import { type HydratedDocument } from 'mongoose';

import { type Permission } from '../constants/permissions.js';
import { type RefreshSessionDocument } from '../modules/auth/refresh-session.model.js';
import { type AccessTokenClaims } from '../modules/auth/token.service.js';
import { type OrganizationDocument } from '../modules/organizations/organization.model.js';
import { type UserDocument } from '../modules/users/user.model.js';

declare global {
  namespace Express {
    /** Set by `requestContextMiddleware` on every request, before routing. */
    interface RequestContext {
      requestId: string;
      ipAddress: string | null;
      userAgent: string | null;
    }

    /** Set by `authenticateRequest`; absent on unauthenticated routes. */
    interface AuthContext {
      token: AccessTokenClaims;
      user: HydratedDocument<UserDocument>;
      organization: HydratedDocument<OrganizationDocument>;
      session: HydratedDocument<RefreshSessionDocument>;
      permissions: Permission[];
    }

    interface Request {
      context?: RequestContext;
      auth?: AuthContext;
    }
  }
}

export {};
