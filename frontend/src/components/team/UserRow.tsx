import { type ReactNode, useState } from 'react';

import { disableUser, enableUser, resetUserPassword, updateUser } from '../../api/endpoints';
import { useAuth } from '../../auth/AuthContext';
import { hasPermission, PERMISSIONS } from '../../lib/permissions';
import { type AuthValue, type AuthedRequest, errorMessage, type TeamMember } from '../types';
import RoleBadge from './RoleBadge';
import ToggleSwitch from '../ToggleSwitch';

/** Mirrors PASSWORD_POLICY.MIN_LENGTH in the backend's password.service.ts - change both together. */
const MIN_PASSWORD_LENGTH = 8;

type ActionTone = 'default' | 'danger';

type ActionButtonProps = {
  children: ReactNode;
  onClick: () => void;
  tone?: ActionTone;
  disabled?: boolean;
};

const ActionButton = ({ children, onClick, tone = 'default', disabled }: ActionButtonProps) => {
  const tones: Record<ActionTone, string> = {
    default: 'border-slate-300 text-slate-700 hover:bg-slate-50',
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
  user: TeamMember;
  currentUserId?: string | null;
  onChanged?: () => void;
};

const UserRow = ({ user, currentUserId, onChanged }: Props) => {
  const { authedRequest, permissions } = useAuth() as AuthValue;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canManage = hasPermission(permissions, PERMISSIONS.USERS_MANAGE);

  // The API refuses to manage the super admin or the actor themselves; hide those controls
  // rather than offering buttons that are guaranteed to fail.
  const isSelf = user.id === currentUserId;
  const isSuperAdmin = user.role === 'super_admin';
  const showActions = canManage && !isSelf && !isSuperAdmin;
  const phonePermission = PERMISSIONS.CLIENT_PII_REVEAL;
  const allowed = user.permissionOverrides?.allow ?? [];
  const denied = user.permissionOverrides?.deny ?? [];
  // Mirrors the backend defaults for this permission. An explicit deny always wins.
  const canViewPhone = !denied.includes(phonePermission) && (
    allowed.includes(phonePermission) || user.role === 'admin' || user.role === 'super_admin'
  );

  const run = async (makeRequest: Parameters<AuthedRequest>[0]) => {
    setBusy(true);
    setError(null);
    try {
      await authedRequest(makeRequest);
      await onChanged?.();
    } catch (actionError: unknown) {
      setError(errorMessage(actionError, 'Action failed.'));
    } finally {
      setBusy(false);
    }
  };

  const handleResetPassword = () => {
    const password = window.prompt(
      `Set a temporary password for ${user.name} (at least ${MIN_PASSWORD_LENGTH} characters). They must change it on next sign-in.`,
    );

    if (password === null) {
      return;
    }

    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }

    run((token) =>
      resetUserPassword({ token, userId: user.id, password, mustChangePassword: true }),
    );
  };

  const disabled = user.status === 'disabled';

  const setPhoneAccess = (enabled: boolean) => {
    const allow = allowed.filter((permission) => permission !== phonePermission);
    const deny = denied.filter((permission) => permission !== phonePermission);
    if (enabled) allow.push(phonePermission);
    else deny.push(phonePermission);
    run((token) => updateUser({
      token, userId: user.id, permissionOverrides: { allow, deny },
    }));
  };

  return (
    <li className="flex flex-col gap-3 border-b border-slate-100 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="truncate font-semibold text-slate-900">{user.name}</span>
          <RoleBadge role={user.role} />
          {disabled ? (
            <span className="rounded-full bg-red-50 px-2 py-0.5 text-xs font-semibold text-red-600">
              Disabled
            </span>
          ) : null}
          {user.mustChangePassword ? (
            <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs font-semibold text-amber-700">
              Must change password
            </span>
          ) : null}
        </div>
        <p className="truncate text-xs text-slate-400">{user.email}</p>
        {error ? (
          <p role="alert" className="mt-1 text-xs text-red-600">
            {error}
          </p>
        ) : null}
      </div>

      {showActions ? (
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
          <div className="mr-2 flex items-center gap-2">
            <span className="text-xs font-medium text-slate-700">Can view phone numbers</span>
            <ToggleSwitch
              size="sm"
              label={`Can view phone numbers for ${user.name}`}
              checked={canViewPhone}
              disabled={busy}
              onChange={setPhoneAccess}
            />
          </div>
          {disabled ? (
            <ActionButton
              onClick={() => run((token) => enableUser({ token, userId: user.id }))}
              disabled={busy}
            >
              Enable
            </ActionButton>
          ) : (
            <ActionButton
              tone="danger"
              onClick={() => run((token) => disableUser({ token, userId: user.id }))}
              disabled={busy}
            >
              Disable
            </ActionButton>
          )}
          <ActionButton onClick={handleResetPassword} disabled={busy}>
            Reset password
          </ActionButton>
        </div>
      ) : null}
    </li>
  );
};

export default UserRow;
