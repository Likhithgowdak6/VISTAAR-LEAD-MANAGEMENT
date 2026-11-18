import { type ReactNode, useEffect, useState } from 'react';

import {
  disconnectAccount,
  pauseAccount,
  removeAccount,
  resetAccount,
  resumeAccount,
  syncAccountTemplates,
  testCloudAccount,
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
  const [localStatus, setLocalStatus] = useState<string | null>(null);
  const canManage = hasPermission(permissions, PERMISSIONS.ACCOUNTS_MANAGE);

  useEffect(() => {
    setLocalStatus(null);
  }, [account.status]);

  const run = async (makeRequest: Parameters<AuthedRequest>[0]) => {
    setBusy(true);
    try {
      const payload: any = await authedRequest(makeRequest);
      if (payload?.data?.status) {
        setLocalStatus(payload.data.status);
      }
      onChanged?.();
    } catch {
      onChanged?.();
    } finally {
      setBusy(false);
    }
  };

  // Not folded into `run`: this is the one action whose response says something the list cannot
  // show afterwards - the row is gone either way, deleted or merely hidden.
  const confirmRemove = async (purgeHistory: boolean) => {
    setBusy(true);
    try {
      const payload = await authedRequest((token) =>
        removeAccount({ token, accountId: account.id, purgeHistory }),
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

  const status = localStatus ?? account.status;
  const canConnect = ['pending', 'disconnected', 'reconnecting'].includes(status);
  const isCloud = account.provider === 'cloud';

  // A Cloud number has no stored WhatsApp Web login, so Reset has nothing to clear; the server
  // refuses it. Hidden rather than shown disabled, so nobody tries it when a number stops working
  // and concludes the product is broken.
  const canReset = !isCloud && status !== 'pending';

  // Meta's own warning that a number is about to be limited. There is nowhere else in the product
  // this surfaces, and by the time it shows in Meta's dashboard the limiting has usually started.
  const qualityWarning =
    isCloud && (account.cloud?.qualityRating === 'RED' || account.cloud?.qualityRating === 'YELLOW')
      ? account.cloud.qualityRating
      : null;

  return (
    <li className="flex flex-col gap-3 border-b border-slate-100 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="truncate font-semibold text-slate-900">{account.name}</span>
          <AccountStatusBadge status={status} />
          {isCloud ? (
            <span className="shrink-0 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-700">
              Official API
            </span>
          ) : null}
          {qualityWarning ? (
            <span
              title="Meta rates this number's quality. A low rating is the warning before it limits how many people you can message."
              className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                qualityWarning === 'RED'
                  ? 'bg-red-50 text-red-700'
                  : 'bg-amber-50 text-amber-700'
              }`}
            >
              Quality {qualityWarning.toLowerCase()}
            </span>
          ) : null}
        </div>
        <p className="truncate text-xs text-slate-400">
          {account.brandKey}
          {isCloud && account.cloud?.displayPhoneNumber
            ? ` · ${account.cloud.displayPhoneNumber}`
            : ''}
        </p>
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
          {canReset ? (
            <ActionButton
              onClick={() => run((token) => resetAccount({ token, accountId: account.id }))}
              disabled={busy}
            >
              Reset
            </ActionButton>
          ) : null}
          {isCloud && account.cloud?.phoneNumberId ? (
            <>
              {/* "Is this still working?" — the only way to find out before a customer does. */}
              <ActionButton
                onClick={() => run((token) => testCloudAccount({ token, accountId: account.id }))}
                disabled={busy}
              >
                Test
              </ActionButton>
              <ActionButton
                onClick={() => run((token) => syncAccountTemplates({ token, accountId: account.id }))}
                disabled={busy}
              >
                Sync templates
              </ActionButton>
            </>
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
