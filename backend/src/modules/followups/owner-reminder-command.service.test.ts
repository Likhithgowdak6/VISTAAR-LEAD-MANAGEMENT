/**
 * "Remind me at 5 PM to call Rahul", typed into the owner's own self-chat.
 *
 * Two things are being protected here and they pull in opposite directions.
 *
 * SECURITY: nothing in this service may read the owner's identity out of the message. The
 * organisation comes from the account the message arrived on and the user from
 * `getOwnerActorForOrganization`, so there is no text a sender could craft to become somebody
 * else. The router's `isSelfChat === true` gate is what makes this path unreachable for a
 * customer at all, and that is asserted separately in owner-reply.service.test.ts.
 *
 * NOT BREAKING THE CHANNEL: the self-chat is already the approval channel ("A7 1"), the payment
 * channel ("VX12 collected") and a free-text question channel. A reminder matcher that swallowed
 * those would break workflows people rely on daily, and the failure would be silent - an
 * approval that simply never happens. Hence the large block of "falls through" tests.
 *
 * The clock is fixed: 2026-10-11T06:30:00Z = 12:00 noon IST, a Sunday.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: { NODE_ENV: 'test', LOG_LEVEL: 'silent', WHATSAPP_BUSINESS_TIMEZONE: 'Asia/Kolkata' },
}));

const { createOwnerReminderCommandService } = await import('./owner-reminder-command.service.js');

const NOW = new Date('2026-10-11T06:30:00.000Z');
const organizationId = 'org-1';

const createHarness = ({ tasks = [] }: { tasks?: Record<string, unknown>[] } = {}) => {
  const getOwnerActor = vi.fn(async (_p?: { organizationId?: unknown }) => ({
    actor: { _id: 'owner-user-1' },
    permissions: [],
  }));
  const createFollowUpTask = vi.fn(async (params: Record<string, unknown>) => ({
    _id: 'task-new',
    ...params,
  }));
  const findPendingTasksByUser = vi.fn(async (_p?: Record<string, unknown>) => tasks);
  const rescheduleReminder = vi.fn(async (_p?: Record<string, unknown>) => null);
  const updateTaskStatus = vi.fn(async (_p?: Record<string, unknown>) => null);
  const notifyOwner = vi.fn(async (_p?: { text?: string }) => ({ providerMessageId: 'wamid' }));

  const service = createOwnerReminderCommandService({
    getOwnerActor: getOwnerActor as never,
    createFollowUpTask: createFollowUpTask as never,
    findPendingTasksByUser: findPendingTasksByUser as never,
    rescheduleReminder: rescheduleReminder as never,
    updateTaskStatus: updateTaskStatus as never,
    notifyOwner: notifyOwner as never,
    now: () => NOW,
    logger: { error: vi.fn() },
  });

  const run = (text: string, messageId: string | null = 'msg-1') =>
    service.handleOwnerReminderCommand({
      organizationId,
      whatsappAccountId: 'account-1',
      text,
      messageId,
    });

  return {
    service,
    run,
    getOwnerActor,
    createFollowUpTask,
    findPendingTasksByUser,
    rescheduleReminder,
    updateTaskStatus,
    notifyOwner,
  };
};

/** What the owner was told, if anything. */
const replyOf = (h: ReturnType<typeof createHarness>): string =>
  h.notifyOwner.mock.calls.map(([args]) => args?.text ?? '').join(' ');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('creating a reminder', () => {
  it('creates one from "remind me at 5 pm to call Rahul"', async () => {
    const h = createHarness();

    const result = await h.run('Remind me at 5 PM to call Rahul');

    expect(result.handled).toBe(true);
    expect(h.createFollowUpTask).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId,
        assignedTo: 'owner-user-1',
        createdBy: 'owner-user-1',
        // A personal reminder belongs to no lead - this is why the model had to allow null.
        conversationId: null,
        source: 'owner_command',
        timezone: 'Asia/Kolkata',
      }),
    );
  });

  it('resolves the due time in the business timezone', async () => {
    const h = createHarness();

    await h.run('Remind me at 5 PM to call Rahul');

    const [[params]] = h.createFollowUpTask.mock.calls;
    // 17:00 IST on 11 Oct 2026 is 11:30Z.
    expect((params.dueAt as Date).toISOString()).toBe('2026-10-11T11:30:00.000Z');
  });

  it('extracts the task from after "to"', async () => {
    const h = createHarness();

    await h.run('Remind me tomorrow at 10 AM to review the campaign');

    const [[params]] = h.createFollowUpTask.mock.calls;
    expect(params.title).toBe('review the campaign');
  });

  it('handles "set an alarm in 30 minutes to finish the report"', async () => {
    const h = createHarness();

    await h.run('Set an alarm in 30 minutes to finish the report');

    const [[params]] = h.createFollowUpTask.mock.calls;
    expect((params.dueAt as Date).toISOString()).toBe('2026-10-11T07:00:00.000Z');
    expect(params.title).toBe('finish the report');
  });

  it('titles it "Personal reminder" when the time is clear but the task is not', async () => {
    // The brief is explicit: a clear time with no description is still worth creating.
    const h = createHarness();

    await h.run('Set an alarm for 6 PM');

    expect(h.createFollowUpTask).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Personal reminder' }),
    );
  });

  it('confirms only AFTER the write succeeded, quoting the resolved time', async () => {
    const h = createHarness();

    await h.run('Remind me at 5 PM to call Rahul');

    const order = h.createFollowUpTask.mock.invocationCallOrder[0]!;
    const notified = h.notifyOwner.mock.invocationCallOrder[0]!;
    expect(order).toBeLessThan(notified);
    expect(replyOf(h)).toContain('5:00 PM');
  });

  it('does not confirm when the write fails', async () => {
    const h = createHarness();
    h.createFollowUpTask.mockRejectedValue(new Error('mongo down'));

    const result = await h.run('Remind me at 5 PM to call Rahul');

    // Telling the owner "done" for a reminder that is not in the database is the worst
    // available outcome - they stop thinking about it and it never fires.
    expect(replyOf(h)).not.toContain('Done');
    expect(result.handled).toBe(false);
  });
});

