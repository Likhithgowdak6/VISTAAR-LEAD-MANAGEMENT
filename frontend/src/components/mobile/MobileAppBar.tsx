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
  <header className={`m-appbar ${onBack ? '' : 'm-appbar-root'}`}>
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
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
    ) : null}

    <div className="min-w-0 flex-1">
      {onBack ? (
        <>
          {asHeading ? (
            <h1 className="m-appbar-title">{title}</h1>
          ) : (
            <p className="m-appbar-title">{title}</p>
          )}
          <p className="m-appbar-subtitle">{subtitle ?? 'Vistaar CRM'}</p>
        </>
      ) : (
        <>
          {/* iOS large title: the section is the headline; the brand is the small print. */}
          <p className="m-appbar-eyebrow">Vistaar CRM</p>
          <p className="m-appbar-brand">{title}</p>
          {subtitle ? <p className="m-appbar-subtitle">{subtitle}</p> : null}
        </>
      )}
    </div>

    {/* iOS 26 groups bar buttons into one Liquid Glass capsule rather than loose circles. */}
    <div className="m-appbar-group">
      {actions}
      <ThemeToggle className="m-appbar-toggle" />
    </div>
  </header>
);

export default MobileAppBar;
