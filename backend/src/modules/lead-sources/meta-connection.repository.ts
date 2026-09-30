/**
 * Storage for the one authorised Facebook account per organisation.
 *
 * Mirrors lead-source.repository.ts's split: the plain finders never load the credential, and the
 * one that does says so in its name. Nothing here returns a token to a caller that has not asked
 * for it by name.
 */
import { type Types } from 'mongoose';

import { type ObjectIdLike, toObjectId } from '../../types/common.js';
import {
  encryptMetaAccessTokenForStorage,
  metaAccessTokenLast4,
} from './meta-credentials.service.js';
import {
  META_CONNECTION_STATUSES,
  MetaConnection,
  type MetaConnectionDocument,
  type MetaConnectionStatus,
} from './meta-connection.model.js';
import { type EncryptedField } from '../security/encrypted-field.schema.js';

/** The credential, loaded only where it is named. */
const WITH_SECRETS = '+encryptedUserAccessToken';

export const findMetaConnection = ({ organizationId }: { organizationId?: ObjectIdLike } = {}) =>
  MetaConnection.findOne({ organizationId }).exec();

export const findMetaConnectionWithSecrets = ({
  organizationId,
}: { organizationId?: ObjectIdLike } = {}) =>
  MetaConnection.findOne({ organizationId }).select(WITH_SECRETS).exec();

export interface SaveMetaConnectionParams {
  organizationId: ObjectIdLike;
  metaUserId: string;
  metaUserName?: string | null;
  accessToken: string;
  accessTokenExpiresAt?: Date | null;
  grantedScopes?: readonly string[];
  connectedBy?: ObjectIdLike | null;
}

/**
 * Records a completed authorisation, replacing whatever was there.
 *
 * UPSERT RATHER THAN INSERT, because re-authorising is the normal repair for a revoked or expired
 * token and must not leave two rows behind - "which of these is live" is not a question anyone
 * should have to answer. The unique index on organizationId enforces it even if a second request
 * races this one.
 *
 * Also clears `status` and `lastError`: a fresh authorisation is the thing that fixes
 * needs_attention, so leaving the old error would keep the dashboard warning about a problem that
 * has just been solved.
 */
export const saveMetaConnection = ({
  organizationId,
  metaUserId,
  metaUserName = null,
  accessToken,
  accessTokenExpiresAt = null,
  grantedScopes = [],
  connectedBy = null,
}: SaveMetaConnectionParams) =>
  MetaConnection.findOneAndUpdate(
    { organizationId },
    {
      $set: {
        organizationId: toObjectId(organizationId) as Types.ObjectId,
        metaUserId,
        metaUserName,
        encryptedUserAccessToken: encryptMetaAccessTokenForStorage(
          accessToken,
        ) as EncryptedField | null,
        accessTokenLast4: metaAccessTokenLast4(accessToken),
        accessTokenSetAt: new Date(),
        accessTokenExpiresAt,
        grantedScopes: [...grantedScopes],
        status: META_CONNECTION_STATUSES.ACTIVE,
        lastError: null,
        lastCheckedAt: new Date(),
        connectedBy: connectedBy ? (toObjectId(connectedBy) as Types.ObjectId) : null,
      },
    },
    { upsert: true, returnDocument: 'after', runValidators: true, setDefaultsOnInsert: true },
  ).exec();

export interface MarkMetaConnectionStatusParams {
  organizationId: ObjectIdLike;
  status: MetaConnectionStatus;
  lastError?: string | null;
}

/**
 * Moves a connection to needs_attention (or back), with Meta's own words for why.
 *
 * The point of the state is to STOP retrying. A revoked token produces the same 190 on every
 * poll, and a source that keeps trying turns one lapsed authorisation into hours of identical
 * errors in the log - which buries anything real.
 */
export const markMetaConnectionStatus = ({
  organizationId,
  status,
  lastError = null,
}: MarkMetaConnectionStatusParams) =>
  MetaConnection.findOneAndUpdate(
    { organizationId },
    {
      $set: {
        status,
        // Truncated because Meta's messages can be long and this is shown in the dashboard.
        lastError: lastError ? String(lastError).slice(0, 500) : null,
        lastCheckedAt: new Date(),
      },
    },
    { returnDocument: 'after' },
  ).exec();

/**
 * Disconnects, and destroys the credential rather than merely flagging it.
 *
 * "Disconnect" has to mean the token is gone. Leaving it encrypted-but-present would mean a
 * disconnected integration still holds a working key to the owner's Facebook account, which is
 * not what anybody pressing that button believes they are doing.
 *
 * The row survives so the dashboard can say "disconnected" rather than reverting to a blank
 * never-connected state, and so the audit trail of who connected it is not lost.
 */
export const disconnectMetaConnection = ({ organizationId }: { organizationId: ObjectIdLike }) =>
  MetaConnection.findOneAndUpdate(
    { organizationId },
    {
      $set: {
        status: META_CONNECTION_STATUSES.DISCONNECTED,
        encryptedUserAccessToken: null,
        accessTokenLast4: null,
        accessTokenExpiresAt: null,
        lastError: null,
        lastCheckedAt: new Date(),
      },
    },
    { returnDocument: 'after' },
  ).exec();

/** What the dashboard may see. No token, not even encrypted. */
export const serializeMetaConnection = (
  connection: MetaConnectionDocument | null | undefined,
): Record<string, unknown> | null => {
  if (!connection) {
    return null;
  }

  return {
    id: connection._id?.toString?.() ?? null,
    metaUserId: connection.metaUserId,
    metaUserName: connection.metaUserName ?? null,
    status: connection.status,
    grantedScopes: connection.grantedScopes ?? [],
    // Enough to recognise the credential, useless to replay.
    accessTokenLast4: connection.accessTokenLast4 ?? null,
    accessTokenSetAt: connection.accessTokenSetAt ?? null,
    accessTokenExpiresAt: connection.accessTokenExpiresAt ?? null,
    lastError: connection.lastError ?? null,
    lastCheckedAt: connection.lastCheckedAt ?? null,
    createdAt: connection.createdAt ?? null,
    updatedAt: connection.updatedAt ?? null,
  };
};
