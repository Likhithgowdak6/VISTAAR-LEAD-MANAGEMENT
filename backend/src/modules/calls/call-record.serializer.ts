import { serializeDate, serializeId, toPlainObject } from '../../utils/serialization.js';

/**
 * A call as the client sees it.
 *
 * TWO THINGS ARE DELIBERATELY ABSENT.
 *
 * The PHONE NUMBER, because it is not on the row in the first place - the contact holds it,
 * encrypted, and revealing it is its own permissioned action. A call list is exactly the wrong
 * place to hand numbers out in bulk.
 *
 * The RECORDING OBJECT KEY, because it names a file on the server's disk. The client never
 * needs it: audio is fetched from an authenticated route by CALL id, and the server resolves
 * the key itself. Sending it out would turn an internal path into something a client can hold,
 * repeat and leak, for no capability it does not already have.
 */
export interface SerializedCallRecord {
  id: string | null;
  organizationId: string | null;
  conversationId: string | null;
  contactId: string | null;
  initiatedBy: string | null;
  direction: unknown;
  status: unknown;
  startedAt: string | null;
  endedAt: string | null;
  durationSeconds: number | null;
  recordingStatus: unknown;
  /** Whether audio exists, WITHOUT saying where. Drives playback and nothing else. */
  hasRecording: boolean;
  recordingMimeType: unknown;
  recordingDurationSeconds: number | null;
  transcriptionStatus: unknown;
  summaryStatus: unknown;
  createdAt: string | null;
  updatedAt: string | null;
}

const asNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

export const serializeCallRecord = (call: unknown): SerializedCallRecord | null => {
  const value = toPlainObject(call);

  if (!value) {
    return null;
  }

  return {
    id: serializeId(value._id),
    organizationId: serializeId(value.organizationId),
    conversationId: serializeId(value.conversationId),
    contactId: serializeId(value.contactId),
    initiatedBy: serializeId(value.initiatedBy),
    direction: value.direction,
    status: value.status,
    startedAt: serializeDate(value.startedAt),
    endedAt: serializeDate(value.endedAt),
    durationSeconds: asNumber(value.durationSeconds),
    recordingStatus: value.recordingStatus,
    hasRecording: typeof value.recordingObjectKey === 'string' && value.recordingObjectKey !== '',
    recordingMimeType: value.recordingMimeType ?? null,
    recordingDurationSeconds: asNumber(value.recordingDurationSeconds),
    transcriptionStatus: value.transcriptionStatus,
    summaryStatus: value.summaryStatus,
    createdAt: serializeDate(value.createdAt),
    updatedAt: serializeDate(value.updatedAt),
  };
};
