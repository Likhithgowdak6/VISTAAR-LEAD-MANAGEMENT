import { useState } from 'react';

import { type WhatsAppAccount } from '../types';

type Props = {
  account: WhatsAppAccount;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (purgeHistory: boolean) => void;
};

/**
 * Remove can delete a number for good, so it asks first.
 *
 * Same modal shape as the connect dialog: an overlay, a labelled `role="dialog"` card, and the
 * destructive action on the right. It spells out both outcomes, because which one an admin gets
 * is decided by the server from the number's history, not by this button.
 *
 * The checkbox is the exception - the one thing the admin, not the server, decides. It is
 * unchecked every time the dialog opens and is never remembered, because "delete 800 customer
 * messages" must be a decision taken on purpose for this number, today, and not a preference
 * that quietly persists into the next removal. The confirm button restates the choice rather
 * than staying generic, so the last thing read before clicking says which one it is.
 */
const RemoveAccountDialog = ({ account, busy, onCancel, onConfirm }: Props) => {
  const [purgeHistory, setPurgeHistory] = useState(false);

  return (
    <div
      role="dialog"
      aria-label={`Remove ${account.name}`}
      className="fixed inset-0 z-10 flex items-center justify-center bg-slate-900/40 p-4"
    >
      <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-xl">
        <h3 className="text-base font-semibold text-slate-900">Remove {account.name}?</h3>

        <p className="mt-2 text-sm text-slate-600">
          This disconnects the number now. If it has no conversations, messages or lead sources it
          is <strong>deleted permanently</strong>, together with its stored WhatsApp login — that
          cannot be undone.
        </p>
        <p className="mt-2 text-sm text-slate-500">
          If it still has history, it is hidden from this list instead and its threads stay in the
          inbox.
        </p>

        <label className="mt-4 flex gap-2 rounded-xl border border-red-200 bg-red-50 p-3">
          <input
            type="checkbox"
            checked={purgeHistory}
            disabled={busy}
            onChange={(event) => setPurgeHistory(event.target.checked)}
            className="mt-0.5 h-4 w-4 shrink-0 accent-red-600"
          />
          <span className="text-sm text-red-900">
            <strong className="font-semibold">Delete its history too.</strong> Every conversation,
            message, note, follow-up and lead source belonging to this number is erased, leaving no
            trace and freeing its brand key. There is no undo and no backup.
          </span>
        </label>

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onConfirm(purgeHistory)}
            disabled={busy}
            className="rounded-lg border border-red-600 bg-red-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-50"
          >
            {busy
              ? purgeHistory
                ? 'Deleting…'
                : 'Removing…'
              : purgeHistory
                ? 'Delete everything'
                : 'Remove number'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default RemoveAccountDialog;
