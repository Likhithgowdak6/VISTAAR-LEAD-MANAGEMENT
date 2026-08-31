/**
 * The 🔔 new-lead alert (Phase 6): the moment a brand-new lead's first WhatsApp message lands,
 * the owner gets a one-line ping in their own self-chat, so a fresh enquiry is never sitting
 * unseen in a dashboard nobody has open.
 *
 * Two properties matter more than anything else here:
 *
 *  1. It is IDEMPOTENT. The right to send is claimed atomically through
 *     `claimNewLeadAlert` - a conditional update on `newLeadAlertSentAt: null` that returns null
 *     for everyone who did not win. A webhook retry, a duplicate delivery, or two processes
 *     racing therefore produce exactly one alert, never two.
 *  2. It NEVER throws. It runs on the inbound-ingestion path, where a throw would abort
 *     persisting a message for an entirely unrelated reason - the same contract
 *     handleInboundMessageForAutomation already holds there.
 */
import { ACTIVITY_EVENTS } from '../../constants/activity-events.js';
import { logger as defaultLogger } from '../../config/logger.js';
import { type ObjectIdLike } from '../../types/common.js';
import { createActivity as defaultCreateActivity } from '../activity/activity-log.repository.js';
import { claimNewLeadAlert as defaultClaimNewLeadAlert } from '../conversations/conversation.repository.js';
import {
  createOwnerNotifyService,
  type NotifyOwnerParams,
  type NotifyOwnerResult,
} from '../whatsapp/automation/owner-notify.service.js';

type NotifyOwnerFn = (params?: NotifyOwnerParams) => Promise<NotifyOwnerResult>;

let ownerNotifyServiceSingleton: { notifyOwner: NotifyOwnerFn } | null = null;
const getOwnerNotifyService = () => {
  ownerNotifyServiceSingleton ??= createOwnerNotifyService();
  return ownerNotifyServiceSingleton;
};

const MAX_FIRST_MESSAGE_PREVIEW_LENGTH = 200;

const previewFirstMessage = (text: string | null | undefined): string => {
  const trimmed = (text ?? '').trim();

  if (trimmed === '') {
    return '(no text)';
  }

  return trimmed.length > MAX_FIRST_MESSAGE_PREVIEW_LENGTH
    ? `${trimmed.slice(0, MAX_FIRST_MESSAGE_PREVIEW_LENGTH).trimEnd()}…`
    : trimmed;
};

// --------------------------------------------------------------------------
// A lead who arrived off a Meta lead form has not written anything yet, so there is nothing to
// quote. What there is instead is everything they typed into the form, and the alert is only
// useful if it stays glanceable on a lock screen - so the facts go out as two short grouped rows
// rather than one long run: "what & when" first, then "how big". Ported from vistaar-agent's
// app/services/alerts.py::_compose.
// --------------------------------------------------------------------------
/** The keys that answer "what is this and when". */
const WHAT_FACT_KEYS: readonly string[] = [
  'event_type',
  'shoot_type',
  'service_interest',
  'site_purpose',
  'event_date',
  'shoot_date',
  'timeline',
  'city',
];

/** The keys that answer "how big is it". */
const SIZE_FACT_KEYS: readonly string[] = [
  'guest_count',
  'photo_or_video',
  'deliverables_needed',
  'budget_range',
  'monthly_budget',
  'product_count',
];

/**
 * The one answer worth its own line. The live form asks what matters most to them when choosing
 * - "Good Communication with Guest Coordination" - and that single sentence says more about how
 * to sell to this person than the rest of the form put together, so it also gets more room.
 */
const CARES_FACT_KEYS: readonly string[] = ['what_matters', 'primary_goal'];

/** Per-fact, so one rambling answer cannot eat the whole alert. The form's location question in
 *  particular gets whole sentences typed into it. */
const MAX_FACT_LENGTH = 34;
const MAX_CARES_LENGTH = 64;

const FACT_SUFFIXES: Readonly<Record<string, string>> = {
  guest_count: 'guests',
  monthly_budget: '/month',
  product_count: 'products',
};

