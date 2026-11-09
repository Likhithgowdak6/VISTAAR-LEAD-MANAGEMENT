/**
 * CHARACTERISATION TESTS. Written before the Python port, against the Node implementation as it
 * stands. This module shipped with zero tests.
 *
 * THE MODULE IS TWO MODULES WEARING ONE COAT, and the tests are split the same way:
 *
 *   1. THE CATALOGUE - list, create, archive at `/api/v1/tags`. Touches the Tag collection and
 *      nothing else. This is the part that migrates.
 *
 *   2. THE ATTACHMENT - attach and detach at `/conversations/:id/tags`. Reaches into the
 *      conversations module for visibility, writes the conversation document, and writes an
 *      activity row, both inside one transaction. This CANNOT migrate before conversations do;
 *      it is covered here so the rule is written down before Phase 9 moves it.
 *
 * THE UNIQUENESS SCOPE IS THE SUBTLE ONE. A tag is unique per (organization, whatsappAccountId,
 * slug) - NOT per organisation. A global tag (`whatsappAccountId: null`) and an account-scoped
 * tag may both be called "vip", and the list for an account returns both. Collapsing that to a
 * per-organisation rule would reject legitimate tags with a 409 that looks like a bug.
 *
 * Mocked repository and collaborators, no real Mongo.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';

vi.mock('../../config/env.js', () => ({
  env: { NODE_ENV: 'test', LOG_LEVEL: 'silent' },
}));

const mocks = vi.hoisted(() => ({
  archiveTag: vi.fn(),
  createTag: vi.fn(),
  findTagById: vi.fn(),
  findTagBySlugInScope: vi.fn(),
  findTagsByOrganization: vi.fn(),
  createActivity: vi.fn(),
  addTagToConversation: vi.fn(),
  removeTagFromConversation: vi.fn(),
  loadVisibleConversationForActor: vi.fn(),
  runInTransaction: vi.fn(),
}));

vi.mock('./tag.repository.js', async () => {
  // `normalizeTagSlug` is deliberately NOT mocked - it is the behaviour under test.
  const actual = await vi.importActual<typeof import('./tag.repository.js')>('./tag.repository.js');

  return { ...actual, ...mocks };
});

vi.mock('../activity/activity-log.repository.js', () => ({
  createActivity: mocks.createActivity,
}));

vi.mock('../conversations/conversation.repository.js', () => ({
  addTagToConversation: mocks.addTagToConversation,
  removeTagFromConversation: mocks.removeTagFromConversation,
}));

vi.mock('../conversations/conversation.service.js', () => ({
  loadVisibleConversationForActor: mocks.loadVisibleConversationForActor,
}));

vi.mock('../../config/database.js', () => ({
  runInTransaction: mocks.runInTransaction,
}));

const {
  archiveTagForActor,
  attachTagToConversationForActor,
  createTagForActor,
  detachTagFromConversationForActor,
  listTagsForOrganization,
} = await import('./tag.service.js');

const { normalizeTagSlug } = await import('./tag.repository.js');

const ORG = new Types.ObjectId();
const ACCOUNT = new Types.ObjectId();
// The id is held separately because ACTOR is cast to `never` so it can stand in for a
// HydratedDocument at the call sites - reading `._id` back off a `never` does not
// typecheck, even though it is present at runtime.
const ACTOR_ID = new Types.ObjectId();
const ACTOR = { _id: ACTOR_ID } as never;
const SESSION = Symbol('session');

const tagRow = (over: Record<string, unknown> = {}) => ({
  _id: new Types.ObjectId(),
  organizationId: ORG,
  whatsappAccountId: null,
  name: 'VIP',
  slug: 'vip',
  color: null,
  description: null,
  status: 'active',
  createdBy: null,
  updatedBy: null,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  ...over,
});

const conversationRow = () => ({
  _id: new Types.ObjectId(),
  whatsappAccountId: ACCOUNT,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findTagsByOrganization.mockResolvedValue([]);
  mocks.findTagBySlugInScope.mockResolvedValue(null);
  // Runs the body with a stand-in session so the calls inside can be asserted.
  mocks.runInTransaction.mockImplementation((fn: (s: unknown) => unknown) => fn(SESSION));
});

describe('normalizeTagSlug', () => {
  // The exact table the Python port must reproduce - identical rules to stage keys, but a
  // separate function, so a change to one must not be assumed to apply to the other.
  it.each([
    ['VIP', 'vip'],
    ['  Repeat  Client  ', 'repeat-client'],
    ['Repeat_Client', 'repeat-client'],
    ['High Value #1', 'high-value-1'],
    ['Budget ₹₹₹', 'budget'],
    ['---edge---', 'edge'],
  ])('maps %j to %j', (input, expected) => {
    expect(normalizeTagSlug(input)).toBe(expected);
  });

  it('COLLAPSES RUNS OF SEPARATORS INTO ONE HYPHEN', () => {
    expect(normalizeTagSlug('repeat   client')).toBe('repeat-client');
  });
});

describe('createTagForActor', () => {
  it('derives the slug from the name when none is given', async () => {
    mocks.createTag.mockResolvedValue(tagRow());

    await createTagForActor({ organizationId: ORG, actor: ACTOR, name: 'Repeat Client' });

    expect(mocks.createTag).toHaveBeenCalledWith(
      expect.objectContaining({ slug: 'repeat-client', name: 'Repeat Client' }),
    );
  });

  it('normalises an explicit slug too', async () => {
    mocks.createTag.mockResolvedValue(tagRow());

    await createTagForActor({
      organizationId: ORG,
      actor: ACTOR,
      name: 'Anything',
      slug: 'High Value',
    });

    expect(mocks.createTag).toHaveBeenCalledWith(expect.objectContaining({ slug: 'high-value' }));
  });

  it('stores the name verbatim, not normalised', async () => {
    mocks.createTag.mockResolvedValue(tagRow());

    await createTagForActor({ organizationId: ORG, actor: ACTOR, name: 'Repeat Client' });

    expect(mocks.createTag.mock.calls[0][0].name).toBe('Repeat Client');
  });

  it('refuses a duplicate slug in the same scope', async () => {
    mocks.findTagBySlugInScope.mockResolvedValue(tagRow());

    await expect(
      createTagForActor({ organizationId: ORG, actor: ACTOR, name: 'VIP' }),
    ).rejects.toThrow('TAG_SLUG_EXISTS');

    expect(mocks.createTag).not.toHaveBeenCalled();
  });

  it('CHECKS UNIQUENESS WITHIN THE ACCOUNT, NOT THE WHOLE ORGANISATION', async () => {
    mocks.createTag.mockResolvedValue(tagRow());

    await createTagForActor({
      organizationId: ORG,
      actor: ACTOR,
      name: 'VIP',
      whatsappAccountId: ACCOUNT,
    });

    expect(mocks.findTagBySlugInScope).toHaveBeenCalledWith({
      organizationId: ORG,
      whatsappAccountId: ACCOUNT,
      slug: 'vip',
    });
  });

  it('TREATS A MISSING ACCOUNT AS THE GLOBAL SCOPE, NOT AS "ANY SCOPE"', async () => {
    // `null` is a value to match, not an absent filter. Dropping the key would make the lookup
    // match an account-scoped tag and reject a legitimate global one with 409.
    mocks.createTag.mockResolvedValue(tagRow());

    await createTagForActor({ organizationId: ORG, actor: ACTOR, name: 'VIP' });

    expect(mocks.findTagBySlugInScope.mock.calls[0][0].whatsappAccountId).toBeNull();
    expect(mocks.createTag.mock.calls[0][0].whatsappAccountId).toBeNull();
  });

  it('records the actor as createdBy', async () => {
    mocks.createTag.mockResolvedValue(tagRow());

    await createTagForActor({ organizationId: ORG, actor: ACTOR, name: 'VIP' });

    expect(mocks.createTag.mock.calls[0][0].createdBy).toBe(ACTOR_ID);
  });

  it('returns the serialized shape, not the document', async () => {
    const row = tagRow();
    mocks.createTag.mockResolvedValue(row);

    const result = await createTagForActor({ organizationId: ORG, actor: ACTOR, name: 'VIP' });

    expect(result).toEqual({
      id: row._id.toString(),
      organizationId: ORG.toString(),
      whatsappAccountId: null,
      name: 'VIP',
      slug: 'vip',
      color: null,
      description: null,
      status: 'active',
      createdBy: null,
      updatedBy: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
  });
});

describe('listTagsForOrganization', () => {
  it('passes the organisation, account, status and pagination straight through', async () => {
    await listTagsForOrganization({
      organizationId: ORG,
      whatsappAccountId: ACCOUNT,
      status: 'active',
      limit: 25,
      skip: 50,
    });

    expect(mocks.findTagsByOrganization).toHaveBeenCalledWith({
      organizationId: ORG,
      whatsappAccountId: ACCOUNT,
      status: 'active',
      limit: 25,
      skip: 50,
    });
  });

  it('omits the status filter when none is asked for', async () => {
    await listTagsForOrganization({ organizationId: ORG });

    expect(mocks.findTagsByOrganization.mock.calls[0][0].status).toBeUndefined();
  });
});

describe('archiveTagForActor', () => {
  it('ARCHIVES RATHER THAN DELETES', async () => {
    const row = tagRow();
    mocks.findTagById.mockResolvedValue(row);
    mocks.archiveTag.mockResolvedValue(tagRow({ _id: row._id, status: 'archived' }));

    const result = await archiveTagForActor({ organizationId: ORG, tagId: row._id, actor: ACTOR });

    expect(result?.status).toBe('archived');
  });

  it('records the actor as updatedBy', async () => {
    const row = tagRow();
    mocks.findTagById.mockResolvedValue(row);
    mocks.archiveTag.mockResolvedValue(row);

    await archiveTagForActor({ organizationId: ORG, tagId: row._id, actor: ACTOR });

    expect(mocks.archiveTag).toHaveBeenCalledWith({
      tagId: row._id,
      organizationId: ORG,
      actorId: ACTOR_ID,
    });
  });

  it('REFUSES A TAG FROM ANOTHER ORGANISATION', async () => {
    mocks.findTagById.mockResolvedValue(null);

    await expect(
      archiveTagForActor({ organizationId: ORG, tagId: new Types.ObjectId(), actor: ACTOR }),
    ).rejects.toThrow('TAG_NOT_FOUND');

    expect(mocks.archiveTag).not.toHaveBeenCalled();
  });
});

describe('attach and detach', () => {
  /**
   * STAYING IN NODE UNTIL PHASE 9. These reach into the conversations module, so they move when
   * conversations move. Pinned now because the rules below are invisible from the route.
   */

  const setUp = () => {
    const conversation = conversationRow();
    const tag = tagRow({ slug: 'vip' });
    const updated = { _id: conversation._id, tags: [tag._id] };

    mocks.loadVisibleConversationForActor.mockResolvedValue(conversation);
    mocks.findTagById.mockResolvedValue(tag);
    mocks.addTagToConversation.mockResolvedValue(updated);
    mocks.removeTagFromConversation.mockResolvedValue({ _id: conversation._id, tags: [] });

    return { conversation, tag };
  };

  const args = (conversationId: Types.ObjectId, tagId: Types.ObjectId) => ({
    organizationId: ORG,
    conversationId,
    tagId,
    actor: ACTOR,
    permissions: ['conversations.read'] as never,
  });

  it('CHECKS CONVERSATION VISIBILITY BEFORE TOUCHING THE TAG', async () => {
    // A staff member must not learn which tags exist by probing conversations they cannot see.
    mocks.loadVisibleConversationForActor.mockRejectedValue(new Error('CONVERSATION_NOT_FOUND'));

    await expect(
      attachTagToConversationForActor(args(new Types.ObjectId(), new Types.ObjectId())),
    ).rejects.toThrow('CONVERSATION_NOT_FOUND');

    expect(mocks.findTagById).not.toHaveBeenCalled();
  });

  it('refuses a tag from another organisation', async () => {
    mocks.loadVisibleConversationForActor.mockResolvedValue(conversationRow());
    mocks.findTagById.mockResolvedValue(null);

    await expect(
      attachTagToConversationForActor(args(new Types.ObjectId(), new Types.ObjectId())),
    ).rejects.toThrow('TAG_NOT_FOUND');

    expect(mocks.addTagToConversation).not.toHaveBeenCalled();
  });

  it('WRITES THE TAG AND THE ACTIVITY ROW IN ONE TRANSACTION', async () => {
    // Half of this pair is worse than neither: a tag with no audit trail, or an audit row
    // claiming a tag that was never applied.
    const { conversation, tag } = setUp();

    await attachTagToConversationForActor(args(conversation._id, tag._id));

    expect(mocks.runInTransaction).toHaveBeenCalledTimes(1);
    expect(mocks.addTagToConversation.mock.calls[0][0].session).toBe(SESSION);
    expect(mocks.createActivity.mock.calls[0][0].session).toBe(SESSION);
  });

  it('records the tag slug and the conversation on the activity row', async () => {
    const { conversation, tag } = setUp();

    await attachTagToConversationForActor(args(conversation._id, tag._id));

    expect(mocks.createActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: ORG,
        whatsappAccountId: ACCOUNT,
        conversationId: conversation._id,
        actorId: ACTOR_ID,
        eventType: 'conversation.tag_added',
        metadata: { tagSlug: 'vip' },
      }),
    );
  });

  it('returns the conversation id and its tag ids as strings', async () => {
    const { conversation, tag } = setUp();

    const result = await attachTagToConversationForActor(args(conversation._id, tag._id));

    expect(result).toEqual({
      conversationId: conversation._id.toString(),
      tags: [tag._id.toString()],
    });
  });

  it('detach removes rather than archives, and logs the removal', async () => {
    const { conversation, tag } = setUp();

    const result = await detachTagFromConversationForActor(args(conversation._id, tag._id));

    expect(mocks.removeTagFromConversation).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: conversation._id, tagId: tag._id }),
    );
    expect(mocks.createActivity.mock.calls[0][0].eventType).toBe('conversation.tag_removed');
    expect(mocks.archiveTag).not.toHaveBeenCalled();
    expect(result.tags).toEqual([]);
  });
});
