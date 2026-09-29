/**
 * What actually reaches the database on a PATCH.
 *
 * This file exists because of a bug that every other layer reported as a success. `autoGreetEnabled`
 * was in the validation schema, so the request parsed; the controller returned 200 with the
 * serialized source; the dashboard showed no error. The field was simply never destructured in the
 * controller, the service or the repository, so it was dropped on the floor between the request
 * body and the `$set`. The switch that decides whether the AI cold-messages a stranger could not be
 * changed from the UI at all, in either direction, and nothing anywhere said so.
 *
 * Schema tests could not have caught it - the schema was correct. So these assert the seam the
 * schema tests do not reach: that a parsed field survives all the way into the update document.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: { NODE_ENV: 'test', LOG_LEVEL: 'silent' },
}));

const mocks = vi.hoisted(() => ({
  findOneAndUpdate: vi.fn(),
}));

vi.mock('./lead-source.model.js', () => ({
  LeadSource: { findOneAndUpdate: mocks.findOneAndUpdate },
}));

const { updateLeadSource } = await import('./lead-source.repository.js');

const LEAD_SOURCE_ID = '65b0f0f0f0f0f0f0f0f0f0f2';
const ORG_ID = '65b0f0f0f0f0f0f0f0f0f0f1';

/** The `$set` document the repository built for this call. */
const setDocument = () => mocks.findOneAndUpdate.mock.calls[0]?.[1]?.$set ?? {};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findOneAndUpdate.mockReturnValue({ exec: () => Promise.resolve({}) });
});

describe('updateLeadSource — booleans survive to the $set', () => {
  it.each([
    ['autoGreetEnabled', true],
    ['autoGreetEnabled', false],
    ['aiContextEnabled', true],
    ['aiContextEnabled', false],
  ])('writes %s: %s', async (field, value) => {
    await updateLeadSource({
      leadSourceId: LEAD_SOURCE_ID,
      organizationId: ORG_ID,
      [field]: value,
    });

    expect(setDocument()).toMatchObject({ [field]: value });
  });

  it('turning auto-greet OFF is written, not swallowed', async () => {
    // The exact regression: `false` is the value that STOPS the AI messaging strangers. A
    // truthiness check here, or a missing destructure anywhere in the chain, makes the off switch
    // silently inoperable while still returning 200.
    await updateLeadSource({
      leadSourceId: LEAD_SOURCE_ID,
      organizationId: ORG_ID,
      autoGreetEnabled: false,
    });

    expect(setDocument()).toHaveProperty('autoGreetEnabled', false);
  });

  it('omits a field that was not supplied, rather than defaulting it to false', async () => {
    // A PATCH names only what it changes. Writing `autoGreetEnabled: false` here because the
    // caller left it undefined would turn the greeting off every time someone renamed a source.
    await updateLeadSource({
      leadSourceId: LEAD_SOURCE_ID,
      organizationId: ORG_ID,
      name: 'Renamed',
    });

    expect(setDocument()).toMatchObject({ name: 'Renamed' });
    expect(setDocument()).not.toHaveProperty('autoGreetEnabled');
    expect(setDocument()).not.toHaveProperty('aiContextEnabled');
  });

  it('scopes the write to the organization, never by id alone', async () => {
    await updateLeadSource({
      leadSourceId: LEAD_SOURCE_ID,
      organizationId: ORG_ID,
      autoGreetEnabled: true,
    });

    expect(mocks.findOneAndUpdate.mock.calls[0]?.[0]).toMatchObject({
      _id: LEAD_SOURCE_ID,
      organizationId: ORG_ID,
    });
  });
});
