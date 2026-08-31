import { serializeDate, serializeId, toPlainObject } from '../../utils/serialization.js';

export interface SerializedStage {
  id: string | null;
  organizationId: string | null;
  key: unknown;
  label: unknown;
  color: unknown;
  status: unknown;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export const serializeStage = (stage: unknown): SerializedStage | null => {
  const value = toPlainObject(stage);

  if (!value) {
    return null;
  }

  return {
    id: serializeId(value._id),
    organizationId: serializeId(value.organizationId),
    key: value.key,
    label: value.label,
    color: value.color,
    status: value.status,
    createdBy: serializeId(value.createdBy),
    updatedBy: serializeId(value.updatedBy),
    createdAt: serializeDate(value.createdAt),
    updatedAt: serializeDate(value.updatedAt),
  };
};
