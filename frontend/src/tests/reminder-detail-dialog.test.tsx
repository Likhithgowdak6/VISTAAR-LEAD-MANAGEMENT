/**
 * The reminder a WhatsApp notification was actually about.
 *
 * WHAT THESE PROVE, AND WHAT THEY DO NOT. The dialog reads the LEAD'S OWN follow-up list and
 * picks one id out of it - there is no by-id endpoint and this deliberately does not add one.
 * So the scoping test below is not decoration: it is the whole authorisation story. A reminder
 * that is not in the conversation the link named cannot be opened by pairing its id with a
 * conversation you happen to be allowed to see, because it simply is not in that list. The
 * organisation scoping itself is the conversation route's existing, unchanged behaviour.
 */
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import ReminderDetailDialog from '../components/reminders/ReminderDetailDialog';
import * as endpointsApi from '../api/endpoints';
import { PERMISSIONS } from '../lib/permissions';
import { AUTH_PAYLOAD, renderAuthed } from './lead-helpers';

// Tests may use `any` for Vitest mocks of untyped endpoint modules.
const endpoints = endpointsApi as any;

vi.mock('../api/endpoints');

const CONVERSATION_ID = '68f1a2b3c4d5e6f708192a3b';
const TASK_ID = '6adf2dd59f91cdd63f09e0f3';

const reminder = (overrides: Record<string, unknown> = {}) => ({
  id: TASK_ID,
  conversationId: CONVERSATION_ID,
  title: 'Follow-up call',
  type: 'call',
  priority: 'high',
  status: 'pending',
  source: 'lead_commitment',
  sourceQuote: 'call me after 5',
  note: 'Quote for the Goa shoot',
  dueAt: new Date(Date.now() + 86_400_000).toISOString(),
  ...overrides,
});

const signedIn = () =>
  endpoints.refresh.mockResolvedValue(
    AUTH_PAYLOAD({ role: 'admin', permissions: [PERMISSIONS.CRM_TASKS_MANAGE] }),
  );

const open = (props: { onClose?: () => void; onChanged?: () => void } = {}) =>
  renderAuthed(
    <ReminderDetailDialog
      reminderId={TASK_ID}
      conversationId={CONVERSATION_ID}
      onClose={() => {}}
      {...props}
    />,
  );

afterEach(() => {
  vi.clearAllMocks();
});

