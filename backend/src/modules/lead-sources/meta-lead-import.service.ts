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
    recordMetaBackfillProgress?: (params: {
      leadSourceId?: ObjectIdLike;
      cursor?: string | null;
      complete?: boolean;
      newestSeenAt?: Date | null;
      truncatedAt?: Date | null;
      completedFormIds?: string[];
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

export interface MetaBackfillState {
  /** True while historical pages are still being walked. */
  backfilling: boolean;
  /** Opaque `paging.cursors.after` to resume from, or null to start at the newest lead. */
  cursor: string | null;
}

/**
 * Whether this source is still reading history, and from where.
 *
 * THE COMPATIBILITY RULE IS THE SUBTLE PART. `backfillComplete` is `undefined` on every source
 * created before resumable backfill existed. Treating that as "not finished" would, on the first
 * tick after deploying this, restart a full historical walk on every live Meta source - lighting
 * up inboxes with leads their owners dealt with weeks ago. So an absent flag plus an established
 * watermark means "legacy, already incremental", and is left alone.
 *
 * A source is only backfilling when backfill was ASKED FOR (`importFromTime` at the epoch), the
 * flag does not say it finished, and either the flag exists - so this code wrote it - or no
 * watermark has ever been set, which means nothing has been read yet.
 */
export const resolveMetaBackfillState = (leadSource: LeadSourceDocument): MetaBackfillState => {
  const meta = leadSource.meta ?? null;
  const complete = meta?.backfillComplete;
  const hasWatermark = (meta?.lastLeadCreatedAt ?? null) !== null;
  const importFrom = leadSource.importFromTime;
  const wantsHistory = !importFrom || importFrom.getTime() <= 0;

  if (!wantsHistory || complete === true) {
    return { backfilling: false, cursor: null };
  }

  // Legacy source: no flag, but it has clearly been running.
  if (complete === undefined && hasWatermark) {
    return { backfilling: false, cursor: null };
  }

  return { backfilling: true, cursor: meta?.backfillCursor ?? null };
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

  /**
   * Moves a backfill forward one tick, or finishes it.
   *
   * THE FORWARD WATERMARK IS NOT TOUCHED WHILE HISTORY REMAINS. Meta serves newest-first, so the
   * newest lead in the whole form arrives on page one; writing it to `lastLeadCreatedAt` there
   * would make every older page older than the filter and unreachable for ever. That was the
   * bug. The newest instant is remembered in `backfillNewestSeenAt` instead and only becomes the
   * watermark on the tick that drains the form.
   *
   * COMPLETION IS MEASURED BY META, NOT BY US: `truncated === false` means Meta had no `next`
   * page left, which is the only trustworthy end-of-history signal available.
   */
  const advanceBackfill = async ({
    leadSource,
    result,
    truncated,
    nextAfter,
    formsThisTick,
    completedFormIds,
    allFormIds,
    exhausted,
  }: {
    leadSource: LeadSourceDocument;
    result: LeadBatchResult;
    truncated: boolean;
    nextAfter: string | null;
    formsThisTick: { id: string; name: string | null }[];
    completedFormIds: readonly string[];
    allFormIds: readonly string[];
    exhausted: boolean;
  }): Promise<void> => {
    const seenBefore = leadSource.meta?.backfillNewestSeenAt ?? null;
    const seenNow = result.newestSubmittedAt;
    const newestSeenAt =
      seenNow !== null && (seenBefore === null || seenNow > seenBefore) ? seenNow : seenBefore;

    if (truncated) {
      await leadSourceRepository?.recordMetaBackfillProgress?.({
        leadSourceId: leadSource._id,
        cursor: nextAfter,
        newestSeenAt,
        truncatedAt: new Date(),
      });

      logger?.warn?.(
        {
          leadSourceId: leadSource._id.toString(),
          imported: result.counts.imported,
          resumable: nextAfter !== null,
        },
        'META_BACKFILL: history is not fully read yet; the next poll resumes from the stored cursor.',
      );

      return;
    }

    // Meta had nothing more for the form read this tick. Record it done, then decide whether
    // the SOURCE is done - which for an all-forms source means every form, not just this one.
    const doneNow = exhausted
      ? [...completedFormIds]
      : [...new Set([...completedFormIds, ...formsThisTick.map((form) => form.id)])];
    const sourceComplete = allFormIds.every((id) => doneNow.includes(id));

    await leadSourceRepository?.recordMetaBackfillProgress?.({
      leadSourceId: leadSource._id,
      cursor: null,
      // Only when the LAST form is drained. Marking it complete earlier would strand the rest.
      ...(sourceComplete ? { complete: true } : {}),
      newestSeenAt,
      truncatedAt: null,
      completedFormIds: doneNow,
    });

    if (!sourceComplete) {
      // More forms to walk; the watermark stays unset so their older leads remain reachable.
      return;
    }

    if (newestSeenAt !== null) {
      await leadSourceRepository?.recordMetaLeadWatermark({
        leadSourceId: leadSource._id,
        lastLeadCreatedAt: newestSeenAt,
      });
    }
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

    const backfill = resolveMetaBackfillState(leadSource);
    // A backfill never filters by time: its whole job is to reach pages OLDER than anything a
    // forward filter would admit. It resumes by cursor instead.
    const since = backfill.backfilling ? null : resolveMetaSince(leadSource);
    const forms = await resolveFormIds({ leadSource, accessToken });

    const graphLeads: { lead: MetaGraphLead; formName: string | null }[] = [];
    let truncated = false;
    let nextAfter: string | null = null;

    const completedFormIds = leadSource.meta?.backfillCompletedFormIds ?? [];
    /**
     * ONE FORM PER TICK WHILE BACKFILLING.
     *
     * A cursor belongs to a single form's page walk, so a source set to "all forms on this page"
     * cannot resume several at once from one stored value. Rather than keep a map of cursors -
     * or silently get multi-form backfill wrong - the backfill drains one form to its end,
     * records it, and takes the next one on the following tick. A single-form source is just the
     * degenerate case of that.
     */
    const formsThisTick = backfill.backfilling
      ? forms.filter((form) => !completedFormIds.includes(form.id)).slice(0, 1)
      : forms;

    // Every form is done and Meta had nothing more to give: the backfill is finished even though
    // this tick read nothing.
    const backfillExhausted = backfill.backfilling && formsThisTick.length === 0;

    for (const form of formsThisTick) {
      if (graphLeads.length >= maxLeadsPerTick) {
        // Stopped by the per-tick cap with forms still unread. Treated as truncated so the
        // watermark is withheld; without it an incremental poll over several forms would
        // advance past the ones never reached.
        truncated = true;
        break;
      }

      const page = await fetchMetaFormLeads({
        accessToken,
        formId: form.id,
        since,
        maxLeads: maxLeadsPerTick - graphLeads.length,
        maxPages: maxPagesPerTick,
        after: backfill.backfilling ? backfill.cursor : null,
        timeoutMs,
      });

      if (page.truncated) {
        truncated = true;
        nextAfter = page.nextAfter;
      }

      page.leads.forEach((lead) => {
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

    // Nothing is recorded after a failed lead. A failure means that lead was not written, so
    // stepping the cursor or the watermark past it would lose it for good; re-reading the same
    // page next tick is free, because the ledger refuses the ones that did land.
    const clean = result.counts.failed === 0;

    if (clean) {
      try {
        if (backfill.backfilling) {
          await advanceBackfill({
            leadSource,
            result,
            truncated,
            nextAfter,
            formsThisTick,
            completedFormIds,
            allFormIds: forms.map((form) => form.id),
            exhausted: backfillExhausted,
          });
        } else if (result.newestSubmittedAt !== null) {
          await leadSourceRepository?.recordMetaLeadWatermark({
            leadSourceId: leadSource._id,
            lastLeadCreatedAt: result.newestSubmittedAt,
          });
        }
      } catch (error: unknown) {
        // Costs one extra fetch next tick and nothing else: the ledger still refuses the
        // duplicates. Never worth failing an otherwise good import.
        logger?.warn?.(
          {
            leadSourceId: leadSource._id.toString(),
            backfilling: backfill.backfilling,
            name: error instanceof Error ? error.name : 'unknown',
          },
          'Could not record Meta import progress; the next poll will re-ask for these leads.',
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
