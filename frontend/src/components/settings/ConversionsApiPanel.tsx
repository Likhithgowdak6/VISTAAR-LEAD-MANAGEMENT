import { useCallback, useEffect, useState } from 'react';

import {
  connectCapi,
  getCapiConnection,
  getCapiStatus,
  setCapiEnabled,
  setCapiEvents,
  type CapiConnection,
  type CapiStatus,
} from '../../api/capi';
import { useAuth } from '../../auth/AuthContext';
import Spinner from '../Spinner';
import { errorMessage } from '../types';

/** How each milestone reads to somebody who has never seen Meta's funnel vocabulary. */
const EVENT_LABELS: Record<string, { title: string; detail: string }> = {
  lead_received: {
    title: 'Lead received',
    detail:
      'Every lead that arrives from a Meta form. Meta uses this to work out what share of your leads it can see — without it, qualified leads appear for leads it was never told about.',
  },
  lead_qualified: {
    title: 'Lead qualified',
    detail:
      'The stage moves to Qualified. This is the one most advertisers optimise toward.',
  },
  lead_won: {
    title: 'Booking won',
    detail: 'The stage moves to Won — a commitment, before any money has arrived.',
  },
  purchase: {
    title: 'Payment received',
    detail:
      'Money actually arrives in the ledger. Never when an invoice is raised — that is a request to be paid, not a sale.',
  },
};

const STATE_LABELS: Record<string, string> = {
  pending: 'Queued',
  sent: 'Delivered',
  failed: 'Failed',
  expired: 'Too old to send',
  unmatchable: 'Nothing to match on',
};

/**
 * Connecting a Meta dataset and choosing which CRM milestones get reported.
 *
 * THIS IS THE CRM INTEGRATION, NOT A WEB PIXEL, and the copy says so — because an admin who
 * thinks this is a pixel will go looking for a website to install it on. Meta treats Lead Ads
 * conversions as a separate integration: the lead id travels with the event, nothing is
 * collected from a browser, and there is no script to paste anywhere.
 *
 * DISABLED UNTIL SOMEBODY SWITCHES IT ON. Pasting a token stores a credential; the toggle is a
 * separate, deliberate act, because the moment it is on, real conversions start changing how an
 * ad account spends money.
 *
 * THE TEST EVENT CODE IS THE SAFE WAY TO PROVE IT. With one set, everything lands in Meta's Test
 * Events tab and nothing touches the advertiser's reporting — so the real milestones flow through
 * the real code path while the numbers stay untouched. There is deliberately no "send a test
 * event" button: that would prove the button works.
 */
