/**
 * What the database is actually asked.
 *
 * WHAT THESE CAN PROVE. Every pipeline in the repository is built by a pure function, so the
 * exact document that would go to MongoDB can be asserted here with no database anywhere. The
 * three things worth pinning are the three whose absence is silent:
 *
 *   - the ORGANIZATION match, missing which one studio's dashboard totals another's;
 *   - `deletedAt: null`, missing which the counts keep including chats the owner deleted and
 *     disagree with every list in the app;
 *   - the ACTOR narrowing, missing which a staff user's cards total the whole organization
 *     while their inbox shows only their own threads.
 *
 * None of those three throws, logs or looks wrong on a developer's empty database. They are
 * exactly the kind of bug that ships.
 *
 * WHAT THESE CANNOT PROVE: that MongoDB produces the numbers these pipelines describe. That
 * needs a database with documents in it, and it is listed as an outstanding check.
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

vi.mock('../contacts/contact.model.js', () => ({
  Contact: { find: mocks.contactFind },
}));

vi.mock('../audit/audit.repository.js', () => ({
  createAuditLog: mocks.createAuditLog,
}));

vi.mock('../privacy/protected-pii.service.js', () => ({
  decryptContactPhoneFromStorage: mocks.decryptPhone,
}));

const {
  aiStatusFacetKey,
  buildAiMessagePipeline,
  buildAttentionPipeline,
  buildConversationMatch,
  buildConversationTrendPipeline,
  buildFirstResponsePipeline,
  buildFollowUpCountsPipeline,
  buildMessageTrendPipeline,
  buildNextRemindersPipeline,
  buildOverviewPipeline,
  buildOwnerBreakdownPipeline,
  buildSourceBreakdownPipeline,
  buildStageBreakdownPipeline,
  enquiryClassFacetKey,
  readFacetCount,
  recordPhoneExportAudit,
  revealContactPhones,
} = await import('./analytics.repository.js');

const { AI_RESPONSE_STATUS_VALUES, ENQUIRY_CLASS_VALUES } = await import(
  './conversation-classification.js'
);

const ORG = new Types.ObjectId('6ab4c2037469f65204cfe999');
const ACTOR = new Types.ObjectId('6ab4c2037469f65204cfe111');

const readAll = { organizationId: ORG, assignedTo: null };
const ownThreadsOnly = { organizationId: ORG, assignedTo: ACTOR };

const RANGE = {
  from: new Date('2026-10-01T18:30:00.000Z'),
  to: new Date('2026-10-21T18:30:00.000Z'),
};

/** The `$match` of a pipeline, whatever stage order the builder chose. */
const matchStage = (pipeline: unknown[]): Record<string, unknown> =>
  (pipeline.find((stage) => '$match' in (stage as object)) as { $match: Record<string, unknown> })
    .$match;

const stage = (pipeline: unknown[], name: string): Record<string, unknown> =>
  (pipeline.find((entry) => name in (entry as object)) as Record<string, unknown>)[name] as Record<
    string,
    unknown
  >;

