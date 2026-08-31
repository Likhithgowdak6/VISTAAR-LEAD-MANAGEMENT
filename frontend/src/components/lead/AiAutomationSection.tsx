import { useCallback, useEffect, useState } from 'react';

import { checkAiOutcome, getAiApproval, resolveAiApproval, setAiAutomation } from '../../api/endpoints';
import { useAuth } from '../../auth/AuthContext';
import { hasPermission, PERMISSIONS } from '../../lib/permissions';
import { useRealtime } from '../../realtime/RealtimeProvider';
import RelativeTime from '../RelativeTime';
import {
  type AiBrainApproval,
  type AiBrainOutcome,
  type AuthValue,
  errorMessage,
  type RealtimeEvent,
  type RealtimeValue,
} from '../types';

type Props = {
  conversationId: string;
  aiAutomationEnabled: boolean;
  aiAutomationPausedReason?: string | null;
  /** ISO timestamp of when this lead asked to stop being messaged, or null if they never did. */
  optedOutAt?: string | null;
  onAutomationChange?: () => void;
};

/**
 * The one piece of UI the AI-brain design actually depends on: without somewhere to approve,
 * revise, or skip a drafted reply, automation would stall forever the moment it needs a human
 * (which, by design, is every sales reply and every proposal - only the qualifying question is
 * ever auto-sent). Lives in the lead panel next to assignment/stage/tags.
 */
