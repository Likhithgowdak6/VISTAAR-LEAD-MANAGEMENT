/**
 * The sweep that fires due reminders.
 *
 * What has to hold, and why each matters more than it looks:
 *
 *  - a reminder goes out ONCE, even though claims expire and workers overlap;
 *  - the two delivery channels never contaminate each other - a dead WhatsApp socket must not
 *    mark the handset's alarm failed, because the handset probably rang;
 *  - a reminder cancelled between being claimed and being read is not announced;
 *  - an overdue reminder is still sent, because the one an owner most wants is the one their
 *    server was down for;
 *  - nothing here can throw, because the next reminder in the queue probably works.
 *
 * Clock is injected. Every dependency is a double - no Mongo, no WhatsApp.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: { NODE_ENV: 'test', LOG_LEVEL: 'silent', REMINDERS_ENABLED: false },
}));

const { createReminderSweepService } = await import('./reminder-sweep.service.js');

const NOW = new Date('2026-10-11T11:30:00.000Z');

const baseTask = (overrides: Record<string, unknown> = {}) => ({
  _id: 'task-1',
  organizationId: 'org-1',
  whatsappAccountId: 'account-1',
  conversationId: 'conv-1',
  status: 'pending',
  dueAt: new Date('2026-10-11T11:29:00.000Z'),
  title: 'Call Rahul',
  note: null,
  timezone: 'Asia/Kolkata',
  source: 'lead_commitment',
  sourceQuote: 'contact me tomorrow at 5',
  lastNotificationAt: null,
  whatsappDelivery: { status: 'pending', attempts: 0, deliveredAt: null, error: null },
  androidDelivery: { status: 'pending', attempts: 0, deliveredAt: null, syncedAt: null, error: null },
  ...overrides,
});

const createHarness = ({
  tasks = [baseTask()],
  accounts = [{ _id: 'org-account-1' }] as { _id: string }[],
}: { tasks?: Record<string, unknown>[]; accounts?: { _id: string }[] } = {}) => {
  const queue = [...tasks];

  // Argument types are spelled out so `.mock.calls` stays typed - vi.fn(async () => …) infers a
  // zero-argument signature and every later inspection of what was passed becomes `never`.
  const claimDueReminder = vi.fn(async (_params?: { now?: Date }) => queue.shift() ?? null);
  const releaseReminderClaim = vi.fn(async (_params?: { taskId?: unknown }) => null);
  const recordReminderDelivery = vi.fn(
    async (_params: {
      taskId?: unknown;
      channel: string;
      status: string;
      error?: string | null;
      now?: Date;
    }) => null,
  );
  const finishReminderDelivery = vi.fn(async (_params?: { taskId?: unknown; now?: Date }) => null);
  const notifyOwner = vi.fn(
    async (_params: { organizationId?: unknown; accountId?: unknown; text?: string }) => ({
      providerMessageId: 'wamid-1' as string | null,
    }),
  );

  const findAccountsByOrganization = vi.fn(
    async (_params?: { organizationId?: unknown; status?: string; limit?: number }) => accounts,
  );
  const logger = { info: vi.fn(), error: vi.fn() };

  const service = createReminderSweepService({
    claimDueReminder: claimDueReminder as never,
    releaseReminderClaim: releaseReminderClaim as never,
    recordReminderDelivery: recordReminderDelivery as never,
    finishReminderDelivery: finishReminderDelivery as never,
    findAccountsByOrganization: findAccountsByOrganization as never,
    notifyOwner: notifyOwner as never,
    now: () => NOW,
    logger,
  });

  return {
    service,
    claimDueReminder,
    releaseReminderClaim,
    recordReminderDelivery,
    finishReminderDelivery,
    findAccountsByOrganization,
    notifyOwner,
    logger,
  };
};

/** The per-channel record written for `channel`, or undefined. */
const deliveryFor = (h: ReturnType<typeof createHarness>, channel: string) =>
  h.recordReminderDelivery.mock.calls.map(([args]) => args).find((args) => args.channel === channel);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('delivering a due reminder', () => {
  it('sends it to the owner and closes it out', async () => {
    const h = createHarness();

    const result = await h.service.sweepOnce({});

    expect(h.notifyOwner).toHaveBeenCalledTimes(1);
    expect(deliveryFor(h, 'whatsapp')).toMatchObject({ status: 'sent' });
    expect(h.finishReminderDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 'task-1' }),
    );
    expect(result).toMatchObject({ claimed: 1, whatsappSent: 1 });
  });

  it('sends the reminder to the OWNER, never into the lead conversation', async () => {
    const h = createHarness();

    await h.service.sweepOnce({});

    // notifyOwner is the owner's own number / self-chat. There is no recipient parameter here
    // at all, which is the structural guarantee that a lead cannot receive this.
    const [[sent]] = h.notifyOwner.mock.calls;
    expect(sent?.organizationId).toBe('org-1');
    expect(sent?.text).toContain('Lead Follow-up');
    expect(sent?.text).toContain('Call Rahul');
  });

  it('still sends a long-overdue reminder rather than dropping it', async () => {
    // The documented catch-up policy: after an outage the owner gets the reminder late, which
    // is strictly better than never learning it existed.
    const h = createHarness({
      tasks: [baseTask({ dueAt: new Date('2026-10-10T02:00:00.000Z') })],
    });

    const result = await h.service.sweepOnce({});

    expect(result.whatsappSent).toBe(1);
  });

  it('drains several due reminders in one pass', async () => {
    const h = createHarness({
      tasks: [baseTask({ _id: 'a' }), baseTask({ _id: 'b' }), baseTask({ _id: 'c' })],
    });

    const result = await h.service.sweepOnce({});

    expect(result.claimed).toBe(3);
    expect(h.notifyOwner).toHaveBeenCalledTimes(3);
  });

  it('stops at the per-tick limit so a backlog cannot become a burst', async () => {
    const h = createHarness({
      tasks: Array.from({ length: 10 }, (_v, i) => baseTask({ _id: `t-${i}` })),
    });

    const result = await h.service.sweepOnce({ limit: 4 });

    // An unofficial WhatsApp connection firing ten messages in a second is how a number is lost.
    expect(result.claimed).toBe(4);
    expect(h.notifyOwner).toHaveBeenCalledTimes(4);
  });
});

