import { type ReactNode } from 'react';
import ThemeToggle from '../ThemeToggle';
import { hapticSelection } from '../../lib/haptics';

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
   */
  asHeading?: boolean;
}

/**
 * The premium WhatsApp-inspired top header every mobile screen uses.
 * Displays Vistaar CRM branding and active section indicator on root tabs,
 * and clean navigation with tactile back control on child views.
 */
const MobileAppBar = ({ onBack, backLabel, title, subtitle, actions, asHeading }: Props) => (
  <header className="m-appbar">
    {onBack ? (
      <button
        type="button"
        onClick={() => {
          hapticSelection();
          onBack();
        }}
        aria-label={backLabel ?? 'Go back'}
        className="m-appbar-action"
      >
        <svg viewBox="0 0 20 20" aria-hidden="true" className="h-5 w-5" fill="none">
          <path
            d="M12.5 15.5 7 10l5.5-5.5"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
    ) : (
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-gradient-to-tr from-blue-600 to-indigo-600 text-white shadow-xs shadow-blue-500/30">
        <span className="font-mono text-sm font-black tracking-tight">V</span>
      </div>
    )}

    <div className="min-w-0 flex-1">
      {onBack ? (
        <>
          {asHeading ? (
            <h1 className="m-appbar-title font-bold text-slate-900 dark:text-white">{title}</h1>
          ) : (
            <p className="m-appbar-title font-bold text-slate-900 dark:text-white">{title}</p>
          )}
          <p className="truncate text-[0.6875rem] leading-tight text-slate-500 dark:text-slate-400">
            {subtitle ?? 'Vistaar CRM'}
          </p>
        </>
      ) : (
        <>
          <div className="flex items-center gap-2">
            <span className="truncate text-base font-bold tracking-tight text-slate-900 dark:text-white">
              Vistaar CRM
            </span>
            <span className="shrink-0 rounded-full bg-blue-500/10 px-2 py-0.5 font-mono text-[0.625rem] font-bold uppercase tracking-wider text-blue-600 dark:bg-blue-500/20 dark:text-blue-400">
              {title}
            </span>
          </div>
          {subtitle ? (
            <p className="truncate text-[0.6875rem] leading-tight text-slate-500 dark:text-slate-400">
              {subtitle}
            </p>
          ) : null}
        </>
      )}
    </div>

    <div className="flex shrink-0 items-center gap-1.5">
      {actions}
      <ThemeToggle
        className="h-8 w-8 rounded-xl border border-slate-200/80 bg-slate-100/70 p-0 text-slate-600 hover:text-slate-900 dark:border-slate-800 dark:bg-slate-800/70 dark:text-slate-300 dark:hover:text-white"
      />
    </div>
  </header>
);

export default MobileAppBar;
