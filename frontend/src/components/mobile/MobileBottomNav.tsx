import { type ReactNode } from 'react';

export type BottomNavKey = 'inbox' | 'more';

interface Props {
  active: BottomNavKey;
  onInbox: () => void;
  onMore: () => void;
}

const Icon = ({ children }: { children: ReactNode }) => (
  <svg viewBox="0 0 24 24" aria-hidden="true" className="h-[22px] w-[22px]" fill="none">
    {children}
  </svg>
);

const STROKE = {
  stroke: 'currentColor',
  strokeWidth: 1.7,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

/**
 * The phone's primary navigation, at the bottom where the thumb is.
 *
 * WHY TWO TABS. Reminders used to have the second one, back when they were a destination of
 * their own. They now live inside a lead's Details panel - a reminder is about a conversation,
 * and the list of them belongs with the lead it concerns - so the tab had nothing left to point
 * at. What remains is the inbox and everything else.
 *
 * THE ORIGINAL NOTE, KEPT because it still explains the shape: The app has nine sections, but only two are opened daily on a
 * phone: the inbox, and the reminders telling you who to ring. The other seven - accounts,
 * team, stages, tags, lead sources, knowledge, settings - are configuration, done sitting
 * down, and giving each a permanent tab would spend the most valuable strip of screen on
 * things touched once a week. They live behind More, one tap away, in a sheet that lists all
 * of them.
 *
 * DELIBERATELY NOT A "LEADS" TAB. Leads are not a separate screen in this product - a lead IS
 * a conversation, and the inbox is the list of them. A fourth tab would have to either
 * duplicate the inbox or lead somewhere that does not exist.
 *
 * THE ONLY NAVIGATION ON A PHONE. The masthead's inline section tabs are gone below `lg`, so
 * there is one way to change screens rather than two competing ones.
 *
 * NO COUNT BADGE ON REMINDERS, deliberately. The only number the shell already holds is
 * `clockAlarmStatus.clockAlarmCount`, which counts alarms armed in the Android Clock app - zero
 * in a browser, and not the same thing as "reminders needing attention" even on a handset.
 * Showing it would put a confidently wrong number on the most glanced-at control in the app.
 * A real badge needs a count the server can answer for, which is an API change and out of
 * scope here.
 */
const MobileBottomNav = ({ active, onInbox, onMore }: Props) => (
  <nav aria-label="Primary" className="m-bottomnav lg:hidden">
    <button
      type="button"
      onClick={onInbox}
      aria-current={active === 'inbox'}
      className="m-bottomnav-item"
    >
      <Icon>
        <path d="M3 12h4.5l1.5 2.5h6L16.5 12H21" {...STROKE} />
        <path
          d="M5.2 5.5h13.6a1 1 0 0 1 .95.68L21 12v5.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5V12l1.25-5.82a1 1 0 0 1 .95-.68Z"
          {...STROKE}
        />
      </Icon>
      Inbox
    </button>

    <button
      type="button"
      onClick={onMore}
      aria-current={active === 'more'}
      aria-haspopup="dialog"
      className="m-bottomnav-item"
    >
      <Icon>
        <path d="M4 7h16M4 12h16M4 17h10" {...STROKE} />
      </Icon>
      More
    </button>
  </nav>
);

export default MobileBottomNav;
