import { Router } from 'express';

import {
  authenticateRequest,
  requireConversationsRead,
  requirePasswordChanged,
} from '../../middleware/auth.middleware.js';

import {
  getAiPerformance,
  getAttentionCsv,
  getAttentionList,
  getBreakdowns,
  getOverview,
  getReminders,
  getTrends,
} from './analytics.controller.js';

// Mounted at /api/v1/analytics
const analyticsRouter = Router();

analyticsRouter.use(authenticateRequest);
analyticsRouter.use(requirePasswordChanged);

/**
 * Gated on the same permission as reading the inbox, and nothing stricter.
 *
 * Every number on this page is a count of conversations the caller can already open one at a
 * time, and the service narrows each query to exactly the set their inbox shows - so a staff
 * user's dashboard totals their own threads, not the organization's. A separate "analytics"
 * permission would be a second thing to keep in step with that narrowing, and the first time it
 * drifted somebody would be reading counts of chats they cannot see.
 *
 * The CSV route is registered before nothing else that could shadow it, and carries the same
 * guard: an export is a read. The extra obligation it has - a phone column only for a caller
 * holding CLIENT_PII_REVEAL, and an audit entry when one is actually decrypted - lives in the
 * service, because it depends on the rows rather than on the route.
 */
analyticsRouter.get('/overview', requireConversationsRead, getOverview);
analyticsRouter.get('/trends', requireConversationsRead, getTrends);
analyticsRouter.get('/ai-performance', requireConversationsRead, getAiPerformance);
analyticsRouter.get('/breakdowns', requireConversationsRead, getBreakdowns);
/**
 * Reminders carry the same guard, and that is the right one rather than a reminder-specific
 * permission. Every row is either a task on a conversation the caller can already open or one
 * of their own personal reminders, and the service narrows to exactly that set - so gating it
 * differently from the inbox would let the two drift into disagreeing about what is visible.
 */
analyticsRouter.get('/reminders', requireConversationsRead, getReminders);
analyticsRouter.get('/attention', requireConversationsRead, getAttentionList);
analyticsRouter.get('/attention.csv', requireConversationsRead, getAttentionCsv);

export default analyticsRouter;
