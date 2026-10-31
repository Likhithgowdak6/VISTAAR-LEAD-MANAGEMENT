import { useState } from 'react';

import { deleteCallAnalysis, deleteCallRecording } from '../../api/endpoints';
import { useAuth } from '../../auth/AuthContext';
import { hasPermission, PERMISSIONS } from '../../lib/permissions';
import { type AuthValue, errorMessage } from '../types';

/**
 * Destroying a call's recording, or its transcript and summary.
 *
 * THE CONFIRMATION SPELLS OUT WHAT GOES AND WHAT STAYS, and that second half is the part that
 * matters. "Delete analysis" could easily be read as "undo everything the AI did to this lead",
 * and an agent who believed that would be surprised to find the reminders it suggested still
 * sitting in Tasks. So the dialog says so: tasks already added are kept, and are cancelled in
 * Tasks where the action says what it does.
 *
 * GATED ON conversations.delete, which in this codebase already means "may remove a lead's
 * data" and is deliberately withheld from `staff`. The route enforces the same thing - this is
 * the courtesy half, so the button is not offered to somebody who would only get a 403.
 *
 * TWO-STEP, NOT window.confirm. A browser confirm cannot explain what survives, and this is
 * irreversible destruction of a record of a conversation with a real person.
 */

type Props = {
  callId: string;
  kind: 'recording' | 'analysis';
  onDeleted: () => void;
};

const COPY = {
  recording: {
    trigger: 'Delete recording',
    heading: 'Delete this recording?',
    body: 'The audio file is destroyed and cannot be recovered. The call itself, its transcript and its summary are kept.',
    confirm: 'Delete the audio',
  },
  analysis: {
    trigger: 'Delete transcript & summary',
    heading: 'Delete the transcript and summary?',
    body: 'The transcript, the AI summary and any suggestions not yet actioned are destroyed. The recording is kept, and tasks you already added stay in Tasks — cancel those there if you want them gone.',
    confirm: 'Delete them',
  },
} as const;

const DeleteCallDataAction = ({ callId, kind, onDeleted }: Props) => {
  const { authedRequest, permissions } = useAuth() as AuthValue;
  const canDelete = hasPermission(permissions, PERMISSIONS.CONVERSATIONS_DELETE);

  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!canDelete) {
    return null;
  }

  const copy = COPY[kind];

  const run = async () => {
    if (busy) {
      return;
    }

    setBusy(true);
    setError(null);

    try {
      // Widened to `unknown`: the two endpoints return different shapes and neither result is
      // used - the dialog refetches rather than patching state from a response.
      await authedRequest<unknown>((token) =>
        kind === 'recording'
          ? deleteCallRecording({ token, callId })
          : deleteCallAnalysis({ token, callId }),
      );

      setConfirming(false);
      onDeleted();
    } catch (deleteError: unknown) {
      /*
       * STAYS OPEN ON FAILURE, showing the server's message.
       *
       * For a recording the server's failure specifically means the audio is STILL THERE -
       * it deletes the object before clearing the reference and refuses to report a success it
       * has not earned. Closing the dialog here would leave the agent believing it was gone.
       */
      setError(errorMessage(deleteError, 'That could not be deleted.'));
      setBusy(false);
    }
  };

  if (!confirming) {
    return (
      <button
        type="button"
        onClick={() => setConfirming(true)}
        className="min-h-9 text-[11px] font-medium text-red-600 hover:text-red-700"
      >
        {copy.trigger}
      </button>
    );
  }

  return (
    <div role="alertdialog" aria-label={copy.heading} className="rounded-lg border border-red-200 bg-red-50 p-2">
      <p className="text-xs font-semibold text-red-800">{copy.heading}</p>
      <p className="mt-1 text-[11px] text-red-700">{copy.body}</p>

      {error ? (
        <p role="alert" className="mt-1 text-[11px] font-medium text-red-800">
          {error}
        </p>
      ) : null}

      <div className="mt-2 flex gap-3 text-[11px] font-medium">
        <button
          type="button"
          disabled={busy}
          onClick={() => void run()}
          className="min-h-9 rounded-lg bg-red-600 px-2 text-white disabled:opacity-60"
        >
          {busy ? 'Deleting…' : copy.confirm}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setConfirming(false);
            setError(null);
          }}
          className="min-h-9 text-slate-600 hover:text-slate-800 disabled:opacity-60"
        >
          Keep it
        </button>
      </div>
    </div>
  );
};

export default DeleteCallDataAction;
