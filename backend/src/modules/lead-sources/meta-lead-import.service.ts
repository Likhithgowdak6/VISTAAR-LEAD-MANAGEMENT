/**
 * The Meta Lead Ads leg of the importer: ask the Graph API for a form's leads instead of reading
 * the spreadsheet Meta was writing them into.
 *
 * It owns only the two things that are genuinely different from the sheet path — talking to Meta,
 * and keeping a watermark so each tick asks for what is new — and then hands the leads to
 * `lead-pipeline.service.ts`, which is the same code the sheet importer runs. Ledger, dedup,
 * contact and conversation creation, the ADR-005 AI-context boundary, the `importFromTime`
 * cutoff and the sync bookkeeping are therefore identical by construction, not by agreement.
 */
import { env, type Env } from '../../config/env.js';
import { LEAD_SOURCE_KINDS } from '../../constants/lead-source-kinds.js';
import { type ObjectIdLike } from '../../types/common.js';
import {
  META_GRAPH_FAILURE_KINDS,
  MetaGraphError,
  MetaLeadSourceNotConfiguredError,
} from './lead-source.errors.js';
import { type LeadSourceDocument } from './lead-source.model.js';
import { decryptMetaAccessTokenFromStorage as defaultDecryptMetaAccessToken } from './meta-credentials.service.js';
import {
  fetchMetaFormLeads as defaultFetchMetaFormLeads,
  listMetaLeadForms as defaultListMetaLeadForms,
  type MetaGraphLead,
} from './meta-graph.client.js';
import { mapMetaGraphLead as defaultMapMetaGraphLead } from './meta-lead.mapper.js';
import { type LeadBatchResult, type LeadPipeline } from './lead-pipeline.service.js';

/**
 * Meta's `time_created` filter is `GREATER_THAN` on whole seconds. Asking for "> the exact second
 * of the newest lead we hold" would return that same lead forever on a boundary tie, so the
 * watermark is nudged forward by one second before it is sent.
 */
const WATERMARK_NUDGE_MS = 1000;

export interface CreateMetaLeadImportServiceOptions {
  config?: Env;
  pipeline: LeadPipeline;
  fetchMetaFormLeads?: typeof defaultFetchMetaFormLeads;
  listMetaLeadForms?: typeof defaultListMetaLeadForms;
  mapMetaGraphLead?: typeof defaultMapMetaGraphLead;
  decryptMetaAccessToken?: typeof defaultDecryptMetaAccessToken;
  leadSourceRepository?: {
    recordMetaLeadWatermark: (params: {
      leadSourceId?: ObjectIdLike;
      lastLeadCreatedAt: Date;
    }) => Promise<unknown>;
  };
  logger?: { error?: (...args: unknown[]) => void; warn?: (...args: unknown[]) => void };
}

/**
 * The instant this source should ask Meta about. The watermark once one tick has succeeded,
 * `importFromTime` before that — which is "now" for a source created without backfill and the
 * epoch for one created with it, exactly as for a sheet.
 */
export const resolveMetaSince = (leadSource: LeadSourceDocument): Date | null => {
  const watermark = leadSource.meta?.lastLeadCreatedAt ?? null;

  if (watermark) {
    return new Date(watermark.getTime() + WATERMARK_NUDGE_MS);
  }

  const importFrom = leadSource.importFromTime;

  // Epoch means "import everything the form has ever held": send no filter at all rather than a
  // filter for leads created after 1970, which Meta would happily but pointlessly evaluate.
  if (!importFrom || importFrom.getTime() <= 0) {
    return null;
  }

  return importFrom;
};

