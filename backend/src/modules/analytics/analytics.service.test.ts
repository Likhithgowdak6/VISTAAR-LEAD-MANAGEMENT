/**
 * The arithmetic and the wording - the two things on an analytics page that can be wrong
 * without anything appearing to break.
 *
 * THE RULE UNDER TEST, stated once: a number that cannot be computed from what is stored must
 * be absent or null with a reason, never a plausible zero. A rate with no denominator printed
 * as "0%" claims that none of something happened; what actually happened is that nothing
 * happened at all, and once both are rendered as 0% there is no way to tell them apart. Same
 * for an empty response-time sample, and same for every metric this schema cannot support.
 *
 * The repository is injected, so none of this needs a database. What it cannot prove is that
 * the pipelines produce the counts handed in here - that is analytics.repository.test's half,
 * and the end-to-end agreement between the two is the check still outstanding.
 */
import { Types } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: { NODE_ENV: 'test', LOG_LEVEL: 'silent', WHATSAPP_BUSINESS_TIMEZONE: 'Asia/Kolkata' },
}));

const mocks = vi.hoisted(() => ({
  conversationAggregate: vi.fn(),
  messageAggregate: vi.fn(),
  followUpAggregate: vi.fn(),
  contactFind: vi.fn(),
  createAuditLog: vi.fn(),
  decryptPhone: vi.fn(),
}));

vi.mock('../conversations/conversation.model.js', () => ({
  Conversation: { aggregate: mocks.conversationAggregate },
}));
vi.mock('../messages/message.model.js', () => ({
  Message: { aggregate: mocks.messageAggregate },
}));
vi.mock('../followups/followup-task.model.js', () => ({
  FollowUpTask: { aggregate: mocks.followUpAggregate },
}));
vi.mock('../contacts/contact.model.js', () => ({ Contact: { find: mocks.contactFind } }));
vi.mock('../audit/audit.repository.js', () => ({ createAuditLog: mocks.createAuditLog }));
vi.mock('../privacy/protected-pii.service.js', () => ({
  decryptContactPhoneFromStorage: mocks.decryptPhone,
}));

const {
  getAnalyticsAiPerformance,
  getAnalyticsAttentionCsv,
  getAnalyticsAttentionList,
  getAnalyticsBreakdowns,
  getAnalyticsOverview,
  getAnalyticsReminders,
  getAnalyticsTrends,
  resolveAnalyticsScope,
  UNAVAILABLE_METRICS,
} = await import('./analytics.service.js');

/** Whatever the service accepts as its injected repository - read off the real signature. */
type AnalyticsRepositoryPort = Parameters<typeof getAnalyticsOverview>[0]['repository'];

const { AI_RESPONSE_STATUS_VALUES, ENQUIRY_CLASS_VALUES } = await import(
  './conversation-classification.js'
);

const ORG = new Types.ObjectId('6ab4c2037469f65204cfe999');
const ACTOR = new Types.ObjectId('6ab4c2037469f65204cfe111');
const OTHER_USER = new Types.ObjectId('6ab4c2037469f65204cfe222');
const CONTACT = new Types.ObjectId('6ab4c2037469f65204cfe333');
const CONVERSATION = new Types.ObjectId('6ab4c2037469f65204cfe444');

const NOW = new Date('2026-10-20T09:00:00.000Z');

const READ_ALL = ['conversations.read_assigned', 'conversations.read_all'] as const;
const OWN_ONLY = ['conversations.read_assigned'] as const;
const WITH_PII = [...READ_ALL, 'client_pii.reveal'] as const;

const actor = (permissions: readonly string[] = READ_ALL) => ({
  organizationId: ORG,
  actorId: ACTOR,
  permissions: permissions as never,
});

/** Every repository call, stubbed empty. Each test overrides only what it is about. */
const stubRepository = (
  overrides: Partial<NonNullable<AnalyticsRepositoryPort>> = {},
): NonNullable<AnalyticsRepositoryPort> =>
  ({
    runOverviewCounts: vi.fn().mockResolvedValue({
      totalConversations: 0,
      uniqueContacts: 0,
      needsAttention: 0,
      enquiryClassCounts: ENQUIRY_CLASS_VALUES.map((enquiryClass) => ({
        enquiryClass,
        count: 0,
      })),
      aiStatusCounts: AI_RESPONSE_STATUS_VALUES.map((status) => ({ status, count: 0 })),
    }),
    runConversationTrend: vi.fn().mockResolvedValue([]),
    runMessageTrend: vi.fn().mockResolvedValue([]),
    runAiConversationCounts: vi.fn().mockResolvedValue({
      enquiries: 0,
      enquiriesWithAiReply: 0,
      enquiriesAwaitingReply: 0,
      pausedOrOwnerHandled: 0,
    }),
    runAiMessageCounts: vi.fn().mockResolvedValue([]),
    runFirstResponseStats: vi
      .fn()
      .mockResolvedValue({ sampleSize: 0, averageSeconds: null, medianSeconds: null }),
    runStageBreakdown: vi.fn().mockResolvedValue([]),
    runSourceBreakdown: vi.fn().mockResolvedValue([]),
    runOwnerBreakdown: vi.fn().mockResolvedValue([]),
    runFollowUpCounts: vi
      .fn()
      .mockResolvedValue({ pending: 0, overdue: 0, dueToday: 0, completed: 0 }),
    runNextReminders: vi.fn().mockResolvedValue([]),
    runAttentionPage: vi.fn().mockResolvedValue({ rows: [], total: 0 }),
    revealContactPhones: vi.fn().mockResolvedValue(new Map()),
    recordPhoneExportAudit: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }) as NonNullable<AnalyticsRepositoryPort>;

