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
      className="m-bottomnav lg:hidden fixed inset-x-2 bottom-2 z-40 flex items-center justify-around rounded-2xl border border-slate-200/80 bg-white/85 px-1 py-1 shadow-lg shadow-slate-900/5 backdrop-blur-xl dark:border-slate-800/80 dark:bg-slate-900/85 dark:shadow-black/40"
      style={{
        paddingBottom: 'calc(0.25rem + env(safe-area-inset-bottom, 0px))',
      }}
    >
      {/* 1. Leads */}
      <button
        type="button"
        onClick={() => handleNav(onLeads)}
        aria-current={active === 'leads'}
        className={`group relative flex flex-1 flex-col items-center justify-center py-1 text-[0.625rem] font-semibold tracking-tight transition-all duration-200 active:scale-95 ${
          active === 'leads'
            ? 'text-blue-600 dark:text-blue-400 font-bold'
            : 'text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200'
        }`}
      >
        <span className={`relative flex h-7 w-7 items-center justify-center rounded-xl transition-all duration-200 ${
          active === 'leads' ? 'bg-blue-50 dark:bg-blue-950/60 shadow-xs' : ''
        }`}>
          <Icon>
            <path d="M4 6.5h16M4 12h16M4 17.5h10" {...STROKE} />
            <circle cx="18.5" cy="17.5" r="2.5" {...STROKE} />
          </Icon>
        </span>
        <span className="mt-0.5">Leads</span>
        {active === 'leads' ? (
          <span className="absolute -bottom-0.5 h-1 w-1 rounded-full bg-blue-600 dark:bg-blue-400" />
        ) : null}
      </button>

      {/* 2. Inbox */}
      <button
        type="button"
        onClick={() => handleNav(onInbox)}
        aria-current={active === 'inbox'}
        className={`group relative flex flex-1 flex-col items-center justify-center py-1 text-[0.625rem] font-semibold tracking-tight transition-all duration-200 active:scale-95 ${
          active === 'inbox'
            ? 'text-blue-600 dark:text-blue-400 font-bold'
            : 'text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200'
        }`}
      >
        <span className={`relative flex h-7 w-7 items-center justify-center rounded-xl transition-all duration-200 ${
          active === 'inbox' ? 'bg-blue-50 dark:bg-blue-950/60 shadow-xs' : ''
        }`}>
          <Icon>
            <path d="M3 12h4.5l1.5 2.5h6L16.5 12H21" {...STROKE} />
            <path
              d="M5.2 5.5h13.6a1 1 0 0 1 .95.68L21 12v5.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5V12l1.25-5.82a1 1 0 0 1 .95-.68Z"
              {...STROKE}
            />
          </Icon>
        </span>
        <span className="mt-0.5">Inbox</span>
        {active === 'inbox' ? (
          <span className="absolute -bottom-0.5 h-1 w-1 rounded-full bg-blue-600 dark:bg-blue-400" />
        ) : null}
      </button>

      {/* 3. Analytics / Dashboard */}
      {onAnalytics ? (
        <button
          type="button"
          onClick={() => handleNav(onAnalytics)}
          aria-current={active === 'analytics'}
          className={`group relative flex flex-1 flex-col items-center justify-center py-1 text-[0.625rem] font-semibold tracking-tight transition-all duration-200 active:scale-95 ${
            active === 'analytics'
              ? 'text-blue-600 dark:text-blue-400 font-bold'
              : 'text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200'
          }`}
        >
          <span className={`relative flex h-7 w-7 items-center justify-center rounded-xl transition-all duration-200 ${
            active === 'analytics' ? 'bg-blue-50 dark:bg-blue-950/60 shadow-xs' : ''
          }`}>
            <Icon>
              <path d="M18 20V10M12 20V4M6 20v-6" {...STROKE} />
            </Icon>
          </span>
          <span className="mt-0.5">Dashboard</span>
          {active === 'analytics' ? (
            <span className="absolute -bottom-0.5 h-1 w-1 rounded-full bg-blue-600 dark:bg-blue-400" />
          ) : null}
        </button>
      ) : null}

      {/* 4. Tasks (if permitted) */}
      {canManageTasks && onTasks ? (
        <button
          type="button"
          onClick={() => handleNav(onTasks)}
          aria-current={active === 'tasks'}
          className={`group relative flex flex-1 flex-col items-center justify-center py-1 text-[0.625rem] font-semibold tracking-tight transition-all duration-200 active:scale-95 ${
            active === 'tasks'
              ? 'text-blue-600 dark:text-blue-400 font-bold'
              : 'text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200'
          }`}
        >
          <span className={`relative flex h-7 w-7 items-center justify-center rounded-xl transition-all duration-200 ${
            active === 'tasks' ? 'bg-blue-50 dark:bg-blue-950/60 shadow-xs' : ''
          }`}>
            <Icon>
              <path d="m9 11 3 3L22 4" {...STROKE} />
              <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" {...STROKE} />
            </Icon>
          </span>
          <span className="mt-0.5">Tasks</span>
          {active === 'tasks' ? (
            <span className="absolute -bottom-0.5 h-1 w-1 rounded-full bg-blue-600 dark:bg-blue-400" />
          ) : null}
        </button>
      ) : null}

      {/* 5. More */}
      <button
        type="button"
        onClick={() => handleNav(onMore)}
        aria-current={active === 'more'}
        aria-haspopup="dialog"
        className={`group relative flex flex-1 flex-col items-center justify-center py-1 text-[0.625rem] font-semibold tracking-tight transition-all duration-200 active:scale-95 ${
          active === 'more'
            ? 'text-blue-600 dark:text-blue-400 font-bold'
            : 'text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200'
        }`}
      >
        <span className={`relative flex h-7 w-7 items-center justify-center rounded-xl transition-all duration-200 ${
          active === 'more' ? 'bg-blue-50 dark:bg-blue-950/60 shadow-xs' : ''
        }`}>
          <Icon>
            <circle cx="12" cy="12" r="1.5" fill="currentColor" />
            <circle cx="6" cy="12" r="1.5" fill="currentColor" />
            <circle cx="18" cy="12" r="1.5" fill="currentColor" />
          </Icon>
        </span>
        <span className="mt-0.5">More</span>
        {active === 'more' ? (
          <span className="absolute -bottom-0.5 h-1 w-1 rounded-full bg-blue-600 dark:bg-blue-400" />
        ) : null}
      </button>
    </nav>
  );
};

export default MobileBottomNav;
