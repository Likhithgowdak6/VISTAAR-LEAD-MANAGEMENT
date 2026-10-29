import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  cancelFollowUp,
  completeFollowUp,
  listOrganizationTasks,
  rescheduleFollowUp,
} from '../api/endpoints';
import { useAuth } from '../auth/AuthContext';
import EmptyState from '../components/EmptyState';
import Spinner from '../components/Spinner';
import RescheduleReminderDialog from '../components/reminders/RescheduleReminderDialog';
import CreateTaskDialog from '../components/tasks/CreateTaskDialog';
import TaskCard from '../components/tasks/TaskCard';
import {
  type AuthValue,
  errorMessage,
  type TaskCounts,
  type TaskListItem,
  type TaskScope,
  type TaskStatusFilter,
} from '../components/types';
import { hasPermission, PERMISSIONS } from '../lib/permissions';
import { groupTasks } from '../lib/task-grouping';

/**
 * Every task in one place, instead of one lead at a time.
 *
 * WHY A SCREEN RATHER THAN A WIDER LEAD PANEL. Reminders live inside a conversation's Details
 * panel, which answers "what do I owe THIS customer". It cannot answer "what am I late on",
 * because that question spans leads - and the owner's actual morning is the second question.
 *
 * THE SERVER DOES THE WORK, DELIBERATELY. Scope, status, search, ordering, pagination and the
 * counts are all decided in one aggregation (see findOrganizationTasks). Fetching conversations
 * and stitching their reminders together here would be N+1, could not sort or count across the
 * whole set - so page 2 would be meaningless - and would quietly turn the Team tab into a
 * client-side filter, which is not a permission check.
 */

const PAGE_SIZE = 25;

/** The chips, in the order the reference layout shows them. */
const CHIPS: readonly { value: TaskStatusFilter; label: string; dot: string; count: keyof TaskCounts }[] =
  [
    { value: 'pending', label: 'Pending', dot: 'bg-key', count: 'pending' },
    { value: 'late', label: 'Late', dot: 'bg-danger', count: 'overdue' },
    { value: 'completed', label: 'Done', dot: 'bg-emerald-400', count: 'completed' },
    { value: 'cancelled', label: 'Cancelled', dot: 'bg-muted', count: 'cancelled' },
  ];

const EMPTY_COUNTS: TaskCounts = {
  total: 0,
  pending: 0,
  overdue: 0,
  completed: 0,
  cancelled: 0,
};

type Props = {
  /**
   * Opens the lead, and the exact reminder when there is one.
   *
   * The same path a tapped WhatsApp link takes - see AppShell - so a task opened here and a
   * reminder opened from a notification land identically. A personal reminder has no
   * conversation, so it passes null and the shell leaves the inbox where it is.
   */
  onOpenTask: (target: { conversationId: string | null; reminderId: string }) => void;
};

