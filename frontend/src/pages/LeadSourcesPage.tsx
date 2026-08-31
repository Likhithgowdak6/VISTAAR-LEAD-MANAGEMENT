import { useCallback, useEffect, useState } from 'react';

import { listAccounts, listLeadSources } from '../api/endpoints';
import { useAuth } from '../auth/AuthContext';
import EmptyState from '../components/EmptyState';
import AddLeadSourceForm from '../components/lead-sources/AddLeadSourceForm';
import LeadSourceRow from '../components/lead-sources/LeadSourceRow';
import Spinner from '../components/Spinner';
import { type LeadSource, type WhatsAppAccount } from '../components/types';

const LeadSourcesPage = () => {
  const { authedRequest } = useAuth();
  const [leadSources, setLeadSources] = useState<LeadSource[]>([]);
  const [accounts, setAccounts] = useState<WhatsAppAccount[]>([]);
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
          Google Sheets that Meta lead ads write into. New rows arrive in the inbox as unassigned
          leads, ready to be picked up — nothing is messaged automatically.
        </p>
      </div>

      {accounts.length === 0 && !loading ? (
        <p className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
          Add a WhatsApp number on the Accounts page first — imported leads need a number to open
          against.
        </p>
      ) : (
        <AddLeadSourceForm accounts={accounts} onCreated={load} />
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
            description="Connect the sheet your Meta lead ads write to."
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
