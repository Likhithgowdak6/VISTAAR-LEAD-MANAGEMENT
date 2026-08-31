import { type ChangeEvent, type FormEvent, useCallback, useEffect, useState } from 'react';

import {
  cancelFollowUp,
  completeFollowUp,
  createFollowUp,
  listConversationFollowUps,
} from '../../api/endpoints';
import { useAuth } from '../../auth/AuthContext';
import { hasPermission, PERMISSIONS } from '../../lib/permissions';
import EmptyState from '../EmptyState';
import RelativeTime from '../RelativeTime';
import Spinner from '../Spinner';
import { type AuthValue, type AuthedRequest, errorMessage, type FollowUpTask } from '../types';

const TYPES = ['call', 'message', 'proposal', 'custom'] as const;
const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;

type FollowUpForm = {
  type: (typeof TYPES)[number];
  dueAt: string;
  priority: (typeof PRIORITIES)[number];
  note: string;
};

type Props = {
  conversationId: string;
};

const FollowUpsSection = ({ conversationId }: Props) => {
  const { authedRequest, permissions } = useAuth() as AuthValue;
  const [tasks, setTasks] = useState<FollowUpTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<FollowUpForm>({
    type: 'call',
    dueAt: '',
    priority: 'normal',
    note: '',
  });
  const [saving, setSaving] = useState(false);
  const canManage = hasPermission(permissions, PERMISSIONS.CRM_TASKS_MANAGE);

  const load = useCallback(async () => {
    try {
      const payload = await authedRequest((token) =>
        listConversationFollowUps({ token, conversationId }),
      );
      setTasks((payload?.data as FollowUpTask[] | undefined) ?? []);
      setError(null);
    } catch (loadError: unknown) {
      setError(errorMessage(loadError, 'Unable to load follow-ups.'));
    } finally {
      setLoading(false);
    }
  }, [authedRequest, conversationId]);

  useEffect(() => {
    if (!canManage) {
      return;
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load, canManage]);

  const updateField =
    (field: keyof FollowUpForm) =>
    (event: ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
      setForm((current) => ({ ...current, [field]: event.target.value }));

  const handleCreate = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!form.dueAt || saving) {
      return;
    }

    setSaving(true);
    setError(null);

    try {
      await authedRequest((token) =>
        createFollowUp({
          token,
          conversationId,
          type: form.type,
          note: form.note.trim() || undefined,
          dueAt: new Date(form.dueAt).toISOString(),
          priority: form.priority,
        }),
      );
      setForm({ type: 'call', dueAt: '', priority: 'normal', note: '' });
      await load();
    } catch (createError: unknown) {
      setError(errorMessage(createError, 'Unable to create follow-up.'));
    } finally {
      setSaving(false);
    }
  };

  const transition = async (makeRequest: Parameters<AuthedRequest>[0]) => {
    setError(null);
    try {
      await authedRequest(makeRequest);
      await load();
    } catch (transitionError: unknown) {
      setError(errorMessage(transitionError, 'Unable to update follow-up.'));
    }
  };

  if (!canManage) {
    return null;
  }

  return (
    <section>
      <h3 className="mb-2 text-xs font-semibold uppercase text-slate-500">Follow-ups</h3>

      <form onSubmit={handleCreate} aria-label="Create follow-up" className="mb-3 space-y-2">
        <div className="flex gap-2">
          <select
            aria-label="Follow-up type"
            value={form.type}
            onChange={updateField('type')}
            className="flex-1 rounded-lg border border-slate-300 px-2 py-1 text-xs capitalize text-slate-700 focus:border-blue-500 focus:outline-none"
          >
            {TYPES.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </select>
          <select
            aria-label="Follow-up priority"
            value={form.priority}
            onChange={updateField('priority')}
            className="flex-1 rounded-lg border border-slate-300 px-2 py-1 text-xs capitalize text-slate-700 focus:border-blue-500 focus:outline-none"
          >
            {PRIORITIES.map((priority) => (
              <option key={priority} value={priority}>
                {priority}
              </option>
            ))}
          </select>
        </div>
        <input
          aria-label="Follow-up due date"
          type="datetime-local"
          value={form.dueAt}
          onChange={updateField('dueAt')}
          className="w-full rounded-lg border border-slate-300 px-2 py-1 text-xs text-slate-700 focus:border-blue-500 focus:outline-none"
        />
        <button
          type="submit"
          disabled={saving || !form.dueAt}
          className="w-full rounded-lg bg-blue-600 px-3 py-1 text-xs font-semibold text-white hover:bg-blue-700 disabled:bg-blue-300"
        >
          {saving ? 'Adding…' : 'Add follow-up'}
        </button>
      </form>

      {loading ? <Spinner label="Loading follow-ups…" /> : null}
      {error ? (
        <p role="alert" className="text-xs text-red-600">
          {error}
        </p>
      ) : null}
      {!loading && tasks.length === 0 ? (
        <EmptyState compact title="No follow-ups" description="Schedule one above." />
      ) : null}

      <ul className="space-y-2">
        {tasks.map((task) => (
          <li key={task.id} className="rounded-lg bg-slate-50 p-2 text-sm">
            <div className="flex items-center justify-between">
              <span className="font-medium capitalize text-slate-800">
                {task.type} · {task.priority}
              </span>
              <span className="text-[11px] capitalize text-slate-400">{task.status}</span>
            </div>
            <p className="text-[11px] text-slate-400">
              due <RelativeTime value={task.dueAt} />
            </p>
            {task.note ? <p className="mt-1 text-xs text-slate-600">{task.note}</p> : null}
            {task.status === 'pending' ? (
              <div className="mt-1 flex gap-3 text-[11px] font-medium">
                <button
                  type="button"
                  onClick={() =>
                    transition((token) => completeFollowUp({ token, taskId: task.id }))
                  }
                  className="text-green-600 hover:text-green-700"
                >
                  Complete
                </button>
                <button
                  type="button"
                  onClick={() => transition((token) => cancelFollowUp({ token, taskId: task.id }))}
                  className="text-slate-500 hover:text-slate-700"
                >
                  Cancel
                </button>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
};

export default FollowUpsSection;