export const createMetaLeadImportService = ({
  config = env,
  pipeline,
  fetchMetaFormLeads = defaultFetchMetaFormLeads,
  listMetaLeadForms = defaultListMetaLeadForms,
  mapMetaGraphLead = defaultMapMetaGraphLead,
  decryptMetaAccessToken = defaultDecryptMetaAccessToken,
  leadSourceRepository,
  logger,
}: CreateMetaLeadImportServiceOptions) => {
  const maxLeadsPerTick = Number(config.LEAD_IMPORT_MAX_ROWS_PER_TICK ?? 200);
  const maxPagesPerTick = Number(config.META_GRAPH_MAX_PAGES_PER_TICK ?? 10);
  const timeoutMs = Number(config.META_GRAPH_TIMEOUT_MS ?? 15_000);

  /**
   * Which form ids this source covers. One when the admin picked a form; every form on the page
   * when they chose "all forms", which is resolved on each tick so a form added on Meta this
   * morning starts importing this afternoon without anyone touching the CRM.
   */
  const resolveFormIds = async ({
    leadSource,
    accessToken,
  }: {
    leadSource: LeadSourceDocument;
    accessToken: string;
  }): Promise<{ id: string; name: string | null }[]> => {
    const configuredFormId = leadSource.meta?.formId ?? null;

    if (configuredFormId) {
      return [{ id: configuredFormId, name: leadSource.meta?.formName ?? null }];
    }

    const pageId = leadSource.meta?.pageId ?? null;

    if (!pageId) {
      throw new MetaLeadSourceNotConfiguredError(
        'This Meta source has neither a form nor a page configured.',
      );
    }

    const forms = await listMetaLeadForms({ accessToken, pageId, timeoutMs });

    return forms.map((form) => ({ id: form.id, name: form.name }));
  };

  const importFromSource = async (leadSource: LeadSourceDocument): Promise<LeadBatchResult> => {
    if (config.META_LEAD_ADS_ENABLED !== true) {
      throw new MetaLeadSourceNotConfiguredError(
        'Meta Lead Ads importing is switched off on this server (META_LEAD_ADS_ENABLED).',
      );
    }

    const accessToken = decryptMetaAccessToken(leadSource.encryptedMetaAccessToken);

    if (!accessToken) {
      // Either no token was ever saved, or the query that loaded this source did not opt in to
      // the `select: false` field. Both are bugs the admin can act on, and neither is a retry.
      throw new MetaLeadSourceNotConfiguredError();
    }

    const since = resolveMetaSince(leadSource);
    const forms = await resolveFormIds({ leadSource, accessToken });

    const graphLeads: { lead: MetaGraphLead; formName: string | null }[] = [];

    for (const form of forms) {
      if (graphLeads.length >= maxLeadsPerTick) {
        break;
      }

      const { leads } = await fetchMetaFormLeads({
        accessToken,
        formId: form.id,
        since,
        maxLeads: maxLeadsPerTick - graphLeads.length,
        maxPages: maxPagesPerTick,
        timeoutMs,
      });

      leads.forEach((lead) => {
        graphLeads.push({ lead, formName: form.name });
      });
    }

    const mapped = graphLeads
      .map(({ lead, formName }) =>
        mapMetaGraphLead({ lead, columnMapping: leadSource.columnMapping, formName }),
      )
      // The floor, enforced on what came back rather than only asked for in the query.
      //
      // `since` above is a REQUEST filter, and a request filter is a courtesy: a boundary tie, a
      // lead whose `created_time` Meta revises, a watermark reset, or someone flipping backfill on
      // later would all put an old lead into this list. For an events business that is not a
      // duplicate, it is a message to someone whose wedding was last year - which is exactly what
      // this business asked never to happen. So anything older than the day the source was
      // connected is dropped here, unconditionally, whatever Meta chose to return.
      //
      // Skipped only when backfill was deliberately requested (importFromTime at the epoch), which
      // is the one case where reaching into the past is the point.
      .filter((lead) => {
        const floor = leadSource.importFromTime;

        if (!floor || floor.getTime() <= 0 || !lead.submittedAt) {
          return true;
        }

        return lead.submittedAt.getTime() >= floor.getTime();
      })
      // Oldest first. Meta serves newest first, and the pipeline's per-tick cap slices from the
      // front: taking the oldest means the watermark only ever advances over leads that were
      // actually looked at, and the newer remainder is still newer than it next tick.
      .sort((left, right) => (left.submittedAt?.getTime() ?? 0) - (right.submittedAt?.getTime() ?? 0));

    const result = await pipeline.importLeads({ leadSource, leads: mapped });

    // Only on a clean tick. A failed lead is one the watermark must not step over, or it would
    // never be asked for again — the ledger would not save it, because nothing was written.
    if (result.counts.failed === 0 && result.newestSubmittedAt !== null) {
      try {
        await leadSourceRepository?.recordMetaLeadWatermark({
          leadSourceId: leadSource._id,
          lastLeadCreatedAt: result.newestSubmittedAt,
        });
      } catch (error: unknown) {
        // A watermark that failed to save costs one extra fetch next tick and nothing else: the
        // ledger still refuses the duplicates. Never worth failing an otherwise good import.
        logger?.warn?.(
          {
            leadSourceId: leadSource._id.toString(),
            name: error instanceof Error ? error.name : 'unknown',
          },
          'Could not advance the Meta lead watermark; the next poll will re-ask for these leads.',
        );
      }
    }

    return result;
  };

  return { importFromSource, resolveFormIds };
};

export type MetaLeadImportService = ReturnType<typeof createMetaLeadImportService>;

/** True when this source should be handed to the Meta importer rather than the sheet one. */
export const isMetaLeadSource = (leadSource: Pick<LeadSourceDocument, 'kind'>): boolean =>
  leadSource.kind === LEAD_SOURCE_KINDS.META_LEAD_ADS;

/**
 * How a Graph failure should be recorded against the source. An expired token and a missing
 * permission are flagged for a human — they will fail identically on every tick from now until
 * somebody does something — while a throttle or a network blip is an ordinary failed sync that
 * the next poll retries.
 */
export const syncStatusForMetaError = (
  error: unknown,
): 'needs_attention' | 'failed' => {
  if (error instanceof MetaLeadSourceNotConfiguredError) {
    return 'needs_attention';
  }

  if (
    error instanceof MetaGraphError &&
    error.failureKind === META_GRAPH_FAILURE_KINDS.NEEDS_ATTENTION
  ) {
    return 'needs_attention';
  }

  return 'failed';
};
