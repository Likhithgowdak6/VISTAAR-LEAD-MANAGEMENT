import { useState } from 'react';
import { createPortal } from 'react-dom';

import { createPersonalReminder } from '../../api/endpoints';
import { useAuth } from '../../auth/AuthContext';
import { useMobileBackLayer } from '../../hooks/useMobileBackLayer';
import { type AuthValue, errorMessage } from '../types';

/**
 * Creating a task from the Tasks screen.
 *
 * WHAT THIS CREATES, PRECISELY: a PERSONAL reminder - `POST /follow-ups`, which the API already
 * supports and which takes a title and a time and nothing else. It is assigned to whoever
 * created it, by the server, and has no lead attached.
 *
 * WHY NOT A LEAD-LINKED TASK. That endpoint exists too and is conversation-scoped
 * (`POST /conversations/:id/follow-ups`), so offering it here would need a customer picker -
 * a searchable list of conversations inside this dialog - which is a feature of its own rather
 * than a field. Rather than ship half of one, this creates the kind of task that needs no
 * picker, and lead follow-ups continue to be created from the lead's own panel where the lead
 * is already chosen. Noted as a limitation rather than faked.
 *
 * THE TIMEZONE IS SENT. `datetime-local` is read in the browser's zone - the zone the person
 * choosing it is standing in - and converted to an absolute instant before it leaves. The zone
 * name travels alongside so the reminder is later displayed in the zone it was set in, which is
 * the same thing RescheduleReminderDialog does.
 */

type Props = {
  onClose: () => void;
  /** Fired after a successful create, so the list and its counts refetch. */
  onCreated: () => void;
};

const CreateTaskDialog = ({ onClose, onCreated }: Props) => {
  const { authedRequest } = useAuth() as AuthValue;
  useMobileBackLayer({ active: true, onBack: onClose });

  const [title, setTitle] = useState('');
  const [dueAt, setDueAt] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();

    if (busy) {
      // The button is disabled too, but a form can still be submitted from the keyboard while
      // a request is in flight - and a duplicate here is a second reminder that will ring.
      return;
    }

    const trimmed = title.trim();
    const parsed = new Date(dueAt);

    if (!trimmed) {
      setError('Give the task a title.');
      return;
    }

    if (dueAt === '' || Number.isNaN(parsed.getTime())) {
      setError('Pick a date and time.');
      return;
    }

    if (parsed.getTime() <= Date.now()) {
      setError('That time has already passed.');
      return;
    }

    setBusy(true);
    setError(null);

    try {
      await authedRequest((token) =>
        createPersonalReminder({
          token,
          title: trimmed,
          dueAt: parsed.toISOString(),
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        }),
      );

      onCreated();
      onClose();
    } catch (createError: unknown) {
      // The form keeps what was typed: a failed save must not cost the typing, and nothing
      // here may suggest a task exists when the request did not land.
      setError(errorMessage(createError, 'Unable to create the task.'));
      setBusy(false);
    }
  };

  return createPortal(
    <div
      data-mobile-sheet-backdrop
      className="fixed inset-0 z-20 flex items-center justify-center bg-ink/70 p-4"
      onClick={onClose}
    >
      <form
        onSubmit={submit}
        role="dialog"
        aria-modal="true"
        aria-label="New task"
        data-mobile-sheet
        onClick={(event) => event.stopPropagation()}
        className="w-full max-w-sm rounded-2xl border border-line bg-panel p-6"
      >
        <h3 className="text-base font-semibold text-bone">New task</h3>
        <p className="mt-1 text-xs text-muted">
          A personal reminder for you. To add one against a customer, open their lead.
        </p>

        <label className="mt-4 block">
          <span className="text-xs font-semibold uppercase tracking-wide text-muted">Title</span>
          <input
            type="text"
            aria-label="Task title"
            value={title}
            onChange={(event) => {
              setTitle(event.target.value);
              setError(null);
            }}
            maxLength={200}
            placeholder="What needs doing?"
            className="mt-1 w-full rounded-lg border border-line bg-ink px-3 py-2 text-sm text-bone"
          />
        </label>

        <label className="mt-3 block">
          <span className="text-xs font-semibold uppercase tracking-wide text-muted">When</span>
          <input
            type="datetime-local"
            aria-label="Task due time"
            value={dueAt}
            onChange={(event) => {
              setDueAt(event.target.value);
              setError(null);
            }}
            className="mt-1 w-full rounded-lg border border-line bg-ink px-3 py-2 text-sm text-bone"
          />
        </label>

        {error ? (
          <p role="alert" className="mt-2 text-xs text-key">
            {error}
          </p>
        ) : null}

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-lg border border-line px-3 py-1.5 text-sm font-medium text-bone disabled:opacity-60"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy}
            className="rounded-lg bg-key px-3 py-1.5 text-sm font-semibold text-ink disabled:opacity-60"
          >
            {busy ? 'Adding…' : 'Add task'}
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
};

export default CreateTaskDialog;
