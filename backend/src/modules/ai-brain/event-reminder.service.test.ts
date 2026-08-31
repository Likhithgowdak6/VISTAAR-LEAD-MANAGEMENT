/**
 * Exercises the pre-event owner reminder's two load-bearing properties: it fires exactly once per
 * booking (the atomic `claimEventReminder` is the only thing that decides), and a failed send
 * hands the claim back rather than silently burning this booking's one reminder. Also covers the
 * negative cases the query is responsible for, and the text the owner actually reads.
 *
 * Every collaborator is injected directly (no real Mongo, no WhatsApp session), following this
 * codebase's DI test style.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// event-reminder.service.ts statically imports conversation.repository.js and
// owner-notify.service.js as its overridable defaults; neither is exercised here, but
// config/env.js's real module validates and process.exit(1)s at import time, so it is mocked
// like every other test in this codebase that touches modules importing it.
vi.mock('../../config/env.js', () => ({
  env: { LOG_LEVEL: 'silent', NODE_ENV: 'test' },
}));

const { buildEventReminder, composeEventReminderText, createEventReminderService } = await import(
  './event-reminder.service.js'
);

/** Mid-afternoon the day before a 12 September wedding. */
const NOW = new Date('2026-09-11T14:00:00.000Z');

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

const baseConversation = (overrides: Record<string, unknown> = {}) => ({
  _id: 'conv-1',
  organizationId: 'org-1',
  whatsappAccountId: 'account-1',
  contactId: 'contact-1',
  displayName: 'Riya Sharma',
  stage: 'won',
  aiCategory: 'event_photography',
  aiFacts: { event_type: 'Wedding', city: 'Whitefield, Bangalore', event_date: '12/09/2026' },
  eventDate: day('2026-09-12'),
  eventReminderSentAt: null,
  ...overrides,
});

/**
 * A stand-in for the real conditional update: the first caller for a conversation claims it and
 * gets the document back, every later caller gets null - exactly what
 * `findOneAndUpdate({ eventReminderSentAt: null }, ...)` does in Mongo. `release` puts it back,
 * which is what a failed send does.
 */
const createClaimStubs = () => {
  const claimed = new Set<string>();

  const claimEventReminder = vi.fn(async ({ conversationId }: { conversationId?: unknown }) => {
    const key = String(conversationId);

    if (claimed.has(key)) {
      return null;
    }

    claimed.add(key);
    return { _id: conversationId, eventReminderSentAt: new Date() };
  });

  const releaseEventReminderClaim = vi.fn(async ({ conversationId }: { conversationId?: unknown }) => {
    claimed.delete(String(conversationId));
    return { _id: conversationId, eventReminderSentAt: null };
  });

  return { claimEventReminder, releaseEventReminderClaim };
};

const createHarness = (overrides: Record<string, unknown> = {}) => {
  const { claimEventReminder, releaseEventReminderClaim } = createClaimStubs();
  const conversationRepository = {
    findConversationsWithUpcomingEvents: vi.fn().mockResolvedValue([]),
    claimEventReminder,
    releaseEventReminderClaim,
  };
  const notifyOwner = vi.fn().mockResolvedValue({ providerMessageId: 'MSG-1' });
  const createActivity = vi.fn().mockResolvedValue(undefined);
  const logger = { error: vi.fn() };

  const service = createEventReminderService({
    conversationRepository: conversationRepository as never,
    notifyOwner,
    createActivity: createActivity as never,
    logger,
    now: () => NOW,
    ...overrides,
  });

  return { service, conversationRepository, notifyOwner, createActivity, logger };
};

