import { createPortal } from 'react-dom';
import { useMobileBackLayer } from '../hooks/useMobileBackLayer';
import { useBillingModalFocus } from '../hooks/useBillingModalFocus';

interface Props {
  title: string;
  /** What will actually happen, and whether it can be undone. */
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: 'default' | 'danger';
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * A yes/no on something that cannot be taken back.
 *
 * ADDED FOR BILLING, where four separate actions are irreversible in a way a client can see -
 * cancelling an invoice, voiding a payment, cancelling a payment link, pausing a schedule. The
 * existing dialogs in this app each build their own confirmation inline, which is fine for one
 * and becomes four slightly different wordings of "are you sure" if each billing action does
 * the same.
 *
 * The message says what happens and whether it is reversible, rather than asking "are you
 * sure?" - which is a question nobody can answer usefully.
 */
const ConfirmDialog = ({
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Go back',
  tone = 'default',
  busy = false,
  onConfirm,
  onCancel,
}: Props) => {
  useMobileBackLayer({ active: true, onBack: onCancel });
  const modalRef = useBillingModalFocus(onCancel, busy);

  return createPortal(
    <div
      ref={modalRef}
      role="dialog"
      aria-label={title}
      aria-modal="true"
      data-mobile-sheet-backdrop
      className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-900/50 p-4"
    >
      <div
        data-mobile-sheet
        className="w-full max-w-sm rounded-2xl bg-white p-5 shadow-xl dark:bg-slate-900"
      >
        <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">{title}</h3>
        <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">{message}</p>

        <div className="mt-4 flex gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="flex-1 rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className={`flex-1 rounded-lg px-4 py-2 text-sm font-semibold text-white disabled:opacity-60 ${
              tone === 'danger'
                ? 'bg-red-600 hover:bg-red-700'
                : 'bg-blue-600 hover:bg-blue-700'
            }`}
          >
            {busy ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
};

export default ConfirmDialog;
