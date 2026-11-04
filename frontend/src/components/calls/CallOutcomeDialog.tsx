import { useState } from 'react';
import { createPortal } from 'react-dom';

import { recordConversationCallOutcome } from '../../api/endpoints';
import { useAuth } from '../../auth/AuthContext';
import { useMobileBackLayer } from '../../hooks/useMobileBackLayer';
import { type AuthValue, type CallOutcome, errorMessage } from '../types';

/**
 * What happened on the call, and what the AI is allowed to do about it.
 *
 * WHY A HUMAN HAS TO ANSWER THIS AT ALL. Vistaar opens the phone's dialler and Android tells it
 * nothing afterwards - not whether the green button was pressed, not whether the customer
 * answered, not how long they spoke. Reading that needs READ_PHONE_STATE plus a foreground
 * service, which is a permission and a Play-policy commitment this app deliberately does not
 * make. So the CRM asks instead of guessing.
 *
 * THE AI DECISION IS ON THIS SCREEN, NOT IN SETTINGS. The moment the owner knows how the call
 * went is the only moment they know whether the agent should pick the thread back up - "she is
 * thinking it over, leave her alone" is a fact that exists for about ten seconds. Burying that
 * behind a settings page means it is never answered, and an unanswered default is wrong in both
 * directions: on messages a customer the owner may have just promised to handle personally, off
 * silently strands a lead nobody is talking to. So it is asked here, and the server REFUSES an
 * outcome that should carry a decision and does not.
 *
 * THE EXPLANATION CHANGES WITH THE ANSWER on purpose. "Resume AI" means something different
 * after a booking than after "call me next week", and an owner who cannot tell those apart will
 * eventually let a sales agent loose on somebody who has already paid.
 *
 * NOT INTERESTED DOES NOT OFFER THE QUESTION. There is no version of "shall we keep messaging
 * them?" worth putting in front of somebody about a lead who just declined.
 */

type Props = {
  conversationId: string;
  /** The call being reported on, when the app's dialler placed it. */
  callId?: string | null;
  /** The reminder this answer came from, completed or moved by the server. */
  reminderTaskId?: string | null;
  /** Seconds the app spent backgrounded. Pre-fills the duration; never stored as one. */
  awaySeconds?: number | null;
  onClose: () => void;
  onRecorded: () => void;
};

interface OutcomeOption {
  value: CallOutcome;
  label: string;
  /** Whether to ask the AI question. Mirrors CALL_OUTCOME_RULES on the server. */
  offersAiResume: boolean;
  needsCallback: boolean;
  /** What saying yes will actually do, in the owner's terms. */
  resumeHint: string;
}

const OUTCOMES: readonly OutcomeOption[] = [
  {
    value: 'contacted',
    label: 'Contacted — customer answered',
    offersAiResume: true,
    needsCallback: false,
    resumeHint: 'the assistant picks the chat back up and carries on qualifying.',
  },
  {
    value: 'not_received',
    label: 'Call not received',
    offersAiResume: true,
    needsCallback: true,
    resumeHint: 'the assistant keeps the conversation warm while you try again.',
  },
  {
    value: 'call_later',
    label: 'Customer asked to call later',
    offersAiResume: true,
    needsCallback: true,
    resumeHint: 'the assistant stays in the chat until the callback.',
  },
  {
    value: 'interested',
    label: 'Interested — decision pending',
    offersAiResume: true,
    needsCallback: false,
    resumeHint: 'the assistant follows up helpfully, without pretending they have booked.',
  },
  {
    value: 'booking_confirmed',
    label: 'Booking confirmed',
    offersAiResume: true,
    needsCallback: false,
    // The one that is not "carry on selling", and the screen says so in as many words.
    resumeHint:
      'the assistant switches to post-booking messages only — thank-yous, confirming details, event reminders. It will not try to sell anything else.',
  },
  {
    value: 'not_interested',
    label: 'Not interested',
    offersAiResume: false,
    needsCallback: false,
    resumeHint: '',
  },
];

