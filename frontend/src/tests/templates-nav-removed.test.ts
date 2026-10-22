/**
 * Templates is gone from the top bar, and the rest of the bar is not.
 *
 * HONEST ABOUT WHAT THIS IS. These read the AppShell source rather than rendering it. A render
 * test would need every page, the auth context, the realtime hook and the reminder hook mocked
 * to assert the absence of one button - disproportionate, and it would break for reasons that
 * have nothing to do with navigation.
 *
 * What a structural guard does buy: if someone re-adds the Templates nav entry, or removes
 * Settings while editing this area, it fails immediately. That is the regression worth
 * catching, and typecheck covers the rest - `View` no longer has a 'templates' member, so
 * `setView('templates')` would not compile.
 *
 * TEMPLATE FUNCTIONALITY IS NOT DELETED. TemplatesPage.tsx, the /templates endpoints and every
 * saved template still exist; only the top-bar route into the page is gone. The writer itself
 * is now reached from the lead panel - see MessageTemplatesSection.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const appShell = readFileSync(join(process.cwd(), 'src/pages/AppShell.tsx'), 'utf8');

describe('the top navigation', () => {
  it('no longer offers Templates', () => {
    expect(appShell).not.toContain('>Templates<');
    expect(appShell).not.toContain("setView('templates')");
  });

  it('no longer routes to the Templates page', () => {
    expect(appShell).not.toContain('<TemplatesPage');
    expect(appShell).not.toContain("from './TemplatesPage'");
  });

  it.each([
    'inbox',
    'analytics',
    'accounts',
    'team',
    'stages',
    'tags',
    'lead-sources',
    'ai-knowledge',
    'settings',
  ])('still routes to %s', (view) => {
    // The point of removing one item is removing exactly ONE item. Matched on the view key
    // rather than the label, because the label sits on its own JSX line.
    expect(appShell).toContain(`setView('${view}')`);
  });
});

/**
 * Reminders followed Templates out of the top bar, for the same reason and with the same rule:
 * the destination goes, the feature does not. A reminder is about one conversation, so the list
 * of them now lives in that lead's Details panel.
 *
 * The things that must NOT have gone with it are asserted below - the scheduler, the APIs, the
 * device-alarm sync - because each is reachable from somewhere other than the page, and
 * deleting the page is only safe for as long as that stays true.
 */
describe('the Reminders destination', () => {
  it('is gone from both navigations', () => {
    expect(appShell).not.toContain("setView('reminders')");
    expect(appShell).not.toContain('<RemindersPage');
    expect(appShell).not.toContain("from './RemindersPage'");
  });

  it('is gone from the bottom bar on a phone', () => {
    const bottomNav = readFileSync(
      join(process.cwd(), 'src/components/mobile/MobileBottomNav.tsx'),
      'utf8',
    );

    // Matched on the affordance, not the word: the file's own comment explains why the tab
    // went, so asserting the absence of "Reminders" would fail on the explanation.
    expect(bottomNav).not.toContain('onReminders');
    expect(bottomNav).not.toContain("active === 'reminders'");
  });

  it('still arms device alarms, which never depended on the page', () => {
    // The sync loop lives in a hook mounted by AppShell, so removing the page cannot stop a
    // reminder ringing. If this ever moves into a page again, this fails.
    expect(appShell).toContain('useReminderAlarms');
    expect(appShell).toContain('syncAlarms');
  });

  it('hands the lead panel what the page used to own', () => {
    // Re-arming after a change, and the device-permission notice. Without these a reminder
    // created in Lead Details would not ring until the next app start.
    expect(appShell).toContain('onRemindersChanged={syncAlarms}');
    expect(appShell).toContain('reminderAlarms=');
  });
});

describe('the reminder feature itself survives', () => {
  it('still has the page on disk, unrouted', () => {
    // Same treatment as TemplatesPage: not deleted, just not a destination. It is the only
    // implementation of the personal-reminder list, which has no lead to live under.
    const page = readFileSync(join(process.cwd(), 'src/pages/RemindersPage.tsx'), 'utf8');

    expect(page).toContain('RemindersPage');
  });

  it('still exposes every reminder endpoint the lead panel and Android need', () => {
    const endpoints = readFileSync(join(process.cwd(), 'src/api/endpoints.ts'), 'utf8');

    for (const name of [
      'listConversationFollowUps',
      'createFollowUp',
      'rescheduleFollowUp',
      'completeFollowUp',
      'cancelFollowUp',
      'syncReminders',
    ]) {
      expect(endpoints).toContain(name);
    }
  });
});

describe('the template feature itself survives', () => {
  it('still has a Templates page on disk', () => {
    // Deliberately not deleted: the page, its saved templates and the API behind them are
    // untouched. Only the navigation entry was asked for.
    const page = readFileSync(join(process.cwd(), 'src/pages/TemplatesPage.tsx'), 'utf8');

    expect(page).toContain('TemplatesPage');
  });

  it('still exposes the generate endpoint the lead panel now reuses', () => {
    const endpoints = readFileSync(join(process.cwd(), 'src/api/endpoints.ts'), 'utf8');

    expect(endpoints).toContain('generateTemplates');
    expect(endpoints).toContain("'/templates/generate'");
  });
});
