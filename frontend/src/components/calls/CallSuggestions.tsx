import { useState } from 'react';

import { confirmCallSuggestion, dismissCallSuggestion } from '../../api/endpoints';
import { useAuth } from '../../auth/AuthContext';
import { hasPermission, PERMISSIONS } from '../../lib/permissions';
import { type AuthValue, type CallSuggestion, errorMessage } from '../types';

/**
 * Follow-ups the AI thought it heard, and the agent's decision on each.
 *
 * NOTHING HERE IS A TASK UNTIL SOMEBODY PRESSES CONFIRM. The asymmetry is the reason: a
 * suggestion the agent ignores costs a glance, while a task created automatically is a reminder
 * that will ring, on a real customer's lead, about something a transcript may have misheard.
 *
 * A SUGGESTION WITH NO DATE ASKS FOR ONE. The model is forbidden from guessing a due date and
 * the server refuses to invent one, so the agent supplies it here. That is deliberately a small
 * piece of friction: it is the moment somebody decides a customer will be chased on a
 * particular day.
 */

type Props = {
  callId: string;
  suggestions: CallSuggestion[];
  onChanged: () => void;
};

/** `datetime-local` wants local wall-clock; this is the same conversion the reminder dialog uses. */
const toLocalInputValue = (iso: string | null): string => {
  if (!iso) {
    return '';
  }

  const date = new Date(iso);

  if (Number.isNaN(date.getTime())) {
    return '';
  }

  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};

const CallSuggestions = ({ callId, suggestions, onChanged }: Props) => {
  const { authedRequest, permissions } = useAuth() as AuthValue;
  // Confirming CREATES a reminder, so it needs the task permission - reading a lead and
  // scheduling work on it are different privileges. Dismissing needs only the read gate.
  const canCreateTasks = hasPermission(permissions, PERMISSIONS.CRM_TASKS_MANAGE);

  const [dates, setDates] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (suggestions.length === 0) {
    return null;
  }

  const act = async (commitmentId: string, action: 'confirm' | 'dismiss') => {
    if (busyId) {
      return;
    }

    setBusyId(commitmentId);
    setError(null);

    try {
      if (action === 'dismiss') {
        await authedRequest((token) => dismissCallSuggestion({ token, callId, commitmentId }));
      } else {
        const local = dates[commitmentId];

        await authedRequest((token) =>
          confirmCallSuggestion({
            token,
            callId,
            commitmentId,
            // Omitted entirely when blank: the server then falls back to the transcript's own
            // date, and refuses outright if there isn't one. Sending an empty string would be
            // a different, worse request.
            dueAt: local ? new Date(local).toISOString() : undefined,
          }),
        );
      }

      onChanged();
    } catch (actionError: unknown) {
      setError(errorMessage(actionError, 'That suggestion could not be updated.'));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div>
      <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
        Suggested follow-ups
      </p>
      {/* Named as the AI's reading, not as fact. An agent skimming has to know these came from
          a machine listening to a recording. */}
      <p className="mb-2 text-[11px] text-slate-500">
        Found in the transcript. Nothing is scheduled until you confirm it.
      </p>

      {error ? (
        <p role="alert" className="mb-2 text-[11px] text-red-600">
          {error}
        </p>
      ) : null}

      <ul className="space-y-2">
        {suggestions.map((suggestion) => {
          const open = suggestion.status === 'suggested';
          const busy = busyId === suggestion.commitmentId;

          return (
            <li
              key={suggestion.commitmentId}
              data-testid="call-suggestion"
              data-status={suggestion.status}
              className="rounded-lg bg-slate-50 p-2"
            >
              <p className="text-sm text-slate-800">{suggestion.title}</p>

              {/* The customer's own words, so the agent can judge it without opening the
                  transcript. */}
              {suggestion.evidence ? (
                <p className="mt-1 border-l-2 border-slate-300 pl-2 text-[11px] italic text-slate-500">
                  “{suggestion.evidence}”
                </p>
              ) : null}

              {!open ? (
                <p className="mt-1 text-[11px] text-slate-500">
                  {suggestion.status === 'confirmed' ? 'Added to tasks' : 'Dismissed'}
                </p>
              ) : canCreateTasks ? (
                <div className="mt-2 space-y-1.5">
                  <label className="block">
                    <span className="text-[11px] text-slate-500">
                      {suggestion.dueAt
                        ? 'When (from the call)'
                        : 'When? The call didn’t give a date'}
                    </span>
                    <input
                      type="datetime-local"
                      aria-label={`Due time for ${suggestion.title}`}
                      value={dates[suggestion.commitmentId] ?? toLocalInputValue(suggestion.dueAt)}
                      onChange={(event) =>
                        setDates((current) => ({
                          ...current,
                          [suggestion.commitmentId]: event.target.value,
                        }))
                      }
                      className="mt-0.5 min-h-9 w-full rounded-lg border border-slate-300 px-2 text-xs text-slate-700"
                    />
                  </label>
                  <div className="flex gap-3 text-[11px] font-medium">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void act(suggestion.commitmentId, 'confirm')}
                      className="min-h-9 text-green-600 hover:text-green-700 disabled:opacity-50"
                    >
                      Add task
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void act(suggestion.commitmentId, 'dismiss')}
                      className="min-h-9 text-slate-500 hover:text-slate-700 disabled:opacity-50"
                    >
                      Dismiss
                    </button>
                  </div>
                </div>
              ) : (
                <p className="mt-1 text-[11px] text-slate-400">
                  You don’t have permission to add tasks.
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
};

export default CallSuggestions;
