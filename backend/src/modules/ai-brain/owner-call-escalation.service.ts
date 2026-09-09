/**
 * If a "🔔 new lead" WhatsApp alert has gone out and the owner has not touched WhatsApp AT ALL
 * since - not a self-chat reply, not typing into a lead's own chat - a text nobody may be looking
 * at is not good enough. Past a configured delay, this places a real phone call to the owner
 * through Vapi (the voice AI agent) over the VoiceLink SIP trunk/DID configured on Vapi's own
 * dashboard, so "there's a new lead" reaches the owner even with their phone face-down.
 *
 * Two properties, same as the other owner alerts next door (new-lead-alert.service.ts,
 * hot-lead-alert.service.ts):
 *
 *  1. IDEMPOTENT per lead, through `claimOwnerCallEscalation` - a conditional update on
 *     `ownerCallEscalationSentAt: null`. A sweep tick that overlaps a slow previous one, or two
 *     API processes, can never dial the owner twice for the same lead.
 *  2. NEVER throws out of `sweepOnce`. One organization's misconfigured Vapi key, or one
 *     conversation's stale contact, must not stop every other organization's sweep from running.
 *
 * "The owner has not touched WhatsApp" is org-wide, not per-lead: Organization.lastOwnerWhatsAppActivityAt
 * is updated by the inbound router the moment it recognizes ANY owner-authored message, on any
 * conversation. A lead sitting unanswered while the owner is visibly active elsewhere in WhatsApp
 * is not the case this exists for - only genuine silence is.
 */
import { ACTIVITY_EVENTS } from '../../constants/activity-events.js';
import { env, type Env } from '../../config/env.js';
import { logger as defaultLogger } from '../../config/logger.js';
import { type ObjectIdLike } from '../../types/common.js';
import { createActivity as defaultCreateActivity } from '../activity/activity-log.repository.js';
import {
  claimOwnerCallEscalation as defaultClaimOwnerCallEscalation,
  findConversationsAwaitingCallOutcome as defaultFindConversationsAwaitingCallOutcome,
  findConversationsNeedingOwnerCall as defaultFindConversationsNeedingOwnerCall,
  recordOwnerCallEscalationResult as defaultRecordOwnerCallEscalationResult,
} from '../conversations/conversation.repository.js';
import {
  findOrganizationById as defaultFindOrganizationById,
  listOrganizations as defaultListOrganizations,
  normalizeOwnerWhatsappNumber,
} from '../organizations/organization.repository.js';
import { ORGANIZATION_STATUSES } from '../../constants/organization-statuses.js';
import {
  getCall as defaultGetCall,
  placeOutboundCall as defaultPlaceOutboundCall,
} from '../calls/vapi.client.js';

const ORGANIZATION_LIMIT = 200;
/** Enough for any realistic single tick; a sweep is a nudge, not a batch dialer. */
const CONVERSATION_LIMIT = 10;

export interface OwnerCallEscalationConversationLike {
  _id: ObjectIdLike;
  organizationId: ObjectIdLike;
  whatsappAccountId: ObjectIdLike;
  displayName: string;
  /** e.g. "birthday_party", "unknown" before the AI has classified the enquiry yet. */
  aiCategory?: string;
  /** Whatever the AI has learned so far - event_date, city, budget, guest_count, etc. Whichever
   *  of these exist is exactly what's worth saying out loud on the call; an empty object before
   *  the lead has answered anything is just as valid and simply produces no line. */
  aiFacts?: Record<string, unknown>;
  /** Set once a call has been placed for this lead, cleared conceptually by recording an
   *  outcome against it - see settleOutstandingCalls. */
  ownerCallEscalationCallId?: string | null;
}

const UNKNOWN_CATEGORY = 'unknown';

/** "birthday_party" -> "a birthday party enquiry"; falls back to something sayable when the AI
 *  has not classified the lead yet, which is common for a lead that just arrived. */