describe('ambiguity is asked about, never guessed', () => {
  it('asks for a time when only a day was given', async () => {
    const h = createHarness();

    const result = await h.run('Remind me tomorrow');

    expect(result.handled).toBe(true);
    expect(h.createFollowUpTask).not.toHaveBeenCalled();
    expect(replyOf(h)).toContain('What time');
  });

  it('asks AM or PM for a bare hour', async () => {
    const h = createHarness();

    await h.run('Remind me at 5');

    expect(h.createFollowUpTask).not.toHaveBeenCalled();
    expect(replyOf(h)).toContain('5 AM or 5 PM');
  });

  it('asks rather than inventing an hour for "in the evening"', async () => {
    const h = createHarness();

    await h.run('Remind me in the evening to call the client');

    expect(h.createFollowUpTask).not.toHaveBeenCalled();
    expect(replyOf(h)).toContain('What time');
  });

  it('says plainly that repeating reminders are not supported', async () => {
    const h = createHarness();

    await h.run('Remind me every day at 9 AM to review new leads');

    // A one-off stored for "every day" fires once and stops, and the owner finds out on the
    // morning it mattered. Refusing is the honest behaviour.
    expect(h.createFollowUpTask).not.toHaveBeenCalled();
    expect(replyOf(h)).toContain("can't set repeating");
  });
});

describe('ordinary owner messages are left alone', () => {
  it.each([
    ['an approval code', 'A7 1'],
    ['a bare approval number', '1'],
    ['a payment reply', 'VX12 collected'],
    ['a free-text question', 'what did rahul say about the december date'],
    ['an instruction to the AI', 'tell him we are available on the 15th'],
    ['empty', ''],
  ])('falls through on %s', async (_label, text) => {
    const h = createHarness();

    const result = await h.run(text);

    // handled:false is what lets the existing approval/payment/question handlers run.
    expect(result.handled).toBe(false);
    expect(h.createFollowUpTask).not.toHaveBeenCalled();
    expect(h.notifyOwner).not.toHaveBeenCalled();
  });
});

