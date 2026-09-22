/**
 * Adding a lead by hand: a phone number, what they need, and optionally "message them now".
 *
 * Deliberately built on the SAME primitives as the Meta/Sheet importer (lead-pipeline.service.ts)
 * rather than beside them, because the parts that are easy to get subtly wrong are all shared:
 *
 *   - PHONE FORMAT IS AN IDENTITY, NOT A STRING. `normalizePhoneNumber` yields bare international
 *     digits with no `+`, and the blind index is a hash of `<digits>@s.whatsapp.net`. Store
 *     anything else and the lead who later replies resolves to a SECOND contact and a SECOND
 *     conversation - one person, two threads, the AI qualifying them twice. A ten-digit Indian
 *     number with no country code validates happily and hashes to the wrong value, which is why
 *     `defaultCountryCode` is required here rather than optional.
 *   - THE ALLOWLIST IS AN INGESTION GATE. `WHATSAPP_TEST_ALLOWED_NUMBERS` is enforced inside the
 *     importer, not in the contact or conversation repositories, so a path that calls those
 *     directly would create records for numbers the owner has restricted and then have the send
 *     blocked later - leaving an orphan conversation with a permanently stuck message.
 *   - COLD OUTBOUND IS OPT-IN PER LEAD. There is no LeadSource here, so there is no
 *     `autoGreetEnabled` to consult; `manualOutreachApprovedAt` is this lead's own copy of that
 *     switch, and the sweep fails closed without it.
 *
 * What is deliberately NOT shared: there is no LeadSubmission row. That collection is the import
 * ledger and doubles as the de-duplication key for a source's external id; a hand-typed lead has
 * no external id and no source to be idempotent against. The activity log records the provenance
 * instead.
 */
import { type HydratedDocument } from 'mongoose';

import { ACTIVITY_EVENTS } from '../../constants/activity-events.js';
import { CONVERSATION_STAGES } from '../../constants/conversation-stages.js';
import { env, type Env } from '../../config/env.js';
import { logger as defaultLogger } from '../../config/logger.js';
import { type ObjectIdLike } from '../../types/common.js';
import { createActivity as defaultCreateActivity } from '../activity/activity-log.repository.js';
import { CATEGORY_PLAYBOOKS } from '../ai-brain/category-playbooks.js';
import {
  attachContactPhoneIfMissing as defaultAttachContactPhoneIfMissing,
  findOrCreateContactByProviderKey as defaultFindOrCreateContactByProviderKey,
} from '../contacts/contact.repository.js';
import { type ConversationDocument } from '../conversations/conversation.model.js';
import {
  approveManualOutreach as defaultApproveManualOutreach,
  findConversationByAccountAndContact as defaultFindConversationByAccountAndContact,
  mergeConversationAiContext as defaultMergeConversationAiContext,
  scheduleAutoGreet as defaultScheduleAutoGreet,
  upsertConversationForContact as defaultUpsertConversationForContact,
} from '../conversations/conversation.repository.js';
import { recomputeLeadScore as defaultRecomputeLeadScore } from '../conversations/lead-score.service.js';
import {
  computeContactProviderKeyFromPhone as defaultComputeContactProviderKeyFromPhone,
  normalizePhoneNumber as defaultNormalizePhoneNumber,
} from '../privacy/protected-pii.service.js';
import { REALTIME_REASONS } from '../realtime/realtime.events.js';
import { publishConversationChanged as defaultPublishConversationChanged } from '../realtime/realtime.publisher.js';
import {
  createNumberAllowlist,
  type NumberAllowlist,
} from '../whatsapp/automation/allowlist.js';

/** Same literal the importer uses - the suffix the blind index is computed over. */
const WHATSAPP_JID_DOMAIN = 's.whatsapp.net';

/** Marks the contact's origin, mirroring the importer's own source label. */
export const MANUAL_CONTACT_SOURCE = 'manual';

export type ManualLeadOutcome = 'created' | 'existing';

export interface CreateManualLeadParams {
  organizationId: ObjectIdLike;
  whatsappAccountId: ObjectIdLike;
  actorId?: ObjectIdLike | null;
  phone: string;
  displayName?: string | null;
  /** A CATEGORY_PLAYBOOKS key. Decides the AI's questions from its very first message. */
  aiCategory?: string | null;
  /** The event's date, if the owner knows it. Drives every reminder and the follow-up cutoff. */
  eventDate?: string | null;
  /** How the owner knows them, used verbatim in the opening line. */
  originNote?: string | null;
  /** Whether the AI may message them first. Defaults to false - cold outbound is never implicit. */
  greetNow?: boolean;
}

