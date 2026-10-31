import { App } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { useCallback, useEffect, useRef, useState } from 'react';

import { revealPhone, startCall } from '../../api/endpoints';
import { useAuth } from '../../auth/AuthContext';
import { hasPermission, PERMISSIONS } from '../../lib/permissions';
import { NotDiallableError, openDialler } from '../../lib/native-dialer';
import CallOutcomeDialog from '../calls/CallOutcomeDialog';
import { type AuthValue, errorMessage } from '../types';

/**
 * The Call button on a lead.
 *
 * THE ORDER OF OPERATIONS IS THE DESIGN, and each step exists for a reason:
 *
 *   1. REVEAL the number through the existing permissioned route. It is encrypted at rest and
 *      `select: false`; this component never holds it beyond the moment it hands it over, and
 *      never puts it in state, in a log, or in a URL.
 *   2. RECORD that the dialler is being opened - before opening it, not after. Once the system
 *      dialler takes the foreground this WebView may be frozen or killed, and a write deferred
 *      until "after" is a write that may never happen. The row says `initiated` and nothing
 *      stronger, because that is all anybody knows yet.
 *   3. OPEN the dialler with ACTION_DIAL. The agent presses call.
 *
 * WHY THE RECORD COMES FIRST ALSO MAKES IT IDEMPOTENT. The key is minted per tap, so a retry
 * after a dropped connection returns the same row rather than littering the timeline.
 *
 * WHEN THE APP COMES BACK we ask what happened, pre-filled with how long we were away. That is
 * an upper bound on the call, not its length - see CallOutcomeDialog - and the two are stored
 * separately so they can never be confused.
 */

type Props = {
  conversationId: string;
  /** Null when the thread has no contact row. The button then explains rather than failing. */
  contactId: string | null;
  /** Lets the lead panel refresh its activity timeline once a call is recorded. */
  onCallRecorded?: () => void;
};

/** Below this, the agent clearly never left for a call - do not ask about one. */
const MIN_AWAY_SECONDS = 5;

const CallAction = ({ conversationId, contactId, onCallRecorded }: Props) => {
  const { authedRequest, permissions } = useAuth() as AuthValue;
  // The number is revealed to place the call, so the same permission gates the button. Without
  // it the agent has no way to see the number anyway and the action would be a dead end.
  const canReveal = hasPermission(permissions, PERMISSIONS.CLIENT_PII_REVEAL);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingCall, setPendingCall] = useState<{ callId: string; awaySeconds: number } | null>(
    null,
  );

  /**
   * The call we are waiting to hear about, and when we left.
   *
   * Refs, not state: the resume listener is registered once and must not be torn down and
   * re-registered on every render, and these are read inside it rather than rendered from.
   */
  const awaitingRef = useRef<{ callId: string; leftAt: number } | null>(null);

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) {
      // On the web the dialler is a handoff to the OS; the tab is never backgrounded in a way
      // that means "a call happened", so there is nothing to listen for.
      return;
    }

    let remove: (() => void) | null = null;

    void App.addListener('appStateChange', ({ isActive }: { isActive: boolean }) => {
      const awaiting = awaitingRef.current;

      if (!isActive || !awaiting) {
        return;
      }

      const awaySeconds = Math.round((Date.now() - awaiting.leftAt) / 1000);
      awaitingRef.current = null;

      if (awaySeconds < MIN_AWAY_SECONDS) {
        // Back almost immediately: they looked at the dialler and came straight back. Asking
        // "how did the call go?" about a call that plainly did not happen is noise.
        return;
      }

      setPendingCall({ callId: awaiting.callId, awaySeconds });
    })
      .then((handle) => {
        remove = () => {
          void handle.remove();
        };
      })
      .catch(() => {
        // No plugin in this build. The call is still recorded as `initiated`; the agent can set
        // the outcome from the call list instead. Degraded, not broken.
      });

    return () => {
      remove?.();
    };
  }, []);

  const handleCall = useCallback(async () => {
    if (busy || !contactId) {
      return;
    }

    setBusy(true);
    setError(null);

    try {
      const revealed = await authedRequest((token) => revealPhone({ token, contactId }));
      const phone = (revealed?.data?.phone as string | null | undefined) ?? null;

      if (!phone) {
        setError('No phone number on file for this lead.');
        return;
      }

      // Minted per tap. Crypto-random rather than a timestamp: two taps in the same millisecond
      // on a fast device would otherwise collapse into one record.
      const idempotencyKey = `call-${crypto.randomUUID()}`;

      const created = await authedRequest((token) =>
        startCall({ token, conversationId, idempotencyKey }),
      );
      const callId = created?.data?.id ?? null;

      if (callId) {
        awaitingRef.current = { callId, leftAt: Date.now() };
      }

      await openDialler(phone);
      onCallRecorded?.();
    } catch (callError: unknown) {
      awaitingRef.current = null;

      if (callError instanceof NotDiallableError) {
        // Deliberately does not echo the value - an error message is the single most likely
        // thing to end up in a log or a screenshot.
        setError('That phone number can’t be dialled.');
        return;
      }

      setError(errorMessage(callError, 'Unable to open the dialler.'));
    } finally {
      setBusy(false);
    }
  }, [authedRequest, busy, contactId, conversationId, onCallRecorded]);

  if (!canReveal) {
    return null;
  }

  return (
    <div>
      <button
        type="button"
        onClick={() => void handleCall()}
        disabled={busy || !contactId}
        aria-label="Call this lead"
        className="flex min-h-11 w-full items-center justify-center gap-2 rounded-lg border border-slate-300 px-3 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
      >
        <span aria-hidden="true">📞</span>
        {busy ? 'Opening dialler…' : 'Call'}
      </button>

      {/* Said plainly rather than leaving a disabled button with no explanation. */}
      {!contactId ? (
        <p className="mt-1 text-[11px] text-slate-400">No contact on file for this lead.</p>
      ) : null}

      {error ? (
        <p role="alert" className="mt-1 text-[11px] text-red-600">
          {error}
        </p>
      ) : null}

      {pendingCall ? (
        <CallOutcomeDialog
          callId={pendingCall.callId}
          awaySeconds={pendingCall.awaySeconds}
          onClose={() => setPendingCall(null)}
          onRecorded={() => onCallRecorded?.()}
        />
      ) : null}
    </div>
  );
};

export default CallAction;
