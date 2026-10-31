import { useState } from 'react';
import { createPortal } from 'react-dom';

import { recordCallOutcome } from '../../api/endpoints';
import { useAuth } from '../../auth/AuthContext';
import { useMobileBackLayer } from '../../hooks/useMobileBackLayer';
import { type AuthValue, type CallStatus, errorMessage } from '../types';

/**
 * Asking the agent what actually happened.
 *
 * WHY A HUMAN HAS TO ANSWER THIS AT ALL. Vistaar opens the phone's dialler and Android tells it
 * nothing afterwards - not whether the green button was pressed, not whether the customer
 * answered, not how long they spoke. Reading that needs READ_PHONE_STATE plus a foreground
 * service to survive the app being backgrounded during the call, which is a permission and a
 * Google Play commitment this phase deliberately does not make. So the CRM asks instead of
 * guessing, and a call stays `unknown` until somebody says otherwise.
 *
 * THE PRE-FILLED DURATION IS A SUGGESTION, NOT A MEASUREMENT. `awaySeconds` is how long the app
 * was in the background: it includes finding the contact in the dialler, the ringing, and any
 * wandering off afterwards. It is offered as a starting number because typing one from memory
 * is worse, and it is editable for exactly that reason. The server stores the two separately so
 * they can never be confused later.
 *
 * DISMISSIBLE WITHOUT ANSWERING. An agent walking back into a meeting should not be trapped in
 * a modal, and a forced answer is a guessed answer. Dismissing leaves the call `initiated` and
 * the timeline says the outcome was not recorded, which is true.
 */

type Props = {
  callId: string;
  /** Seconds the app spent backgrounded. Pre-fills the duration; never stored as one. */
  awaySeconds: number | null;
  onClose: () => void;
  onRecorded: () => void;
};

const toMinutes = (seconds: number | null): string =>
  seconds && seconds > 0 ? String(Math.max(1, Math.round(seconds / 60))) : '';

const CallOutcomeDialog = ({ callId, awaySeconds, onClose, onRecorded }: Props) => {
  const { authedRequest } = useAuth() as AuthValue;
  useMobileBackLayer({ active: true, onBack: onClose });

  const [minutes, setMinutes] = useState(() => toMinutes(awaySeconds));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (status: Exclude<CallStatus, 'initiated'>) => {
    if (busy) {
      return;
    }

    setBusy(true);
    setError(null);

    const parsed = Number.parseInt(minutes, 10);
    // A duration is only sent with `completed`. The server rejects it on any other outcome,
    // because "no answer, five minutes long" is a contradiction rather than extra detail.
    const durationSeconds =
      status === 'completed' && Number.isFinite(parsed) && parsed > 0 ? parsed * 60 : undefined;

    try {
      await authedRequest((token) =>
        recordCallOutcome({
          token,
          callId,
          status,
          durationSeconds,
          awaySeconds: awaySeconds ?? undefined,
        }),
      );

      onRecorded();
      onClose();
    } catch (saveError: unknown) {
      setError(errorMessage(saveError, 'Unable to save the call outcome.'));
      setBusy(false);
    }
  };

  return createPortal(
    <div
      data-mobile-sheet-backdrop
      className="fixed inset-0 z-20 flex items-center justify-center bg-slate-900/40 p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="How did the call go?"
        data-mobile-sheet
        onClick={(event) => event.stopPropagation()}
        className="w-full max-w-sm rounded-2xl bg-white p-4 shadow-xl"
      >
        <h3 className="text-base font-semibold text-slate-900">How did the call go?</h3>
        <p className="mt-1 text-xs text-slate-500">
          Vistaar can’t tell what happened after the dialler opened, so this is the only record.
        </p>

        <label className="mt-4 block">
          <span className="text-xs font-semibold uppercase tracking-wide text-slate-400">
            Roughly how long (minutes)
          </span>
          <input
            type="number"
            inputMode="numeric"
            min={1}
            max={240}
            aria-label="Call length in minutes"
            value={minutes}
            onChange={(event) => setMinutes(event.target.value)}
            placeholder="e.g. 5"
            className="mt-1 min-h-11 w-full rounded-lg border border-slate-300 px-3 text-sm text-slate-800"
          />
          {awaySeconds && awaySeconds > 0 ? (
            // Said out loud, so nobody mistakes the pre-filled figure for a measured one.
            <span className="mt-1 block text-[11px] text-slate-400">
              Suggested from the {Math.round(awaySeconds / 60)} min you were away — edit if that’s
              wrong.
            </span>
          ) : null}
        </label>

        {error ? (
          <p role="alert" className="mt-2 text-xs text-red-600">
            {error}
          </p>
        ) : null}

        <div className="mt-4 grid gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => void submit('completed')}
            className="min-h-11 rounded-lg bg-green-600 px-3 text-sm font-semibold text-white disabled:opacity-60"
          >
            We spoke
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void submit('failed')}
            className="min-h-11 rounded-lg border border-slate-300 px-3 text-sm font-medium text-slate-700 disabled:opacity-60"
          >
            No answer
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void submit('cancelled')}
            className="min-h-11 rounded-lg border border-slate-300 px-3 text-sm font-medium text-slate-700 disabled:opacity-60"
          >
            I didn’t call
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onClose}
            className="min-h-11 text-xs font-medium text-slate-500 hover:text-slate-700 disabled:opacity-60"
          >
            Skip for now
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
};

export default CallOutcomeDialog;
