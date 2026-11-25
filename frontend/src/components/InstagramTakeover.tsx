import { useState } from 'react';

import { setInstagramTakeover } from '../api/instagram';
import { useAuth } from '../auth/AuthContext';
import { hasPermission, PERMISSIONS } from '../lib/permissions';
import { errorMessage } from './types';
import { type Conversation } from '../types';

/**
 * Take over an Instagram thread, or hand it back to automation.
 *
 * SHOWN ONLY ON INSTAGRAM THREADS. WhatsApp has its own, older handover mechanisms wired into the
 * AI brain; duplicating a second control there would give staff two switches for one idea.
 *
 * SHOWN ONLY WHEN THERE IS SOMETHING TO TAKE OVER FROM. If the workspace has automatic replies
 * switched off entirely, nothing is ever going to answer over anybody and the button would be a
 * lie about what the system does.
 *
 * It writes the same `aiAutomationEnabled` flag WhatsApp uses, so "paused" means one thing across
 * the CRM — and the server re-checks that flag immediately before any automatic reply is sent, so
 * pressing this stops a reply that is already composed rather than only future ones.
 */
const InstagramTakeover = ({
  conversation,
  automationAvailable,
  onChanged,
}: {
  conversation: Pick<Conversation, 'id' | 'channel' | 'aiAutomationEnabled'>;
  /** Whether the workspace has Instagram automation switched on at all. */
  automationAvailable: boolean;
  onChanged?: (automationEnabled: boolean) => void;
}) => {
  const { authedRequest, permissions } = useAuth();

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Whoever may answer a customer may stop the automation answering over them. The server
  // enforces the same permission; hiding it here just avoids offering a button that 403s.
  const canSend = hasPermission(permissions, PERMISSIONS.MESSAGES_SEND);

  if (conversation.channel !== 'instagram' || !canSend || !automationAvailable) {
    return null;
  }

  const paused = conversation.aiAutomationEnabled === false;

  const toggle = async () => {
    setBusy(true);
    setError(null);

    try {
      const payload = await authedRequest((token) =>
        setInstagramTakeover({ token, conversationId: conversation.id, resume: paused }),
      );

      onChanged?.(payload.data.aiAutomationEnabled);
    } catch (toggleError: unknown) {
      setError(errorMessage(toggleError, 'Could not change that.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span
        className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
          paused
            ? 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300'
            : 'bg-blue-50 text-blue-700 dark:bg-blue-500/10 dark:text-blue-300'
        }`}
      >
        {paused ? 'You have this thread' : 'Auto-replies on'}
      </span>

      <button
        type="button"
        onClick={toggle}
        disabled={busy}
        title={
          paused
            ? 'Let automatic replies answer this thread again'
            : 'Stop automatic replies on this thread until you resume them'
        }
        className="rounded-lg border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
      >
        {busy ? 'Saving…' : paused ? 'Resume automation' : 'Take over'}
      </button>

      {error ? (
        <span role="alert" className="text-xs text-red-600">
          {error}
        </span>
      ) : null}
    </div>
  );
};

export default InstagramTakeover;
