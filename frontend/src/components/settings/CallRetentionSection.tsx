import { useCallback, useEffect, useState } from 'react';

import {
  getRetentionPreview,
  getSettings,
  updateCallRetention,
  type RetentionPreview,
} from '../../api/endpoints';
import { useAuth } from '../../auth/AuthContext';
import Spinner from '../Spinner';
import { type AuthValue, type CallRetentionPolicy, errorMessage } from '../types';

/**
 * How long this studio keeps call recordings, transcripts and AI summaries.
 *
 * KEEP FOREVER IS THE DEFAULT AND IT IS NOT A PLACEHOLDER. Every field starts null, the sweep
 * finds nothing while they are null, and this screen never pre-fills a number. The reason is
 * that this is being added to a database already holding real recorded conversations: a
 * suggested "90" sitting in the box is one careless Save away from destroying years of them,
 * irreversibly, on a schedule nobody actually chose.
 *
 * PREVIEW BEFORE SAVE IS MANDATORY, not a convenience. The flow is: change the numbers, press
 * Preview, read how many recordings and transcripts WOULD be destroyed and from what date, and
 * only then confirm. Saving is not reachable without that step - a destructive scheduled job
 * is exactly the kind of thing that should be hard to turn on by accident.
 *
 * THE PREVIEW REFLECTS THE SAVED POLICY, NOT THE DRAFT, and the UI says so. The endpoint
 * computes from what is stored, so for a brand-new policy it honestly reports zero. That is a
 * real limitation rather than a bug, and overstating it would be worse than admitting it.
 */

/** Narrowed to the three string keys, so it can be used as a React key and input name. */
type Field = 'recordingDays' | 'transcriptDays' | 'summaryDays';

const FIELDS: readonly { key: Field; label: string; hint: string }[] = [
  {
    key: 'recordingDays',
    label: 'Audio recordings',
    hint: 'The uploaded call audio itself.',
  },
  {
    key: 'transcriptDays',
    label: 'Transcripts',
    hint: 'The words. Deleting these also deletes the summary built from them.',
  },
  {
    key: 'summaryDays',
    label: 'AI summaries',
    hint: 'The structured summary and any suggestions not yet actioned.',
  },
];

const EMPTY: CallRetentionPolicy = {
  recordingDays: null,
  transcriptDays: null,
  summaryDays: null,
};

const describe = (days: number | null): string =>
  days === null ? 'Keep forever' : `Delete after ${days} ${days === 1 ? 'day' : 'days'}`;

