/**
 * The shared tail of lead importing: everything that happens once a source — a Google Sheet or
 * the Meta Graph API — has produced a list of `NormalizedMetaLead`.
 *
 * It lives apart from `lead-import.service.ts` so the two source kinds cannot drift. Contact
 * resolution, the ADR-005 AI-context boundary, the submission ledger, the activity entry, the
 * owner ping and the per-lead failure isolation are written once and both importers run the same
 * code. A change to how a lead becomes a CRM record lands on both, or on neither.
 *
 * Deliberately not transactional, mirroring inbound WhatsApp ingestion: the conversation upsert
 * is idempotent and the submission ledger's unique index is the duplicate check, so a crash
 * mid-lead costs at most a contact with no submission attached, which the next poll repairs.
 * Nothing here sends a message — an imported lead is a thread waiting for a human.
 */
import { ACTIVITY_EVENTS } from '../../constants/activity-events.js';
import { CONVERSATION_STAGES } from '../../constants/conversation-stages.js';
import {
  LEAD_SKIP_REASONS,
  LEAD_SUBMISSION_STATUSES,
  type LeadSkipReason,
} from '../../constants/lead-submission-statuses.js';
import { env, type Env } from '../../config/env.js';
import { logger as defaultLogger } from '../../config/logger.js';
import { type ObjectIdLike } from '../../types/common.js';
import { createActivity as defaultCreateActivity } from '../activity/activity-log.repository.js';
import { sendNewLeadAlert as defaultSendNewLeadAlert } from '../ai-brain/new-lead-alert.service.js';
import {
  attachContactEmailIfMissing as defaultAttachContactEmailIfMissing,
  attachContactPhoneIfMissing as defaultAttachContactPhoneIfMissing,
  findOrCreateContactByProviderKey as defaultFindOrCreateContactByProviderKey,
} from '../contacts/contact.repository.js';
import {
  mergeConversationAiContext as defaultMergeConversationAiContext,
  touchConversation as defaultTouchConversation,
  upsertConversationForContact as defaultUpsertConversationForContact,
} from '../conversations/conversation.repository.js';
import { recomputeLeadScore as defaultRecomputeLeadScore } from '../conversations/lead-score.service.js';
import { type ConversationDocument } from '../conversations/conversation.model.js';
import {
  computeContactProviderKeyFromPhone as defaultComputeContactProviderKeyFromPhone,
  normalizePhoneNumber as defaultNormalizePhoneNumber,
} from '../privacy/protected-pii.service.js';
import { REALTIME_REASONS } from '../realtime/realtime.events.js';
import { publishConversationChanged as defaultPublishConversationChanged } from '../realtime/realtime.publisher.js';
import { LeadSourceError, sanitizeLeadSourceErrorText } from './lead-source.errors.js';
import { type LeadSourceDocument } from './lead-source.model.js';
import {
  countLeadSubmissionsForConversation as defaultCountLeadSubmissionsForConversation,
  createLeadSubmission as defaultCreateLeadSubmission,
  findImportedExternalIds as defaultFindImportedExternalIds,
} from './lead-submission.repository.js';
import { type NormalizedMetaLead } from './meta-lead.mapper.js';

export const LEAD_CONTACT_SOURCE = 'meta-lead-form';

const WHATSAPP_JID_DOMAIN = 's.whatsapp.net';

export const isDuplicateKeyError = (error: unknown): boolean =>
  Boolean(error && typeof error === 'object' && 'code' in error && error.code === 11000);

/**
 * Our own errors carry messages written for the admin ("the sheet is not link-shared") and are
 * safe to persist. Anything else could be a driver or fetch error echoing the sheet URL, the
 * Graph URL (which carries the access token) or row content, so only its code/name survives.
 * Either way the result goes through the sanitizer before it can reach `lastError`.
 */
export const describeError = (error: unknown): string => {
  if (error instanceof LeadSourceError) {
    return sanitizeLeadSourceErrorText(error.message);
  }

  const errorRecord =
    error && typeof error === 'object' ? (error as { code?: unknown; name?: unknown }) : {};

  return sanitizeLeadSourceErrorText(String(errorRecord.code ?? errorRecord.name ?? 'lead_import_failed'));
};

export interface LeadImportCounts {
  imported: number;
  duplicates: number;
  skipped: number;
  failed: number;
}

export interface LeadBatchResult {
  counts: LeadImportCounts;
  /**
   * Newest `submittedAt` among the leads this batch carried to a terminal outcome. The Meta
   * importer stores it as the source's watermark; the sheet importer has no use for it.
   */
  newestSubmittedAt: Date | null;
}

