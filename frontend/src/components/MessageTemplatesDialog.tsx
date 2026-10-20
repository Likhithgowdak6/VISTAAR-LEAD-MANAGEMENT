import { createPortal } from 'react-dom';

import { useMobileBackLayer } from '../hooks/useMobileBackLayer';
import MessageTemplatesSection from './lead/MessageTemplatesSection';

interface Props {
  /** The thread these messages will be sent to. The ONLY routing input - never a name. */
  conversationId: string;
  /** Steers generation towards the right playbook without the owner retyping it. */
  aiCategory?: string | null;
  /** What the lead has already told us: date, city, guest count and so on. */
  aiFacts?: Record<string, unknown> | null;
  onClose: () => void;
}

/**
 * The template writer, opened from the composer instead of living in the lead panel.
 *
 * WHY A DIALOG AND NOT AN INLINE BLOCK. The generator is a textarea, a Generate button and a
 * list of expandable options with their own editors - roughly a screenful. Inline above the
 * composer it would push the message history off a phone entirely, and the brief is explicit
 * that the composer, the history and the generator must not fight each other on a narrow
 * screen. A dialog gives it the whole screen while it is in use and none of it afterwards.
 *
 * NO SECOND GENERATOR. This is a shell: MessageTemplatesSection is rendered unchanged, so the
 * `/templates/generate` call, the send through `POST /conversations/:id/messages`, the
 * `generatedFor` stamp, the idempotency keys and the in-flight ref all come along exactly as
 * they were. Nothing about the send pipeline is reimplemented here.
 *
 * KEYED ON THE CONVERSATION by the caller, so switching leads remounts the generator and one
 * lead's drafts can never be left on screen looking ready to send to another. That is belt to
 * the braces of `generatedFor`, which refuses the send outright if the stamp does not match.
 *
 * PORTALLED TO THE BODY. The mobile app bar carries `backdrop-filter`, and an element with one
 * becomes the containing block for any `position: fixed` descendant - a lesson this codebase
 * already learned with the More sheet, which rendered pinned under the masthead. Nothing in the
 * current ancestor chain does that, but portalling makes it true regardless of what moves later.
 */
const MessageTemplatesDialog = ({ conversationId, aiCategory, aiFacts, onClose }: Props) => {
  // Mounted only while open, so `active: true` is the whole condition. On a phone the back
  // gesture dismisses this layer instead of leaving the app.
  useMobileBackLayer({ active: true, onBack: onClose });

  return createPortal(
    <div
      data-mobile-sheet-backdrop
      className="fixed inset-0 z-20 flex items-center justify-center bg-slate-900/40 p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Message templates"
        data-mobile-sheet
        // Clicking the backdrop dismisses; clicks inside the panel must not.
        onClick={(event) => event.stopPropagation()}
        className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl bg-white p-4 shadow-xl"
      >
        <div className="mb-3 flex items-center justify-between gap-3">
          <h3 className="text-base font-semibold text-slate-900">Message templates</h3>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
          >
            Close
          </button>
        </div>

        <MessageTemplatesSection
          conversationId={conversationId}
          aiCategory={aiCategory}
          aiFacts={aiFacts}
        />
      </div>
    </div>,
    document.body,
  );
};

export default MessageTemplatesDialog;
