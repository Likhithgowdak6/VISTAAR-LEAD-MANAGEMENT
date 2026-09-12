/**
 * The week-ahead countdown: one WhatsApp each morning listing every confirmed booking in the next
 * seven days, and a phone call only when there is one tomorrow.
 *
 * WHY ONE MESSAGE AND NOT ONE PER BOOKING. The obvious reading of "remind me every day for the
 * week before" is a message per booking per day - which for five bookings is thirty-five messages
 * a week, arriving in overlapping streams, and the owner stops reading them by Wednesday. A
 * reminder nobody reads is worse than no reminder, because it is believed to be working. So this
 * sends one message with the whole week in it, soonest first: the day-before line is at the top
 * where it cannot be missed, and the shape of the week is visible in one read.
 *
 * WHY THE CALL IS CONDITIONAL. A call every morning that usually says "nothing tomorrow" is
 * ignored inside a week, and each one costs money. Ringing only when something is actually on
 * tomorrow keeps the ring meaningful - a call from this system comes to mean "you are shooting
 * tomorrow" rather than "the system is still alive". Silence is the "nothing tomorrow" answer,
 * and the written digest above says so explicitly anyway, so nothing is lost.
 *
 * This never messages a customer and never changes any state - it only reads and reports, like
 * digest.service.ts beside it. The one-shot pre-event reminder in event-reminder.service.ts is a
 * different job and still runs: that one is the safety net that retries until it lands, this one
 * is the standing view.
 */
import { env, type Env } from '../../config/env.js';
import { logger as defaultLogger } from '../../config/logger.js';
import { type ObjectIdLike } from '../../types/common.js';
import { ORGANIZATION_STATUSES } from '../../constants/organization-statuses.js';
import { placeOutboundCall as defaultPlaceOutboundCall } from '../calls/vapi.client.js';
import { findWonBookingsBetween as defaultFindWonBookingsBetween } from '../conversations/conversation.repository.js';
import { daysUntilEventDate, formatEventDate } from '../conversations/event-date.js';
import {
  findOrganizationById as defaultFindOrganizationById,
  listOrganizations as defaultListOrganizations,
  normalizeOwnerWhatsappNumber,
} from '../organizations/organization.repository.js';
import {
  createOwnerNotifyService,
  type NotifyOwnerParams,
  type NotifyOwnerResult,
} from '../whatsapp/automation/owner-notify.service.js';

type NotifyOwnerFn = (params?: NotifyOwnerParams) => Promise<NotifyOwnerResult>;
type Logger = { info?: (...args: unknown[]) => void; error?: (...args: unknown[]) => void };

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** The window the owner is asked to hold in their head. A fortnight is a diary, not a reminder. */
export const COUNTDOWN_DAYS = 7;

const ORGANIZATION_LIMIT = 200;
const BOOKING_LIMIT = 50;

export interface CountdownBooking {
  displayName: string;
  eventDate: Date;
  category: string | null;
  daysAway: number;
}

/**
 * The message. Pure, so the wording is testable without a database or a WhatsApp session.
 *
 * Returns null when there is nothing in the window: an "all clear" every single morning is how a
 * channel gets muted, and the owner has the dashboard for the quiet weeks.
 */
export const buildCountdownMessage = (bookings: CountdownBooking[]): string | null => {
  if (bookings.length === 0) {
    return null;
  }

  const lines = bookings.map((booking) => {
    const when =
      booking.daysAway <= 0
        ? 'Today'
        : booking.daysAway === 1
          ? 'Tomorrow'
          : `In ${booking.daysAway} days`;

    const what = booking.category && booking.category !== 'unknown' ? `, ${booking.category}` : '';

    return `${when} — ${booking.displayName}${what} (${formatEventDate(booking.eventDate)})`;
  });

  const heading =
    bookings.length === 1
      ? '📸 1 booking this week'
      : `📸 ${bookings.length} bookings this week`;

  return `${heading}\n\n${lines.join('\n')}`;
};

/** What the owner hears when something is on tomorrow. Names, because a count is not a plan. */
export const buildTomorrowCallSummary = (bookings: CountdownBooking[]): string => {
  const names = bookings.map((booking) => booking.displayName).join(', ');

  return bookings.length === 1
    ? `You have 1 shoot tomorrow: ${names}.`
    : `You have ${bookings.length} shoots tomorrow: ${names}.`;
};