const describeCategory = (category?: string): string => {
  const normalized = (category ?? '').trim().toLowerCase();

  if (normalized === '' || normalized === UNKNOWN_CATEGORY) {
    return 'a new enquiry';
  }

  return `a ${normalized.replace(/_/g, ' ')} enquiry`;
};

/** The handful of facts worth saying out loud, in the order an owner would want to hear them. */
const CALL_FACT_ORDER = ['event_date', 'city', 'venue', 'guest_count', 'budget'] as const;
const CALL_FACT_LABELS: Record<(typeof CALL_FACT_ORDER)[number], string> = {
  event_date: 'date',
  city: 'city',
  venue: 'venue',
  guest_count: 'guest count',
  budget: 'budget',
};

const isSayableFactValue = (value: unknown): value is string | number =>
  (typeof value === 'string' && value.trim() !== '') || typeof value === 'number';

/** "date 6th September, budget 40k" - empty string when nothing has been learned yet. */
const describeFacts = (facts?: Record<string, unknown>): string =>
  CALL_FACT_ORDER.filter((key) => isSayableFactValue(facts?.[key]))
    .map((key) => `${CALL_FACT_LABELS[key]} ${facts?.[key]}`)
    .join(', ');

export interface OwnerCallEscalationOrganizationLike {
  _id: ObjectIdLike;
  ownerWhatsappNumber?: string | null;
  lastOwnerWhatsAppActivityAt?: Date | null;
}

export interface CreateOwnerCallEscalationServiceOptions {
  config?: Env;
  findConversationsNeedingOwnerCall?: typeof defaultFindConversationsNeedingOwnerCall;
  claimOwnerCallEscalation?: typeof defaultClaimOwnerCallEscalation;
  findConversationsAwaitingCallOutcome?: typeof defaultFindConversationsAwaitingCallOutcome;
  recordOwnerCallEscalationResult?: typeof defaultRecordOwnerCallEscalationResult;
  listOrganizations?: typeof defaultListOrganizations;
  findOrganizationById?: typeof defaultFindOrganizationById;
  placeOutboundCall?: typeof defaultPlaceOutboundCall;
  getCall?: typeof defaultGetCall;
  createActivity?: typeof defaultCreateActivity;
  logger?: { error?: (...args: unknown[]) => void };
  now?: () => Date;
}

export interface SweepOnceParams {
  organizationId?: ObjectIdLike;
}

export interface SweepOnceResult {
  organizations: number;
  called: number;
  skipped: number;
  failed: number;
  /** Calls whose outcome was read back from Vapi and recorded on this tick. */
  settled: number;
}

/**
 * How the destination is written for Vapi. `+<digits>` by default; `VAPI_DIAL_FORMAT=plain`
 * drops the plus for a trunk that will not accept full E.164 (see the env comment).
 */
const formatDialNumber = (digitsOnly: string, format: Env['VAPI_DIAL_FORMAT']): string =>
  format === 'plain' ? digitsOnly : `+${digitsOnly}`;

/**
 * The dialed line, masked, for the activity timeline.
 *
 * Recorded because "the call never connected" is only half an answer - the first question anyone
 * asks next is "which number did it try", and an owner number that was edited between the alert
 * and the call makes that genuinely ambiguous. Masked and stored under a key that does not
 * contain "phone", because activity metadata refuses sensitive keys outright (see
 * security/redaction.service.ts) and a full number has no business in a timeline row.
 */
const maskNumber = (digitsOnly: string): string =>
  digitsOnly.length <= 7
    ? '***'
    : `${digitsOnly.slice(0, 4)}***${digitsOnly.slice(-3)}`;

