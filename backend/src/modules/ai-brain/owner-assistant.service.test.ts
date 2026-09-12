/**
 * The owner's WhatsApp assistant.
 *
 * What is checked here is the grounding, not the phrasing: that the answering call only ever gets
 * data this repo actually fetched, that the model cannot widen its own query, and that a question
 * is never mistaken for an instruction to a customer.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: { NODE_ENV: 'test', LOG_LEVEL: 'silent' },
}));

const { handleOwnerQuestion } = await import('./owner-assistant.service.js');

const organizationId = 'org-1';

const deps = () => ({
  planAssistantAction: vi.fn(),
  answerAssistantQuestion: vi.fn().mockResolvedValue({ message: 'Three.' }),
  countConversationsMatching: vi.fn().mockResolvedValue(0),
  listConversationsMatching: vi.fn().mockResolvedValue([]),
  groupConversationCounts: vi.fn().mockResolvedValue([]),
  logger: { info: vi.fn(), error: vi.fn() },
  now: () => new Date('2026-09-11T00:00:00.000Z'),
});

const plan = (overrides: Record<string, unknown> = {}) => ({
  action: 'count',
  restated: 'how many birthday bookings',
  group_by: '',
  filters: {},
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('counting', () => {
  it('answers from a real count and passes the model only what was fetched', async () => {
    const d = deps();
    d.planAssistantAction.mockResolvedValue(
      plan({ filters: { stages: ['won'], categories: ['birthday'] } }),
    );
    d.countConversationsMatching.mockResolvedValue(3);

    const outcome = await handleOwnerQuestion({
      organizationId,
      question: 'how many people have booked for a birthday party',
      ...d,
    });

    expect(d.countConversationsMatching).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId, stages: ['won'], categories: ['birthday'] }),
    );
    // The number in the data is the number the repository returned. The model is never asked to
    // produce one.
    expect(d.answerAssistantQuestion).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.stringContaining('Matching leads: 3') }),
    );
    expect(outcome).toEqual({ kind: 'answered', message: 'Three.' });
  });

  it('turns a day window into a date rather than passing the number through', async () => {
    const d = deps();
    d.planAssistantAction.mockResolvedValue(plan({ filters: { since_days: 7 } }));

    await handleOwnerQuestion({ organizationId, question: 'new leads this week', ...d });

    expect(d.countConversationsMatching).toHaveBeenCalledWith(
      expect.objectContaining({ since: new Date('2026-09-04T00:00:00.000Z') }),
    );
  });

  it('looks only forward for an event window', async () => {
    const d = deps();
    d.planAssistantAction.mockResolvedValue(plan({ filters: { event_within_days: 7 } }));

    await handleOwnerQuestion({ organizationId, question: "who's booked next week", ...d });

    // Reaching backwards would answer "who is booked next week" with last month's shoots.
    expect(d.countConversationsMatching).toHaveBeenCalledWith(
      expect.objectContaining({
        eventFrom: new Date('2026-09-11T00:00:00.000Z'),
        eventTo: new Date('2026-09-18T00:00:00.000Z'),
      }),
    );
  });
});

describe('listing', () => {
  it('reports the true total when the list was cut short', async () => {
    const d = deps();
    d.planAssistantAction.mockResolvedValue(plan({ action: 'list' }));
    d.listConversationsMatching.mockResolvedValue([
      { displayName: 'Likhith', stage: 'won', aiCategory: 'birthday', leadScore: 85 },
    ]);
    d.countConversationsMatching.mockResolvedValue(20);

    await handleOwnerQuestion({ organizationId, question: 'show me the bookings', ...d });

    const { data } = d.answerAssistantQuestion.mock.calls[0][0];
    expect(data).toContain('Likhith');
    expect(data).toContain('showing 1 of 20');
  });

  it('says so plainly when nothing matches, rather than sending an empty sheet', async () => {
    const d = deps();
    d.planAssistantAction.mockResolvedValue(plan({ action: 'list' }));

    await handleOwnerQuestion({ organizationId, question: 'show me the hot leads', ...d });

    expect(d.answerAssistantQuestion).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.stringContaining('No leads match') }),
    );
  });
});

describe('breakdown', () => {
  it('groups by a whitelisted field, falling back to stage for an unknown one', async () => {
    const d = deps();
    d.planAssistantAction.mockResolvedValue(plan({ action: 'breakdown', group_by: 'nonsense' }));
    d.groupConversationCounts.mockResolvedValue([{ key: 'won', count: 2 }]);

    await handleOwnerQuestion({ organizationId, question: "how's the pipeline", ...d });

    // A field name from the model can never reach the aggregation directly.
    expect(d.groupConversationCounts).toHaveBeenCalledWith(
      expect.objectContaining({ groupBy: 'stage' }),
    );
  });

  it('maps category to the stored field name', async () => {
    const d = deps();
    d.planAssistantAction.mockResolvedValue(plan({ action: 'breakdown', group_by: 'category' }));

    await handleOwnerQuestion({ organizationId, question: 'what do we get most of', ...d });

    expect(d.groupConversationCounts).toHaveBeenCalledWith(
      expect.objectContaining({ groupBy: 'aiCategory' }),
    );
  });
});

describe('the routing boundary', () => {
  it('hands an instruction back without looking anything up or answering', async () => {
    const d = deps();
    d.planAssistantAction.mockResolvedValue(plan({ action: 'lead_instruction' }));

    const outcome = await handleOwnerQuestion({
      organizationId,
      question: 'ask them for their budget',
      parkedLeadName: 'Likhith',
      ...d,
    });

    expect(outcome).toEqual({ kind: 'instruction' });
    expect(d.countConversationsMatching).not.toHaveBeenCalled();
    expect(d.answerAssistantQuestion).not.toHaveBeenCalled();
  });

  it('tells the dispatcher which lead is parked', async () => {
    const d = deps();
    d.planAssistantAction.mockResolvedValue(plan());

    await handleOwnerQuestion({
      organizationId,
      question: 'how many bookings',
      parkedLeadName: 'Likhith',
      ...d,
    });

    expect(d.planAssistantAction).toHaveBeenCalledWith(
      expect.objectContaining({ parkedLeadName: 'Likhith' }),
    );
  });

  it('runs no lookup for a message that was not a question about the pipeline', async () => {
    const d = deps();
    d.planAssistantAction.mockResolvedValue(plan({ action: 'chat' }));

    await handleOwnerQuestion({ organizationId, question: 'thanks!', ...d });

    expect(d.countConversationsMatching).not.toHaveBeenCalled();
    expect(d.answerAssistantQuestion).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.stringContaining('No lookup was run') }),
    );
  });
});

describe('what it will not say', () => {
  it('never puts a phone number in the data, even if a row somehow carries one', async () => {
    const d = deps();
    d.planAssistantAction.mockResolvedValue(plan({ action: 'list' }));
    d.listConversationsMatching.mockResolvedValue([
      { displayName: 'Likhith', stage: 'won', phone: '+918183003081' } as never,
    ]);
    d.countConversationsMatching.mockResolvedValue(1);

    await handleOwnerQuestion({ organizationId, question: 'show me the bookings', ...d });

    // Revealing a customer's number is gated on CLIENT_PII_REVEAL and audited; this channel must
    // not route around that, so only whitelisted fields are ever rendered.
    const { data } = d.answerAssistantQuestion.mock.calls[0][0];
    expect(data).not.toContain('8183003081');
  });
});
