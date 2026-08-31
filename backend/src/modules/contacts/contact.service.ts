import { AUDIT_EVENTS } from '../../constants/audit-events.js';
import { type ObjectIdLike } from '../../types/common.js';
import { createAuditLog } from '../audit/audit.repository.js';
import { findContactById, findContactPrivatePiiForInternalUse } from './contact.repository.js';
import { serializeContact } from './contact.serializer.js';

export interface GetContactForActorParams {
  organizationId: ObjectIdLike;
  contactId: ObjectIdLike;
}

export const getContactForActor = async ({
  organizationId,
  contactId,
}: GetContactForActorParams) => {
  const contact = await findContactById({
    contactId,
    organizationId,
  });

  if (!contact) {
    throw new Error('CONTACT_NOT_FOUND');
  }

  return serializeContact(contact);
};

export interface RevealContactPhoneRequestContext {
  requestId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}

export interface RevealContactPhoneForActorParams {
  organizationId: ObjectIdLike;
  contactId: ObjectIdLike;
  actor: Express.AuthContext['user'];
  session?: Express.AuthContext['session'] | null;
  requestContext?: RevealContactPhoneRequestContext;
}

/**
 * Returns the decrypted phone for a contact. This is the only path by which a phone
 * number leaves the backend; callers must already be authorized with CLIENT_PII_REVEAL.
 * Every reveal is recorded in the audit log (without the phone itself).
 */
export const revealContactPhoneForActor = async ({
  organizationId,
  contactId,
  actor,
  session,
  requestContext = {},
}: RevealContactPhoneForActorParams) => {
  const contact = await findContactById({
    contactId,
    organizationId,
  });

  if (!contact) {
    throw new Error('CONTACT_NOT_FOUND');
  }

  const privatePii = await findContactPrivatePiiForInternalUse({
    contactId: contact._id,
    organizationId,
  });

  await createAuditLog({
    organizationId,
    eventType: AUDIT_EVENTS.CLIENT_PII_REVEALED,
    actorId: actor._id,
    sessionId: session?._id ?? null,
    requestId: requestContext.requestId ?? null,
    ipAddress: requestContext.ipAddress ?? null,
    userAgent: requestContext.userAgent ?? null,
    metadata: {
      contactId: contact._id.toString(),
      leadId: contact.leadId,
      field: 'phone',
    },
  });

  return {
    contactId: contact._id.toString(),
    leadId: contact.leadId,
    phone: privatePii?.phone ?? null,
  };
};
