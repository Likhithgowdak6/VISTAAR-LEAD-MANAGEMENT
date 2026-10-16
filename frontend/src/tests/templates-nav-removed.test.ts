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
    'reminders',
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
