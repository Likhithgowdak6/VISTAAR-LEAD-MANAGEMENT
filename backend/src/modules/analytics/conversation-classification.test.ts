/**
 * The classification rules, case by case.
 *
 * These are the numbers on the analytics page. If a rule here is wrong the dashboard is
 * confidently wrong, which is worse than having no dashboard - so each case below is a concrete
 * situation from the brief rather than a property of the code, and the awkward ones (a
 * confirmed customer who says "ok", a reply that succeeded and then a newer message, a legacy
 * row with no recorded reply) are the point of the file.
 */
import { describe, expect, it } from 'vitest';

import {
  AI_RESPONSE_STATUSES,
  ENQUIRY_CLASSES,
  classifyEnquiry,
  hasUnansweredInbound,
  needsAttention,
  resolveAiResponseStatus,
  resolveLastAiReplyAt,
  type AttentionInput,
} from './conversation-classification.js';

const at = (iso: string) => new Date(iso);

const MON = at('2026-10-19T09:00:00.000Z');
const TUE = at('2026-10-20T09:00:00.000Z');
const WED = at('2026-10-21T09:00:00.000Z');

const conversation = (overrides: AttentionInput = {}): AttentionInput => ({
  leadQualificationStatus: 'unknown',
  aiAutomationEnabled: true,
  ...overrides,
});

describe('enquiry classification', () => {
  it('calls a confirmed conversation an enquiry', () => {
    expect(classifyEnquiry(conversation({ leadQualificationStatus: 'confirmed' }))).toBe(
      ENQUIRY_CLASSES.ENQUIRY,
    );
  });

  it('calls a rejected conversation a non-enquiry', () => {
    expect(classifyEnquiry(conversation({ leadQualificationStatus: 'rejected' }))).toBe(
      ENQUIRY_CLASSES.NOT_ENQUIRY,
    );
  });

  it('puts an unknown conversation in needs review, NOT in non-enquiry', () => {
    // The distinction the brief is most insistent on: "we have not established this" is not the
    // same claim as "this is not a customer", and only one of them is safe to act on.
    expect(classifyEnquiry(conversation({ leadQualificationStatus: 'unknown' }))).toBe(
      ENQUIRY_CLASSES.NEEDS_REVIEW,
    );
  });

  it('puts a legacy row with no qualification field at all in needs review', () => {
    expect(classifyEnquiry({})).toBe(ENQUIRY_CLASSES.NEEDS_REVIEW);
  });

  it('KEEPS a confirmed enquiry confirmed when the latest message is a short follow-up', () => {
    // "ok" / "yes" / "I'll confirm tomorrow". Nothing in this module reads the last message, so
    // there is no path by which one can downgrade an established lead - this asserts that the
    // inputs which DO move (an inbound arriving, a reply being owed) leave the class alone.
    const established = conversation({
      leadQualificationStatus: 'confirmed',
      leadQualificationSource: 'ai_reply_sent',
      leadQualifiedAt: MON,
      lastInboundAt: WED,
    });

    expect(classifyEnquiry(established)).toBe(ENQUIRY_CLASSES.ENQUIRY);
    expect(resolveAiResponseStatus(established)).toBe(AI_RESPONSE_STATUSES.AWAITING);
  });

  it('does not mark a conversation a non-enquiry just because the AI never replied', () => {
    const neverAnswered = conversation({ lastInboundAt: TUE, lastAiReplyAt: null });

    expect(classifyEnquiry(neverAnswered)).not.toBe(ENQUIRY_CLASSES.NOT_ENQUIRY);
    expect(classifyEnquiry(neverAnswered)).toBe(ENQUIRY_CLASSES.NEEDS_REVIEW);
  });

  it('does not mark a paused conversation a non-enquiry', () => {
    expect(classifyEnquiry(conversation({ aiAutomationEnabled: false }))).toBe(
      ENQUIRY_CLASSES.NEEDS_REVIEW,
    );
  });
});

