import { useState } from 'react';

/**
 * Moves a reminder to a new time.
 *
 * Replaces a `window.prompt`, which could not be validated before it closed, could not show an
 * API error, and gave a screen reader nothing to work with. Same modal shape as the rest of
 * this app - overlay, labelled `role="dialog"`, confirm on the right.
 *
 * TIMEZONE: the `datetime-local` value is read in the BROWSER's zone, which is the zone the
 * person choosing it is standing in, and converted to an absolute instant with `toISOString()`
 * before it leaves. The server stores that instant. No second conversion is attempted here -
 * the reminder's own stored timezone is for DISPLAY, and re-interpreting the input against it
 * would move the reminder to an hour the owner did not pick.
 */
interface Props {
  title: string;
  /** The current due time, ISO. Pre-fills the field so a small change is a small edit. */
  dueAt: string;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onSave: (dueAtIso: string) => void;
}

/** ISO instant -> the `YYYY-MM-DDTHH:mm` a datetime-local input wants, in local time. */
export const toLocalInputValue = (iso: string): string => {
  const date = new Date(iso);

  if (Number.isNaN(date.getTime())) {
    return '';
  }

  // Shift by the offset so `toISOString` yields local wall-clock rather than UTC.
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);

  return local.toISOString().slice(0, 16);
};

const RescheduleReminderDialog = ({ title, dueAt, busy, error, onCancel, onSave }: Props) => {
  const [value, setValue] = useState(() => toLocalInputValue(dueAt));
  const [localError, setLocalError] = useState<string | null>(null);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();

    if (busy) {
      // Guards the double-tap: the button is disabled too, but a form can still be submitted
      // with the keyboard while a request is in flight.
      return;
    }

    const parsed = new Date(value);

    if (value === '' || Number.isNaN(parsed.getTime())) {
      setLocalError('Pick a date and time.');
      return;
    }

    if (parsed.getTime() <= Date.now()) {
      setLocalError('That time has already passed.');
      return;
    }

    setLocalError(null);
    onSave(parsed.toISOString());
  };

  return (
    <div
      role="dialog"
      aria-label={`Reschedule ${title}`}
      className="fixed inset-0 z-10 flex items-center justify-center bg-ink/70 p-4"
    >
      <form onSubmit={submit} className="w-full max-w-sm rounded-2xl border border-line bg-panel p-6">
        <h3 className="text-base font-semibold text-bone">Reschedule</h3>
        <p className="mt-1 truncate text-sm text-muted">{title}</p>

        <label className="mt-4 block">
          <span className="text-xs font-semibold uppercase tracking-wide text-muted">
            New time
          </span>
          <input
            type="datetime-local"
            aria-label="New reminder time"
            value={value}
            onChange={(event) => {
              setValue(event.target.value);
              setLocalError(null);
            }}
            className="mt-1 w-full rounded-lg border border-line bg-ink px-3 py-2 text-sm text-bone"
          />
        </label>

        {localError ?? error ? (
          <p role="alert" className="mt-2 text-xs text-key">
            {localError ?? error}
          </p>
        ) : null}

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
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
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </div>
  );
};

export default RescheduleReminderDialog;
