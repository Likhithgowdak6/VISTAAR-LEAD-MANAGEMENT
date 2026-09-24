import { type ChangeEvent, type FormEvent, useState } from 'react';

import { createUser } from '../../api/endpoints';
import { useAuth } from '../../auth/AuthContext';
import { ASSIGNABLE_ROLES, ROLE_LABELS } from '../../lib/permissions';
import { type AssignableRole } from '../../types';
import { type AuthValue, errorMessage } from '../types';

/** Mirrors PASSWORD_POLICY.MIN_LENGTH in the backend's password.service.ts - change both together. */
const MIN_PASSWORD_LENGTH = 8;

type UserForm = {
  name: string;
  email: string;
  password: string;
  role: AssignableRole;
};

const EMPTY_FORM: UserForm = { name: '', email: '', password: '', role: 'staff' };

type Props = {
  onCreated?: () => void;
};

const AddUserForm = ({ onCreated }: Props) => {
  const { authedRequest } = useAuth() as AuthValue;
  const [form, setForm] = useState<UserForm>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const update =
    (field: keyof UserForm) => (event: ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      setForm((current) => ({
        ...current,
        [field]: field === 'role' ? (event.target.value as AssignableRole) : event.target.value,
      }));

  const passwordTooShort = form.password.length > 0 && form.password.length < MIN_PASSWORD_LENGTH;

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saving) {
      return;
    }
    setSaving(true);
    setError(null);

    try {
      await authedRequest((token) =>
        createUser({
          token,
          name: form.name.trim(),
          email: form.email.trim(),
          password: form.password,
          role: form.role,
          // New teammates must replace the temporary password on first sign-in.
          mustChangePassword: true,
        }),
      );
      setForm(EMPTY_FORM);
      onCreated?.();
    } catch (submitError: unknown) {
      setError(errorMessage(submitError, 'Unable to add team member.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      onSubmit={handleSubmit}
      aria-label="Add team member"
      className="rounded-xl border border-slate-200 bg-white p-4"
    >
      <h3 className="mb-3 text-sm font-semibold text-slate-900">Add a team member</h3>

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor="user-name" className="mb-1 block text-xs font-medium text-slate-600">
            Name
          </label>
          <input
            id="user-name"
            required
            value={form.name}
            onChange={update('name')}
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-blue-500 focus:outline-none"
          />
        </div>
        <div>
          <label htmlFor="user-email" className="mb-1 block text-xs font-medium text-slate-600">
            Email
          </label>
          <input
            id="user-email"
            type="email"
            required
            value={form.email}
            onChange={update('email')}
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-blue-500 focus:outline-none"
          />
        </div>
        <div>
          <label htmlFor="user-password" className="mb-1 block text-xs font-medium text-slate-600">
            Temporary password
          </label>
          <input
            id="user-password"
            type="password"
            required
            minLength={MIN_PASSWORD_LENGTH}
            value={form.password}
            onChange={update('password')}
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-blue-500 focus:outline-none"
          />
          <p className="mt-1 text-xs text-slate-500">
            At least {MIN_PASSWORD_LENGTH} characters. They must change it on first sign-in.
          </p>
        </div>
        <div>
          <label htmlFor="user-role" className="mb-1 block text-xs font-medium text-slate-600">
            Role
          </label>
          <select
            id="user-role"
            value={form.role}
            onChange={update('role')}
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-blue-500 focus:outline-none"
          >
            {ASSIGNABLE_ROLES.map((role) => (
              <option key={role} value={role}>
                {ROLE_LABELS[role]}
              </option>
            ))}
          </select>
        </div>
      </div>

      {error ? (
        <p role="alert" className="mt-2 text-xs text-red-600">
          {error}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={saving || form.name.trim() === '' || form.email.trim() === '' || passwordTooShort}
        className="mt-3 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:bg-blue-300"
      >
        {saving ? 'Adding…' : 'Add member'}
      </button>
    </form>
  );
};

export default AddUserForm;