/** The service in the words the owner uses, not the database's. Covers the sixteen named
 *  services and the six broader groups an older conversation may still be filed under; anything
 *  unrecognised falls through to UNKNOWN_CATEGORY_LABEL rather than showing a raw key. */
const CATEGORY_LABELS: Readonly<Record<string, string>> = {
  wedding: 'Wedding',
  birthday: 'Birthday',
  anniversary: 'Anniversary',
  car_delivery: 'Car delivery',
  house_warming: 'House warming',
  half_saree: 'Half saree ceremony',
  ear_piercing: 'Ear piercing',
  social_private_event: 'Social / private event',
  sports_event: 'Sports event',
  corporate_event: 'Corporate event',
  podcast_talking_head: 'Podcast / talking head',
  festival_event: 'Festival event',
  baby_shower: 'Baby shower',
  real_estate_shoot: 'Real estate shoot',
  interior_article_shoot: 'Interior / article shoot',
  party_shoot: 'Party shoot',
  event_photography: 'Events & functions',
  corporate_commercial: 'Corporate & commercial',
  ecommerce_web: 'Web & e-commerce',
  marketing_retainer: 'Marketing & ads',
  social_branding: 'Branding & creative',
  seo_search: 'SEO & search',
};

const UNKNOWN_CATEGORY_LABEL = 'Not sure yet';

const BLANK_FACT_VALUES = new Set(['', '-', '--', '?', 'n/a', 'na', 'none', 'null']);

const cleanFact = (value: unknown, maxLength: number): string => {
  const text = String(value ?? '')
    .split(/\s+/)
    .filter((word) => word !== '')
    .join(' ');

  if (BLANK_FACT_VALUES.has(text.toLowerCase())) {
    return '';
  }

  return text.length > maxLength ? `${text.slice(0, maxLength - 1).trimEnd()}…` : text;
};

const buildFactRow = (
  facts: Record<string, unknown>,
  keys: readonly string[],
  limit: number,
  maxLength: number = MAX_FACT_LENGTH,
): string => {
  const parts: string[] = [];

  for (const key of keys) {
    const value = cleanFact(facts[key], maxLength);

    if (value === '') {
      continue;
    }

    const suffix = FACT_SUFFIXES[key] ?? '';
    parts.push(suffix.startsWith('/') ? `${value}${suffix}` : `${value} ${suffix}`.trim());

    if (parts.length === limit) {
      break;
    }
  }

  return parts.join(' · ');
};

export interface BuildNewLeadAlertTextParams {
  leadDisplayName: string;
  phone?: string | null;
  /** The lead's own first WhatsApp message, quoted. Omitted entirely for a sheet-imported lead,
   *  who has not written in yet - that alert leads with the form facts instead. */
  firstMessage?: string | null;
  /** Canonical form facts (lead-sources/lead-field-rules.ts). */
  facts?: Record<string, unknown> | null;
  /** A key of category-playbooks.ts, rendered in the owner's own words. */
  category?: string | null;
  /** Where the lead came from, e.g. the lead source's name. */
  sourceLabel?: string | null;
}

/**
 * One alert text for both arrivals. An inbound lead has a first message and no facts yet; an
 * imported lead has facts and no message. Passing neither still produces the name line, which is
 * the only part the owner reads before deciding whether to open the chat.
 */