const CallRetentionSection = () => {
  const { authedRequest } = useAuth() as AuthValue;

  const [saved, setSaved] = useState<CallRetentionPolicy>(EMPTY);
  const [draft, setDraft] = useState<CallRetentionPolicy>(EMPTY);
  const [preview, setPreview] = useState<RetentionPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const payload = await authedRequest((token) => getSettings({ token }));
      const policy = payload?.data?.callRetention ?? EMPTY;

      setSaved(policy);
      setDraft(policy);
      setError(null);
    } catch (loadError: unknown) {
      setError(errorMessage(loadError, 'Unable to load the retention policy.'));
    } finally {
      setLoading(false);
    }
  }, [authedRequest]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  const setField = (key: Field, value: number | null) => {
    setDraft((current) => ({ ...current, [key]: value }));
    // Any edit invalidates the preview. Confirming against a stale one would mean approving a
    // deletion count that does not describe what is about to be saved.
    setPreview(null);
    setNotice(null);
  };

  const runPreview = async () => {
    setBusy(true);
    setError(null);

    try {
      const payload = await authedRequest((token) => getRetentionPreview({ token }));
      setPreview(payload?.data ?? null);
    } catch (previewError: unknown) {
      setError(errorMessage(previewError, 'Unable to work out what would be deleted.'));
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    setBusy(true);
    setError(null);

    try {
      const payload = await authedRequest((token) => updateCallRetention({ token, ...draft }));
      const policy = payload?.data?.callRetention ?? draft;

      setSaved(policy);
      setDraft(policy);
      setPreview(null);
      setNotice('Retention policy saved.');
    } catch (saveError: unknown) {
      setError(errorMessage(saveError, 'The retention policy could not be saved.'));
    } finally {
      setBusy(false);
    }
  };

  const changed = FIELDS.some(({ key }) => draft[key] !== saved[key]);
  /*
   * A field switched to "Delete after" with nothing typed holds NaN.
   *
   * THIS MUST BLOCK BOTH BUTTONS. `JSON.stringify(NaN)` is `null`, so an incomplete field sent
   * to the server would arrive as "keep forever" - the opposite of what the admin was in the
   * middle of configuring, saved silently and looking successful.
   */
  const incomplete = FIELDS.some(({ key }) => {
    const value = draft[key];

    return typeof value === 'number' && !Number.isFinite(value);
  });

  return (
    <section
      aria-label="Call data retention"
      className="overflow-hidden rounded-xl border border-slate-200 bg-white"
    >
      <div className="border-b border-slate-100 p-4">
        <h2 className="text-sm font-bold text-slate-900">Call data retention</h2>
        <p className="mt-1 text-xs text-slate-500">
          How long call recordings, transcripts and AI summaries are kept.{' '}
          {/* Said plainly and up front. There is no undo and no backup of the audio. */}
          <strong className="text-slate-700">Deletion is permanent and cannot be undone.</strong>
        </p>
      </div>

      {loading ? (
        <div className="p-4">
          <Spinner label="Loading retention policy…" />
        </div>
      ) : (
        <div className="space-y-4 p-4">
          {FIELDS.map(({ key, label, hint }) => {
            const value = draft[key];

            return (
              <div key={key}>
                <p className="text-xs font-medium text-slate-700">{label}</p>
                <p className="text-[11px] text-slate-500">{hint}</p>
                <p className="mt-0.5 text-[11px] text-slate-400">
                  Currently: {describe(saved[key])}
                </p>

                <div className="mt-1 flex items-center gap-3">
                  <label className="flex items-center gap-1.5 text-xs text-slate-700">
                    <input
                      type="radio"
                      name={key}
                      aria-label={`${label}: keep forever`}
                      checked={value === null}
                      onChange={() => setField(key, null)}
                    />
                    Keep forever
                  </label>
                  <label className="flex items-center gap-1.5 text-xs text-slate-700">
                    <input
                      type="radio"
                      name={key}
                      aria-label={`${label}: delete after a number of days`}
                      checked={value !== null}
                      // Switching ON does NOT pre-fill a number. An empty box that must be
                      // typed into is the point: the period has to be a decision.
                      onChange={() => setField(key, Number.NaN)}
                    />
                    Delete after
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={3650}
                    aria-label={`${label}: days to keep`}
                    disabled={value === null}
                    value={value === null || Number.isNaN(value) ? '' : value}
                    onChange={(event) => {
                      const next = Number.parseInt(event.target.value, 10);
                      setField(key, Number.isFinite(next) ? next : Number.NaN);
                    }}
                    className="min-h-9 w-20 rounded-lg border border-slate-300 px-2 text-xs text-slate-700 disabled:bg-slate-50"
                  />
                  <span className="text-xs text-slate-500">days</span>
                </div>
              </div>
            );
          })}

          {error ? (
            <p role="alert" className="text-xs text-red-600">
              {error}
            </p>
          ) : null}

          {notice ? <p className="text-xs text-green-700">{notice}</p> : null}

          {preview ? (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
              <p className="text-xs font-semibold text-amber-900">
                What the next cleanup would delete
              </p>
              {preview.unconfigured ? (
                <p className="mt-1 text-[11px] text-amber-800">
                  Nothing — no retention period is currently saved, so nothing is ever deleted.
                </p>
              ) : (
                <ul className="mt-1 space-y-0.5 text-[11px] text-amber-800">
                  <li>
                    {preview.recordings.count} recordings
                    {preview.recordings.cutoff
                      ? ` older than ${new Date(preview.recordings.cutoff).toLocaleDateString()}`
                      : ''}
                  </li>
                  <li>
                    {preview.transcripts.count} transcripts
                    {preview.transcripts.cutoff
                      ? ` older than ${new Date(preview.transcripts.cutoff).toLocaleDateString()}`
                      : ''}
                  </li>
                  <li>
                    {preview.summaries.count} summaries
                    {preview.summaries.cutoff
                      ? ` older than ${new Date(preview.summaries.cutoff).toLocaleDateString()}`
                      : ''}
                  </li>
                </ul>
              )}
              {/* The honest caveat. The endpoint computes from the SAVED policy, so a brand-new
                  one previews as zero - which is true, and better said than glossed over. */}
              <p className="mt-2 text-[11px] text-amber-700">
                Counted against the policy currently saved. After you save a new one, preview
                again to see its real effect.
              </p>
            </div>
          ) : null}

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              disabled={busy || !changed || incomplete}
              onClick={() => void runPreview()}
              className="min-h-9 rounded-lg border border-slate-300 px-3 text-xs font-medium text-slate-700 disabled:opacity-50"
            >
              {busy && !preview ? 'Checking…' : 'Preview what would be deleted'}
            </button>

            {/* UNREACHABLE WITHOUT A PREVIEW. Turning on an irreversible scheduled deletion
                should take two deliberate actions, not one. */}
            <button
              type="button"
              disabled={busy || !changed || !preview || incomplete}
              onClick={() => void save()}
              className="min-h-9 rounded-lg bg-slate-900 px-3 text-xs font-semibold text-white disabled:opacity-50"
            >
              {busy && preview ? 'Saving…' : 'Confirm and save'}
            </button>

            {incomplete ? (
              <span className="text-[11px] text-red-600">
                Enter a number of days, or choose Keep forever.
              </span>
            ) : changed && !preview ? (
              <span className="text-[11px] text-slate-500">Preview before saving.</span>
            ) : null}
          </div>
        </div>
      )}
    </section>
  );
};

export default CallRetentionSection;
