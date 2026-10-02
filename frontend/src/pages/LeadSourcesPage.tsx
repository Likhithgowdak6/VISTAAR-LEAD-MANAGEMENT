import { useCallback, useEffect, useState } from 'react';

import { listAccounts, listLeadSources } from '../api/endpoints';
import { useAuth } from '../auth/AuthContext';
import EmptyState from '../components/EmptyState';
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

/*
 * ONE WAY IN, plus a fallback.
 *
 * The Google Sheet CREATION form is deliberately no longer offered here. Routing lead ads through
 * a spreadsheet was a workaround for not having Meta's API; now that Facebook Login does the job
 * directly, offering the sheet as a peer choice invites people into the slower, lossier path for
 * no reason.
 *
 * Nothing about sheets has been deleted. AddLeadSourceForm still exists, the API still accepts
 * `kind: 'google_sheet'`, the importer still polls, and every sheet source already configured
 * keeps rendering and syncing in the list below - see LeadSourceRow, which still links out to the
 * spreadsheet. This is a change to what is OFFERED, not to what is SUPPORTED.
 *
 * The pasted Page-access-token form stays too, but behind a disclosure: it is the way out when
 * Facebook Login cannot be used (an unpublished app, a Page the signed-in account has no role
 * on), not a second front door.
 */
const LeadSourcesPage = () => {
  const { authedRequest } = useAuth();
  const [leadSources, setLeadSources] = useState<LeadSource[]>([]);
  const [accounts, setAccounts] = useState<WhatsAppAccount[]>([]);
  // Collapsed by default. Open, it would read as "two equal options".
  const [tokenFallbackOpen, setTokenFallbackOpen] = useState(false);
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
          Where your Facebook lead ads reach the CRM. New leads arrive in the inbox as unassigned,
          ready to be picked up — nothing is messaged automatically.
        </p>
      </div>

      {accounts.length === 0 && !loading ? (
        <p className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
          Add a WhatsApp number on the Accounts page first — imported leads need a number to open
          against.
        </p>
      ) : (
        <div className="space-y-3">
          <div className="rounded-xl border border-blue-200 bg-blue-50 p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
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
          </div>

          <div>
            <button
              type="button"
              aria-expanded={tokenFallbackOpen}
              onClick={() => setTokenFallbackOpen((open) => !open)}
              className="text-xs font-medium text-slate-500 underline-offset-2 hover:text-slate-700 hover:underline"
            >
              {tokenFallbackOpen ? 'Hide' : 'Use a Page access token instead'}
            </button>
            {/* Named for when you need it, not for what it is: nobody goes looking for "the
                manual path", they go looking for why Facebook sign-in did not work. */}
            {tokenFallbackOpen ? (
              <div className="mt-2 space-y-2">
                <p className="text-xs text-slate-500">
                  For a Page the signed-in Facebook account has no role on, or while the Meta app
                  is still unpublished.
                </p>
                <AddMetaLeadSourceForm accounts={accounts} onCreated={load} />
              </div>
            ) : null}
          </div>
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
            description="Connect Facebook and pick the lead form your ads point at."
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
