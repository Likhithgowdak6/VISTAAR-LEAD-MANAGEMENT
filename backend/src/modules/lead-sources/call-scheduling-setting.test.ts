/**
 * Only a Meta source may switch the call-scheduling workflow on.
 *
 * WHY THIS IS CHECKED ON THE SERVER AND NOT ONLY IN THE UI. The dashboard hides the toggle for
 * a Google Sheet source, but hiding a control is a courtesy, not a guarantee - the field is a
 * plain boolean on an authenticated PATCH anyone with the permission can call. If a sheet
 * source could carry the flag, the workflow would be armed for rows that have no verified Meta
 * submission id behind them, which is the one thing its eligibility rests on.
 *
 * Forced to false rather than rejected: a client sending it harmlessly gets the safe answer
 * instead of a 400 it cannot act on.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: { NODE_ENV: 'test', LOG_LEVEL: 'silent' },
}));

const mocks = vi.hoisted(() => ({
  findLeadSourceById: vi.fn(),
  updateLeadSource: vi.fn(),
  serializeLeadSource: vi.fn((value: unknown) => value),
}));

vi.mock('./lead-source.repository.js', () => ({
  findLeadSourceById: mocks.findLeadSourceById,
  updateLeadSource: mocks.updateLeadSource,
}));

vi.mock('./lead-source.serializer.js', () => ({
  serializeLeadSource: mocks.serializeLeadSource,
}));

const { updateLeadSourceForActor } = await import('./lead-source.service.js');

const actor = { _id: 'user-1' } as never;

const update = (kind: string, callSchedulingEnabled?: boolean) => {
  mocks.findLeadSourceById.mockResolvedValue({ _id: 'ls-1', kind, organizationId: 'org-1' });
  mocks.updateLeadSource.mockResolvedValue({ _id: 'ls-1' });

  return updateLeadSourceForActor({
    organizationId: 'org-1',
    leadSourceId: 'ls-1',
    actor,
    ...(callSchedulingEnabled === undefined ? {} : { callSchedulingEnabled }),
  });
};

/** What actually reached the repository. */
const written = () =>
  (mocks.updateLeadSource.mock.calls.at(-1)?.[0] ?? {}) as Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('enabling call scheduling', () => {
  it('is allowed on a Meta Lead Ads source', async () => {
    await update('meta_lead_ads', true);

    expect(written().callSchedulingEnabled).toBe(true);
  });

  it('is forced OFF on a Google Sheet source', async () => {
    await update('google_sheet', true);

    // A spreadsheet row carries no Meta lead id, so the workflow could never verify its own
    // eligibility. Switching it on would arm a chase with nothing to key on.
    expect(written().callSchedulingEnabled).toBe(false);
  });

  it('is forced OFF on a source with no kind at all', async () => {
    // Every source written before `kind` existed is a sheet by definition.
    await update('', true);

    expect(written().callSchedulingEnabled).toBe(false);
  });

  it('can always be turned off, whatever the kind', async () => {
    await update('google_sheet', false);

    expect(written().callSchedulingEnabled).toBe(false);
  });

  it('is left untouched when the request does not mention it', async () => {
    await update('meta_lead_ads');

    // `undefined` means "not part of this PATCH" - the repository skips the field entirely
    // rather than defaulting it to false and silently disabling a working workflow.
    expect(written().callSchedulingEnabled).toBeUndefined();
  });

  it('does not disturb the auto-greet switch', async () => {
    await update('meta_lead_ads', true);

    // The two are independent decisions: one lets the AI speak first, the other decides what
    // it asks for and whether it chases.
    expect(written().autoGreetEnabled).toBeUndefined();
  });
});