describe('when a reply was last delivered', () => {
  it('uses the recorded delivery time when there is one', () => {
    expect(resolveLastAiReplyAt(conversation({ lastAiReplyAt: TUE }))).toEqual(TUE);
  });

  it('falls back to the qualification time, which IS a delivered reply', () => {
    // A conversation becomes `confirmed` only because a qualifying AI reply reached WhatsApp,
    // so this timestamp is evidence rather than an estimate. It is how legacy rows - written
    // before lastAiReplyAt existed - still answer this question.
    expect(
      resolveLastAiReplyAt(
        conversation({
          leadQualificationStatus: 'confirmed',
          leadQualificationSource: 'ai_reply_sent',
          leadQualifiedAt: MON,
        }),
      ),
    ).toEqual(MON);
  });

  it('accepts the adopted-legacy qualification source too', () => {
    expect(
      resolveLastAiReplyAt(
        conversation({
          leadQualificationSource: 'legacy_delivered_reply',
          leadQualifiedAt: MON,
        }),
      ),
    ).toEqual(MON);
  });

  it('does NOT treat a classifier rejection timestamp as a reply', () => {
    // `rejected` is also stamped with leadQualifiedAt, and nothing was sent to anybody.
    expect(
      resolveLastAiReplyAt(
        conversation({
          leadQualificationStatus: 'rejected',
          leadQualificationSource: 'classifier_non_lead',
          leadQualifiedAt: MON,
        }),
      ),
    ).toBeNull();
  });

  it('prefers the recorded time over the qualification fallback', () => {
    expect(
      resolveLastAiReplyAt(
        conversation({
          leadQualificationSource: 'ai_reply_sent',
          leadQualifiedAt: MON,
          lastAiReplyAt: WED,
        }),
      ),
    ).toEqual(WED);
  });
});

describe('AI response status', () => {
  it('reports a replied enquiry with nothing new since', () => {
    expect(
      resolveAiResponseStatus(
        conversation({
          leadQualificationStatus: 'confirmed',
          lastInboundAt: MON,
          lastAiReplyAt: TUE,
        }),
      ),
    ).toBe(AI_RESPONSE_STATUSES.REPLIED);
  });

  it('REOPENS to awaiting when a newer message arrives after a successful reply', () => {
    // The single most important case in this file, and the one a permanent "has replied" flag
    // gets wrong: the AI did answer, days ago, and the customer has since asked something else.
    expect(
      resolveAiResponseStatus(
        conversation({
          leadQualificationStatus: 'confirmed',
          lastAiReplyAt: MON,
          lastInboundAt: WED,
        }),
      ),
    ).toBe(AI_RESPONSE_STATUSES.AWAITING);
  });

  it('reports an enquiry that has never been answered as awaiting', () => {
    expect(
      resolveAiResponseStatus(
        conversation({ leadQualificationStatus: 'confirmed', lastInboundAt: TUE }),
      ),
    ).toBe(AI_RESPONSE_STATUSES.AWAITING);
  });

  it('reports a paused conversation as paused, not awaiting', () => {
    expect(
      resolveAiResponseStatus(
        conversation({
          leadQualificationStatus: 'confirmed',
          aiAutomationEnabled: false,
          lastInboundAt: WED,
        }),
      ),
    ).toBe(AI_RESPONSE_STATUSES.PAUSED);
  });

  it('reports a failed send, and ranks it above awaiting', () => {
    expect(
      resolveAiResponseStatus(
        conversation({
          leadQualificationStatus: 'confirmed',
          lastInboundAt: TUE,
          lastAiSendFailedAt: WED,
        }),
      ),
    ).toBe(AI_RESPONSE_STATUSES.FAILED);
  });

  it('clears a failure once a later send succeeds', () => {
    expect(
      resolveAiResponseStatus(
        conversation({
          leadQualificationStatus: 'confirmed',
          lastAiSendFailedAt: MON,
          lastAiReplyAt: TUE,
          lastInboundAt: MON,
        }),
      ),
    ).toBe(AI_RESPONSE_STATUSES.REPLIED);
  });

  it('owes nothing to a non-enquiry', () => {
    expect(
      resolveAiResponseStatus(
        conversation({ leadQualificationStatus: 'rejected', lastInboundAt: WED }),
      ),
    ).toBe(AI_RESPONSE_STATUSES.NOT_NEEDED);
  });

  it('owes nothing to someone who opted out, however they are classified', () => {
    expect(
      resolveAiResponseStatus(
        conversation({
          leadQualificationStatus: 'confirmed',
          optedOutAt: MON,
          lastInboundAt: WED,
        }),
      ),
    ).toBe(AI_RESPONSE_STATUSES.NOT_NEEDED);
  });

  it('does not claim an unclassified thread is awaiting an AI reply', () => {
    // There is an unanswered message, but nothing establishes that the AI is going to answer
    // it. Saying "awaiting AI reply" would put it in a queue that nothing drains.
    const unclassified = conversation({ leadQualificationStatus: 'unknown', lastInboundAt: WED });

    expect(resolveAiResponseStatus(unclassified)).toBe(AI_RESPONSE_STATUSES.NEEDS_REVIEW);
    expect(needsAttention(unclassified)).toBe(true);
  });

  it('reports a legacy row with nothing recorded as needs review', () => {
    expect(resolveAiResponseStatus({})).toBe(AI_RESPONSE_STATUSES.NEEDS_REVIEW);
  });

  it('puts every conversation in exactly one bucket', () => {
    // The cards on the dashboard are added together, so the buckets have to partition. Any
    // combination of the inputs must produce exactly one status, and never throw.
    const dates = [null, MON, WED];
    const seen = new Set<string>();

    for (const status of ['unknown', 'confirmed', 'rejected'] as const) {
      for (const automation of [true, false]) {
        for (const inbound of dates) {
          for (const reply of dates) {
            for (const failure of dates) {
              const result = resolveAiResponseStatus(
                conversation({
                  leadQualificationStatus: status,
                  aiAutomationEnabled: automation,
                  lastInboundAt: inbound,
                  lastAiReplyAt: reply,
                  lastAiSendFailedAt: failure,
                }),
              );

              expect(Object.values(AI_RESPONSE_STATUSES)).toContain(result);
              seen.add(result);
            }
          }
        }
      }
    }

    // And the inputs above are varied enough to actually reach every bucket.
    expect(seen.size).toBe(Object.values(AI_RESPONSE_STATUSES).length);
  });
});

