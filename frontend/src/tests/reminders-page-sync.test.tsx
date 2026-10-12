/**
 * Every mutation on the reminders screen must re-arm this handset's alarms.
 *
 * THE PRODUCTION FAILURE THIS EXISTS FOR. Alarms are armed by the sync pass and by nothing else.
 * The sync pass ran on app startup and on returning to the foreground - neither of which happens
 * when the owner is already looking at this screen and types a reminder into it. So the list
 * refreshed, the server stored it, the backend's WhatsApp message went out on time, and the
 * alarm the owner was actually waiting for was never handed to the OS at all. It looked like a
 * notification-delivery problem and was really a "nothing was ever scheduled" problem.
 *
 * Completing and cancelling matter for the mirror-image reason: those have to CANCEL an armed
 * alarm, or a reminder you already dealt with still goes off.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  syncReminders: vi.fn(),
  createPersonalReminder: vi.fn(),
  completeFollowUp: vi.fn(),
  cancelFollowUp: vi.fn(),
  rescheduleFollowUp: vi.fn(),
  useAuth: vi.fn(),
}));

vi.mock('../api/endpoints', () => ({
  syncReminders: mocks.syncReminders,
  createPersonalReminder: mocks.createPersonalReminder,
  completeFollowUp: mocks.completeFollowUp,
  cancelFollowUp: mocks.cancelFollowUp,
  rescheduleFollowUp: mocks.rescheduleFollowUp,
}));

vi.mock('../auth/AuthContext', () => ({ useAuth: mocks.useAuth }));

const RemindersPage = (await import('../pages/RemindersPage')).default;

const reminder = (overrides: Record<string, unknown> = {}) => ({
  id: 'task-1',
  version: 1,
  title: 'Call Rahul',
  note: null,
  dueAt: '2099-01-01T11:30:00.000Z',
  timezone: 'Asia/Kolkata',
  status: 'pending',
  conversationId: null,
  source: 'manual',
  schedulable: true,
  ...overrides,
});

const renderPage = (reminders: Record<string, unknown>[] = [reminder()]) => {
  const onSyncAlarms = vi.fn(async () => undefined);

  mocks.useAuth.mockReturnValue({
    authedRequest: (make: (token: string | null) => Promise<unknown>) => make('token'),
  });
  mocks.syncReminders.mockResolvedValue({ data: { reminders, syncedAt: null } });
  mocks.createPersonalReminder.mockResolvedValue({ data: {} });
  mocks.completeFollowUp.mockResolvedValue({ data: {} });
  mocks.cancelFollowUp.mockResolvedValue({ data: {} });

  render(<RemindersPage onSyncAlarms={onSyncAlarms} />);

  return { onSyncAlarms };
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('PRODUCTION DEFECT: a reminder created in the app never rang', () => {
  it('re-arms the alarms after creating a reminder', async () => {
    const { onSyncAlarms } = renderPage([]);

    await waitFor(() => expect(mocks.syncReminders).toHaveBeenCalled());

    fireEvent.change(screen.getByPlaceholderText('Call the venue back'), {
      target: { value: 'Test' },
    });
    fireEvent.change(screen.getByLabelText(/when/i), {
      target: { value: '2099-01-01T14:20' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add reminder' }));

    await waitFor(() => expect(mocks.createPersonalReminder).toHaveBeenCalledTimes(1));

    // THE ASSERTION THE PRODUCTION BUG WOULD FAIL. Creating used to refresh the list and stop.
    await waitFor(() => expect(onSyncAlarms).toHaveBeenCalledTimes(1));
  });

  it('re-arms the alarms after completing one, so a dealt-with reminder stops ringing', async () => {
    const { onSyncAlarms } = renderPage();

    await waitFor(() => expect(screen.getByText('Call Rahul')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Done' }));

    await waitFor(() => expect(mocks.completeFollowUp).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onSyncAlarms).toHaveBeenCalledTimes(1));
  });

  it('does not sync when the create was rejected', async () => {
    const { onSyncAlarms } = renderPage([]);

    await waitFor(() => expect(mocks.syncReminders).toHaveBeenCalled());

    // No title and no time: the screen refuses before it calls the API, so there is nothing new
    // to arm and a sync here would only be noise.
    fireEvent.click(screen.getByRole('button', { name: 'Add reminder' }));

    await waitFor(() => expect(screen.getByText(/needs a title and a time/i)).toBeInTheDocument());
    expect(mocks.createPersonalReminder).not.toHaveBeenCalled();
    expect(onSyncAlarms).not.toHaveBeenCalled();
  });

  it('survives a screen rendered without the callback', async () => {
    mocks.useAuth.mockReturnValue({
      authedRequest: (make: (token: string | null) => Promise<unknown>) => make('token'),
    });
    mocks.syncReminders.mockResolvedValue({ data: { reminders: [reminder()], syncedAt: null } });
    mocks.completeFollowUp.mockResolvedValue({ data: {} });

    // The browser build mounts this page too, where there is no handset to arm.
    render(<RemindersPage />);

    await waitFor(() => expect(screen.getByText('Call Rahul')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Done' }));

    await waitFor(() => expect(mocks.completeFollowUp).toHaveBeenCalledTimes(1));
  });
});