const CallOutcomeDialog = ({
  conversationId,
  callId = null,
  reminderTaskId = null,
  awaySeconds = null,
  onClose,
  onRecorded,
}: Props) => {
  const { authedRequest } = useAuth() as AuthValue;
  useMobileBackLayer({ active: true, onBack: onClose });

  const [outcome, setOutcome] = useState<CallOutcome | null>(null);
  const [resumeAi, setResumeAi] = useState<boolean | null>(null);
  const [callbackAt, setCallbackAt] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selected = OUTCOMES.find((option) => option.value === outcome) ?? null;

  // Mirrors the server's own refusal rather than relying on it: a disabled Save explains itself
  // better than a 422 does, and the server still refuses if this ever drifts.
  const canSave =
    selected !== null &&
    (!selected.offersAiResume || resumeAi !== null) &&
    (!selected.needsCallback || callbackAt !== '');

  const chooseOutcome = (next: CallOutcome) => {
    setOutcome(next);
    // Cleared, never carried over. An owner who picks "booking confirmed", answers yes, then
    // corrects themselves to "not interested" must not silently leave a yes behind it.
    setResumeAi(null);
    setCallbackAt('');
    setError(null);
  };

  const save = async () => {
    if (!selected || busy || !canSave) {
      return;
    }

    setBusy(true);
    setError(null);

    try {
      await authedRequest((token) =>
        recordConversationCallOutcome({
          token,
          conversationId,
          outcome: selected.value,
          resumeAi: selected.offersAiResume ? resumeAi === true : undefined,
          callbackAt: selected.needsCallback ? new Date(callbackAt).toISOString() : undefined,
          callId: callId ?? undefined,
          reminderTaskId: reminderTaskId ?? undefined,
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
        className="max-h-[90vh] w-full max-w-sm overflow-y-auto rounded-2xl bg-white p-4 shadow-xl"
      >
        <h3 className="text-base font-semibold text-slate-900">How did the call go?</h3>
        <p className="mt-1 text-xs text-slate-500">
          Vistaar can’t tell what happened after the dialler opened, so this is the only record.
        </p>

        <fieldset className="mt-4">
          <legend className="text-xs font-semibold uppercase tracking-wide text-slate-400">
            Outcome
          </legend>

          <div className="mt-2 grid gap-1.5">
            {OUTCOMES.map((option) => (
              <label
                key={option.value}
                className={`flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm ${
                  outcome === option.value
                    ? 'border-slate-800 bg-slate-50 font-medium text-slate-900'
                    : 'border-slate-300 text-slate-700'
                }`}
              >
                <input
                  type="radio"
                  name="call-outcome"
                  value={option.value}
                  checked={outcome === option.value}
                  onChange={() => chooseOutcome(option.value)}
                />
                {option.label}
              </label>
            ))}
          </div>
        </fieldset>

        {/* Appears the moment an outcome needing a time is picked, rather than after saving. */}
        {selected?.needsCallback ? (
          <label className="mt-4 block">
            <span className="text-xs font-semibold uppercase tracking-wide text-slate-400">
              When should we try again?
            </span>
            <input
              type="datetime-local"
              aria-label="When should we try again?"
              value={callbackAt}
              onChange={(event) => setCallbackAt(event.target.value)}
              className="mt-1 min-h-11 w-full rounded-lg border border-slate-300 px-3 text-sm text-slate-800"
            />
            <span className="mt-1 block text-[11px] text-slate-400">
              Moves the existing reminder — you won’t get two.
            </span>
          </label>
        ) : null}

        {selected?.offersAiResume ? (
          <fieldset className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-3">
            <legend className="px-1 text-xs font-semibold text-slate-700">
              Should AI messaging be enabled again?
            </legend>

            <div className="mt-1 grid gap-1.5">
              <label className="flex min-h-11 cursor-pointer items-center gap-2 text-sm text-slate-800">
                <input
                  type="radio"
                  name="resume-ai"
                  checked={resumeAi === true}
                  onChange={() => setResumeAi(true)}
                />
                Yes
              </label>
              <label className="flex min-h-11 cursor-pointer items-center gap-2 text-sm text-slate-800">
                <input
                  type="radio"
                  name="resume-ai"
                  checked={resumeAi === false}
                  onChange={() => setResumeAi(false)}
                />
                No
              </label>
            </div>

            {/* The explanation is the point of this block: "resume" means something different
                after a booking than after a missed call. */}
            <p className="mt-2 text-[11px] leading-snug text-slate-500">
              {resumeAi === true
                ? `Yes — ${selected.resumeHint}`
                : resumeAi === false
                  ? 'No — the assistant stays quiet and you handle this conversation yourself.'
                  : 'Pick one. Vistaar won’t decide this for you.'}
            </p>
          </fieldset>
        ) : null}

        {selected?.value === 'not_interested' ? (
          <p className="mt-4 rounded-lg bg-slate-50 p-3 text-[11px] leading-snug text-slate-500">
            The assistant stops messaging this lead and won’t restart on its own. You can still
            message them yourself.
          </p>
        ) : null}

        {error ? (
          <p role="alert" className="mt-3 text-xs text-red-600">
            {error}
          </p>
        ) : null}

        <div className="mt-4 grid gap-2">
          <button
            type="button"
            disabled={busy || !canSave}
            onClick={() => void save()}
            className="min-h-11 rounded-lg bg-slate-900 px-3 text-sm font-semibold text-white disabled:opacity-50"
          >
            {busy ? 'Saving…' : 'Save outcome'}
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
