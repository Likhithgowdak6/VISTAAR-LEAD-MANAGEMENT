/**
 * The auto-greet sweep — the only path where this system speaks to someone who never messaged it.
 *
 * What is checked is the pacing and the escape hatches, because the failure here is not a bad
 * message, it is a banned WhatsApp number and every conversation on it gone with it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: { NODE_ENV: 'test', LOG_LEVEL: 'silent' },
}));

const { createAutoGreetSweepService } = await import('./auto-greet-sweep.service.js');

const NOW = new Date('2026-09-12T10:00:00.000Z');

// The three nullable fields are annotated rather than inferred: a hand-added lead sets
// leadSourceId to null and manualOutreachApprovedAt to a date, and TypeScript would otherwise
// narrow them to the literal types of the defaults and reject those overrides.
const conversation = (id: string) => ({
  _id: { toString: () => id },
  organizationId: 'org-1',
  leadSourceId: 'src-1' as string | null,
  aiCategory: 'wedding',
  manualOutreachApprovedAt: null as Date | null,
  manualOriginNote: null as string | null,
});

const deps = (due: ReturnType<typeof conversation>[] = []) => ({
  config: { LEAD_AUTO_GREET_MAX_PER_TICK: 5, LEAD_AUTO_GREET_SPACING_MS: 20000 } as never,
  findConversationsDueForAutoGreet: vi.fn().mockResolvedValue(due),
  claimAutoGreet: vi.fn().mockImplementation(({ conversationId }) => ({ _id: conversationId })),
  releaseAutoGreetClaim: vi.fn().mockResolvedValue(null),
  findLeadSourceById: vi
    .fn()
    .mockResolvedValue({ name: 'Wedding Genie', autoGreetEnabled: true }),
  greetImportedLead: vi.fn().mockResolvedValue(undefined),
  delay: vi.fn().mockResolvedValue(undefined),
  logger: { info: vi.fn(), error: vi.fn() },
  now: () => NOW,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('pacing', () => {
  it('asks for no more than the per-sweep budget', async () => {
    const d = deps();

    await createAutoGreetSweepService(d).run();

    // The cap is applied in the query, not after: fetching 200 and greeting 5 would still walk
    // 200 documents every minute for nothing.
    expect(d.findConversationsDueForAutoGreet).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 5, dueBefore: NOW }),
    );
  });

  it('waits between sends, but not after the last one', async () => {
    const d = deps([conversation('c1'), conversation('c2')]);

    await createAutoGreetSweepService(d).run();

    expect(d.greetImportedLead).toHaveBeenCalledTimes(2);
    // Five messages in five seconds reads as a bot. One trailing pause would just delay the tick.
    expect(d.delay).toHaveBeenCalledTimes(1);
    expect(d.delay).toHaveBeenCalledWith(20000);
  });

  it('does nothing, quietly, when nothing is due', async () => {
    const d = deps();

    await createAutoGreetSweepService(d).run();

    expect(d.claimAutoGreet).not.toHaveBeenCalled();
    expect(d.logger.info).not.toHaveBeenCalled();
  });
});

describe('changing your mind during the pause', () => {
  it('skips a lead whose source was switched off while it waited', async () => {
    const d = deps([conversation('c1')]);
    d.findLeadSourceById.mockResolvedValue({ name: 'Wedding Genie', autoGreetEnabled: false });

    await createAutoGreetSweepService(d).run();

    // The whole point of a delay is that it is a window in which the owner can still stop it.
    expect(d.greetImportedLead).not.toHaveBeenCalled();
  });

  it('skips a lead whose source has since been deleted', async () => {
    const d = deps([conversation('c1')]);
    d.findLeadSourceById.mockResolvedValue(null);

    await createAutoGreetSweepService(d).run();

    // This used to greet. It was changed when the gate was rewritten as "what says we MAY message
    // first" rather than "what says we may not": the old shape needed a lead source to exist in
    // order to refuse anything, so a missing one fell straight through.
    //
    // A deleted source is the absence of evidence of consent, not evidence of consent - and
    // deleting the whole source is a louder change of mind than flicking its toggle off, which
    // the test above already honours. The two outcomes are not symmetrical either: a greeting
    // dropped leaves the lead sitting in the inbox for the owner to message himself, while a
    // greeting sent to someone whose form he just deleted cannot be taken back.
    expect(d.greetImportedLead).not.toHaveBeenCalled();
  });

  it('refuses to greet a hand-added lead nobody approved', async () => {
    const d = deps([{ ...conversation('c1'), leadSourceId: null, manualOutreachApprovedAt: null }]);

    await createAutoGreetSweepService(d).run();

    // The regression this pins: the gate used to read `if (leadSource && ...)`, and a manually
    // added lead has no lead source at all - so the check was skipped entirely and the greeting
    // fired unconditionally. Cold outbound was permanently on, and invisible, for exactly the
    // leads where a person typed the number in by hand.
    expect(d.findLeadSourceById).not.toHaveBeenCalled();
    expect(d.greetImportedLead).not.toHaveBeenCalled();
  });

  it('greets a hand-added lead the owner did approve, without claiming a form', async () => {
    const d = deps([
      {
        ...conversation('c1'),
        leadSourceId: null,
        manualOutreachApprovedAt: new Date('2026-09-21T09:00:00.000Z'),
        manualOriginNote: 'met at the wedding expo',
      },
    ]);

    await createAutoGreetSweepService(d).run();

    expect(d.greetImportedLead).toHaveBeenCalledWith(
      expect.objectContaining({ origin: 'manual', originNote: 'met at the wedding expo' }),
    );
  });
});

describe('claims', () => {
  it('greets only what it successfully claimed', async () => {
    const d = deps([conversation('c1'), conversation('c2')]);
    d.claimAutoGreet.mockResolvedValueOnce(null).mockResolvedValueOnce({ _id: 'c2' });

    await createAutoGreetSweepService(d).run();

    // Another sweep got there first. Two "hi, you filled our form" messages is the worst possible
    // first impression.
    expect(d.greetImportedLead).toHaveBeenCalledTimes(1);
  });

  it('hands the claim back when the send fails', async () => {
    const d = deps([conversation('c1')]);
    d.greetImportedLead.mockRejectedValue(new Error('no session'));

    await createAutoGreetSweepService(d).run();

    // At-least-once on purpose: an unsent greeting is a lead who heard nothing while the owner
    // was told the AI had it.
    expect(d.releaseAutoGreetClaim).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org-1' }),
    );
    expect(d.logger.error).toHaveBeenCalled();
  });

  it('carries on to the next lead after one fails', async () => {
    const d = deps([conversation('c1'), conversation('c2')]);
    d.greetImportedLead.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(undefined);

    await createAutoGreetSweepService(d).run();

    expect(d.greetImportedLead).toHaveBeenCalledTimes(2);
  });
});
