import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

import { useMobileBackLayer } from '../hooks/useMobileBackLayer';
import { getInitials } from '../lib/format';

/** Everything inside the sheet a Tab can land on. Queried live - the list changes with role. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface MobileNavItem<TView extends string = string> {
  view: TView;
  label: string;
}

interface Props<TView extends string> {
  /** Already filtered by permission upstream - this component does not decide who sees what. */
  items: readonly MobileNavItem<TView>[];
  activeView: TView;
  onSelect: (view: TView) => void;
  /** Controlled: the bottom bar's More tab owns the open state now. */
  onClose: () => void;
  userName?: string | null;
  organizationName?: string | null;
  onChangePassword: () => void;
  onSignOut: () => void;
}

/**
 * The phone's way into every section, and into the account controls.
 *
 * WHY THIS EXISTS. The masthead nav is a single scrolling strip of nine letterspaced labels. It
 * needs about 790px; a 360px phone shows four of them and hides Lead sources, Knowledge and
 * Settings behind a sideways scroll nobody discovers. The account row above it - W-Staff, the
 * avatar, Password, Sign out - costs a second line for controls used once a week. Together they
 * took a sixth of the screen before a single lead was visible.
 *
 * So on a phone the bottom bar carries the two sections used all day, and everything else -
 * the other seven, plus W-Staff, the password change and sign-out - lives in here. Desktop
 * keeps the full masthead strip exactly as it was and never renders this.
 *
 * CONTROLLED, NOT SELF-OPENING. It used to own both a trigger button and its open state, which
 * made sense when the trigger sat in the masthead. The trigger is now the More tab in the
 * bottom bar, so the shell owns `open` and this renders only while it is true - one component
 * with one job, and no second button competing with the tab that opens it.
 *
 * The sheet registers a back layer, so the phone's back gesture closes it rather than leaving
 * the app - the same rule every other dismissible thing in the app now follows.
 */
const MobileSectionMenu = <TView extends string>({
  items,
  activeView,
  onSelect,
  onClose,
  userName,
  organizationName,
  onChangePassword,
  onSignOut,
}: Props<TView>) => {
  const close = onClose;
  const sheetRef = useRef<HTMLDivElement>(null);

  useMobileBackLayer({ active: true, onBack: close });

  /**
   * MAKING `aria-modal="true"` TRUE.
   *
   * The sheet declared itself a modal dialog but did none of what that promises: focus stayed
   * on whatever was behind it, Tab walked the inbox underneath, Escape did nothing, and
   * closing left focus nowhere. For a keyboard or screen-reader user that is a dialog in name
   * only - worse than no role at all, because the role tells assistive tech the rest of the
   * page is inert when it is not.
   *
   * Mounted only while open, so the whole effect is the open/close lifecycle.
   */
  useEffect(() => {
    const sheet = sheetRef.current;
    if (!sheet) {
      return;
    }

    // Remembered before focus moves, so it can go back exactly where it came from - the More
    // tab - rather than to the top of the document.
    const previouslyFocused = document.activeElement as HTMLElement | null;

    // The panel itself takes focus rather than the first section: landing on "Reminders" would
    // read as if that row were selected, and the sheet's own label is the useful announcement.
    sheet.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
        return;
      }

      if (event.key !== 'Tab') {
        return;
      }

      const focusable = [...sheet.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (element) => element.offsetParent !== null,
      );

      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;

      // Wrap at both ends, and treat "focus is on the panel itself" as being before the first
      // item so the very first Tab goes inward rather than escaping to the page behind.
      if (event.shiftKey && (active === first || active === sheet)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      // Guard the restore: the element can be gone if closing unmounted it.
      if (previouslyFocused && document.contains(previouslyFocused)) {
        previouslyFocused.focus();
      }
    };
  }, [close]);

  const choose = (view: TView) => {
    onSelect(view);
    close();
  };

  return (
    <>
      {/* PORTALLED TO THE BODY, and it has to be. The trigger lives inside the masthead, which
          carries `backdrop-blur` - and an element with a backdrop-filter becomes the containing
          block for any `position: fixed` descendant. Rendered in place, `fixed inset-0` resolved
          against the 65px header instead of the viewport: the sheet appeared pinned under the
          wordmark with no backdrop and no visible section list. */}
      {createPortal(
        <div className="fixed inset-0 z-50 flex flex-col justify-end lg:hidden">
          {/* Tapping away closes, which is the gesture people try before the back swipe. */}
          <button
            type="button"
            aria-label="Close menu"
            onClick={close}
            className="absolute inset-0 bg-black/60"
          />

          {/* max-h + scroll so nine sections plus the account block still fit a 320px-tall
              landscape phone rather than running off the bottom. */}
          <div
            ref={sheetRef}
            role="dialog"
            aria-modal="true"
            aria-label="Sections"
            // -1 so the panel can hold focus on open without becoming a Tab stop of its own.
            tabIndex={-1}
            className="relative max-h-[85dvh] overflow-y-auto overscroll-contain rounded-t-2xl border-t border-hairline bg-ink-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))] focus:outline-none"
          >
            <div className="sticky top-0 flex items-center gap-3 border-b border-hairline bg-ink-2 px-4 py-3">
              {/* The initials moved here with the rest of the account block when the masthead
                  trigger gave way to the bottom bar - this sheet is now the only place on a
                  phone that answers "who am I signed in as". */}
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-key/40 bg-key/10 font-mono text-[0.6875rem] font-semibold text-key-soft">
                {getInitials(userName)}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-bone">
                  {userName ?? 'Signed in'}
                </p>
                {organizationName ? (
                  <p className="truncate font-mono text-[0.625rem] uppercase tracking-[0.12em] text-muted">
                    {organizationName}
                  </p>
                ) : null}
              </div>
              <button
                type="button"
                onClick={close}
                aria-label="Close menu"
                className="tap-target shrink-0 rounded-md border border-hairline px-3 text-[0.6875rem] uppercase tracking-[0.1em] text-muted"
              >
                Close
              </button>
            </div>

            <nav aria-label="All sections" className="flex flex-col p-2">
              {items.map((item) => {
                const isActive = item.view === activeView;

                return (
                  <button
                    key={item.view}
                    type="button"
                    onClick={() => choose(item.view)}
                    aria-current={isActive}
                    className={`flex min-h-12 items-center gap-3 rounded-lg px-3 text-left text-sm transition-colors ${
                      isActive ? 'bg-panel text-key' : 'text-bone-dim active:bg-panel/60'
                    }`}
                  >
                    <span
                      aria-hidden="true"
                      className={`h-5 w-[3px] rounded-full ${isActive ? 'bg-key' : 'bg-transparent'}`}
                    />
                    {item.label}
                  </button>
                );
              })}
            </nav>

            <div className="flex flex-col gap-1 border-t border-hairline p-2">
              <a
                href="whatsapp-admin://open"
                className="flex min-h-12 items-center rounded-lg px-3 text-sm text-bone-dim active:bg-panel/60"
              >
                W-Staff
              </a>
              <button
                type="button"
                onClick={() => {
                  close();
                  onChangePassword();
                }}
                className="flex min-h-12 items-center rounded-lg px-3 text-left text-sm text-bone-dim active:bg-panel/60"
              >
                Change password
              </button>
              <button
                type="button"
                onClick={onSignOut}
                className="flex min-h-12 items-center rounded-lg px-3 text-left text-sm text-danger active:bg-panel/60"
              >
                Sign out
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
};

export default MobileSectionMenu;
