import { useState } from 'react';

import { deleteConversation } from '../../api/endpoints';
import { useAuth } from '../../auth/AuthContext';
import { type AuthValue, errorMessage } from '../types';

type Props = {
  conversationId: string;
  displayName?: string | null;
  /** Called once the chat is hidden, so the inbox can drop its selection. */
  onDeleted?: () => void;
};

/**
 * Deleting a chat from the inbox.
 *
 * The copy is deliberately literal about what happens, because "delete" sets an expectation this
 * feature does not meet and should not pretend to. It hides the thread, stops every automation on
 * it, and cancels anything still queued to send - it does not erase the lead from WhatsApp, and the
 * thread returns if the lead writes in again. An owner who deletes a chat believing the customer
 * can never reach them again would be wrong in a way that matters.
 */
const DeleteChatSection = ({ conversationId, displayName, onDeleted }: Props) => {
  const { authedRequest } = useAuth() as AuthValue;
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleConfirm = async () => {
    setBusy(true);
    setError(null);

    try {
      await authedRequest((token) => deleteConversation({ token, conversationId }));
      setConfirming(false);
      onDeleted?.();
    } catch (deleteError: unknown) {
      setError(errorMessage(deleteError, 'Unable to delete this chat.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-lg border border-red-200 p-3">
      <span className="text-xs font-semibold uppercase text-red-500">Danger zone</span>
      <p className="mt-1 text-xs text-slate-500">
        Hides this chat and stops the AI. It comes back if they message you again.
      </p>
      <button
        type="button"
        onClick={() => setConfirming(true)}
        className="mt-2 w-full rounded-lg border border-red-300 px-3 py-1.5 text-sm font-medium text-red-600 hover:bg-red-50"
      >
        Delete chat
      </button>

      {error ? (
        <p role="alert" className="mt-1 text-xs text-red-600">
          {error}
        </p>
      ) : null}

      {confirming ? (
        <div
          role="dialog"
          aria-label={`Delete chat with ${displayName ?? 'this lead'}`}
          className="fixed inset-0 z-10 flex items-center justify-center bg-slate-900/40 p-4"
        >
          <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-xl">
            <h3 className="text-base font-semibold text-slate-900">
              Delete chat with {displayName ?? 'this lead'}?
            </h3>

            <p className="mt-2 text-sm text-slate-600">
              It disappears from your inbox, the AI stops handling it, and any reply still waiting
              to send is <strong>cancelled</strong>.
            </p>
            <p className="mt-2 text-sm text-slate-500">
              This does not delete anything on WhatsApp, and the chat reappears if they message you
              again — so nothing they send is ever lost.
            </p>

            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirming(false)}
                disabled={busy}
                className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirm}
                disabled={busy}
                className="rounded-lg border border-red-600 bg-red-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-50"
              >
                {busy ? 'Deleting…' : 'Delete chat'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
};

export default DeleteChatSection;
