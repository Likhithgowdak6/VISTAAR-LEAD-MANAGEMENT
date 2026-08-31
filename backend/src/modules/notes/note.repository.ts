import { type QueryFilter } from 'mongoose';

import { NOTE_VISIBILITY, type NoteVisibility } from '../../constants/note-visibility.js';
import { ROLES, type Role } from '../../constants/roles.js';
import { type DatabaseSession } from '../../config/database.js';
import { type ObjectIdLike, type PaginationParams, toObjectId } from '../../types/common.js';
import { Note, type NoteDocument } from './note.model.js';

export const getAllowedNoteVisibilityForRole = (role: Role): NoteVisibility[] => {
  if (role === ROLES.STAFF) {
    return [NOTE_VISIBILITY.SHARED];
  }

  if (role === ROLES.MANAGER) {
    return [NOTE_VISIBILITY.SHARED, NOTE_VISIBILITY.MANAGER];
  }

  return [NOTE_VISIBILITY.SHARED, NOTE_VISIBILITY.MANAGER, NOTE_VISIBILITY.ADMIN];
};

export interface CreateNoteParams {
  organizationId: ObjectIdLike;
  whatsappAccountId: ObjectIdLike;
  conversationId: ObjectIdLike;
  body: string;
  visibility: NoteVisibility;
  createdBy: ObjectIdLike;
  session?: DatabaseSession;
}

export const createNote = ({
  organizationId,
  whatsappAccountId,
  conversationId,
  body,
  visibility,
  createdBy,
  session,
}: CreateNoteParams) =>
  Note.create(
    [
      {
        organizationId: toObjectId(organizationId),
        whatsappAccountId: toObjectId(whatsappAccountId),
        conversationId: toObjectId(conversationId),
        body,
        visibility,
        createdBy: toObjectId(createdBy),
      },
    ],
    { session },
  ).then(([note]) => note!);

export interface FindNoteByIdParams {
  noteId?: ObjectIdLike;
  organizationId?: ObjectIdLike;
}

export const findNoteById = ({ noteId, organizationId }: FindNoteByIdParams = {}) =>
  Note.findOne({
    _id: noteId,
    organizationId,
  }).exec();

export interface FindNotesForConversationByVisibilityParams extends PaginationParams {
  organizationId?: ObjectIdLike;
  conversationId?: ObjectIdLike;
  role?: Role;
  includeDeleted?: boolean;
}

export const findNotesForConversationByVisibility = ({
  organizationId,
  conversationId,
  role,
  includeDeleted = false,
  limit = 50,
  skip = 0,
}: FindNotesForConversationByVisibilityParams = {}) => {
  const filter: QueryFilter<NoteDocument> = {
    organizationId,
    conversationId,
    visibility: {
      $in: getAllowedNoteVisibilityForRole(role as Role),
    },
  };

  if (!includeDeleted) {
    filter.deletedAt = null;
  }

  return Note.find(filter)
    .sort({
      createdAt: -1,
    })
    .skip(skip)
    .limit(limit)
    .exec();
};

export interface SoftDeleteNoteParams {
  noteId?: ObjectIdLike;
  organizationId?: ObjectIdLike;
  actorId?: ObjectIdLike;
  now?: Date;
}

export const softDeleteNote = ({
  noteId,
  organizationId,
  actorId,
  now = new Date(),
}: SoftDeleteNoteParams = {}) =>
  Note.findOneAndUpdate(
    {
      _id: noteId,
      organizationId,
    },
    {
      $set: {
        deletedAt: now,
        updatedBy: actorId,
      },
    },
    {
      returnDocument: 'after',
      runValidators: true,
    },
  ).exec();