describe('who is allowed to count what', () => {
  it('narrows a user without read-all to their own conversations', () => {
    // Otherwise their dashboard totals the whole organization while their inbox shows a
    // fraction of it - the same information in aggregate, handed over by accident.
    const scope = resolveAnalyticsScope(actor(OWN_ONLY));

    expect(scope.assignedTo?.toString()).toBe(ACTOR.toString());
  });

  it('leaves a read-all caller unnarrowed', () => {
    expect(resolveAnalyticsScope(actor(READ_ALL)).assignedTo).toBeNull();
  });

  it('lets a read-all caller filter to one person on purpose', () => {
    const scope = resolveAnalyticsScope(actor(READ_ALL), OTHER_USER.toString());

    expect(scope.assignedTo?.toString()).toBe(OTHER_USER.toString());
  });

  it('refuses rather than silently answering a different question', () => {
    // Quietly rewriting assignedTo to themselves would show a staff user their own numbers
    // under somebody else's name.
    expect(() => resolveAnalyticsScope(actor(OWN_ONLY), OTHER_USER.toString())).toThrow(
      /only see analytics for conversations assigned to you/i,
    );
  });

  it('takes the organization from the auth context, never from the caller', () => {
    expect(resolveAnalyticsScope(actor()).organizationId.toString()).toBe(ORG.toString());
  });
});

describe('the overview', () => {
  // Annotated rather than inferred from the default: without this TypeScript narrows the
  // parameter to READ_ALL's exact two-element tuple, and passing the single-element OWN_ONLY
  // fixture becomes a type error.
  const run = (
    repository: NonNullable<AnalyticsRepositoryPort>,
    permissions: readonly string[] = READ_ALL,
  ) =>
    getAnalyticsOverview({
      actor: actor(permissions),
      filters: { preset: 'last_7_days' },
      now: NOW,
      timeZone: 'Asia/Kolkata',
      repository,
    });

  it('attaches a definition to every count', async () => {
    const overview = await run(stubRepository());

    for (const key of [
      'totalConversations',
      'uniqueContacts',
      'enquiries',
      'notEnquiries',
      'needsReview',
      'awaitingAiReply',
      'needsAttention',
    ] as const) {
      expect(overview[key].definition.length).toBeGreaterThan(20);
    }
  });

  it('says which date field the counts are over', async () => {
    const overview = await run(stubRepository());

    expect(overview.totalConversations.definition).toContain('Conversation.createdAt');
  });

  it('returns a NULL enquiry rate when nothing has been classified', async () => {
    const overview = await run(stubRepository());

    expect(overview.enquiryRate.value).toBeNull();
    expect(overview.enquiryRate.denominator).toBe(0);
  });

  it('shows its working on a rate that does exist', async () => {
    const overview = await run(
      stubRepository({
        runOverviewCounts: vi.fn().mockResolvedValue({
          totalConversations: 10,
          uniqueContacts: 9,
          needsAttention: 2,
          enquiryClassCounts: [
            { enquiryClass: 'enquiry', count: 3 },
            { enquiryClass: 'not_enquiry', count: 1 },
            { enquiryClass: 'needs_review', count: 6 },
          ],
          aiStatusCounts: AI_RESPONSE_STATUS_VALUES.map((status) => ({ status, count: 0 })),
        }),
      }),
    );

    // 3 of the 4 whose class is established - the 6 unclassified are excluded from the
    // denominator rather than counted as non-enquiries, which would read as 30%.
    expect(overview.enquiryRate).toMatchObject({ value: 75, numerator: 3, denominator: 4 });
  });

  it('reports needs-review as its own number rather than folding it into a total', async () => {
    const overview = await run(
      stubRepository({
        runOverviewCounts: vi.fn().mockResolvedValue({
          totalConversations: 5,
          uniqueContacts: 5,
          needsAttention: 0,
          enquiryClassCounts: [
            { enquiryClass: 'enquiry', count: 0 },
            { enquiryClass: 'not_enquiry', count: 0 },
            { enquiryClass: 'needs_review', count: 5 },
          ],
          aiStatusCounts: AI_RESPONSE_STATUS_VALUES.map((status) => ({ status, count: 0 })),
        }),
      }),
    );

    expect(overview.needsReview.value).toBe(5);
    expect(overview.needsReview.definition).toMatch(/not been established|cannot yet classify/i);
  });

  it('returns all six AI buckets even when every one of them is empty', async () => {
    const overview = await run(stubRepository());

    expect(overview.aiStatusCounts).toHaveLength(AI_RESPONSE_STATUS_VALUES.length);
    expect(overview.enquiryClassCounts).toHaveLength(ENQUIRY_CLASS_VALUES.length);
  });

  it('passes the actor narrowing through to the repository', async () => {
    const repository = stubRepository();
    await run(repository, OWN_ONLY);

    const passed = vi.mocked(repository.runOverviewCounts).mock.calls[0]?.[0];
    expect(passed?.scope.assignedTo?.toString()).toBe(ACTOR.toString());
  });

  it('passes no narrowing for a read-all caller', async () => {
    const repository = stubRepository();
    await run(repository, READ_ALL);

    expect(vi.mocked(repository.runOverviewCounts).mock.calls[0]?.[0].scope.assignedTo).toBeNull();
  });

  it('echoes the window it is reporting on', async () => {
    const overview = await run(stubRepository());

    expect(overview.range).toMatchObject({
      preset: 'last_7_days',
      timeZone: 'Asia/Kolkata',
      days: 7,
    });
  });

  it('rejects an incoherent custom range with a 400 rather than guessing one', async () => {
    await expect(
      getAnalyticsOverview({
        actor: actor(),
        filters: { preset: 'custom', fromDate: '2026-10-01' },
        now: NOW,
        timeZone: 'Asia/Kolkata',
        repository: stubRepository(),
      }),
    ).rejects.toMatchObject({ statusCode: 400, code: 'INVALID_DATE_RANGE' });
  });
});