const TasksPage = ({ onOpenTask }: Props) => {
  const { authedRequest, permissions } = useAuth() as AuthValue;
  const canManage = hasPermission(permissions, PERMISSIONS.CRM_TASKS_MANAGE);
  /**
   * The Team tab, gated on the permission that already decides whether somebody may see work
   * that is not theirs. Hiding it is a COURTESY - the real gate is in followup.service.ts,
   * because `scope` travels in a query string and anyone can type one.
   */
  const canSeeTeam = hasPermission(permissions, PERMISSIONS.CONVERSATIONS_READ_ALL);

  const [scope, setScope] = useState<TaskScope>('mine');
  const [status, setStatus] = useState<TaskStatusFilter | null>(null);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);

  const [items, setItems] = useState<TaskListItem[]>([]);
  const [counts, setCounts] = useState<TaskCounts>(EMPTY_COUNTS);
  const [matched, setMatched] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [rescheduling, setRescheduling] = useState<TaskListItem | null>(null);
  /** Bumped after a mutation, to refetch from the first page rather than patch rows in place. */
  const [refreshKey, setRefreshKey] = useState(0);

  /**
   * The clock the whole list is judged against, stamped when a page arrives rather than read
   * during render - `Date.now()` in a render is impure, and would let two renders disagree
   * about whether the same task is late.
   */
  const [listLoadedAt, setListLoadedAt] = useState(() => Date.now());

  // Typing a customer's name should not fire a request per keystroke. 300ms is long enough to
  // collapse a word and short enough not to feel laggy.
  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(searchInput);
      setPage(0);
    }, 300);

    return () => clearTimeout(timer);
  }, [searchInput]);

  useEffect(() => {
    if (!canManage) {
      return;
    }

    let cancelled = false;
    const append = page > 0;

    if (append) {
      setLoadingMore(true);
    } else {
      setLoading(true);
    }

    authedRequest((token) =>
      listOrganizationTasks({
        token,
        scope,
        status,
        search,
        limit: PAGE_SIZE,
        skip: page * PAGE_SIZE,
      }),
    )
      .then((payload) => {
        // A response that arrived after the filters changed would overwrite the newer list
        // with older rows, which looks exactly like the filter not working.
        if (cancelled) {
          return;
        }

        const rows = payload.data ?? [];
        const meta = (payload.meta ?? {}) as { matched?: number; counts?: TaskCounts };

        setItems((current) => (append ? [...current, ...rows] : rows));
        setCounts(meta.counts ?? EMPTY_COUNTS);
        setMatched(meta.matched ?? rows.length);
        setListLoadedAt(Date.now());
        setError(null);
      })
      .catch((loadError: unknown) => {
        if (!cancelled) {
          setError(errorMessage(loadError, 'Unable to load tasks.'));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
          setLoadingMore(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [authedRequest, canManage, scope, status, search, page, refreshKey]);

  const reload = useCallback(() => {
    // Back to the first page rather than patching the changed row: completing a task moves it
    // between sections and changes four counts, and a patched row would leave the chips lying.
    setPage(0);
    setRefreshKey((value) => value + 1);
  }, []);

  const transition = async (
    task: TaskListItem,
    makeRequest: (token: string | null) => Promise<unknown>,
  ) => {
    if (busyId) {
      return;
    }

    setBusyId(task.id);
    setError(null);

    try {
      await authedRequest(makeRequest);
      reload();
    } catch (actionError: unknown) {
      setError(errorMessage(actionError, 'Unable to update the task.'));
    } finally {
      setBusyId(null);
    }
  };

  const handleComplete = (task: TaskListItem) =>
    void transition(task, (token) => completeFollowUp({ token, taskId: task.id }));

  const handleCancel = (task: TaskListItem) => {
    // The same confirmation the lead panel asks for, because it is the same irreversible
    // action: cancelling stops a reminder ringing and this API cannot undo it.
    if (!window.confirm('Cancel this task? Its reminder will not ring.')) {
      return;
    }

    void transition(task, (token) => cancelFollowUp({ token, taskId: task.id }));
  };

  const handleOpen = (task: TaskListItem) =>
    onOpenTask({ conversationId: task.lead?.conversationId ?? task.conversationId, reminderId: task.id });

  const grouped = useMemo(() => groupTasks(items, listLoadedAt), [items, listLoadedAt]);
  const hasMore = items.length < matched;

  if (!canManage) {
    return (
      <EmptyState
        title="Tasks are not available for your role"
        description="Ask an administrator for task management access."
      />
    );
  }

  const selectScope = (next: TaskScope) => {
    setScope(next);
    setPage(0);
  };

  const selectStatus = (next: TaskStatusFilter) => {
    // Tapping the active chip clears it, which is the only way back to "everything" without a
    // fifth chip that says All.
    setStatus((current) => (current === next ? null : next));
    setPage(0);
  };

  const section = (label: string, tasks: TaskListItem[], tone: 'danger' | 'bone') =>
    tasks.length === 0 ? null : (
      <section className="space-y-2">
        <h2 className="flex items-baseline gap-2 text-xs font-semibold uppercase tracking-[0.12em]">
          <span className={tone === 'danger' ? 'text-danger' : 'text-bone-dim'}>{label}</span>
          <span className="text-muted">{tasks.length}</span>
        </h2>
        <ul className="space-y-2">
          {tasks.map((task) => (
            <TaskCard
              key={task.id}
              task={task}
              now={listLoadedAt}
              busy={busyId === task.id}
              onOpen={handleOpen}
              onComplete={handleComplete}
              onReschedule={setRescheduling}
              onCancel={handleCancel}
            />
          ))}
        </ul>
      </section>
    );

  return (
    <div className="relative mx-auto max-w-2xl space-y-4 p-4">
      <div>
        <h1 className="text-2xl font-bold text-bone">Tasks</h1>
        {/* The total across every status, so the headline does not change meaning when a chip
            narrows the list below it. */}
        <p className="mt-0.5 text-sm text-muted">
          {counts.total} {counts.total === 1 ? 'task' : 'tasks'}
        </p>
      </div>

      {/* Mine / Team. Only rendered when the permission allows it - see canSeeTeam. */}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => selectScope('mine')}
          aria-pressed={scope === 'mine'}
          className={`min-h-9 rounded-full px-4 text-sm font-semibold transition-colors ${
            scope === 'mine' ? 'bg-bone text-ink' : 'border border-hairline text-bone-dim'
          }`}
        >
          Mine
        </button>
        {canSeeTeam ? (
          <button
            type="button"
            onClick={() => selectScope('team')}
            aria-pressed={scope === 'team'}
            className={`min-h-9 rounded-full px-4 text-sm font-semibold transition-colors ${
              scope === 'team' ? 'bg-bone text-ink' : 'border border-hairline text-bone-dim'
            }`}
          >
            Team
          </button>
        ) : null}
      </div>

      {/* The counts ride on the chips rather than sitting in a separate stat row: a chip that
          says "Late 14" is both the number and the way to see those fourteen. */}
      <div className="no-scrollbar -mx-1 flex gap-2 overflow-x-auto px-1">
        {CHIPS.map((chip) => (
          <button
            key={chip.value}
            type="button"
            data-testid={`task-chip-${chip.value}`}
            onClick={() => selectStatus(chip.value)}
            aria-pressed={status === chip.value}
            className={`flex min-h-9 shrink-0 items-center gap-1.5 rounded-full px-3 text-xs font-medium transition-colors ${
              status === chip.value
                ? 'bg-bone text-ink'
                : 'border border-hairline bg-panel text-bone-dim'
            }`}
          >
            <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${chip.dot}`} />
            {chip.label}
            <span className={status === chip.value ? 'text-ink/60' : 'text-muted'}>
              {counts[chip.count]}
            </span>
          </button>
        ))}
      </div>

      <input
        type="search"
        aria-label="Search tasks"
        value={searchInput}
        onChange={(event) => setSearchInput(event.target.value)}
        placeholder="Search by customer or task…"
        className="min-h-11 w-full rounded-lg border border-hairline bg-panel px-3 text-sm text-bone placeholder:text-muted"
      />

      {loading ? <Spinner label="Loading tasks…" /> : null}

      {error ? (
        <div>
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
          <button
            type="button"
            onClick={reload}
            className="min-h-11 text-xs font-medium text-key hover:text-key-soft"
          >
            Try again
          </button>
        </div>
      ) : null}

      {!loading && !error && items.length === 0 ? (
        <EmptyState
          title={search ? 'Nothing matches that search' : 'No tasks here'}
          description={
            search
              ? 'Try a customer’s name, or part of a task title.'
              : scope === 'team'
                ? 'Nobody on the team has tasks in this view.'
                : 'Add one with the + button, or from a lead’s Details panel.'
          }
        />
      ) : null}

      {/* Sections describe the page that is loaded. With pagination a group can continue onto
          the next page - the server's ordering keeps that coherent (overdue first), and Load
          more appends rather than replacing. */}
      {section('Overdue', grouped.overdue, 'danger')}
      {section('Due today', grouped.today, 'bone')}
      {section('Upcoming', grouped.upcoming, 'bone')}
      {section('Closed', grouped.closed, 'bone')}

      {hasMore && !loading ? (
        <button
          type="button"
          disabled={loadingMore}
          onClick={() => setPage((value) => value + 1)}
          className="min-h-11 w-full rounded-lg border border-hairline text-sm font-medium text-bone-dim disabled:opacity-60"
        >
          {loadingMore ? 'Loading…' : `Load more (${matched - items.length} left)`}
        </button>
      ) : null}

      {/* Fixed, thumb-reachable, and in Vistaar's key colour rather than the reference's
          purple - this app has one accent and a second one would read as a different product. */}
      <button
        type="button"
        onClick={() => setCreating(true)}
        aria-label="New task"
        className="fixed bottom-20 right-5 z-10 flex h-14 w-14 items-center justify-center rounded-full bg-key text-2xl font-light text-ink shadow-lg sm:bottom-8"
      >
        +
      </button>

      {creating ? (
        <CreateTaskDialog onClose={() => setCreating(false)} onCreated={reload} />
      ) : null}

      {/* The same dialog the lead panel and the reminder detail use, so rescheduling behaves
          identically wherever it is reached from - including its past-time validation. */}
      {rescheduling ? (
        <RescheduleReminderDialog
          title={rescheduling.title?.trim() || `${rescheduling.type} task`}
          dueAt={rescheduling.dueAt ?? ''}
          busy={busyId === rescheduling.id}
          error={error}
          onCancel={() => setRescheduling(null)}
          onSave={(dueAtIso: string) => {
            const task = rescheduling;
            setRescheduling(null);
            void transition(task, (token) =>
              rescheduleFollowUp({
                token,
                taskId: task.id,
                // The zone the new time was CHOSEN in, so the task is later displayed as what
                // the person actually typed rather than translated into its original zone.
                dueAt: dueAtIso,
                timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
              }),
            );
          }}
        />
      ) : null}
    </div>
  );
};

export default TasksPage;
