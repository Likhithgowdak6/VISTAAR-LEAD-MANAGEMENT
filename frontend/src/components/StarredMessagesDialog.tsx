import { createPortal } from 'react-dom';

import { useMobileBackLayer } from '../hooks/useMobileBackLayer';
import StarredMessagesSection from './starred/StarredMessagesSection';

interface Props {
  /** Fills the composer with this text and closes. NEVER sends. */
  onUse: (body: string) => void;
  /** Lets the thread refresh its stars after something is saved or deleted here. */
  onChanged?: () => void;
  onClose: () => void;
}

/**
 * The Starred panel, opened from the composer beside Message templates.
 *
 * SAME SHELL AS MessageTemplatesDialog, DELIBERATELY. The two buttons sit next to each other
 * and do adjacent things, so opening them should feel identical: a portalled overlay, a back
 * gesture that dismisses the layer rather than leaving the app, backdrop-to-close, and the
 * panel itself swallowing clicks. Divergence here would read as two different features bolted
 * on by two different people.
 *
 * NOT KEYED ON THE CONVERSATION, which is the one real difference. Templates are generated for
 * a specific lead and stamped with it, so that dialog is remounted per thread to stop a draft
 * for one lead being sent to another. Saved messages have no such affinity - they are the
 * user's own text, equally valid on any thread - so there is nothing to scope and nothing to
 * leak by keeping the list warm.
 *
 * PORTALLED TO THE BODY for the reason the templates dialog documents: an ancestor with
 * `backdrop-filter` becomes the containing block for `position: fixed` descendants, and the
 * mobile app bar has one.
 */
const StarredMessagesDialog = ({ onUse, onChanged, onClose }: Props) => {
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
        aria-label="Starred messages"
        data-mobile-sheet
        onClick={(event) => event.stopPropagation()}
        className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl bg-white p-4 shadow-xl"
      >
        <div className="mb-3 flex items-center justify-between gap-3">
          <h3 className="text-base font-semibold text-slate-900">Starred messages</h3>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
          >
            Close
          </button>
        </div>

        <StarredMessagesSection
          onUse={(body) => {
            // Insert, then close. Leaving the panel open over a composer the user now needs to
            // edit would hide the very thing the click was for.
            onUse(body);
            onClose();
          }}
          onChanged={onChanged}
        />
      </div>
    </div>,
    document.body,
  );
};

export default StarredMessagesDialog;