describe('showing the reminder', () => {
  it('shows what the notification was about', async () => {
    signedIn();
    endpoints.listConversationFollowUps.mockResolvedValue({ data: [reminder()] });
    endpoints.getConversation.mockResolvedValue({
      data: { conversation: { displayName: 'Vaishu', leadId: 'L-1042' } },
    });

    open();

    // The task, its reason, its note, its status and the lead it belongs to - the five things
    // the brief asks a reminder view to answer.
    expect(await screen.findByText('Follow-up call')).toBeInTheDocument();
    expect(await screen.findByText(/call me after 5/)).toBeInTheDocument();
    expect(screen.getByText('Quote for the Goa shoot')).toBeInTheDocument();
    expect(screen.getByText(/Still open/)).toBeInTheDocument();
    expect(await screen.findByText(/Vaishu/)).toBeInTheDocument();
    expect(screen.getByText(/L-1042/)).toBeInTheDocument();
  });

  it('SCOPES THE LOOKUP TO THE LEAD THE LINK NAMED', async () => {
    signedIn();
    endpoints.listConversationFollowUps.mockResolvedValue({ data: [reminder()] });

    open();

    await waitFor(() =>
      expect(endpoints.listConversationFollowUps).toHaveBeenCalledWith(
        expect.objectContaining({ conversationId: CONVERSATION_ID }),
      ),
    );
  });

  it('says so plainly when the reminder is not in that lead’s list', async () => {
    // Deleted, or an id paired with a conversation it does not belong to. Both are the same
    // event from the owner's side, and neither is an error screen.
    signedIn();
    endpoints.listConversationFollowUps.mockResolvedValue({
      data: [reminder({ id: '6adf2dd59f91cdd63f09e0ff' })],
    });

    open();

    expect(await screen.findByText(/no longer here/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Complete' })).toBeNull();
  });

  it('still renders a reminder that has no due time recorded', async () => {
    signedIn();
    endpoints.listConversationFollowUps.mockResolvedValue({ data: [reminder({ dueAt: null })] });

    open();

    expect(await screen.findByText('No due time recorded')).toBeInTheDocument();
  });

  it('offers no actions on a reminder that is already closed', async () => {
    signedIn();
    endpoints.listConversationFollowUps.mockResolvedValue({
      data: [reminder({ status: 'completed' })],
    });

    open();

    expect(await screen.findByText(/Completed/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Complete' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reschedule' })).toBeNull();
  });

  it('SHOWS THE REMINDER EVEN IF THE LEAD LOOKUP FAILS', async () => {
    // A missing name costs one line of context. It must not stop the reminder being acted on.
    signedIn();
    endpoints.listConversationFollowUps.mockResolvedValue({ data: [reminder()] });
    endpoints.getConversation.mockRejectedValue(new Error('offline'));

    open();

    expect(await screen.findByText('Follow-up call')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Complete' })).toBeInTheDocument();
  });
});

describe('acting on it', () => {
  it('completes the reminder, tells the shell, and closes', async () => {
    signedIn();
    endpoints.listConversationFollowUps.mockResolvedValue({ data: [reminder()] });
    endpoints.completeFollowUp.mockResolvedValue({ data: reminder({ status: 'completed' }) });
    const onClose = vi.fn();
    const onChanged = vi.fn();

    open({ onClose, onChanged });

    fireEvent.click(await screen.findByRole('button', { name: 'Complete' }));

    await waitFor(() =>
      expect(endpoints.completeFollowUp).toHaveBeenCalledWith(
        expect.objectContaining({ taskId: TASK_ID }),
      ),
    );
    // Both halves: re-arm the device alarms and refresh the panel behind, then get out of the
    // way. A dialog left hanging over a completed reminder is the thing this avoids.
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(onClose).toHaveBeenCalled();
  });

  it('asks before cancelling, and does nothing if the answer is no', async () => {
    signedIn();
    endpoints.listConversationFollowUps.mockResolvedValue({ data: [reminder()] });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);

    open();

    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));

    expect(confirm).toHaveBeenCalled();
    expect(endpoints.cancelFollowUp).not.toHaveBeenCalled();
    confirm.mockRestore();
  });

  it('STAYS OPEN WHEN THE REQUEST FAILS, saying why', async () => {
    // Closing on a failure would claim the reminder was dealt with when it was not.
    signedIn();
    endpoints.listConversationFollowUps.mockResolvedValue({ data: [reminder()] });
    endpoints.completeFollowUp.mockRejectedValue(new Error('Network down'));
    const onClose = vi.fn();
    const onChanged = vi.fn();

    open({ onClose, onChanged });

    fireEvent.click(await screen.findByRole('button', { name: 'Complete' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Network down');
    expect(onClose).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('reschedules through the same dialog the lead panel uses', async () => {
    signedIn();
    endpoints.listConversationFollowUps.mockResolvedValue({ data: [reminder()] });
    endpoints.rescheduleFollowUp.mockResolvedValue({ data: reminder() });

    open();

    fireEvent.click(await screen.findByRole('button', { name: 'Reschedule' }));

    const field = await screen.findByLabelText('New reminder time');
    const future = new Date(Date.now() + 172_800_000);
    const local = new Date(future.getTime() - future.getTimezoneOffset() * 60_000);
    fireEvent.change(field, { target: { value: local.toISOString().slice(0, 16) } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(endpoints.rescheduleFollowUp).toHaveBeenCalledWith(
        expect.objectContaining({ taskId: TASK_ID }),
      ),
    );
  });
});

describe('without crm.tasks.manage', () => {
  it('RENDERS NOTHING AND FETCHES NOTHING', async () => {
    // The link still opens the lead; this just adds nothing on top of it. The list endpoint
    // behind this would refuse anyway, so asking it would only produce an error to display.
    endpoints.refresh.mockResolvedValue(AUTH_PAYLOAD({ role: 'staff', permissions: [] }));

    open();

    await waitFor(() => expect(endpoints.refresh).toHaveBeenCalled());
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(endpoints.listConversationFollowUps).not.toHaveBeenCalled();
  });
});
