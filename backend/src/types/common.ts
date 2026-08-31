import { Types } from 'mongoose';

/**
 * Anything Mongoose accepts where an `_id` is expected. Repositories take this rather than a
 * bare `Types.ObjectId` because ids arrive from route params and JWT claims as strings.
 */
export type ObjectIdLike = Types.ObjectId | string;

export const toObjectId = (value: ObjectIdLike): Types.ObjectId =>
  typeof value === 'string' ? new Types.ObjectId(value) : value;

/** A JSON-ish value, for metadata bags persisted as `Schema.Types.Mixed`. */
export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** Standard cursor-less pagination accepted by the list repositories. */
export interface PaginationParams {
  limit?: number;
  skip?: number;
}
