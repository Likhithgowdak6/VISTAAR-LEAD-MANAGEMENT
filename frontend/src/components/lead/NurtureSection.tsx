import { useState } from 'react';

import { setNurture } from '../../api/endpoints';
import { useAuth } from '../../auth/AuthContext';
import { hasPermission, PERMISSIONS } from '../../lib/permissions';
import { type AuthValue, errorMessage } from '../types';

/**
 * Whether the AI may chase THIS lead when they go quiet.
 *
 * A SEPARATE CONTROL FROM "AI ASSISTANT" ABOVE, and the distinction is the reason it exists.
 * That switch decides whether the agent may speak at all; turning it off to stop the chasing
 * would also stop it ANSWERING a lead who writes in. "Stop pestering them, but still reply if
 * they come back" is the thing an owner actually wants, and before this there was no way to
 * say it.
 *
 * TURNING IT OFF IS IMMEDIATE. The follow-up sequence is decided at sweep time against a
 * database query, and a disabled lead is excluded by that query - so there is no queue to
 * drain and nothing in flight to cancel.
 *
 * TURNING IT BACK ON RESTARTS RATHER THAN RESUMES, which the copy says out loud because the
 * alternative is alarming: the schedule is anchored to the customer's last message, so a lead
 * paused for a week would otherwise come back with every missed step owed at once. The server
 * re-anchors on the moment you switch it on.
 *
 * SITS UNDER THE GLOBAL SWITCH. With nurture disabled for the deployment this changes nothing
 * that happens today - it records the owner's intent for when it is enabled.
 */

type Props = {
  conversationId: string;
  nurtureEnabled: boolean;
  /** When this lead asked to stop being messaged. Nothing may chase them again. */
  optedOutAt?: string | null;
  onNurtureChange?: () => void;
};

const NurtureSection = ({
  conversationId,
  nurtureEnabled,
  optedOutAt,
  onNurtureChange,
}: Props) => {
  const { authedRequest, permissions } = useAuth() as AuthValue;
  const canManage = hasPermission(permissions, PERMISSIONS.AI_AUTOMATION_MANAGE);

  const [enabled, setEnabled] = useState(nurtureEnabled);
  const [toggling, setToggling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const optedOut = Boolean(optedOutAt);

  const handleToggle = async () => {
    const next = !enabled;
    setToggling(true);
    setError(null);

    try {
      const payload = await authedRequest((token) =>
        setNurture({ token, conversationId, enabled: next }),
      );

      // Trust the server's answer over the optimistic one: it owns the re-anchor and could in
      // principle refuse.
      setEnabled(payload?.data?.nurtureEnabled ?? next);
      onNurtureChange?.();
    } catch (toggleError: unknown) {
      setError(errorMessage(toggleError, 'Unable to change follow-ups.'));
    } finally {
      setToggling(false);
    }
  };

  return (
    <div className="rounded-lg border border-slate-200 p-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold uppercase text-slate-500">Follow-ups</span>

        {optedOut ? (
          // Not a toggle at all. An opted-out lead is never chased, and offering a switch that
          // cannot do anything would be a lie about what the system will do.
          <span className="text-xs font-semibold text-rose-700">Off — opted out</span>
        ) : canManage ? (
          <label className="flex items-center gap-1.5 text-xs text-slate-600">
            <input
              type="checkbox"
              checked={enabled}
              disabled={toggling}
              onChange={handleToggle}
              aria-label="Chase this lead when they go quiet"
              className="h-3.5 w-3.5 rounded border-slate-300"
            />
            Chase when quiet
          </label>
        ) : (
          <span className="text-xs text-slate-400">{enabled ? 'On' : 'Off'}</span>
        )}
      </div>

      <p className="mt-1 text-xs text-slate-400">
        {enabled
          ? 'The AI nudges this lead if they go quiet. It still replies either way.'
          : 'The AI won’t chase this lead. It still replies if they message you.'}
      </p>

      {!enabled && !optedOut ? (
        <p className="mt-1 text-[11px] text-slate-400">
          Turning this back on starts the sequence again from two hours’ time — it won’t send
          the messages it skipped.
        </p>
      ) : null}

      {error ? (
        <p role="alert" className="mt-2 text-xs text-red-600">
          {error}
        </p>
      ) : null}
    </div>
  );
};

export default NurtureSection;
