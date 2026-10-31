import {
  PROCESSING_STATUSES,
  RECORDING_STATUSES,
  type ProcessingStatus,
} from '../../constants/call-statuses.js';
import { type ObjectIdLike, toObjectId } from '../../types/common.js';
import { CallRecord } from './call-record.model.js';
import {
  CallAnalysis,
  type CallSummaryDocument,
  type TranscriptSegmentDocument,
} from './call-analysis.model.js';

/**
 * The derived-artefact half of the calls repository: claiming work, and storing its results.
 *
 * THE CLAIM IS THE WHOLE CONCURRENCY STORY, and it is the same shape `claimDueReminder` already
 * uses for reminders: a conditional update, not a read followed by a write. Two workers that
 * both read "pending" would both transcribe, and the second one would overwrite the first's
 * result after paying for it twice. `findOneAndUpdate` lets exactly one of them match.
 */

export interface ClaimCallForTranscriptionParams {
  now?: Date;
  /** How long a claim is honoured before another worker may take it back. */
  leaseMs?: number;
}

/**
 * Takes ONE call that has audio and no transcript yet, atomically.
 *
 * `processing` doubles as a LEASE rather than a permanent flag. A worker that claims a call and
 * then dies - OOM, redeploy, an uncaught throw - would otherwise strand it as forever-
 * processing, which is the silent-stall failure this is meant not to have. So the filter also
 * reclaims anything whose claim is older than the lease.
 *
 * NOT ORGANISATION-SCOPED, deliberately: this is a background sweep across every tenant, the
 * same shape as the reminder sweep. The organisation travels with the row to whoever acts on it.
 */
export const claimCallForTranscription = ({
  now = new Date(),
  leaseMs = 600_000,
}: ClaimCallForTranscriptionParams = {}) => {
  const leaseExpiredBefore = new Date(now.getTime() - leaseMs);

  return CallRecord.findOneAndUpdate(
    {
      recordingStatus: RECORDING_STATUSES.UPLOADED,
      $or: [
        { transcriptionStatus: PROCESSING_STATUSES.PENDING },
        {
          transcriptionStatus: PROCESSING_STATUSES.PROCESSING,
          updatedAt: { $lte: leaseExpiredBefore },
        },
      ],
    },
    { $set: { transcriptionStatus: PROCESSING_STATUSES.PROCESSING, transcriptionError: null } },
    // Oldest first, so a backlog drains in the order the calls happened.
    { returnDocument: 'after', sort: { startedAt: 1 }, runValidators: true },
  ).exec();
};

export interface SetTranscriptionStatusParams {
  callId: ObjectIdLike;
  status: ProcessingStatus;
  error?: string | null;
}

export const setTranscriptionStatus = ({
  callId,
  status,
  error = null,
}: SetTranscriptionStatusParams) =>
  CallRecord.findOneAndUpdate(
    { _id: callId },
    { $set: { transcriptionStatus: status, transcriptionError: error } },
    { returnDocument: 'after', runValidators: true },
  ).exec();

export interface SetSummaryStatusParams {
  callId: ObjectIdLike;
  status: ProcessingStatus;
  error?: string | null;
}

export const setSummaryStatus = ({ callId, status, error = null }: SetSummaryStatusParams) =>
  CallRecord.findOneAndUpdate(
    { _id: callId },
    { $set: { summaryStatus: status, summaryError: error } },
    { returnDocument: 'after', runValidators: true },
  ).exec();

export interface SaveTranscriptParams {
  organizationId: ObjectIdLike;
  conversationId: ObjectIdLike;
  callId: ObjectIdLike;
  segments: TranscriptSegmentDocument[];
  text: string;
  detectedLanguage: string | null;
  diarized: boolean;
  provider: string;
}

/**
 * Writes a transcript, replacing any previous one for this call.
 *
 * UPSERT, AND IT CLEARS THE SUMMARY. Reprocessing a call produces new words, and a summary
 * written from the OLD words sitting beside them would be quietly wrong in the most convincing
 * possible way - it would look complete. So the derived-from-derived artefacts go with it, and
 * are rebuilt from what is actually there now.
 *
 * SUGGESTIONS ARE CLEARED TOO, but the tasks an agent already confirmed are NOT - those live in
 * the follow-up collection and are the agent's, not ours to revoke.
 */
export const saveTranscript = ({
  organizationId,
  conversationId,
  callId,
  segments,
  text,
  detectedLanguage,
  diarized,
  provider,
}: SaveTranscriptParams) =>
  CallAnalysis.findOneAndUpdate(
    { callId: toObjectId(callId) },
    {
      $set: {
        organizationId: toObjectId(organizationId),
        conversationId: toObjectId(conversationId),
        transcriptSegments: segments,
        transcriptText: text,
        detectedLanguage,
        diarized,
        transcriptionProvider: provider,
        summary: null,
        suggestions: [],
      },
    },
    { upsert: true, returnDocument: 'after', runValidators: true },
  ).exec();

export interface SaveSummaryParams {
  callId: ObjectIdLike;
  summary: CallSummaryDocument;
  suggestions: {
    commitmentId: string;
    title: string;
    evidence: string | null;
    dueAt: Date | null;
  }[];
}

/**
 * Writes a summary and its suggestions over whatever was there.
 *
 * REPLACES RATHER THAN APPENDS, which is what makes reprocessing idempotent: a call summarised
 * three times ends with one summary and one set of suggestions, not three. Suggestions arrive
 * as `suggested`; nothing here confirms anything.
 */