describe('the match under every conversation pipeline', () => {
  it('always scopes to the organization and excludes deleted chats', () => {
    const match = buildConversationMatch({ scope: readAll });

    expect(match.organizationId).toBe(ORG);
    expect(match.deletedAt).toBeNull();
  });

  it('narrows to the actor when they cannot read every conversation', () => {
    // The bug this pins: without it a staff dashboard counts the whole organization while
    // their inbox shows only their own threads, and the two numbers never agree.
    expect(buildConversationMatch({ scope: ownThreadsOnly }).assignedTo).toBe(ACTOR);
  });

  it('omits the assignment narrowing for a read-all caller', () => {
    expect('assignedTo' in buildConversationMatch({ scope: readAll })).toBe(false);
  });

  it('uses a half-open window on createdAt', () => {
    const match = buildConversationMatch({ scope: readAll, ...RANGE });

    expect(match.createdAt).toEqual({ $gte: RANGE.from, $lt: RANGE.to });
  });

  it('leaves createdAt out entirely for a current-state count', () => {
    expect('createdAt' in buildConversationMatch({ scope: readAll })).toBe(false);
  });

  it('ANDs the derived classification filters instead of assigning them', () => {
    // Each of these contributes its own `$expr`; assigning them would leave only the last, and
    // "enquiries awaiting a reply" would quietly become "everything awaiting a reply".
    const match = buildConversationMatch({
      scope: readAll,
      enquiryClass: 'enquiry',
      aiStatus: 'awaiting_ai_reply',
      needsAttention: true,
    });

    expect(match.$and).toHaveLength(3);
  });

  it('adds nothing when no classification filter was asked for', () => {
    expect(buildConversationMatch({ scope: readAll }).$and).toBeUndefined();
  });
});

describe('the overview pipeline', () => {
  const pipeline = buildOverviewPipeline({ scope: ownThreadsOnly, ...RANGE });

  it('matches first, then fans out in a single pass', () => {
    expect(Object.keys(pipeline[0] as object)).toEqual(['$match']);
    expect(Object.keys(pipeline[1] as object)).toEqual(['$facet']);
  });

  it('carries the scope into the match', () => {
    const match = matchStage(pipeline);

    expect(match.organizationId).toBe(ORG);
    expect(match.deletedAt).toBeNull();
    expect(match.assignedTo).toBe(ACTOR);
  });

  it('asks for every bucket of both families, including the empty ones', () => {
    // A status that vanishes from the response because nothing matched is a status the UI
    // cannot draw, and the reader cannot tell "none" from "not measured".
    const facet = stage(pipeline, '$facet');

    for (const value of ENQUIRY_CLASS_VALUES) {
      expect(facet[enquiryClassFacetKey(value)]).toBeDefined();
    }

    for (const value of AI_RESPONSE_STATUS_VALUES) {
      expect(facet[aiStatusFacetKey(value)]).toBeDefined();
    }
  });

  it('keeps the two bucket families in separate keys', () => {
    // `needs_review` is a legal value of BOTH. Unprefixed they would collide into one count.
    expect(enquiryClassFacetKey('needs_review')).not.toBe(aiStatusFacetKey('needs_review'));
  });

  it('counts distinct contacts rather than conversations', () => {
    const facet = stage(pipeline, '$facet');
    const branch = facet.uniqueContacts as Array<Record<string, unknown>>;

    expect(branch[0]).toEqual({ $group: { _id: '$contactId' } });
  });
});

describe('reading a facet branch', () => {
  it('reads the count out of the single-document array', () => {
    expect(readFacetCount({ total: [{ value: 7 }] }, 'total')).toBe(7);
  });

  it('treats an empty branch as a real zero', () => {
    // MongoDB encodes "nothing matched" as an empty array, which IS a zero here - unlike a
    // missing metric, which never reaches this function in the first place.
    expect(readFacetCount({ total: [] }, 'total')).toBe(0);
    expect(readFacetCount({}, 'total')).toBe(0);
  });
});

