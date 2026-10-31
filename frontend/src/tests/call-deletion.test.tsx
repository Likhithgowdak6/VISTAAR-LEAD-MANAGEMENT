/**
 * Deleting a call's recording, or its transcript and summary, from the UI.
 *
 * TWO THINGS THIS FILE DEFENDS.
 *
 * THE CONFIRMATION MUST SAY WHAT SURVIVES. "Delete transcript & summary" reads to most people
 * as "undo everything the AI did here", and somebody who believed that would be surprised to
 * find the reminders it suggested still sitting in Tasks. The dialog has to say so in words.
 *
 * A FAILED DELETE MUST NOT LOOK LIKE A SUCCESSFUL ONE. The server deletes the audio object
 * before clearing its reference and refuses to report a success it has not earned - so a
 * failure here means the recording is STILL THERE, and the UI closing cheerfully would leave
 * the agent believing it was destroyed.
 */
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import DeleteCallDataAction from '../components/calls/DeleteCallDataAction';
import * as endpointsApi from '../api/endpoints';
import { PERMISSIONS } from '../lib/permissions';
import { AUTH_PAYLOAD, renderAuthed } from './lead-helpers';

// Tests may use `any` for Vitest mocks of untyped endpoint modules.
const endpoints = endpointsApi as any;

vi.mock('../api/endpoints');

const CALL_ID = '6adf2dd59f91cdd63f09e0f3';

const signedIn = (permissions: string[]) =>
  endpoints.refresh.mockResolvedValue(AUTH_PAYLOAD({ role: 'admin', permissions }));

const CAN_DELETE = [PERMISSIONS.CONVERSATIONS_DELETE, PERMISSIONS.CONVERSATIONS_READ_ALL];

const render = (kind: 'recording' | 'analysis', onDeleted = vi.fn()) => {
  renderAuthed(<DeleteCallDataAction callId={CALL_ID} kind={kind} onDeleted={onDeleted} />);
  return onDeleted;
};

afterEach(() => {
  vi.clearAllMocks();
});

describe('permissions', () => {
  it('OFFERS NOTHING without conversations.delete', async () => {
    // Reading a lead and destroying the evidence of what was said on it are different
    // privileges, and `staff` holds the first without the second. The route enforces the same.
    signedIn([PERMISSIONS.CONVERSATIONS_READ_ALL]);

    const { container } = renderAuthed(
      <DeleteCallDataAction callId={CALL_ID} kind="recording" onDeleted={vi.fn()} />,
    );

    await waitFor(() => expect(endpoints.refresh).toHaveBeenCalled());
    expect(container.querySelector('button')).toBeNull();
  });

  it('offers the action with the permission', async () => {
    signedIn(CAN_DELETE);

    render('recording');

    expect(await screen.findByRole('button', { name: 'Delete recording' })).toBeInTheDocument();
  });
});

describe('confirming', () => {
  it('DOES NOT DELETE ON THE FIRST CLICK', async () => {
    // Irreversible destruction of a record of a real conversation. One tap is not a decision.
    signedIn(CAN_DELETE);

    render('recording');

    fireEvent.click(await screen.findByRole('button', { name: 'Delete recording' }));

    expect(endpoints.deleteCallRecording).not.toHaveBeenCalled();
    expect(screen.getByText('Delete this recording?')).toBeInTheDocument();
  });

  it('says what the recording delete keeps', async () => {
    signedIn(CAN_DELETE);

    render('recording');

    fireEvent.click(await screen.findByRole('button', { name: 'Delete recording' }));

    expect(screen.getByText(/transcript and its summary are kept/)).toBeInTheDocument();
  });

  it('SAYS CONFIRMED TASKS SURVIVE the analysis delete', async () => {
    // The misreading this wording exists to prevent.
    signedIn(CAN_DELETE);

    render('analysis');

    fireEvent.click(await screen.findByRole('button', { name: 'Delete transcript & summary' }));

    expect(screen.getByText(/tasks you already added stay in Tasks/)).toBeInTheDocument();
    expect(screen.getByText(/recording is kept/)).toBeInTheDocument();
  });

  it('backing out deletes nothing', async () => {
    signedIn(CAN_DELETE);

    render('recording');

    fireEvent.click(await screen.findByRole('button', { name: 'Delete recording' }));
    fireEvent.click(screen.getByRole('button', { name: 'Keep it' }));

    expect(endpoints.deleteCallRecording).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Delete recording' })).toBeInTheDocument();
  });
});

describe('deleting', () => {
  it('deletes the recording after confirmation and reports back', async () => {
    signedIn(CAN_DELETE);
    endpoints.deleteCallRecording.mockResolvedValue({ data: { id: CALL_ID } });
    const onDeleted = render('recording');

    fireEvent.click(await screen.findByRole('button', { name: 'Delete recording' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete the audio' }));

    await waitFor(() =>
      expect(endpoints.deleteCallRecording).toHaveBeenCalledWith(
        expect.objectContaining({ callId: CALL_ID }),
      ),
    );
    await waitFor(() => expect(onDeleted).toHaveBeenCalled());
  });

  it('deletes the analysis, and NEVER the recording', async () => {
    signedIn(CAN_DELETE);
    endpoints.deleteCallAnalysis.mockResolvedValue({ data: { deleted: true } });

    render('analysis');

    fireEvent.click(await screen.findByRole('button', { name: 'Delete transcript & summary' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete them' }));

    await waitFor(() => expect(endpoints.deleteCallAnalysis).toHaveBeenCalled());
    expect(endpoints.deleteCallRecording).not.toHaveBeenCalled();
  });

  it('STAYS OPEN AND SHOWS WHY when the server refuses', async () => {
    // For a recording this specifically means the audio is still there. Closing cheerfully
    // would leave the agent believing it was destroyed.
    signedIn(CAN_DELETE);
    endpoints.deleteCallRecording.mockRejectedValue(
      new Error('The recording could not be deleted. It has not been removed — please try again.'),
    );
    const onDeleted = render('recording');

    fireEvent.click(await screen.findByRole('button', { name: 'Delete recording' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete the audio' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('has not been removed');
    expect(onDeleted).not.toHaveBeenCalled();
    // Still on the confirmation, so a retry is one tap away.
    expect(screen.getByRole('button', { name: 'Delete the audio' })).toBeInTheDocument();
  });

  it('allows a retry after a failure', async () => {
    signedIn(CAN_DELETE);
    endpoints.deleteCallRecording.mockRejectedValueOnce(new Error('Network down'));
    endpoints.deleteCallRecording.mockResolvedValue({ data: { id: CALL_ID } });
    const onDeleted = render('recording');

    fireEvent.click(await screen.findByRole('button', { name: 'Delete recording' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete the audio' }));
    await screen.findByRole('alert');

    fireEvent.click(screen.getByRole('button', { name: 'Delete the audio' }));

    await waitFor(() => expect(onDeleted).toHaveBeenCalled());
  });
});