describe('the trends', () => {
  const run = (repository: NonNullable<AnalyticsRepositoryPort>) =>
    getAnalyticsTrends({
      actor: actor(),
      filters: { preset: 'last_7_days' },
      now: NOW,
      timeZone: 'Asia/Kolkata',
      repository,
    });

  it('fills every local day in the range, zeroes included', async () => {
    // A chart that omits a quiet Tuesday draws a straight line from Monday to Wednesday,
    // which reads as steady traffic on a day that had none.
    const trends = await run(stubRepository());

    expect(trends.points).toHaveLength(7);
    expect(trends.points.every((point) => point.conversationsCreated === 0)).toBe(true);
  });

  it('returns the days in order with no gaps', async () => {
    const days = (await run(stubRepository())).points.map((point) => point.day);

    expect(days).toEqual([...days].sort());
    expect(new Set(days).size).toBe(days.length);
  });

  it('places a day the aggregation returned into the right bucket', async () => {
    const trends = await run(
      stubRepository({
        runConversationTrend: vi
          .fn()
          .mockResolvedValue([
            { day: '2026-10-19', conversationsCreated: 4, enquiriesConfirmed: 2 },
          ]),
        runMessageTrend: vi
          .fn()
          .mockResolvedValue([
            { day: '2026-10-19', inboundMessages: 11, outboundMessagesDelivered: 7 },
          ]),
      }),
    );

    const day = trends.points.find((point) => point.day === '2026-10-19');

    expect(day).toMatchObject({
      conversationsCreated: 4,
      enquiriesConfirmed: 2,
      inboundMessages: 11,
      outboundMessagesDelivered: 7,
    });
  });

  it('warns that the enquiry series is a cohort view, not a historical one', async () => {
    const { definitions } = await run(stubRepository());

    expect(definitions.enquiriesConfirmed).toMatch(/current-state|AS OF NOW/i);
    expect(definitions.day).toContain('Asia/Kolkata');
  });
});