describe('the trend pipelines', () => {
  it('buckets conversations on createdAt in the range timezone', () => {
    const pipeline = buildConversationTrendPipeline({
      scope: readAll,
      ...RANGE,
      timeZone: 'Asia/Kolkata',
    });

    expect(stage(pipeline, '$addFields')).toEqual({ _bucketDate: '$createdAt' });
    expect(stage(pipeline, '$group')._id).toEqual({
      $dateToString: { format: '%Y-%m-%d', date: '$_bucketDate', timezone: 'Asia/Kolkata' },
    });
  });

  it('counts confirmed enquiries off the qualification field, not a guess', () => {
    const group = stage(
      buildConversationTrendPipeline({ scope: readAll, ...RANGE, timeZone: 'UTC' }),
      '$group',
    );

    expect(JSON.stringify(group.enquiriesConfirmed)).toContain('confirmed');
  });

  it('buckets messages on sentAt, scoped to the organization', () => {
    const pipeline = buildMessageTrendPipeline({ scope: readAll, ...RANGE, timeZone: 'UTC' });
    const match = matchStage(pipeline);

    expect(match.organizationId).toBe(ORG);
    expect(match.sentAt).toEqual({ $gte: RANGE.from, $lt: RANGE.to });
    expect(stage(pipeline, '$addFields')).toEqual({ _bucketDate: '$sentAt' });
  });

  it('re-applies conversation visibility through a lookup, since messages carry none', () => {
    // Messages have no deletedAt and no assignedTo. Without this a deleted chat's traffic
    // stays on the chart forever and a staff user sees the whole organization's volume.
    const pipeline = buildMessageTrendPipeline({
      scope: ownThreadsOnly,
      ...RANGE,
      timeZone: 'UTC',
    });
    const lookup = stage(pipeline, '$lookup') as {
      from: string;
      pipeline: Array<{ $match?: Record<string, unknown> }>;
    };

    expect(lookup.from).toBe('conversations');
    expect(lookup.pipeline[0]?.$match).toMatchObject({
      organizationId: ORG,
      deletedAt: null,
      assignedTo: ACTOR,
    });
  });

  it('does not re-apply the creation window to the conversations behind the messages', () => {
    // A message sent this week can belong to a conversation created last year. Carrying the
    // createdAt window into the lookup would silently drop that week's real traffic.
    const pipeline = buildMessageTrendPipeline({ scope: readAll, ...RANGE, timeZone: 'UTC' });
    const lookup = stage(pipeline, '$lookup') as {
      pipeline: Array<{ $match?: Record<string, unknown> }>;
    };

    expect(lookup.pipeline[0]?.$match).not.toHaveProperty('createdAt');
  });

  it('collapses messages per conversation per day before the lookup', () => {
    // One lookup per thread per day rather than one per message - the difference between a
    // chart that loads and one that does not.
    const pipeline = buildMessageTrendPipeline({ scope: readAll, ...RANGE, timeZone: 'UTC' });
    const groupIndex = pipeline.findIndex((entry) => '$group' in (entry as object));
    const lookupIndex = pipeline.findIndex((entry) => '$lookup' in (entry as object));

    expect(groupIndex).toBeLessThan(lookupIndex);
  });
});

describe('the AI message pipeline', () => {
  const pipeline = buildAiMessagePipeline({ scope: readAll, ...RANGE });

  it('counts only AI-authored outbound messages', () => {
    const match = matchStage(pipeline);

    expect(match.authoredBy).toBe('ai');
    expect(match.direction).toBe('out');
  });

  it('splits the three delivery outcomes and never calls a queued message a send', () => {
    const buckets = JSON.stringify(stage(pipeline, '$addFields'));

    expect(buckets).toContain('delivered');
    expect(buckets).toContain('pending');
    expect(buckets).toContain('failed');
    // `sent` is a success and `queued` is not; both must appear, in different branches.
    expect(buckets).toContain('queued');
    expect(buckets).toContain('sent');
  });
});

describe('the first-response pipeline', () => {
  const pipeline = buildFirstResponsePipeline({ scope: readAll, ...RANGE });

  it('pairs the first inbound with the first AI reply delivered after it', () => {
    const lookups = pipeline.filter((entry) => '$lookup' in (entry as object));

    expect(lookups).toHaveLength(2);
    expect(JSON.stringify(lookups[1])).toContain('$$inboundAt');
  });

  it('drops conversations with no inbound or no delivered reply instead of scoring them zero', () => {
    // `$unwind` on an empty lookup result removes the document. That exclusion is the honest
    // behaviour: a thread nobody answered has no response time, it does not have one of zero.
    const unwinds = pipeline.filter((entry) => '$unwind' in (entry as object));

    expect(unwinds).toHaveLength(2);
  });

  it('only accepts a reply that actually reached WhatsApp', () => {
    const second = JSON.stringify(pipeline.filter((e) => '$lookup' in (e as object))[1]);

    expect(second).toContain('"ai"');
    expect(second).toContain('delivered');
    expect(second).not.toContain('"queued"');
  });
});

