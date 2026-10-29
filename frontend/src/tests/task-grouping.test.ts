/**
 * Which section a task lands in, and what its due line says.
 *
 * THE TWO QUESTIONS ARE NOT THE SAME QUESTION, which is the whole reason this module exists
 * separately from the page:
 *
 *   "Is it overdue" is about an INSTANT. Either the due moment has passed or it has not. No
 *   calendar, no zone, nothing to get wrong - and the lead panel judges it the same way, so the
 *   two screens cannot disagree about the same reminder.
 *
 *   "Is it due today" is about a CALENDAR DAY, and so it needs a zone. It uses the VIEWER'S
 *   local day, not the reminder's stored timezone and not UTC. The UTC test below is the one
 *   that matters: the naive implementation passes every other test in this file and still puts
 *   tomorrow's reminder under "Due today" for half the evening in India.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  classifyTask,
  formatDueLabel,
  groupTasks,
  isTaskOverdue,
  taskStatusLabel,
} from '../lib/task-grouping';
import { type TaskListItem } from '../types';

const originalTz = process.env.TZ;

// Pinned so "local day" is a fixed, checkable thing rather than whatever the machine running
// the suite happens to be set to. Asia/Kolkata is the studio's own zone and is +05:30, which
// is also an offset that catches half-hour mistakes.
beforeAll(() => {
  process.env.TZ = 'Asia/Kolkata';
});

afterAll(() => {
  process.env.TZ = originalTz;
});

const task = (overrides: Partial<TaskListItem> = {}): TaskListItem =>
  ({
    id: '6adf2dd59f91cdd63f09e0f3',
    conversationId: '68f1a2b3c4d5e6f708192a3b',
    title: 'Call vaishu',
    type: 'call',
    status: 'pending',
    dueAt: '2026-10-30T10:00:00.000Z',
    lead: { conversationId: '68f1a2b3c4d5e6f708192a3b', displayName: 'vaishu', leadId: 'L-1' },
    ...overrides,
  }) as TaskListItem;

/** 09:00 IST on 30 October 2026. */
const NOW = new Date('2026-10-30T03:30:00.000Z').getTime();

describe('overdue', () => {
  it('is a pending task whose due instant has passed', () => {
    expect(isTaskOverdue(task({ dueAt: '2026-10-30T03:29:00.000Z' }), NOW)).toBe(true);
    expect(classifyTask(task({ dueAt: '2026-10-30T03:29:00.000Z' }), NOW)).toBe('overdue');
  });

  it('IS NEVER A CLOSED TASK, however long ago it was due', () => {
    // A reminder completed last week is history, not work. Showing it under Overdue would put
    // finished items at the top of the screen for ever.
    expect(isTaskOverdue(task({ status: 'completed', dueAt: '2026-10-01T00:00:00.000Z' }), NOW)).toBe(
      false,
    );
    expect(classifyTask(task({ status: 'cancelled', dueAt: '2026-10-01T00:00:00.000Z' }), NOW)).toBe(
      'closed',
    );
  });

  it('treats the due instant itself as due', () => {
    expect(isTaskOverdue(task({ dueAt: new Date(NOW).toISOString() }), NOW)).toBe(true);
  });
});

describe('due today', () => {
  it('is the same local calendar day', () => {
    // 14:00 IST, later the same day.
    expect(classifyTask(task({ dueAt: '2026-10-30T08:30:00.000Z' }), NOW)).toBe('today');
  });

  it('USES THE VIEWER’S DAY, NOT UTC', () => {
    // 2026-10-30T19:00Z is 00:30 IST on the 31st - tomorrow for the person reading the screen,
    // even though it is still the 30th in UTC. A UTC-based implementation calls this "today"
    // and the owner is told a reminder is due today when it is not.
    expect(classifyTask(task({ dueAt: '2026-10-30T19:00:00.000Z' }), NOW)).toBe('upcoming');
  });

  it('counts a late-evening local time as today', () => {
    // 23:30 IST on the 30th = 18:00Z. Same local day, so it belongs under Due today.
    expect(classifyTask(task({ dueAt: '2026-10-30T18:00:00.000Z' }), NOW)).toBe('today');
  });
});

describe('upcoming', () => {
  it('is any later day', () => {
    expect(classifyTask(task({ dueAt: '2026-11-02T09:30:00.000Z' }), NOW)).toBe('upcoming');
  });

  it('KEEPS A PENDING TASK THAT HAS NO DUE TIME', () => {
    // A real row in this schema. It is not overdue (nothing has passed) and not today, so
    // without this branch it would be silently dropped from every section.
    expect(classifyTask(task({ dueAt: null }), NOW)).toBe('upcoming');
  });
});

describe('the due line', () => {
  it('shows the clock time when it went late today', () => {
    expect(formatDueLabel(task({ dueAt: '2026-10-30T03:00:00.000Z' }), NOW)).toMatch(/^Overdue /);
  });

  it('counts whole days once it is older than today', () => {
    expect(formatDueLabel(task({ dueAt: '2026-10-29T03:00:00.000Z' }), NOW)).toBe('Overdue 1d');
    expect(formatDueLabel(task({ dueAt: '2026-10-28T03:00:00.000Z' }), NOW)).toBe('Overdue 2d');
  });

  it('says Today for work still ahead of you today', () => {
    expect(formatDueLabel(task({ dueAt: '2026-10-30T08:30:00.000Z' }), NOW)).toMatch(/^Today /);
  });

  it('says so plainly when there is no due time', () => {
    expect(formatDueLabel(task({ dueAt: null }), NOW)).toBe('No due time');
  });
});

describe('the status word', () => {
  it('calls an overdue pending task Late', () => {
    expect(taskStatusLabel(task({ dueAt: '2026-10-29T03:00:00.000Z' }), NOW)).toBe('Late');
  });

  it('reads Pending, Done and Cancelled otherwise', () => {
    expect(taskStatusLabel(task({ dueAt: '2026-11-02T09:30:00.000Z' }), NOW)).toBe('Pending');
    expect(taskStatusLabel(task({ status: 'completed' }), NOW)).toBe('Done');
    expect(taskStatusLabel(task({ status: 'cancelled' }), NOW)).toBe('Cancelled');
  });
});

describe('grouping a page', () => {
  it('splits into the four sections and loses nothing', () => {
    const rows = [
      task({ id: '1', dueAt: '2026-10-29T03:00:00.000Z' }),
      task({ id: '2', dueAt: '2026-10-30T08:30:00.000Z' }),
      task({ id: '3', dueAt: '2026-11-02T09:30:00.000Z' }),
      task({ id: '4', status: 'completed' }),
    ];

    const grouped = groupTasks(rows, NOW);

    expect(grouped.overdue.map((row) => row.id)).toEqual(['1']);
    expect(grouped.today.map((row) => row.id)).toEqual(['2']);
    expect(grouped.upcoming.map((row) => row.id)).toEqual(['3']);
    expect(grouped.closed.map((row) => row.id)).toEqual(['4']);
  });

  it('PRESERVES THE SERVER’S ORDER inside each section', () => {
    // The server orders overdue-first then soonest-due, with a total order on _id - which is
    // what makes pagination stable. Re-sorting here would only reorder the rows that happen to
    // be loaded, and page 2 would disagree with page 1.
    const rows = [
      task({ id: 'b', dueAt: '2026-10-28T03:00:00.000Z' }),
      task({ id: 'a', dueAt: '2026-10-29T03:00:00.000Z' }),
    ];

    expect(groupTasks(rows, NOW).overdue.map((row) => row.id)).toEqual(['b', 'a']);
  });
});
