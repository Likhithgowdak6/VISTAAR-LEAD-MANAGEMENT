import { useCallback, useEffect, useState } from 'react';

import { listAccounts, listLeadSources } from '../api/endpoints';
import { useAuth } from '../auth/AuthContext';
import EmptyState from '../components/EmptyState';
import AddLeadSourceForm from '../components/lead-sources/AddLeadSourceForm';
import AddMetaLeadSourceForm from '../components/lead-sources/AddMetaLeadSourceForm';
import LeadSourceRow from '../components/lead-sources/LeadSourceRow';
import MetaConnectWizard from '../components/lead-sources/meta/MetaConnectWizard';
import Spinner from '../components/Spinner';
import {
  clearMetaConnectReturn,
  readMetaConnectReturn,
  type MetaConnectReturn,
} from '../lib/meta-connect';
import { type LeadSource, type WhatsAppAccount } from '../components/types';

type SourceKindTab = 'google_sheet' | 'meta_lead_ads';

const TAB_BUTTON_CLASS =
  'rounded-lg px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-50';

const LeadSourcesPage = () => {
  const { authedRequest } = useAuth();
  const [leadSources, setLeadSources] = useState<LeadSource[]>([]);
  const [accounts, setAccounts] = useState<WhatsAppAccount[]>([]);
  // The sheet importer stays the default tab: it is what every existing install uses, and
  // switching the default would move an admin's furniture for no reason.
  const [sourceKind, setSourceKind] = useState<SourceKindTab>('google_sheet');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Read once, on the first render, and wiped from the address bar immediately - otherwise a
  // refresh would reopen the wizard on a "connected" that happened an hour ago.
  const [metaReturn] = useState<MetaConnectReturn | null>(() => readMetaConnectReturn());
  const [wizardOpen, setWizardOpen] = useState(() => readMetaConnectReturn() !== null);
  // Distinguishes "add a form" (skip ahead if Facebook is already connected) from "reconnect"
  // (hold on step one, which is the button they asked for).
  const [wizardAtConnect, setWizardAtConnect] = useState(false);

  const load = useCallback(async () => {
    try {
      const [sourcesPayload, accountsPayload] = await Promise.all([
        authedRequest((token) => listLeadSources({ token })),
        authedRequest((token) => listAccounts({ token })),
      ]);

      setLeadSources(sourcesPayload.data ?? []);
      // A removed number can't receive new leads, so it is not offered as a destination.
      setAccounts((accountsPayload.data ?? []).filter((account) => account.status !== 'removed'));
      setError(null);
    } catch (loadError: unknown) {
      setError(loadError instanceof Error ? loadError.message : 'Unable to load lead sources.');
    } finally {
      setLoading(false);
    }
  }, [authedRequest]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  useEffect(() => {
    clearMetaConnectReturn();
  }, []);

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-4 sm:p-6">
      <div>
        <h1 className="text-xl font-bold text-slate-900">Lead sources</h1>
        <p className="mt-1 text-sm text-slate-500">
          Where Meta lead ads reach the CRM: straight from the Meta Lead Ads API, or from a Google
          Sheet the ads write into. New leads arrive in the inbox as unassigned, ready to be picked
          up — nothing is messaged automatically.
        </p>
      </div>

      {accounts.length === 0 && !loading ? (
        <p className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
          Add a WhatsApp number on the Accounts page first — imported leads need a number to open
          against.
        </p>
      ) : (
        <div className="space-y-3">
          {/* The recommended route, above the tabs rather than inside them: signing in with
              Facebook and pasting a Page token are not two flavours of the same task, and the
              one that needs no token should not be something you have to find. */}
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-blue-200 bg-blue-50 p-4">
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-slate-900">Connect Facebook leads</h3>
              <p className="mt-0.5 text-xs text-slate-600">
                Sign in with Facebook and pick your lead form. Nothing to copy or paste.
              </p>
            </div>
            <button
              type="button"
              onClick={() => {
                setWizardAtConnect(false);
                setWizardOpen(true);
              }}
              className="shrink-0 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700"
            >
              Connect Facebook
            </button>
          </div>

          <div role="tablist" aria-label="Lead source type" className="flex gap-2">
            <button
              type="button"
              role="tab"
              aria-selected={sourceKind === 'google_sheet'}
              onClick={() => setSourceKind('google_sheet')}
              className={`${TAB_BUTTON_CLASS} ${
                sourceKind === 'google_sheet'
                  ? 'bg-blue-600 text-white'
                  : 'border border-slate-300 text-slate-700 hover:bg-slate-50'
              }`}
            >
              Google Sheet
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={sourceKind === 'meta_lead_ads'}
              onClick={() => setSourceKind('meta_lead_ads')}
              className={`${TAB_BUTTON_CLASS} ${
                sourceKind === 'meta_lead_ads'
                  ? 'bg-blue-600 text-white'
                  : 'border border-slate-300 text-slate-700 hover:bg-slate-50'
              }`}
            >
              Meta Lead Ads
            </button>
          </div>

          {sourceKind === 'meta_lead_ads' ? (
            <AddMetaLeadSourceForm accounts={accounts} onCreated={load} />
          ) : (
            <AddLeadSourceForm accounts={accounts} onCreated={load} />
          )}
        </div>
      )}

      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
        {loading ? (
          <div className="p-4">
            <Spinner label="Loading lead sources…" />
          </div>
        ) : null}
        {error ? (
          <p role="alert" className="p-4 text-sm text-red-600">
            {error}
          </p>
        ) : null}
        {!loading && leadSources.length === 0 ? (
          <EmptyState
            title="No lead sources yet"
            description="Connect your Meta lead form, or the sheet your lead ads write to."
          />
        ) : null}
        <ul>
          {leadSources.map((leadSource) => (
            <LeadSourceRow
              key={leadSource.id}
              leadSource={leadSource}
              accounts={accounts}
              onChanged={load}
              onReconnectMeta={() => {
                setWizardAtConnect(true);
                setWizardOpen(true);
              }}
            />
          ))}
        </ul>
      </div>

      {wizardOpen ? (
        <MetaConnectWizard
          accounts={accounts}
          returned={metaReturn}
          startAtConnect={wizardAtConnect}
          onClose={() => setWizardOpen(false)}
          onCreated={load}
        />
      ) : null}
    </div>
  );
};

export default LeadSourcesPage;