describe('never announcing the same reminder twice', () => {
  it('skips one already announced, and hands the claim back', async () => {
    // The reclaim path: a lease expired under a slow send and a second worker picked it up.
    const h = createHarness({
      tasks: [baseTask({ lastNotificationAt: new Date('2026-10-11T11:00:00.000Z') })],
    });

    const result = await h.service.sweepOnce({});

    expect(h.notifyOwner).not.toHaveBeenCalled();
    expect(h.releaseReminderClaim).toHaveBeenCalledWith({ taskId: 'task-1' });
    expect(result.whatsappSent).toBe(0);
  });

  it.each(['cancelled', 'completed'])('does not announce a %s reminder', async (status) => {
    const h = createHarness({ tasks: [baseTask({ status })] });

    await h.service.sweepOnce({});

    expect(h.notifyOwner).not.toHaveBeenCalled();
    expect(h.releaseReminderClaim).toHaveBeenCalled();
  });

  it('stops when nothing is due', async () => {
    const h = createHarness({ tasks: [] });

    const result = await h.service.sweepOnce({});

    expect(result).toMatchObject({ claimed: 0, whatsappSent: 0 });
    expect(h.notifyOwner).not.toHaveBeenCalled();
  });
});

describe('the two channels are independent', () => {
  it('a WhatsApp failure never marks the Android channel anything', async () => {
    const h = createHarness();
    h.notifyOwner.mockRejectedValue(new Error('socket closed'));

    await h.service.sweepOnce({});

    expect(deliveryFor(h, 'whatsapp')).toMatchObject({ status: 'pending' });
    // THE ASSERTION THAT MATTERS: nothing at all was written about the handset. Its alarm was
    // armed on the device and may well have rung; this process has no idea either way.
    expect(deliveryFor(h, 'android')).toBeUndefined();
  });

  it('closes the reminder only once WhatsApp is out of attempts', async () => {
    const h = createHarness({
      tasks: [
        baseTask({
          whatsappDelivery: { status: 'pending', attempts: 3, deliveredAt: null, error: 'x' },
        }),
      ],
    });

    await h.service.sweepOnce({});

    // Terminal failure closes it - otherwise it is re-announced on every sweep forever, and
    // the owner's phone (which may well have rung) buzzes again each minute.
    expect(h.finishReminderDelivery).toHaveBeenCalled();
  });

  it('records a missing WhatsApp session as skipped, not failed', async () => {
    // Nothing is broken at this end and no retry will help, so it must not burn attempts.
    const h = createHarness();
    h.notifyOwner.mockResolvedValue({ providerMessageId: null });

    await h.service.sweepOnce({});

    expect(deliveryFor(h, 'whatsapp')).toMatchObject({ status: 'skipped' });
  });
});

