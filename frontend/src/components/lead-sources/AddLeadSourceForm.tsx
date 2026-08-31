import { type FormEvent, useState } from 'react';

import { createLeadSource } from '../../api/endpoints';
import { useAuth } from '../../auth/AuthContext';
import { type AuthValue, errorMessage, type WhatsAppAccount } from '../types';

type Props = {
  accounts: readonly WhatsAppAccount[];
  onCreated?: () => void;
};

const AddLeadSourceForm = ({ accounts, onCreated }: Props) => {
  const { authedRequest } = useAuth() as AuthValue;
  const [name, setName] = useState('');
  const [sheetUrl, setSheetUrl] = useState('');
  const [whatsappAccountId, setWhatsappAccountId] = useState('');
  const [defaultCountryCode, setDefaultCountryCode] = useState('91');
  const [aiContextEnabled, setAiContextEnabled] = useState(false);
  const [importExisting, setImportExisting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedAccountId = whatsappAccountId || (accounts[0]?.id ?? '');
  const isComplete = name.trim() !== '' && sheetUrl.trim() !== '' && selectedAccountId !== '';

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saving || !isComplete) {
      return;
    }

    setSaving(true);
    setError(null);

    try {
      await authedRequest((token) =>
        createLeadSource({
          token,
          name: name.trim(),
          sheetUrl: sheetUrl.trim(),
          whatsappAccountId: selectedAccountId,
          defaultCountryCode: defaultCountryCode.trim(),
          aiContextEnabled,
          importExisting,
        }),
      );
      setName('');
      setSheetUrl('');
      setAiContextEnabled(false);
      setImportExisting(false);
      onCreated?.();
    } catch (submitError: unknown) {
      setError(errorMessage(submitError, 'Unable to connect the sheet.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      onSubmit={handleSubmit}
      aria-label="Connect a lead sheet"
      className="rounded-xl border border-slate-200 bg-white p-4"
    >
      <h3 className="mb-3 text-sm font-semibold text-slate-900">Connect a sheet</h3>

      <div className="space-y-3">
        <div>
          <label htmlFor="lead-source-name" className="mb-1 block text-xs font-medium text-slate-600">
            Name
          </label>
          <input
            id="lead-source-name"
            required
            placeholder="Meta wedding leads"
            value={name}
            onChange={(event) => setName(event.target.value)}
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-blue-500 focus:outline-none"
          />
        </div>

        <div>
          <label htmlFor="lead-source-url" className="mb-1 block text-xs font-medium text-slate-600">
            Google Sheet link
          </label>
          <input
            id="lead-source-url"
            required
            type="url"
            placeholder="https://docs.google.com/spreadsheets/d/…"
            value={sheetUrl}
            onChange={(event) => setSheetUrl(event.target.value)}
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-blue-500 focus:outline-none"
          />
          <p className="mt-1 text-[11px] text-slate-400">
            Share the sheet as “anyone with the link can view”, then paste the link. Include the
            tab’s <code>#gid=</code> if the leads are not on the first tab.
          </p>
        </div>

        <div className="flex gap-3">
          <div className="flex-1">
            <label
              htmlFor="lead-source-account"
              className="mb-1 block text-xs font-medium text-slate-600"
            >
              WhatsApp number for new leads
            </label>
            <select
              id="lead-source-account"
              value={selectedAccountId}
              onChange={(event) => setWhatsappAccountId(event.target.value)}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-blue-500 focus:outline-none"
            >
              {accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.name}
                </option>
              ))}
            </select>
          </div>

          <div className="w-32">
            <label
              htmlFor="lead-source-country"
              className="mb-1 block text-xs font-medium text-slate-600"
            >
              Country code
            </label>
            <input
              id="lead-source-country"
              required
              value={defaultCountryCode}
              onChange={(event) => setDefaultCountryCode(event.target.value)}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-blue-500 focus:outline-none"
            />
          </div>
        </div>

        <label className="flex items-start gap-2 text-xs text-slate-600">
          <input
            type="checkbox"
            checked={importExisting}
            onChange={(event) => setImportExisting(event.target.checked)}
            className="mt-0.5"
          />
          <span>
            Import every row already in the sheet.
            <span className="block text-slate-400">
              Off by default — otherwise only leads submitted from now on are imported.
            </span>
          </span>
        </label>

        <label className="flex items-start gap-2 text-xs text-slate-600">
          <input
            type="checkbox"
            checked={aiContextEnabled}
            onChange={(event) => setAiContextEnabled(event.target.checked)}
            className="mt-0.5"
          />
          <span>
            Let AI drafts use the form answers.
            <span className="block text-slate-400">
              Sends answers like event type and date to the AI provider. Name, email and phone are
              never included.
            </span>
          </span>
        </label>
      </div>

      {error ? (
        <p role="alert" className="mt-2 text-xs text-red-600">
          {error}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={saving || !isComplete}
        className="mt-3 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:bg-blue-300"
      >
        {saving ? 'Connecting…' : 'Connect sheet'}
      </button>
    </form>
  );
};

export default AddLeadSourceForm;
