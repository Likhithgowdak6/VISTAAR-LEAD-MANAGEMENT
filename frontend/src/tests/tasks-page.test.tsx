/**
 * The centralised Tasks screen.
 *
 * WHAT THESE COVER AND WHAT THEY DELIBERATELY DO NOT. The server decides scope, status,
 * ordering, pagination and the counts - that is tested against the aggregation itself in
 * organization-tasks.repository.test.ts, and the Team permission gate in
 * organization-tasks.service.test.ts. What is testable HERE is that the screen asks the right
 * question and shows the answer honestly: that a chip becomes a `status` parameter rather than
 * a client-side filter, that search is debounced into one request, that completing a task
 * refetches instead of patching a row, and that opening one lands on the right reminder.
 *
 * THE TEAM TAB IS A COURTESY, NOT A CONTROL. Hiding it from somebody without
 * conversations.read_all is tested below, but the real refusal is the server's - anybody can
 * type `?scope=team`. These tests assert the UI does its half; they do not pretend it is the
 * boundary.
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import TasksPage from '../pages/TasksPage';
import * as endpointsApi from '../api/endpoints';
import { PERMISSIONS } from '../lib/permissions';
import { AUTH_PAYLOAD, renderAuthed } from './lead-helpers';

// Tests may use `any` for Vitest mocks of untyped endpoint modules.
const endpoints = endpointsApi as any;

vi.mock('../api/endpoints');

const CONVERSATION_ID = '68f1a2b3c4d5e6f708192a3b';
const TASK_ID = '6adf2dd59f91cdd63f09e0f3';

const counts = (overrides: Record<string, number> = {}) => ({
  total: 35,
  pending: 20,
  overdue: 14,
  completed: 12,
  cancelled: 3,
  ...overrides,
});

const task = (overrides: Record<string, unknown> = {}) => ({
  id: TASK_ID,
  conversationId: CONVERSATION_ID,
  title: 'Call vaishu',
  type: 'call',
  priority: 'high',
  status: 'pending',
  source: 'manual',
  sourceQuote: null,
  note: null,
  dueAt: new Date(Date.now() - 3_600_000).toISOString(),
  lead: { conversationId: CONVERSATION_ID, displayName: 'vaishu', leadId: 'L-1042' },
  ...overrides,
});

const respond = (rows: unknown[], meta: Record<string, unknown> = {}) => ({
  data: rows,
  meta: { matched: rows.length, counts: counts(), ...meta },
});

const signedIn = (permissions: string[]) =>
  endpoints.refresh.mockResolvedValue(AUTH_PAYLOAD({ role: 'admin', permissions }));

const FULL = [PERMISSIONS.CRM_TASKS_MANAGE, PERMISSIONS.CONVERSATIONS_READ_ALL];
const OWN_ONLY = [PERMISSIONS.CRM_TASKS_MANAGE];

const render = (onOpenTask = vi.fn()) => {
  renderAuthed(<TasksPage onOpenTask={onOpenTask} />);
  return onOpenTask;
};

/** The query of the most recent list request. */
const lastQuery = () =>
  endpoints.listOrganizationTasks.mock.calls.at(-1)![0] as Record<string, unknown>;

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('permissions', () => {
  it('OFFERS NO TEAM TAB without conversations.read_all', async () => {
    signedIn(OWN_ONLY);
    endpoints.listOrganizationTasks.mockResolvedValue(respond([task()]));

    render();

    expect(await screen.findByRole('button', { name: 'Mine' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Team' })).toBeNull();
  });

  it('offers it with the permission, and asks the server for the team scope', async () => {
    signedIn(FULL);
    endpoints.listOrganizationTasks.mockResolvedValue(respond([task()]));

    render();

    fireEvent.click(await screen.findByRole('button', { name: 'Team' }));

    await waitFor(() => expect(lastQuery().scope).toBe('team'));
  });

  it('renders nothing usable without crm.tasks.manage', async () => {
    signedIn([]);

    render();

    expect(await screen.findByText(/not available for your role/i)).toBeInTheDocument();
    expect(endpoints.listOrganizationTasks).not.toHaveBeenCalled();
  });
});

describe('the counts', () => {
  it('shows the total in the headline and the rest on the chips', async () => {
    signedIn(FULL);
    endpoints.listOrganizationTasks.mockResolvedValue(respond([task()]));

    render();

    expect(await screen.findByText('35 tasks')).toBeInTheDocument();
    expect(within(screen.getByTestId('task-chip-late')).getByText('14')).toBeInTheDocument();
    expect(within(screen.getByTestId('task-chip-completed')).getByText('12')).toBeInTheDocument();
    expect(
      within(screen.getByTestId('task-chip-cancelled')).getByText('3'),
    ).toBeInTheDocument();
  });

  it('KEEPS SHOWING EVERY COUNT while one chip is selected', async () => {
    // The point of server-side counts: "Done 12" has to stay readable while you are looking at
    // the pending list. If the counts narrowed with the filter, each chip would show its own
    // count and the screen would lose its overview.
    signedIn(FULL);
    endpoints.listOrganizationTasks.mockResolvedValue(respond([task()]));

    render();

    fireEvent.click(await screen.findByTestId('task-chip-late'));

    await waitFor(() => expect(lastQuery().status).toBe('late'));
    expect(within(screen.getByTestId('task-chip-completed')).getByText('12')).toBeInTheDocument();
  });
});

describe('filtering', () => {
  it('sends the chip to the SERVER rather than filtering what is loaded', async () => {
    // Filtering client-side would only ever filter the current page, so "Done" would show the
    // completed rows that happened to be in the first 25 and claim that was all of them.
    signedIn(FULL);
    endpoints.listOrganizationTasks.mockResolvedValue(respond([task()]));

    render();

    fireEvent.click(await screen.findByTestId('task-chip-completed'));

    await waitFor(() => expect(lastQuery().status).toBe('completed'));
  });

  it('clears the filter when the active chip is tapped again', async () => {
    signedIn(FULL);
    endpoints.listOrganizationTasks.mockResolvedValue(respond([task()]));

    render();

    const chip = await screen.findByTestId('task-chip-pending');
    fireEvent.click(chip);
    await waitFor(() => expect(lastQuery().status).toBe('pending'));

    fireEvent.click(chip);
    await waitFor(() => expect(lastQuery().status).toBeNull());
  });

  it('DEBOUNCES SEARCH INTO ONE REQUEST', async () => {
    signedIn(FULL);
    endpoints.listOrganizationTasks.mockResolvedValue(respond([task()]));

    render();

    // Wait for the MOUNT fetch to have landed before counting. The search field renders on the
    // first paint, before the effect has fired, so capturing the baseline off its appearance
    // races the initial request - which is why this passed alone and failed under load.
    await screen.findByTestId('task-card');

    const field = screen.getByLabelText('Search tasks');
    const before = endpoints.listOrganizationTasks.mock.calls.length;

    fireEvent.change(field, { target: { value: 'v' } });
    fireEvent.change(field, { target: { value: 'va' } });
    fireEvent.change(field, { target: { value: 'vaishu' } });

    await vi.advanceTimersByTimeAsync(350);
    await waitFor(() => expect(lastQuery().search).toBe('vaishu'));

    /*
     * THREE KEYSTROKES, ONE REQUEST. Counted at the end rather than asserting "nothing has
     * fired yet" mid-way: these timers auto-advance with real time, so under a loaded full-suite
     * run the debounce can legitimately fire before the assertion does, and the test would fail
     * for reasons that have nothing to do with the behaviour.
     *
     * Undebounced, each keystroke is its own request - `before + 3` - so this still catches it,
     * and a request per keystroke is both wasted round trips and a race in which an earlier,
     * shorter term can land last and overwrite the results.
     */
    expect(endpoints.listOrganizationTasks.mock.calls.length).toBe(before + 1);
  });

  it('returns to the first page when a filter changes', async () => {
    // Keeping the offset would show page 3 of a list the owner has only just asked for, which
    // reads as an empty result.
    signedIn(FULL);
    endpoints.listOrganizationTasks.mockResolvedValue(
      respond([task()], { matched: 60 }),
    );

    render();

    fireEvent.click(await screen.findByRole('button', { name: /Load more/ }));
    await waitFor(() => expect(lastQuery().skip).toBe(25));

    fireEvent.click(screen.getByTestId('task-chip-completed'));
    await waitFor(() => expect(lastQuery().skip).toBe(0));
  });
});

describe('sections', () => {
  it('splits the page into Overdue, Due today and Upcoming', async () => {
    signedIn(FULL);
    endpoints.listOrganizationTasks.mockResolvedValue(
      respond([
        task({ id: 'a', title: 'Late one', dueAt: new Date(Date.now() - 7_200_000).toISOString() }),
        task({ id: 'b', title: 'Later today', dueAt: new Date(Date.now() + 3_600_000).toISOString() }),
        task({
          id: 'c',
          title: 'Next week',
          dueAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
        }),
      ]),
    );

    render();

    expect(await screen.findByText('Overdue')).toBeInTheDocument();
    expect(screen.getByText('Late one')).toBeInTheDocument();
    expect(screen.getByText('Upcoming')).toBeInTheDocument();
    expect(screen.getByText('Next week')).toBeInTheDocument();
  });
});

describe('pagination', () => {
  it('appends the next page rather than replacing the list', async () => {
    signedIn(FULL);
    endpoints.listOrganizationTasks
      .mockResolvedValueOnce(respond([task({ id: 'a', title: 'First page' })], { matched: 50 }))
      .mockResolvedValueOnce(respond([task({ id: 'b', title: 'Second page' })], { matched: 50 }));

    render();

    fireEvent.click(await screen.findByRole('button', { name: /Load more/ }));

    expect(await screen.findByText('Second page')).toBeInTheDocument();
    expect(screen.getByText('First page')).toBeInTheDocument();
  });

  it('hides Load more once everything is in', async () => {
    signedIn(FULL);
    endpoints.listOrganizationTasks.mockResolvedValue(respond([task()], { matched: 1 }));

    render();

    await screen.findByTestId('task-card');
    expect(screen.queryByRole('button', { name: /Load more/ })).toBeNull();
  });
});

describe('acting on a task', () => {
  it('completes it and REFETCHES rather than patching the row', async () => {
    // Completing moves a task between sections and changes four counts. A patched row would
    // leave the chips reporting numbers the list contradicts.
    signedIn(FULL);
    endpoints.listOrganizationTasks.mockResolvedValue(respond([task()]));
    endpoints.completeFollowUp.mockResolvedValue({ data: task({ status: 'completed' }) });

    render();

    fireEvent.click(await screen.findByRole('button', { name: 'Complete Call vaishu' }));

    await waitFor(() =>
      expect(endpoints.completeFollowUp).toHaveBeenCalledWith(
        expect.objectContaining({ taskId: TASK_ID }),
      ),
    );
    await waitFor(() => expect(endpoints.listOrganizationTasks.mock.calls.length).toBeGreaterThan(1));
  });

  it('asks before cancelling, and does nothing if the answer is no', async () => {
    signedIn(FULL);
    endpoints.listOrganizationTasks.mockResolvedValue(respond([task()]));
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);

    render();

    fireEvent.click(await screen.findByRole('button', { name: 'Cancel Call vaishu' }));

    expect(confirm).toHaveBeenCalled();
    expect(endpoints.cancelFollowUp).not.toHaveBeenCalled();
    confirm.mockRestore();
  });

  it('cancels when confirmed', async () => {
    signedIn(FULL);
    endpoints.listOrganizationTasks.mockResolvedValue(respond([task()]));
    endpoints.cancelFollowUp.mockResolvedValue({ data: task({ status: 'cancelled' }) });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);

    render();

    fireEvent.click(await screen.findByRole('button', { name: 'Cancel Call vaishu' }));

    await waitFor(() =>
      expect(endpoints.cancelFollowUp).toHaveBeenCalledWith(
        expect.objectContaining({ taskId: TASK_ID }),
      ),
    );
    confirm.mockRestore();
  });

  it('reschedules through the shared dialog, sending the zone it was chosen in', async () => {
    signedIn(FULL);
    endpoints.listOrganizationTasks.mockResolvedValue(respond([task()]));
    endpoints.rescheduleFollowUp.mockResolvedValue({ data: task() });

    render();

    fireEvent.click(await screen.findByRole('button', { name: 'Reschedule Call vaishu' }));

    const field = await screen.findByLabelText('New reminder time');
    const future = new Date(Date.now() + 172_800_000);
    const local = new Date(future.getTime() - future.getTimezoneOffset() * 60_000);
    fireEvent.change(field, { target: { value: local.toISOString().slice(0, 16) } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(endpoints.rescheduleFollowUp).toHaveBeenCalledWith(
        expect.objectContaining({ taskId: TASK_ID, timezone: expect.any(String) }),
      ),
    );
  });

  it('OPENS THE EXACT REMINDER, not just the lead', async () => {
    // The same payload the WhatsApp deep-link path produces, so a task opened here and a
    // reminder opened from a notification land identically.
    signedIn(FULL);
    endpoints.listOrganizationTasks.mockResolvedValue(respond([task()]));
    const onOpenTask = render();

    fireEvent.click(await screen.findByText('Call vaishu'));

    expect(onOpenTask).toHaveBeenCalledWith({
      conversationId: CONVERSATION_ID,
      reminderId: TASK_ID,
    });
  });

  it('gives a PERSONAL reminder no destination to open', async () => {
    // It belongs to no lead, and the reminder dialog finds a reminder through its conversation.
    // A tappable card that then does nothing is worse than a card that is plainly not tappable.
    signedIn(FULL);
    endpoints.listOrganizationTasks.mockResolvedValue(
      respond([task({ title: 'Review the campaign', conversationId: null, lead: null })]),
    );
    const onOpenTask = render();

    fireEvent.click(await screen.findByText('Review the campaign'));

    expect(onOpenTask).not.toHaveBeenCalled();
    // Its own actions still work - it can be completed, moved or called off.
    expect(screen.getByRole('button', { name: 'Complete Review the campaign' })).toBeInTheDocument();
  });
});

describe('loading, empty and error', () => {
  it('shows a spinner while the first page is in flight', async () => {
    signedIn(FULL);
    endpoints.listOrganizationTasks.mockReturnValue(new Promise(() => {}));

    render();

    expect(await screen.findByText('Loading tasks…')).toBeInTheDocument();
  });

  it('says there is nothing here, and how to add one', async () => {
    signedIn(FULL);
    endpoints.listOrganizationTasks.mockResolvedValue(
      respond([], { matched: 0, counts: counts({ total: 0 }) }),
    );

    render();

    expect(await screen.findByText('No tasks here')).toBeInTheDocument();
  });

  it('distinguishes an empty SEARCH from an empty list', async () => {
    signedIn(FULL);
    endpoints.listOrganizationTasks.mockResolvedValue(
      respond([], { matched: 0, counts: counts({ total: 0 }) }),
    );

    render();

    fireEvent.change(await screen.findByLabelText('Search tasks'), {
      target: { value: 'nobody' },
    });
    await vi.advanceTimersByTimeAsync(350);

    expect(await screen.findByText('Nothing matches that search')).toBeInTheDocument();
  });

  it('reports a failure and offers a retry', async () => {
    signedIn(FULL);
    endpoints.listOrganizationTasks.mockRejectedValue(new Error('Network down'));

    render();

    expect(await screen.findByRole('alert')).toHaveTextContent('Network down');

    endpoints.listOrganizationTasks.mockResolvedValue(respond([task()]));
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    expect(await screen.findByTestId('task-card')).toBeInTheDocument();
  });
});

describe('creating a task', () => {
  it('creates a personal reminder and refreshes the list', async () => {
    signedIn(FULL);
    endpoints.listOrganizationTasks.mockResolvedValue(respond([task()]));
    endpoints.createPersonalReminder.mockResolvedValue({ data: task() });

    render();

    fireEvent.click(await screen.findByRole('button', { name: 'New task' }));

    fireEvent.change(await screen.findByLabelText('Task title'), {
      target: { value: 'Review the campaign' },
    });
    const future = new Date(Date.now() + 172_800_000);
    const local = new Date(future.getTime() - future.getTimezoneOffset() * 60_000);
    fireEvent.change(screen.getByLabelText('Task due time'), {
      target: { value: local.toISOString().slice(0, 16) },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add task' }));

    await waitFor(() =>
      expect(endpoints.createPersonalReminder).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Review the campaign' }),
      ),
    );
  });

  it('REFUSES A TIME THAT HAS ALREADY PASSED', async () => {
    // A reminder set for the past never rings, and nothing downstream would say so.
    signedIn(FULL);
    endpoints.listOrganizationTasks.mockResolvedValue(respond([task()]));

    render();

    fireEvent.click(await screen.findByRole('button', { name: 'New task' }));
    fireEvent.change(await screen.findByLabelText('Task title'), {
      target: { value: 'Too late' },
    });
    const past = new Date(Date.now() - 86_400_000);
    const local = new Date(past.getTime() - past.getTimezoneOffset() * 60_000);
    fireEvent.change(screen.getByLabelText('Task due time'), {
      target: { value: local.toISOString().slice(0, 16) },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add task' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('already passed');
    expect(endpoints.createPersonalReminder).not.toHaveBeenCalled();
  });
});
