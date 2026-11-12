/**
 * The CRM assistant.
 *
 * ----------------------------------------------------------------------------------------------
 * WHAT THIS SCREEN IS CAREFUL ABOUT
 * ----------------------------------------------------------------------------------------------
 * **It never claims more than it can see.** Answers are computed under the asker's own
 * permissions, so a staff member's "how many hot leads" counts only their assigned ones. The
 * banner says so rather than leaving the number to be read as organisation-wide.
 *
 * **It never looks like it can act.** The assistant is strictly read-only, and a premium
 * assistant UI is exactly the kind of thing an owner would expect to be able to say "message
 * her" to. The read-only state is stated in the header, repeated under the composer, and comes
 * from the API rather than being hardcoded here — a frontend constant would keep claiming
 * read-only after that stopped being true.
 *
 * **The optimistic question stays on screen if the request fails.** Clearing the composer and
 * then losing the question to a network error is the one thing guaranteed to make someone
 * distrust the feature.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  askAssistant,
  deleteAssistantThread,
  getAssistantCapabilities,
  getAssistantThread,
  listAssistantThreads,
  type AssistantCapabilities,
  type AssistantStep,
  type AssistantThreadSummary,
} from '../api/endpoints';
import { useAuth } from '../auth/AuthContext';
import AssistantComposer from '../components/assistant/AssistantComposer';
import AssistantMessage from '../components/assistant/AssistantMessage';
import { hasPermission, PERMISSIONS } from '../lib/permissions';

interface Turn {
  role: 'user' | 'assistant';
  content: string;
  steps?: AssistantStep[];
  stoppedEarly?: boolean;
  usedHistory?: boolean;
}

const SUGGESTIONS = [
  'Which leads need attention today?',
  'Who has gone quiet this week?',
  'Why is my hottest lead hot?',
  'What objections am I hearing most?',
];

const AssistantPage = () => {
  const { authedRequest, permissions } = useAuth();

  const [turns, setTurns] = useState<Turn[]>([]);
  const [threads, setThreads] = useState<AssistantThreadSummary[]>([]);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [capabilities, setCapabilities] = useState<AssistantCapabilities | null>(null);
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const bottomRef = useRef<HTMLDivElement | null>(null);

  // Staff see only their own assigned leads. Saying so up front is the difference between a
  // correct partial answer and a number the person reads as the whole pipeline.
  const seesEverything = hasPermission(permissions, PERMISSIONS.CONVERSATIONS_READ_ALL);

  const loadThreads = useCallback(async () => {
    try {
      const payload = await authedRequest((token) => listAssistantThreads({ token }));
      setThreads(payload.data ?? []);
    } catch {
      // The sidebar is a convenience. Failing to load it must not block asking a question.
    }
  }, [authedRequest]);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const payload = await authedRequest((token) => getAssistantCapabilities({ token }));

        if (!cancelled) {
          setCapabilities(payload.data ?? null);
        }
      } catch {
        // Falls back to showing no capability chips rather than blocking the screen.
      }
    };

    load();
    loadThreads();

    return () => {
      cancelled = true;
    };
  }, [authedRequest, loadThreads]);

  useEffect(() => {
    // Guarded, not assumed. `scrollIntoView` is absent in jsdom and in some embedded webviews,
    // and an unguarded call throws from inside an effect — which unmounts the whole screen
    // over a scroll nicety. Staying put is an acceptable outcome; a blank page is not.
    const bottom = bottomRef.current;

    if (typeof bottom?.scrollIntoView === 'function') {
      bottom.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
  }, [turns, busy]);

  const ask = useCallback(
    async (raw: string) => {
      const text = raw.trim();

      if (!text || busy) {
        return;
      }

      setBusy(true);
      setError(null);
      setQuestion('');
      setTurns((current) => [...current, { role: 'user', content: text }]);

      try {
        const payload = await authedRequest((token) =>
          askAssistant({ token, question: text, threadId }),
        );
        const answer = payload.data;

        setThreadId(answer.threadId);
        setTurns((current) => [
          ...current,
          {
            role: 'assistant',
            content: answer.answer,
            steps: answer.steps,
            stoppedEarly: answer.stoppedEarly,
            usedHistory: answer.usedHistory,
          },
        ]);

        loadThreads();
      } catch (askError: unknown) {
        setError(
          askError instanceof Error ? askError.message : 'The assistant could not answer that.',
        );
        // The question goes back in the box. Losing what somebody typed to a network blip is
        // how a feature stops being trusted.
        setQuestion(text);
        setTurns((current) => current.slice(0, -1));
      } finally {
        setBusy(false);
      }
    },
    [authedRequest, busy, loadThreads, threadId],
  );

  const openThread = useCallback(
    async (id: string) => {
      setError(null);

      try {
        const payload = await authedRequest((token) =>
          getAssistantThread({ token, threadId: id }),
        );

        setThreadId(id);
        setTurns(
          (payload.data.turns ?? []).map((turn) => ({
            role: turn.role,
            content: turn.content,
          })),
        );
      } catch (openError: unknown) {
        setError(
          openError instanceof Error ? openError.message : 'Unable to open that conversation.',
        );
      }
    },
    [authedRequest],
  );

  const removeThread = useCallback(
    async (id: string) => {
      try {
        await authedRequest((token) => deleteAssistantThread({ token, threadId: id }));

        if (id === threadId) {
          setThreadId(null);
          setTurns([]);
        }

        loadThreads();
      } catch {
        setError('Unable to delete that conversation.');
      }
    },
    [authedRequest, loadThreads, threadId],
  );

  const startNew = () => {
    setThreadId(null);
    setTurns([]);
    setError(null);
  };

  return (
    <div className="mx-auto flex h-full max-w-6xl gap-4 p-4 sm:p-6">
      <aside className="hidden w-60 shrink-0 flex-col gap-2 lg:flex">
        <button
          type="button"
          onClick={startNew}
          className="btn-key w-full rounded-xl px-3 py-2 text-sm"
        >
          New conversation
        </button>

        <nav aria-label="Past conversations" className="min-h-0 flex-1 space-y-1 overflow-y-auto">
          {threads.map((thread) => (
            <div
              key={thread.id}
              className={`group flex items-center gap-1 rounded-lg px-2 py-1.5 text-sm transition ${
                thread.id === threadId
                  ? 'bg-blue-50 text-blue-800 dark:bg-blue-500/15 dark:text-blue-200'
                  : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800'
              }`}
            >
              <button
                type="button"
                onClick={() => openThread(thread.id)}
                className="min-w-0 flex-1 truncate text-left"
                title={thread.title}
              >
                {thread.title}
              </button>

              <button
                type="button"
                onClick={() => removeThread(thread.id)}
                aria-label={`Delete conversation: ${thread.title}`}
                className="shrink-0 rounded p-1 text-slate-400 opacity-0 transition group-hover:opacity-100 hover:text-rose-600 focus:opacity-100 dark:hover:text-rose-400"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 7h12M10 11v6m4-6v6M7 7l1 12h8l1-12M9 7V5h6v2" />
                </svg>
              </button>
            </div>
          ))}
        </nav>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col">
        <header className="mb-4 flex flex-wrap items-center gap-3">
          <div
            aria-hidden="true"
            className="flex h-11 w-11 items-center justify-center rounded-2xl bg-gradient-to-br from-blue-600 via-blue-500 to-sky-400 text-white glow-key"
          >
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v2m0 14v2m9-9h-2M5 12H3m14.7-6.7-1.4 1.4M7.7 16.3l-1.4 1.4m0-11.4 1.4 1.4m8.6 8.6 1.4 1.4" />
              <circle cx="12" cy="12" r="3.5" />
            </svg>
          </div>

          <div className="min-w-0 flex-1">
            <h1 className="text-xl font-bold text-slate-900 dark:text-slate-50">Assistant</h1>
            <p className="text-sm text-slate-500 dark:text-slate-400">
              Ask about your pipeline. It reads your CRM to answer —{' '}
              {seesEverything
                ? 'across the whole organisation.'
                : 'limited to the leads assigned to you.'}
            </p>
          </div>

          {capabilities?.readOnly ? (
            <span className="chip" title="The assistant can read your CRM. It cannot send messages or change anything.">
              <svg viewBox="0 0 24 24" aria-hidden="true" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 15v2m-6 4h12a2 2 0 0 0 2-2v-6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2Zm10-10V7a4 4 0 0 0-8 0v4" />
              </svg>
              Read-only
            </span>
          ) : null}
        </header>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto pb-4">
          {turns.length === 0 && !busy ? (
            <div className="surface-card p-5">
              <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">
                What would you like to know?
              </p>
              <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                It can search leads, read conversations, explain a lead score and find who has
                gone quiet.
              </p>

              <div className="mt-4 flex flex-wrap gap-2">
                {SUGGESTIONS.map((suggestion) => (
                  <button
                    key={suggestion}
                    type="button"
                    onClick={() => ask(suggestion)}
                    className="chip chip-key transition hover:brightness-95"
                  >
                    {suggestion}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {turns.map((turn, index) => (
            <AssistantMessage
              key={index}
              role={turn.role}
              content={turn.content}
              steps={turn.steps}
              stoppedEarly={turn.stoppedEarly}
              usedHistory={turn.usedHistory}
            />
          ))}

          {busy ? (
            <div className="flex items-center gap-3 text-sm text-slate-500 dark:text-slate-400">
              <span className="flex gap-1" aria-hidden="true">
                <span className="h-2 w-2 animate-bounce rounded-full bg-blue-500 [animation-delay:-0.3s]" />
                <span className="h-2 w-2 animate-bounce rounded-full bg-blue-500 [animation-delay:-0.15s]" />
                <span className="h-2 w-2 animate-bounce rounded-full bg-blue-500" />
              </span>
              <span role="status">Looking through your CRM…</span>
            </div>
          ) : null}

          {error ? (
            <p
              role="alert"
              className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-300"
            >
              {error}
            </p>
          ) : null}

          <div ref={bottomRef} />
        </div>

        <AssistantComposer
          value={question}
          onChange={setQuestion}
          onSubmit={() => ask(question)}
          busy={busy}
        />
      </section>
    </div>
  );
};

export default AssistantPage;
