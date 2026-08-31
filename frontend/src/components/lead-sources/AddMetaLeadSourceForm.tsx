import { type FormEvent, useState } from 'react';

import {
  createMetaLeadSource,
  listMetaLeadForms,
  testMetaLeadSourceConnection,
} from '../../api/endpoints';
import { useAuth } from '../../auth/AuthContext';
import {
  type AuthValue,
  errorMessage,
  type MetaLeadFormSummary,
  type MetaPageSummary,
  type WhatsAppAccount,
} from '../types';

type Props = {
  accounts: readonly WhatsAppAccount[];
  onCreated?: () => void;
};

/** Sentinel for the "every form on this page" option; the API takes null for it. */
const ALL_FORMS = '__all__';

const inputClass =
  'w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-blue-500 focus:outline-none';

/**
 * Paste a Page access token → test it → pick the page and the form from what came back → save.
 *
 * The token is held in component state only long enough to be tested and then submitted; it is
 * cleared the moment the source is created, and no endpoint ever gives it back. The page and form
 * pickers exist so nobody has to hand-copy a seventeen-digit id out of Meta's Business Suite.
 */
const AddMetaLeadSourceForm = ({ accounts, onCreated }: Props) => {
  const { authedRequest } = useAuth() as AuthValue;
  const [name, setName] = useState('');
  const [accessToken, setAccessToken] = useState('');
  const [pages, setPages] = useState<MetaPageSummary[]>([]);
  const [pageId, setPageId] = useState('');
  const [forms, setForms] = useState<MetaLeadFormSummary[]>([]);
  const [formId, setFormId] = useState(ALL_FORMS);
  const [whatsappAccountId, setWhatsappAccountId] = useState('');
  const [defaultCountryCode, setDefaultCountryCode] = useState('91');
  const [aiContextEnabled, setAiContextEnabled] = useState(false);
  const [importExisting, setImportExisting] = useState(false);
  const [testing, setTesting] = useState(false);
  const [tested, setTested] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedAccountId = whatsappAccountId || (accounts[0]?.id ?? '');
  const selectedPage = pages.find((page) => page.id === pageId) ?? null;
  const selectedForm = forms.find((form) => form.id === formId) ?? null;
  const isComplete = name.trim() !== '' && tested && pageId !== '' && selectedAccountId !== '';

  const loadForms = async (nextPageId: string) => {
    setPageId(nextPageId);
    setFormId(ALL_FORMS);
    setForms([]);

    if (nextPageId === '') {
      return;
    }

    try {
      const payload = await authedRequest((token) =>
        listMetaLeadForms({ token, accessToken: accessToken.trim(), pageId: nextPageId }),
      );

      setForms(payload.data ?? []);
    } catch (formsError: unknown) {
      // Not fatal: the source can still be saved as "every form on this page".
      setError(errorMessage(formsError, 'Could not list the forms on that page.'));
    }
  };

  const handleTest = async () => {
    if (testing || accessToken.trim() === '') {
      return;
    }

    setTesting(true);
    setError(null);

    try {
      const payload = await authedRequest((token) =>
        testMetaLeadSourceConnection({ token, accessToken: accessToken.trim() }),
      );

      const foundPages = payload.data?.pages ?? [];

      setPages(foundPages);
      setTested(true);

      // One page is the normal case for a Page access token — select it and fetch its forms
      // rather than making the admin choose from a list of one.
      if (foundPages.length === 1 && foundPages[0]) {
        await loadForms(foundPages[0].id);
      }
    } catch (testError: unknown) {
      setTested(false);
      setPages([]);
      setError(errorMessage(testError, 'Meta rejected that token.'));
    } finally {
      setTesting(false);
    }
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saving || !isComplete) {
      return;
    }

    setSaving(true);
    setError(null);

    try {
      await authedRequest((token) =>
        createMetaLeadSource({
          token,
          name: name.trim(),
          accessToken: accessToken.trim(),
          pageId,
          pageName: selectedPage?.name ?? null,
          formId: formId === ALL_FORMS ? null : formId,
          formName: formId === ALL_FORMS ? null : (selectedForm?.name ?? null),
          whatsappAccountId: selectedAccountId,
          defaultCountryCode: defaultCountryCode.trim(),
          aiContextEnabled,
          importExisting,
        }),
      );

      setName('');
      setAccessToken('');
      setPages([]);
      setPageId('');
      setForms([]);
      setFormId(ALL_FORMS);
      setTested(false);
      setAiContextEnabled(false);
      setImportExisting(false);
      onCreated?.();
    } catch (submitError: unknown) {
      setError(errorMessage(submitError, 'Unable to connect the Meta form.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      onSubmit={handleSubmit}
      aria-label="Connect a Meta lead form"
      className="rounded-xl border border-slate-200 bg-white p-4"
    >
      <h3 className="mb-3 text-sm font-semibold text-slate-900">Connect Meta Lead Ads</h3>

      <div className="space-y-3">
        <div>
          <label htmlFor="meta-source-name" className="mb-1 block text-xs font-medium text-slate-600">
            Name
          </label>
          <input
            id="meta-source-name"
            required
            placeholder="Meta wedding leads"
            value={name}
            onChange={(event) => setName(event.target.value)}
            className={inputClass}
          />
        </div>

        <div>
          <label htmlFor="meta-source-token" className="mb-1 block text-xs font-medium text-slate-600">
            Page access token
          </label>
          <div className="flex gap-2">
            <input
              id="meta-source-token"
              required
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder="Paste the Page access token"
              value={accessToken}
              onChange={(event) => {
                setAccessToken(event.target.value);
                setTested(false);
              }}
              className={inputClass}
            />
            <button
              type="button"
              onClick={handleTest}
              disabled={testing || accessToken.trim() === ''}
              className="shrink-0 rounded-lg border border-slate-300 px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            >
              {testing ? 'Testing…' : 'Test connection'}
            </button>
          </div>
          <p className="mt-1 text-[11px] text-slate-400">
            The token is stored encrypted and is never shown again. It needs the{' '}
            <code>leads_retrieval</code>, <code>pages_show_list</code> and{' '}
            <code>pages_read_engagement</code> permissions.
          </p>
        </div>

        {tested ? (
          <p role="status" className="rounded-lg bg-emerald-50 px-2 py-1.5 text-xs text-emerald-700">
            Token accepted — {pages.length} page{pages.length === 1 ? '' : 's'} available.
          </p>
        ) : null}

        {tested ? (
          <div className="flex gap-3">
            <div className="flex-1">
              <label htmlFor="meta-source-page" className="mb-1 block text-xs font-medium text-slate-600">
                Facebook page
              </label>
              <select
                id="meta-source-page"
                value={pageId}
                onChange={(event) => {
                  void loadForms(event.target.value);
                }}
                className={inputClass}
              >
                <option value="">Choose a page…</option>
                {pages.map((page) => (
                  <option key={page.id} value={page.id}>
                    {page.name ?? page.id}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex-1">
              <label htmlFor="meta-source-form" className="mb-1 block text-xs font-medium text-slate-600">
                Lead form
              </label>
              <select
                id="meta-source-form"
                value={formId}
                onChange={(event) => setFormId(event.target.value)}
                className={inputClass}
              >
                <option value={ALL_FORMS}>Every form on this page</option>
                {forms.map((form) => (
                  <option key={form.id} value={form.id}>
                    {form.name ?? form.id}
                    {form.status && form.status !== 'ACTIVE' ? ` (${form.status.toLowerCase()})` : ''}
                  </option>
                ))}
              </select>
            </div>
          </div>
        ) : null}

        <div className="flex gap-3">
          <div className="flex-1">
            <label
              htmlFor="meta-source-account"
              className="mb-1 block text-xs font-medium text-slate-600"
            >
              WhatsApp number for new leads
            </label>
            <select
              id="meta-source-account"
              value={selectedAccountId}
              onChange={(event) => setWhatsappAccountId(event.target.value)}
              className={inputClass}
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
              htmlFor="meta-source-country"
              className="mb-1 block text-xs font-medium text-slate-600"
            >
              Country code
            </label>
            <input
              id="meta-source-country"
              required
              value={defaultCountryCode}
              onChange={(event) => setDefaultCountryCode(event.target.value)}
              className={inputClass}
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
            Import every lead the form has ever collected.
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
        {saving ? 'Connecting…' : 'Connect Meta form'}
      </button>
    </form>
  );
};

export default AddMetaLeadSourceForm;
