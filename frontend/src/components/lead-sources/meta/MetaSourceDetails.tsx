import { useCallback, useEffect, useState } from 'react';

import {
  getMetaConnection,
  retryMetaWebhookSubscription,
  runMetaDiagnostics,
} from '../../../api/endpoints';
import { useAuth } from '../../../auth/AuthContext';
import RelativeTime from '../../RelativeTime';
import Spinner from '../../Spinner';
import { errorMessage, type AuthValue } from '../../types';
import {
  type LeadSource,
  type MetaConnection,
  type MetaDiagnostics,
} from './meta-wizard-types';
import { primaryButtonClass, secondaryButtonClass } from './meta-wizard-ui';

type Props = {
  leadSource: LeadSource;
  onClose: () => void;
  onChanged: () => void;
  /** Opens the wizard at step one, for re-authorising Facebook. */
  onReconnect: () => void;
};

const CHECK_LABELS: Readonly<Record<string, string>> = {
  connection: 'Facebook account',
  page_access: 'Page access',
  form_access: 'Lead form',
  webhook: 'Instant delivery',
};

/**
 * Step 7. What state this connection is actually in, and the two buttons that fix it.
 *
 * Diagnostics are RE-RUN against Meta rather than read off our own record. A stored
 * `webhookSubscribedAt` only says we once succeeded; it cannot know that the page was since
 * disconnected from the app in Business Suite, which is exactly the failure someone opens this
 * panel to understand.
 */
