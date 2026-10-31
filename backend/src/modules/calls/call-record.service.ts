import { type HydratedDocument } from 'mongoose';

import { ACTIVITY_EVENTS } from '../../constants/activity-events.js';
import {
  CALL_STATUSES,
  PROCESSING_STATUSES,
  RECORDING_STATUSES,
  type CallStatus,
} from '../../constants/call-statuses.js';
import { type Permission } from '../../constants/permissions.js';
import { type ObjectIdLike } from '../../types/common.js';
import { createActivity } from '../activity/activity-log.repository.js';
import { loadVisibleConversationForActor } from '../conversations/conversation.service.js';
import { type UserDocument } from '../users/user.model.js';
import {
  attachCallRecording,
  createCallRecord,
  findCallRecordById,
  findCallRecordByIdempotencyKey,
  findCallRecordsByConversation,
  updateCallOutcome,
} from './call-record.repository.js';
import { serializeCallRecord } from './call-record.serializer.js';

/**
 * Everything a call record can have done to it, with the authorisation attached.
 *
 * ONE RULE GOVERNS EVERY FUNCTION HERE: a call is reached through its CONVERSATION, and
 * `loadVisibleConversationForActor` decides whether this actor may see that conversation. That
 * is the same gate the thread, its messages, its notes and its reminders already pass through,
 * so a call cannot be more visible than the lead it is about. Nothing in this file invents a
 * second visibility concept.
 */

export interface StartCallForActorParams {
  organizationId: ObjectIdLike;
  conversationId: ObjectIdLike;
  actor: HydratedDocument<UserDocument>;
  permissions: readonly Permission[];
  /** Client-supplied, so a retried POST cannot produce two rows for one tap. */
  idempotencyKey?: string | null;
  now?: Date;
}

/**
 * Records that the dialler was opened for this lead.
 *
 * WHAT THIS DOES NOT CLAIM. It does not say a call happened. Android tells an ordinary app
 * nothing about what follows - see constants/call-statuses.ts - so the row is `initiated`, the
 * outcome is supplied by a human later, and the timeline entry is worded accordingly. Writing
 * `completed` here would be the CRM asserting a customer conversation took place when it may
 * well not have.
 *
 * IDEMPOTENT ON RETRY. A flaky connection on a phone is normal; two taps producing two call
 * rows on a lead's timeline is not. The key is minted by the client per tap, and a second
 * request carrying the same one returns the first row rather than creating another.
 */
export const startCallForActor = async ({
  organizationId,
  conversationId,
  actor,
  permissions,
  idempotencyKey = null,
  now = new Date(),
}: StartCallForActorParams) => {
  const conversation = await loadVisibleConversationForActor({
    organizationId,
    conversationId,
    permissions,
    actorId: actor._id,
  });

  if (idempotencyKey) {
    const existing = await findCallRecordByIdempotencyKey({ organizationId, idempotencyKey });

    if (existing) {
      return serializeCallRecord(existing);
    }
  }

  const call = await createCallRecord({
    organizationId,
    conversationId: conversation._id,
    whatsappAccountId: conversation.whatsappAccountId,
    contactId: conversation.contactId ?? null,
    initiatedBy: actor._id,
    startedAt: now,
    idempotencyKey,
  });

  // Deliberately worded as the dialler opening rather than as a call. The timeline is read by
  // somebody reconstructing what happened with a customer, and "Called" would be a lie here.
  await createActivity({
    organizationId,
    whatsappAccountId: conversation.whatsappAccountId,
    conversationId: conversation._id,
    actorId: actor._id,
    eventType: ACTIVITY_EVENTS.CALL_STARTED,
    summary: 'Dialler opened for this lead.',
    // NO PHONE NUMBER. Activity metadata is read back into the timeline and the AI context;
    // the number belongs to the contact, encrypted, behind its own permission.
    metadata: { callId: String(call._id), direction: call.direction },
  });

  return serializeCallRecord(call);
};

export interface RecordCallOutcomeForActorParams {
  organizationId: ObjectIdLike;
  callId: ObjectIdLike;
  actor: HydratedDocument<UserDocument>;
  permissions: readonly Permission[];
  status: CallStatus;
  durationSeconds?: number | null;
  awaySeconds?: number | null;
}

/** Plain-language timeline lines. One per outcome, so the timeline never says "status: failed". */
const CALL_OUTCOME_SUMMARIES: Record<string, string> = {
  [CALL_STATUSES.COMPLETED]: 'Spoke to the lead by phone.',
  [CALL_STATUSES.FAILED]: 'Called, but the lead did not answer.',
  [CALL_STATUSES.CANCELLED]: 'Dialler opened, but no call was made.',
  [CALL_STATUSES.UNKNOWN]: 'Call outcome not recorded.',
};

/**
 * What the agent says actually happened.
 *
 * THE ONLY SOURCE OF OUTCOME TRUTH in this phase, and it is a human one. `durationSeconds` is
 * their answer, not a measurement; `awaySeconds` is how long the app was backgrounded and is
 * stored separately precisely so the two can never be confused.
 *
 * Re-answerable on purpose. An agent who taps the wrong button, or who is interrupted and
 * answers later, must be able to correct it - this is a note about a conversation, not a
 * financial transaction, and locking it after the first answer would strand a wrong one.
 */
