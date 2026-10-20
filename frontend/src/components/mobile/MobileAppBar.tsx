import { type ReactNode } from 'react';

interface Props {
  /** Shown when there is somewhere to go back TO. Omit at a root tab. */
  onBack?: () => void;
  /** What the back control returns to, named for screen readers: "Back to inbox". */
  backLabel?: string;
  title: ReactNode;
  /** A second line under the title - the lead's number, a source's state. */
  subtitle?: ReactNode;
  /** Up to two controls. More than that belongs in the screen, not the bar. */
  actions?: ReactNode;
  /**
   * Render the title as the screen's `<h1>` rather than a paragraph.
   *
   * ON FOR SCREENS THAT HAVE NO HEADING OF THEIR OWN - the inbox and the open thread, which
   * both dropped their `<h2>` when they adopted this bar and were left with no heading at all
   * on a phone. OFF for the section screens, which keep their own `<h1>` (visually hidden by
   * `.m-has-appbar`, still in the accessibility tree): turning it on there would announce the
   * same title twice.
   */
  asHeading?: boolean;
}

/**
 * The one top bar every mobile screen uses.
 *
 * WHY IT EXISTS. Before this, a section page put an `<h1>` inside its own scroll
 * area, the conversation had a bespoke header with a "← Inbox" button, and the lead panel had a
 * third shape added later. Three headers, three heights, three places the title could sit - and
 * on a phone the top bar is the one piece of furniture present on every screen, so an
 * inconsistency there is the one people feel most.
 *
 * Sticky rather than fixed: it scrolls with its own screen's container, so a screen can have a
 * bar without every screen needing to reserve space for it.
 *
 * MOBILE ONLY BY CONSTRUCTION. Nothing renders this above `lg` - callers gate on
 * `useIsMobileViewport`, and the desktop masthead and panel headers are untouched.
 */
const MobileAppBar = ({ onBack, backLabel, title, subtitle, actions, asHeading }: Props) => (
  <header className="m-appbar">
    {onBack ? (
      <button
        type="button"
        onClick={onBack}
        aria-label={backLabel ?? 'Go back'}
        className="m-appbar-action"
      >
        {/* A chevron, not a word: the label is read by screen readers and the shape is
            understood everywhere, which keeps the bar's width for the title. */}
        <svg viewBox="0 0 20 20" aria-hidden="true" className="h-5 w-5" fill="none">
          <path
            d="M12.5 15.5 7 10l5.5-5.5"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
    ) : null}

    <div className="min-w-0 flex-1">
      {asHeading ? (
        <h1 className="m-appbar-title">{title}</h1>
      ) : (
        <p className="m-appbar-title">{title}</p>
      )}
      {subtitle ? (
        <p className="truncate text-[0.6875rem] leading-tight text-muted">{subtitle}</p>
      ) : null}
    </div>

    {actions ? <div className="flex shrink-0 items-center gap-1">{actions}</div> : null}
  </header>
);

export default MobileAppBar;
