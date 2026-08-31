import { type ChangeEvent, type FormEvent, useState } from 'react';

import { createAccount } from '../../api/endpoints';
import { useAuth } from '../../auth/AuthContext';
import { type AuthValue, errorMessage } from '../types';

const toBrandKey = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

type AccountForm = {
  name: string;
  brandKey: string;
  description: string;
};

type Props = {
  onCreated?: () => void;
};

const AddAccountForm = ({ onCreated }: Props) => {
  const { authedRequest } = useAuth() as AuthValue;
  const [form, setForm] = useState<AccountForm>({ name: '', brandKey: '', description: '' });
  const [brandKeyTouched, setBrandKeyTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const updateName = (event: ChangeEvent<HTMLInputElement>) => {
    const name = event.target.value;
    setForm((current) => ({
      ...current,
      name,
      brandKey: brandKeyTouched ? current.brandKey : toBrandKey(name),
    }));
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saving) {
      return;
    }
    setSaving(true);
    setError(null);

    try {
      await authedRequest((token) =>
        createAccount({
          token,
          name: form.name.trim(),
          brandKey: toBrandKey(form.brandKey || form.name),
          description: form.description.trim() || undefined,
        }),
      );
      setForm({ name: '', brandKey: '', description: '' });
      setBrandKeyTouched(false);
      onCreated?.();
    } catch (submitError: unknown) {
      setError(errorMessage(submitError, 'Unable to add account.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      onSubmit={handleSubmit}
      aria-label="Add WhatsApp number"
      className="rounded-xl border border-slate-200 bg-white p-4"
    >
      <h3 className="mb-3 text-sm font-semibold text-slate-900">Add a WhatsApp number</h3>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor="acct-name" className="mb-1 block text-xs font-medium text-slate-600">
            Name
          </label>
          <input
            id="acct-name"
            required
            value={form.name}
            onChange={updateName}
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-blue-500 focus:outline-none"
          />
        </div>
        <div>
          <label htmlFor="acct-brand" className="mb-1 block text-xs font-medium text-slate-600">
            Brand key
          </label>
          <input
            id="acct-brand"
            required
            value={form.brandKey}
            onChange={(event) => {
              setBrandKeyTouched(true);
              setForm((current) => ({ ...current, brandKey: event.target.value }));
            }}
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-blue-500 focus:outline-none"
          />
        </div>
      </div>

      {error ? (
        <p role="alert" className="mt-2 text-xs text-red-600">
          {error}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={saving || form.name.trim() === ''}
        className="mt-3 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:bg-blue-300"
      >
        {saving ? 'Adding…' : 'Add number'}
      </button>
    </form>
  );
};

export default AddAccountForm;
