import Spinner from '../../Spinner';
import { type MetaConnection, type MetaConnectReturn } from './meta-wizard-types';
import { primaryButtonClass, secondaryButtonClass } from './meta-wizard-ui';

type Props = {
  loading: boolean;
  /** False when the SERVER has no Meta app credentials — the button would fail at Facebook. */
  configured: boolean;
  connection: MetaConnection | null;
  /** The outcome of a redirect we have just come back from, if any. */
  returned: MetaConnectReturn | null;
  starting: boolean;
  error: string | null;
  onConnect: () => void;
  onDisconnect: () => void;
};

/**
 * Step 1. Authorise Facebook once for the whole organisation.
 *
 * This is the only step that leaves the app: Facebook's consent screen cannot be embedded, so
 * "Connect" is a full-page redirect and the backend redirects back. Nothing is selected yet when
 * that happens, which is exactly why the redirect lives in step one — a later step would throw
 * away a page, a form and a reviewed mapping on the way out.
 */
const MetaConnectStep = ({
  loading,
  configured,
  connection,
  returned,
  starting,
  error,
  onConnect,
  onDisconnect,
}: Props) => {
  if (loading) {
    return (
      <div className="p-6">
        <Spinner label="Checking your Facebook connection…" />
      </div>
    );
  }

  const isConnected = connection !== null && connection.status !== 'disconnected';
  const needsAttention = connection?.status === 'needs_attention';

  return (
    <div className="space-y-4">
      {returned && returned.outcome !== 'connected' ? (
        <p
          role="alert"
          className={`rounded-lg px-3 py-2 text-xs ${
            returned.outcome === 'cancelled'
              ? 'bg-slate-100 text-slate-600'
              : 'bg-red-50 text-red-700'
          }`}
        >
          {returned.message ??
            (returned.outcome === 'cancelled'
              ? 'Facebook sign-in was cancelled.'
              : 'Facebook sign-in could not be completed.')}
        </p>
      ) : null}

      {!configured ? (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
          Facebook sign-in isn&apos;t set up on this server yet. Ask whoever runs it to add the
          Meta app credentials — until then, use the Meta Lead Ads tab and paste a Page access
          token instead.
        </p>
      ) : null}

      {isConnected ? (
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-slate-900">
                {connection.metaUserName ?? 'Facebook account'}
              </p>
              <p className="mt-0.5 text-xs text-slate-500">
                {needsAttention
                  ? 'This connection needs attention — reconnect to continue.'
                  : 'Connected. Vistaar can read this account’s pages and lead forms.'}
              </p>
              {/* Four characters, so two authorisations can be told apart. The credential
                  itself never reaches the browser. */}
              {connection.accessTokenLast4 ? (
                <p className="mt-1 font-mono text-[11px] text-slate-400">
                  credential ····{connection.accessTokenLast4}
                </p>
              ) : null}
            </div>
            <span
              className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${
                needsAttention ? 'bg-amber-100 text-amber-800' : 'bg-emerald-50 text-emerald-700'
              }`}
            >
              {needsAttention ? 'Needs attention' : 'Connected'}
            </span>
          </div>

          {connection.lastError ? (
            <p className="mt-2 rounded-lg bg-amber-50 px-2 py-1.5 text-xs text-amber-800">
              {connection.lastError}
            </p>
          ) : null}

          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={onConnect}
              disabled={starting || !configured}
              className={secondaryButtonClass}
            >
              {starting ? 'Opening Facebook…' : 'Reconnect'}
            </button>
            <button
              type="button"
              onClick={onDisconnect}
              disabled={starting}
              className="rounded-lg border border-red-200 px-3 py-2 text-sm font-medium text-red-600 hover:bg-red-50 disabled:opacity-50"
            >
              Disconnect
            </button>
          </div>
        </div>
      ) : (
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <p className="text-sm text-slate-700">
            Sign in with the Facebook account that manages your page. Vistaar will then list your
            lead forms for you.
          </p>
          <ul className="mt-2 space-y-1 text-xs text-slate-500">
            <li>· You&apos;ll be taken to Facebook and brought straight back.</li>
            <li>· Nothing is posted to your page, and no adverts are changed.</li>
            <li>· There is no token to copy anywhere.</li>
          </ul>

          <button
            type="button"
            onClick={onConnect}
            disabled={starting || !configured}
            className={`${primaryButtonClass} mt-3`}
          >
            {starting ? 'Opening Facebook…' : 'Connect Facebook'}
          </button>
        </div>
      )}

      {error ? (
        <p role="alert" className="text-xs text-red-600">
          {error}
        </p>
      ) : null}
    </div>
  );
};

export default MetaConnectStep;
