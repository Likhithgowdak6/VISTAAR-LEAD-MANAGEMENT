import { useState } from 'react';

import { deleteLeadSource, syncLeadSource, updateLeadSource } from '../../api/endpoints';
import { useAuth } from '../../auth/AuthContext';
import RelativeTime from '../RelativeTime';
import { type AuthValue, errorMessage, type LeadSource, type WhatsAppAccount } from '../types';

type Props = {
  leadSource: LeadSource;
  accounts: readonly WhatsAppAccount[];
  onChanged?: () => void;
};

const SYNC_BADGE: Readonly<Record<string, string>> = {
  ok: 'bg-emerald-50 text-emerald-700',
  failed: 'bg-red-50 text-red-700',
  pending: 'bg-slate-100 text-slate-600',
};

const SYNC_LABEL: Readonly<Record<string, string>> = {
  ok: 'Syncing',
  failed: 'Sync failed',
  pending: 'Not synced yet',
};

const LeadSourceRow = ({ leadSource, accounts, onChanged }: Props) => {
  const { authedRequest } = useAuth() as AuthValue;
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const accountName =
    accounts.find((account) => account.id === leadSource.whatsappAccountId)?.name ??
    'Unknown number';
  const isPaused = leadSource.status === 'paused';

  const run = async (action: string, task: () => Promise<unknown>) => {
    setBusy(action);
    setError(null);

    try {
      await task();
      onChanged?.();
    } catch (actionError: unknown) {
      setError(errorMessage(actionError, 'Action failed.'));
    } finally {
      setBusy(null);
    }
  };

  const handleSync = () =>
    run('sync', () =>
      authedRequest((token) => syncLeadSource({ token, leadSourceId: leadSource.id })),
    );

  const handleTogglePause = () =>
    run('pause', () =>
      authedRequest((token) =>
        updateLeadSource({
          token,
          leadSourceId: leadSource.id,
          status: isPaused ? 'active' : 'paused',
        }),
      ),
    );

  const handleToggleAi = () =>
    run('ai', () =>
      authedRequest((token) =>
        updateLeadSource({
          token,
          leadSourceId: leadSource.id,
          aiContextEnabled: !leadSource.aiContextEnabled,
        }),
      ),
    );

  const handleRemove = () =>
    run('remove', () =>
      authedRequest((token) => deleteLeadSource({ token, leadSourceId: leadSource.id })),
    );

  return (
    <li className="border-b border-slate-100 p-4 last:border-b-0">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="truncate font-semibold text-slate-900">{leadSource.name}</h3>
            <span
              className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                SYNC_BADGE[leadSource.lastSyncStatus] ?? SYNC_BADGE.pending
              }`}
            >
              {isPaused ? 'Paused' : (SYNC_LABEL[leadSource.lastSyncStatus] ?? 'Unknown')}
            </span>
          </div>

          <p className="mt-1 text-xs text-slate-500">
            New leads open on <span className="font-medium text-slate-700">{accountName}</span> ·
            default +{leadSource.defaultCountryCode}
            {leadSource.aiContextEnabled ? ' · AI context on' : null}
          </p>

          <p className="mt-1 text-xs text-slate-400">
            {leadSource.totalImported} lead{leadSource.totalImported === 1 ? '' : 's'} imported
            {leadSource.lastSyncedAt ? (
              <>
                {' · last checked '}
                <RelativeTime value={leadSource.lastSyncedAt} />
              </>
            ) : null}
            {leadSource.lastSyncCounts.skipped > 0
              ? ` · ${leadSource.lastSyncCounts.skipped} skipped`
              : null}
          </p>

          <a
            href={leadSource.sheetUrl}
            target="_blank"
            rel="noreferrer"
            className="mt-1 inline-block text-xs font-medium text-blue-600 hover:text-blue-700"
          >
            Open sheet
          </a>
        </div>

        <div className="flex shrink-0 flex-wrap justify-end gap-2">
          <button
            type="button"
            onClick={handleSync}
            disabled={busy !== null}
            className="rounded-lg border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            {busy === 'sync' ? 'Syncing…' : 'Sync now'}
          </button>
          <button
            type="button"
            onClick={handleTogglePause}
            disabled={busy !== null}
            className="rounded-lg border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            {isPaused ? 'Resume' : 'Pause'}
          </button>
          <button
            type="button"
            onClick={handleToggleAi}
            disabled={busy !== null}
            className="rounded-lg border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            {leadSource.aiContextEnabled ? 'Disable AI context' : 'Enable AI context'}
          </button>
          <button
            type="button"
            onClick={handleRemove}
            disabled={busy !== null}
            className="rounded-lg border border-red-200 px-2.5 py-1 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-50"
          >
            Remove
          </button>
        </div>
      </div>

      {/* The sheet's own failure message, written for an admin ("not link-shared"). */}
      {leadSource.lastError && leadSource.lastSyncStatus === 'failed' ? (
        <p className="mt-2 rounded-lg bg-red-50 px-2 py-1.5 text-xs text-red-700">
          {leadSource.lastError}
        </p>
      ) : null}

      {error ? (
        <p role="alert" className="mt-2 text-xs text-red-600">
          {error}
        </p>
      ) : null}
    </li>
  );
};

export default LeadSourceRow;