export const buildNewLeadAlertText = ({
  leadDisplayName,
  phone,
  firstMessage,
  facts,
  category,
  sourceLabel,
}: BuildNewLeadAlertTextParams): string => {
  const safeFacts = facts ?? {};
  const lines: string[] = [`🔔 New lead: ${leadDisplayName}${phone ? ` (${phone})` : ''}`];

  if (category || sourceLabel) {
    const categoryKey = (category ?? '').trim();
    const serviceLabel = Object.hasOwn(CATEGORY_LABELS, categoryKey)
      ? CATEGORY_LABELS[categoryKey]!
      : UNKNOWN_CATEGORY_LABEL;
    lines.push([serviceLabel, cleanFact(sourceLabel, MAX_CARES_LENGTH)].filter(Boolean).join(' · '));
  }

  const detailRows = [
    buildFactRow(safeFacts, WHAT_FACT_KEYS, 3),
    buildFactRow(safeFacts, SIZE_FACT_KEYS, 2),
  ].filter((row) => row !== '');

  lines.push(...detailRows);

  const cares = buildFactRow(safeFacts, CARES_FACT_KEYS, 1, MAX_CARES_LENGTH);

  if (cares !== '') {
    lines.push(`Cares about: ${cares}`);
  }

  // Deliberately keyed on the parameter being passed at all, not on it being non-empty: an
  // inbound lead whose first message was a photo still gets a quote line saying so, while an
  // imported lead - who passes no first message - gets no empty quotes.
  if (firstMessage !== undefined) {
    lines.push(`"${previewFirstMessage(firstMessage)}"`);
  }

  return lines.join('\n');
};

export interface SendNewLeadAlertParams {
  organizationId?: ObjectIdLike;
  whatsappAccountId?: ObjectIdLike;
  conversationId?: ObjectIdLike;
  leadDisplayName?: string;
  phone?: string | null;
  /** Quoted when there is one. A sheet-imported lead has not written in, and passes facts. */
  firstMessage?: string | null;
  facts?: Record<string, unknown> | null;
  category?: string | null;
  sourceLabel?: string | null;
  claimNewLeadAlert?: typeof defaultClaimNewLeadAlert;
  notifyOwner?: NotifyOwnerFn;
  createActivity?: typeof defaultCreateActivity;
  logger?: { error?: (...args: unknown[]) => void };
}

export interface SendNewLeadAlertResult {
  sent: boolean;
}

export const sendNewLeadAlert = async ({
  organizationId,
  whatsappAccountId,
  conversationId,
  leadDisplayName = 'New WhatsApp lead',
  phone,
  firstMessage,
  facts,
  category,
  sourceLabel,
  claimNewLeadAlert = defaultClaimNewLeadAlert,
  notifyOwner,
  createActivity = defaultCreateActivity,
  logger = defaultLogger,
}: SendNewLeadAlertParams = {}): Promise<SendNewLeadAlertResult> => {
  // Without an account there is no self-chat to reach the owner through, so there is nothing
  // this can do - and nothing is claimed, so a later well-formed call can still alert.
  if (!organizationId || !conversationId || !whatsappAccountId) {
    return { sent: false };
  }

  try {
    const claimed = await claimNewLeadAlert({ conversationId, organizationId });

    // Someone else already alerted for this conversation (or it no longer exists) - the claim is
    // the whole idempotency guarantee, so losing it means staying quiet.
    if (!claimed) {
      return { sent: false };
    }

    const notify: NotifyOwnerFn = notifyOwner ?? getOwnerNotifyService().notifyOwner;

    await notify({
      accountId: whatsappAccountId,
      organizationId,
      text: buildNewLeadAlertText({
        leadDisplayName,
        phone,
        // Spread rather than passed: the builder distinguishes "no first message at all" (an
        // imported lead) from "a first message with no text in it" (a photo), and that
        // distinction is lost the moment the key exists with an undefined value.
        ...(firstMessage === undefined ? {} : { firstMessage }),
        facts,
        category,
        sourceLabel,
      }),
    });

    await createActivity({
      organizationId,
      whatsappAccountId,
      conversationId,
      eventType: ACTIVITY_EVENTS.AI_BRAIN_NEW_LEAD_ALERTED,
      summary: 'Owner was alerted on WhatsApp about this new lead.',
      metadata: {},
    });

    return { sent: true };
  } catch (error: unknown) {
    // Most commonly: no running WhatsApp session yet, so the owner's self-chat is unreachable.
    // The lead's message is already saved and visible in the dashboard either way.
    const err = error as { code?: unknown; name?: unknown };
    logger.error?.(
      {
        code: err?.code,
        name: err?.name,
        organizationId: organizationId?.toString?.(),
        conversationId: conversationId?.toString?.(),
      },
      'New-lead owner alert failed safely; message ingestion is unaffected.',
    );

    return { sent: false };
  }
};