export interface CreateLeadPipelineOptions {
  config?: Env;
  contactRepository?: {
    findOrCreateContactByProviderKey: typeof defaultFindOrCreateContactByProviderKey;
    attachContactPhoneIfMissing: typeof defaultAttachContactPhoneIfMissing;
    attachContactEmailIfMissing: typeof defaultAttachContactEmailIfMissing;
  };
  conversationRepository?: {
    upsertConversationForContact: typeof defaultUpsertConversationForContact;
    touchConversation: typeof defaultTouchConversation;
    mergeConversationAiContext?: typeof defaultMergeConversationAiContext;
  };
  leadSubmissionRepository?: {
    createLeadSubmission: typeof defaultCreateLeadSubmission;
    findImportedExternalIds: typeof defaultFindImportedExternalIds;
    countLeadSubmissionsForConversation: typeof defaultCountLeadSubmissionsForConversation;
  };
  createActivity?: typeof defaultCreateActivity;
  /**
   * The 🔔 owner ping (Phase 6), fired here as well as from inbound WhatsApp: a lead who came in
   * off an ad should reach the owner's phone, not only a dashboard nobody has open. Internally
   * failure-isolated and idempotent per conversation (`newLeadAlertSentAt` is claimed
   * atomically), so an imported lead who then messages produces one alert, not two.
   */
  sendNewLeadAlert?: typeof defaultSendNewLeadAlert;
  /**
   * Rescores the lead off the facts this form just contributed. Internally failure-isolated and
   * never throws, exactly like `sendNewLeadAlert` above - one unscoreable row must not abandon
   * the rest of the batch.
   */
  recomputeLeadScore?: typeof defaultRecomputeLeadScore;
  publishEvent?: (options: {
    organizationId?: ObjectIdLike;
    conversationId?: ObjectIdLike;
    assignedTo?: ObjectIdLike | null;
    reason?: string;
  }) => Promise<unknown>;
  computeContactProviderKeyFromPhone?: typeof defaultComputeContactProviderKeyFromPhone;
  normalizePhoneNumber?: typeof defaultNormalizePhoneNumber;
  logger?: { error?: (...args: unknown[]) => void; warn?: (...args: unknown[]) => void };
}