export interface CreateBookingCountdownServiceOptions {
  config?: Env;
  findWonBookingsBetween?: typeof defaultFindWonBookingsBetween;
  listOrganizations?: typeof defaultListOrganizations;
  findOrganizationById?: typeof defaultFindOrganizationById;
  placeOutboundCall?: typeof defaultPlaceOutboundCall;
  notifyOwner?: NotifyOwnerFn;
  logger?: Logger;
  now?: () => Date;
}

export const createBookingCountdownService = ({
  config = env,
  findWonBookingsBetween = defaultFindWonBookingsBetween,
  listOrganizations = defaultListOrganizations,
  findOrganizationById = defaultFindOrganizationById,
  placeOutboundCall = defaultPlaceOutboundCall,
  notifyOwner,
  logger = defaultLogger,
  now = () => new Date(),
}: CreateBookingCountdownServiceOptions = {}) => {
  // Lazily resolved for the same module-cycle reason digest.service.ts does it: the session
  // manager must not be constructed at import time.
  const notify: NotifyOwnerFn =
    notifyOwner ?? ((params) => getOwnerNotifyService().notifyOwner(params));

  const runForOrganization = async (organizationId: ObjectIdLike): Promise<void> => {
    const reference = now();
    const bookings = (
      await findWonBookingsBetween({
        organizationId,
        from: reference,
        to: new Date(reference.getTime() + COUNTDOWN_DAYS * MS_PER_DAY),
        limit: BOOKING_LIMIT,
      })
    ).map((conversation) => ({
      displayName: conversation.displayName ?? 'Unnamed booking',
      eventDate: conversation.eventDate as Date,
      category: conversation.aiCategory ?? null,
      daysAway: daysUntilEventDate(conversation.eventDate as Date, reference),
    }));

    const message = buildCountdownMessage(bookings);

    if (!message) {
      return;
    }

    await notify({ organizationId, text: message });

    const tomorrow = bookings.filter((booking) => booking.daysAway === 1);

    if (tomorrow.length === 0) {
      logger?.info?.(
        { bookings: bookings.length },
        'Booking countdown sent. No call: nothing on tomorrow.',
      );
      return;
    }

    // The call is a second delivery of something already sent in writing, so its failures are
    // logged and never thrown - a Vapi outage must not look like the digest failing.
    try {
      await placeCall({ organizationId, summary: buildTomorrowCallSummary(tomorrow) });
    } catch (error: unknown) {
      const err = error as { name?: unknown; message?: unknown };
      logger?.error?.(
        { name: err?.name, message: err?.message },
        'Tomorrow-shoot call failed. The WhatsApp countdown already went out.',
      );
    }
  };

  const placeCall = async ({
    organizationId,
    summary,
  }: {
    organizationId: ObjectIdLike;
    summary: string;
  }): Promise<void> => {
    // Shares the escalation gate rather than adding a second one: a business that has switched
    // off being rung about leads has said what it thinks about being rung.
    if (!config.OWNER_CALL_ESCALATION_ENABLED) {
      return;
    }

    const organization = await findOrganizationById(organizationId);
    const number = normalizeOwnerWhatsappNumber(
      organization?.ownerWhatsappNumber ?? config.WHATSAPP_OWNER_NUMBER ?? '',
    );

    if (!number) {
      return;
    }

    await placeOutboundCall({
      toNumber: number,
      // Its own assistant, because the whole message lives in Vapi's First Message and a
      // "you have a new lead" opener cannot also be a "you are shooting tomorrow" opener.
      // Reusing the escalation assistant made it read the summary out as if it were a lead's name.
      assistantId: config.VAPI_SCHEDULE_ASSISTANT_ID || config.VAPI_ASSISTANT_ID,
      variableValues: { summary },
    });
  };

  const run = async (): Promise<void> => {
    const organizations = await listOrganizations({
      status: ORGANIZATION_STATUSES.ACTIVE,
      limit: ORGANIZATION_LIMIT,
    });

    for (const organization of organizations) {
      try {
        await runForOrganization(organization._id);
      } catch (error: unknown) {
        // Per-organization isolation, exactly as the digest and nurture sweeps do it: one
        // unreachable organization must not cost every other one its countdown.
        const err = error as { name?: unknown; message?: unknown };
        logger?.error?.(
          { organizationId: organization._id?.toString?.(), name: err?.name, message: err?.message },
          'Booking countdown failed for one organization.',
        );
      }
    }
  };

  return { run, runForOrganization };
};

export type BookingCountdownService = ReturnType<typeof createBookingCountdownService>;

// Imported late so the module cycle note above holds.
const getOwnerNotifyService = (() => {
  let cached: ReturnType<typeof createOwnerNotifyService> | null = null;

  return () => {
    cached ??= createOwnerNotifyService();
    return cached;
  };
})();