describe('the breakdown pipelines', () => {
  it('counts stages as a snapshot, with no date window', () => {
    const pipeline = buildStageBreakdownPipeline({ scope: readAll, ...RANGE });

    expect(matchStage(pipeline)).not.toHaveProperty('createdAt');
    expect(stage(pipeline, '$group')._id).toBe('$stage');
  });

  it('counts lead sources over the range, because that question is about a period', () => {
    const pipeline = buildSourceBreakdownPipeline({ scope: readAll, ...RANGE });

    expect(matchStage(pipeline).createdAt).toEqual({ $gte: RANGE.from, $lt: RANGE.to });
    expect(stage(pipeline, '$group')._id).toBe('$leadSourceId');
  });

  it('groups owners on the CURRENT assignment, with no date window', () => {
    const pipeline = buildOwnerBreakdownPipeline({ scope: readAll, ...RANGE });
    const facet = stage(pipeline, '$facet') as Record<string, Array<Record<string, unknown>>>;

    expect(matchStage(pipeline)).not.toHaveProperty('createdAt');
    expect((facet.totals?.[0]?.$group as { _id: string })._id).toBe('$assignedTo');
    expect((facet.attention?.[1]?.$group as { _id: string })._id).toBe('$assignedTo');
  });

  it('derives the owner attention column from the shared needs-attention filter', () => {
    const facet = stage(
      buildOwnerBreakdownPipeline({ scope: readAll, ...RANGE }),
      '$facet',
    ) as Record<string, Array<Record<string, unknown>>>;

    expect(JSON.stringify(facet.attention?.[0])).toContain('nextFollowUpAt');
  });
});

/** The current local calendar day in Asia/Kolkata, where midnight is 18:30 UTC the day before. */
const LOCAL_DAY = {
  dayStart: new Date('2026-10-20T18:30:00.000Z'),
  dayEnd: new Date('2026-10-21T18:30:00.000Z'),
};

describe('the follow-up pipeline', () => {
  const pipeline = buildFollowUpCountsPipeline({
    scope: ownThreadsOnly,
    ...RANGE,
    ...LOCAL_DAY,
  });

  it('scopes to the organization and to the actor', () => {
    const match = matchStage(pipeline);

    expect(match.organizationId).toBe(ORG);
    expect(match.assignedTo).toBe(ACTOR);
  });

  it('derives overdue from a pending task past its due date, never from the "missed" status', () => {
    // FOLLOWUP_STATUSES.MISSED is never written by any code path, so a card counting it would
    // read zero no matter what was actually overdue.
    const group = JSON.stringify(stage(pipeline, '$group'));

    expect(group).not.toContain('missed');
    expect(group).toContain('dueAt');
  });

  it('keeps personal reminders, which have no conversation at all', () => {
    const matches = pipeline.filter((entry) => '$match' in (entry as object));

    expect(JSON.stringify(matches[1])).toContain('conversationId');
  });

  it('bounds due-today by the LOCAL day it was handed, not by a UTC midnight', () => {
    // The bug this pins: in Asia/Kolkata a UTC-midnight boundary is five and a half hours out,
    // so every evening "due today" would start counting tomorrow's early reminders and would
    // have dropped this morning's. Nothing about that looks wrong on screen.
    const group = stage(pipeline, '$group') as {
      dueToday: { $sum: { $cond: [{ $and: unknown[] }, number, number] } };
    };

    expect(JSON.stringify(group.dueToday)).toContain('2026-10-20T18:30:00.000Z');
    expect(group.dueToday.$sum.$cond[0].$and).toContainEqual({
      $gte: ['$dueAt', LOCAL_DAY.dayStart],
    });
    // Half-open: a reminder due at exactly tomorrow's local midnight belongs to tomorrow.
    expect(group.dueToday.$sum.$cond[0].$and).toContainEqual({ $lt: ['$dueAt', LOCAL_DAY.dayEnd] });
  });

  it('keeps overdue and due-today inside pending rather than beside it', () => {
    // Both are "pending AND something", never a status of their own - which is what makes
    // overdue a strict subset of pending rather than a fourth bucket that can disagree with it.
    const group = stage(pipeline, '$group') as Record<string, unknown>;

    for (const key of ['overdue', 'dueToday']) {
      expect(JSON.stringify(group[key])).toContain('"$eq":["$status","pending"]');
    }
  });

  it('counts completed on completedAt and inside the range, not on createdAt', () => {
    const group = JSON.stringify(stage(pipeline, '$group'));

    expect(group).toContain('completedAt');
    expect(group).not.toContain('createdAt');
  });
});

