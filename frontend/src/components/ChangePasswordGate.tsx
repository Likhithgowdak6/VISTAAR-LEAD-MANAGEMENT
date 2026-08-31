import { type ChangeEvent, type FormEvent, useState } from 'react';

import { changePassword } from '../api/endpoints';
import { useAuth } from '../auth/AuthContext';
import { type AuthUser, type AuthValue, errorMessage } from './types';

const MIN_PASSWORD_LENGTH = 12;

type PasswordForm = {
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
};

type PasswordField = keyof PasswordForm;

/**
 * Shown instead of the app while `user.mustChangePassword` is set, so an admin-assigned
 * temporary password cannot stay in use. The backend enforces the same rule (every product
 * route returns 403 PASSWORD_CHANGE_REQUIRED until this is satisfied).
 */
const ChangePasswordGate = () => {
  const { authedRequest, applyUser, logout, user } = useAuth() as AuthValue;
  const [form, setForm] = useState<PasswordForm>({
    currentPassword: '',
    newPassword: '',
    confirmPassword: '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const update = (field: PasswordField) => (event: ChangeEvent<HTMLInputElement>) =>
    setForm((current) => ({ ...current, [field]: event.target.value }));

  const mismatch = form.confirmPassword.length > 0 && form.newPassword !== form.confirmPassword;
  const tooShort = form.newPassword.length > 0 && form.newPassword.length < MIN_PASSWORD_LENGTH;

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (saving || mismatch || tooShort) {
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

      applyUser((payload?.data?.user as AuthUser | null | undefined) ?? null);
    } catch (submitError: unknown) {
      setError(errorMessage(submitError, 'Unable to change the password.'));
      setSaving(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-100 p-4">
      <form
        onSubmit={handleSubmit}
        aria-label="Change your password"
        className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-sm"
      >
        <h1 className="text-lg font-bold text-slate-900">Choose a new password</h1>
        <p className="mt-1 text-sm text-slate-500">
          {user?.name ? `Hi ${user.name}. ` : ''}
          Your account uses a temporary password. Set your own to continue.
        </p>

        <div className="mt-4 space-y-3">
          <div>
            <label
              htmlFor="current-password"
              className="mb-1 block text-xs font-medium text-slate-600"
            >
              Current (temporary) password
            </label>
            <input
              id="current-password"
              type="password"
              required
              value={form.currentPassword}
              onChange={update('currentPassword')}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-blue-500 focus:outline-none"
            />
          </div>

          <div>
            <label htmlFor="new-password" className="mb-1 block text-xs font-medium text-slate-600">
              New password
            </label>
            <input
              id="new-password"
              type="password"
              required
              minLength={MIN_PASSWORD_LENGTH}
              value={form.newPassword}
              onChange={update('newPassword')}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-blue-500 focus:outline-none"
            />
            <p className="mt-1 text-xs text-slate-500">
              At least {MIN_PASSWORD_LENGTH} characters.
            </p>
          </div>

          <div>
            <label
              htmlFor="confirm-password"
              className="mb-1 block text-xs font-medium text-slate-600"
            >
              Confirm new password
            </label>
            <input
              id="confirm-password"
              type="password"
              required
              value={form.confirmPassword}
              onChange={update('confirmPassword')}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-blue-500 focus:outline-none"
            />
            {mismatch ? <p className="mt-1 text-xs text-red-600">Passwords do not match.</p> : null}
          </div>
        </div>

        {error ? (
          <p role="alert" className="mt-3 text-sm text-red-600">
            {error}
          </p>
        ) : null}

        <button
          type="submit"
          disabled={saving || mismatch || tooShort || form.currentPassword === ''}
          className="mt-4 w-full rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:bg-blue-300"
        >
          {saving ? 'Saving…' : 'Set password and continue'}
        </button>

        <button
          type="button"
          onClick={logout}
          className="mt-2 w-full rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
        >
          Sign out
        </button>
      </form>
    </div>
  );
};

export default ChangePasswordGate;
