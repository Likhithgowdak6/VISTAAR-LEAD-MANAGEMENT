import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

import { fetchCallRecording, getCall, getCallAnalysis } from '../../api/endpoints';
import { useAuth } from '../../auth/AuthContext';
import { useMobileBackLayer } from '../../hooks/useMobileBackLayer';
import RelativeTime from '../RelativeTime';
import Spinner from '../Spinner';
import {
  type AuthValue,
  type CallAnalysis,
  type CallRecord,
  type CallSummary,
  errorMessage,
  type ProcessingStatus,
} from '../types';
import CallSuggestions from './CallSuggestions';
import DeleteCallDataAction from './DeleteCallDataAction';
import RecordingUploader from './RecordingUploader';

/**
 * One call, in full: what happened, the audio, the words, the summary and what to do next.
 *
 * THE HARD RULE OF THIS SCREEN is unchanged from the first slice: it never shows a recording, a
 * transcript or a summary that does not exist, and never implies one is coming when nothing is
 * coming. The states are spelled out in words rather than left as empty panels, because an
 * empty panel reads as a bug and a wrong explanation is worse than a blunt one.
 *
 * THE FOUR PROCESSING STATES MEAN DIFFERENT THINGS and are worded differently:
 *   not_applicable - there is nothing to do, because there is no recording. A settled answer.
 *   pending        - there is something to do and it has not happened. With no transcription
 *                    provider configured this is where a call sits, and the screen says so.
 *   processing     - in progress.
 *   failed         - it ran and did not work, with the reason.
 * Collapsing any two of those turns a settled state into a permanent spinner.
 *
 * AUDIO IS FETCHED, NOT LINKED. The session lives in a header, so an `<audio src>` pointed at
 * the API would be an unauthenticated request. The bytes are fetched with the token and handed
 * to the player as an object URL, which is revoked on unmount - there is no public, signed or
 * guessable recording URL anywhere in this app.
 */

type Props = {
  callId: string;
  onClose: () => void;
};

const STATUS_LABELS: Record<string, string> = {
  initiated: 'Dialler opened',
  completed: 'Spoke to the lead',
  failed: 'No answer',
  cancelled: 'Not called',
  unknown: 'Outcome not recorded',
};

const PROCESSING_LABELS: Record<ProcessingStatus, string> = {
  not_applicable: 'Not applicable — there is no recording',
  pending: 'Queued',
  processing: 'In progress',
  completed: 'Ready',
  failed: 'Failed',
};

const formatDuration = (seconds: number | null): string => {
  if (!seconds || seconds <= 0) {
    return '—';
  }

  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;

  return minutes > 0 ? `${minutes} min ${rest}s` : `${rest}s`;
};

