import { serializeDate, serializeId, toPlainObject } from '../../utils/serialization.js';

export interface SerializedMessageTemplate {
  id: string | null;
  title: unknown;
  body: unknown;
  kind: unknown;
  sourceDetails: unknown;
  createdBy: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export const serializeMessageTemplate = (
  template: unknown,
): SerializedMessageTemplate | null => {
  const value = toPlainObject(template);

  if (!value) {
    return null;
  }

  return {
    id: serializeId(value._id),
    title: value.title,
    body: value.body,
    kind: value.kind,
    sourceDetails: value.sourceDetails ?? '',
    createdBy: serializeId(value.createdBy),
    createdAt: serializeDate(value.createdAt),
    updatedAt: serializeDate(value.updatedAt),
  };
};
