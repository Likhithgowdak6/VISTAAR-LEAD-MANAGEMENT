import { useState } from 'react';

import { useAuth } from '../auth/AuthContext';
import { hasPermission, PERMISSIONS } from '../lib/permissions';
import AccountsPage from './AccountsPage';
import TeamPage from './TeamPage';

export type TeamAndAccountsTab = 'team' | 'accounts';

interface Props {
  defaultTab?: TeamAndAccountsTab;
}

/**
 * The people in this workspace and the numbers they work from, on one screen.
 *
 * They were two top-level sections and are one question in practice — "who is set up here?" —
 * so splitting them meant two trips through the nav to answer it.
 *
 * TABS ARE FILTERED BY PERMISSION, which is the one place this deliberately differs from
 * StagesAndTagsPage. That page renders both tabs whenever the caller holds EITHER permission,
 * so somebody who may manage tags but not stages still sees a Stages tab and gets an empty or
 * failing panel when they press it. Team and Accounts are gated by two genuinely separate
 * permissions — `users.read` and `accounts.read` — and staff routinely hold neither, so the
 * same shortcut here would show a WhatsApp numbers tab to people who cannot read them.
 *
 * A caller with only one permission sees no tab strip at all: a single tab is not a choice,
 * and rendering one would imply there is somewhere else to go.
 */
const TeamAndAccountsPage = ({ defaultTab = 'team' }: Props) => {
  const { permissions } = useAuth();
  const canReadUsers = hasPermission(permissions, PERMISSIONS.USERS_READ);
  const canReadAccounts = hasPermission(permissions, PERMISSIONS.ACCOUNTS_READ);

  // NULL UNTIL THE USER PICKS ONE, rather than seeding state with the derived default.
  //
  // `permissions` arrives asynchronously — the first render happens before the auth payload
  // resolves, so `canReadUsers` is false at that moment. Passing the derived value to
  // `useState` froze that first, permission-less answer forever and every admin landed on the
  // WhatsApp numbers tab. Deriving on each render and letting an explicit choice win keeps the
  // default correct once permissions land, without fighting the user afterwards.
  const [chosenTab, setChosenTab] = useState<TeamAndAccountsTab | null>(null);

  // Fall back to whichever tab the caller can actually open, so a deep link to `accounts` from
  // somebody without `accounts.read` lands on Team rather than on a blank panel.
  const derivedTab: TeamAndAccountsTab =
    defaultTab === 'accounts' && canReadAccounts
      ? 'accounts'
      : canReadUsers
        ? 'team'
        : 'accounts';

  const showTabs = canReadUsers && canReadAccounts;
  const tab = showTabs ? (chosenTab ?? derivedTab) : canReadUsers ? 'team' : 'accounts';

  const tabClass = (selected: boolean) =>
    `flex items-center gap-2 px-4 py-2 rounded-lg text-xs sm:text-sm font-semibold transition-all duration-150 ${
      selected
        ? 'bg-white dark:bg-slate-900 text-blue-600 dark:text-blue-400 shadow-xs'
        : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
    }`;

  return (
    <div className="mx-auto max-w-3xl space-y-5 p-4 sm:p-6 lg:p-8 animate-fade-in">
      {/* Page Header */}
      <div>
        <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-100">
          Team &amp; Accounts
        </h1>
        <p className="mt-1 text-xs sm:text-sm text-slate-500 dark:text-slate-400">
          Manage the people in this workspace and the WhatsApp numbers they work from.
        </p>
      </div>

      {/* Segmented Tab Controls */}
      {showTabs ? (
        <div className="flex items-center gap-1.5 p-1 rounded-xl bg-slate-200/70 dark:bg-slate-800/80 w-fit">
          <button
            type="button"
            onClick={() => setChosenTab('team')}
            aria-selected={tab === 'team'}
            className={tabClass(tab === 'team')}
          >
            <span>👥</span>
            <span>Team Members</span>
          </button>

          <button
            type="button"
            onClick={() => setChosenTab('accounts')}
            aria-selected={tab === 'accounts'}
            className={tabClass(tab === 'accounts')}
          >
            <span>📱</span>
            <span>WhatsApp Numbers</span>
          </button>
        </div>
      ) : null}

      {/* Tab Content */}
      <div className="pt-2">
        {tab === 'team' ? <TeamPage embedded /> : <AccountsPage embedded />}
      </div>
    </div>
  );
};

export default TeamAndAccountsPage;