const AiAutomationSection = ({
  conversationId,
  aiAutomationEnabled,
  aiAutomationPausedReason,
  optedOutAt,
  onAutomationChange,
}: Props) => {
  const { authedRequest, permissions } = useAuth() as AuthValue;
  const { subscribe } = useRealtime() as RealtimeValue;
  const canManage = hasPermission(permissions, PERMISSIONS.AI_AUTOMATION_MANAGE);
  const canResolve = hasPermission(permissions, PERMISSIONS.MESSAGES_SEND);

  /**
   * A lead who asked to stop is not a paused conversation someone forgot to resume - it is a
   * decision the lead made, and the ordinary toggle must never quietly undo it. So the toggle is
   * not rendered at all here: turning automation back on for this number is deliberately not
   * something this panel offers, and the banner below says so in as many words. A human can
   * still type to them in the composer, which is the one contact they did not opt out of.
   */
  const optedOut = Boolean(optedOutAt);

  // Seeded from the initial prop, then owned locally - mirrors AssignmentControl/TagsSection,
  // since nothing upstream refetches the conversation detail after the first load.
  const [enabled, setEnabled] = useState(aiAutomationEnabled);
  const [pausedReason, setPausedReason] = useState(aiAutomationPausedReason ?? null);
  const [toggling, setToggling] = useState(false);
  const [approval, setApproval] = useState<AiBrainApproval | null>(null);
  const [instruction, setInstruction] = useState('');
  const [showInstruction, setShowInstruction] = useState(false);
  const [busy, setBusy] = useState(false);
  const [checkingOutcome, setCheckingOutcome] = useState(false);
  const [lastOutcome, setLastOutcome] = useState<AiBrainOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadApproval = useCallback(async () => {
    try {
      const payload = await authedRequest((token) => getAiApproval({ token, conversationId }));
      setApproval(payload?.data ?? null);
    } catch {
      // Non-fatal - the review card just doesn't appear until the next refresh.
    }
  }, [authedRequest, conversationId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadApproval();
  }, [loadApproval]);

  // The backend pings realtime with reason "ai_pending" whenever a new draft opens or an
  // escalation pauses automation - refetch this conversation's approval on any such event.
  useEffect(
    () =>
      subscribe((event: RealtimeEvent) => {
        if (event?.conversationId === conversationId) {
          loadApproval();
        }
      }),
    [subscribe, conversationId, loadApproval],
  );

  const handleToggle = async () => {
    const next = !enabled;
    setToggling(true);
    setError(null);

    try {
      const payload = await authedRequest((token) =>
        setAiAutomation({ token, conversationId, enabled: next }),
      );
      const resolvedEnabled = payload?.data?.aiAutomationEnabled ?? next;
      setEnabled(resolvedEnabled);
      setPausedReason(payload?.data?.aiAutomationPausedReason ?? null);
      onAutomationChange?.();
    } catch (toggleError: unknown) {
      setError(errorMessage(toggleError, 'Unable to change AI automation.'));
    } finally {
      setToggling(false);
    }
  };

  const handleResolve = async (verdict: 'approve' | 'edit' | 'skip') => {
    setBusy(true);
    setError(null);

    try {
      const payload = await authedRequest((token) =>
        resolveAiApproval({
          token,
          conversationId,
          verdict,
          instruction: verdict === 'edit' ? instruction : undefined,
        }),
      );
      const nextApproval = payload?.data?.approval ?? null;
      setApproval(nextApproval && nextApproval.status === 'pending' ? nextApproval : null);
      setShowInstruction(false);
      setInstruction('');
      onAutomationChange?.();
    } catch (resolveError: unknown) {
      setError(errorMessage(resolveError, 'Unable to update the AI draft.'));
    } finally {
      setBusy(false);
    }
  };

  const handleCheckOutcome = async () => {
    setCheckingOutcome(true);
    setError(null);

    try {
      const payload = await authedRequest((token) => checkAiOutcome({ token, conversationId }));
      setLastOutcome(payload?.data ?? null);
      await loadApproval();
      onAutomationChange?.();
    } catch (outcomeError: unknown) {
      setError(errorMessage(outcomeError, 'Unable to check the outcome right now.'));
    } finally {
      setCheckingOutcome(false);
    }
  };

  return (
    <div className="rounded-lg border border-slate-200 p-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold uppercase text-slate-500">AI assistant</span>
        {optedOut ? (
          <span className="text-xs font-semibold text-rose-700">Off — opted out</span>
        ) : canManage ? (
          <label className="flex items-center gap-1.5 text-xs text-slate-600">
            <input
              type="checkbox"
              checked={enabled}
              disabled={toggling}
              onChange={handleToggle}
              className="h-3.5 w-3.5 rounded border-slate-300"
            />
            Auto-qualify
          </label>
        ) : (
          <span className="text-xs text-slate-400">{enabled ? 'On' : 'Off'}</span>
        )}
      </div>

      <p className="mt-1 text-xs text-slate-400">
        Auto-sends qualifying questions only. Every sales reply and proposal still needs your
        approval below.
      </p>

      {optedOut ? (
        <div className="mt-2 rounded-md border border-rose-200 bg-rose-50 p-2.5">
          <p className="text-xs font-semibold text-rose-800">🚫 This lead asked to stop</p>
          <p className="mt-1 text-xs text-rose-700">
            They opted out{' '}
            {optedOutAt ? <RelativeTime value={optedOutAt} /> : null}. No automated message —
            qualifying question, follow-up or nudge — will ever go to them again, and this cannot
            be switched back on here.
          </p>
          <p className="mt-1 text-xs text-rose-700">
            You can still reply to them yourself in the message box.
          </p>
        </div>
      ) : pausedReason ? (
        <p className="mt-2 text-xs text-amber-700">Paused: {pausedReason}</p>
      ) : null}

      {approval ? (
        <div className="mt-3 rounded-md bg-amber-50 p-2.5">
          <p className="text-xs font-semibold text-amber-800">AI drafted a reply — needs review</p>
          <p className="mt-1 whitespace-pre-wrap text-sm text-slate-800">{approval.draft}</p>

          {canResolve ? (
            <div className="mt-2 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => handleResolve('approve')}
                disabled={busy}
                className="rounded-md bg-emerald-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
              >
                Approve &amp; send
              </button>
              <button
                type="button"
                onClick={() => setShowInstruction((open) => !open)}
                disabled={busy}
                className="rounded-md border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              >
                Ask AI to revise
              </button>
              <button
                type="button"
                onClick={() => handleResolve('skip')}
                disabled={busy}
                className="rounded-md border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              >
                Skip
              </button>
            </div>
          ) : (
            <p className="mt-2 text-xs text-slate-500">
              You need message-sending permission to act on this.
            </p>
          )}

          {showInstruction ? (
            <div className="mt-2">
              <textarea
                value={instruction}
                onChange={(event) => setInstruction(event.target.value)}
                placeholder="e.g. mention the festive discount"
                rows={2}
                className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
              />
              <button
                type="button"
                onClick={() => handleResolve('edit')}
                disabled={busy || instruction.trim() === ''}
                className="mt-1.5 rounded-md bg-blue-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              >
                Send instruction
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

      {canManage ? (
        <button
          type="button"
          onClick={handleCheckOutcome}
          disabled={checkingOutcome}
          className="mt-3 text-xs font-medium text-blue-600 hover:underline disabled:opacity-50"
        >
          {checkingOutcome ? 'Checking…' : 'Ask AI: won, lost, or still open?'}
        </button>
      ) : null}

      {lastOutcome ? (
        <p className="mt-2 text-xs text-slate-600">
          AI read this as <span className="font-semibold">{lastOutcome.decision}</span>
          {lastOutcome.reasoning ? `: ${lastOutcome.reasoning}` : ''}
        </p>
      ) : null}

      {error ? <p className="mt-2 text-xs text-red-600">{error}</p> : null}
    </div>
  );
};

export default AiAutomationSection;