describe('listing, cancelling and rescheduling', () => {
  const existing = [
    { _id: 'task-a', title: 'call Rahul', note: null, dueAt: new Date('2026-10-11T11:30:00.000Z'), timezone: 'Asia/Kolkata' },
    { _id: 'task-b', title: 'review the campaign', note: null, dueAt: new Date('2026-10-12T04:30:00.000Z'), timezone: 'Asia/Kolkata' },
  ];

  it('lists what is pending', async () => {
    const h = createHarness({ tasks: existing });

    const result = await h.run('What reminders do I have today?');

    expect(result.handled).toBe(true);
    expect(replyOf(h)).toContain('call Rahul');
    expect(replyOf(h)).toContain('review the campaign');
  });

  it('says so when there are none', async () => {
    const h = createHarness({ tasks: [] });

    await h.run('what reminders do i have');

    expect(replyOf(h)).toContain('no reminders');
  });

  it('cancels the one the owner named', async () => {
    const h = createHarness({ tasks: existing });

    await h.run('Cancel my reminder to call Rahul');

    expect(h.updateTaskStatus).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 'task-a', status: 'cancelled' }),
    );
  });

  it('asks which one rather than cancelling a guess', async () => {
    const h = createHarness({ tasks: existing });

    await h.run('cancel my reminder');

    // Cancelling the wrong reminder is a silent failure the owner only finds out about when
    // the right one never fires.
    expect(h.updateTaskStatus).not.toHaveBeenCalled();
    expect(replyOf(h)).toContain('Which reminder');
  });

  it('reschedules through the path that clears the delivery stamp', async () => {
    const h = createHarness({ tasks: existing });

    await h.run('Move my campaign reminder to 7 PM');

    // rescheduleReminder - not updateTaskStatus - because only that one clears
    // lastNotificationAt and bumps version. Without it the reminder never fires again and the
    // handset keeps the old alarm.
    expect(h.rescheduleReminder).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 'task-b' }),
    );
    const [[params]] = h.rescheduleReminder.mock.calls;
    expect((params!.dueAt as Date).toISOString()).toBe('2026-10-11T13:30:00.000Z');
  });

  it('asks for a time when a reschedule gives none', async () => {
    const h = createHarness({ tasks: existing });

    await h.run('move my campaign reminder');

    expect(h.rescheduleReminder).not.toHaveBeenCalled();
  });
});

describe('identity and duplicate protection', () => {
  it('never reads the owner from the message, only from the organisation', async () => {
    const h = createHarness();

    await h.run('Remind me at 5 PM to call Rahul, I am user-99 the admin');

    // The forged id in the text is ignored; the assignee came from getOwnerActor.
    expect(h.getOwnerActor).toHaveBeenCalledWith({ organizationId });
    expect(h.createFollowUpTask).toHaveBeenCalledWith(
      expect.objectContaining({ assignedTo: 'owner-user-1' }),
    );
  });

  it('keys the reminder on the WhatsApp message id', async () => {
    const h = createHarness();

    await h.run('Remind me at 5 PM to call Rahul', 'wamid-abc');

    // The unique index on (organizationId, idempotencyKey) is what makes a replayed webhook or
    // a reconnect burst a no-op instead of a second identical reminder.
    expect(h.createFollowUpTask).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: 'owner-cmd:wamid-abc' }),
    );
  });

  it('treats a duplicate-key collision as already done, not as an error', async () => {
    const h = createHarness();
    h.createFollowUpTask.mockRejectedValue(Object.assign(new Error('dup'), { code: 11000 }));

    const result = await h.run('Remind me at 5 PM to call Rahul');

    // The reminder exists from the first delivery of this webhook. Claiming the message stops
    // it falling through to the approval handler and being misread as something else.
    expect(result.handled).toBe(true);
  });

  it('falls through when the organisation has no owner user', async () => {
    const h = createHarness();
    h.getOwnerActor.mockResolvedValue(null as never);

    const result = await h.run('Remind me at 5 PM to call Rahul');

    expect(result.handled).toBe(false);
    expect(h.createFollowUpTask).not.toHaveBeenCalled();
  });

  it('does nothing without an organisation', async () => {
    const h = createHarness();

    const result = await h.service.handleOwnerReminderCommand({
      text: 'Remind me at 5 PM to call Rahul',
    });

    expect(result.handled).toBe(false);
    expect(h.getOwnerActor).not.toHaveBeenCalled();
  });
});