describe('AI performance', () => {
  const run = (repository: NonNullable<AnalyticsRepositoryPort>) =>
    getAnalyticsAiPerformance({
      actor: actor(),
      filters: {},
      now: NOW,
      timeZone: 'Asia/Kolkata',
      repository,
    });

  it('returns a NULL coverage rate when there were no enquiries to cover', async () => {
    const performance = await run(stubRepository());

    expect(performance.coverageRate.value).toBeNull();
  });

  it('keeps message counts and conversation counts apart', async () => {
    const performance = await run(
      stubRepository({
        runAiConversationCounts: vi.fn().mockResolvedValue({
          enquiries: 4,
          enquiriesWithAiReply: 3,
          enquiriesAwaitingReply: 1,
          pausedOrOwnerHandled: 2,
        }),
        runAiMessageCounts: vi.fn().mockResolvedValue([
          { bucket: 'delivered', count: 31 },
          { bucket: 'failed', count: 2 },
          { bucket: 'pending', count: 5 },
        ]),
      }),
    );

    expect(performance.enquiriesWithAiReply.value).toBe(3);
    expect(performance.aiMessagesDelivered.value).toBe(31);
    expect(performance.aiMessagesDelivered.definition).toMatch(/message count, not a conversation/i);
    expect(performance.coverageRate).toMatchObject({ value: 75, numerator: 3, denominator: 4 });
  });

  it('reports an empty response-time sample as nulls with the reason, not as zero seconds', async () => {
    const performance = await run(stubRepository());

    expect(performance.firstResponseSeconds).toMatchObject({
      median: null,
      average: null,
      sampleSize: 0,
    });
    expect(performance.firstResponseSeconds.definition).toMatch(
      /not a zero-second response time/i,
    );
  });

  it('states how many conversations a real response time was measured over', async () => {
    const performance = await run(
      stubRepository({
        runFirstResponseStats: vi
          .fn()
          .mockResolvedValue({ sampleSize: 9, averageSeconds: 142.46, medianSeconds: 95 }),
      }),
    );

    expect(performance.firstResponseSeconds).toMatchObject({
      median: 95,
      average: 142.5,
      sampleSize: 9,
    });
    expect(performance.firstResponseSeconds.definition).toMatch(/EXCLUDED from the sample/i);
  });
});

describe('the breakdowns', () => {
  const run = (repository: NonNullable<AnalyticsRepositoryPort>) =>
    getAnalyticsBreakdowns({
      actor: actor(),
      filters: {},
      now: NOW,
      timeZone: 'Asia/Kolkata',
      repository,
    });

  it('labels the stage counts as a snapshot rather than a funnel', async () => {
    const breakdowns = await run(stubRepository());

    expect(breakdowns.asOf).toBe(NOW.toISOString());
    expect(breakdowns.definitions.currentStageCounts).toMatch(/snapshot/i);
    expect(breakdowns.definitions.currentStageCounts).toMatch(/not a funnel/i);
  });

  it('spells out every metric this schema cannot support, with the reason', async () => {
    const breakdowns = await run(stubRepository());

    expect(breakdowns.unavailable.length).toBe(UNAVAILABLE_METRICS.length);
    expect(breakdowns.unavailable.every((entry) => entry.reason.length > 40)).toBe(true);

    const text = JSON.stringify(breakdowns.unavailable).toLowerCase();
    expect(text).toContain('revenue');
    expect(text).toContain('funnel');
    expect(text).toContain('missed');
    expect(text).toContain('assignment');
  });

  it('names a built-in stage and keeps an admin-defined label', async () => {
    const breakdowns = await run(
      stubRepository({
        runStageBreakdown: vi.fn().mockResolvedValue([
          { stage: 'new', label: null, count: 5 },
          { stage: 'shoot-booked', label: 'Shoot booked', count: 2 },
          { stage: 'odd-legacy-key', label: null, count: 1 },
        ]),
      }),
    );

    expect(breakdowns.currentStageCounts.map((entry) => entry.label)).toEqual([
      'New',
      'Shoot booked',
      'Odd Legacy Key',
    ]);
  });

  it('shows leads with no source rather than dropping them', async () => {
    const breakdowns = await run(
      stubRepository({
        runSourceBreakdown: vi
          .fn()
          .mockResolvedValue([
            { sourceId: null, sourceName: null, conversations: 8, enquiries: 2 },
          ]),
      }),
    );

    expect(breakdowns.bySource[0]).toMatchObject({
      sourceId: null,
      sourceName: 'Direct - no lead source',
      enquiryRate: 25,
    });
  });

  it('gives a source with no conversations a null rate, not a zero', async () => {
    const breakdowns = await run(
      stubRepository({
        runSourceBreakdown: vi.fn().mockResolvedValue([
          {
            sourceId: OTHER_USER,
            sourceName: 'Wedding expo sheet',
            conversations: 0,
            enquiries: 0,
          },
        ]),
      }),
    );

    expect(breakdowns.bySource[0]?.enquiryRate).toBeNull();
  });

  it('names the unassigned bucket instead of leaving it blank', async () => {
    const breakdowns = await run(
      stubRepository({
        runOwnerBreakdown: vi.fn().mockResolvedValue([
          { userId: null, userName: null, conversations: 4, enquiries: 1, needsAttention: 3 },
        ]),
      }),
    );

    expect(breakdowns.byOwner[0]).toMatchObject({ userId: null, userName: 'Unassigned' });
    expect(breakdowns.definitions.byOwner).toMatch(/CURRENT assignment/i);
  });

  it('derives overdue follow-ups and says why "missed" is not shown', async () => {
    const breakdowns = await run(
      stubRepository({
        runFollowUpCounts: vi
          .fn()
          .mockResolvedValue({ pending: 6, overdue: 2, dueToday: 3, completed: 11 }),
      }),
    );

    // Follow-up counts moved to the reminders endpoint, which owns them with fuller
    // definitions and due-today as well. Breakdowns must no longer run that aggregation -
    // it was the same query twice per page load, one result discarded.
    expect(breakdowns).not.toHaveProperty('followUps');
  });

  it('does not run the follow-up aggregation at all', async () => {
    // The cost side of the same change: not merely absent from the payload, not queried.
    const runFollowUpCounts = vi.fn();

    await run(stubRepository({ runFollowUpCounts }));

    expect(runFollowUpCounts).not.toHaveBeenCalled();
  });
});

