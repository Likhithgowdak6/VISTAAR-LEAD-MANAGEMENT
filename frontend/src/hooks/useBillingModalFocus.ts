import { useEffect, useRef } from 'react';

const openModals: HTMLElement[] = [];
const focusable = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex="0"]';

/** Billing dialogs follow the existing section menu's keyboard behavior, including nesting. */
export const useBillingModalFocus = (onClose: () => void, busy = false) => {
  const ref = useRef<HTMLDivElement>(null);
  const latest = useRef({ onClose, busy });
  useEffect(() => { latest.current = { onClose, busy }; }, [onClose, busy]);

  useEffect(() => {
    const modal = ref.current;
    if (!modal) return;
    const previous = document.activeElement as HTMLElement | null;
    openModals.push(modal);
    modal.tabIndex = -1;
    modal.setAttribute('aria-modal', 'true');
    modal.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (openModals.at(-1) !== modal) return;
      const focusedModal = document.activeElement?.closest('[role="dialog"]');
      if (focusedModal && focusedModal !== modal && !modal.contains(focusedModal)) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!latest.current.busy) latest.current.onClose();
      }
      if (event.key !== 'Tab') return;
      const controls = [...modal.querySelectorAll<HTMLElement>(focusable)].filter(
        element => !element.hidden && element.getAttribute('aria-hidden') !== 'true',
      );
      const first = controls[0];
      const last = controls.at(-1);
      const active = document.activeElement;
      if (!first || !last) { event.preventDefault(); return; }
      if (event.shiftKey && (active === first || active === modal || !modal.contains(active))) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && (active === last || active === modal || !modal.contains(active))) {
        event.preventDefault(); first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      const index = openModals.lastIndexOf(modal);
      if (index >= 0) openModals.splice(index, 1);
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  return ref;
};
