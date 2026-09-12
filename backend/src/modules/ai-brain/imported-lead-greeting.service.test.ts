/**
 * The opening message to an ad-form lead.
 *
 * This is the only path where the agent speaks first, to someone who never messaged it, so what
 * is checked here is that the message is shaped to be RECOGNISED: a stranger who cannot place why
 * you are in their WhatsApp is a stranger who reports you, and on an unofficial connection that
 * costs the number every conversation on it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: { NODE_ENV: 'test', LOG_LEVEL: 'silent' },
}));

const { buildGreetingDirective, createImportedLeadGreetingService } = await import(
  './imported-lead-greeting.service.js'
);

const conversation = { _id: { toString: () => 'conv-1' } } as never;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('the directive', () => {
  it('names the form, so the first line can be placed instantly', () => {
    const directive = buildGreetingDirective({
      sourceLabel: 'Wedding Genie — Aug 2026',
      category: 'wedding',
    });

    expect(directive).toContain('Wedding Genie — Aug 2026');
    expect(directive).toContain('FIRST message');
    expect(directive).toContain('never messaged us');
  });

  it('says what they enquired about, in words', () => {
    expect(buildGreetingDirective({ sourceLabel: 'F', category: 'house_warming' })).toContain(
      'house warming',
    );
  });

  it('admits when the service is unknown rather than guessing one', () => {
    // Inventing "wedding" here would have the opening confidently reference something they never
    // asked for, in the first sentence they ever read from us.
    const directive = buildGreetingDirective({ sourceLabel: 'F', category: 'unknown' });

    expect(directive).toContain('did not say which service');
  });
});

describe('sending it', () => {
  it('runs the normal qualifying graph with no inbound text', async () => {
    const handleInboundMessageForAutomation = vi.fn().mockResolvedValue(undefined);
    const service = createImportedLeadGreetingService({ handleInboundMessageForAutomation });

    await service.greetImportedLead({
      organizationId: 'org-1',
      conversation,
      sourceLabel: 'Wedding Genie',
      category: 'wedding',
    });

    // No second "first contact" prompt: same voice, same rules, same refusal to quote a price it
    // was not given. A separate prompt would be a second place for those to live, and they drift.
    expect(handleInboundMessageForAutomation).toHaveBeenCalledWith(
      expect.objectContaining({
        inboundText: '',
        inboundMessageId: 'auto-greet:conv-1',
        ownerInstruction: expect.stringContaining('Wedding Genie'),
      }),
    );
  });
});