/** One batch, then an empty one to end the cursor loop. */
const withOneBatch = (find: ReturnType<typeof vi.fn>, conversations: unknown[]) => {
  find.mockResolvedValueOnce(conversations).mockResolvedValue([]);
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('buildEventReminder', () => {
  it('reads who, when, what and where off the conversation', () => {
    expect(buildEventReminder({ conversation: baseConversation() as never, now: NOW })).toEqual({
      conversationId: 'conv-1',
      organizationId: 'org-1',
      whatsappAccountId: 'account-1',
      contactId: 'contact-1',
      leadDisplayName: 'Riya Sharma',
      eventDate: day('2026-09-12'),
      daysUntil: 1,
      serviceType: 'Wedding',
      place: 'Whitefield, Bangalore',
    });
  });

  it('falls back to the lead category when the lead never named the event', () => {
    const reminder = buildEventReminder({
      conversation: baseConversation({ aiFacts: {} }) as never,
      now: NOW,
    });

    expect(reminder?.serviceType).toBe('event photography');
    expect(reminder?.place).toBe('');
  });

  it('returns null for a conversation with no event date', () => {
    expect(
      buildEventReminder({ conversation: baseConversation({ eventDate: null }) as never, now: NOW }),
    ).toBeNull();
  });
});

describe('composeEventReminderText', () => {
  it('names the customer, the date and the service type', () => {
    const reminder = buildEventReminder({ conversation: baseConversation() as never, now: NOW })!;
    const text = composeEventReminderText(reminder);

    expect(text).toContain('Riya Sharma');
    expect(text).toContain('12 Sep 2026');
    expect(text).toContain('Wedding');
    expect(text).toContain('Whitefield, Bangalore');
    expect(text).toContain('Tomorrow');
  });

  it('leaves out the place line when the lead never gave one', () => {
    const reminder = buildEventReminder({
      conversation: baseConversation({ aiFacts: { event_type: 'Wedding' } }) as never,
      now: NOW,
    })!;

    expect(composeEventReminderText(reminder)).not.toContain('·');
  });
});

describe('remindUpcomingEvents', () => {
  it('reminds the owner about a won booking whose event is tomorrow', async () => {
    const { service, conversationRepository, notifyOwner, createActivity } = createHarness();
    withOneBatch(conversationRepository.findConversationsWithUpcomingEvents, [baseConversation()]);

    const result = await service.remindUpcomingEvents({});

    expect(notifyOwner).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: 'account-1',
        organizationId: 'org-1',
        text: expect.stringContaining('Riya Sharma'),
      }),
    );
    expect(createActivity).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'ai_brain.event_reminder_sent' }),
    );
    expect(result).toMatchObject({ scanned: 1, reminded: 1, failed: 0 });
  });

  it('asks only for won bookings inside the next 24 hours that have not been reminded about', async () => {
    const { service, conversationRepository } = createHarness();

    await service.remindUpcomingEvents({});

    expect(conversationRepository.findConversationsWithUpcomingEvents).toHaveBeenCalledWith(
      expect.objectContaining({
        from: NOW,
        to: new Date(NOW.getTime() + 24 * 60 * 60 * 1000),
      }),
    );
  });

  it('claims before it sends, so two overlapping sweeps cannot both message the owner', async () => {
    const { service, conversationRepository, notifyOwner } = createHarness();
    withOneBatch(conversationRepository.findConversationsWithUpcomingEvents, [baseConversation()]);

    await service.remindUpcomingEvents({});

    const claimOrder = conversationRepository.claimEventReminder.mock.invocationCallOrder[0]!;
    const notifyOrder = notifyOwner.mock.invocationCallOrder[0]!;
    expect(claimOrder).toBeLessThan(notifyOrder);
  });

  it('does not fire twice for the same booking, however often the sweep runs', async () => {
    const { service, conversationRepository, notifyOwner } = createHarness();

    // The same conversation comes back on a second sweep - it does until the write is visible,
    // and the claim is the only thing standing between the owner and a duplicate.
    conversationRepository.findConversationsWithUpcomingEvents
      .mockResolvedValueOnce([baseConversation()])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([baseConversation()])
      .mockResolvedValue([]);

    const first = await service.remindUpcomingEvents({});
    const second = await service.remindUpcomingEvents({});

    expect(notifyOwner).toHaveBeenCalledTimes(1);
    expect(first).toMatchObject({ reminded: 1 });
    expect(second).toMatchObject({ scanned: 1, reminded: 0, skipped: 1 });
  });

  it('sends nothing when the query returns nothing — not won, no date, or further out', async () => {
    // The three exclusions live in the query itself (stage: won, eventDate inside the window,
    // eventReminderSentAt: null), which conversation.repository.test.ts asserts on directly.
    // What matters here is that an empty scan is a quiet one: no claim, no message.
    const { service, conversationRepository, notifyOwner } = createHarness();

    const result = await service.remindUpcomingEvents({});

    expect(conversationRepository.claimEventReminder).not.toHaveBeenCalled();
    expect(notifyOwner).not.toHaveBeenCalled();
    expect(result).toMatchObject({ scanned: 0, reminded: 0 });
  });

  it('never reminds about a conversation whose event date has somehow gone missing', async () => {
    const { service, conversationRepository, notifyOwner } = createHarness();
    withOneBatch(conversationRepository.findConversationsWithUpcomingEvents, [
      baseConversation({ eventDate: null }),
    ]);

    const result = await service.remindUpcomingEvents({});

    expect(conversationRepository.claimEventReminder).not.toHaveBeenCalled();
    expect(notifyOwner).not.toHaveBeenCalled();
    expect(result).toMatchObject({ scanned: 1, skipped: 1 });
  });

  it('hands the claim back when the send fails, so the next sweep retries instead of losing it', async () => {
    const { service, conversationRepository, notifyOwner, createActivity, logger } = createHarness();
    notifyOwner.mockRejectedValueOnce(new Error('no live WhatsApp session'));
    conversationRepository.findConversationsWithUpcomingEvents
      .mockResolvedValueOnce([baseConversation()])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([baseConversation()])
      .mockResolvedValue([]);

    // The sweep itself must not throw: one unreachable organization cannot cost every other
    // booking its reminder.
    const failed = await service.remindUpcomingEvents({});

    expect(failed).toMatchObject({ scanned: 1, reminded: 0, failed: 1 });
    expect(conversationRepository.releaseEventReminderClaim).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-1', organizationId: 'org-1' }),
    );
    expect(createActivity).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledTimes(1);

    // A missed shoot is worse than a duplicate reminder, so the reminder is at-least-once: the
    // next sweep, still inside the window, gets its chance.
    const retried = await service.remindUpcomingEvents({});

    expect(retried).toMatchObject({ reminded: 1 });
    expect(notifyOwner).toHaveBeenCalledTimes(2);
  });

  it('isolates a per-booking failure so the rest of the sweep still runs', async () => {
    const { service, conversationRepository, notifyOwner, logger } = createHarness();
    withOneBatch(conversationRepository.findConversationsWithUpcomingEvents, [
      baseConversation({ _id: 'conv-bad' }),
      baseConversation({ _id: 'conv-good', displayName: 'Arjun Rao' }),
    ]);
    notifyOwner.mockRejectedValueOnce(new Error('no live WhatsApp session'));

    const result = await service.remindUpcomingEvents({});

    expect(notifyOwner).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ scanned: 2, reminded: 1, failed: 1 });
  });
});
