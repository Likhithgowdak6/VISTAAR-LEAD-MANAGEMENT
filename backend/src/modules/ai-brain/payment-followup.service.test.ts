/**
 * Payment follow-up.
 *
 * The rule under test throughout: the AI never messages a client about money unless the owner has
 * explicitly said it is outstanding, and never more than once. Asking someone who has already paid
 * to pay again is an accusation, not an annoyance, and it lands on a customer who just spent money.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: { NODE_ENV: 'test', LOG_LEVEL: 'silent' },
}));

const { buildPaymentPrompt, createPaymentFollowUpService, parsePaymentReply } = await import(
  './payment-followup.service.js'
);

const organizationId = 'org-1';
const NOW = new Date('2026-09-11T06:00:00.000Z');

const conversation = {
  _id: 'conv-1',
  whatsappAccountId: 'account-1',
  displayName: 'Likhith',
  eventDate: new Date('2026-09-09T00:00:00.000Z'),
};

const deps = () => ({
  findBookingsAwaitingPaymentPrompt: vi.fn().mockResolvedValue([]),
  claimPaymentPrompt: vi.fn().mockResolvedValue(conversation),
  releasePaymentPromptClaim: vi.fn().mockResolvedValue(null),
  findConversationByPaymentCode: vi.fn().mockResolvedValue(conversation),
  recordPaymentSettled: vi.fn().mockResolvedValue(conversation),
  claimPaymentChase: vi.fn().mockResolvedValue(conversation),
  listOrganizations: vi.fn().mockResolvedValue([{ _id: organizationId }]),
  createActivity: vi.fn().mockResolvedValue(null),
  sendToClient: vi.fn().mockResolvedValue(null),
  createFollowUp: vi.fn().mockResolvedValue(null),
  notifyOwner: vi.fn().mockResolvedValue({ providerMessageId: 'MSG-1' }),
  logger: { info: vi.fn(), error: vi.fn() },
  now: () => NOW,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('reading his answer', () => {
  it.each([
    ['B4 collected', true],
    ['b4 received', true],
    ['B4 paid', true],
    ['B4 done', true],
    ['B4 not collected', false],
    ['B4 notcollected', false],
    ['B4 not  paid', false],
    ['B4 notreceived', false],
    ['B4 pending', false],
    ['B4 no', false],
  ])('reads %s', (text, collected) => {
    expect(parsePaymentReply(text)).toEqual({ code: 'B4', collected });
  });

  it('only ever says collected for an explicit yes', () => {
    // The check is "is this a yes", not "is this not a no". A yes it fails to recognise costs one
    // avoidable reminder; a no it reads as yes writes real money off and tells nobody.
    const positives = ['collected', 'received', 'paid', 'done'];

    for (const word of positives) {
      expect(parsePaymentReply(`B4 ${word}`)?.collected).toBe(true);
      expect(parsePaymentReply(`B4 not ${word}`)?.collected).toBe(false);
      expect(parsePaymentReply(`B4 not${word}`)?.collected).toBe(false);
    }
  });

  it('ignores a bare approval-card reply, which means something else entirely', () => {
    // "B4" and "B4 1" are approval-card replies and must keep meaning that.
    expect(parsePaymentReply('B4')).toBeNull();
    expect(parsePaymentReply('B4 1')).toBeNull();
  });

  it('ignores a sentence that merely mentions money', () => {
    expect(parsePaymentReply('did the payment for B4 come in?')).toBeNull();
    expect(parsePaymentReply('collected')).toBeNull();
  });
});

describe('asking him', () => {
  it('asks once per booking, with a code to answer by', async () => {
    const d = deps();
    d.findBookingsAwaitingPaymentPrompt.mockResolvedValue([conversation]);

    await createPaymentFollowUpService(d).run();

    expect(d.claimPaymentPrompt).toHaveBeenCalledTimes(1);
    const [{ text }] = d.notifyOwner.mock.calls[0];
    expect(text).toContain('Likhith');
    expect(text).toMatch(/Reply \*[A-Z][1-9] collected\*/);
  });

  it('gives a day of grace rather than asking the same evening', async () => {
    const d = deps();

    await createPaymentFollowUpService(d).run();

    expect(d.findBookingsAwaitingPaymentPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ endedBefore: new Date('2026-09-10T06:00:00.000Z') }),
    );
  });

  it('hands the claim back when the ask could not be delivered', async () => {
    const d = deps();
    d.findBookingsAwaitingPaymentPrompt.mockResolvedValue([conversation]);
    d.notifyOwner.mockRejectedValueOnce(new Error('no session'));

    await createPaymentFollowUpService(d).run();

    // An unasked question is money quietly forgotten, so the next sweep must ask again.
    expect(d.releasePaymentPromptClaim).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-1' }),
    );
  });

  it('names the booking and its date in the prompt', () => {
    const text = buildPaymentPrompt({
      displayName: 'Likhith',
      eventDate: new Date('2026-09-09T00:00:00.000Z'),
      code: 'B4',
    });

    expect(text).toContain('Likhith (9 Sep 2026)');
  });
});

describe('when he says it came in', () => {
  it('closes it out and says nothing back', async () => {
    const d = deps();

    const handled = await createPaymentFollowUpService(d).handleOwnerReply({
      organizationId,
      text: 'B4 collected',
    });

    expect(handled).toBe(true);
    expect(d.recordPaymentSettled).toHaveBeenCalled();
    // He told us. Repeating it back is noise.
    expect(d.notifyOwner).not.toHaveBeenCalled();
    expect(d.sendToClient).not.toHaveBeenCalled();
  });
});

describe('when he says it is outstanding', () => {
  it('sends the client exactly one polite message and hands it back to him', async () => {
    const d = deps();

    await createPaymentFollowUpService(d).handleOwnerReply({
      organizationId,
      text: 'B4 pending',
    });

    expect(d.sendToClient).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-1' }),
    );
    expect(d.createFollowUp).toHaveBeenCalled();
    expect(d.notifyOwner).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining("only one I'll send") }),
    );
  });

  it('refuses to send a second one', async () => {
    const d = deps();
    d.claimPaymentChase.mockResolvedValue(null);

    await createPaymentFollowUpService(d).handleOwnerReply({
      organizationId,
      text: 'B4 pending',
    });

    // Chasing is a relationship, not a retry loop.
    expect(d.sendToClient).not.toHaveBeenCalled();
    expect(d.notifyOwner).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('one reminder') }),
    );
  });
});

describe('what silence means', () => {
  it('never treats a non-answer as unpaid', async () => {
    const d = deps();

    const handled = await createPaymentFollowUpService(d).handleOwnerReply({
      organizationId,
      text: 'ok thanks',
    });

    // Not a payment reply at all: the caller carries on, and crucially nobody is chased.
    expect(handled).toBe(false);
    expect(d.sendToClient).not.toHaveBeenCalled();
    expect(d.recordPaymentSettled).not.toHaveBeenCalled();
  });

  it('never chases on a code it has no open question for', async () => {
    const d = deps();
    d.findConversationByPaymentCode.mockResolvedValue(null);

    await createPaymentFollowUpService(d).handleOwnerReply({
      organizationId,
      text: 'Z9 pending',
    });

    expect(d.sendToClient).not.toHaveBeenCalled();
    expect(d.notifyOwner).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('Z9') }),
    );
  });
});
