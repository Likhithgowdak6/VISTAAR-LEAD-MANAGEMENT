import { type HydratedDocument } from 'mongoose';

import { ACTIVITY_EVENTS } from '../../constants/activity-events.js';
import { type NoteVisibility } from '../../constants/note-visibility.js';
import { PERMISSIONS, type Permission } from '../../constants/permissions.js';
import { runInTransaction } from '../../config/database.js';
import { type ObjectIdLike } from '../../types/common.js';
import { createActivity } from '../activity/activity-log.repository.js';
import { loadVisibleConversationForActor } from '../conversations/conversation.service.js';
import { type UserDocument } from '../users/user.model.js';
import {
  createNote,
  findNoteById,
  findNotesForConversationByVisibility,
  getAllowedNoteVisibilityForRole,
  softDeleteNote,
} from './note.repository.js';
import { serializeNote } from './note.serializer.js';

export interface ListNotesForActorParams {
  organizationId: ObjectIdLike;
  conversationId: ObjectIdLike;
  actor: HydratedDocument<UserDocument>;
  permissions: readonly Permission[];
  limit?: number;
  skip?: number;
}

export const listNotesForActor = async ({
  organizationId,
  conversationId,
  actor,
  permissions,
  limit,
  skip,
}: ListNotesForActorParams) => {
  await loadVisibleConversationForActor({
    organizationId,
    conversationId,
    permissions,
    actorId: actor._id,
  });

  const notes = await findNotesForConversationByVisibility({
    organizationId,
    conversationId,
    role: actor.role,
    limit,
    skip,
  });

  return notes.map((note) => serializeNote(note));
};

export interface CreateNoteForActorParams {
  organizationId: ObjectIdLike;
  conversationId: ObjectIdLike;
  actor: HydratedDocument<UserDocument>;
  permissions: readonly Permission[];
  body: string;
  visibility: NoteVisibility;
}

export const createNoteForActor = async ({
  organizationId,
  conversationId,
  actor,
  permissions,
  body,
  visibility,
}: CreateNoteForActorParams) => {
  const conversation = await loadVisibleConversationForActor({
    organizationId,
    conversationId,
    permissions,
    actorId: actor._id,
  });

  if (!getAllowedNoteVisibilityForRole(actor.role).includes(visibility)) {
    throw new Error('NOTE_VISIBILITY_FORBIDDEN');
  }

  const note = await runInTransaction(async (session) => {
    const note = await createNote({
      organizationId,
      whatsappAccountId: conversation.whatsappAccountId,
      conversationId: conversation._id,
      body,
      visibility,
      createdBy: actor._id,
      session,
    });

    await createActivity({
      organizationId,
      whatsappAccountId: conversation.whatsappAccountId,
      conversationId: conversation._id,
      actorId: actor._id,
      eventType: ACTIVITY_EVENTS.NOTE_CREATED,
      summary: 'Note added to the conversation.',
      metadata: {
        visibility,
      },
      session,
    });

    return note;
  });

  return serializeNote(note);
};

export interface DeleteNoteForActorParams {
  organizationId: ObjectIdLike;
  conversationId: ObjectIdLike;
  noteId: ObjectIdLike;
  actor: HydratedDocument<UserDocument>;
  permissions: readonly Permission[];
}

export const deleteNoteForActor = async ({
  organizationId,
  conversationId,
  noteId,
  actor,
  permissions,
}: DeleteNoteForActorParams) => {
  await loadVisibleConversationForActor({
    organizationId,
    conversationId,
    permissions,
    actorId: actor._id,
  });

  const note = await findNoteById({
    noteId,
    organizationId,
  });

  if (!note || note.conversationId.toString() !== conversationId.toString() || note.deletedAt) {
    throw new Error('NOTE_NOT_FOUND');
  }

  const isCreator = note.createdBy.toString() === actor._id.toString();
  const canManageAll = permissions.includes(PERMISSIONS.CONVERSATIONS_READ_ALL);

  if (!isCreator && !canManageAll) {
    throw new Error('NOTE_DELETE_FORBIDDEN');
  }

  const deleted = await softDeleteNote({
    noteId: note._id,
    organizationId,
    actorId: actor._id,
  });

  return serializeNote(deleted);
};
