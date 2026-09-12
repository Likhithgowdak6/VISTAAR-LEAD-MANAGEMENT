import { useCallback, useEffect, useState } from 'react';

import { deleteTemplate, listTemplates } from '../api/endpoints';
import { useAuth } from '../auth/AuthContext';
import EmptyState from '../components/EmptyState';
import Spinner from '../components/Spinner';
import TemplateGenerateDialog from '../components/templates/TemplateGenerateDialog';
import { type AuthValue, errorMessage } from '../components/types';
import { hasPermission, PERMISSIONS } from '../lib/permissions';
import { type MessageTemplate } from '../types';

const TemplatesPage = () => {
  const { authedRequest, permissions } = useAuth() as AuthValue;
  const [templates, setTemplates] = useState<MessageTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [seedDetails, setSeedDetails] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const canManage = hasPermission(permissions, PERMISSIONS.TEMPLATES_MANAGE);

  const load = useCallback(async () => {
    try {
      const payload = await authedRequest((token) => listTemplates({ token }));
      setTemplates(payload.data ?? []);
      setError(null);
    } catch (loadError: unknown) {
      setError(errorMessage(loadError, 'Unable to load templates.'));
    } finally {
      setLoading(false);
    }
  }, [authedRequest]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  const handleDelete = async (template: MessageTemplate) => {
    if (busyId || !window.confirm(`Delete "${template.title}"?`)) {
      return;
    }

    setBusyId(template.id);
    setError(null);

    try {
      await authedRequest((token) => deleteTemplate({ token, templateId: template.id }));
      await load();
    } catch (deleteError: unknown) {
      setError(errorMessage(deleteError, 'Unable to delete that template.'));
    } finally {
      setBusyId(null);
    }
  };

  const openFresh = () => {
    setSeedDetails('');
    setDialogOpen(true);
  };

  /** Same numbers, four new ways of putting them. */
  const openLike = (template: MessageTemplate) => {
    setSeedDetails(template.sourceDetails || template.body);
    setDialogOpen(true);
  };

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-4 sm:p-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-xl font-bold text-slate-900">Templates</h1>
          <p className="mt-1 text-sm text-slate-500">
            Price messages written up ready to send. Pick one from the reply box in any
            conversation.
          </p>
        </div>

        {canManage ? (
          <button
            type="button"
            onClick={openFresh}
            className="btn-key shrink-0 rounded-lg px-4 py-2 text-sm"
          >
            New price template
          </button>
        ) : null}
      </div>

      {dialogOpen ? (
        <TemplateGenerateDialog
          initialDetails={seedDetails}
          onClose={() => setDialogOpen(false)}
          onSaved={load}
        />
      ) : null}

      {error ? (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      ) : null}

      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
        {loading ? (
          <div className="p-4">
            <Spinner label="Loading templates…" />
          </div>
        ) : null}

        {!loading && templates.length === 0 ? (
          <EmptyState
            title="No templates yet"
            description="Type what you charge and the AI will write it up four ways."
          />
        ) : null}

        <ul>
          {templates.map((template) => (
            <li
              key={template.id}
              className="flex flex-col gap-3 border-b border-slate-100 px-4 py-3 sm:flex-row sm:items-start sm:justify-between"
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="truncate font-semibold text-slate-900">{template.title}</span>
                  <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold capitalize text-slate-500">
                    {template.kind}
                  </span>
                </div>
                {/* Shown exactly as it will arrive on the customer's phone, line breaks included. */}
                <p className="mt-1 whitespace-pre-wrap break-words text-sm text-slate-600">
                  {template.body}
                </p>
              </div>

              {canManage ? (
                <div className="flex shrink-0 items-center gap-2">
                  <button
                    type="button"
                    onClick={() => openLike(template)}
                    disabled={busyId !== null}
                    className="rounded-lg border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                  >
                    More like this
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDelete(template)}
                    disabled={busyId !== null}
                    className="rounded-lg border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-700 transition-colors hover:border-danger/50 hover:text-danger disabled:opacity-50"
                  >
                    Delete
                  </button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
};

export default TemplatesPage;