const ConversionsApiPanel = () => {
  const { authedRequest } = useAuth();

  const [connection, setConnection] = useState<CapiConnection | null>(null);
  const [status, setStatus] = useState<CapiStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [datasetId, setDatasetId] = useState('');
  const [accessToken, setAccessToken] = useState('');
  const [testEventCode, setTestEventCode] = useState('');
  const [selected, setSelected] = useState<string[]>([]);

  const load = useCallback(async () => {
    try {
      const [connectionPayload, statusPayload] = await Promise.all([
        authedRequest((token) => getCapiConnection({ token })),
        authedRequest((token) => getCapiStatus({ token })).catch(() => null),
      ]);

      setConnection(connectionPayload.data);
      setStatus(statusPayload?.data ?? null);
      setSelected(connectionPayload.data.selectedEvents ?? []);
      setTestEventCode(connectionPayload.data.testEventCode ?? '');
      setError(null);
    } catch (loadError: unknown) {
      setError(errorMessage(loadError, 'Unable to load Conversions API settings.'));
    } finally {
      setLoading(false);
    }
  }, [authedRequest]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  const toggleEvent = (key: string) =>
    setSelected((current) =>
      current.includes(key) ? current.filter((value) => value !== key) : [...current, key],
    );

  const run = async (action: () => Promise<unknown>, success: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);

    try {
      await action();
      setNotice(success);
      await load();
    } catch (actionError: unknown) {
      // The server's messages are written for whoever is reading the screen — "Meta needs at
      // least two funnel stages to model a conversion rate" — so they are shown as written.
      setError(errorMessage(actionError, 'That did not work.'));
    } finally {
      setBusy(false);
    }
  };

  const connect = () =>
    run(
      () =>
        authedRequest((token) =>
          connectCapi({
            token,
            datasetId: datasetId.trim(),
            accessToken: accessToken.trim(),
            testEventCode: testEventCode.trim() || null,
            selectedEvents: selected,
          }),
        ).then(() => {
          // Cleared the moment it is stored: no reason for an access token to sit in component
          // state while a success message is on screen.
          setAccessToken('');
          setDatasetId('');
        }),
      'Dataset connected. Nothing is being sent until you switch delivery on.',
    );

  const field =
    'w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-blue-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100';
  const label = 'mb-1 block text-xs font-medium text-slate-600 dark:text-slate-400';

  if (loading) {
    return (
      <section className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
        <Spinner label="Loading Conversions API settings…" />
      </section>
    );
  }

  const events = connection?.availableEvents ?? [];

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-bold text-slate-900 dark:text-slate-100">
          Meta Conversions API
        </h2>

        {connection?.connected ? (
          <span className="flex flex-wrap items-center gap-2">
            <span
              className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                connection.enabled
                  ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300'
                  : 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400'
              }`}
            >
              {connection.enabled ? 'Sending' : 'Paused'}
            </span>

            {/* Live and test look identical from here otherwise, and the difference is whether
                an advertiser's reported conversions are changing. */}
            {connection.testEventCode ? (
              <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700 dark:bg-amber-500/10 dark:text-amber-300">
                Test events only
              </span>
            ) : null}
          </span>
        ) : null}
      </div>

      <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
        Reports what happens to your Meta leads back to Meta, so your ad account can optimise for
        leads that actually become customers. This is the CRM integration — there is no pixel and
        no script to install anywhere.
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

      {connection?.lastError ? (
        <div className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-3 dark:border-amber-500/40 dark:bg-amber-500/10">
          <p className="text-xs font-semibold text-amber-900 dark:text-amber-200">
            Meta reported a problem
          </p>
          {/* Meta's own words, verbatim. Paraphrasing them loses the error code somebody needs
              to search for. */}
          <p className="mt-1 text-xs text-amber-900 dark:text-amber-200">{connection.lastError}</p>
        </div>
      ) : null}

      {connection?.connected ? (
        <p className="mt-3 font-mono text-xs text-slate-500 dark:text-slate-400">
          Dataset {connection.datasetId}
          {connection.accessTokenLast4 ? ` · token ····${connection.accessTokenLast4}` : ''}
        </p>
      ) : null}

      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        <div>
          <label htmlFor="capi-dataset" className={label}>
            Dataset ID
          </label>
          <input
            id="capi-dataset"
            value={datasetId}
            onChange={(e) => setDatasetId(e.target.value)}
            placeholder={connection?.datasetId ?? '1234567890123'}
            autoComplete="off"
            className={`${field} font-mono`}
          />
        </div>

        <div>
          <label htmlFor="capi-token" className={label}>
            Access token
          </label>
          <input
            id="capi-token"
            type="password"
            value={accessToken}
            onChange={(e) => setAccessToken(e.target.value)}
            autoComplete="off"
            className={`${field} font-mono`}
          />
        </div>

        <div>
          <label htmlFor="capi-test-code" className={label}>
            Test event code
          </label>
          <input
            id="capi-test-code"
            value={testEventCode}
            onChange={(e) => setTestEventCode(e.target.value.toUpperCase())}
            placeholder="TEST12345"
            autoComplete="off"
            className={`${field} font-mono`}
          />
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            While this is set, nothing reaches your real reporting.
          </p>
        </div>
      </div>

      <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
        The token is encrypted before it is stored and is never shown again. To change it, paste a
        new one.
      </p>

      <fieldset className="mt-4">
        <legend className={label}>What gets reported</legend>

        <div className="grid gap-2 sm:grid-cols-2">
          {events.map((event) => {
            const copy = EVENT_LABELS[event.key] ?? {
              title: event.key,
              detail: `Sent to Meta as ${event.metaEventName}.`,
            };

            return (
              <label
                key={event.key}
                className={`cursor-pointer rounded-lg border p-3 transition ${
                  selected.includes(event.key)
                    ? 'border-blue-500 bg-blue-50 ring-1 ring-blue-500 dark:bg-blue-500/10'
                    : 'border-slate-200 hover:border-slate-300 dark:border-slate-700'
                }`}
              >
                <span className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    checked={selected.includes(event.key)}
                    onChange={() => toggleEvent(event.key)}
                    className="mt-0.5"
                  />
                  <span>
                    <span className="block text-sm font-semibold text-slate-900 dark:text-slate-100">
                      {copy.title}
                    </span>
                    <span className="mt-1 block text-xs text-slate-600 dark:text-slate-400">
                      {copy.detail}
                    </span>
                  </span>
                </span>
              </label>
            );
          })}
        </div>

        <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
          Meta needs at least two of these to work out a conversion rate. Reporting only payments
          is refused.
        </p>
      </fieldset>

      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={connect}
          disabled={busy || datasetId.trim() === '' || accessToken.trim() === ''}
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:bg-blue-300"
        >
          {connection?.connected ? 'Replace credentials' : 'Connect dataset'}
        </button>

        {connection?.connected ? (
          <>
            <button
              type="button"
              onClick={() =>
                run(
                  () =>
                    authedRequest((token) =>
                      setCapiEvents({
                        token,
                        selectedEvents: selected,
                        testEventCode: testEventCode.trim() || null,
                      }),
                    ),
                  'Saved.',
                )
              }
              disabled={busy}
              className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
            >
              Save what gets reported
            </button>

            <button
              type="button"
              onClick={() =>
                run(
                  () =>
                    authedRequest((token) =>
                      setCapiEnabled({ token, enabled: !connection.enabled }),
                    ),
                  connection.enabled
                    ? 'Delivery paused. Milestones stop being queued.'
                    : 'Delivery on. New milestones will be reported to Meta.',
                )
              }
              disabled={busy}
              className={`rounded-lg px-4 py-2 text-sm font-semibold text-white disabled:opacity-50 ${
                connection.enabled
                  ? 'bg-slate-600 hover:bg-slate-700'
                  : 'bg-emerald-600 hover:bg-emerald-700'
              }`}
            >
              {connection.enabled ? 'Pause delivery' : 'Start sending'}
            </button>
          </>
        ) : null}
      </div>

      {status ? (
        <div className="mt-4 rounded-lg border border-slate-200 p-3 dark:border-slate-800">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
            Delivery
          </p>

          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
            {Object.entries(status.counts).map(([state, count]) => (
              <span key={state} className="text-xs text-slate-600 dark:text-slate-400">
                {STATE_LABELS[state] ?? state}:{' '}
                <span className="font-semibold text-slate-900 dark:text-slate-100">{count}</span>
              </span>
            ))}
          </div>

          {status.recentFailures.length > 0 ? (
            <ul className="mt-2 divide-y divide-slate-100 dark:divide-slate-800">
              {status.recentFailures.map((failure, index) => (
                <li key={index} className="py-1.5">
                  <p className="text-xs font-medium text-slate-900 dark:text-slate-100">
                    {EVENT_LABELS[failure.eventKey ?? '']?.title ?? failure.eventKey} ·{' '}
                    {STATE_LABELS[failure.state ?? ''] ?? failure.state}
                  </p>
                  <p className="text-xs text-red-600 dark:text-red-400">{failure.lastError}</p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
              Nothing has failed.
            </p>
          )}
        </div>
      ) : null}
    </section>
  );
};

export default ConversionsApiPanel;