export const saveSummary = ({ callId, summary, suggestions }: SaveSummaryParams) =>
  CallAnalysis.findOneAndUpdate(
    { callId: toObjectId(callId) },
    {
      $set: {
        summary,
        suggestions: suggestions.map((suggestion) => ({
          ...suggestion,
          status: 'suggested' as const,
          taskId: null,
          decidedBy: null,
          decidedAt: null,
        })),
      },
    },
    { returnDocument: 'after', runValidators: true },
  ).exec();

export interface FindCallAnalysisParams {
  organizationId?: ObjectIdLike;
  callId?: ObjectIdLike;
}

export const findCallAnalysis = ({ organizationId, callId }: FindCallAnalysisParams = {}) =>
  CallAnalysis.findOne({ organizationId, callId }).exec();

export interface DeleteCallAnalysisParams {
  organizationId: ObjectIdLike;
  callId: ObjectIdLike;
}

/**
 * Destroys a call's transcript, summary and suggestions.
 *
 * THE WHOLE DOCUMENT GOES, because the three are one artefact: a transcript with its summary
 * stripped out would leave the words of a customer conversation sitting in the database with
 * nothing pointing at them, which is the opposite of what somebody pressing Delete means.
 *
 * WHAT IS NOT TOUCHED: the FollowUpTask rows an agent already confirmed. Those live in a
 * different collection, were created by a human decision, and are ordinary CRM work by the
 * time they exist. Deleting the AI's notes must not silently cancel the reminders somebody
 * scheduled off the back of them - if they want those gone they can cancel them in Tasks,
 * where the action says what it does.
 *
 * Returns the delete result so a caller can tell a real deletion from a no-op retry.
 */
export const deleteCallAnalysis = ({ organizationId, callId }: DeleteCallAnalysisParams) =>
  CallAnalysis.deleteOne({
    organizationId: toObjectId(organizationId),
    callId: toObjectId(callId),
  }).exec();

export interface ClearCallSummaryParams {
  organizationId: ObjectIdLike;
  callId: ObjectIdLike;
}

/**
 * Drops the summary and its suggestions, keeping the transcript.
 *
 * Exists because retention is configured SEPARATELY for the two: a studio may want to keep the
 * words for a year and the AI's reading of them for a month. Keeping a summary whose transcript
 * has been destroyed would be worse - an unverifiable claim about a conversation - so the
 * reverse case deletes the whole document instead.
 */
export const clearCallSummary = ({ organizationId, callId }: ClearCallSummaryParams) =>
  CallAnalysis.findOneAndUpdate(
    { organizationId: toObjectId(organizationId), callId: toObjectId(callId) },
    { $set: { summary: null, suggestions: [] } },
    { returnDocument: 'after' },
  ).exec();

export interface FindExpiredAnalysesParams {
  organizationId: ObjectIdLike;
  createdBefore: Date;
  /** Only rows that still hold a summary, so a cleared one is never reconsidered. */
  requireSummary?: boolean;
  limit?: number;
}

/** Analyses past this organisation's retention period. Always single-tenant - see the records. */
export const findExpiredAnalyses = ({
  organizationId,
  createdBefore,
  requireSummary = false,
  limit = 25,
}: FindExpiredAnalysesParams) =>
  CallAnalysis.find({
    organizationId: toObjectId(organizationId),
    createdAt: { $lt: createdBefore },
    ...(requireSummary ? { summary: { $ne: null } } : {}),
  })
    .sort({ createdAt: 1 })
    .limit(limit)
    .exec();

export interface CountExpiredAnalysesParams {
  organizationId: ObjectIdLike;
  createdBefore: Date;
  requireSummary?: boolean;
}

export const countExpiredAnalyses = ({
  organizationId,
  createdBefore,
  requireSummary = false,
}: CountExpiredAnalysesParams) =>
  CallAnalysis.countDocuments({
    organizationId: toObjectId(organizationId),
    createdAt: { $lt: createdBefore },
    ...(requireSummary ? { summary: { $ne: null } } : {}),
  }).exec();

export interface DecideSuggestionParams {
  organizationId: ObjectIdLike;
  callId: ObjectIdLike;
  commitmentId: string;
  status: 'confirmed' | 'dismissed';
  taskId?: ObjectIdLike | null;
  decidedBy: ObjectIdLike;
  now?: Date;
}

/**
 * Records an agent's decision on one suggestion.
 *
 * THE FILTER REQUIRES `suggested`, which is what stops a double-tap creating two tasks: the
 * second update matches nothing and returns null, and the caller treats that as "already
 * decided" rather than doing the work again. Org-scoped in the same filter so there is no
 * window between checking and writing.
 */
export const decideSuggestion = ({
  organizationId,
  callId,
  commitmentId,
  status,
  taskId = null,
  decidedBy,
  now = new Date(),
}: DecideSuggestionParams) =>
  CallAnalysis.findOneAndUpdate(
    {
      organizationId: toObjectId(organizationId),
      callId: toObjectId(callId),
      suggestions: { $elemMatch: { commitmentId, status: 'suggested' } },
    },
    {
      $set: {
        'suggestions.$.status': status,
        'suggestions.$.taskId': taskId ? toObjectId(taskId) : null,
        'suggestions.$.decidedBy': toObjectId(decidedBy),
        'suggestions.$.decidedAt': now,
      },
    },
    { returnDocument: 'after', runValidators: true },
  ).exec();
