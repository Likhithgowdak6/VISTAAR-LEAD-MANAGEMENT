import { type HydratedDocument } from 'mongoose';

import { ACTIVITY_EVENTS } from '../../constants/activity-events.js';
import { type TagStatus } from '../../constants/tag-statuses.js';
import { type ObjectIdLike } from '../../types/common.js';
import { type Permission } from '../../constants/permissions.js';
import { runInTransaction } from '../../config/database.js';
import { createActivity } from '../activity/activity-log.repository.js';
import {
  addTagToConversation,
  removeTagFromConversation,
} from '../conversations/conversation.repository.js';
import { loadVisibleConversationForActor } from '../conversations/conversation.service.js';
import { type UserDocument } from '../users/user.model.js';
import {
  archiveTag,
  createTag,
  findTagById,
  findTagBySlugInScope,
  findTagsByOrganization,
  normalizeTagSlug,
} from './tag.repository.js';
import { serializeTag } from './tag.serializer.js';

export interface ListTagsForOrganizationParams {
  organizationId: ObjectIdLike;
  whatsappAccountId?: ObjectIdLike;
  status?: TagStatus;
  limit?: number;
  skip?: number;
}

export const listTagsForOrganization = async ({
  organizationId,
  whatsappAccountId,
  status,
  limit,
  skip,
}: ListTagsForOrganizationParams) => {
  const tags = await findTagsByOrganization({
    organizationId,
    whatsappAccountId,
    status,
    limit,
    skip,
  });

  return tags.map((tag) => serializeTag(tag));
};

export interface CreateTagForActorParams {
  organizationId: ObjectIdLike;
  actor: HydratedDocument<UserDocument>;
  name: string;
  slug?: string;
  color?: string;
  description?: string;
  whatsappAccountId?: ObjectIdLike;
}

export const createTagForActor = async ({
  organizationId,
  actor,
  name,
  slug,
  color,
  description,
  whatsappAccountId,
}: CreateTagForActorParams) => {
  const resolvedSlug = normalizeTagSlug(slug ?? name);

  const existing = await findTagBySlugInScope({
    organizationId,
    whatsappAccountId: whatsappAccountId ?? null,
    slug: resolvedSlug,
  });

  if (existing) {
    throw new Error('TAG_SLUG_EXISTS');
  }

  const tag = await createTag({
    organizationId,
    whatsappAccountId: whatsappAccountId ?? null,
    name,
    slug: resolvedSlug,
    color,
    description,
    createdBy: actor._id,
  });

  return serializeTag(tag);
};

export interface ArchiveTagForActorParams {
  organizationId: ObjectIdLike;
  tagId: ObjectIdLike;
  actor: HydratedDocument<UserDocument>;
}

export const archiveTagForActor = async ({
  organizationId,
  tagId,
  actor,
}: ArchiveTagForActorParams) => {
  const tag = await findTagById({
    tagId,
    organizationId,
  });

  if (!tag) {
    throw new Error('TAG_NOT_FOUND');
  }

  const archived = await archiveTag({
    tagId: tag._id,
    organizationId,
    actorId: actor._id,
  });

  return serializeTag(archived);
};

export interface LoadConversationAndTagParams {
  organizationId: ObjectIdLike;
  conversationId: ObjectIdLike;
  tagId: ObjectIdLike;
  actor: HydratedDocument<UserDocument>;
  permissions: readonly Permission[];
}

const loadConversationAndTag = async ({
  organizationId,
  conversationId,
  tagId,
  actor,
  permissions,
}: LoadConversationAndTagParams) => {
  const conversation = await loadVisibleConversationForActor({
    organizationId,
    conversationId,
    permissions,
    actorId: actor._id,
  });

  const tag = await findTagById({
    tagId,
    organizationId,
  });

  if (!tag) {
    throw new Error('TAG_NOT_FOUND');
  }

  return { conversation, tag };
};

export interface AttachTagToConversationForActorParams {
  organizationId: ObjectIdLike;
  conversationId: ObjectIdLike;
  tagId: ObjectIdLike;
  actor: HydratedDocument<UserDocument>;
  permissions: readonly Permission[];
}

export const attachTagToConversationForActor = async ({
  organizationId,
  conversationId,
  tagId,
  actor,
  permissions,
}: AttachTagToConversationForActorParams) => {
  const { conversation, tag } = await loadConversationAndTag({
    organizationId,
    conversationId,
    tagId,
    actor,
    permissions,
  });

  const updated = await runInTransaction(async (session) => {
    const updated = await addTagToConversation({
      conversationId: conversation._id,
      organizationId,
      tagId: tag._id,
      session,
    });

    await createActivity({
      organizationId,
      whatsappAccountId: conversation.whatsappAccountId,
      conversationId: conversation._id,
      actorId: actor._id,
      eventType: ACTIVITY_EVENTS.CONVERSATION_TAG_ADDED,
      summary: 'Tag added to the conversation.',
      metadata: {
        tagSlug: tag.slug,
      },
      session,
    });

    return updated;
  });

  return {
    conversationId: updated!._id.toString(),
    tags: updated!.tags.map((id) => id.toString()),
  };
};

export interface DetachTagFromConversationForActorParams {
  organizationId: ObjectIdLike;
  conversationId: ObjectIdLike;
  tagId: ObjectIdLike;
  actor: HydratedDocument<UserDocument>;
  permissions: readonly Permission[];
}

export const detachTagFromConversationForActor = async ({
  organizationId,
  conversationId,
  tagId,
  actor,
  permissions,
}: DetachTagFromConversationForActorParams) => {
  const { conversation, tag } = await loadConversationAndTag({
    organizationId,
    conversationId,
    tagId,
    actor,
    permissions,
  });

  const updated = await runInTransaction(async (session) => {
    const updated = await removeTagFromConversation({
      conversationId: conversation._id,
      organizationId,
      tagId: tag._id,
      session,
    });

    await createActivity({
      organizationId,
      whatsappAccountId: conversation.whatsappAccountId,
      conversationId: conversation._id,
      actorId: actor._id,
      eventType: ACTIVITY_EVENTS.CONVERSATION_TAG_REMOVED,
      summary: 'Tag removed from the conversation.',
      metadata: {
        tagSlug: tag.slug,
      },
      session,
    });

    return updated;
  });

  return {
    conversationId: updated!._id.toString(),
    tags: updated!.tags.map((id) => id.toString()),
  };
};
