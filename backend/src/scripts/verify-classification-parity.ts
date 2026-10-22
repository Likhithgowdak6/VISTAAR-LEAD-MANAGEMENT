/**
 * Proves that MongoDB and TypeScript agree about how a conversation is classified.
 *
 * WHY THIS SCRIPT EXISTS. The classification rules are written twice on purpose - once as plain
 * functions, for labelling a conversation the API already holds, and once as `$expr` predicates,
 * so the inbox can filter by them across every page rather than the fifty rows in memory.
 * Unit tests cover the TypeScript. Nothing but a real database can cover the other half, and two
 * definitions that drift apart produce an inbox filter that disagrees with the label printed on
 * the row it returns - which is worse than having neither.
 *
 * So: seed one document per scenario, run both implementations over the same documents, and
 * diff the id sets. Any disagreement is printed with the offending ids and the script exits 1.
 *
 * SAFETY. It connects to the configured MongoDB SERVER but creates its own throwaway database,
 * named with a timestamp, and drops it at the end. It never reads, writes or deletes anything
 * in the application's database - a parity check is not worth any risk to real conversations.
 *
 *   npm run verify:classification-parity
 */
import mongoose, { Schema } from 'mongoose';

import { env } from '../config/env.js';
import {
  aiResponseStatusFilter,
  enquiryClassFilter,
  needsAttentionFilter,
} from '../modules/analytics/classification-filters.js';
import {
  AI_RESPONSE_STATUS_VALUES,
  ENQUIRY_CLASS_VALUES,
  classifyEnquiry,
  needsAttention,
  resolveAiResponseStatus,
  type AttentionInput,
} from '../modules/analytics/conversation-classification.js';

/** Fixed clock so "overdue follow-up" means the same thing on both sides of the comparison. */
const NOW = new Date('2026-10-20T12:00:00.000Z');
const MON = new Date('2026-10-19T09:00:00.000Z');
const TUE = new Date('2026-10-20T09:00:00.000Z');
const WED = new Date('2026-10-21T09:00:00.000Z');

interface Scenario {
  /** Readable id, used as `_id` so a failure names the case rather than an ObjectId. */
  name: string;
  /** Which of the brief's 17 scenarios this covers, for the report. */
  covers: string;
  doc: AttentionInput;
}

