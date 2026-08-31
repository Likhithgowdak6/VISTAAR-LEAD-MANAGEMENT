import { type ObjectIdLike } from '../../types/common.js';
import { IDEMPOTENCY_STATUSES } from '../../constants/idempotency-statuses.js';
import { IdempotencyRecord, type IdempotencyRecordDocument } from './idempotency-record.model.js';

const BLOCKED_REQUEST_HASH_VALUE_PARTS = [
  'password',
  'token',
  'cookie',
  'secret',
  'authorization',
  'bearer',
];

export type CreateInProgressRecordData = Partial<IdempotencyRecordDocument> & {
  requestHash: string;
};

export interface FindIdempotencyByKeyParams {
  organizationId?: ObjectIdLike;
  scope?: string;
  key?: string;
}

export interface MarkIdempotencyResultParams {
  recordId?: ObjectIdLike;
  organizationId?: ObjectIdLike;
  responseStatus?: number | null;
  responseBody?: unknown;
}

const assertSafeRequestHash = (requestHash: unknown): void => {
  const normalizedRequestHash = String(requestHash ?? '').toLowerCase();

  if (
    BLOCKED_REQUEST_HASH_VALUE_PARTS.some((blockedPart) =>
      normalizedRequestHash.includes(blockedPart),
    )
  ) {
    throw new Error('IDEMPOTENCY_REQUEST_HASH_CONTAINS_SENSITIVE_VALUE');
  }
};

export const createInProgressRecord = (recordData: CreateInProgressRecordData) => {
  assertSafeRequestHash(recordData.requestHash);

  return IdempotencyRecord.create({
    ...recordData,
    status: IDEMPOTENCY_STATUSES.IN_PROGRESS,
  });
};

export const findByKey = ({ organizationId, scope, key }: FindIdempotencyByKeyParams = {}) =>
  IdempotencyRecord.findOne({
    organizationId,
    scope,
    key,
  }).exec();

export const markCompleted = ({
  recordId,
  organizationId,
  responseStatus,
  responseBody,
}: MarkIdempotencyResultParams = {}) =>
  IdempotencyRecord.findOneAndUpdate(
    {
      _id: recordId,
      organizationId,
    },
    {
      $set: {
        status: IDEMPOTENCY_STATUSES.COMPLETED,
        responseStatus,
        responseBody,
        lockedUntil: null,
      },
    },
    {
      returnDocument: 'after',
      runValidators: true,
    },
  ).exec();

export const markFailed = ({
  recordId,
  organizationId,
  responseStatus,
  responseBody,
}: MarkIdempotencyResultParams = {}) =>
  IdempotencyRecord.findOneAndUpdate(
    {
      _id: recordId,
      organizationId,
    },
    {
      $set: {
        status: IDEMPOTENCY_STATUSES.FAILED,
        responseStatus,
        responseBody,
        lockedUntil: null,
      },
    },
    {
      returnDocument: 'after',
      runValidators: true,
    },
  ).exec();
