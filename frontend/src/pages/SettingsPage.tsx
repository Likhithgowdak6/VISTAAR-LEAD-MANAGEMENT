import { type FormEvent, useCallback, useEffect, useState } from 'react';

import { clearTestData, getSettings, getTestModeStatus, updateSettings } from '../api/endpoints';
import { useAuth } from '../auth/AuthContext';
import Spinner from '../components/Spinner';
import { errorMessage } from '../components/types';
import { hasPermission, PERMISSIONS } from '../lib/permissions';

const SettingsPage = () => {
  const { authedRequest, permissions } = useAuth();
  const [ownerWhatsappNumber, setOwnerWhatsappNumber] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canManage = hasPermission(permissions, PERMISSIONS.SETTINGS_MANAGE);

  const [testModeNumbers, setTestModeNumbers] = useState<string[]>([]);
  const [clearing, setClearing] = useState(false);
  const [clearResult, setClearResult] = useState<string | null>(null);
  const [clearError, setClearError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const payload = await authedRequest((token) => getSettings({ token }));
      setOwnerWhatsappNumber(payload.data?.ownerWhatsappNumber ?? '');
      setError(null);
    } catch (loadError: unknown) {
      setError(errorMessage(loadError, 'Unable to load settings.'));
    } finally {
      setLoading(false);
    }
  }, [authedRequest]);

  const loadTestMode = useCallback(async () => {
    try {
      const payload = await authedRequest((token) => getTestModeStatus({ token }));
      setTestModeNumbers(payload.data?.active ? (payload.data.allowedNumbers ?? []) : []);
    } catch {
      // TEST-PHASE ONLY panel: a failed lookup just hides it, no need to surface an error here.
      setTestModeNumbers([]);
    }
  }, [authedRequest]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadTestMode();
  }, [load, loadTestMode]);

  const handleClearTestData = async () => {
    if (clearing) {
      return;
    }

    if (
      !window.confirm(
        'Delete ALL lead and conversation data for this organization (contacts, conversations, ' +
          'messages, drafts, approvals, follow-ups, notes)? This cannot be undone.',
      )
    ) {
      return;
    }

    setClearing(true);
    setClearResult(null);
    setClearError(null);

    try {
      const payload = await authedRequest((token) => clearTestData({ token }));
      const result = payload.data;
      setClearResult(
        result
          ? `Cleared ${result.totalDeleted} document(s). The dashboard is now empty.`
          : 'Cleared.',
      );
    } catch (clearErr: unknown) {
      setClearError(errorMessage(clearErr, 'Unable to clear test data.'));
    } finally {
      setClearing(false);
    }
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saving) {
      return;
    }
    setSaving(true);
    setSaved(false);
    setError(null);

    try {
      const trimmed = ownerWhatsappNumber.trim();
      const payload = await authedRequest((token) =>
        updateSettings({ token, ownerWhatsappNumber: trimmed === '' ? null : trimmed }),
      );
      setOwnerWhatsappNumber(payload.data?.ownerWhatsappNumber ?? '');
      setSaved(true);
    } catch (saveError: unknown) {
      setError(errorMessage(saveError, 'Unable to save settings.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-6">
      <div>
        <h1 className="text-xl font-bold text-slate-900">Settings</h1>
        <p className="mt-1 text-sm text-slate-500">
          Organization-wide settings for the AI sales agent.
        </p>
      </div>

      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
        {loading ? (
          <div className="p-4">
            <Spinner label="Loading settings…" />
          </div>
        ) : (
          <form onSubmit={handleSubmit} aria-label="Owner WhatsApp settings" className="p-4">
            <label
              htmlFor="owner-whatsapp-number"
              className="mb-1 block text-xs font-medium text-slate-600"
            >
              Owner WhatsApp number
            </label>
            <input
              id="owner-whatsapp-number"
              inputMode="tel"
              placeholder="+91 81830 03081"
              disabled={!canManage || saving}
              value={ownerWhatsappNumber}
              onChange={(event) => {
                setOwnerWhatsappNumber(event.target.value);
                setSaved(false);
              }}
              className="w-full max-w-sm rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-blue-500 focus:outline-none disabled:bg-slate-50 disabled:text-slate-500"
            />
            <p className="mt-2 text-xs text-slate-500">
              The phone that receives new-lead alerts, approval cards and escalations, and whose
              replies the AI reads as your decisions. The country code is optional. Leave it empty
              to fall back to the server default.
            </p>
            <p className="mt-1 text-xs text-slate-500">
              A second phone, separate from the one the agent is connected as, keeps the two roles
              apart cleanly. Putting the agent&apos;s own number here also works and is a perfectly
              normal setup when there is only one phone — the agent then writes to its own
              &ldquo;message yourself&rdquo; chat, and you answer it there.
            </p>

            {error ? (
              <p role="alert" className="mt-2 text-xs text-red-600">
                {error}
              </p>
            ) : null}
            {saved && !error ? (
              <p role="status" className="mt-2 text-xs text-green-600">
                Saved.
              </p>
            ) : null}

            {canManage ? (
              <button
                type="submit"
                disabled={saving}
                className="mt-3 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:bg-blue-300"
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
            ) : (
              <p className="mt-3 text-xs text-slate-400">An admin can change this.</p>
            )}
          </form>
        )}
      </div>

      {testModeNumbers.length > 0 ? (
        <div className="overflow-hidden rounded-xl border border-amber-300 bg-amber-50 p-4">
          <h2 className="text-sm font-bold text-amber-900">Test mode — clear test data</h2>
          <p className="mt-1 text-xs text-amber-800">
            WHATSAPP_TEST_ALLOWED_NUMBERS is set to {testModeNumbers.join(', ')}, so every
            inbound message not from that list is already dropped before it reaches the
            dashboard — everything here is test data. This wipes all of it (contacts,
            conversations, messages, drafts, approvals, follow-ups, notes) for a fresh dashboard.
            Remove WHATSAPP_TEST_ALLOWED_NUMBERS before production and this panel disappears.
          </p>

          {canManage ? (
            <button
              type="button"
              onClick={handleClearTestData}
              disabled={clearing}
              className="mt-3 rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-700 disabled:bg-red-300"
            >
              {clearing ? 'Clearing…' : 'Clear all test data'}
            </button>
          ) : null}

          {clearError ? (
            <p role="alert" className="mt-2 text-xs text-red-700">
              {clearError}
            </p>
          ) : null}
          {clearResult && !clearError ? (
            <p role="status" className="mt-2 text-xs text-green-700">
              {clearResult}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
};

export default SettingsPage;
