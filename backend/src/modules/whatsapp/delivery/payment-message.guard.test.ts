import { describe, expect, it, vi } from 'vitest';
import { paymentMessageStopReason } from './payment-message.guard.js';

const id = (n: number) => n.toString(16).padStart(24, '0');
const now = new Date('2026-11-20T12:00:00Z');
const harness = () => {
  const message = { organizationId: id(1), conversationId: id(2), contactId: id(3),
    paymentContext: { invoiceId: id(4), generation: 'approved', amountDuePaise: 10000, commitmentKey: null, providerLinkId: 'plink_test' } };
  const invoice = { conversationId: id(2), contactId: id(3), status: 'issued', totalPaise: 10000,
    paymentChase: { state: 'active', generation: 'approved', approvedAt: new Date('2026-11-20T11:00:00Z') } };
  const conversation: Record<string, unknown> = { stage: 'won', eventDate: new Date('2026-11-18T12:00:00Z'),
    aiAutomationEnabled: true, paymentInvoiceApproval: { generation: 'approved' } };
  const store = { invoice: vi.fn().mockResolvedValue(invoice), totalPaid: vi.fn().mockResolvedValue(0),
    humanReply: vi.fn().mockResolvedValue(null), link: vi.fn().mockResolvedValue({ state: 'created' }) };
  const run = () => paymentMessageStopReason(message as never, conversation, now, store);
  return { message, invoice, conversation, store, run };
};
describe('last-moment payment reminder guard', () => {
  it('does not query billing for ordinary messages', async () => {
    const h = harness(); delete (h.message as { paymentContext?: unknown }).paymentContext;
    expect(await h.run()).toBeNull();
    expect(h.store.invoice).not.toHaveBeenCalled();
  });
  it('allows an approved reminder for the current ledger balance', async () => {
    expect(await harness().run()).toBeNull();
  });
  it.each([
    ['paymentSettledAt', now, 'payment_owner_settled'],
    ['optedOutAt', now, 'payment_recipient_stopped'],
    ['aiAutomationEnabled', false, 'payment_automation_paused'],
    ['ownerLastTypedAt', now, 'payment_owner_takeover'],
    ['stage', 'contacted', 'payment_booking_not_won'],
    ['eventDate', now, 'payment_service_not_finished'],
    ['paymentInvoiceApproval', { generation: 'revoked' }, 'payment_approval_revoked'],
  ])('blocks %s changes after queueing', async (key, value, reason) => {
    const h = harness(); h.conversation[String(key)] = value;
    expect(await h.run()).toBe(reason);
  });
  it('reads the ledger rather than trusting amountPaidPaise', async () => {
    const h = harness(); h.store.totalPaid.mockResolvedValue(4000);
    expect(await h.run()).toBe('payment_balance_changed');
  });
  it('blocks payment on an invoice linked to another contact', async () => {
    const h = harness(); h.invoice.contactId = id(5);
    expect(await h.run()).toBe('payment_chase_stopped');
  });
  it('blocks a new payment promise before the Python sweep updates the invoice', async () => {
    const h = harness();
    h.conversation.lastLeadCommitment = { key: 'new-promise', direction: 'await_lead',
      quote: 'I will pay next Friday', dueAt: new Date('2026-11-27T12:00:00Z') };
    expect(await h.run()).toBe('payment_promise_changed');
  });
  it('blocks a staff reply written after approval', async () => {
    const h = harness(); h.store.humanReply.mockResolvedValue({} as never);
    expect(await h.run()).toBe('payment_owner_takeover');
  });
  it('blocks a revoked or paid payment link', async () => {
    const h = harness(); h.store.link.mockResolvedValue(null as never);
    expect(await h.run()).toBe('payment_link_unavailable');
  });
  it('propagates database errors so delivery fails closed', async () => {
    const h = harness(); h.store.totalPaid.mockRejectedValue(new Error('synthetic database failure'));
    await expect(h.run()).rejects.toThrow('synthetic database failure');
  });
});