describe('the next reminders pipeline', () => {
  const pipeline = buildNextRemindersPipeline({
    scope: ownThreadsOnly,
    ...RANGE,
    limit: 5,
  });

  it('scopes to the organization and to the actor, and asks only for pending work', () => {
    const match = matchStage(pipeline);

    expect(match.organizationId).toBe(ORG);
    expect(match.assignedTo).toBe(ACTOR);
    expect(match.status).toBe('pending');
  });

  it('puts no lower bound on dueAt, so overdue reminders stay on the list', () => {
    // They are the ones most worth showing. A `dueAt >= now` filter would silently drop
    // exactly the work that is late.
    expect(JSON.stringify(matchStage(pipeline))).not.toContain('dueAt');
  });

  it('orders by due date, soonest first, with a stable tiebreak', () => {
    expect(pipeline).toContainEqual({ $sort: { dueAt: 1, _id: 1 } });
    expect(pipeline).toContainEqual({ $limit: 5 });
  });

  it('filters to visible conversations BEFORE taking the page', () => {
    // The other way round fills the page with rows that are then thrown away, and a list of
    // five can come back with two in it.
    const visibility = pipeline.findIndex(
      (entry) => JSON.stringify(entry).includes('conversationId') && '$match' in (entry as object),
    );
    const limit = pipeline.findIndex((entry) => '$limit' in (entry as object));

    expect(visibility).toBeGreaterThan(-1);
    expect(visibility).toBeLessThan(limit);
  });

  it('resolves the assignee name through a lookup scoped to the organization', () => {
    const lookups = pipeline.filter((entry) => '$lookup' in (entry as object));
    const users = lookups.find((entry) =>
      JSON.stringify(entry).includes('"from":"users"'),
    );

    expect(JSON.stringify(users)).toContain(String(ORG));
    // After the limit, so it resolves at most `limit` names rather than one per pending task.
    expect(pipeline.indexOf(users as never)).toBeGreaterThan(
      pipeline.findIndex((entry) => '$limit' in (entry as object)),
    );
  });

  it('projects only fields the model stores, and no invented lead name', () => {
    const project = stage(pipeline, '$project');

    expect(Object.keys(project).sort()).toEqual([
      '_id',
      'assignedToName',
      'conversationDisplayName',
      'conversationId',
      'dueAt',
      'source',
      'sourceQuote',
      'title',
    ]);
    // The display name falls back to null, never to a placeholder: a personal reminder is not
    // about anybody, and giving it a name would be a fabrication the reader cannot detect.
    expect(JSON.stringify(project.conversationDisplayName)).toContain('null');
  });

  it('keeps personal reminders, which have no conversation at all', () => {
    const matches = pipeline.filter((entry) => '$match' in (entry as object));

    expect(JSON.stringify(matches[1])).toContain('"conversationId":null');
  });
});

