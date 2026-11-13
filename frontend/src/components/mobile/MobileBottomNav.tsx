import { type ReactNode } from 'react';
import { hapticSelection } from '../../lib/haptics';

export type BottomNavKey = 'leads' | 'inbox' | 'analytics' | 'tasks' | 'more';

interface Props {
  active: BottomNavKey;
  onLeads: () => void;
  onInbox: () => void;
  onAnalytics?: () => void;
  onTasks?: () => void;
  onMore: () => void;
  canManageTasks?: boolean;
}

const Icon = ({ children }: { children: ReactNode }) => (
  <svg viewBox="0 0 24 24" aria-hidden="true" className="h-[20px] w-[20px] transition-transform duration-200 group-active:scale-90" fill="none">
    {children}
  </svg>
);

const STROKE = {
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

/**
 * Apple-inspired Floating Mobile Bottom Navigation.
 * Features translucent frosted glass backdrop, tactile haptic feedback,
 * active indicator glow, and safe-area padding for Android gesture navigation.
 */
const MobileBottomNav = ({
  active,
  onLeads,
  onInbox,
  onAnalytics,
  onTasks,
  onMore,
  canManageTasks = true,
}: Props) => {
  const handleNav = (action?: () => void) => {
    if (action) {
      void hapticSelection();
      action();
    }
  };

  return (
    <nav
      aria-label="Primary"
      className="m-bottomnav lg:hidden fixed inset-x-4 bottom-3 z-40 flex items-center justify-around gap-0.5 p-1"
    >
      {/* 1. Leads */}
      <button
        type="button"
        onClick={() => handleNav(onLeads)}
        aria-current={active === 'leads'}
        className={`group relative flex min-h-[52px] min-w-0 flex-1 flex-col items-center justify-center rounded-full py-1 text-[0.625rem] font-semibold tracking-tight transition-all duration-300 active:scale-90 ${
          active === 'leads'
            ? 'glass-pill text-blue-600 dark:text-blue-400'
            : 'text-slate-800 dark:text-slate-200'
        }`}
      >
        <span className={`relative flex h-6 w-7 items-center justify-center`}>
          <Icon>
            <path d="M4 6.5h16M4 12h16M4 17.5h10" {...STROKE} />
            <circle cx="18.5" cy="17.5" r="2.5" {...STROKE} />
          </Icon>
        </span>
        <span className="m-bottomnav-label">Leads</span>
      </button>

      {/* 2. Inbox */}
      <button
        type="button"
        onClick={() => handleNav(onInbox)}
        aria-current={active === 'inbox'}
        className={`group relative flex min-h-[52px] min-w-0 flex-1 flex-col items-center justify-center rounded-full py-1 text-[0.625rem] font-semibold tracking-tight transition-all duration-300 active:scale-90 ${
          active === 'inbox'
            ? 'glass-pill text-blue-600 dark:text-blue-400'
            : 'text-slate-800 dark:text-slate-200'
        }`}
      >
        <span className={`relative flex h-6 w-7 items-center justify-center`}>
          <Icon>
            <path d="M3 12h4.5l1.5 2.5h6L16.5 12H21" {...STROKE} />
            <path
              d="M5.2 5.5h13.6a1 1 0 0 1 .95.68L21 12v5.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5V12l1.25-5.82a1 1 0 0 1 .95-.68Z"
              {...STROKE}
            />
          </Icon>
        </span>
        <span className="m-bottomnav-label">Inbox</span>
      </button>

      {/* 3. Analytics / Dashboard */}
      {onAnalytics ? (
        <button
          type="button"
          onClick={() => handleNav(onAnalytics)}
          aria-current={active === 'analytics'}
          className={`group relative flex min-h-[52px] min-w-0 flex-1 flex-col items-center justify-center rounded-full py-1 text-[0.625rem] font-semibold tracking-tight transition-all duration-300 active:scale-90 ${
            active === 'analytics'
              ? 'glass-pill text-blue-600 dark:text-blue-400'
              : 'text-slate-800 dark:text-slate-200'
          }`}
        >
          <span className={`relative flex h-6 w-7 items-center justify-center`}>
            <Icon>
              <path d="M18 20V10M12 20V4M6 20v-6" {...STROKE} />
            </Icon>
          </span>
          <span className="m-bottomnav-label">Dashboard</span>
        </button>
      ) : null}

      {/* 4. Tasks (if permitted) */}
      {canManageTasks && onTasks ? (
        <button
          type="button"
          onClick={() => handleNav(onTasks)}
          aria-current={active === 'tasks'}
          className={`group relative flex min-h-[52px] min-w-0 flex-1 flex-col items-center justify-center rounded-full py-1 text-[0.625rem] font-semibold tracking-tight transition-all duration-300 active:scale-90 ${
            active === 'tasks'
              ? 'glass-pill text-blue-600 dark:text-blue-400'
              : 'text-slate-800 dark:text-slate-200'
          }`}
        >
          <span className={`relative flex h-6 w-7 items-center justify-center`}>
            <Icon>
              <path d="m9 11 3 3L22 4" {...STROKE} />
              <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" {...STROKE} />
            </Icon>
          </span>
          <span className="m-bottomnav-label">Tasks</span>
        </button>
      ) : null}

      {/* 5. More */}
      <button
        type="button"
        onClick={() => handleNav(onMore)}
        aria-current={active === 'more'}
        aria-haspopup="dialog"
        className={`group relative flex min-h-[52px] min-w-0 flex-1 flex-col items-center justify-center rounded-full py-1 text-[0.625rem] font-semibold tracking-tight transition-all duration-300 active:scale-90 ${
          active === 'more'
            ? 'glass-pill text-blue-600 dark:text-blue-400'
            : 'text-slate-800 dark:text-slate-200'
        }`}
      >
        <span className={`relative flex h-6 w-7 items-center justify-center`}>
          <Icon>
            <circle cx="12" cy="12" r="1.5" fill="currentColor" />
            <circle cx="6" cy="12" r="1.5" fill="currentColor" />
            <circle cx="18" cy="12" r="1.5" fill="currentColor" />
          </Icon>
        </span>
        <span className="m-bottomnav-label">More</span>
      </button>
    </nav>
  );
};

export default MobileBottomNav;
