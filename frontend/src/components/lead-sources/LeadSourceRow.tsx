import { useState } from 'react';

import { deleteLeadSource, syncLeadSource, updateLeadSource } from '../../api/endpoints';
import { useAuth } from '../../auth/AuthContext';
import RelativeTime from '../RelativeTime';
import ToggleSwitch from '../ToggleSwitch';
import { type AuthValue, errorMessage, type LeadSource, type WhatsAppAccount } from '../types';

type Props = {
  leadSource: LeadSource;
  accounts: readonly WhatsAppAccount[];
  onChanged?: () => void;
};

const SYNC_BADGE: Readonly<Record<string, string>> = {
  ok: 'bg-emerald-50 text-emerald-700',
  failed: 'bg-red-50 text-red-700',
  // Deliberately not the same red as a failed sync: this one will not fix itself.
  needs_attention: 'bg-amber-100 text-amber-800',
  pending: 'bg-slate-100 text-slate-600',
};

const SYNC_LABEL: Readonly<Record<string, string>> = {
  ok: 'Syncing',
  failed: 'Sync failed',
  needs_attention: 'Needs attention',
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
  // A source stored before the field existed has no `kind` on the wire: it is a sheet.
  const isMeta = leadSource.kind === 'meta_lead_ads';

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

  const handleToggleAutoGreet = () =>
    run('greet', () =>
      authedRequest((token) =>
        updateLeadSource({
          token,
          leadSourceId: leadSource.id,
          autoGreetEnabled: !leadSource.autoGreetEnabled,
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

          {isMeta ? (
            <p className="mt-1 text-xs text-slate-500">
              Meta Lead Ads ·{' '}
              <span className="font-medium text-slate-700">
                {leadSource.meta.pageName ?? leadSource.meta.pageId ?? 'Unknown page'}
              </span>{' '}
              · {leadSource.meta.formName ?? (leadSource.meta.formId ? 'One form' : 'Every form')}
              {/* Four characters, so an admin rotating a token can tell which one is stored.
                  The token itself is never sent to the browser. */}
              {leadSource.meta.accessTokenLast4 ? (
                <span className="text-slate-400"> · token ····{leadSource.meta.accessTokenLast4}</span>
              ) : null}
            </p>
          ) : null}

          {!isMeta && leadSource.sheetUrl ? (
            <a
              href={leadSource.sheetUrl}
              target="_blank"
              rel="noreferrer"
              className="mt-1 inline-block text-xs font-medium text-blue-600 hover:text-blue-700"
            >
              Open sheet
            </a>
          ) : null}
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
            onClick={handleRemove}
            disabled={busy !== null}
            className="rounded-lg border border-red-200 px-2.5 py-1 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-50"
          >
            Remove
          </button>
        </div>
      </div>

      {/* Per form, not per ad: several ads can point at one form, and a lead only ever carries the
          form it came from. Two ads sharing a form cannot be separated here because they cannot be
          separated in the data either. */}
      <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-slate-100 pt-3">
        <label className="flex items-center gap-2 text-xs text-slate-600">
          <ToggleSwitch
            size="sm"
            checked={!isPaused}
            disabled={busy !== null}
            label={isPaused ? `Resume importing from ${leadSource.name}` : `Pause importing from ${leadSource.name}`}
            onChange={handleTogglePause}
          />
          <span>Importing</span>
        </label>

        <label className="flex items-center gap-2 text-xs text-slate-600">
          <ToggleSwitch
            size="sm"
            checked={Boolean(leadSource.aiContextEnabled)}
            disabled={busy !== null}
            label={`Let the AI read the form answers for ${leadSource.name}`}
            onChange={handleToggleAi}
          />
          <span>AI reads answers</span>
        </label>

        <label className="flex items-center gap-2 text-xs text-slate-600">
          <ToggleSwitch
            size="sm"
            checked={Boolean(leadSource.autoGreetEnabled)}
            disabled={busy !== null}
            label={`Let the AI message new leads from ${leadSource.name} first`}
            onChange={handleToggleAutoGreet}
          />
          <span>AI messages first</span>
        </label>

        {leadSource.autoGreetEnabled ? (
          // Said plainly, next to the switch that causes it. This is the only setting in the app
          // that makes the studio message a stranger.
          <span className="text-[11px] text-amber-700">
            New leads get a WhatsApp from the AI 5 minutes after they fill this form.
          </span>
        ) : null}
      </div>

      {/* The importer's own failure message, written for an admin ("not link-shared", "the
          token has expired"). Never Meta's raw prose, and never a URL. */}
      {leadSource.lastError &&
      (leadSource.lastSyncStatus === 'failed' ||
        leadSource.lastSyncStatus === 'needs_attention') ? (
        <p
          className={`mt-2 rounded-lg px-2 py-1.5 text-xs ${
            leadSource.lastSyncStatus === 'needs_attention'
              ? 'bg-amber-50 text-amber-800'
              : 'bg-red-50 text-red-700'
          }`}
        >
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