describe('the attention pipeline', () => {
  const pipeline = buildAttentionPipeline({
    scope: readAll,
    ...RANGE,
    limit: 25,
    skip: 50,
  });

  it('applies the shared needs-attention filter rather than a second copy of the rule', () => {
    const match = matchStage(pipeline);

    expect(match.$and).toHaveLength(1);
    expect(JSON.stringify(match.$and)).toContain('nextFollowUpAt');
  });

  it('pages inside the database and counts the unpaged total alongside it', () => {
    const facet = stage(pipeline, '$facet') as Record<string, Array<Record<string, unknown>>>;

    expect(facet.rows).toContainEqual({ $skip: 50 });
    expect(facet.rows).toContainEqual({ $limit: 25 });
    expect(facet.total).toEqual([{ $count: 'value' }]);
  });

  it('orders by how long the thread has been owed something, oldest first', () => {
    const facet = stage(pipeline, '$facet') as Record<string, Array<Record<string, unknown>>>;
    const sort = facet.rows?.find((entry) => '$sort' in entry);

    expect(sort).toEqual({ $sort: { _waitingSince: 1, _id: 1 } });
  });

  it('projects only the classification inputs and the display columns', () => {
    const facet = stage(pipeline, '$facet') as Record<string, Array<Record<string, unknown>>>;
    const project = facet.rows?.find((entry) => '$project' in entry) as {
      $project: Record<string, unknown>;
    };

    expect(project.$project).toHaveProperty('leadQualificationStatus');
    expect(project.$project).toHaveProperty('lastAiSendFailedAt');
    // Nothing that is not needed leaves the database - notably no message bodies or AI facts.
    expect(project.$project).not.toHaveProperty('aiFacts');
    expect(project.$project).not.toHaveProperty('lastMessagePreview');
  });
});

describe('revealing phone numbers', () => {
  const chain = (contacts: unknown[]) => {
    const query = {
      select: vi.fn().mockReturnThis(),
      lean: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue(contacts),
    };
    mocks.contactFind.mockReturnValue(query);

    return query;
  };

  it('asks for the encrypted field explicitly, because it is never selected by default', async () => {
    const contactId = new Types.ObjectId('6ab4c2037469f65204cfe222');
    const query = chain([{ _id: contactId, encryptedPhone: 'cipher' }]);
    mocks.decryptPhone.mockReturnValue('919876543210');

    const phones = await revealContactPhones({ organizationId: ORG, contactIds: [contactId] });

    expect(query.select).toHaveBeenCalledWith('+encryptedPhone');
    expect(mocks.contactFind.mock.calls.at(-1)?.[0]).toMatchObject({ organizationId: ORG });
    expect(phones.get(contactId.toString())).toBe('919876543210');
  });

  it('does not query at all for an empty page', async () => {
    mocks.contactFind.mockClear();

    await revealContactPhones({ organizationId: ORG, contactIds: [] });

    expect(mocks.contactFind).not.toHaveBeenCalled();
  });

  it('audits an export without writing the numbers into the log', async () => {
    mocks.createAuditLog.mockResolvedValue({});

    await recordPhoneExportAudit({
      organizationId: ORG,
      actorId: ACTOR,
      contactCount: 12,
      context: 'analytics.attention.csv',
    });

    const written = mocks.createAuditLog.mock.calls.at(-1)?.[0] as {
      eventType: string;
      metadata: Record<string, unknown>;
    };

    expect(written.eventType).toBe('CLIENT_PII_REVEALED');
    expect(written.metadata).toEqual({
      field: 'phone',
      contactCount: 12,
      context: 'analytics.attention.csv',
    });
    expect(JSON.stringify(written.metadata)).not.toContain('9876543210');
  });
});