export interface ManualLeadResult {
  outcome: ManualLeadOutcome;
  conversation: HydratedDocument<ConversationDocument>;
}

export class ManualLeadError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'ManualLeadError';
    this.code = code;
  }
}

export interface CreateManualLeadServiceOptions {
  config?: Env;
  // Injected for the same reason lead-pipeline.service.ts injects them: the real implementations
  // reach into the encryption keyring, which a unit test has no business needing.
  normalizePhoneNumber?: typeof defaultNormalizePhoneNumber;
  computeContactProviderKeyFromPhone?: typeof defaultComputeContactProviderKeyFromPhone;
  findOrCreateContactByProviderKey?: typeof defaultFindOrCreateContactByProviderKey;
  attachContactPhoneIfMissing?: typeof defaultAttachContactPhoneIfMissing;
  findConversationByAccountAndContact?: typeof defaultFindConversationByAccountAndContact;
  upsertConversationForContact?: typeof defaultUpsertConversationForContact;
  mergeConversationAiContext?: typeof defaultMergeConversationAiContext;
  approveManualOutreach?: typeof defaultApproveManualOutreach;
  scheduleAutoGreet?: typeof defaultScheduleAutoGreet;
  recomputeLeadScore?: typeof defaultRecomputeLeadScore;
  createActivity?: typeof defaultCreateActivity;
  publishConversationChanged?: typeof defaultPublishConversationChanged;
  allowlist?: NumberAllowlist;
  logger?: { warn?: (...args: unknown[]) => void; error?: (...args: unknown[]) => void };
  now?: () => Date;
}