export const createLeadPipeline = ({
  config = env,
  contactRepository = {
    findOrCreateContactByProviderKey: defaultFindOrCreateContactByProviderKey,
    attachContactPhoneIfMissing: defaultAttachContactPhoneIfMissing,
    attachContactEmailIfMissing: defaultAttachContactEmailIfMissing,
  },
  conversationRepository = {
    upsertConversationForContact: defaultUpsertConversationForContact,
    touchConversation: defaultTouchConversation,
    mergeConversationAiContext: defaultMergeConversationAiContext,
  },
  leadSubmissionRepository = {
    createLeadSubmission: defaultCreateLeadSubmission,
    findImportedExternalIds: defaultFindImportedExternalIds,
    countLeadSubmissionsForConversation: defaultCountLeadSubmissionsForConversation,
  },
  createActivity = defaultCreateActivity,
  sendNewLeadAlert = defaultSendNewLeadAlert,
  recomputeLeadScore = defaultRecomputeLeadScore,
  publishEvent = defaultPublishConversationChanged as CreateLeadPipelineOptions['publishEvent'],
  computeContactProviderKeyFromPhone = defaultComputeContactProviderKeyFromPhone,
  normalizePhoneNumber = defaultNormalizePhoneNumber,
  logger = defaultLogger,
}: CreateLeadPipelineOptions = {}) => {
  const maxRowsPerTick = Number(config.LEAD_IMPORT_MAX_ROWS_PER_TICK ?? 200);

  const recordSkippedLead = async ({
    leadSource,
    lead,
    skipReason,
  }: {
    leadSource: LeadSourceDocument;
    lead: NormalizedMetaLead;
    skipReason: LeadSkipReason;
  }): Promise<void> => {
    // Written to the ledger rather than retried: the same lead will be just as unusable on the
    // next poll, and an admin needs to see the count to know the form needs fixing.
    await leadSubmissionRepository.createLeadSubmission({
      organizationId: leadSource.organizationId,
      leadSourceId: leadSource._id,
      externalId: lead.externalId,
      status: LEAD_SUBMISSION_STATUSES.SKIPPED,
      skipReason,
      payload: {
        fullName: lead.fullName,
        phone: lead.phone,
        email: lead.email,
        inboxUrl: lead.inboxUrl,
        customFields: lead.customFields,
        raw: lead.raw,
      },
      submittedAt: lead.submittedAt,
      platform: lead.platform,
      isOrganic: lead.isOrganic,
      leadStatus: lead.leadStatus,
      campaignId: lead.campaignId,
      campaignName: lead.campaignName,
      adId: lead.adId,
      adName: lead.adName,
      adsetId: lead.adsetId,
      adsetName: lead.adsetName,
      formId: lead.formId,
      formName: lead.formName,
    });
  };

  const importLead = async ({
    leadSource,
    lead,
  }: {
    leadSource: LeadSourceDocument;
    lead: NormalizedMetaLead;
  }): Promise<'imported' | 'duplicate' | 'skipped'> => {
    const organizationId = leadSource.organizationId;
    const countryCodeOptions = { defaultCountryCode: leadSource.defaultCountryCode };
    const normalizedPhone = normalizePhoneNumber(lead.phone, countryCodeOptions);

    if (normalizedPhone === null) {
      await recordSkippedLead({
        leadSource,
        lead,
        skipReason: lead.phone === null ? LEAD_SKIP_REASONS.NO_PHONE : LEAD_SKIP_REASONS.UNPARSABLE_PHONE,
      });

      return 'skipped';
    }

    // The identity bridge: hashing `<digits>@s.whatsapp.net` produces the same blind index that
    // inbound ingestion derives from the sender's JID, so a lead who later messages the number
    // resolves to this very contact instead of a second one.
    const providerContactKey = computeContactProviderKeyFromPhone(
      normalizedPhone,
      countryCodeOptions,
    );

    if (!providerContactKey) {
      await recordSkippedLead({ leadSource, lead, skipReason: LEAD_SKIP_REASONS.NO_IDENTITY });
      return 'skipped';
    }

    const { contact, created: contactCreated } =
      await contactRepository.findOrCreateContactByProviderKey({
        organizationId,
        providerContactKey,
        displayName: lead.displayName,
        phone: normalizedPhone,
        providerJids: [`${normalizedPhone}@${WHATSAPP_JID_DOMAIN}`],
        source: LEAD_CONTACT_SOURCE,
      });

    if (!contact) {
      throw new LeadSourceError('Contact could not be resolved for the lead.', {
        code: 'LEAD_CONTACT_UNRESOLVED',
      });
    }

    // A contact first seen over WhatsApp has a phone but no email, and one first seen through a
    // form may predate its phone being known. Both fills are "only if missing" in the query.
    await contactRepository.attachContactPhoneIfMissing({
      contactId: contact._id,
      organizationId,
      phone: normalizedPhone,
    });

    await contactRepository.attachContactEmailIfMissing({
      contactId: contact._id,
      organizationId,
      email: lead.email,
    });

    const conversation = (await conversationRepository.upsertConversationForContact({
      organizationId,
      whatsappAccountId: leadSource.whatsappAccountId,
      contactId: contact._id,
      leadId: contact.leadId,
      displayName: contact.displayName,
      defaults: {
        stage: CONVERSATION_STAGES.NEW,
      },
    })) as ConversationDocument;

    // ADR-005, the same boundary lead-context.service.ts already enforces: the answers a lead
    // typed into a third-party form only reach the AI provider when the admin who connected the
    // source said so. `aiFacts` IS the AI's copy of them - it is posted to ai-brain-service on
    // every call - so the toggle gates this write exactly as it gates the prompt section. With
    // the toggle off nothing is written and the AI carries on asking its own questions; the
    // submission ledger and the lead panel still hold every answer, unchanged. The boundary is
    // per source and identical for a sheet and for the Graph API: where the answers came from
    // has never been what decides whether they may leave the estate.
    if (leadSource.aiContextEnabled) {
      await conversationRepository.mergeConversationAiContext?.({
        conversationId: conversation._id,
        organizationId,
        facts: lead.canonicalFacts,
        category: lead.category,
      });

      // The facts blob just changed, so the score is stale. Only inside this branch: with the AI
      // context toggle off nothing was written to `aiFacts`, and scoring a lead off answers the
      // AI is not allowed to see would put a number on the dashboard nothing else agrees with.
      await recomputeLeadScore?.({
        organizationId,
        conversationId: conversation._id,
        whatsappAccountId: leadSource.whatsappAccountId,
      });
    }

    const priorSubmissions = contactCreated
      ? 0
      : await leadSubmissionRepository.countLeadSubmissionsForConversation({
          organizationId,
          conversationId: conversation._id,
        });

    try {
      await leadSubmissionRepository.createLeadSubmission({
        organizationId,
        leadSourceId: leadSource._id,
        externalId: lead.externalId,
        status: LEAD_SUBMISSION_STATUSES.IMPORTED,
        contactId: contact._id,
        conversationId: conversation._id,
        payload: {
          fullName: lead.fullName,
          phone: normalizedPhone,
          email: lead.email,
          inboxUrl: lead.inboxUrl,
          customFields: lead.customFields,
          raw: lead.raw,
        },
        submittedAt: lead.submittedAt,
        platform: lead.platform,
        isOrganic: lead.isOrganic,
        leadStatus: lead.leadStatus,
        campaignId: lead.campaignId,
        campaignName: lead.campaignName,
        adId: lead.adId,
        adName: lead.adName,
        adsetId: lead.adsetId,
        adsetName: lead.adsetName,
        formId: lead.formId,
        formName: lead.formName,
      });
    } catch (error: unknown) {
      if (isDuplicateKeyError(error)) {
        return 'duplicate';
      }

      throw error;
    }

    const isResubmission = priorSubmissions > 0;

    await createActivity({
      organizationId,
      whatsappAccountId: conversation.whatsappAccountId,
      conversationId: conversation._id,
      actorId: null,
      eventType: isResubmission ? ACTIVITY_EVENTS.LEAD_RESUBMITTED : ACTIVITY_EVENTS.LEAD_IMPORTED,
      summary: isResubmission
        ? 'Lead submitted the form again.'
        : `Lead imported from ${leadSource.name}.`,
      metadata: {
        leadSourceId: leadSource._id.toString(),
        externalId: lead.externalId,
        campaignName: lead.campaignName,
        formName: lead.formName,
        platform: lead.platform,
      },
    });

    if (isResubmission) {
      await conversationRepository.touchConversation({
        conversationId: conversation._id,
        organizationId,
      });
    }

    await publishEvent?.({
      organizationId,
      conversationId: conversation._id,
      assignedTo: conversation.assignedTo,
      reason: REALTIME_REASONS.IMPORTED,
    });

    // Last, and guarded: the lead is fully recorded by this point, and a courtesy ping that
    // cannot go out (no running WhatsApp session, most often) must never turn a successful
    // import into a failed row. The alert quotes no first message - there isn't one yet - so it
    // summarises the form instead. Not gated on `aiContextEnabled`: that toggle is about what
    // leaves the estate for the AI provider, and this is the business's own owner reading their
    // own lead's answers on their own phone, the same way the inbound alert already quotes a
    // lead's first message verbatim.
    try {
      await sendNewLeadAlert?.({
        organizationId,
        whatsappAccountId: conversation.whatsappAccountId,
        conversationId: conversation._id,
        leadDisplayName: conversation.displayName,
        phone: normalizedPhone,
        facts: lead.canonicalFacts,
        category: lead.category,
        sourceLabel: leadSource.name,
      });
    } catch (error: unknown) {
      logger.error?.(
        { conversationId: conversation._id.toString(), reason: describeError(error) },
        'New-lead owner alert threw unexpectedly; the lead is imported either way.',
      );
    }

    return 'imported';
  };

  /**
   * Takes whatever the source produced and carries it the rest of the way: the `importFromTime`
   * cutoff, the ledger pre-filter, the per-tick cap and the per-lead failure isolation.
   *
   * Leads are consumed in the order given. The Meta importer hands them over oldest-first on
   * purpose, so that when the cap truncates the batch the watermark only advances past leads that
   * were actually processed and the rest come back on the next tick.
   */
  const importLeads = async ({
    leadSource,
    leads,
  }: {
    leadSource: LeadSourceDocument;
    leads: readonly NormalizedMetaLead[];
  }): Promise<LeadBatchResult> => {
    const counts: LeadImportCounts = { imported: 0, duplicates: 0, skipped: 0, failed: 0 };

    const inWindow = leads.filter(
      // A lead with no timestamp is imported: the ledger stops it repeating, and dropping leads
      // because a field was blank would be worse than importing one extra.
      (lead) => lead.submittedAt === null || lead.submittedAt > leadSource.importFromTime,
    );

    const alreadyImported = await leadSubmissionRepository.findImportedExternalIds({
      organizationId: leadSource.organizationId,
      leadSourceId: leadSource._id,
      externalIds: inWindow.map((lead) => lead.externalId),
    });

    const pendingLeads = inWindow
      .filter((lead) => !alreadyImported.has(lead.externalId))
      .slice(0, maxRowsPerTick);

    counts.duplicates = inWindow.length - pendingLeads.length;

    let newestSubmittedAt: Date | null = null;

    for (const lead of pendingLeads) {
      try {
        const outcome = await importLead({ leadSource, lead });

        if (outcome === 'imported') {
          counts.imported += 1;
        } else if (outcome === 'duplicate') {
          counts.duplicates += 1;
        } else {
          counts.skipped += 1;
        }

        if (
          lead.submittedAt !== null &&
          (newestSubmittedAt === null || lead.submittedAt > newestSubmittedAt)
        ) {
          newestSubmittedAt = lead.submittedAt;
        }
      } catch (error: unknown) {
        // One malformed lead must not abandon the rest of the batch.
        counts.failed += 1;
        logger.error?.(
          { leadSourceId: leadSource._id.toString(), reason: describeError(error) },
          'Lead row import failed safely.',
        );
      }
    }

    return { counts, newestSubmittedAt };
  };

  return { importLead, importLeads, recordSkippedLead };
};

export type LeadPipeline = ReturnType<typeof createLeadPipeline>;