/**
 * The reminders overview.
 *
 * TWO THINGS HERE CAN BE WRONG WITHOUT LOOKING WRONG. The first is the local day: this business
 * runs on Asia/Kolkata, where midnight is 18:30 UTC the evening before, so a "due today" count
 * taken against UTC midnights is five and a half hours out every single evening and still
 * renders as a perfectly believable small number. The second is the personal reminder: it has
 * no conversation, so any code that reaches for a lead name has to come back with nothing
 * rather than with the nearest plausible string.
 *
 * The repository is injected, so the counts below are given rather than computed - what is
 * under test is that the service passes the right BOUNDARIES down, labels the two kinds of
 * number differently on the way back, and never substitutes a value it was not given.
 */
describe('the reminders overview', () => {
  const run = (repository: NonNullable<AnalyticsRepositoryPort>, limit = 5) =>
    getAnalyticsReminders({
      actor: actor(),
      filters: {},
      now: NOW,
      timeZone: 'Asia/Kolkata',
      limit,
      repository,
    });

  /** NOW is 14:30 on 20 October in Asia/Kolkata, so the local day runs between these. */
  const LOCAL_DAY_START = new Date('2026-10-19T18:30:00.000Z');
  const LOCAL_DAY_END = new Date('2026-10-20T18:30:00.000Z');

  const reminder = (overrides: Record<string, unknown> = {}) => ({
    _id: new Types.ObjectId('6ab4c2037469f65204cfe551'),
    title: 'Send the Goa package',
    dueAt: new Date('2026-10-20T11:00:00.000Z'),
    source: 'lead_commitment',
    sourceQuote: 'call me after 4 tomorrow',
    conversationId: CONVERSATION,
    conversationDisplayName: 'Priya Nair',
    assignedToName: 'Himanshu',
    ...overrides,
  });

  it('asks for due-today against the LOCAL calendar day, not a UTC one', async () => {
    const runFollowUpCounts = vi
      .fn()
      .mockResolvedValue({ pending: 0, overdue: 0, dueToday: 0, completed: 0 });

    await run(stubRepository({ runFollowUpCounts }));

    expect(runFollowUpCounts).toHaveBeenCalledWith(
      expect.objectContaining({ dayStart: LOCAL_DAY_START, dayEnd: LOCAL_DAY_END }),
    );
  });

  it('separates the three as-of-now counts from the one counted over the range', async () => {
    const runFollowUpCounts = vi
      .fn()
      .mockResolvedValue({ pending: 9, overdue: 4, dueToday: 3, completed: 12 });

    const reminders = await run(stubRepository({ runFollowUpCounts }));

    // Completed is the only one bounded by the selected range; the others are snapshots.
    expect(runFollowUpCounts).toHaveBeenCalledWith(
      expect.objectContaining({ from: expect.any(Date), to: expect.any(Date) }),
    );

    expect(reminders.counts.pending.definition).toMatch(/current outstanding/i);
    expect(reminders.counts.overdue.definition).toMatch(/current outstanding/i);
    expect(reminders.counts.dueToday.definition).toMatch(/current outstanding/i);
    expect(reminders.counts.completed.definition).toMatch(/inside the selected range/i);
  });

  it('counts completed on completedAt rather than on when the reminder was made', async () => {
    const reminders = await run(stubRepository());

    expect(reminders.counts.completed.definition).toContain('FollowUpTask.completedAt');
    expect(reminders.counts.completed.definition).toMatch(/never on createdAt/i);
  });

  it('says that overdue is inside pending and that due-today overlaps it', async () => {
    // Printed rather than implied, because four numbers in a row invite being added up and
    // these three describe the same set from three angles.
    const reminders = await run(stubRepository());

    expect(reminders.counts.overdue.definition).toMatch(/subset of pending/i);
    expect(reminders.counts.dueToday.definition).toMatch(/overlaps overdue/i);
  });

  it('names the timezone the local day was computed in', async () => {
    const reminders = await run(stubRepository());

    expect(reminders.counts.dueToday.definition).toContain('Asia/Kolkata');
    expect(reminders.range.timeZone).toBe('Asia/Kolkata');
  });

  it('reports a counted none as a real zero and an empty list, not as missing data', async () => {
    const reminders = await run(stubRepository());

    expect(reminders.counts.pending.value).toBe(0);
    expect(reminders.counts.overdue.value).toBe(0);
    expect(reminders.counts.dueToday.value).toBe(0);
    expect(reminders.counts.completed.value).toBe(0);
    expect(reminders.next).toEqual([]);
  });

  it('counts reminder RECORDS, so one lead with three pending reminders contributes three', async () => {
    const reminders = await run(
      stubRepository({
        runFollowUpCounts: vi
          .fn()
          .mockResolvedValue({ pending: 3, overdue: 0, dueToday: 3, completed: 0 }),
        runNextReminders: vi.fn().mockResolvedValue([
          reminder({ _id: new Types.ObjectId('6ab4c2037469f65204cfe561'), title: 'Call back' }),
          reminder({ _id: new Types.ObjectId('6ab4c2037469f65204cfe562'), title: 'Send quote' }),
          reminder({ _id: new Types.ObjectId('6ab4c2037469f65204cfe563'), title: 'Confirm date' }),
        ]),
      }),
    );

    // All three are the same lead. Collapsing them to one would hide two pieces of owed work.
    expect(reminders.next).toHaveLength(3);
    expect(new Set(reminders.next.map((row) => row.conversationId)).size).toBe(1);
    expect(reminders.counts.pending.value).toBe(3);
    expect(reminders.counts.pending.definition).toMatch(/contributes three/i);
  });

  it('keeps the repository order - soonest due first - rather than re-sorting it', async () => {
    const reminders = await run(
      stubRepository({
        runNextReminders: vi.fn().mockResolvedValue([
          reminder({
            _id: new Types.ObjectId('6ab4c2037469f65204cfe571'),
            title: 'Overdue since yesterday',
            dueAt: new Date('2026-10-19T04:00:00.000Z'),
          }),
          reminder({
            _id: new Types.ObjectId('6ab4c2037469f65204cfe572'),
            title: 'Due this afternoon',
            dueAt: new Date('2026-10-20T11:00:00.000Z'),
          }),
          reminder({
            _id: new Types.ObjectId('6ab4c2037469f65204cfe573'),
            title: 'Due next week',
            dueAt: new Date('2026-10-27T11:00:00.000Z'),
          }),
        ]),
      }),
    );

    expect(reminders.next.map((row) => row.title)).toEqual([
      'Overdue since yesterday',
      'Due this afternoon',
      'Due next week',
    ]);
  });

  it('flags an overdue row as still actionable rather than dropping it', async () => {
    const reminders = await run(
      stubRepository({
        runNextReminders: vi.fn().mockResolvedValue([
          reminder({ dueAt: new Date('2026-10-19T04:00:00.000Z') }),
          reminder({
            _id: new Types.ObjectId('6ab4c2037469f65204cfe582'),
            dueAt: new Date('2026-10-27T11:00:00.000Z'),
          }),
        ]),
      }),
    );

    expect(reminders.next[0]?.overdue).toBe(true);
    expect(reminders.next[1]?.overdue).toBe(false);
    expect(reminders.definitions.next).toMatch(/overdue ones are pending/i);
  });

  it('marks a personal reminder and gives it no lead name', async () => {
    const reminders = await run(
      stubRepository({
        runNextReminders: vi.fn().mockResolvedValue([
          reminder({
            title: 'Review the campaign',
            conversationId: null,
            conversationDisplayName: null,
            source: 'owner_command',
            sourceQuote: null,
          }),
          reminder({ _id: new Types.ObjectId('6ab4c2037469f65204cfe592') }),
        ]),
      }),
    );

    expect(reminders.next[0]).toMatchObject({
      isPersonal: true,
      conversationId: null,
      leadName: null,
      sourceQuote: null,
    });
    expect(reminders.next[1]).toMatchObject({ isPersonal: false, leadName: 'Priya Nair' });
    expect(reminders.definitions.personal).toMatch(/no lead name|not about anybody/i);
  });

  it('refuses to borrow a lead name for a reminder with no conversation', async () => {
    // The row the database could still hand back: no conversation, but a stale display name
    // riding along. Printing it would attach a reminder to a lead it is not about.
    const reminders = await run(
      stubRepository({
        runNextReminders: vi
          .fn()
          .mockResolvedValue([
            reminder({ conversationId: null, conversationDisplayName: 'Priya Nair' }),
          ]),
      }),
    );

    expect(reminders.next[0]?.leadName).toBeNull();
    expect(reminders.next[0]?.isPersonal).toBe(true);
  });

  it('leaves an absent title absent instead of inventing one', async () => {
    const reminders = await run(
      stubRepository({
        runNextReminders: vi.fn().mockResolvedValue([reminder({ title: null })]),
      }),
    );

    expect(reminders.next[0]?.title).toBeNull();
  });

  it('passes the requested limit down and echoes it back', async () => {
    const runNextReminders = vi.fn().mockResolvedValue([]);

    const reminders = await run(stubRepository({ runNextReminders }), 20);

    expect(runNextReminders).toHaveBeenCalledWith(expect.objectContaining({ limit: 20 }));
    expect(reminders.limit).toBe(20);
    // A short list under a large pending count has to read as a preview, not as the total.
    expect(reminders.definitions.next).toMatch(/preview, not the whole list/i);
  });

  it('narrows both the counts and the list to a caller who cannot read every conversation', async () => {
    const runFollowUpCounts = vi
      .fn()
      .mockResolvedValue({ pending: 0, overdue: 0, dueToday: 0, completed: 0 });
    const runNextReminders = vi.fn().mockResolvedValue([]);

    await getAnalyticsReminders({
      actor: actor(OWN_ONLY),
      filters: {},
      now: NOW,
      timeZone: 'Asia/Kolkata',
      limit: 5,
      repository: stubRepository({ runFollowUpCounts, runNextReminders }),
    });

    for (const call of [runFollowUpCounts, runNextReminders]) {
      const scope = call.mock.calls[0]?.[0]?.scope;

      expect(scope.assignedTo?.toString()).toBe(ACTOR.toString());
      expect(scope.organizationId.toString()).toBe(ORG.toString());
    }
  });

  it('stamps asOf with the instant the snapshot counts were taken', async () => {
    const reminders = await run(stubRepository());

    expect(reminders.asOf).toBe(NOW.toISOString());
    expect(reminders.definitions.asOf).toMatch(/instant/i);
  });
});

