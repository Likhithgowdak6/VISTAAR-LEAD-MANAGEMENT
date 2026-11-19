import { useState } from 'react';

import { useAuth } from '../auth/AuthContext';
import BillingSettingsPanel from '../components/billing/BillingSettingsPanel';
import InvoicesPanel from '../components/billing/InvoicesPanel';
import RecurringPanel from '../components/billing/RecurringPanel';
import { hasPermission, PERMISSIONS } from '../lib/permissions';

export type BillingTab = 'invoices' | 'recurring' | 'settings';

interface Props {
  defaultTab?: BillingTab;
}

/**
 * Invoicing, payments and the provider connection, on one screen.
 *
 * TABS ARE FILTERED BY PERMISSION, following TeamAndAccountsPage rather than
 * StagesAndTagsPage. Billing splits across three genuinely different permissions - `invoices.read`
 * to look, `invoices.manage` to raise, `settings.manage` to connect a payment provider - and a
 * manager holds only the first. Rendering a Settings tab they cannot open would show them a
 * failing panel; rendering a Recurring tab would offer a schedule they cannot create.
 *
 * A caller with one tab sees no tab strip: a single tab is not a choice.
 */
const BillingPage = ({ defaultTab = 'invoices' }: Props) => {
  const { permissions } = useAuth();

  const canRead = hasPermission(permissions, PERMISSIONS.INVOICES_READ);
  const canManage = hasPermission(permissions, PERMISSIONS.INVOICES_MANAGE);
  const canManageSettings = hasPermission(permissions, PERMISSIONS.SETTINGS_MANAGE);

  /**
   * NULL UNTIL THE USER PICKS ONE, rather than seeding from the derived default.
   *
   * `permissions` arrives asynchronously, so the first render happens before the auth payload
   * resolves and every flag is false at that instant. Freezing that answer into `useState` is
   * the bug TeamAndAccountsPage documents - it landed every admin on the wrong tab.
   */
  const [chosenTab, setChosenTab] = useState<BillingTab | null>(null);

  const available: BillingTab[] = [
    ...(canRead ? (['invoices'] as const) : []),
    ...(canManage ? (['recurring'] as const) : []),
    ...(canManageSettings ? (['settings'] as const) : []),
  ];

  // Falls back to whichever tab the caller can actually open, so a deep link to `settings` from
  // somebody without `settings.manage` lands on Invoices rather than on a blank panel.
  const derived: BillingTab = available.includes(defaultTab) ? defaultTab : (available[0] ?? 'invoices');
  const tab = chosenTab && available.includes(chosenTab) ? chosenTab : derived;

  const tabClass = (selected: boolean) =>
    `flex items-center gap-2 px-4 py-2 rounded-lg text-xs sm:text-sm font-semibold transition-all duration-150 ${
      selected
        ? 'bg-white dark:bg-slate-900 text-blue-600 dark:text-blue-400 shadow-xs'
        : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
    }`;

  if (available.length === 0) {
    return (
      <div className="mx-auto max-w-3xl p-4 sm:p-6">
        <p className="rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-600 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400">
          You do not have access to billing in this workspace.
        </p>
      </div>
    );
  }

  const labels: Record<BillingTab, string> = {
    invoices: 'Invoices',
    recurring: 'Recurring',
    settings: 'Settings',
  };

  return (
    <div className="mx-auto w-full max-w-5xl space-y-4 p-3 sm:p-6">
      {available.length > 1 ? (
        <div
          role="tablist"
          aria-label="Billing sections"
          className="inline-flex gap-1 rounded-xl bg-slate-100 p-1 dark:bg-slate-800"
        >
          {available.map((value) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={tab === value}
              onClick={() => setChosenTab(value)}
              className={tabClass(tab === value)}
            >
              {labels[value]}
            </button>
          ))}
        </div>
      ) : null}

      {tab === 'invoices' ? <InvoicesPanel /> : null}
      {tab === 'recurring' ? <RecurringPanel /> : null}
      {tab === 'settings' ? <BillingSettingsPanel /> : null}
    </div>
  );
};

export default BillingPage;