export const recordCallOutcomeForActor = async ({
  organizationId,
  callId,
  actor,
  permissions,
  status,
  durationSeconds = null,
  awaySeconds = null,
}: RecordCallOutcomeForActorParams) => {
  const call = await findCallRecordById({ callId, organizationId });

  if (!call) {
    throw new Error('CALL_NOT_FOUND');
  }

  // The conversation gate, not a check on who placed the call: a manager correcting a
  // colleague's call note is ordinary CRM behaviour, and the same rule already governs
  // completing somebody else's follow-up.
  await loadVisibleConversationForActor({
    organizationId,
    conversationId: call.conversationId,
    permissions,
    actorId: actor._id,
  });

  // An end time only exists for a call somebody says connected, and only when they gave a
  // length. Anything else leaves it null rather than inventing a moment.
  const connected = status === CALL_STATUSES.COMPLETED;
  const endedAt =
    connected && typeof durationSeconds === 'number'
      ? new Date(call.startedAt.getTime() + durationSeconds * 1000)
      : null;

  const updated = await updateCallOutcome({
    callId: call._id,
    organizationId,
    status,
    endedAt,
    durationSeconds: connected ? durationSeconds : null,
    awaySeconds,
  });

  if (call.whatsappAccountId) {
    await createActivity({
      organizationId,
      whatsappAccountId: call.whatsappAccountId,
      conversationId: call.conversationId,
      actorId: actor._id,
      eventType: ACTIVITY_EVENTS.CALL_COMPLETED,
      summary: CALL_OUTCOME_SUMMARIES[status] ?? 'Call outcome recorded.',
      metadata: {
        callId: String(call._id),
        status,
        ...(connected && durationSeconds ? { durationSeconds } : {}),
      },
    });
  }

  return serializeCallRecord(updated);
};

export interface ListConversationCallsForActorParams {
  organizationId: ObjectIdLike;
  conversationId: ObjectIdLike;
  actor: HydratedDocument<UserDocument>;
  permissions: readonly Permission[];
  limit?: number;
  skip?: number;
}

export const listConversationCallsForActor = async ({
  organizationId,
  conversationId,
  actor,
  permissions,
  limit,
  skip,
}: ListConversationCallsForActorParams) => {
  await loadVisibleConversationForActor({
    organizationId,
    conversationId,
    permissions,
    actorId: actor._id,
  });

  const calls = await findCallRecordsByConversation({
    organizationId,
    conversationId,
    limit,
    skip,
  });

  return calls.map((call) => serializeCallRecord(call));
};

export interface GetCallForActorParams {
  organizationId: ObjectIdLike;
  callId: ObjectIdLike;
  actor: HydratedDocument<UserDocument>;
  permissions: readonly Permission[];
}

/**
 * One call, by id.
 *
 * THE CROSS-ORGANISATION TEST LIVES HERE. The lookup is org-scoped, so another studio's call id
 * is simply not found - not "forbidden", which would confirm the id exists. Then the
 * conversation gate runs, so an assignment-restricted agent cannot reach a call on a lead they
 * cannot open either.
 */
export const getCallForActor = async ({
  organizationId,
  callId,
  actor,
  permissions,
}: GetCallForActorParams) => {
  const call = await findCallRecordById({ callId, organizationId });

  if (!call) {
    throw new Error('CALL_NOT_FOUND');
  }

  await loadVisibleConversationForActor({
    organizationId,
    conversationId: call.conversationId,
    permissions,
    actorId: actor._id,
  });

  return call;
};

export interface AttachRecordingForActorParams {
  organizationId: ObjectIdLike;
  callId: ObjectIdLike;
  actor: HydratedDocument<UserDocument>;
  permissions: readonly Permission[];
  objectKey: string;
  mimeType: string;
  sizeBytes: number;
}

/**
 * Points a call at audio that has already been stored.
 *
 * THE UPLOAD IS NOT AUTOMATIC AND IS NOT DISCOVERED. Nothing in Vistaar scans device storage,
 * holds All Files Access, or hunts for an OEM recording folder - a human chooses a file and
 * sends it. That is the whole of the recording story in this phase, and the modular seam the
 * later Storage Access Framework work plugs into.
 *
 * Marks the transcript PENDING rather than running it, so ingestion and processing fail
 * independently: audio that arrived is kept even when no transcription provider is configured.
 */
export const attachRecordingForActor = async ({
  organizationId,
  callId,
  actor,
  permissions,
  objectKey,
  mimeType,
  sizeBytes,
}: AttachRecordingForActorParams) => {
  const call = await getCallForActor({ organizationId, callId, actor, permissions });

  const updated = await attachCallRecording({
    callId: call._id,
    organizationId,
    recordingObjectKey: objectKey,
    recordingMimeType: mimeType,
    recordingSizeBytes: sizeBytes,
    recordingStatus: RECORDING_STATUSES.UPLOADED,
    transcriptionStatus: PROCESSING_STATUSES.PENDING,
  });

  if (call.whatsappAccountId) {
    await createActivity({
      organizationId,
      whatsappAccountId: call.whatsappAccountId,
      conversationId: call.conversationId,
      actorId: actor._id,
      eventType: ACTIVITY_EVENTS.CALL_RECORDING_ATTACHED,
      summary: 'A recording was attached to this call.',
      // Size and type only. Never the key - it names a file on disk - and never anything the
      // audio contains.
      metadata: { callId: String(call._id), sizeBytes, mimeType },
    });
  }

  return serializeCallRecord(updated);
};