const MetaSourceDetails = ({ leadSource, onClose, onChanged, onReconnect }: Props) => {
  const { authedRequest } = useAuth() as AuthValue;
  const [connection, setConnection] = useState<MetaConnection | null>(null);
  const [diagnostics, setDiagnostics] = useState<MetaDiagnostics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [retryNote, setRetryNote] = useState<string | null>(null);

  const pageId = leadSource.meta.pageId;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const connectionPayload = await authedRequest((token) => getMetaConnection({ token }));
      setConnection(connectionPayload.data?.connection ?? null);

      if (pageId) {
        const diagnosticsPayload = await authedRequest((token) =>
          runMetaDiagnostics({ token, pageId, formId: leadSource.meta.formId }),
        );
        setDiagnostics(diagnosticsPayload.data ?? null);
      }
    } catch (loadError: unknown) {
      setError(errorMessage(loadError, 'Could not check this connection.'));
    } finally {
      setLoading(false);
    }
  }, [authedRequest, leadSource.meta.formId, pageId]);

  useEffect(() => {
    // The panel's whole purpose is to go and ask Facebook the moment it opens, which is a fetch
    // that necessarily flips `loading` on the way in. Same exemption LeadSourcesPage takes.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const handleRetry = async () => {
    if (retrying) {
      return;
    }

    setRetrying(true);
    setRetryNote(null);
    setError(null);

    try {
      const payload = await authedRequest((token) =>
        retryMetaWebhookSubscription({ token, leadSourceId: leadSource.id }),
      );

      setRetryNote(
        payload.data?.webhookSubscribed
          ? 'Subscribed. Leads from this form now arrive within seconds.'
          : (payload.data?.webhookError ?? 'Facebook refused the subscription again.'),
      );
      onChanged();
      await load();
    } catch (retryError: unknown) {
      setError(errorMessage(retryError, 'Could not retry the connection.'));
    } finally {
      setRetrying(false);
    }
  };

  const subscribed = Boolean(leadSource.meta.webhookSubscribedAt);

  return (
    <div
      role="dialog"
      aria-label={`Connection details for ${leadSource.name}`}
      className="fixed inset-0 z-10 flex items-center justify-center bg-slate-900/40 p-4"
    >
      <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl bg-white p-6 shadow-xl">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="truncate text-base font-semibold text-slate-900">{leadSource.name}</h3>
            <p className="mt-0.5 text-xs text-slate-500">Facebook lead form connection</p>
          </div>
          <span
            className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${
              leadSource.status === 'active'
                ? 'bg-emerald-50 text-emerald-700'
                : 'bg-amber-100 text-amber-800'
            }`}
          >
            {leadSource.status === 'active' ? 'Active' : 'Paused'}
          </span>
        </div>

        <dl className="mt-4 rounded-xl border border-slate-200 px-3">
          <div className="flex items-start justify-between gap-4 border-b border-slate-100 py-2">
            <dt className="text-xs text-slate-500">Facebook account</dt>
            <dd className="text-xs font-medium text-slate-800">
              {connection?.metaUserName ?? (loading ? '…' : 'Not connected')}
            </dd>
          </div>
          <div className="flex items-start justify-between gap-4 border-b border-slate-100 py-2">
            <dt className="text-xs text-slate-500">Page</dt>
            <dd className="text-xs font-medium text-slate-800">
              {leadSource.meta.pageName ?? leadSource.meta.pageId ?? '—'}
            </dd>
          </div>
          <div className="flex items-start justify-between gap-4 border-b border-slate-100 py-2">
            <dt className="text-xs text-slate-500">Lead form</dt>
            <dd className="text-xs font-medium text-slate-800">
              {leadSource.meta.formName ?? leadSource.meta.formId ?? 'Every form'}
            </dd>
          </div>
          <div className="flex items-start justify-between gap-4 py-2">
            <dt className="text-xs text-slate-500">Instant delivery</dt>
            <dd className="text-xs font-medium text-slate-800">
              {subscribed ? (
                <>
                  On · since <RelativeTime value={leadSource.meta.webhookSubscribedAt ?? null} />
                </>
              ) : (
                'Off — leads arrive on the ten-minute check'
              )}
            </dd>
          </div>
        </dl>

        {leadSource.meta.webhookError ? (
          <p className="mt-2 rounded-lg bg-amber-50 px-2 py-1.5 text-xs text-amber-800">
            {leadSource.meta.webhookError}
          </p>
        ) : null}

        {leadSource.lastError ? (
          <p className="mt-2 rounded-lg bg-red-50 px-2 py-1.5 text-xs text-red-700">
            {leadSource.lastError}
          </p>
        ) : null}

        <div className="mt-4">
          <div className="flex items-center justify-between">
            <h4 className="text-xs font-semibold text-slate-700">Checks</h4>
            <button
              type="button"
              onClick={() => void load()}
              disabled={loading}
              className="text-xs font-medium text-blue-600 hover:text-blue-700 disabled:opacity-50"
            >
              Re-run
            </button>
          </div>

          {loading ? (
            <div className="py-3">
              <Spinner label="Checking with Facebook…" />
            </div>
          ) : null}

          {!loading && !pageId ? (
            <p className="mt-2 text-xs text-slate-500">
              This source has no page recorded, so there is nothing to check against Facebook.
            </p>
          ) : null}

          {!loading && diagnostics ? (
            <ul className="mt-2 space-y-1">
              {diagnostics.checks.map((check) => (
                <li key={check.key} className="flex items-start gap-2 text-xs">
                  <span
                    aria-hidden="true"
                    className={`mt-1 h-2 w-2 shrink-0 rounded-full ${
                      check.ok ? 'bg-emerald-500' : 'bg-red-500'
                    }`}
                  />
                  <span className="min-w-0">
                    <span className="font-medium text-slate-700">
                      {CHECK_LABELS[check.key] ?? check.key}
                    </span>
                    <span className="block text-slate-500">{check.detail}</span>
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>

        {retryNote ? (
          <p role="status" className="mt-3 rounded-lg bg-slate-100 px-2 py-1.5 text-xs text-slate-700">
            {retryNote}
          </p>
        ) : null}

        {error ? (
          <p role="alert" className="mt-3 text-xs text-red-600">
            {error}
          </p>
        ) : null}

        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <button type="button" onClick={onClose} className={secondaryButtonClass}>
            Close
          </button>
          <button type="button" onClick={onReconnect} className={secondaryButtonClass}>
            Reconnect Facebook
          </button>
          {/* Offered whenever delivery is off — including when it never succeeded, which is the
              common case for a source created while the subscription was refused. */}
          {!subscribed ? (
            <button
              type="button"
              onClick={handleRetry}
              disabled={retrying}
              className={primaryButtonClass}
            >
              {retrying ? 'Retrying…' : 'Retry connection'}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
};

export default MetaSourceDetails;