describe('retries', () => {
  it('leaves a failed send pending so the next sweep tries again', async () => {
    const h = createHarness({
      tasks: [
        baseTask({
          whatsappDelivery: { status: 'pending', attempts: 1, deliveredAt: null, error: 'x' },
        }),
      ],
    });
    h.notifyOwner.mockRejectedValue(new Error('ETIMEDOUT'));

    await h.service.sweepOnce({});

    expect(deliveryFor(h, 'whatsapp')).toMatchObject({ status: 'pending' });
  });

  it('gives up after the attempt limit and records why', async () => {
    const h = createHarness({
      tasks: [
        baseTask({
          whatsappDelivery: { status: 'pending', attempts: 3, deliveredAt: null, error: 'x' },
        }),
      ],
    });

    await h.service.sweepOnce({});

    // Visible and recoverable rather than retried against whatever is actually broken.
    expect(h.notifyOwner).not.toHaveBeenCalled();
    expect(deliveryFor(h, 'whatsapp')).toMatchObject({ status: 'failed' });
  });

  it('never throws out of a sweep, whatever the channel does', async () => {
    const h = createHarness({ tasks: [baseTask({ _id: 'a' }), baseTask({ _id: 'b' })] });
    h.notifyOwner.mockRejectedValueOnce(new Error('boom'));

    await expect(h.service.sweepOnce({})).resolves.toMatchObject({ claimed: 2 });
    // The second reminder still went out - one bad send does not strand the queue behind it.
    expect(h.notifyOwner).toHaveBeenCalledTimes(2);
  });
});

describe('personal vs lead reminders', () => {
  it('writes a personal reminder without naming a lead', async () => {
    const h = createHarness({
      tasks: [
        baseTask({
          conversationId: null,
          whatsappAccountId: null,
          title: 'Review the campaign',
          source: 'owner_command',
          sourceQuote: null,
        }),
      ],
    });

    await h.service.sweepOnce({});

    const [[sent]] = h.notifyOwner.mock.calls;
    expect(sent?.text).toContain('Personal Reminder');
    expect(sent?.text).toContain('Review the campaign');
    expect(sent?.text).not.toContain('Lead Follow-up');
  });
});

describe('AUDIT: the retry path', () => {
  it('leaves a transiently-failed reminder retryable by the next sweep', async () => {
    const h = createHarness();
    h.notifyOwner.mockRejectedValue(new Error('ETIMEDOUT'));

    await h.service.sweepOnce({});

    // A failed send that is still within its attempt budget must NOT be stamped as announced -
    // `lastNotificationAt` is what the next sweep checks to decide the reminder is done with,
    // so setting it here retires the reminder after one attempt and the retry never happens.
    expect(h.finishReminderDelivery).not.toHaveBeenCalled();

    // And the claim is HELD, not released. Releasing made the reminder instantly eligible
    // again, so the same sweep re-claimed it and burned all three attempts in 27ms against a
    // socket that was equally down each time. The lease expiring is the backoff.
    expect(h.releaseReminderClaim).not.toHaveBeenCalled();
  });
});

