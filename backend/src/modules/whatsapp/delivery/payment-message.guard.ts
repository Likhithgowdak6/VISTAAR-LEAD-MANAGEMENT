import mongoose, { Types } from 'mongoose';
import { type MessageDocument } from '../../messages/message.model.js';

type Row = Record<string, unknown>;
const row = (value: unknown): Row => value && typeof value === 'object' ? value as Row : {};
const date = (value: unknown): Date | null => {
  if (!value) return null;
  const result = value instanceof Date ? value : new Date(String(value));
  return Number.isFinite(result.getTime()) ? result : null;
};
const paymentWords = /\b(pay|payment|balance|settle|settlement|upi)\b|\bbank\s+transfer\b/i;
interface Reads {
  invoice: (organizationId: Types.ObjectId, invoiceId: Types.ObjectId) => Promise<Row | null>;
  totalPaid: (organizationId: Types.ObjectId, invoiceId: Types.ObjectId) => Promise<number>;
  humanReply: (organizationId: Types.ObjectId, conversationId: Types.ObjectId, since: Date) => Promise<unknown>;
  link: (organizationId: Types.ObjectId, invoiceId: Types.ObjectId, providerLinkId: string) => Promise<unknown>;
}
const reads: Reads = {
  invoice: (org, id) => mongoose.connection.db!.collection('invoices').findOne({ _id: id, organizationId: org, deletedAt: null }),
  totalPaid: async (org, id) => {
    const result = await mongoose.connection.db!.collection('payments').aggregate([
      { $match: { organizationId: org, invoiceId: id, voidedAt: null } },
      { $group: { _id: null, total: { $sum: '$amountPaise' } } },
    ]).toArray();
    return Number(result[0]?.total ?? 0);
  },
  humanReply: (org, cid, since) => mongoose.connection.db!.collection('messages').findOne({
    organizationId: org, conversationId: cid, authoredBy: 'human', createdAt: { $gte: since },
  }),
  link: (org, id, providerId) => mongoose.connection.db!.collection('payment_links').findOne({
    organizationId: org, invoiceId: id, providerLinkId: providerId, state: 'created',
  }),
};

/** Read-only final guard. Python owns approvals, ledger mutations, and chase scheduling. */
export const paymentMessageStopReason = async (
  message: MessageDocument, conversation: unknown, now: Date, store: Reads = reads,
): Promise<string | null> => {
  const context = message.paymentContext;
  if (!context) return null;
  if (![message.organizationId, message.conversationId, context.invoiceId].every(id => Types.ObjectId.isValid(String(id)))) {
    return 'payment_context_invalid';
  }
  const org = new Types.ObjectId(String(message.organizationId));
  const id = new Types.ObjectId(String(context.invoiceId));
  const invoice = await store.invoice(org, id);
  const chase = row(invoice?.paymentChase);
  if (!invoice || !['issued', 'sent'].includes(String(invoice.status)) ||
      String(invoice.conversationId) !== String(message.conversationId) ||
      String(invoice.contactId) !== String(message.contactId) ||
      chase.generation !== context.generation || chase.state !== 'active') return 'payment_chase_stopped';
  const conv = row(conversation);
  const approvedAt = date(chase.approvedAt);
  if (!approvedAt) return 'payment_context_invalid';
  if (!conversation || conv.isDeleted || conv.stage !== 'won') return 'payment_booking_not_won';
  const event = date(conv.eventDate);
  if (!event || event.getTime() > now.getTime() - 86400000) return 'payment_service_not_finished';
  if (conv.paymentSettledAt) return 'payment_owner_settled';
  if (conv.optedOutAt || conv.salesRejectedAt) return 'payment_recipient_stopped';
  if (conv.aiAutomationEnabled !== true) return 'payment_automation_paused';
  if ((date(conv.ownerLastTypedAt)?.getTime() ?? 0) >= approvedAt.getTime()) return 'payment_owner_takeover';
  if (row(conv.paymentInvoiceApproval).generation !== chase.generation) return 'payment_approval_revoked';
  const promise = row(conv.lastLeadCommitment);
  if (promise.direction === 'await_lead' && typeof promise.key === 'string' && promise.key && date(promise.dueAt) && paymentWords.test(String(promise.quote ?? '')) &&
      promise.key !== context.commitmentKey) return 'payment_promise_changed';
  if ((date(invoice.remindersPausedUntil)?.getTime() ?? 0) > now.getTime()) return 'payment_reminders_paused';
  if ((date(chase.notBefore)?.getTime() ?? 0) > now.getTime()) return 'payment_promise_pending';
  if (await store.humanReply(org, new Types.ObjectId(String(message.conversationId)), approvedAt)) return 'payment_owner_takeover';
  const balance = Number(invoice.totalPaise ?? 0) - await store.totalPaid(org, id);
  if (balance !== context.amountDuePaise) return 'payment_balance_changed';
  if (context.providerLinkId && !await store.link(org, id, context.providerLinkId)) return 'payment_link_unavailable';
  return null;
};
