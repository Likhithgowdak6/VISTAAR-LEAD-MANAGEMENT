/**
 * The week-ahead countdown.
 *
 * The two decisions worth defending are checked here: that the whole week arrives as ONE message
 * rather than one per booking, and that the phone only rings when something is actually on
 * tomorrow. Both exist so the owner keeps reading and answering them.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: { NODE_ENV: 'test', LOG_LEVEL: 'silent' },
}));

const { buildCountdownMessage, buildTomorrowCallSummary, createBookingCountdownService } =
  await import('./booking-countdown.service.js');

const organizationId = 'org-1';
const NOW = new Date('2026-09-11T06:00:00.000Z');

const booking = (displayName: string, daysAway: number, category: string | null = 'wedding') => ({
  displayName,
  eventDate: new Date(NOW.getTime() + daysAway * 24 * 60 * 60 * 1000),
  aiCategory: category,
});

const deps = (bookings: ReturnType<typeof booking>[] = []) => ({
  config: {
    OWNER_CALL_ESCALATION_ENABLED: true,
    WHATSAPP_OWNER_NUMBER: '916361322519',
    VAPI_SCHEDULE_ASSISTANT_ID: 'schedule-assistant',
    VAPI_ASSISTANT_ID: 'lead-assistant',
  } as never,
  findWonBookingsBetween: vi.fn().mockResolvedValue(bookings),
  listOrganizations: vi.fn().mockResolvedValue([{ _id: organizationId }]),
  findOrganizationById: vi.fn().mockResolvedValue({ ownerWhatsappNumber: '916361322519' }),
  placeOutboundCall: vi.fn().mockResolvedValue({ callId: 'call-1' }),
  notifyOwner: vi.fn().mockResolvedValue({ providerMessageId: 'MSG-1' }),
  logger: { info: vi.fn(), error: vi.fn() },
  now: () => NOW,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('the message', () => {
  it('puts the whole week in one message, soonest first', () => {
    const text = buildCountdownMessage([
      { displayName: 'Likhith', eventDate: new Date('2026-09-12'), category: 'wedding', daysAway: 1 },
      { displayName: 'Priya', eventDate: new Date('2026-09-15'), category: 'birthday', daysAway: 4 },
    ]);

    // One message, not one per booking per day: five bookings would otherwise be 35 messages a
    // week and the owner stops reading them.
    expect(text).toContain('2 bookings this week');
    expect(text).toContain('Tomorrow — Likhith, wedding');
    expect(text).toContain('In 4 days — Priya, birthday');
  });

  it('says nothing at all when the week is empty', () => {
    // An "all clear" every morning is how a channel gets muted.
    expect(buildCountdownMessage([])).toBeNull();
  });

  it('leaves out a service nobody has identified yet', () => {
    const text = buildCountdownMessage([
      { displayName: 'Likhith', eventDate: new Date('2026-09-12'), category: 'unknown', daysAway: 1 },
    ]);

    expect(text).toContain('Tomorrow — Likhith (');
    expect(text).not.toContain('unknown');
  });

  it('names who is shooting tomorrow, because a count is not a plan', () => {
    const summary = buildTomorrowCallSummary([
      { displayName: 'Likhith', eventDate: new Date('2026-09-12'), category: 'wedding', daysAway: 1 },
      { displayName: 'Priya', eventDate: new Date('2026-09-12'), category: 'birthday', daysAway: 1 },
    ]);

    expect(summary).toBe('You have 2 shoots tomorrow: Likhith, Priya.');
  });
});

describe('the call', () => {
  it('rings only when something is on tomorrow', async () => {
    const d = deps([booking('Likhith', 1)]);
    const service = createBookingCountdownService(d);

    await service.run();

    expect(d.notifyOwner).toHaveBeenCalledTimes(1);
    expect(d.placeOutboundCall).toHaveBeenCalledWith(
      expect.objectContaining({
        toNumber: '916361322519',
        // Its own assistant: the schedule opener and the new-lead opener are different scripts,
        // and the whole message lives in Vapi's First Message.
        assistantId: 'schedule-assistant',
        variableValues: { summary: expect.stringContaining('Likhith') },
      }),
    );
  });

  it('falls back to the lead assistant rather than not calling at all', async () => {
    const d = deps([booking('Likhith', 1)]);
    d.config = {
      OWNER_CALL_ESCALATION_ENABLED: true,
      WHATSAPP_OWNER_NUMBER: '916361322519',
      VAPI_ASSISTANT_ID: 'lead-assistant',
    } as never;

    await createBookingCountdownService(d).run();

    // It will read oddly, but a missing id should degrade the wording, not lose the reminder.
    expect(d.placeOutboundCall).toHaveBeenCalledWith(
      expect.objectContaining({ assistantId: 'lead-assistant' }),
    );
  });

  it('stays silent when the next shoot is days away', async () => {
    const d = deps([booking('Priya', 4)]);
    const service = createBookingCountdownService(d);

    await service.run();

    // A daily call that usually says "nothing tomorrow" gets ignored inside a week, and each one
    // costs money. The written countdown still went out.
    expect(d.notifyOwner).toHaveBeenCalledTimes(1);
    expect(d.placeOutboundCall).not.toHaveBeenCalled();
  });

  it('sends nothing at all in a quiet week', async () => {
    const d = deps([]);
    const service = createBookingCountdownService(d);

    await service.run();

    expect(d.notifyOwner).not.toHaveBeenCalled();
    expect(d.placeOutboundCall).not.toHaveBeenCalled();
  });

  it('still sends the message when the call fails', async () => {
    const d = deps([booking('Likhith', 1)]);
    d.placeOutboundCall.mockRejectedValue(new Error('vapi down'));
    const service = createBookingCountdownService(d);

    await expect(service.run()).resolves.toBeUndefined();

    // A Vapi outage must not read as the countdown failing - the owner already has it in writing.
    expect(d.notifyOwner).toHaveBeenCalledTimes(1);
    expect(d.logger.error).toHaveBeenCalled();
  });
});

describe('isolation', () => {
  it('one broken organization does not cost the others their countdown', async () => {
    const d = deps([booking('Likhith', 1)]);
    d.listOrganizations.mockResolvedValue([{ _id: 'org-broken' }, { _id: 'org-ok' }]);
    d.findWonBookingsBetween
      .mockRejectedValueOnce(new Error('mongo blew up'))
      .mockResolvedValueOnce([booking('Priya', 1)]);

    await service(d).run();

    expect(d.notifyOwner).toHaveBeenCalledTimes(1);
    expect(d.logger.error).toHaveBeenCalled();
  });
});

const service = (d: ReturnType<typeof deps>) => createBookingCountdownService(d);
