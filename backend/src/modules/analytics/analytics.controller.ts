/**
 * HTTP for the analytics endpoints. Thin on purpose: parse, hand the auth context to the
 * service, serialise. Every decision worth testing lives one layer down.
 *
 * THE ONE THING THIS LAYER OWNS is the organization and actor identity. `auth.organization._id`
 * and `auth.user._id` come from the verified token and are never read off the query string, so
 * no `?organizationId=` can be smuggled in; the permission array travels with them so the
 * service can work out whether this caller counts their own threads or the whole organization's.
 */
import { requireAuthContext } from '../../middleware/auth.middleware.js';
import { asyncHandler } from '../../utils/async-handler.js';
import { parseWithSchema } from '../../utils/parse-with-schema.js';
import {
  type AnalyticsActorContext,
  getAnalyticsAiPerformance,
  getAnalyticsAttentionCsv,
  getAnalyticsAttentionList,
  getAnalyticsBreakdowns,
  getAnalyticsOverview,
  getAnalyticsReminders,
  getAnalyticsTrends,
} from './analytics.service.js';
import {
  analyticsFiltersQuerySchema,
  attentionCsvQuerySchema,
  attentionQuerySchema,
  remindersQuerySchema,
} from './analytics.validation.js';
import { type Request } from 'express';

const actorContextFrom = (req: Request): AnalyticsActorContext => {
  const auth = requireAuthContext(req);

  return {
    organizationId: auth.organization._id,
    actorId: auth.user._id,
    permissions: auth.permissions,
    sessionId: auth.session?._id ?? null,
    requestId: req.context?.requestId ?? null,
    ipAddress: req.context?.ipAddress ?? null,
    userAgent: req.context?.userAgent ?? null,
  };
};

const parseFilters = (req: Request) =>
  parseWithSchema({ schema: analyticsFiltersQuerySchema, value: req.query, source: 'Query' });

export const getOverview = asyncHandler(async (req, res) => {
  const data = await getAnalyticsOverview({
    actor: actorContextFrom(req),
    filters: parseFilters(req),
  });

  res.status(200).json({ data });
});

export const getTrends = asyncHandler(async (req, res) => {
  const data = await getAnalyticsTrends({
    actor: actorContextFrom(req),
    filters: parseFilters(req),
  });

  res.status(200).json({ data });
});

export const getAiPerformance = asyncHandler(async (req, res) => {
  const data = await getAnalyticsAiPerformance({
    actor: actorContextFrom(req),
    filters: parseFilters(req),
  });

  res.status(200).json({ data });
});

export const getBreakdowns = asyncHandler(async (req, res) => {
  const data = await getAnalyticsBreakdowns({
    actor: actorContextFrom(req),
    filters: parseFilters(req),
  });

  res.status(200).json({ data });
});

/**
 * The Reminders overview. Counts plus a short preview of what is next.
 *
 * `limit` is parsed and bounded here like the attention list's is; `total` in the meta is the
 * PENDING count rather than the length of the preview, so a five-row list under a pending count
 * of forty reads as a preview instead of as the whole story.
 */
export const getReminders = asyncHandler(async (req, res) => {
  const { limit, ...filters } = parseWithSchema({
    schema: remindersQuerySchema,
    value: req.query,
    source: 'Query',
  });

  const data = await getAnalyticsReminders({
    actor: actorContextFrom(req),
    filters,
    limit,
  });

  res.status(200).json({
    data,
    meta: { limit: data.limit, count: data.next.length, total: data.counts.pending.value },
  });
});

export const getAttentionList = asyncHandler(async (req, res) => {
  const { limit, skip, ...filters } = parseWithSchema({
    schema: attentionQuerySchema,
    value: req.query,
    source: 'Query',
  });

  const data = await getAnalyticsAttentionList({
    actor: actorContextFrom(req),
    filters,
    limit,
    skip,
  });

  res.status(200).json({
    data,
    meta: { limit: data.limit, skip: data.skip, count: data.rows.length, total: data.total },
  });
});

/**
 * The same rows as above, as a file.
 *
 * `X-Total-Count` against the actual row count is how a clipped export announces itself: the
 * endpoint caps what one request may take out, and a file that silently held fewer rows than
 * the filters matched would be read as the whole answer.
 */
export const getAttentionCsv = asyncHandler(async (req, res) => {
  const { limit, skip, ...filters } = parseWithSchema({
    schema: attentionCsvQuerySchema,
    value: req.query,
    source: 'Query',
  });

  const { fileName, body, rowCount, total } = await getAnalyticsAttentionCsv({
    actor: actorContextFrom(req),
    filters,
    limit,
    skip,
  });

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Total-Count', String(total));
  res.setHeader('X-Row-Count', String(rowCount));

  res.status(200).send(body);
});