export const createManualLeadService = ({
  config = env,
  normalizePhoneNumber = defaultNormalizePhoneNumber,
  computeContactProviderKeyFromPhone = defaultComputeContactProviderKeyFromPhone,
  findOrCreateContactByProviderKey = defaultFindOrCreateContactByProviderKey,
  attachContactPhoneIfMissing = defaultAttachContactPhoneIfMissing,
  findConversationByAccountAndContact = defaultFindConversationByAccountAndContact,
  upsertConversationForContact = defaultUpsertConversationForContact,
  mergeConversationAiContext = defaultMergeConversationAiContext,
  approveManualOutreach = defaultApproveManualOutreach,
  scheduleAutoGreet = defaultScheduleAutoGreet,
  recomputeLeadScore = defaultRecomputeLeadScore,
  createActivity = defaultCreateActivity,
  publishConversationChanged = defaultPublishConversationChanged,
  allowlist = createNumberAllowlist(String(config?.WHATSAPP_TEST_ALLOWED_NUMBERS ?? '')),
  logger = defaultLogger,
  now = () => new Date(),
}: CreateManualLeadServiceOptions = {}) => {
  const defaultCountryCode = config.MANUAL_LEAD_DEFAULT_COUNTRY_CODE ?? '91';
  const greetDelayMs = Number(config.LEAD_AUTO_GREET_DELAY_MS ?? 300000);

  const createManualLead = async ({
    organizationId,
    whatsappAccountId,
    actorId = null,
    phone,
    displayName,
    aiCategory,
    eventDate,
    originNote,
    greetNow = false,
  }: CreateManualLeadParams): Promise<ManualLeadResult> => {
    const countryCodeOptions = { defaultCountryCode };
    const normalizedPhone = normalizePhoneNumber(phone, countryCodeOptions);

    if (normalizedPhone === null) {
      throw new ManualLeadError('That phone number could not be read.', 'INVALID_PHONE');
    }

    // Same gate, same layer, same reason as the importer: refuse before anything is written, so a
    // blocked number leaves no half-made contact or conversation behind.
    if (!allowlist.permitsInboundJid(`${normalizedPhone}@${WHATSAPP_JID_DOMAIN}`, normalizedPhone)) {
      throw new ManualLeadError(
        'That number is not on the test allowlist, so it cannot be added yet.',
        'PHONE_NOT_ALLOWED',
      );
    }

    const category =
      aiCategory && Object.hasOwn(CATEGORY_PLAYBOOKS, aiCategory) ? aiCategory : 'unknown';

    const providerContactKey = computeContactProviderKeyFromPhone(
      normalizedPhone,
      countryCodeOptions,
    );

    if (!providerContactKey) {
      throw new ManualLeadError('That number could not be identified.', 'NO_IDENTITY');
    }

    const { contact } = await findOrCreateContactByProviderKey({
      organizationId,
      providerContactKey,
      displayName: displayName?.trim() || 'Added by hand',
      phone: normalizedPhone,
      providerJids: [`${normalizedPhone}@${WHATSAPP_JID_DOMAIN}`],
      source: MANUAL_CONTACT_SOURCE,
    });

    if (!contact) {
      throw new ManualLeadError('Contact could not be created.', 'CONTACT_UNRESOLVED');
    }

    await attachContactPhoneIfMissing({
      contactId: contact._id,
      organizationId,
      phone: normalizedPhone,
    });

    // CHECKED BEFORE THE UPSERT, not after. `upsertConversationForContact` writes through
    // `$setOnInsert` only, so re-adding an existing number silently discards every value typed
    // into the form - the service, the date, the note - and returns the untouched original. The
    // form would report success having changed nothing. Detecting it here lets the caller say so.
    const existing = await findConversationByAccountAndContact({
      organizationId,
      whatsappAccountId,
      contactId: contact._id,
    });

    if (existing) {
      return { outcome: 'existing', conversation: existing as HydratedDocument<ConversationDocument> };
    }

    const conversation = (await upsertConversationForContact({
      organizationId,
      whatsappAccountId,
      contactId: contact._id,
      leadId: contact.leadId,
      displayName: contact.displayName,
      defaults: {
        stage: CONVERSATION_STAGES.NEW,
        // On insert only, and true for the same reason an imported lead's is: the AI is meant to
        // work these. It governs whether the AI REPLIES; whether it may SPEAK FIRST is
        // `manualOutreachApprovedAt` below, and the two are deliberately separate decisions.
        aiAutomationEnabled: true,
        manualOriginNote: originNote?.trim() || null,
      },
    })) as HydratedDocument<ConversationDocument>;

    // The owner has just told us what this job is, which is exactly what the classifier spends
    // its first turn guessing. Writing it now means the very first message already asks the right
    // questions. `event_date` goes through `aiFacts` rather than straight to the `eventDate`
    // column because that column is only ever written by applyEventDateFromFacts - setting it
    // directly would be overwritten, and setting neither makes every reminder silently never fire.
    const facts: Record<string, unknown> = {};

    if (eventDate?.trim()) {
      facts.event_date = eventDate.trim();
    }

    if (category !== 'unknown' || Object.keys(facts).length > 0) {
      await mergeConversationAiContext({
        conversationId: conversation._id,
        organizationId,
        facts,
        category,
      });

      await recomputeLeadScore({
        organizationId,
        conversationId: conversation._id,
        whatsappAccountId,
      });
    }

    await createActivity({
      organizationId,
      whatsappAccountId,
      conversationId: conversation._id,
      actorId,
      eventType: ACTIVITY_EVENTS.LEAD_ADDED_MANUALLY,
      summary: originNote?.trim()
        ? `Lead added by hand: ${originNote.trim()}`
        : 'Lead added by hand.',
      metadata: {
        aiCategory: category,
        eventDate: eventDate?.trim() ?? null,
        greetNow,
      },
    });

    // Last, and only on an explicit yes. Scheduled rather than sent, like the importer's: the
    // pause is the window in which the owner can still change his mind, and the sweep re-reads
    // `manualOutreachApprovedAt` at send time rather than trusting it was set here.
    if (greetNow) {
      try {
        await approveManualOutreach({
          conversationId: conversation._id,
          organizationId,
          now: now(),
        });

        await scheduleAutoGreet({
          conversationId: conversation._id,
          organizationId,
          dueAt: new Date(now().getTime() + greetDelayMs),
        });
      } catch (error: unknown) {
        logger.error?.(
          { conversationId: conversation._id.toString() },
          'Could not schedule the opening message; the lead is saved either way.',
        );
      }
    }

    await publishConversationChanged({
      organizationId,
      conversationId: conversation._id,
      assignedTo: conversation.assignedTo,
      reason: REALTIME_REASONS.IMPORTED,
    });

    return { outcome: 'created', conversation };
  };

  return { createManualLead };
};

export type ManualLeadService = ReturnType<typeof createManualLeadService>;
