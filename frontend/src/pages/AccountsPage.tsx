import { useCallback, useEffect, useState } from 'react';

import { listAccounts } from '../api/endpoints';
import { useAuth } from '../auth/AuthContext';
import AccountRow from '../components/accounts/AccountRow';
import AddAccountForm from '../components/accounts/AddAccountForm';
import ConnectQrModal from '../components/accounts/ConnectQrModal';
import EmptyState from '../components/EmptyState';
import Spinner from '../components/Spinner';
import { type AccountRemoval, type RealtimeValue, type WhatsAppAccount } from '../components/types';
import { describeAccountRemoval } from '../lib/account-removal';
import { hasPermission, PERMISSIONS } from '../lib/permissions';
import { useRealtime } from '../realtime/RealtimeProvider';

const AccountsPage = () => {
  const { authedRequest, permissions } = useAuth();
  const { subscribe } = useRealtime() as RealtimeValue;
  const [accounts, setAccounts] = useState<WhatsAppAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState<WhatsAppAccount | null>(null);
  const [removalNotice, setRemovalNotice] = useState<string | null>(null);
  const canManage = hasPermission(permissions, PERMISSIONS.ACCOUNTS_MANAGE);

  const load = useCallback(async () => {
    try {
      const payload = await authedRequest((token) => listAccounts({ token }));
      // The API already leaves removed accounts out of the default list; this is belt and braces
      // so a soft-removed number can never reappear here with a grey "Removed" badge.
      setAccounts((payload.data ?? []).filter((account) => account.status !== 'removed'));
      setError(null);
    } catch (loadError: unknown) {
      setError(loadError instanceof Error ? loadError.message : 'Unable to load accounts.');
    } finally {
      setLoading(false);
    }
  }, [authedRequest]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  // Realtime: refetch when any account status changes.
  useEffect(
    () => subscribe((event) => event?.type === 'account.changed' && load()),
    [subscribe, load],
  );

  // The modal owns the connect call + polling so it can surface any error.
  const startConnect = (account: WhatsAppAccount) => setConnecting(account);

  // The row is gone by the time this runs, so the page is the only place left to say whether the
  // number was deleted for good or just hidden.
  const handleRemoved = (removal: AccountRemoval) =>
    setRemovalNotice(describeAccountRemoval(removal));

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-6">
      <div>
        <h1 className="text-xl font-bold text-slate-900">WhatsApp numbers</h1>
        <p className="mt-1 text-sm text-slate-500">
          Connect and manage the numbers this workspace uses. Disposable numbers only — never a
          personal or client number.
        </p>
      </div>

      {removalNotice ? (
        <div className="flex items-start justify-between gap-3 rounded-xl border border-slate-200 bg-slate-50 p-3">
          <p role="status" className="text-sm text-slate-700">
            {removalNotice}
          </p>
          <button
            type="button"
            onClick={() => setRemovalNotice(null)}
            aria-label="Dismiss"
            className="shrink-0 text-slate-400 hover:text-slate-600"
          >
            ×
          </button>
        </div>
      ) : null}

      {canManage ? <AddAccountForm onCreated={load} /> : null}

      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
        {loading ? (
          <div className="p-4">
            <Spinner label="Loading accounts…" />
          </div>
        ) : null}
        {error ? (
          <p role="alert" className="p-4 text-sm text-red-600">
            {error}
          </p>
        ) : null}
        {!loading && accounts.length === 0 ? (
          <EmptyState title="No numbers yet" description="Add a WhatsApp number to get started." />
        ) : null}
        <ul>
          {accounts.map((account) => (
            <AccountRow
              key={account.id}
              account={account}
              onConnect={startConnect}
              onChanged={load}
              onRemoved={handleRemoved}
            />
          ))}
        </ul>
      </div>

      {connecting ? (
        <ConnectQrModal
          account={connecting}
          onClose={() => {
            setConnecting(null);
            void load();
          }}
          onConnected={load}
        />
      ) : null}
    </div>
  );
};

export default AccountsPage;
