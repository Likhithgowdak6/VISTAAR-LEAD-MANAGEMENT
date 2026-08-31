/**
 * A dedicated, non-login "AI Assistant" user per organization, used as the `actor` when
 * ai-brain-service sends a qualifying question on its own. Every other part of the system -
 * activity log entries, "sent by", message ownership - already expects a real User document,
 * so this gives the AI one instead of teaching every one of those call sites about a special
 * case. It shows up in the UI exactly like a team member would, labelled "AI Assistant".
 */
import { randomBytes } from 'node:crypto';

import { ACCOUNT_ACCESS_MODES } from '../../constants/account-access-modes.js';
import { ROLES } from '../../constants/roles.js';
import { USER_STATUSES } from '../../constants/user-statuses.js';
import { type ObjectIdLike } from '../../types/common.js';
import { hashPassword } from '../auth/password.service.js';
import { findUserByEmailInOrganization, createUser } from '../users/user.repository.js';
import { type UserDocument } from '../users/user.model.js';

const AI_SYSTEM_USER_EMAIL = 'ai-assistant@internal.local';

export const getOrCreateAiSystemUser = async ({
  organizationId,
}: {
  organizationId: ObjectIdLike;
}): Promise<UserDocument> => {
  const existing = await findUserByEmailInOrganization({
    organizationId,
    email: AI_SYSTEM_USER_EMAIL,
  });

  if (existing) {
    return existing;
  }

  // Never logged into - the hash just has to be valid and unguessable.
  const passwordHash = await hashPassword(randomBytes(24).toString('hex'));

  return createUser({
    organizationId,
    name: 'AI Assistant',
    email: AI_SYSTEM_USER_EMAIL,
    passwordHash,
    role: ROLES.STAFF,
    accountAccessMode: ACCOUNT_ACCESS_MODES.ALL,
    status: USER_STATUSES.ACTIVE,
    mustChangePassword: false,
  });
};
