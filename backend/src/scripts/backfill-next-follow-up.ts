/**
 * Repairs `Conversation.nextFollowUpAt` from the reminders that are the authority for it.
 *
 * WHY IT IS NEEDED. Nothing wrote this field until now, so every conversation that already has
 * reminders carries a null where a due time belongs. It is also the recovery path for the one
 * failure the live sync tolerates: if refreshing the conversation fails after a reminder was
 * saved, that conversation stays stale until its next reminder mutation - or until this runs.
 *
 * DRY RUN IS THE DEFAULT. It reports what it would change and writes nothing unless `--apply`
 * is passed. A backfill that writes by default is one typo away from being run against the
 * wrong database.
 *
 * IDEMPOTENT. It recomputes each conversation's answer from its pending reminders and writes
 * only where the stored value differs, so a second run reports zero changes. Safe to re-run,
 * safe to interrupt and re-run.
 *
 * SCOPE. Only conversations that HAVE reminders are considered - the grouping starts from the
 * FollowUpTask collection, so a CRM with a million quiet conversations does not pay for them.
 * Personal reminders (no conversationId) are excluded at the first stage: they have no
 * conversation to update, and attaching them to one is the mistake this field must never make.
 *
 *   npm run backfill:next-follow-up            # dry run, writes nothing
 *   npm run backfill:next-follow-up -- --apply # actually writes
 *   npm run backfill:next-follow-up -- --apply --org <organizationId>
 *
 * NEVER RUN THIS AGAINST PRODUCTION WITHOUT A BACKUP, and never automatically - it is a manual
 * tool, not a migration, and nothing calls it on boot.
 */
import mongoose from 'mongoose';

import { connectDatabase, disconnectDatabase } from '../config/database.js';
import { FOLLOWUP_STATUSES } from '../constants/followup-statuses.js';
import { Conversation } from '../modules/conversations/conversation.model.js';
import { FollowUpTask } from '../modules/followups/followup-task.model.js';

interface Args {
  apply: boolean;
  organizationId: string | null;
}

const parseArgs = (argv: readonly string[]): Args => {
  const orgIndex = argv.indexOf('--org');

  return {
    apply: argv.includes('--apply'),
    organizationId: orgIndex >= 0 ? (argv[orgIndex + 1] ?? null) : null,
  };
};

interface PendingGroup {
  _id: { organizationId: mongoose.Types.ObjectId; conversationId: mongoose.Types.ObjectId };
  earliestDueAt: Date;
}

const sameInstant = (a: Date | null | undefined, b: Date | null | undefined): boolean => {
  if (!a && !b) {
    return true;
  }

  return Boolean(a && b && a.getTime() === b.getTime());
};

const run = async (): Promise<number> => {
  const args = parseArgs(process.argv.slice(2));

  await connectDatabase();
  console.log(args.apply ? 'MODE: apply (will write)' : 'MODE: dry run (writes nothing)');

  if (args.organizationId) {
    console.log(`scoped to organization ${args.organizationId}`);
  }

  const orgFilter = args.organizationId
    ? { organizationId: new mongoose.Types.ObjectId(args.organizationId) }
    : {};

  /**
   * One row per conversation that has at least one pending reminder, carrying the earliest due
   * time. Grouped in the database rather than in memory - the whole point is not to load the
   * reminder collection into this process.
   */
  const groups = await FollowUpTask.aggregate<PendingGroup>([
    {
      $match: {
        ...orgFilter,
        status: FOLLOWUP_STATUSES.PENDING,
        // Personal reminders excluded here, at the source.
        conversationId: { $ne: null },
      },
    },
    {
      $group: {
        _id: { organizationId: '$organizationId', conversationId: '$conversationId' },
        earliestDueAt: { $min: '$dueAt' },
      },
    },
  ]);

  console.log(`conversations with pending reminders: ${groups.length}`);

  const expected = new Map<string, { organizationId: mongoose.Types.ObjectId; dueAt: Date }>();

  for (const group of groups) {
    expected.set(String(group._id.conversationId), {
      organizationId: group._id.organizationId,
      dueAt: group.earliestDueAt,
    });
  }

  /**
   * Conversations that currently claim a next reminder. Needed to find the opposite error -
   * a stored time on a conversation whose reminders are all closed, which no amount of looking
   * at pending reminders alone would reveal.
   */
  const claiming = await Conversation.find({ ...orgFilter, nextFollowUpAt: { $ne: null } })
    .select({ _id: 1, organizationId: 1, nextFollowUpAt: 1 })
    .lean();

  let toSet = 0;
  let toCorrect = 0;
  let toClear = 0;
  let unchanged = 0;

  const writes: Array<{
    organizationId: mongoose.Types.ObjectId;
    conversationId: mongoose.Types.ObjectId;
    dueAt: Date | null;
  }> = [];

  const stored = new Map<string, Date | null>();

  for (const row of claiming) {
    stored.set(String(row._id), (row.nextFollowUpAt as Date | null) ?? null);
  }

  // Conversations that should carry a time.
  for (const [conversationId, { organizationId, dueAt }] of expected) {
    const current = stored.get(conversationId) ?? null;

    if (sameInstant(current, dueAt)) {
      unchanged += 1;
      continue;
    }

    if (current === null) {
      toSet += 1;
    } else {
      toCorrect += 1;
    }

    writes.push({
      organizationId,
      conversationId: new mongoose.Types.ObjectId(conversationId),
      dueAt,
    });
  }

  // Conversations that claim a time but have no pending reminder left.
  for (const row of claiming) {
    if (!expected.has(String(row._id))) {
      toClear += 1;
      writes.push({
        organizationId: row.organizationId as mongoose.Types.ObjectId,
        conversationId: row._id as mongoose.Types.ObjectId,
        dueAt: null,
      });
    }
  }

  console.log('');
  console.log(`  already correct : ${unchanged}`);
  console.log(`  to set          : ${toSet}   (null -> a due time)`);
  console.log(`  to correct      : ${toCorrect}   (stale time -> the right one)`);
  console.log(`  to clear        : ${toClear}   (time -> null, no pending reminders left)`);
  console.log(`  TOTAL WRITES    : ${writes.length}`);

  if (!args.apply) {
    console.log('');
    console.log('Dry run - nothing was written. Re-run with --apply to make these changes.');
    return 0;
  }

  if (writes.length === 0) {
    console.log('\nNothing to do.');
    return 0;
  }

  // One bulk round trip rather than a write per conversation. Each filter carries the
  // organization, so a conversation can only ever be updated within its own tenant.
  const result = await Conversation.bulkWrite(
    writes.map((write) => ({
      updateOne: {
        filter: { _id: write.conversationId, organizationId: write.organizationId },
        update: { $set: { nextFollowUpAt: write.dueAt } },
      },
    })),
    { ordered: false },
  );

  console.log(`\napplied: ${result.modifiedCount} conversation(s) updated.`);
  console.log('Re-run without --apply to confirm it now reports zero writes.');

  return 0;
};

run()
  .then(async (code) => {
    await disconnectDatabase();
    process.exit(code);
  })
  .catch(async (error: unknown) => {
    console.error('backfill failed:', error instanceof Error ? error.message : error);
    await disconnectDatabase().catch(() => undefined);
    process.exit(1);
  });
