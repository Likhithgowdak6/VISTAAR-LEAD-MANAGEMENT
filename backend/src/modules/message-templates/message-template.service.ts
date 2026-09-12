/**
 * Saved messages the owner has approved for sending, and the AI pass that writes them.
 *
 * Generating and saving are deliberately separate calls. Four versions arrive, three are thrown
 * away, and only the one he picked is stored - so the AI never writes to this collection, and
 * nothing the whole team can send to customers gets there without someone choosing it.
 */
import { type HydratedDocument } from 'mongoose';

import { type ObjectIdLike } from '../../types/common.js';
import { type UserDocument } from '../users/user.model.js';
import { generatePriceTemplates } from '../ai-brain/ai-brain.client.js';
import { type MessageTemplateKind } from './message-template.model.js';
import {
  createMessageTemplate,
  deleteMessageTemplate,
  findMessageTemplateById,
  findMessageTemplates,
} from './message-template.repository.js';
import {
  serializeMessageTemplate,
  type SerializedMessageTemplate,
} from './message-template.serializer.js';

export interface GeneratedTemplate {
  title: string;
  body: string;
}

export interface GenerateTemplateOptionsParams {
  rawDetails: string;
  rejected?: readonly string[];
}

export const generateTemplateOptions = async ({
  rawDetails,
  rejected,
}: GenerateTemplateOptionsParams): Promise<GeneratedTemplate[]> => {
  const result = await generatePriceTemplates({ rawDetails, rejected });

  // Coerced rather than trusted: these render straight into a picker the owner clicks, so a
  // missing title must become a usable label, not `undefined` on screen.
  return (result?.templates ?? [])
    .map((template, index) => ({
      title: (template?.title ?? '').trim() || `Version ${index + 1}`,
      body: (template?.body ?? '').trim(),
    }))
    .filter((template) => template.body !== '');
};

export interface ListTemplatesParams {
  organizationId: ObjectIdLike;
  kind?: MessageTemplateKind;
}

export const listTemplatesForOrganization = async ({
  organizationId,
  kind,
}: ListTemplatesParams): Promise<(SerializedMessageTemplate | null)[]> => {
  const templates = await findMessageTemplates({ organizationId, kind });

  return templates.map((template) => serializeMessageTemplate(template));
};

export interface SaveTemplateParams {
  organizationId: ObjectIdLike;
  actor: Pick<UserDocument, '_id'> | HydratedDocument<UserDocument>;
  title: string;
  body: string;
  kind?: MessageTemplateKind;
  sourceDetails?: string;
}

export const saveTemplateForActor = async ({
  organizationId,
  actor,
  title,
  body,
  kind,
  sourceDetails,
}: SaveTemplateParams): Promise<SerializedMessageTemplate | null> => {
  const template = await createMessageTemplate({
    organizationId,
    title,
    body,
    kind,
    sourceDetails,
    createdBy: actor._id,
  });

  return serializeMessageTemplate(template);
};

export interface DeleteTemplateParams {
  organizationId: ObjectIdLike;
  templateId: ObjectIdLike;
}

export const deleteTemplateForActor = async ({
  organizationId,
  templateId,
}: DeleteTemplateParams): Promise<SerializedMessageTemplate | null> => {
  // Read first so a wrong id is a 404 rather than a silent success, matching the knowledge module.
  const existing = await findMessageTemplateById({ templateId, organizationId });

  if (!existing) {
    throw new Error('MESSAGE_TEMPLATE_NOT_FOUND');
  }

  const removed = await deleteMessageTemplate({ templateId: existing._id, organizationId });

  return serializeMessageTemplate(removed ?? existing);
};