export const createOwnerCallEscalationService = ({
  config = env,
  findConversationsNeedingOwnerCall = defaultFindConversationsNeedingOwnerCall,
  claimOwnerCallEscalation = defaultClaimOwnerCallEscalation,
  findConversationsAwaitingCallOutcome = defaultFindConversationsAwaitingCallOutcome,
  recordOwnerCallEscalationResult = defaultRecordOwnerCallEscalationResult,
  listOrganizations = defaultListOrganizations,
  findOrganizationById = defaultFindOrganizationById,
  placeOutboundCall = defaultPlaceOutboundCall,
  getCall = defaultGetCall,
  createActivity = defaultCreateActivity,
  logger = defaultLogger,
  now = () => new Date(),
}: CreateOwnerCallEscalationServiceOptions = {}) => {
  const delayMs = config.OWNER_CALL_ESCALATION_DELAY_SECONDS * 1_000;

  /**
   * Reads back what became of calls placed on earlier ticks and writes it onto the conversation's
   * timeline. Polled rather than webhooked on purpose: a webhook needs this API to be publicly
   * reachable, which it is not during local testing - and "the owner was called but nobody knows
   * if it connected" is exactly the blind spot that cost hours the first time a dead SIP trunk
   * answered every request with a cheerful 2xx.
   */
  const settleOutstandingCalls = async (
    organizationId: ObjectIdLike,
  ): Promise<number> => {
    let settled = 0;

    const outstanding = (await findConversationsAwaitingCallOutcome({
      organizationId,
      limit: CONVERSATION_LIMIT,
    })) as OwnerCallEscalationConversationLike[];

    for (const conversation of outstanding) {
      const callId = conversation.ownerCallEscalationCallId;

      if (!callId) {
        continue;
      }

      try {
        const outcome = await getCall(callId);

        // Still queued/ringing/talking - ask again on the next tick rather than recording a
        // half-finished answer we would then never revisit.
        if (!outcome.settled) {
          continue;
        }

        const reason = outcome.endedReason ?? outcome.status ?? 'unknown';
        const connected = (outcome.durationSeconds ?? 0) > 0;

        await recordOwnerCallEscalationResult({
          conversationId: conversation._id,
          organizationId,
          outcome: reason,
        });

        await createActivity({
          organizationId,
          whatsappAccountId: conversation.whatsappAccountId,
          conversationId: conversation._id,
          eventType: ACTIVITY_EVENTS.AI_BRAIN_OWNER_CALL_ESCALATED,
          summary: connected
            ? `The owner's call about ${conversation.displayName} connected for ${outcome.durationSeconds}s (${reason}).`
            : `The owner's call about ${conversation.displayName} never connected: ${reason}.`,
          metadata: {
            vapiCallId: callId,
            endedReason: reason,
            durationSeconds: outcome.durationSeconds ?? 0,
            connected,
          },
        });

        settled += 1;
      } catch (error: unknown) {
        const err = error as { code?: unknown; name?: unknown; statusCode?: unknown };
        logger.error?.(
          {
            code: err?.code,
            name: err?.name,
            statusCode: err?.statusCode,
            conversationId: conversation._id?.toString?.(),
          },
          'Reading a placed call back from Vapi failed safely; it will be retried next tick.',
        );
      }
    }

    return settled;
  };

  const sweepForOrganization = async (
    organizationId: ObjectIdLike,
    reference: Date,
  ): Promise<{ called: number; skipped: number; failed: number; settled: number }> => {
    const result = { called: 0, skipped: 0, failed: 0, settled: 0 };

    // Before placing anything new: close the books on what was already placed.
    result.settled = await settleOutstandingCalls(organizationId);

    const organization = (await findOrganizationById(
      organizationId,
    )) as OwnerCallEscalationOrganizationLike | null;

    const ownerNumber = normalizeOwnerWhatsappNumber(organization?.ownerWhatsappNumber);

    // No owner number configured on this organization at all - nobody to call, and dialing a
    // wrong or missing number is worse than staying silent.
    if (!ownerNumber) {
      return result;
    }

    const alertedBefore = new Date(reference.getTime() - delayMs);
    const activitySince = organization?.lastOwnerWhatsAppActivityAt ?? null;

    const candidates = await findConversationsNeedingOwnerCall({
      organizationId,
      alertedBefore,
      limit: CONVERSATION_LIMIT,
    });

    for (const conversation of candidates as OwnerCallEscalationConversationLike[]) {
      // The owner has been active on WhatsApp at all since this specific lead's alert went out -
      // that alert reached someone who is clearly not away from their phone. Not a call worth
      // making, and not claimed either, so a LATER silence on this same lead can still escalate.
      if (activitySince && activitySince.getTime() >= alertedBefore.getTime()) {
        result.skipped += 1;
        continue;
      }

      const claimed = await claimOwnerCallEscalation({
        conversationId: conversation._id,
        organizationId,
        now: reference,
      });

      // Already claimed by a previous tick, or the conversation no longer exists.
      if (!claimed) {
        continue;
      }

      try {
        const call = await placeOutboundCall({
          toNumber: formatDialNumber(ownerNumber, config.VAPI_DIAL_FORMAT),
          variableValues: {
            leadName: conversation.displayName,
            enquiryType: describeCategory(conversation.aiCategory),
            knownDetails: describeFacts(conversation.aiFacts) || 'nothing else yet',
          },
        });

        // Stored so a later tick can read the call's fate back out of Vapi. Vapi accepting the
        // request is not the phone ringing, and without this id nothing in the CRM could ever
        // find out which of those two happened.
        await recordOwnerCallEscalationResult({
          conversationId: conversation._id,
          organizationId,
          callId: call.callId || null,
        });

        await createActivity({
          organizationId,
          whatsappAccountId: conversation.whatsappAccountId,
          conversationId: conversation._id,
          eventType: ACTIVITY_EVENTS.AI_BRAIN_OWNER_CALL_ESCALATED,
          summary: `Called the owner on ${maskNumber(ownerNumber)}: the new-lead alert for ${conversation.displayName} went unanswered.`,
          metadata: { vapiCallId: call.callId, dialed: maskNumber(ownerNumber) },
        });

        result.called += 1;

        /*
         * ONE CALL PER TICK, PER ORGANIZATION. Two independent reasons, and either alone would
         * justify it:
         *
         *  - A telephony plan sells CHANNELS, and a channel is one concurrent call. On a
         *    single-channel plan the second simultaneous call does not queue, it fails at the SIP
         *    layer ("outbound call failed to connect") - so a burst of leads would turn one real
         *    alert into one connected call and several phantom failures.
         *  - The owner has one pair of ears. Ringing them about a second lead while they are
         *    still being told about the first is not more information, it is a dropped call.
         *
         * The remaining candidates were never reached by this loop, so nothing was claimed on
         * their behalf and a later tick picks them up untouched.
         */
        break;
      } catch (error: unknown) {
        const err = error as { code?: unknown; name?: unknown; statusCode?: unknown };
        logger.error?.(
          {
            code: err?.code,
            name: err?.name,
            statusCode: err?.statusCode,
            organizationId: organizationId?.toString?.(),
            conversationId: conversation._id?.toString?.(),
          },
          'Owner call escalation failed safely; the lead stays in the dashboard either way.',
        );
        result.failed += 1;
      }
    }

    return result;
  };

  const sweepOnce = async ({ organizationId }: SweepOnceParams = {}): Promise<SweepOnceResult> => {
    const reference = now();
    const totals: SweepOnceResult = { organizations: 0, called: 0, skipped: 0, failed: 0, settled: 0 };

    const organizationIds: ObjectIdLike[] = organizationId
      ? [organizationId]
      : (
          await listOrganizations({
            status: ORGANIZATION_STATUSES.ACTIVE,
            limit: ORGANIZATION_LIMIT,
          })
        ).map((organization) => organization._id);

    for (const id of organizationIds) {
      totals.organizations += 1;

      try {
        const { called, skipped, failed, settled } = await sweepForOrganization(id, reference);

        totals.called += called;
        totals.skipped += skipped;
        totals.failed += failed;
        totals.settled += settled;
      } catch (error: unknown) {
        const err = error as { code?: unknown; name?: unknown };
        logger.error?.(
          { code: err?.code, name: err?.name, organizationId: id?.toString?.() },
          'Owner call escalation sweep failed safely for one organization.',
        );
      }
    }

    return totals;
  };

  return { sweepOnce };
};

export type OwnerCallEscalationService = ReturnType<typeof createOwnerCallEscalationService>;
