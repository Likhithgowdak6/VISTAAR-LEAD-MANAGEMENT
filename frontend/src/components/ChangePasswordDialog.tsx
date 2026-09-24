import { type ChangeEvent, type FormEvent, useState } from 'react';

import { changePassword } from '../api/endpoints';
import { useAuth } from '../auth/AuthContext';
import { type AuthUser, type AuthValue, errorMessage } from './types';

/** Mirrors PASSWORD_POLICY.MIN_LENGTH in the backend's password.service.ts - change both together. */
const MIN_PASSWORD_LENGTH = 8;

type Props = {
  onClose: () => void;
};

type PasswordForm = {
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
};

type PasswordField = keyof PasswordForm;

/**
 * Changing your own password, any time, from the header.
 *
 * Distinct from ChangePasswordGate, which REPLACES the whole app while a temporary password is
 * still in force and cannot be dismissed. This one is voluntary and closable, so it is a dialog.
 *
 * It exists because the Team page deliberately hides every action on your own row and on any
 * super-admin row (`showActions = canManage && !isSelf && !isSuperAdmin` in UserRow) - sensible
 * for stopping an admin locking themselves out or editing a super admin, but it left the owner
 * with no route to his own password except a mongosh command. Anyone can reach this one: it is
 * your own credential, so it needs no permission beyond being signed in.
 */
const ChangePasswordDialog = ({ onClose }: Props) => {
  const { authedRequest, applyUser } = useAuth() as AuthValue;
  const [form, setForm] = useState<PasswordForm>({
    currentPassword: '',
    newPassword: '',
    confirmPassword: '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const update = (field: PasswordField) => (event: ChangeEvent<HTMLInputElement>) =>
    setForm((current) => ({ ...current, [field]: event.target.value }));

  const mismatch = form.confirmPassword.length > 0 && form.newPassword !== form.confirmPassword;
  const tooShort = form.newPassword.length > 0 && form.newPassword.length < MIN_PASSWORD_LENGTH;
  const reused = form.newPassword.length > 0 && form.newPassword === form.currentPassword;

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (saving || mismatch || tooShort || reused) {
      return;
    }

    setSaving(true);
    setError(null);

    try {
      const payload = await authedRequest((token) =>
        changePassword({
          token,
          currentPassword: form.currentPassword,
          newPassword: form.newPassword,
        }),
      );

      // The response carries the refreshed user, including mustChangePassword now being false -
      // without applying it, an owner who arrived here from the forced-change flow would still
      // be gated on the next render.
      applyUser((payload?.data?.user as AuthUser | null | undefined) ?? null);
      setDone(true);
    } catch (submitError: unknown) {
      setError(errorMessage(submitError, 'Unable to change the password.'));
    } finally {
      setSaving(false);
    }
  };

  const inputClass =
    'w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-blue-500 focus:outline-none';
  const labelClass = 'mb-1 block text-xs font-medium text-slate-600';

  if (done) {
    return (
      <div
        role="dialog"
        aria-label="Password changed"
        className="fixed inset-0 z-20 flex items-center justify-center bg-slate-900/40 p-4"
      >
        <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-xl">
          <h3 className="text-base font-semibold text-slate-900">Password changed</h3>
          <p className="mt-2 text-sm text-slate-600">
            Use the new one next time you sign in. Sessions already open elsewhere are not signed
            out.
          </p>
          <button
            type="button"
            onClick={onClose}
            className="mt-5 w-full rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700"
          >
            Done
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      role="dialog"
      aria-label="Change your password"
      className="fixed inset-0 z-20 flex items-center justify-center bg-slate-900/40 p-4"
    >
      <form onSubmit={handleSubmit} className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-xl">
        <h3 className="text-base font-semibold text-slate-900">Change your password</h3>

        <div className="mt-4 space-y-3">
          <div>
            <label htmlFor="cpd-current" className={labelClass}>
              Current password
            </label>
            <input
              id="cpd-current"
              type="password"
              required
              autoComplete="current-password"
              value={form.currentPassword}
              onChange={update('currentPassword')}
              disabled={saving}
              className={inputClass}
            />
          </div>

          <div>
            <label htmlFor="cpd-new" className={labelClass}>
              New password
            </label>
            <input
              id="cpd-new"
              type="password"
              required
              autoComplete="new-password"
              minLength={MIN_PASSWORD_LENGTH}
              value={form.newPassword}
              onChange={update('newPassword')}
              disabled={saving}
              className={inputClass}
            />
            <p className="mt-1 text-xs text-slate-500">At least {MIN_PASSWORD_LENGTH} characters.</p>
            {reused ? (
              <p className="mt-1 text-xs text-red-600">
                That is your current password. Choose a different one.
              </p>
            ) : null}
          </div>

          <div>
            <label htmlFor="cpd-confirm" className={labelClass}>
              Confirm new password
            </label>
            <input
              id="cpd-confirm"
              type="password"
              required
              autoComplete="new-password"
              value={form.confirmPassword}
              onChange={update('confirmPassword')}
              disabled={saving}
              className={inputClass}
            />
            {mismatch ? <p className="mt-1 text-xs text-red-600">Passwords do not match.</p> : null}
          </div>
        </div>

        {error ? (
          <p role="alert" className="mt-3 text-sm text-red-600">
            {error}
          </p>
        ) : null}

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={saving || mismatch || tooShort || reused || form.currentPassword === ''}
            className="rounded-lg border border-blue-600 bg-blue-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Change password'}
          </button>
        </div>
      </form>
    </div>
  );
};

export default ChangePasswordDialog;
