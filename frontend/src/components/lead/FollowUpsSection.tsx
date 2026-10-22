import {
  type ChangeEvent,
  type ComponentProps,
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import {
  cancelFollowUp,
  completeFollowUp,
  createFollowUp,
  listConversationFollowUps,
  rescheduleFollowUp,
} from '../../api/endpoints';
import { useAuth } from '../../auth/AuthContext';
import { hasPermission, PERMISSIONS } from '../../lib/permissions';
import EmptyState from '../EmptyState';
import RelativeTime from '../RelativeTime';
import Spinner from '../Spinner';
import NotificationPermissionNotice from '../reminders/NotificationPermissionNotice';
import RescheduleReminderDialog from '../reminders/RescheduleReminderDialog';
import { type AuthValue, type AuthedRequest, errorMessage, type FollowUpTask } from '../types';

const TYPES = ['call', 'message', 'proposal', 'custom'] as const;
const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;

/**
 * Where a reminder came from, in words an owner would use.
 *
 * Null is a real answer here, not a gap to paper over: rows written before `source` existed
 * genuinely do not record who made them, and saying "Added by hand" about an AI-created
 * reminder would be worse than admitting we do not know.
 */
const SOURCE_LABELS: Record<string, string> = {
  manual: 'Added by hand',
  lead_commitment: 'From what the lead said',
  owner_command: 'Asked for on WhatsApp',
};

type FollowUpForm = {
  type: (typeof TYPES)[number];
  dueAt: string;
  priority: (typeof PRIORITIES)[number];
  note: string;
};

const EMPTY_FORM: FollowUpForm = { type: 'call', dueAt: '', priority: 'normal', note: '' };

type Props = {
  conversationId: string;
  /**
   * Re-arms the device alarms after a reminder is added or moved.
   *
   * Without it a reminder created here does not ring until the next sync, which only happens on
   * app start or when the app returns to the foreground - so a reminder set for twenty minutes
   * from now would silently never fire. Optional because the browser has no alarms to arm.
   */
  onRemindersChanged?: () => void;
  /**
   * Everything the device-alarm notice needs, passed as one bag rather than ten props.
   *
   * It used to live on the standalone Reminders page. With reminders managed per lead it has no
   * page of its own, so it appears where it is actually relevant - inside the create form, at
   * the moment someone is setting a time they expect the phone to ring at. Absent on the web
   * build, where there are no alarms to arm.
   */
  alarms?: ComponentProps<typeof NotificationPermissionNotice>;
};

const isOverdue = (task: FollowUpTask, now: number): boolean =>
  task.status === 'pending' && Boolean(task.dueAt) && new Date(task.dueAt!).getTime() <= now;

const FollowUpsSection = ({ conversationId, onRemindersChanged, alarms }: Props) => {
  const { authedRequest, permissions } = useAuth() as AuthValue;
  const [tasks, setTasks] = useState<FollowUpTask[]>([]);
  /**
   * The clock the overdue split is judged against, stamped when the list arrives rather than
   * read during render - `Date.now()` in a `useMemo` is impure and would also let two renders
   * disagree about whether the same reminder is late.
   */
  const [listLoadedAt, setListLoadedAt] = useState(() => Date.now());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<FollowUpForm>(EMPTY_FORM);
  const [formOpen, setFormOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [rescheduling, setRescheduling] = useState<FollowUpTask | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  /**
   * A ref, not the `saving` state. Two submits land in the same React batch and both read the
   * old state - the template writer in this codebase shipped exactly that bug once already, and
   * here the duplicate is a second reminder that will ring on its own.
   */
  const submittingRef = useRef(false);
  const canManage = hasPermission(permissions, PERMISSIONS.CRM_TASKS_MANAGE);

  const load = useCallback(async () => {
    try {
      const payload = await authedRequest((token) =>
        listConversationFollowUps({ token, conversationId }),
      );
      setTasks((payload?.data as FollowUpTask[] | undefined) ?? []);
      setListLoadedAt(Date.now());
      setError(null);
    } catch (loadError: unknown) {
      setError(errorMessage(loadError, 'Unable to load reminders.'));
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

  /**
   * Split once per render rather than filtered three times in the markup.
   *
   * Judged against `listLoadedAt` rather than a fresh clock: nothing re-renders this panel on a
   * timer, so the two are equivalent in practice, and a stamped value keeps the split stable
   * across renders instead of shifting under an unrelated state change.
   */
  const { overdue, upcoming, history } = useMemo(() => {
    const now = listLoadedAt;
    const pending = tasks.filter((task) => task.status === 'pending');
    const byDue = (a: FollowUpTask, b: FollowUpTask) =>
      new Date(a.dueAt ?? 0).getTime() - new Date(b.dueAt ?? 0).getTime();

    return {
      overdue: pending.filter((task) => isOverdue(task, now)).sort(byDue),
      upcoming: pending.filter((task) => !isOverdue(task, now)).sort(byDue),
      history: tasks.filter((task) => task.status !== 'pending').sort(byDue).reverse(),
    };
  }, [tasks, listLoadedAt]);

  const updateField =
    (field: keyof FollowUpForm) =>
    (event: ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
      setForm((current) => ({ ...current, [field]: event.target.value }));

  const handleCreate = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!form.dueAt || submittingRef.current) {
      return;
    }

    submittingRef.current = true;
    setSaving(true);
    setError(null);

    try {
      // The conversation comes from the URL this request is sent to, never from the form - the
      // server reads it off the route, so there is no way for this panel to file a reminder
      // against a different lead.
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

      setForm(EMPTY_FORM);
      setFormOpen(false);
      await load();
      onRemindersChanged?.();
    } catch (createError: unknown) {
      // The form is deliberately left filled in: a failed save should not cost the owner the
      // typing, and nothing here may suggest a reminder exists when the request did not land.
      setError(errorMessage(createError, 'Unable to create the reminder.'));
    } finally {
      submittingRef.current = false;
      setSaving(false);
    }
  };

  const transition = async (taskId: string, makeRequest: Parameters<AuthedRequest>[0]) => {
    if (busyId) {
      return;
    }

    setBusyId(taskId);
    setError(null);

    try {
      await authedRequest(makeRequest);
      await load();
      onRemindersChanged?.();
    } catch (transitionError: unknown) {
      setError(errorMessage(transitionError, 'Unable to update the reminder.'));
    } finally {
      setBusyId(null);
    }
  };

  const handleCancel = (task: FollowUpTask) => {
    // Cancelling stops a reminder ringing and cannot be undone through this API, so it asks.
    if (!window.confirm('Cancel this reminder? It will not ring.')) {
      return;
    }

    void transition(task.id, (token) => cancelFollowUp({ token, taskId: task.id }));
  };

  if (!canManage) {
    return null;
  }

  const renderTask = (task: FollowUpTask, tone: 'overdue' | 'upcoming' | 'history') => {
    const sourceLabel = task.source ? SOURCE_LABELS[task.source] : null;
    const busy = busyId === task.id;

    return (
      <li
        key={task.id}
        data-testid="reminder-item"
        data-status={task.status}
        data-overdue={tone === 'overdue'}
        className={`rounded-lg p-2 text-sm ${
          tone === 'overdue'
            ? 'border border-red-200 bg-red-50'
            : tone === 'history'
              ? 'bg-slate-50 opacity-75'
              : 'bg-slate-50'
        }`}
      >
        <div className="flex items-start justify-between gap-2">
          <span className="font-medium capitalize text-slate-800">
            {task.title?.trim() || `${task.type} · ${task.priority}`}
          </span>
          <span
            className={`shrink-0 text-[11px] capitalize ${
              tone === 'overdue' ? 'font-semibold text-red-600' : 'text-slate-400'
            }`}
          >
            {tone === 'overdue' ? 'Overdue' : task.status}
          </span>
        </div>

        {/* A reminder with no due date is a real row in this schema, so it says so rather than
            rendering "due Invalid Date". */}
        <p className="text-[11px] text-slate-400">
          {task.dueAt ? (
            <>
              due <RelativeTime value={task.dueAt} />
            </>
          ) : (
            'no due time recorded'
          )}
          {sourceLabel ? <span> · {sourceLabel}</span> : null}
        </p>

        {task.note ? <p className="mt-1 text-xs text-slate-600">{task.note}</p> : null}

        {/* What the customer actually said, when that is what produced this reminder. */}
        {task.sourceQuote ? (
          <p className="mt-1 border-l-2 border-slate-300 pl-2 text-xs italic text-slate-500">
            “{task.sourceQuote}”
          </p>
        ) : null}

        {task.status === 'pending' ? (
          <div className="mt-1.5 flex flex-wrap gap-3 text-[11px] font-medium">
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void transition(task.id, (token) => completeFollowUp({ token, taskId: task.id }))
              }
              className="min-h-11 text-green-600 hover:text-green-700 disabled:opacity-50 sm:min-h-0"
            >
              Complete
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setRescheduling(task)}
              className="min-h-11 text-blue-600 hover:text-blue-700 disabled:opacity-50 sm:min-h-0"
            >
              Reschedule
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => handleCancel(task)}
              className="min-h-11 text-slate-500 hover:text-slate-700 disabled:opacity-50 sm:min-h-0"
            >
              Cancel
            </button>
          </div>
        ) : null}
      </li>
    );
  };

  return (
    <section>
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase text-slate-500">Reminders &amp; follow-ups</h3>
        <button
          type="button"
          onClick={() => setFormOpen((open) => !open)}
          aria-expanded={formOpen}
          className="min-h-11 rounded-lg px-2 text-xs font-medium text-blue-600 hover:text-blue-700 sm:min-h-0"
        >
          {formOpen ? 'Close' : '+ Add reminder'}
        </button>
      </div>

      {formOpen ? (
        <form onSubmit={handleCreate} aria-label="Create reminder" className="mb-3 space-y-2">
          {/* Whether this phone will actually ring, shown while a time is being chosen. */}
          {alarms ? <NotificationPermissionNotice {...alarms} /> : null}
          <div className="flex gap-2">
            <select
              aria-label="Reminder type"
              value={form.type}
              onChange={updateField('type')}
              className="min-h-11 flex-1 rounded-lg border border-slate-300 px-2 py-1 text-xs capitalize text-slate-700 focus:border-blue-500 focus:outline-none sm:min-h-0"
            >
              {TYPES.map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </select>
            <select
              aria-label="Reminder priority"
              value={form.priority}
              onChange={updateField('priority')}
              className="min-h-11 flex-1 rounded-lg border border-slate-300 px-2 py-1 text-xs capitalize text-slate-700 focus:border-blue-500 focus:outline-none sm:min-h-0"
            >
              {PRIORITIES.map((priority) => (
                <option key={priority} value={priority}>
                  {priority}
                </option>
              ))}
            </select>
          </div>
          <input
            aria-label="Reminder due date"
            type="datetime-local"
            value={form.dueAt}
            onChange={updateField('dueAt')}
            className="min-h-11 w-full rounded-lg border border-slate-300 px-2 py-1 text-xs text-slate-700 focus:border-blue-500 focus:outline-none sm:min-h-0"
          />
          <input
            aria-label="Reminder note"
            type="text"
            value={form.note}
            onChange={updateField('note')}
            placeholder="What is this about? (optional)"
            className="min-h-11 w-full rounded-lg border border-slate-300 px-2 py-1 text-xs text-slate-700 focus:border-blue-500 focus:outline-none sm:min-h-0"
          />
          <button
            type="submit"
            disabled={saving || !form.dueAt}
            className="min-h-11 w-full rounded-lg bg-blue-600 px-3 py-1 text-xs font-semibold text-white hover:bg-blue-700 disabled:bg-blue-300 sm:min-h-0"
          >
            {saving ? 'Adding…' : 'Add reminder'}
          </button>
        </form>
      ) : null}

      {loading ? <Spinner label="Loading reminders…" /> : null}

      {error ? (
        <div className="mb-2">
          <p role="alert" className="text-xs text-red-600">
            {error}
          </p>
          <button
            type="button"
            onClick={() => void load()}
            className="min-h-11 text-[11px] font-medium text-blue-600 hover:text-blue-700 sm:min-h-0"
          >
            Try again
          </button>
        </div>
      ) : null}

      {!loading && tasks.length === 0 && !error ? (
        <EmptyState
          compact
          title="No reminders for this lead yet"
          description="Add one so this conversation does not go quiet."
        />
      ) : null}

      {overdue.length > 0 ? (
        <ul className="mb-2 space-y-2">{overdue.map((task) => renderTask(task, 'overdue'))}</ul>
      ) : null}

      {upcoming.length > 0 ? (
        <ul className="space-y-2">{upcoming.map((task) => renderTask(task, 'upcoming'))}</ul>
      ) : null}

      {/* Closed reminders are history, not work. They stay reachable because "did we already
          chase this?" is a real question, but they do not compete with what is still open. */}
      {history.length > 0 ? (
        <div className="mt-2">
          <button
            type="button"
            onClick={() => setHistoryOpen((open) => !open)}
            aria-expanded={historyOpen}
            className="min-h-11 text-[11px] font-medium text-slate-500 hover:text-slate-700 sm:min-h-0"
          >
            {historyOpen ? 'Hide' : 'Show'} completed &amp; cancelled ({history.length})
          </button>
          {historyOpen ? (
            <ul className="mt-2 space-y-2">{history.map((task) => renderTask(task, 'history'))}</ul>
          ) : null}
        </div>
      ) : null}

      {/* The same dialog the standalone Reminders page used, so rescheduling behaves identically
          wherever it is reached from - including its past-time validation. */}
      {rescheduling ? (
        <RescheduleReminderDialog
          title={rescheduling.title?.trim() || `${rescheduling.type} reminder`}
          dueAt={rescheduling.dueAt ?? ''}
          busy={busyId === rescheduling.id}
          error={error}
          onCancel={() => setRescheduling(null)}
          onSave={(dueAtIso: string) => {
            const taskId = rescheduling.id;
            setRescheduling(null);
            void transition(taskId, (token) =>
              rescheduleFollowUp({ token, taskId, dueAt: dueAtIso }),
            );
          }}
        />
      ) : null}
    </section>
  );
};

export default FollowUpsSection;
