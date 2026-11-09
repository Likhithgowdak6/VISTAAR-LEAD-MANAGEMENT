/**
 * Generates fixtures for sales-rejection from the compiled Node module.
 *
 * Run from crm-api/:
 *   node tools/make_sales_rejection_fixtures.mjs
 */

process.env.NODE_ENV ??= 'test';
process.env.PORT ??= '5001';
process.env.FRONTEND_ORIGIN ??= 'http://localhost:5173';
process.env.MONGODB_URI ??= 'mongodb://127.0.0.1:27017/fixture-generator-never-connects';
process.env.REDIS_URL ??= 'redis://127.0.0.1:6379';
process.env.JWT_ACCESS_SECRET ??= 'fixture-generator-placeholder-not-a-real-secret';
process.env.JWT_REFRESH_SECRET ??= 'fixture-generator-placeholder-not-a-real-secret';
process.env.ENCRYPTION_KEY ??= '0'.repeat(64);

import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const MODULE = pathToFileURL(
  path.resolve(process.cwd(), '../backend/dist/modules/followups/sales-rejection.service.js'),
).href;

const { createSalesRejectionService } = await import(MODULE);

const NOW = new Date('2026-10-21T17:00:00.000Z');

const CASES = [
  {
    name: 'firm_rejection_full',
    text: 'We have booked another photographer',
    verdict: { verdict: 'firm_rejection', quote: 'we have booked another photographer', confidence: 0.95 },
    params: { organizationId: 'org-1', conversationId: 'conv-1', whatsappAccountId: 'acc-1' },
    mockDbReturn: { _id: 'conv-1' },
  },
  {
    name: 'firm_rejection_fallback_quote',
    text: 'We selected another vendor',
    verdict: { verdict: 'firm_rejection', quote: '', confidence: 0.92 },
    params: { organizationId: 'org-1', conversationId: 'conv-1', whatsappAccountId: 'acc-1' },
    mockDbReturn: { _id: 'conv-1' },
  },
  {
    name: 'hesitation_discuss',
    text: 'Let me discuss with my family',
    verdict: { verdict: 'none', quote: '', confidence: 0.0 },
    params: { organizationId: 'org-1', conversationId: 'conv-1', whatsappAccountId: 'acc-1' },
  },
  {
    name: 'price_objection_high_confidence',
    text: 'Your price is too high for us',
    verdict: { verdict: 'none', quote: '', confidence: 0.99 },
    params: { organizationId: 'org-1', conversationId: 'conv-1', whatsappAccountId: 'acc-1' },
  },
  {
    name: 'low_confidence_rejection',
    text: 'I think we are going a different way, maybe',
    verdict: { verdict: 'firm_rejection', quote: 'going a different way', confidence: 0.79 },
    params: { organizationId: 'org-1', conversationId: 'conv-1', whatsappAccountId: 'acc-1' },
  },
  {
    name: 'exact_threshold_rejection',
    text: 'We went with someone else',
    verdict: { verdict: 'firm_rejection', quote: 'went with someone else', confidence: 0.80 },
    params: { organizationId: 'org-1', conversationId: 'conv-1', whatsappAccountId: 'acc-1' },
    mockDbReturn: { _id: 'conv-1' },
  },
  {
    name: 'opted_out_short_circuit',
    text: 'Please stop messaging me',
    params: { organizationId: 'org-1', conversationId: 'conv-1', whatsappAccountId: 'acc-1', optedOut: true },
  },
  {
    name: 'already_rejected_short_circuit',
    text: 'ok thanks',
    params: { organizationId: 'org-1', conversationId: 'conv-1', whatsappAccountId: 'acc-1', alreadyRejected: true },
  },
  {
    name: 'empty_text',
    text: '   ',
    params: { organizationId: 'org-1', conversationId: 'conv-1', whatsappAccountId: 'acc-1' },
  },
  {
    name: 'missing_org_or_conv',
    text: 'We booked someone else',
    params: { organizationId: null, conversationId: 'conv-1' },
  },
  {
    name: 'db_refused_concurrent_rejection',
    text: 'We booked someone else',
    verdict: { verdict: 'firm_rejection', quote: 'booked someone else', confidence: 0.9 },
    params: { organizationId: 'org-1', conversationId: 'conv-1', whatsappAccountId: 'acc-1' },
    mockDbReturn: null,
  },
];

const main = async () => {
  const results = [];

  for (const c of CASES) {
    let classifyCalled = false;
    let markCalledWith = null;
    let activityCalledWith = null;

    const svc = createSalesRejectionService({
      aiBrainClient: {
        classifyRejection: async (p) => {
          classifyCalled = true;
          return c.verdict;
        },
      },
      markSalesRejected: async (p) => {
        markCalledWith = p;
        return c.mockDbReturn !== undefined ? c.mockDbReturn : { _id: p.conversationId };
      },
      createActivity: async (p) => {
        activityCalledWith = p;
      },
      now: () => NOW,
      logger: { info: () => {}, error: () => {} },
    });

    const out = await svc.detectSalesRejection({
      text: c.text,
      ...c.params,
    });

    results.push({
      case: c.name,
      input: { text: c.text, ...c.params, verdict: c.verdict },
      output: out,
      calls: {
        classifyCalled,
        markCalledWith: markCalledWith ? {
          organizationId: String(markCalledWith.organizationId),
          conversationId: String(markCalledWith.conversationId),
          quote: markCalledWith.quote,
          source: markCalledWith.source,
        } : null,
        activityCalledWith: activityCalledWith ? {
          eventType: activityCalledWith.eventType,
          summary: activityCalledWith.summary,
          metadata: activityCalledWith.metadata,
        } : null,
      },
    });
  }

  const target = path.resolve(process.cwd(), 'tests/fixtures/sales_rejection.json');
  writeFileSync(target, JSON.stringify({ now: NOW.toISOString(), results }, null, 2), 'utf-8');
  console.log(`Wrote ${results.length} sales rejection cases to ${target}`);
};

main();

