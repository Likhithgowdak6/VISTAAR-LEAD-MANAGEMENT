import { describe, expect, it } from 'vitest';
import { nurtureMessageStopReason } from './silence-schedule.js';

const anchor = new Date('2026-11-19T08:00:00Z');
const key = `nurture:conv:${anchor.getTime()}:1`;
const conversation = { lastInboundAt: anchor, aiAutomationEnabled: true };

describe('nurture cycle at delivery', () => {
  it('allows the current cycle and leaves unrelated messages alone', () => {
    expect(nurtureMessageStopReason(key, conversation)).toBeNull();
    expect(nurtureMessageStopReason('payment-chase:conv', null)).toBeNull();
  });
  it('rejects a draft prepared from before a new reply, even when queued later', () => {
    expect(nurtureMessageStopReason(key, { ...conversation,
      lastInboundAt: new Date(anchor.getTime()+60000) })).toBe('superseded_by_inbound');
  });
  it('rejects the old cycle when an owner resumes from a newer anchor', () => {
    expect(nurtureMessageStopReason(key, { ...conversation,
      nurtureResumedAt: new Date(anchor.getTime()+60000) })).toBe('superseded_by_inbound');
  });
  it.each([
    [{ nurtureEnabled: false }, 'nurture_disabled'],
    [{ optedOutAt: anchor }, 'recipient_opted_out'],
    [{ salesRejectedAt: anchor }, 'lead_rejected_service'],
    [{ aiAutomationEnabled: false }, 'automation_paused_before_send'],
    [{ promisedFollowUpAt: anchor }, 'promised_follow_up_pending'],
  ])('preserves stop conditions %j', (changes, reason) => {
    expect(nurtureMessageStopReason(key, { ...conversation, ...changes })).toBe(reason);
  });
  it('fails closed on legacy/malformed cycle keys or a deleted conversation', () => {
    expect(nurtureMessageStopReason('nurture:conv:1', conversation)).toBe('superseded_by_inbound');
    expect(nurtureMessageStopReason(key, null)).toBe('superseded_by_inbound');
  });
});