const scenarios: Scenario[] = [
  {
    name: 'enquiry-ai-replied',
    covers: '1. genuine enquiry that received an AI reply',
    doc: {
      leadQualificationStatus: 'confirmed',
      leadQualificationSource: 'ai_reply_sent',
      leadQualifiedAt: MON,
      aiAutomationEnabled: true,
      lastInboundAt: MON,
      lastAiReplyAt: TUE,
      lastDeliveredOutboundAt: TUE,
    },
  },
  {
    name: 'enquiry-no-reply',
    covers: '2. genuine enquiry with no AI reply',
    doc: { leadQualificationStatus: 'confirmed', aiAutomationEnabled: true, lastInboundAt: TUE },
  },
  {
    name: 'enquiry-short-followup',
    covers: '3. confirmed enquiry whose latest message is a short follow-up ("ok")',
    doc: {
      leadQualificationStatus: 'confirmed',
      leadQualificationSource: 'ai_reply_sent',
      leadQualifiedAt: MON,
      aiAutomationEnabled: true,
      lastAiReplyAt: MON,
      lastDeliveredOutboundAt: MON,
      lastInboundAt: TUE,
    },
  },
  {
    name: 'not-an-enquiry',
    covers: '4. non-enquiry conversation',
    doc: {
      leadQualificationStatus: 'rejected',
      leadQualificationSource: 'classifier_non_lead',
      leadQualifiedAt: MON,
      aiAutomationEnabled: true,
      lastInboundAt: WED,
    },
  },
  {
    name: 'ambiguous-needs-review',
    covers: '5. ambiguous conversation requiring review',
    doc: { leadQualificationStatus: 'unknown', aiAutomationEnabled: true, lastInboundAt: TUE },
  },
  {
    name: 'ai-paused',
    covers: '6. AI-paused conversation',
    doc: {
      leadQualificationStatus: 'confirmed',
      aiAutomationEnabled: false,
      lastInboundAt: WED,
      lastAiReplyAt: MON,
    },
  },
  {
    name: 'queued-not-sent',
    covers: '7. a queued AI message must not count as sent',
    // The giveaway: lastOutboundAt (queue time) is set, the delivered fields are not. If the
    // rules ever read lastOutboundAt this row would wrongly read as replied.
    doc: { leadQualificationStatus: 'confirmed', aiAutomationEnabled: true, lastInboundAt: TUE },
  },
  {
    name: 'ai-send-failed',
    covers: '8. failed AI message',
    doc: {
      leadQualificationStatus: 'confirmed',
      aiAutomationEnabled: true,
      lastInboundAt: MON,
      lastAiSendFailedAt: TUE,
    },
  },
  {
    name: 'replied-then-new-inbound',
    covers: '9. successful send followed by a newer unanswered inbound',
    doc: {
      leadQualificationStatus: 'confirmed',
      aiAutomationEnabled: true,
      lastAiReplyAt: MON,
      lastDeliveredOutboundAt: MON,
      lastInboundAt: WED,
    },
  },
  {
    name: 'failure-then-success',
    covers: '10. a retry that succeeded must not still read as failed',
    doc: {
      leadQualificationStatus: 'confirmed',
      aiAutomationEnabled: true,
      lastInboundAt: MON,
      lastAiSendFailedAt: MON,
      lastAiReplyAt: TUE,
      lastDeliveredOutboundAt: TUE,
    },
  },
  {
    name: 'legacy-no-fields',
    covers: '11. legacy row with no classification fields at all',
    doc: {},
  },
  {
    name: 'legacy-confirmed-by-qualified-at',
    covers: '11. legacy confirmed row, reply time known only from leadQualifiedAt',
    doc: {
      leadQualificationStatus: 'confirmed',
      leadQualificationSource: 'legacy_delivered_reply',
      leadQualifiedAt: TUE,
      aiAutomationEnabled: true,
      lastInboundAt: MON,
    },
  },
  {
    name: 'opted-out',
    covers: 'opt-out outranks every other status',
    doc: {
      leadQualificationStatus: 'confirmed',
      aiAutomationEnabled: true,
      optedOutAt: MON,
      lastInboundAt: WED,
    },
  },
  {
    name: 'human-answered',
    covers: 'a human reply settles the customer, even with no AI reply',
    doc: {
      leadQualificationStatus: 'confirmed',
      aiAutomationEnabled: true,
      lastInboundAt: MON,
      lastDeliveredOutboundAt: WED,
    },
  },
  {
    name: 'overdue-followup',
    covers: 'a follow-up that has come due needs attention',
    doc: {
      leadQualificationStatus: 'confirmed',
      aiAutomationEnabled: true,
      lastInboundAt: MON,
      lastAiReplyAt: TUE,
      lastDeliveredOutboundAt: TUE,
      nextFollowUpAt: MON,
    },
  },
  {
    name: 'future-followup',
    covers: 'a follow-up still in the future does not',
    doc: {
      leadQualificationStatus: 'confirmed',
      aiAutomationEnabled: true,
      lastInboundAt: MON,
      lastAiReplyAt: TUE,
      lastDeliveredOutboundAt: TUE,
      nextFollowUpAt: WED,
    },
  },
  {
    name: 'paused-non-enquiry',
    covers: 'precedence: not-needed outranks paused',
    doc: { leadQualificationStatus: 'rejected', aiAutomationEnabled: false, lastInboundAt: WED },
  },
  {
    name: 'unknown-paused-waiting',
    covers: 'paused + unclassified + customer waiting still needs attention',
    doc: { leadQualificationStatus: 'unknown', aiAutomationEnabled: false, lastInboundAt: WED },
  },
  {
    name: 'never-messaged',
    covers: 'a conversation created by hand that has never exchanged a message',
    doc: { leadQualificationStatus: 'unknown', aiAutomationEnabled: true },
  },
];

/**
 * A schema with no casting opinions, so a document is stored exactly as written - including
 * the absent fields that make the legacy cases legacy. The real Conversation model would apply
 * defaults and fill them in, which is precisely what must not happen here.
 */
const parchmentSchema = new Schema({}, { strict: false, _id: false, versionKey: false });

const sortedNames = (names: string[]): string => [...names].sort().join(', ') || '(none)';

