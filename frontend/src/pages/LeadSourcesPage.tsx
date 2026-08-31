import { useCallback, useEffect, useState } from 'react';

import { listAccounts, listLeadSources } from '../api/endpoints';
import { useAuth } from '../auth/AuthContext';
import EmptyState from '../components/EmptyState';
import AddLeadSourceForm from '../components/lead-sources/AddLeadSourceForm';
import AddMetaLeadSourceForm from '../components/lead-sources/AddMetaLeadSourceForm';
import LeadSourceRow from '../components/lead-sources/LeadSourceRow';
import Spinner from '../components/Spinner';
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

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-6">
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
            />
          ))}
        </ul>
      </div>
    </div>
  );
};

export default LeadSourcesPage;
