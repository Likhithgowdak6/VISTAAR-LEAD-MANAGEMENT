import { type TaskListItem } from '../types';

/**
 * Which section of the Tasks screen a task belongs in, and what its due line reads.
 *
 * PURE, AND SEPARATE FROM THE PAGE, because this is where the timezone bugs live. "Is this
 * overdue" and "is this due today" are different kinds of question and get different answers
 * here, deliberately:
 *
 *   OVERDUE IS AN INSTANT. `dueAt` is an absolute moment; either it has passed or it has not.
 *   No calendar, no zone, nothing to get wrong - which is also how the lead panel has always
 *   judged it (see FollowUpsSection), so the two screens cannot disagree about the same task.
 *
 *   TODAY IS A CALENDAR DAY, and therefore needs a zone. It is computed in the VIEWER'S local
 *   zone - what their own clock says - not in the reminder's stored `timezone`. Those differ
 *   on purpose: the stored zone is the one the reminder was set in and is what the WhatsApp
 *   message quotes back ("5:00 PM today"), because that is the time the customer was promised.
 *   But somebody looking at this screen in London at 23:00 should not see a reminder listed
 *   under "Due today" because it is still today in Kolkata. The section headings describe the
 *   reader's day.
 */

/** Closed work is its own section: it is history, not a thing with a deadline. */
export type TaskGroup = 'overdue' | 'today' | 'upcoming' | 'closed';

const DAY_MS = 86_400_000;

/** Same local calendar day, judged in the browser's zone. */
const isSameLocalDay = (a: Date, b: Date): boolean =>
  a.getFullYear() === b.getFullYear() &&
  a.getMonth() === b.getMonth() &&
  a.getDate() === b.getDate();

/** Pending and the due instant has passed. The one definition, used for both label and group. */
export const isTaskOverdue = (task: TaskListItem, now: number): boolean =>
  task.status === 'pending' && Boolean(task.dueAt) && new Date(task.dueAt!).getTime() <= now;

export const classifyTask = (task: TaskListItem, now: number): TaskGroup => {
  if (task.status !== 'pending') {
    return 'closed';
  }

  // A pending task with no due time is a real row in this schema. It is not overdue (nothing
  // has passed) and it is not today, so it sits in Upcoming rather than being dropped.
  if (!task.dueAt) {
    return 'upcoming';
  }

  if (isTaskOverdue(task, now)) {
    return 'overdue';
  }

  return isSameLocalDay(new Date(task.dueAt), new Date(now)) ? 'today' : 'upcoming';
};

const clockTime = (value: Date): string =>
  value.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

/**
 * The second line of a card: "Overdue 09:10 PM", "Overdue 2d", "Today 14:30", "02 Nov 15:00".
 *
 * WHOLE DAYS LATE ARE COUNTED IN DAYS, not hours, because "Overdue 51h" is arithmetic the
 * reader has to do and "Overdue 2d" is not. Measured between local calendar days rather than
 * by dividing the elapsed milliseconds: across a DST change those disagree, and the day count
 * is the one a person would say out loud.
 */
export const formatDueLabel = (task: TaskListItem, now: number): string => {
  if (!task.dueAt) {
    return 'No due time';
  }

  const due = new Date(task.dueAt);
  const current = new Date(now);

  if (isTaskOverdue(task, now)) {
    if (isSameLocalDay(due, current)) {
      return `Overdue ${clockTime(due)}`;
    }

    const midnightDue = new Date(due.getFullYear(), due.getMonth(), due.getDate()).getTime();
    const midnightNow = new Date(
      current.getFullYear(),
      current.getMonth(),
      current.getDate(),
    ).getTime();
    const days = Math.round((midnightNow - midnightDue) / DAY_MS);

    return `Overdue ${days}d`;
  }

  if (isSameLocalDay(due, current)) {
    return `Today ${clockTime(due)}`;
  }

  return `${due.toLocaleDateString(undefined, { day: '2-digit', month: 'short' })} ${clockTime(due)}`;
};

/** The dot and word under a card's title. `late` is derived, never a stored status. */
export const taskStatusLabel = (task: TaskListItem, now: number): string => {
  if (isTaskOverdue(task, now)) {
    return 'Late';
  }

  if (task.status === 'completed') {
    return 'Done';
  }

  if (task.status === 'cancelled') {
    return 'Cancelled';
  }

  return 'Pending';
};

export interface GroupedTasks {
  overdue: TaskListItem[];
  today: TaskListItem[];
  upcoming: TaskListItem[];
  closed: TaskListItem[];
}

/**
 * Splits the CURRENT PAGE into sections, preserving the server's order within each.
 *
 * Deliberately not re-sorted here. The server orders overdue-first then soonest-due with a
 * total order on `_id`, which is what makes pagination stable; re-sorting in the browser would
 * only reorder the handful of rows that happen to be loaded and would disagree with page 2.
 */
export const groupTasks = (tasks: readonly TaskListItem[], now: number): GroupedTasks => {
  const grouped: GroupedTasks = { overdue: [], today: [], upcoming: [], closed: [] };

  tasks.forEach((task) => {
    grouped[classifyTask(task, now)].push(task);
  });

  return grouped;
};