const run = async (): Promise<number> => {
  // Its own database on the same server, dropped at the end. Nothing in the application's
  // database is read or written at any point.
  const databaseName = `vistaar_parity_${Date.now()}`;
  const uri = new URL(env.MONGODB_URI.replace(/^mongodb(\+srv)?:\/\//, 'http://'));
  uri.pathname = `/${databaseName}`;
  const target = env.MONGODB_URI.startsWith('mongodb+srv')
    ? env.MONGODB_URI.replace(/\/[^/?]*(\?|$)/, `/${databaseName}$1`)
    : `mongodb://${uri.host}/${databaseName}`;

  await mongoose.connect(target, { serverSelectionTimeoutMS: 10_000 });
  console.log(`connected; using throwaway database ${databaseName}`);

  const Parity = mongoose.model('ParityConversation', parchmentSchema, 'conversations');

  try {
    await Parity.insertMany(
      scenarios.map((scenario) => ({ _id: scenario.name, ...scenario.doc })),
      { ordered: true },
    );
    console.log(`seeded ${scenarios.length} scenario documents\n`);

    const failures: string[] = [];

    const compare = async (label: string, filter: object, predicate: (doc: AttentionInput) => boolean) => {
      const fromMongo = (await Parity.find(filter).select({ _id: 1 }).lean()).map((row) =>
        String(row._id),
      );
      const fromTypeScript = scenarios.filter((s) => predicate(s.doc)).map((s) => s.name);

      const mongoSet = new Set(fromMongo);
      const tsSet = new Set(fromTypeScript);
      const onlyMongo = [...mongoSet].filter((name) => !tsSet.has(name));
      const onlyTs = [...tsSet].filter((name) => !mongoSet.has(name));

      if (onlyMongo.length === 0 && onlyTs.length === 0) {
        console.log(`  PASS  ${label.padEnd(44)} ${mongoSet.size} match(es)`);
        return;
      }

      failures.push(label);
      console.log(`  FAIL  ${label}`);
      console.log(`          mongo only : ${sortedNames(onlyMongo)}`);
      console.log(`          rules only : ${sortedNames(onlyTs)}`);
    };

    console.log('enquiry classification');
    for (const value of ENQUIRY_CLASS_VALUES) {
      await compare(`class = ${value}`, enquiryClassFilter(value), (doc) => classifyEnquiry(doc) === value);
    }

    console.log('\nAI response status');
    for (const value of AI_RESPONSE_STATUS_VALUES) {
      await compare(
        `status = ${value}`,
        aiResponseStatusFilter(value),
        (doc) => resolveAiResponseStatus(doc) === value,
      );
    }

    console.log('\nneeds attention');
    await compare('needsAttention', needsAttentionFilter(NOW), (doc) => needsAttention(doc, NOW));

    console.log('\ncombined filters');
    const combinations: Array<[string, object, (doc: AttentionInput) => boolean]> = [
      [
        'enquiry + awaiting',
        { $and: [enquiryClassFilter('enquiry'), aiResponseStatusFilter('awaiting_ai_reply')] },
        (doc) => classifyEnquiry(doc) === 'enquiry' && resolveAiResponseStatus(doc) === 'awaiting_ai_reply',
      ],
      [
        'enquiry + paused',
        { $and: [enquiryClassFilter('enquiry'), aiResponseStatusFilter('ai_paused')] },
        (doc) => classifyEnquiry(doc) === 'enquiry' && resolveAiResponseStatus(doc) === 'ai_paused',
      ],
      [
        'enquiry + replied',
        { $and: [enquiryClassFilter('enquiry'), aiResponseStatusFilter('ai_replied')] },
        (doc) => classifyEnquiry(doc) === 'enquiry' && resolveAiResponseStatus(doc) === 'ai_replied',
      ],
      [
        'needs review + needs attention',
        { $and: [enquiryClassFilter('needs_review'), needsAttentionFilter(NOW)] },
        (doc) => classifyEnquiry(doc) === 'needs_review' && needsAttention(doc, NOW),
      ],
    ];

    for (const [label, filter, predicate] of combinations) {
      await compare(label, filter, predicate);
    }

    console.log('\npartition check');
    // Every seeded document must fall into exactly one AI-status bucket in MongoDB too -
    // otherwise the dashboard's cards would double-count or lose rows.
    const counts = new Map<string, number>();
    for (const value of AI_RESPONSE_STATUS_VALUES) {
      for (const row of await Parity.find(aiResponseStatusFilter(value)).select({ _id: 1 }).lean()) {
        const key = String(row._id);
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }

    const miscounted = scenarios
      .map((s) => s.name)
      .filter((name) => (counts.get(name) ?? 0) !== 1)
      .map((name) => `${name}=${counts.get(name) ?? 0}`);

    if (miscounted.length === 0) {
      console.log(`  PASS  every document matches exactly one status bucket`);
    } else {
      failures.push('status buckets partition');
      console.log(`  FAIL  documents in the wrong number of buckets: ${miscounted.join(', ')}`);
    }

    console.log('');
    if (failures.length > 0) {
      console.log(`${failures.length} CHECK(S) FAILED: ${failures.join('; ')}`);
      return 1;
    }

    console.log('ALL PARITY CHECKS PASSED - MongoDB and the TypeScript rules agree.');
    return 0;
  } finally {
    // Always, including on failure: the throwaway database must not outlive the run.
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
    console.log(`dropped ${databaseName}`);
  }
};

run()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error('parity check could not run:', error instanceof Error ? error.message : error);
    process.exit(1);
  });
