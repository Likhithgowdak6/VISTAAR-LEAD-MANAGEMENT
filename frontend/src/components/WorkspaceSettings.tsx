import { useEffect, useState, type FormEvent } from 'react';
import { getWorkspace, updateWorkspace, type WorkspaceDetails } from '../api/endpoints';
import { useAuth } from '../auth/AuthContext';
import { errorMessage } from './types';

export default function WorkspaceSettings({ onNavigate }: {
  onNavigate?: (view: 'team-and-accounts' | 'ai-knowledge') => void;
}) {
  const { authedRequest, applyOrganization } = useAuth();
  const [workspace, setWorkspace] = useState<WorkspaceDetails | null>(null);
  const [name, setName] = useState('');
  const [industry, setIndustry] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const payload = await authedRequest((token) => getWorkspace({ token }));
        if (!active || !payload?.data) return;
        setWorkspace(payload.data);
        setName(payload.data.name);
        setIndustry(payload.data.profile.industry ?? '');
      } catch (err) {
        if (active) setError(errorMessage(err, 'Unable to load workspace.'));
      }
    })();
    return () => { active = false; };
  }, [authedRequest]);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true); setSaved(false); setError(null);
    try {
      const payload = await authedRequest((token) => updateWorkspace({ token, name, industry,
        timezone: workspace?.profile.timezone ?? 'Asia/Kolkata' }));
      if (payload.data) {
        setWorkspace(payload.data);
        applyOrganization?.({ id: payload.data.id, name: payload.data.name, slug: payload.data.slug,
          onboardingRequired: payload.data.plan === 'beta' && !payload.data.onboarding.businessProfile });
      }
      setSaved(true);
    } catch (err) { setError(errorMessage(err, 'Unable to save workspace.')); }
    finally { setSaving(false); }
  };

  if (!workspace && !error) return null;
  return <div className="overflow-hidden rounded-xl border border-slate-200 bg-white p-4">
    <h2 className="text-sm font-bold text-slate-900">Workspace</h2>
    {workspace ? <>
      <p className="mt-1 text-xs text-slate-500">Workspace: {workspace.name}</p>
      <div className="mt-3 grid grid-cols-2 gap-3 text-sm text-slate-600">
        <p>Team: {workspace.usage.users}{workspace.limits ? ` / ${workspace.limits.users}` : ''}</p>
        <p>WhatsApp: {workspace.usage.whatsappAccounts}{workspace.limits ? ` / ${workspace.limits.whatsappAccounts}` : ''}</p>
      </div>
      <p className="mt-2 text-xs text-slate-500">
        {workspace.plan === 'beta' ? 'Beta workspace. No subscription payment is configured.' : 'Existing workspace'}
      </p>
      <form onSubmit={save} aria-label="Workspace settings" className="mt-4 space-y-3">
        <div><label htmlFor="workspace-name" className="mb-1 block text-xs font-medium text-slate-600">Business name</label>
          <input id="workspace-name" required minLength={2} maxLength={120} value={name}
            onChange={(event) => setName(event.target.value)} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" /></div>
        <div><label htmlFor="workspace-industry" className="mb-1 block text-xs font-medium text-slate-600">Industry</label>
          <input id="workspace-industry" maxLength={100} value={industry} placeholder="Photography, events, media..."
            onChange={(event) => setIndustry(event.target.value)} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" /></div>
        <button type="submit" disabled={saving} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:bg-blue-300">
          {saving ? 'Saving...' : 'Save workspace'}
        </button>
        {saved ? <p role="status" className="text-xs text-green-600">Workspace saved.</p> : null}
      </form>
      <div className="mt-4 border-t border-slate-200 pt-3">
        <h3 className="text-xs font-semibold text-slate-600">Getting started</h3>
        <ul className="mt-2 space-y-2 text-xs text-slate-500">
          <li>{workspace.onboarding.businessProfile ? 'Done' : 'Next'}: Add your business name and industry above.</li>
          <li>{workspace.onboarding.whatsappConnected ? 'Done' : 'Next'}: Connect your WhatsApp number using the QR code.
            {onNavigate ? <button type="button" onClick={() => onNavigate('team-and-accounts')} className="ml-2 font-medium text-blue-600">Open accounts</button> : null}</li>
          <li>{workspace.onboarding.knowledgeAdded ? 'Done' : 'Next'}: Add your services, prices, and AI rules.
            {onNavigate ? <button type="button" onClick={() => onNavigate('ai-knowledge')} className="ml-2 font-medium text-blue-600">Open AI knowledge</button> : null}</li>
        </ul>
      </div>
    </> : null}
    {error ? <p role="alert" className="mt-2 text-xs text-red-600">{error}</p> : null}
  </div>;
}