describe('unanswered inbound', () => {
  it('is true when the customer spoke last', () => {
    expect(hasUnansweredInbound(conversation({ lastInboundAt: WED, lastAiReplyAt: MON }))).toBe(true);
  });

  it('is false when the reply came after', () => {
    expect(hasUnansweredInbound(conversation({ lastInboundAt: MON, lastAiReplyAt: WED }))).toBe(
      false,
    );
  });

  it('counts a HUMAN reply as an answer, not just the AI', () => {
    // The owner typing by hand settles the customer's question. Treating only AI sends as
    // answers would keep a manually-handled thread on the attention list forever.
    expect(
      hasUnansweredInbound(
        conversation({ lastInboundAt: MON, lastDeliveredOutboundAt: WED, lastAiReplyAt: null }),
      ),
    ).toBe(false);
  });

  it('still reports waiting when the human reply predates the newest message', () => {
    expect(
      hasUnansweredInbound(
        conversation({ lastInboundAt: WED, lastDeliveredOutboundAt: MON }),
      ),
    ).toBe(true);
  });

  it('is false for a conversation that has never received anything', () => {
    expect(hasUnansweredInbound(conversation({}))).toBe(false);
  });
});

describe('needs attention', () => {
  it('includes an enquiry awaiting a reply', () => {
    expect(
      needsAttention(
        conversation({ leadQualificationStatus: 'confirmed', lastInboundAt: WED }),
      ),
    ).toBe(true);
  });

  it('includes a PAUSED thread with the customer waiting', () => {
    // The AI will not pick this up. If nobody looks at it, nobody answers it - which is exactly
    // what an attention list is for.
    expect(
      needsAttention(
        conversation({
          leadQualificationStatus: 'confirmed',
          aiAutomationEnabled: false,
          lastInboundAt: WED,
        }),
      ),
    ).toBe(true);
  });

  it('includes a follow-up that has come due', () => {
    expect(
      needsAttention(
        conversation({ leadQualificationStatus: 'confirmed', nextFollowUpAt: MON }),
        TUE,
      ),
    ).toBe(true);
  });

  it('excludes a follow-up that is still in the future', () => {
    expect(
      needsAttention(
        conversation({ leadQualificationStatus: 'confirmed', nextFollowUpAt: WED }),
        TUE,
      ),
    ).toBe(false);
  });

  it('excludes a non-enquiry and an opted-out contact', () => {
    expect(
      needsAttention(conversation({ leadQualificationStatus: 'rejected', lastInboundAt: WED })),
    ).toBe(false);
    expect(
      needsAttention(
        conversation({
          leadQualificationStatus: 'confirmed',
          optedOutAt: MON,
          lastInboundAt: WED,
        }),
      ),
    ).toBe(false);
  });

  it('excludes a thread that was answered and has gone quiet', () => {
    expect(
      needsAttention(
        conversation({
          leadQualificationStatus: 'confirmed',
          lastInboundAt: MON,
          lastAiReplyAt: WED,
        }),
      ),
    ).toBe(false);
  });
});