const attentionRow = (overrides: Record<string, unknown> = {}) => ({
  _id: CONVERSATION,
  contactId: CONTACT,
  displayName: 'Priya =HYPERLINK("http://evil.test")',
  stage: 'new',
  assignedToName: 'Asha',
  lastInboundAt: new Date('2026-10-20T07:30:00.000Z'),
  nextFollowUpAt: null,
  leadQualificationStatus: 'confirmed',
  leadQualificationSource: 'ai_reply_sent',
  leadQualifiedAt: new Date('2026-10-19T10:00:00.000Z'),
  aiAutomationEnabled: true,
  optedOutAt: null,
  lastAiReplyAt: new Date('2026-10-19T10:00:00.000Z'),
  lastDeliveredOutboundAt: new Date('2026-10-19T10:00:00.000Z'),
  lastAiSendFailedAt: null,
  ...overrides,
});

describe('the attention list', () => {
  const run = (
    repository: NonNullable<AnalyticsRepositoryPort>,
    permissions: readonly string[] = READ_ALL,
  ) =>
    getAnalyticsAttentionList({
      actor: actor(permissions),
      filters: {},
      now: NOW,
      timeZone: 'Asia/Kolkata',
      repository,
      limit: 25,
      skip: 0,
    });

  it('labels each row with the same rules the inbox uses', async () => {
    const list = await run(
      stubRepository({
        runAttentionPage: vi.fn().mockResolvedValue({ rows: [attentionRow()], total: 1 }),
      }),
    );

    expect(list.rows[0]).toMatchObject({
      enquiryClass: 'enquiry',
      aiResponseStatus: 'awaiting_ai_reply',
      waitingMinutes: 90,
    });
    expect(list.rows[0]?.reason).toMatch(/confirmed enquiry has messaged/i);
  });

  it('leaves waiting time NULL when the customer has never messaged', async () => {
    // Zero would say "they messaged a moment ago", which is the opposite of the truth.
    const list = await run(
      stubRepository({
        runAttentionPage: vi.fn().mockResolvedValue({
          rows: [
            attentionRow({
              lastInboundAt: null,
              nextFollowUpAt: new Date('2026-10-20T08:00:00.000Z'),
            }),
          ],
          total: 1,
        }),
      }),
    );

    expect(list.rows[0]?.waitingMinutes).toBeNull();
    expect(list.rows[0]?.lastInboundAt).toBeNull();
    expect(list.rows[0]?.reason).toMatch(/follow-up/i);
  });

  it('explains a failed send differently from an unanswered message', async () => {
    const list = await run(
      stubRepository({
        runAttentionPage: vi.fn().mockResolvedValue({
          rows: [attentionRow({ lastAiSendFailedAt: new Date('2026-10-20T08:00:00.000Z') })],
          total: 1,
        }),
      }),
    );

    expect(list.rows[0]?.aiResponseStatus).toBe('ai_reply_failed');
    expect(list.rows[0]?.reason).toMatch(/failed to send/i);
  });

  it('withholds the phone number from a caller without the reveal permission', async () => {
    const repository = stubRepository({
      runAttentionPage: vi.fn().mockResolvedValue({ rows: [attentionRow()], total: 1 }),
    });

    const list = await run(repository, READ_ALL);

    expect(list.rows[0]?.phone).toBeNull();
    // Not merely blanked afterwards: nothing was decrypted in the first place.
    expect(repository.revealContactPhones).not.toHaveBeenCalled();
  });

  it('includes it for a caller who holds the permission', async () => {
    const repository = stubRepository({
      runAttentionPage: vi.fn().mockResolvedValue({ rows: [attentionRow()], total: 1 }),
      revealContactPhones: vi
        .fn()
        .mockResolvedValue(new Map([[CONTACT.toString(), '919876543210']])),
    });

    const list = await run(repository, WITH_PII);

    expect(list.rows[0]?.phone).toBe('919876543210');
  });

  it('carries the paging and the unpaged total back', async () => {
    const list = await run(
      stubRepository({
        runAttentionPage: vi.fn().mockResolvedValue({ rows: [attentionRow()], total: 97 }),
      }),
    );

    expect(list).toMatchObject({ total: 97, limit: 25, skip: 0 });
    expect(list.definition).toMatch(/need a human right now/i);
  });
});

