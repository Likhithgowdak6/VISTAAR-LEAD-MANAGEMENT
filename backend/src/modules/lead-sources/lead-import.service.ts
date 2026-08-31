/**
 * Turns Meta lead-form submissions into CRM leads, whichever way they arrive.
 *
 * This file owns the *sheet* leg (fetch the CSV export, parse it, map the rows) and the
 * per-source bookkeeping both legs share: which importer a source gets, and what `lastSyncStatus`
 * / `lastSyncCounts` / `lastError` say afterwards. Everything from "here is a list of leads"
 * onwards lives in lead-pipeline.service.ts, and the Graph API leg lives in
 * meta-lead-import.service.ts — see the comment at the top of each.
 */
import { LEAD_SOURCE_SYNC_STATUSES } from '../../constants/lead-source-statuses.js';
import { env } from '../../config/env.js';
import { logger as defaultLogger } from '../../config/logger.js';
import { parseDelimitedText as defaultParseDelimitedText } from './csv.parser.js';
import { fetchSheetCsv as defaultFetchSheetCsv } from './google-sheet.client.js';
import {
  createLeadPipeline,
  describeError,
  type CreateLeadPipelineOptions,
  type LeadImportCounts,
  type LeadPipeline,
} from './lead-pipeline.service.js';
import { type LeadSourceDocument } from './lead-source.model.js';
import {
  findActiveLeadSources as defaultFindActiveLeadSources,
  recordLeadSourceSync as defaultRecordLeadSourceSync,
  recordMetaLeadWatermark as defaultRecordMetaLeadWatermark,
} from './lead-source.repository.js';
import {
  createMetaLeadImportService,
  isMetaLeadSource,
  syncStatusForMetaError,
} from './meta-lead-import.service.js';
import { mapMetaLeadRow as defaultMapMetaLeadRow } from './meta-lead.mapper.js';

export { LEAD_CONTACT_SOURCE, type LeadImportCounts } from './lead-pipeline.service.js';

export interface CreateLeadImportServiceOptions extends CreateLeadPipelineOptions {
  fetchSheetCsv?: typeof defaultFetchSheetCsv;
  parseDelimitedText?: typeof defaultParseDelimitedText;
  mapMetaLeadRow?: typeof defaultMapMetaLeadRow;
  leadSourceRepository?: {
    findActiveLeadSources: typeof defaultFindActiveLeadSources;
    recordLeadSourceSync: typeof defaultRecordLeadSourceSync;
    recordMetaLeadWatermark?: typeof defaultRecordMetaLeadWatermark;
  };
  /** Already-built pipeline, for a caller that wants to share one. Built from the options if not. */
  pipeline?: LeadPipeline;
  /** The Graph API leg. Built off the same pipeline when not supplied. */
  metaImportService?: { importFromSource: (leadSource: LeadSourceDocument) => Promise<{ counts: LeadImportCounts }> };
  now?: () => Date;
}

export const createLeadImportService = ({
  config = env,
  fetchSheetCsv = defaultFetchSheetCsv,
  parseDelimitedText = defaultParseDelimitedText,
  mapMetaLeadRow = defaultMapMetaLeadRow,
  leadSourceRepository = {
    findActiveLeadSources: defaultFindActiveLeadSources,
    recordLeadSourceSync: defaultRecordLeadSourceSync,
    recordMetaLeadWatermark: defaultRecordMetaLeadWatermark,
  },
  logger = defaultLogger,
  now = () => new Date(),
  pipeline,
  metaImportService,
  ...pipelineOptions
}: CreateLeadImportServiceOptions = {}) => {
  const leadPipeline =
    pipeline ?? createLeadPipeline({ ...pipelineOptions, config, logger });

  const metaImporter =
    metaImportService ??
    createMetaLeadImportService({
      config,
      pipeline: leadPipeline,
      logger,
      leadSourceRepository: {
        recordMetaLeadWatermark:
          leadSourceRepository.recordMetaLeadWatermark ?? defaultRecordMetaLeadWatermark,
      },
    });

  const importFromSheet = async (leadSource: LeadSourceDocument): Promise<LeadImportCounts> => {
    const csv = await fetchSheetCsv({
      sheetRef: {
        sheetId: leadSource.sheetId ?? '',
        gid: leadSource.gid ?? '0',
        published: (leadSource.sheetUrl ?? '').includes('/spreadsheets/d/e/'),
      },
    });

    const { rows } = parseDelimitedText(csv);

    const leads = rows.map((row) => mapMetaLeadRow({ row, columnMapping: leadSource.columnMapping }));

    const { counts } = await leadPipeline.importLeads({ leadSource, leads });

    return counts;
  };

  /** The dispatch. Which importer a source gets is decided here and nowhere else. */
  const importFromSource = async (leadSource: LeadSourceDocument): Promise<LeadImportCounts> => {
    if (isMetaLeadSource(leadSource)) {
      const { counts } = await metaImporter.importFromSource(leadSource);
      return counts;
    }

    return importFromSheet(leadSource);
  };

  const syncSource = async (leadSource: LeadSourceDocument): Promise<LeadImportCounts> => {
    try {
      const counts = await importFromSource(leadSource);

      await leadSourceRepository.recordLeadSourceSync({
        leadSourceId: leadSource._id,
        syncStatus:
          counts.failed > 0 ? LEAD_SOURCE_SYNC_STATUSES.FAILED : LEAD_SOURCE_SYNC_STATUSES.OK,
        lastError: counts.failed > 0 ? `${counts.failed} row(s) failed to import.` : null,
        counts,
        importedIncrement: counts.imported,
        syncedAt: now(),
      });

      return counts;
    } catch (error: unknown) {
      // A dead Meta token is not "the last sync failed", it is "this source has stopped working
      // and only a human can restart it". The distinction is the difference between a red badge
      // an admin learns to ignore and one that means something.
      await leadSourceRepository.recordLeadSourceSync({
        leadSourceId: leadSource._id,
        syncStatus: isMetaLeadSource(leadSource)
          ? syncStatusForMetaError(error)
          : LEAD_SOURCE_SYNC_STATUSES.FAILED,
        lastError: describeError(error),
        syncedAt: now(),
      });

      throw error;
    }
  };

  const drain = async (): Promise<LeadImportCounts> => {
    const totals: LeadImportCounts = { imported: 0, duplicates: 0, skipped: 0, failed: 0 };
    const leadSources = await leadSourceRepository.findActiveLeadSources();

    for (const leadSource of leadSources) {
      try {
        const counts = await syncSource(leadSource);

        totals.imported += counts.imported;
        totals.duplicates += counts.duplicates;
        totals.skipped += counts.skipped;
        totals.failed += counts.failed;
      } catch (error: unknown) {
        // Already recorded against the source; one broken source must not stop the others.
        logger.warn?.(
          { leadSourceId: leadSource._id.toString(), reason: describeError(error) },
          'Lead source sync failed safely.',
        );
      }
    }

    return totals;
  };

  return {
    drain,
    syncSource,
    importFromSource,
    importFromSheet,
    /** Kept on the service's surface: one lead, all the way through. */
    importLead: leadPipeline.importLead,
  };
};

export type LeadImportService = ReturnType<typeof createLeadImportService>;