describe('AUDIT: retries actually happen across sweeps', () => {
  it('attempts again on the next sweep, up to the budget, then gives up', async () => {
    // Walks the whole budget: attempts 0, 1 and 2 are retryable, attempt 3 is terminal. The
    // defect this pins made attempt 0 the only one that ever ran.
    const attemptsSeen: string[] = [];

    for (const attempts of [0, 1, 2]) {
      const h = createHarness({
        tasks: [
          baseTask({
            whatsappDelivery: { status: 'pending', attempts, deliveredAt: null, error: null },
          }),
        ],
      });
      h.notifyOwner.mockRejectedValue(new Error('ETIMEDOUT'));

      const result = await h.service.sweepOnce({});

      // ONE attempt per sweep, not three in a row: the held claim is what spaces them out.
      expect(h.notifyOwner).toHaveBeenCalledTimes(1);
      expect(h.finishReminderDelivery).not.toHaveBeenCalled();
      expect(h.releaseReminderClaim).not.toHaveBeenCalled();
      expect(result.whatsappRetrying).toBe(1);
      attemptsSeen.push(`retry@${attempts}`);
    }

    const exhausted = createHarness({
      tasks: [
        baseTask({
          whatsappDelivery: { status: 'pending', attempts: 3, deliveredAt: null, error: null },
        }),
      ],
    });

    const result = await exhausted.service.sweepOnce({});

    // Budget spent: no further send, recorded as failed, and closed so it stops being claimed.
    expect(exhausted.notifyOwner).not.toHaveBeenCalled();
    expect(deliveryFor(exhausted, 'whatsapp')).toMatchObject({ status: 'failed' });
    expect(exhausted.finishReminderDelivery).toHaveBeenCalled();
    expect(result.whatsappRetrying).toBe(0);
    expect(attemptsSeen).toEqual(['retry@0', 'retry@1', 'retry@2']);
  });

  it('reports a retry as neither sent nor silently delivered', async () => {
    const h = createHarness();
    h.notifyOwner.mockRejectedValue(new Error('socket closed'));

    const result = await h.service.sweepOnce({});

    // The state must stay truthful: nothing was sent, and the channel says pending because it
    // genuinely will be tried again.
    expect(result.whatsappSent).toBe(0);
    expect(deliveryFor(h, 'whatsapp')).toMatchObject({ status: 'pending' });
  });

  it('a skipped channel is terminal, not retried forever', async () => {
    const h = createHarness();
    h.notifyOwner.mockResolvedValue({ providerMessageId: null });

    await h.service.sweepOnce({});

    // No WhatsApp session configured is not a transient fault - retrying it every minute would
    // burn the budget on something no retry can fix.
    expect(h.finishReminderDelivery).toHaveBeenCalled();
  });
});

describe('AUDIT: a terminal failure keeps the cause', () => {
  it('carries the last real error into the give-up message', async () => {
    const h = createHarness({
      tasks: [
        baseTask({
          whatsappDelivery: {
            status: 'pending',
            attempts: 3,
            deliveredAt: null,
            error: 'ECONNRESET',
          },
        }),
      ],
    });

    await h.service.sweepOnce({});

    // "gave up after 3 attempts" on its own overwrites the only field that says WHY, leaving
    // an operator with a record they cannot act on.
    expect(deliveryFor(h, 'whatsapp')?.error).toContain('ECONNRESET');
    expect(deliveryFor(h, 'whatsapp')?.error).toContain('gave up after 3 attempts');
  });

  it('says so plainly when there was no recorded cause', async () => {
    const h = createHarness({
      tasks: [
        baseTask({
          whatsappDelivery: { status: 'pending', attempts: 3, deliveredAt: null, error: null },
        }),
      ],
    });

    await h.service.sweepOnce({});

    expect(deliveryFor(h, 'whatsapp')?.error).toContain('unknown');
  });
});