/**
 * Two bugs an adversarial review found in the reminder pipelines, pinned so they cannot return.
 *
 * Both were about WHICH reminders a pipeline admits, and both were invisible from the current
 * UI - the page only ever sends date parameters - which is exactly why they need tests rather
 * than a careful reading.
 */
describe('reminder pipeline scoping regressions', () => {
  const ORG = new Types.ObjectId();
  const ACTOR = new Types.ObjectId();

  const scope = { organizationId: ORG, assignedTo: ACTOR };
  const window = { from: new Date('2026-10-01T00:00:00.000Z'), to: new Date('2026-11-01T00:00:00.000Z') };
  const day = {
    dayStart: new Date('2026-10-20T18:30:00.000Z'),
    dayEnd: new Date('2026-10-21T18:30:00.000Z'),
  };

  /** The `$match` that decides whether a task survives its conversation lookup. */
  const visibilityStage = (pipeline: readonly Record<string, unknown>[]) =>
    pipeline.find(
      (stage) =>
        '$match' in stage &&
        JSON.stringify(stage).includes('conversation') &&
        !JSON.stringify(stage).includes('$lookup'),
    );

  it('EXCLUDES personal reminders when a lead-specific filter is active', () => {
    // The bug: `{$or: [{conversationId: null}, ...]}` waved every personal reminder through
    // regardless of the filter, so `?stage=won` answered with won-lead reminders PLUS every
    // personal reminder in the organization.
    const pipeline = buildFollowUpCountsPipeline({ scope, ...window, ...day, stage: 'won' });
    const stage = visibilityStage(pipeline as never);

    expect(JSON.stringify(stage)).not.toContain('conversationId');
    expect(JSON.stringify(stage)).toContain('$ne');
  });

  it('KEEPS personal reminders when no lead-specific filter is asked for', () => {
    // The default question is "my outstanding reminders", and the owner's own notes are part
    // of that. Only a lead-shaped filter should remove them.
    const pipeline = buildFollowUpCountsPipeline({ scope, ...window, ...day });

    expect(JSON.stringify(visibilityStage(pipeline as never))).toContain('conversationId');
  });

  it.each([['leadSourceId', new Types.ObjectId()], ['enquiryClass', 'enquiry'], ['aiStatus', 'awaiting_ai_reply']])(
    'treats %s as lead-specific too',
    (key, value) => {
      const pipeline = buildFollowUpCountsPipeline({
        scope,
        ...window,
        ...day,
        [key]: value,
      } as never);

      expect(JSON.stringify(visibilityStage(pipeline as never))).not.toContain('conversationId');
    },
  );

  it('narrows on the TASK assignee, never a second time on the conversation', () => {
    // The bug: the conversation lookup also carried `assignedTo`, so a staff member's own
    // reminder vanished from analytics the moment the conversation was reassigned to a
    // colleague - while their reminder list and their phone alarm both still showed it.
    // Reassignment never touches FollowUpTask.assignedTo, so this was ordinary, not exotic.
    const pipeline = buildNextRemindersPipeline({ scope, ...window, ...day, limit: 5 });

    const rootMatch = pipeline[0] as { $match: Record<string, unknown> };
    expect(String(rootMatch.$match.assignedTo)).toBe(String(ACTOR));

    const lookup = pipeline.find(
      (stage) => '$lookup' in stage && JSON.stringify(stage).includes('conversations'),
    );
    expect(JSON.stringify(lookup)).not.toContain(String(ACTOR));
  });

  it('still scopes the conversation lookup to the organization and to live chats', () => {
    // Dropping the actor narrowing must not have loosened the other two rules.
    const pipeline = buildNextRemindersPipeline({ scope, ...window, ...day, limit: 5 });
    const lookup = pipeline.find(
      (stage) => '$lookup' in stage && JSON.stringify(stage).includes('conversations'),
    );

    expect(JSON.stringify(lookup)).toContain(String(ORG));
    expect(JSON.stringify(lookup)).toContain('deletedAt');
  });
});
