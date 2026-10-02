/**
 * Leads arriving in seconds instead of on the ten-minute poll.
 *
 * A leadgen webhook carries an id and almost nothing else - no answers, no name, no phone. So the
 * work here is: decide the event is genuine, find which of this organisation's sources it belongs
 * to, fetch the lead with that source's own Page token, and hand it to the SAME pipeline the
 * poller uses.
 *
 * ONE PIPELINE, TWO DOORS. `importLead` is the only thing that creates a lead, here as in the
 * poller - so deduplication, the LeadSubmission ledger, the allowlist gate, the auto-greet
 * scheduling and the owner alert all behave identically whichever door the lead came through.
 * A webhook-specific creation path would be a second place for all of that to drift.
 *
 * WHICH MAKES DOUBLE DELIVERY A NON-EVENT. LeadSubmission is unique on
 * (organizationId, leadSourceId, externalId), and `importLead` returns 'duplicate' on the
 * duplicate-key error rather than throwing. So a webhook and a poll that both see the same lead
 * produce one conversation and one ledger row - which is exactly what Meta's retry behaviour
 * needs, since it re-delivers anything we do not acknowledge quickly.
 */
import { type Env, env } from '../../config/env.js';
import { logger as defaultLogger } from '../../config/logger.js';
import { createLeadPipeline } from './lead-pipeline.service.js';
import { fetchMetaLeadById as defaultFetchMetaLeadById } from './meta-graph.client.js';
import { decryptMetaAccessTokenFromStorage as defaultDecryptMetaAccessTokenFromStorage } from './meta-credentials.service.js';
import { mapMetaGraphLead } from './meta-lead.mapper.js';
import {
  countLeadSourceImport as defaultCountLeadSourceImport,
  findLeadSourceForMetaForm as defaultFindLeadSourceForMetaForm,
} from './lead-source.repository.js';
import { type FieldKeyOverrides } from './lead-field-rules.js';
import { type LeadSourceDocument } from './lead-source.model.js';

/** One `changes[]` entry off a `page` webhook, once we have decided we care about it. */
export interface MetaLeadgenEvent {
  leadgenId: string;
  pageId: string;
  formId: string | null;
  /** Meta's own epoch-seconds stamp for when the lead was created. */
  createdTime: number | null;
}

/**
 * Pulls the leadgen events out of a webhook body, ignoring everything else.
 *
 * Meta posts one envelope for many kinds of Page change; `field: 'leadgen'` is the only one this
 * app subscribes to, but a Page subscribed by someone else for another reason still delivers
 * here. Anything unrecognised is dropped silently rather than logged as an error - it is not one.
 *
 * Total, never throws: a malformed envelope must produce an empty list and a 200, because Meta
 * retries anything else and a parse bug would become an infinite redelivery loop.
 */
export const extractLeadgenEvents = (body: unknown): MetaLeadgenEvent[] => {
  const envelope = (body ?? {}) as { object?: unknown; entry?: unknown[] };

  if (envelope.object !== 'page' || !Array.isArray(envelope.entry)) {
    return [];
  }

  const events: MetaLeadgenEvent[] = [];

  for (const rawEntry of envelope.entry) {
    const entry = (rawEntry ?? {}) as { changes?: unknown[] };

    if (!Array.isArray(entry.changes)) {
      continue;
    }

    for (const rawChange of entry.changes) {
      const change = (rawChange ?? {}) as { field?: unknown; value?: unknown };

      if (change.field !== 'leadgen') {
        continue;
      }

      const value = (change.value ?? {}) as {
        leadgen_id?: unknown;
        page_id?: unknown;
        form_id?: unknown;
        created_time?: unknown;
      };

      const leadgenId = typeof value.leadgen_id === 'string' ? value.leadgen_id.trim() : '';
      // The page id is what proves this event belongs to a source WE configured. Without it the
      // event is unattributable and must be dropped, not guessed at.
      const pageId =
        typeof value.page_id === 'string'
          ? value.page_id.trim()
          : typeof value.page_id === 'number'
            ? String(value.page_id)
            : '';

      if (leadgenId === '' || pageId === '') {
        continue;
      }

      const formId =
        typeof value.form_id === 'string'
          ? value.form_id.trim()
          : typeof value.form_id === 'number'
            ? String(value.form_id)
            : null;

      const createdTime = Number(value.created_time);

      events.push({
        leadgenId,
        pageId,
        formId: formId === '' ? null : formId,
        createdTime: Number.isFinite(createdTime) ? createdTime : null,
      });
    }
  }

  return events;
};

/** The overrides a source's stored mappings amount to, in the shape parseFormFields wants. */
export const fieldKeyOverridesFor = (leadSource: {
  fieldMappings?: { metaKey?: string; factKey?: string | null }[] | null;
}): FieldKeyOverrides => {
  const overrides: Record<string, string | null> = {};

  for (const mapping of leadSource.fieldMappings ?? []) {
    const metaKey = typeof mapping?.metaKey === 'string' ? mapping.metaKey.trim() : '';

    if (metaKey === '') {
      continue;
    }

    overrides[metaKey] = typeof mapping.factKey === 'string' && mapping.factKey !== ''
      ? mapping.factKey
      : null;
  }

  return overrides;
};

export type MetaWebhookOutcome =
  | 'imported'
  | 'duplicate'
  | 'skipped'
  | 'no_source'
  | 'no_token'
  | 'failed';

