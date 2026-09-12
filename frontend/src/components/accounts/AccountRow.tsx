import { type ReactNode, useState } from 'react';

import {
  disconnectAccount,
  pauseAccount,
  removeAccount,
  resetAccount,
  resumeAccount,
} from '../../api/endpoints';
import { useAuth } from '../../auth/AuthContext';
import { hasPermission, PERMISSIONS } from '../../lib/permissions';
import {
  type AccountRemoval,
  type AuthValue,
  type AuthedRequest,
  type WhatsAppAccount,
} from '../types';
import AccountStatusBadge from './AccountStatusBadge';
import RemoveAccountDialog from './RemoveAccountDialog';

type ActionTone = 'default' | 'primary' | 'danger';

type ActionButtonProps = {
  children: ReactNode;
  onClick: () => void;
  tone?: ActionTone;
  disabled?: boolean;
};

const ActionButton = ({ children, onClick, tone = 'default', disabled }: ActionButtonProps) => {
  const tones: Record<ActionTone, string> = {
    default: 'border-slate-300 text-slate-700 hover:bg-slate-50',
    primary: 'border-blue-600 bg-blue-600 text-white hover:bg-blue-700',
    danger: 'border-slate-300 text-red-600 hover:bg-red-50',
  };
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`rounded-lg border px-2.5 py-1 text-xs font-medium disabled:opacity-50 ${tones[tone]}`}
    >
      {children}
    </button>
  );
};

type Props = {
  account: WhatsAppAccount;
  onConnect: (account: WhatsAppAccount) => void;
  onChanged?: () => void;
  /** Called with what the server actually did, so the page can say which of the two it was. */
  onRemoved?: (removal: AccountRemoval) => void;
};

const AccountRow = ({ account, onConnect, onChanged, onRemoved }: Props) => {
  const { authedRequest, permissions } = useAuth() as AuthValue;
  const [busy, setBusy] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const canManage = hasPermission(permissions, PERMISSIONS.ACCOUNTS_MANAGE);

  const run = async (makeRequest: Parameters<AuthedRequest>[0]) => {
    setBusy(true);
    try {
      await authedRequest(makeRequest);
      onChanged?.();
    } catch {
      onChanged?.();
    } finally {
      setBusy(false);
    }
  };

  // Not folded into `run`: this is the one action whose response says something the list cannot
  // show afterwards - the row is gone either way, deleted or merely hidden.
  const confirmRemove = async () => {
    setBusy(true);
    try {
      const payload = await authedRequest((token) =>
        removeAccount({ token, accountId: account.id }),
      );
      setConfirmingRemove(false);
      if (payload?.data) {
        onRemoved?.(payload.data);
      }
      onChanged?.();
    } catch {
      setConfirmingRemove(false);
      onChanged?.();
    } finally {
      setBusy(false);
    }
  };

  const { status } = account;
  const canConnect = ['pending', 'disconnected', 'reconnecting'].includes(status);

  return (
    <li className="flex flex-col gap-3 border-b border-slate-100 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="truncate font-semibold text-slate-900">{account.name}</span>
          <AccountStatusBadge status={status} />
        </div>
        <p className="truncate text-xs text-slate-400">{account.brandKey}</p>
      </div>

      {canManage ? (
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
          {canConnect ? (
            <ActionButton tone="primary" onClick={() => onConnect(account)} disabled={busy}>
              Connect
            </ActionButton>
          ) : null}
          {status === 'active' ? (
            <ActionButton
              onClick={() => run((token) => pauseAccount({ token, accountId: account.id }))}
              disabled={busy}
            >
              Pause
            </ActionButton>
          ) : null}
          {status === 'paused' ? (
            <ActionButton
              onClick={() => run((token) => resumeAccount({ token, accountId: account.id }))}
              disabled={busy}
            >
              Resume
            </ActionButton>
          ) : null}
          {status === 'active' || status === 'connecting' ? (
            <ActionButton
              onClick={() => run((token) => disconnectAccount({ token, accountId: account.id }))}
              disabled={busy}
            >
              Disconnect
            </ActionButton>
          ) : null}
          {status !== 'pending' ? (
            <ActionButton
              onClick={() => run((token) => resetAccount({ token, accountId: account.id }))}
              disabled={busy}
            >
              Reset
            </ActionButton>
          ) : null}
          <ActionButton tone="danger" onClick={() => setConfirmingRemove(true)} disabled={busy}>
            Remove
          </ActionButton>
        </div>
      ) : null}

      {confirmingRemove ? (
        <RemoveAccountDialog
          account={account}
          busy={busy}
          onCancel={() => setConfirmingRemove(false)}
          onConfirm={confirmRemove}
        />
      ) : null}
    </li>
  );
};

export default AccountRow;
