import { type WhatsAppAccount } from '../types';

type Props = {
  account: WhatsAppAccount;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
};

/**
 * Remove can delete a number for good, so it asks first.
 *
 * Same modal shape as the connect dialog: an overlay, a labelled `role="dialog"` card, and the
 * destructive action on the right. It deliberately spells out both outcomes, because which one
 * an admin gets is decided by the server from the number's history, not by this button.
 */
const RemoveAccountDialog = ({ account, busy, onCancel, onConfirm }: Props) => (
  <div
    role="dialog"
    aria-label={`Remove ${account.name}`}
    className="fixed inset-0 z-10 flex items-center justify-center bg-slate-900/40 p-4"
  >
    <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-xl">
      <h3 className="text-base font-semibold text-slate-900">Remove {account.name}?</h3>

      <p className="mt-2 text-sm text-slate-600">
        This disconnects the number now. If it has no conversations, messages or lead sources it is{' '}
        <strong>deleted permanently</strong>, together with its stored WhatsApp login — that cannot
        be undone.
      </p>
      <p className="mt-2 text-sm text-slate-500">
        If it still has history, it is hidden from this list instead and its threads stay in the
        inbox.
      </p>

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
          onClick={onConfirm}
          disabled={busy}
          className="rounded-lg border border-red-600 bg-red-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-50"
        >
          {busy ? 'Removing…' : 'Remove number'}
        </button>
      </div>
    </div>
  </div>
);

export default RemoveAccountDialog;