export interface CreateMetaWebhookServiceOptions {
  config?: Env;
  findLeadSourceForMetaForm?: typeof defaultFindLeadSourceForMetaForm;
  fetchMetaLeadById?: typeof defaultFetchMetaLeadById;
  // Injected for the same reason the Graph call is: the real one reaches the encryption keyring,
  // which a unit test has no business needing.
  decryptMetaAccessTokenFromStorage?: typeof defaultDecryptMetaAccessTokenFromStorage;
  leadPipeline?: Pick<ReturnType<typeof createLeadPipeline>, 'importLead'>;
  countLeadSourceImport?: typeof defaultCountLeadSourceImport;
  logger?: { info?: (...args: unknown[]) => void; error?: (...args: unknown[]) => void };
}

export const createMetaWebhookService = ({
  config = env,
  findLeadSourceForMetaForm = defaultFindLeadSourceForMetaForm,
  fetchMetaLeadById = defaultFetchMetaLeadById,
  decryptMetaAccessTokenFromStorage = defaultDecryptMetaAccessTokenFromStorage,
  leadPipeline = createLeadPipeline({ config }),
  countLeadSourceImport = defaultCountLeadSourceImport,
  logger = defaultLogger,
}: CreateMetaWebhookServiceOptions = {}) => {
  /**
   * One leadgen event, end to end.
   *
   * Never throws. Meta treats a non-2xx as "try again", and a lead that fails for a reason
   * retrying cannot fix - a revoked token, a form nobody configured - would be redelivered for
   * days. The poller is the real safety net for anything genuinely transient.
   */
  const handleLeadgenEvent = async (event: MetaLeadgenEvent): Promise<MetaWebhookOutcome> => {
    try {
      // Ownership check, and the reason a forged body cannot make us create a lead: the page and
      // form have to match a source this organisation configured, with a token it already holds.
      const leadSource = (await findLeadSourceForMetaForm({
        pageId: event.pageId,
        formId: event.formId,
      })) as (LeadSourceDocument & { encryptedMetaAccessToken?: unknown }) | null;

      if (!leadSource) {
        logger.info?.(
          { pageId: event.pageId, formId: event.formId },
          'Meta webhook ignored: no lead source is configured for that page and form.',
        );

        return 'no_source';
      }

      const accessToken = decryptMetaAccessTokenFromStorage(leadSource.encryptedMetaAccessToken);

      if (!accessToken) {
        logger.error?.(
          { leadSourceId: leadSource._id?.toString?.() },
          'Meta webhook could not run: the source has no usable access token. The poller will not work either - reconnect Facebook.',
        );

        return 'no_token';
      }

      const graphLead = await fetchMetaLeadById({
        leadgenId: event.leadgenId,
        accessToken,
        timeoutMs: Number(config.META_GRAPH_TIMEOUT_MS ?? 15_000),
      });

      const lead = mapMetaGraphLead({
        lead: graphLead,
        columnMapping: leadSource.columnMapping,
        formName: leadSource.meta?.formName ?? null,
        fieldKeyOverrides: fieldKeyOverridesFor(leadSource),
      });

      // The same call the poller makes. Everything downstream - dedup, the ledger, the allowlist,
      // the owner alert, the auto-greet - is whatever importLead already does.
      const outcome = await leadPipeline.importLead({ leadSource, lead });

      // Only a genuinely NEW lead counts. `duplicate` is the dedup working - Meta redelivers,
      // and we replay deliveries ourselves - so counting it would inflate the figure every time
      // the same lead arrived twice. `skipped` and `failed` produced no lead at all.
      //
      // The poller keeps this count through recordLeadSourceSync; the webhook never went through
      // that, so a source fed entirely by webhook sat at "0 leads imported" however many it had
      // actually brought in.
      if (outcome === 'imported') {
        // Deliberately not fatal: the lead is already saved. Losing the increment is a wrong
        // number on a dashboard; turning that into 'failed' would have Meta redeliver a lead
        // that imported perfectly well.
        await countLeadSourceImport({ leadSourceId: leadSource._id }).catch((error: unknown) => {
          logger.error?.(
            { code: (error as { code?: unknown })?.code },
            'Meta webhook imported a lead but could not update the source import count.',
          );
        });
      }

      return outcome;
    } catch (error: unknown) {
      const err = error as { code?: unknown; name?: unknown };

      logger.error?.(
        { code: err?.code, name: err?.name, pageId: event.pageId },
        'Meta webhook failed to process a lead safely; the poller will pick it up on the next tick.',
      );

      return 'failed';
    }
  };

  /**
   * Every event in one delivery.
   *
   * Sequential rather than parallel: a single delivery rarely carries more than one lead, and the
   * outbound side is rate limited anyway - concurrency here would buy nothing and make the
   * per-event failure isolation harder to reason about.
   */
  const handleWebhookBody = async (
    body: unknown,
  ): Promise<{ received: number; outcomes: MetaWebhookOutcome[] }> => {
    const events = extractLeadgenEvents(body);
    const outcomes: MetaWebhookOutcome[] = [];

    for (const event of events) {
      outcomes.push(await handleLeadgenEvent(event));
    }

    return { received: events.length, outcomes };
  };

  return { handleLeadgenEvent, handleWebhookBody };
};

export type MetaWebhookService = ReturnType<typeof createMetaWebhookService>;