describe('the CSV export', () => {
  const run = (
    repository: NonNullable<AnalyticsRepositoryPort>,
    permissions: readonly string[],
  ) =>
    getAnalyticsAttentionCsv({
      actor: actor(permissions),
      filters: {},
      now: NOW,
      timeZone: 'Asia/Kolkata',
      repository,
      limit: 1000,
      skip: 0,
    });

  const withRows = (overrides: Partial<NonNullable<AnalyticsRepositoryPort>> = {}) =>
    stubRepository({
      runAttentionPage: vi.fn().mockResolvedValue({ rows: [attentionRow()], total: 1 }),
      ...overrides,
    });

  it('omits the phone column entirely without the reveal permission', async () => {
    // A column of blanks would read as missing data rather than as a permission boundary.
    const csv = await run(withRows(), READ_ALL);

    expect(csv.body).not.toContain('Phone');
    expect(csv.body.split('\r\n')[0]).toContain('Conversation ID');
  });

  it('includes it when the caller may see one', async () => {
    const csv = await run(
      withRows({
        revealContactPhones: vi
          .fn()
          .mockResolvedValue(new Map([[CONTACT.toString(), '919876543210']])),
      }),
      WITH_PII,
    );

    expect(csv.body).toContain('Phone');
    expect(csv.body).toContain('919876543210');
  });

  it('neutralises a display name that is trying to be a spreadsheet formula', async () => {
    const csv = await run(withRows(), READ_ALL);

    expect(csv.body).toContain(`"Priya =HYPERLINK(""http://evil.test"")"`);
  });

  it('audits the export once, with a count and no numbers', async () => {
    const repository = withRows({
      revealContactPhones: vi
        .fn()
        .mockResolvedValue(new Map([[CONTACT.toString(), '919876543210']])),
    });

    await run(repository, WITH_PII);

    expect(repository.recordPhoneExportAudit).toHaveBeenCalledTimes(1);
    expect(vi.mocked(repository.recordPhoneExportAudit).mock.calls[0]?.[0]).toMatchObject({
      contactCount: 1,
      context: 'analytics.attention.csv',
    });
  });

  it('does not log a reveal when nothing was decrypted', async () => {
    const repository = withRows();

    await run(repository, WITH_PII);

    expect(repository.recordPhoneExportAudit).not.toHaveBeenCalled();
  });

  it('reports the matched total alongside the exported row count, so a clipped file shows it', async () => {
    const csv = await run(
      withRows({
        runAttentionPage: vi.fn().mockResolvedValue({ rows: [attentionRow()], total: 4321 }),
      }),
      READ_ALL,
    );

    expect(csv).toMatchObject({ rowCount: 1, total: 4321 });
    expect(csv.fileName).toBe('needs-attention-2026-10-20.csv');
  });
});
