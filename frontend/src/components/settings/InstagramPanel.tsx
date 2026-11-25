import { useCallback, useEffect, useState } from 'react';

import {
  connectInstagramAccount,
  disconnectInstagramAccount,
  listInstagramAccounts,
  listInstagramCandidates,
  updateInstagramAutomation,
  type InstagramAccount,
  type InstagramCandidate,
  type InstagramKeywordReply,
} from '../../api/instagram';
import { ApiError } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import ConfirmDialog from '../ConfirmDialog';
import Spinner from '../Spinner';
import { errorMessage } from '../types';

/**
 * Connecting Instagram and configuring its automatic replies.
 *
 * NO SECOND LOGIN. Instagram reuses the Facebook authorisation already stored for Lead Ads, so
 * this panel lists the Pages that authorisation can reach rather than opening another OAuth
 * window. When that authorisation is missing or lacks the Instagram permissions, the panel says
 * so and sends the admin to the one place that can fix it — rather than showing an empty list,
 * which reads as "we have no Pages" when it means "we were not allowed to ask".
 *
 * AUTOMATION IS OFF UNTIL SOMEBODY TURNS IT ON, and the copy is explicit that the switch is what
 * starts messaging customers — not connecting, and not writing a reply.
 */
const InstagramPanel = ({
  onNavigate,
}: {
  onNavigate?: (view: 'team-and-accounts' | 'ai-knowledge' | 'lead-sources') => void;
}) => {
  const { authedRequest } = useAuth();

  const [accounts, setAccounts] = useState<InstagramAccount[]>([]);
  const [candidates, setCandidates] = useState<InstagramCandidate[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  /**
   * Set when the stored Facebook authorisation cannot list Pages — missing, expired, or granted
   * without the Instagram permissions. All three need the same action and the same button.
   */
  const [reauthorizeReason, setReauthorizeReason] = useState<string | null>(null);

  const [welcome, setWelcome] = useState('');
  const [keywords, setKeywords] = useState<InstagramKeywordReply[]>([]);
  const [disconnectTarget, setDisconnectTarget] = useState<InstagramAccount | null>(null);

  const account = accounts[0] ?? null;

  const load = useCallback(async () => {
    try {
      const connected = await authedRequest((token) => listInstagramAccounts({ token }));

      setAccounts(connected.data ?? []);
      setWelcome(connected.data?.[0]?.welcomeReply ?? '');
      setKeywords(connected.data?.[0]?.keywordReplies ?? []);
      setError(null);

      try {
        const available = await authedRequest((token) => listInstagramCandidates({ token }));

        setCandidates(available.data ?? []);
        setReauthorizeReason(null);
      } catch (candidateError: unknown) {
        // A 409 or 502 here is the reauthorization case, not a broken panel — the connected
        // account above is still shown and still working.
        setCandidates([]);
        setReauthorizeReason(
          errorMessage(
            candidateError,
            'Your Facebook authorisation could not list Pages. Reconnect it to continue.',
          ),
        );
      }
    } catch (loadError: unknown) {
      setError(errorMessage(loadError, 'Unable to load Instagram settings.'));
    } finally {
      setLoading(false);
    }
  }, [authedRequest]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  const run = async (action: () => Promise<unknown>, success: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);

    try {
      await action();
      setNotice(success);
      await load();
    } catch (actionError: unknown) {
      // Meta's own refusals are written for whoever is reading the screen — "You need the
      // Messages task on that Page" — so they are shown as written.
      setError(errorMessage(actionError, 'That did not work.'));

      if (actionError instanceof ApiError && actionError.code === 'META_NOT_CONNECTED') {
        setReauthorizeReason(actionError.message);
      }
    } finally {
      setBusy(false);
    }
  };

  const field =
    'w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-blue-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100';
  const label = 'mb-1 block text-xs font-medium text-slate-600 dark:text-slate-400';

  if (loading) {
    return (
      <section className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
        <Spinner label="Loading Instagram settings…" />
      </section>
    );
  }

  const connectable = candidates.filter((candidate) => candidate.instagram);

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-bold text-slate-900 dark:text-slate-100">Instagram DMs</h2>

        {account ? (
          <span className="flex flex-wrap items-center gap-2">
            <span
              className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                account.status === 'needs_attention'
                  ? 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300'
                  : 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300'
              }`}
            >
              {account.status === 'needs_attention' ? 'Needs attention' : 'Connected'}
            </span>

            <span
              className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                account.automationEnabled
                  ? 'bg-blue-50 text-blue-700 dark:bg-blue-500/10 dark:text-blue-300'
                  : 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400'
              }`}
            >
              {account.automationEnabled ? 'Auto-replies on' : 'Auto-replies off'}
            </span>
          </span>
        ) : null}
      </div>

      <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
        DMs arrive in your inbox and your team replies from there. Instagram uses the Facebook
        connection you already set up — there is no second login.
      </p>

      {error ? (
        <p role="alert" className="mt-3 text-sm text-red-600">
          {error}
        </p>
      ) : null}

      {notice ? (
        <p role="status" className="mt-3 text-sm text-emerald-700 dark:text-emerald-400">
          {notice}
        </p>
      ) : null}

      {/*
        THE REAUTHORIZATION PATH. An empty Page list reads as "we have no Pages" when it actually
        means "the stored authorisation could not ask" — a very different problem with a very
        different fix.
      */}
      {reauthorizeReason ? (
        <div className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-3 dark:border-amber-500/40 dark:bg-amber-500/10">
          <p className="text-xs font-semibold text-amber-900 dark:text-amber-200">
            Facebook needs reconnecting
          </p>
          <p className="mt-1 text-xs text-amber-900 dark:text-amber-200">{reauthorizeReason}</p>
          <p className="mt-1 text-xs text-amber-900 dark:text-amber-200">
            Instagram DMs also need the Instagram permissions, which an older authorisation may
            not have been granted.
          </p>
          <button
            type="button"
            onClick={() => onNavigate?.('lead-sources')}
            className="mt-2 rounded-lg border border-amber-400 px-2.5 py-1 text-xs font-medium text-amber-800 hover:bg-amber-100 dark:border-amber-500/50 dark:text-amber-200 dark:hover:bg-amber-500/20"
          >
            Reconnect Facebook
          </button>
        </div>
      ) : null}

      {account?.lastError ? (
        <div className="mt-3 rounded-lg border border-red-300 bg-red-50 p-3 dark:border-red-500/40 dark:bg-red-500/10">
          <p className="text-xs font-semibold text-red-900 dark:text-red-200">
            Instagram reported a problem
          </p>
          {/* Meta's own words, verbatim: the wording is what gets searched for. */}
          <p className="mt-1 text-xs text-red-900 dark:text-red-200">{account.lastError}</p>
        </div>
      ) : null}

      {account ? (
        <>
          <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
            <span className="font-semibold text-slate-900 dark:text-slate-100">
              @{account.username ?? account.instagramAccountId}
            </span>{' '}
            via {account.pageName ?? `Page ${account.pageId}`}
          </p>

          <div className="mt-4">
            <label htmlFor="ig-welcome" className={label}>
              Welcome reply
            </label>
            <textarea
              id="ig-welcome"
              rows={2}
              maxLength={1000}
              value={welcome}
              onChange={(e) => setWelcome(e.target.value)}
              placeholder="Thanks for getting in touch — what date are you looking at?"
              className={field}
            />
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              Sent once, on somebody&rsquo;s first message. Leave it empty for no welcome.
            </p>
          </div>

          <fieldset className="mt-4">
            <legend className={label}>Keyword replies</legend>

            <div className="space-y-2">
              {keywords.map((rule, index) => (
                <div key={index} className="grid gap-2 sm:grid-cols-[1fr_2fr_auto]">
                  <input
                    aria-label={`Keyword ${index + 1}`}
                    value={rule.keyword}
                    onChange={(e) =>
                      setKeywords((current) =>
                        current.map((row, i) =>
                          i === index ? { ...row, keyword: e.target.value } : row,
                        ),
                      )
                    }
                    placeholder="price"
                    className={field}
                  />
                  <input
                    aria-label={`Reply ${index + 1}`}
                    value={rule.reply}
                    maxLength={1000}
                    onChange={(e) =>
                      setKeywords((current) =>
                        current.map((row, i) =>
                          i === index ? { ...row, reply: e.target.value } : row,
                        ),
                      )
                    }
                    placeholder="Packages start at ₹1,50,000. What date?"
                    className={field}
                  />
                  <button
                    type="button"
                    onClick={() =>
                      setKeywords((current) => current.filter((_, i) => i !== index))
                    }
                    className="rounded-lg border border-slate-300 px-3 py-2 text-xs font-medium text-red-600 hover:bg-red-50 dark:border-slate-700 dark:hover:bg-red-500/10"
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>

            <button
              type="button"
              onClick={() => setKeywords((current) => [...current, { keyword: '', reply: '' }])}
              className="mt-2 rounded-lg border border-slate-300 px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
            >
              Add keyword
            </button>

            <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
              Matched anywhere in the message, ignoring case. The first one that matches wins, so
              put the most specific at the top. A keyword reply is sent instead of the welcome.
            </p>
          </fieldset>

          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() =>
                run(
                  () =>
                    authedRequest((token) =>
                      updateInstagramAutomation({
                        token,
                        accountId: account.id,
                        welcomeReply: welcome.trim() || null,
                        keywordReplies: keywords,
                      }),
                    ),
                  'Saved.',
                )
              }
              disabled={busy}
              className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
            >
              Save replies
            </button>

            <button
              type="button"
              onClick={() =>
                run(
                  () =>
                    authedRequest((token) =>
                      updateInstagramAutomation({
                        token,
                        accountId: account.id,
                        automationEnabled: !account.automationEnabled,
                      }),
                    ),
                  account.automationEnabled
                    ? 'Automatic replies paused. Your team still replies by hand.'
                    : 'Automatic replies on. New DMs will get a reply without anybody present.',
                )
              }
              disabled={busy}
              className={`rounded-lg px-4 py-2 text-sm font-semibold text-white disabled:opacity-50 ${
                account.automationEnabled
                  ? 'bg-slate-600 hover:bg-slate-700'
                  : 'bg-emerald-600 hover:bg-emerald-700'
              }`}
            >
              {account.automationEnabled ? 'Pause automatic replies' : 'Turn on automatic replies'}
            </button>

            <button
              type="button"
              onClick={() => setDisconnectTarget(account)}
              disabled={busy}
              className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-red-600 hover:bg-red-50 disabled:opacity-50 dark:border-slate-700 dark:hover:bg-red-500/10"
            >
              Disconnect
            </button>
          </div>
        </>
      ) : (
        <div className="mt-4">
          {connectable.length === 0 ? (
            <p className="text-xs text-slate-500 dark:text-slate-400">
              {reauthorizeReason
                ? 'Reconnect Facebook above to choose an account.'
                : 'None of your Facebook Pages has an Instagram professional account attached. Connect one in the Instagram app, then reload this page.'}
            </p>
          ) : (
            <ul className="space-y-2">
              {connectable.map((candidate) => (
                <li
                  key={candidate.pageId}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 p-3 dark:border-slate-800"
                >
                  <span className="min-w-0">
                    <span className="block text-sm font-semibold text-slate-900 dark:text-slate-100">
                      @{candidate.instagram?.username ?? candidate.instagram?.id}
                    </span>
                    <span className="block text-xs text-slate-500 dark:text-slate-400">
                      via {candidate.pageName ?? candidate.pageId}
                    </span>
                  </span>

                  <button
                    type="button"
                    onClick={() =>
                      run(
                        () =>
                          authedRequest((token) =>
                            connectInstagramAccount({
                              token,
                              pageId: candidate.pageId,
                              instagramAccountId: String(candidate.instagram?.id),
                              username: candidate.instagram?.username ?? null,
                              pageName: candidate.pageName,
                            }),
                          ),
                        'Connected. Automatic replies are off until you turn them on.',
                      )
                    }
                    disabled={busy}
                    className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:bg-blue-300"
                  >
                    Connect
                  </button>
                </li>
              ))}
            </ul>
          )}

          {/* Listed but not connectable, so "my Page isn't here" is answerable. */}
          {candidates.some((candidate) => !candidate.instagram) ? (
            <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
              {candidates.filter((candidate) => !candidate.instagram).length} other Page(s) have no
              Instagram professional account attached.
            </p>
          ) : null}
        </div>
      )}

      {disconnectTarget ? (
        <ConfirmDialog
          title="Disconnect Instagram?"
          message="New DMs stop arriving and automatic replies stop. Conversations already in your inbox stay. Reconnecting later needs the Facebook authorisation again."
          confirmLabel="Disconnect"
          tone="danger"
          busy={busy}
          onCancel={() => setDisconnectTarget(null)}
          onConfirm={() => {
            const target = disconnectTarget;
            setDisconnectTarget(null);

            void run(
              () =>
                authedRequest((token) =>
                  disconnectInstagramAccount({ token, accountId: target.id }),
                ),
              'Disconnected.',
            );
          }}
        />
      ) : null}
    </section>
  );
};

export default InstagramPanel;
