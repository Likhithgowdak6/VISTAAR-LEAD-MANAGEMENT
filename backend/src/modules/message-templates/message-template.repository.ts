import { type ObjectIdLike, toObjectId } from '../../types/common.js';
import {
  MessageTemplate,
  type MessageTemplateKind,
} from './message-template.model.js';

export interface CreateMessageTemplateParams {
  organizationId: ObjectIdLike;
  title: string;
  body: string;
  kind?: MessageTemplateKind;
  sourceDetails?: string;
  createdBy?: ObjectIdLike | null;
}

export const createMessageTemplate = ({
  organizationId,
  title,
  body,
  kind,
  sourceDetails = '',
  createdBy = null,
}: CreateMessageTemplateParams) =>
  MessageTemplate.create({
    organizationId: toObjectId(organizationId),
    title,
    body,
    kind,
    sourceDetails,
    createdBy: createdBy ? toObjectId(createdBy) : null,
  });

export interface FindMessageTemplatesParams {
  organizationId?: ObjectIdLike;
  kind?: MessageTemplateKind;
  limit?: number;
}

export const findMessageTemplates = ({
  organizationId,
  kind,
  limit = 100,
}: FindMessageTemplatesParams = {}) =>
  MessageTemplate.find({
    organizationId,
    ...(kind ? { kind } : {}),
  })
    .sort({
      createdAt: -1,
    })
    .limit(limit)
    .exec();

export interface FindMessageTemplateByIdParams {
  templateId?: ObjectIdLike;
  organizationId?: ObjectIdLike;
}

export const findMessageTemplateById = ({
  templateId,
  organizationId,
}: FindMessageTemplateByIdParams = {}) =>
  MessageTemplate.findOne({
    _id: templateId,
    organizationId,
  }).exec();

export interface DeleteMessageTemplateParams {
  templateId?: ObjectIdLike;
  organizationId?: ObjectIdLike;
}

/** Scoped to the organization, so an id from elsewhere matches nothing. */
export const deleteMessageTemplate = ({
  templateId,
  organizationId,
}: DeleteMessageTemplateParams = {}) =>
  MessageTemplate.findOneAndDelete({
    _id: templateId,
    organizationId,
  }).exec();