const clock = (seconds: number | null): string => {
  if (seconds === null) {
    return '';
  }

  const minutes = Math.floor(seconds / 60);

  return `${minutes}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
};

const Row = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div>
    <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{label}</p>
    <p className="text-sm text-slate-700">{children}</p>
  </div>
);

/** A summary section. Renders NOTHING when empty rather than an encouraging blank heading. */
const Section = ({ label, items }: { label: string; items: string[] }) =>
  items.length === 0 ? null : (
    <div>
      <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{label}</p>
      <ul className="list-disc pl-4 text-sm text-slate-700">
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </div>
  );

const SummaryPanel = ({ summary }: { summary: CallSummary }) => (
  <div className="space-y-3">
    {/* Said first and plainly. A summary the model itself doubts must not be read as fact. */}
    {summary.lowConfidence ? (
      <p className="rounded-lg bg-amber-50 p-2 text-[11px] text-amber-800">
        The recording was short or unclear, so this summary may be incomplete.
      </p>
    ) : null}

    {summary.overview ? <p className="text-sm text-slate-800">{summary.overview}</p> : null}

    <Section label="Requirements" items={summary.customerRequirements} />

    {/* Budget and timeline are the two fields a model is most tempted to invent, so they say
        "not discussed" explicitly rather than disappearing - the absence is information. */}
    <Row label="Budget">{summary.budget ?? 'Not discussed'}</Row>
    <Row label="Timeline">{summary.expectedTimeline ?? 'Not discussed'}</Row>

    <Section label="Preferences" items={summary.preferences} />
    <Section label="Asked" items={summary.questionsAsked} />
    <Section label="Concerns" items={summary.concerns} />
    <Section label="Decisions" items={summary.decisions} />
    <Section label="Next steps" items={summary.nextSteps} />

    {/* Separated by design and labelled as such: a reader must always be able to tell what the
        customer said from what a model concluded. */}
    {summary.inferences.length > 0 ? (
      <div className="rounded-lg border border-dashed border-slate-300 p-2">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
          AI reading — not stated on the call
        </p>
        <ul className="list-disc pl-4 text-sm text-slate-600">
          {summary.inferences.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </div>
    ) : null}
  </div>
);

const CallDetailDialog = ({ callId, onClose }: Props) => {
  const { authedRequest } = useAuth() as AuthValue;
  useMobileBackLayer({ active: true, onBack: onClose });

  const [call, setCall] = useState<CallRecord | null>(null);
  const [analysis, setAnalysis] = useState<CallAnalysis | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [audioError, setAudioError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const load = useCallback(async () => {
    try {
      const [callPayload, analysisPayload] = await Promise.all([
        authedRequest((token) => getCall({ token, callId })),
        // Allowed to fail quietly: a missing analysis is the normal case, and an error here
        // must not hide the call's own metadata.
        authedRequest((token) => getCallAnalysis({ token, callId })).catch(() => null),
      ]);

      setCall(callPayload?.data ?? null);
      setAnalysis(analysisPayload?.data ?? null);
      setError(null);
    } catch (loadError: unknown) {
      setError(errorMessage(loadError, 'Unable to load this call.'));
    } finally {
      setLoading(false);
    }
  }, [authedRequest, callId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load, refreshKey]);

  /** Fetches the audio with the session token and hands the player an object URL. */
  useEffect(() => {
    if (!call?.hasRecording) {
      return;
    }

    let revoked = false;
    let url: string | null = null;

    authedRequest((token) => fetchCallRecording({ token, callId }))
      .then((blob) => {
        if (revoked) {
          return;
        }

        url = URL.createObjectURL(blob);
        setAudioUrl(url);
      })
      .catch((fetchError: unknown) => {
        if (!revoked) {
          setAudioError(errorMessage(fetchError, 'The recording could not be loaded.'));
        }
      });

    return () => {
      revoked = true;
      // Revoked on unmount, so the bytes do not linger in the page after the dialog closes.
      if (url) {
        URL.revokeObjectURL(url);
      }
    };
  }, [authedRequest, callId, call?.hasRecording]);

  const transcript = analysis?.transcript ?? null;

  return createPortal(
    <div
      data-mobile-sheet-backdrop
      className="fixed inset-0 z-20 flex items-center justify-center bg-slate-900/40 p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Call details"
        data-mobile-sheet
        onClick={(event) => event.stopPropagation()}
        className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-2xl bg-white p-4 shadow-xl"
      >
        <div className="mb-3 flex items-start justify-between gap-3">
          <h3 className="text-base font-semibold text-slate-900">Call</h3>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 rounded-lg border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
          >
            Close
          </button>
        </div>

        {loading ? <Spinner label="Loading call…" /> : null}

        {error ? (
          <p role="alert" className="text-sm text-red-600">
            {error}
          </p>
        ) : null}

        {!loading && !call && !error ? (
          <p className="text-sm text-slate-600">
            This call is no longer here. It may have been deleted, or it belongs to a different
            lead.
          </p>
        ) : null}

        {call ? (
          <div className="space-y-3">
            <Row label="Outcome">{STATUS_LABELS[call.status] ?? call.status}</Row>

            <Row label="When">
              {call.startedAt ? (
                <>
                  {new Date(call.startedAt).toLocaleString()} (
                  <RelativeTime value={call.startedAt} />)
                </>
              ) : (
                '—'
              )}
            </Row>

            <Row label="Direction">{call.direction === 'inbound' ? 'Incoming' : 'Outgoing'}</Row>

            <Row label="Length">
              {call.status === 'completed' ? (
                <>
                  {formatDuration(call.durationSeconds)}
                  <span className="text-slate-400"> · as reported by the agent</span>
                </>
              ) : (
                '—'
              )}
            </Row>

            <div className="rounded-lg bg-slate-50 p-3">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                Recording
              </p>

              {call.hasRecording ? (
                <>
                  {audioUrl ? (
                    <audio
                      controls
                      src={audioUrl}
                      aria-label="Call recording"
                      className="mt-1 w-full"
                    />
                  ) : audioError ? (
                    <p role="alert" className="text-sm text-red-600">
                      {audioError}
                    </p>
                  ) : (
                    <p className="text-sm text-slate-600">Loading audio…</p>
                  )}
                  <div className="mt-2">
                    <DeleteCallDataAction
                      callId={callId}
                      kind="recording"
                      onDeleted={() => setRefreshKey((v) => v + 1)}
                    />
                  </div>
                </>
              ) : (
                <>
                  {/* Two different facts. "Deleted" has to survive as its own answer - a
                      customer asking what happened to their recording deserves it. */}
                  <p className="text-sm text-slate-700">
                    {call.recordingStatus === 'deleted' ? 'Recording deleted' : 'No recording'}
                  </p>
                  <p className="mt-1 text-[11px] text-slate-500">
                    Vistaar can’t record calls. Android doesn’t let any ordinary app capture both
                    sides of a cellular call, so a recording only exists here if someone attaches
                    one their phone made.
                  </p>
                </>
              )}
            </div>

            {!call.hasRecording ? (
              <RecordingUploader callId={callId} onUploaded={() => setRefreshKey((v) => v + 1)} />
            ) : null}

            <Row label="Transcript">{PROCESSING_LABELS[call.transcriptionStatus]}</Row>

            {call.transcriptionStatus === 'pending' ? (
              <p className="text-[11px] text-slate-500">
                Queued, but no transcription service is configured yet — nothing will be
                processed until one is.
              </p>
            ) : null}

            {transcript && transcript.segments.length > 0 ? (
              <div>
                <p className="text-[11px] text-slate-400">
                  {transcript.detectedLanguage ? `${transcript.detectedLanguage} · ` : ''}
                  {/* Said out loud when absent: for Kannada the services that support the
                      language do not offer speaker separation, so an unlabelled transcript is
                      the expected result rather than a fault. */}
                  {transcript.diarized ? 'speakers identified' : 'speakers not identified'}
                </p>
                <div className="mt-1 max-h-48 space-y-1 overflow-y-auto rounded-lg bg-slate-50 p-2">
                  {transcript.segments.map((segment, index) => (
                    <p key={`${index}-${segment.text.slice(0, 12)}`} className="text-xs text-slate-700">
                      {segment.startSeconds !== null ? (
                        <span className="text-slate-400">{clock(segment.startSeconds)} </span>
                      ) : null}
                      {segment.speaker ? (
                        <span className="font-semibold capitalize">{segment.speaker}: </span>
                      ) : null}
                      {segment.text}
                    </p>
                  ))}
                </div>
              </div>
            ) : null}

            <Row label="Summary">{PROCESSING_LABELS[call.summaryStatus]}</Row>

            {analysis?.summary ? <SummaryPanel summary={analysis.summary} /> : null}

            {analysis ? (
              <CallSuggestions
                callId={callId}
                suggestions={analysis.suggestions}
                onChanged={() => setRefreshKey((v) => v + 1)}
              />
            ) : null}

            {analysis ? (
              <div className="border-t border-slate-200 pt-2">
                <DeleteCallDataAction
                  callId={callId}
                  kind="analysis"
                  onDeleted={() => setRefreshKey((v) => v + 1)}
                />
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>,
    document.body,
  );
};

export default CallDetailDialog;
