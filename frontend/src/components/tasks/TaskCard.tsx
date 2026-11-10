import { type ReactNode } from 'react';

import { formatDueLabel, isTaskOverdue, taskStatusLabel } from '../../lib/task-grouping';
import { type TaskListItem } from '../types';

/**
 * One row of the Tasks screen.
 *
 * TWO TARGETS IN ONE CARD, and keeping them apart is the whole layout problem. The circle on
 * the left completes the task; everything else opens it. They are separate buttons rather than
 * one card with a nested control, so a tap near the circle can never be read as "open" and a
 * screen reader announces two distinct actions instead of a card that does something
 * mysterious depending on where you touched it.
 *
 * THE CARD IS NOT A LINK. Opening a task navigates the shell's own state - there is no router
 * here - so an anchor would promise a URL that does not exist.
 */

type Props = {
  task: TaskListItem;
  /** The clock the late/overdue wording is judged against. Passed so a list cannot self-disagree. */
  now: number;
  busy: boolean;
  onOpen: (task: TaskListItem) => void;
  onComplete: (task: TaskListItem) => void;
  /**
   * Reschedule and cancel live ON THE CARD rather than only inside the reminder dialog.
   *
   * The dialog is conversation-scoped - it finds a reminder by looking through its lead's list -
   * so a PERSONAL reminder cannot be opened in it at all. Leaving these there only would mean
   * half the rows on this screen could be completed but never moved or called off.
   */
  onReschedule: (task: TaskListItem) => void;
  onCancel: (task: TaskListItem) => void;
};

/** The tappable middle of a card, or just its text when there is nothing to open. */
const Body = ({
  openable,
  onOpen,
  children,
}: {
  openable: boolean;
  onOpen: () => void;
  children: ReactNode;
}) =>
  openable ? (
    <button type="button" onClick={onOpen} className="min-w-0 flex-1 text-left">
      {children}
    </button>
  ) : (
    <div className="min-w-0 flex-1">{children}</div>
  );

const TaskCard = ({ task, now, busy, onOpen, onComplete, onReschedule, onCancel }: Props) => {
  const late = isTaskOverdue(task, now);
  const pending = task.status === 'pending';
  const title = task.title?.trim() || task.note?.trim() || `${task.type} task`;
  const statusLabel = taskStatusLabel(task, now);
  const openTarget = task.lead?.conversationId ?? task.conversationId;

  const dotColor = late
    ? 'bg-danger'
    : task.status === 'completed'
      ? 'bg-emerald-400'
      : task.status === 'cancelled'
        ? 'bg-muted'
        : 'bg-key';

  return (
    <li
      data-testid="task-card"
      data-status={task.status}
      data-late={late}
      className="flex items-start gap-3.5 rounded-2xl border border-slate-200/80 bg-white p-4 shadow-xs transition-all duration-150 hover:shadow-md hover:-translate-y-0.5 hover:border-slate-300"
    >
      {/* Only pending work can be completed, so for closed rows this is a static marker rather
          than a dead button that looks tappable. */}
      {pending ? (
        <button
          type="button"
          disabled={busy}
          onClick={() => onComplete(task)}
          aria-label={`Complete ${title}`}
          className="mt-0.5 h-5 w-5 shrink-0 rounded-full border-2 border-slate-300 transition-all hover:border-blue-600 hover:bg-blue-50/50 disabled:opacity-40"
        />
      ) : (
        <span
          aria-hidden="true"
          className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 ${
            task.status === 'completed'
              ? 'border-emerald-500 bg-emerald-50 text-emerald-600'
              : 'border-slate-300 bg-slate-50 text-slate-400'
          }`}
        >
          <span className="text-[10px] font-bold leading-none">{task.status === 'completed' ? '✓' : '×'}</span>
        </span>
      )}

      {/*
        A PERSONAL REMINDER HAS NOWHERE TO OPEN. It belongs to no lead, and the reminder-detail
        dialog finds a reminder by looking through its conversation's list - so there is no
        destination to send anybody to. Rendered as plain text rather than a button that looks
        tappable and then does nothing; its Complete, Reschedule and Cancel still work.
      */}
      <Body openable={Boolean(openTarget)} onOpen={() => onOpen(task)}>
        <p className="truncate text-sm font-bold text-slate-900">{title}</p>

        <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs">
          {/* Null for a personal reminder, and then the line simply has no customer on it -
              better than a blank where a name goes, which reads as a failed load. */}
          {task.lead?.displayName ? (
            <span className="truncate font-medium text-slate-600">{task.lead.displayName}</span>
          ) : null}
          <span className={late ? 'font-semibold text-rose-600' : 'text-slate-400'}>
            {formatDueLabel(task, now)}
          </span>
        </p>

        <p className="mt-1 flex items-center gap-1.5 text-[11px]">
          <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${dotColor}`} />
          <span className={late ? 'font-semibold text-rose-600' : 'text-slate-400'}>{statusLabel}</span>
        </p>
      </Body>

      {/* Outside the "open" button, not nested in it: a button inside a button is invalid HTML
          and the browser's own fix-up moves it out of the card entirely. Only for pending
          work - a completed task has nothing left to move or call off. */}
      {pending ? (
        <div className="flex shrink-0 flex-col items-end gap-1 text-[11px] font-medium">
          <button
            type="button"
            disabled={busy}
            onClick={() => onReschedule(task)}
            aria-label={`Reschedule ${title}`}
            className="min-h-6 font-semibold text-blue-600 hover:text-blue-700 disabled:opacity-50"
          >
            Reschedule
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => onCancel(task)}
            aria-label={`Cancel ${title}`}
            className="min-h-6 text-slate-400 hover:text-rose-600 transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
        </div>
      ) : null}
    </li>
  );
};

export default TaskCard;
