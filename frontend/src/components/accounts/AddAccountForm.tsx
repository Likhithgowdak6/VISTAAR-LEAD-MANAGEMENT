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
  /**
   * Whether this installation can offer the Cloud API at all (WHATSAPP_CLOUD_ENABLED on the
   * server). When false the choice is hidden entirely rather than shown disabled: an option
   * nobody can pick is just a question the admin cannot answer.
   */
  cloudAvailable?: boolean;
};

/**
 * The two ways a number can connect, described in the terms that actually decide which one an
 * owner wants. The 24-hour rule is stated here rather than discovered later, because it is the
 * difference that changes how the inbox works every day.
 */
const PROVIDER_CHOICES = [
  {
    value: 'baileys' as const,
    title: 'Link by QR code',
    summary: 'Scan a QR from WhatsApp on your phone. Free, and you can message anyone, any time.',
    caveat: 'Unofficial. Meta may ban the number, and the phone must stay online.',
  },
  {
    value: 'cloud' as const,
    title: 'Official WhatsApp API',
    summary: "Connect through Meta's hosted API. No phone session to keep connected.",
    caveat:
      'Meta applies messaging policies and usage charges. Approved templates are required outside the 24-hour customer service window.',
  },
];

const AddAccountForm = ({ onCreated, cloudAvailable = false }: Props) => {
  const { authedRequest } = useAuth() as AuthValue;
  const [form, setForm] = useState<AccountForm>({ name: '', brandKey: '', description: '' });
  const [provider, setProvider] = useState<'baileys' | 'cloud'>('baileys');
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
          provider,
        }),
      );
      setForm({ name: '', brandKey: '', description: '' });
      setProvider('baileys');
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

      {cloudAvailable ? (
        <fieldset className="mt-4">
          <legend className="mb-2 text-xs font-medium text-slate-600">How it connects</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {PROVIDER_CHOICES.map((choice) => {
              const selected = provider === choice.value;

              return (
                <label
                  key={choice.value}
                  className={`cursor-pointer rounded-lg border p-3 text-left transition ${
                    selected
                      ? 'border-blue-500 bg-blue-50 ring-1 ring-blue-500'
                      : 'border-slate-200 bg-white hover:border-slate-300'
                  }`}
                >
                  <span className="flex items-start gap-2">
                    <input
                      type="radio"
                      name="acct-provider"
                      value={choice.value}
                      checked={selected}
                      onChange={() => setProvider(choice.value)}
                      className="mt-0.5"
                    />
                    <span>
                      <span className="block text-sm font-semibold text-slate-900">
                        {choice.title}
                      </span>
                      <span className="mt-1 block text-xs text-slate-600">{choice.summary}</span>
                      {/* Stated up front rather than in a tooltip: both of these change how the
                          number behaves every day, and finding out later is expensive. */}
                      <span className="mt-1 block text-xs text-amber-700">{choice.caveat}</span>
                    </span>
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>
      ) : null}

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
