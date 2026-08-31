import { useCallback, useEffect, useState } from 'react';

import { getConversationSummary, regenerateConversationSummary } from '../api/endpoints';
import { useAuth } from '../auth/AuthContext';
import { hasPermission, PERMISSIONS } from '../lib/permissions';
import RelativeTime from './RelativeTime';
import { type AuthValue, type ConversationAiSummary, errorMessage } from './types';

type Props = {
  conversationId: string;
};

/**
 * The catch-up read, above the thread: who this is, what they asked for, where it stands, what
 * is still open, and what to do next - so the owner does not have to scroll twenty messages the
 * AI already handled.
 *
 * It never generates on open. Opening a conversation must not cost an ai-brain-service call, so
 * the panel loads whatever is stored and offers the button; "Summarise this thread" is the only
 * thing here that spends one. A summary read before the latest messages is still shown - out of
 * date is more useful than blank - but it is labelled, and the button changes to "Update".
 */
const ConversationSummaryPanel = ({ conversationId }: Props) => {
  const { authedRequest, permissions } = useAuth() as AuthValue;
  const canGenerate = hasPermission(permissions, PERMISSIONS.AI_GENERATE);

  const [summary, setSummary] = useState<ConversationAiSummary | null>(null);
  const [open, setOpen] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const payload = await authedRequest((token) =>
        getConversationSummary({ token, conversationId }),
      );
      setSummary(payload?.data ?? null);
    } catch {
      // Non-fatal by design: a summary that will not load must never take the thread with it.
    }
  }, [authedRequest, conversationId]);

  useEffect(() => {
    // Fetch-on-mount: state updates happen after the awaited request resolves. ConversationView
    // keys this panel by conversation id, so switching threads remounts it rather than leaving
    // the previous lead's summary on screen while the new one loads.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  const handleRegenerate = useCallback(async () => {
    setBusy(true);
    setError(null);

    try {
      const payload = await authedRequest((token) =>
        regenerateConversationSummary({ token, conversationId, force: true }),
      );
      const next = payload?.data ?? null;
      setSummary(next);

      if (payload?.meta?.unavailable) {
        setError('The summariser is unavailable right now — showing the last one.');
      } else if (!next) {
        setError('No summary could be written for this thread yet.');
      }
    } catch (regenerateError: unknown) {
      setError(errorMessage(regenerateError, 'Unable to summarise this thread right now.'));
    } finally {
      setBusy(false);
    }
  }, [authedRequest, conversationId]);

  const buttonLabel = busy ? 'Reading…' : summary ? 'Update summary' : 'Summarise this thread';

  return (
    <section
      aria-label="Conversation summary"
      className="border-b border-slate-200 bg-white px-4 py-3"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="text-xs font-semibold uppercase text-slate-500">Summary</span>
          {summary ? (
            summary.stale ? (
              <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-800">
                Out of date
              </span>
            ) : (
              <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-medium text-emerald-800">
                Up to date
              </span>
            )
          ) : null}
          {summary?.generatedAt ? (
            <RelativeTime value={summary.generatedAt} className="truncate text-xs text-slate-400" />
          ) : null}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {canGenerate ? (
            <button
              type="button"
              onClick={handleRegenerate}
              disabled={busy}
              className="rounded-md border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            >
              {buttonLabel}
            </button>
          ) : null}
          {summary ? (
            <button
              type="button"
              onClick={() => setOpen((current) => !current)}
              aria-expanded={open}
              className="rounded-md border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
            >
              {open ? 'Hide' : 'Show'}
            </button>
          ) : null}
        </div>
      </div>

      {!summary ? (
        <p className="mt-2 text-xs text-slate-500">
          {canGenerate
            ? 'No summary yet. Summarise the thread to see where it stands without reading it.'
            : 'No summary yet.'}
        </p>
      ) : null}

      {summary && open ? (
        <div className="mt-2 space-y-2 rounded-md bg-slate-50 p-3">
          {summary.headline ? (
            <p className="text-sm font-semibold text-slate-900">{summary.headline}</p>
          ) : null}

          {summary.whatTheyAskedFor ? (
            <div>
              <p className="text-[11px] font-semibold uppercase text-slate-500">What they asked for</p>
              <p className="text-sm text-slate-700">{summary.whatTheyAskedFor}</p>
            </div>
          ) : null}

          {summary.whereItStands ? (
            <div>
              <p className="text-[11px] font-semibold uppercase text-slate-500">Where it stands</p>
              <p className="text-sm text-slate-700">{summary.whereItStands}</p>
            </div>
          ) : null}

          {/* An empty list is a correct answer, not a gap - so nothing is rendered for it. */}
          {summary.openQuestions.length > 0 ? (
            <div>
              <p className="text-[11px] font-semibold uppercase text-slate-500">Still open</p>
              <ul className="list-disc space-y-0.5 pl-4 text-sm text-slate-700">
                {summary.openQuestions.map((question) => (
                  <li key={question}>{question}</li>
                ))}
              </ul>
            </div>
          ) : null}

          {summary.suggestedNextStep ? (
            <div>
              <p className="text-[11px] font-semibold uppercase text-slate-500">Next step</p>
              <p className="text-sm text-slate-700">{summary.suggestedNextStep}</p>
            </div>
          ) : null}

          {summary.stale ? (
            <p className="text-xs text-amber-700">
              {summary.currentMessageCount - (summary.messageCount ?? 0) > 0
                ? `${summary.currentMessageCount - (summary.messageCount ?? 0)} newer message(s) are not in this summary.`
                : 'Newer messages are not in this summary.'}
            </p>
          ) : null}
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="mt-2 text-xs text-red-600">
          {error}
        </p>
      ) : null}
    </section>
  );
};

export default ConversationSummaryPanel;