describe('AUDIT: one attempt per sweep, never a storm', () => {
  it('does not re-attempt the same reminder inside a single sweep', async () => {
    // Reproduces production: the queue keeps handing back the same task because a released
    // claim makes it instantly eligible again.
    const task = baseTask();
    const h = createHarness({ tasks: Array.from({ length: 10 }, () => ({ ...task })) });
    h.notifyOwner.mockRejectedValue(
      Object.assign(new Error('socket down'), { code: 'WHATSAPP_SESSION_NOT_RUNNING' }),
    );

    const result = await h.service.sweepOnce({});

    // One send for one reminder, however many times the claim query returns it.
    expect(h.notifyOwner).toHaveBeenCalledTimes(1);
    expect(result.claimed).toBe(1);
  });
});


describe('PRODUCTION DEFECT: a personal reminder has no account to send through', () => {
  it('borrows the organization\'s active number when the reminder has none', async () => {
    // The exact production document: created from the Reminders UI, so no conversation and no
    // account. Passing that null on to the session manager is what made every personal reminder
    // fail with WHATSAPP_SESSION_NOT_RUNNING while the socket was demonstrably connected - the
    // account id IS the key into the live-socket map, and null is not a key.
    const h = createHarness({
      tasks: [baseTask({ whatsappAccountId: null, conversationId: null, source: 'manual' })],
      accounts: [{ _id: 'org-account-1' }],
    });

    const result = await h.service.sweepOnce({});

    expect(h.notifyOwner).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: 'org-account-1' }),
    );
    expect(result.whatsappSent).toBe(1);
  });

  it('never borrows across organizations', async () => {
    const h = createHarness({
      tasks: [baseTask({ whatsappAccountId: null, organizationId: 'org-7' })],
    });

    await h.service.sweepOnce({});

    // Scoped lookup, or one tenant's reminder goes out over another tenant's number.
    expect(h.findAccountsByOrganization).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org-7', status: 'active' }),
    );
  });

  it('leaves a lead follow-up pointed at its own account', async () => {
    const h = createHarness({ tasks: [baseTask({ whatsappAccountId: 'account-1' })] });

    await h.service.sweepOnce({});

    expect(h.notifyOwner).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: 'account-1' }),
    );
    expect(h.findAccountsByOrganization).not.toHaveBeenCalled();
  });

  it('skips rather than burning the retry budget when there is no active number', async () => {
    const h = createHarness({
      tasks: [baseTask({ whatsappAccountId: null })],
      accounts: [],
    });

    const result = await h.service.sweepOnce({});

    // Nothing transient about an organization with no connected number: retrying it three times
    // changes nothing, and the handset alarm is unaffected either way.
    expect(h.notifyOwner).not.toHaveBeenCalled();
    expect(deliveryFor(h, 'whatsapp')?.status).toBe('skipped');
    expect(result.whatsappRetrying).toBe(0);
    expect(h.finishReminderDelivery).toHaveBeenCalled();
  });

  it('looks the organization up once per sweep, not once per reminder', async () => {
    const h = createHarness({
      tasks: Array.from({ length: 4 }, (_, i) =>
        baseTask({ _id: `task-${i}`, whatsappAccountId: null }),
      ),
    });

    await h.service.sweepOnce({});

    expect(h.notifyOwner).toHaveBeenCalledTimes(4);
    expect(h.findAccountsByOrganization).toHaveBeenCalledTimes(1);
  });

  it('skips safely when the account lookup itself throws', async () => {
    const h = createHarness({ tasks: [baseTask({ whatsappAccountId: null })] });
    h.findAccountsByOrganization.mockRejectedValue(new Error('mongo down'));

    const result = await h.service.sweepOnce({});

    // A sweep must survive a failing lookup; it must not take the whole runner down.
    expect(result.whatsappSent).toBe(0);
    expect(deliveryFor(h, 'whatsapp')?.status).toBe('skipped');
    expect(h.logger.error).toHaveBeenCalled();
  });
});
