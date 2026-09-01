/**
 * Clean-slate reset: puts an install back to how a freshly hosted one looks, keeping everything
 * the owner configured.
 *
 * The number this CRM runs on was used for real testing before the test-number allowlist
 * existed, so the dashboard now holds the owner's personal chats, channel spam and friends'
 * messages. This deletes the lead and conversation data and *only* that. Configuration — the
 * live WhatsApp session above all — is left exactly where it is.
 *
 * The two lists below are both explicit on purpose. A model must appear in `DELETE_TARGETS` or
 * in `PRESERVED_COLLECTIONS`, and `classifyRegisteredModels` reports any registered model that
 * is in neither. A model nobody classified is never deleted (the safer failure) but it is
 * printed loudly in both modes, and `reset-conversation-data.test.ts` fails until somebody puts
 * it in a list on purpose.
 *
 * This deletes real data irreversibly, so:
 *   - it is a dry run unless `--apply` is passed;
 *   - an unrecognised flag aborts rather than being ignored, because a typo'd `--org acme` that
 *     was quietly dropped would widen the scope from one organization to all of them;
 *   - an `--organization` that matches nothing aborts before a single delete, for the same
 *     reason;
 *   - `--apply` re-counts every preserved collection afterwards and says whether the numbers
 *     moved, so "the WhatsApp session survived" is something the run proves rather than claims.
 *
 *   npm run reset:conversation-data                              # dry run, all organizations
 *   npm run reset:conversation-data -- --organization vistaar    # dry run, one organization
 *   npm run reset:conversation-data -- --apply                   # delete, all organizations
 *   npm run reset:conversation-data -- --organization vistaar --apply
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import mongoose from 'mongoose';

import { connectDatabase, disconnectDatabase } from '../config/database.js';
import { env, type Env } from '../config/env.js';

// Lead and conversation data — everything this script exists to remove.
import { ActivityLog } from '../modules/activity/activity-log.model.js';
import { AiBrainApproval } from '../modules/ai-brain/ai-brain-approval.model.js';
import { AiDraft } from '../modules/ai/ai-draft.model.js';
import { Contact } from '../modules/contacts/contact.model.js';
import { Conversation } from '../modules/conversations/conversation.model.js';
import { FollowUpTask } from '../modules/followups/followup-task.model.js';
import { IdempotencyRecord } from '../modules/idempotency/idempotency-record.model.js';
import { LeadSubmission } from '../modules/lead-sources/lead-submission.model.js';
import { Message } from '../modules/messages/message.model.js';
import { Note } from '../modules/notes/note.model.js';
import { RealtimeOutboxEvent } from '../modules/realtime/realtime-outbox.model.js';

// Configuration and identity — imported so they are registered and classified, never deleted.
import { AiKnowledge } from '../modules/ai-knowledge/ai-knowledge.model.js';
import { AuditLog } from '../modules/audit/audit.model.js';
import { LeadSource } from '../modules/lead-sources/lead-source.model.js';
import { Organization } from '../modules/organizations/organization.model.js';
import { RefreshSession } from '../modules/auth/refresh-session.model.js';
import { Stage } from '../modules/stages/stage.model.js';
import { Tag } from '../modules/tags/tag.model.js';
import { User } from '../modules/users/user.model.js';
import { WhatsAppAccount } from '../modules/whatsapp-accounts/whatsapp-account.model.js';
import { WhatsAppAuthState } from '../modules/whatsapp-auth-states/whatsapp-auth-state.model.js';

/** The slice of a Mongoose model this script uses, so tests can hand it plain doubles. */
export interface CollectionLike {
  countDocuments: (filter: Record<string, unknown>) => PromiseLike<number>;
  deleteMany: (filter: Record<string, unknown>) => PromiseLike<{ deletedCount?: number }>;
}

/**
 * How one collection is narrowed to a single organization. Every model here is
 * organization-scoped; `Organization` itself is scoped on its own `_id` rather than on a
 * field pointing elsewhere, which is why this is a field name and not a boolean.
 */
export type ScopeField = 'organizationId' | '_id';

export interface ManagedCollection {
  /** The Mongoose model name, which is what `classifyRegisteredModels` matches on. */
  name: string;
  model: CollectionLike;
  scopeField: ScopeField;
  /** Printed next to the count. Why it is deleted, or why it must survive. */
  reason: string;
}

/**
 * DELETED. Lead and conversation data: what a lead sent, what the CRM said back, what the AI
 * proposed, and the bookkeeping rows that only make sense alongside them.
 */
export const DELETE_TARGETS: readonly ManagedCollection[] = Object.freeze([
  {
    name: 'Conversation',
    model: Conversation,
    scopeField: 'organizationId',
    reason: 'lead threads, stages and AI context',
  },
  {
    name: 'Message',
    model: Message,
    scopeField: 'organizationId',
    reason: 'every inbound and outbound message',
  },
  {
    name: 'Contact',
    model: Contact,
    scopeField: 'organizationId',
    reason: 'the people behind those threads',
  },
  {
    name: 'ActivityLog',
    model: ActivityLog,
    scopeField: 'organizationId',
    reason: 'per-conversation timeline entries',
  },
  {
    name: 'AiBrainApproval',
    model: AiBrainApproval,
    scopeField: 'organizationId',
    reason: 'pending and decided AI reply approvals',
  },
  {
    name: 'AiDraft',
    model: AiDraft,
    scopeField: 'organizationId',
    reason: 'AI drafts written for those conversations',
  },
  {
    name: 'FollowUpTask',
    model: FollowUpTask,
    scopeField: 'organizationId',
    reason: 'scheduled follow-ups for those leads',
  },
  {
    name: 'Note',
    model: Note,
    scopeField: 'organizationId',
    reason: 'human notes on those leads',
  },
  {
    name: 'LeadSubmission',
    model: LeadSubmission,
    scopeField: 'organizationId',
    reason: 'imported form rows AND the import ledger — see the warning below',
  },
  {
    name: 'RealtimeOutboxEvent',
    model: RealtimeOutboxEvent,
    scopeField: 'organizationId',
    reason: 'undelivered dashboard refresh events',
  },
  {
    name: 'IdempotencyRecord',
    model: IdempotencyRecord,
    scopeField: 'organizationId',
    reason: 'replay guards keyed to deleted requests',
  },
]);

/**
 * PRESERVED. Configuration, identity and the audit trail. Written out rather than left implicit:
 * "not in the delete list" is not a decision anybody made, and this list is where the reasoning
 * for each one lives.
 */
export const PRESERVED_COLLECTIONS: readonly ManagedCollection[] = Object.freeze([
  {
    name: 'WhatsAppAuthState',
    model: WhatsAppAuthState,
    scopeField: 'organizationId',
    reason: 'THE LIVE WHATSAPP SESSION — deleting it forces a QR re-scan and re-pairing',
  },
  {
    name: 'WhatsAppAccount',
    model: WhatsAppAccount,
    scopeField: 'organizationId',
    reason: 'the connected number and its settings',
  },
  {
    name: 'Organization',
    model: Organization,
    scopeField: '_id',
    reason: 'the tenant itself, including ownerWhatsappNumber',
  },
  {
    name: 'User',
    model: User,
    scopeField: 'organizationId',
    reason: 'logins',
  },
  {
    name: 'RefreshSession',
    model: RefreshSession,
    scopeField: 'organizationId',
    reason: 'signed-in sessions',
  },
  {
    name: 'AiKnowledge',
    model: AiKnowledge,
    scopeField: 'organizationId',
    reason: 'the knowledge base, written by hand',
  },
  {
    name: 'Stage',
    model: Stage,
    scopeField: 'organizationId',
    reason: 'pipeline configuration',
  },
  {
    name: 'Tag',
    model: Tag,
    scopeField: 'organizationId',
    reason: 'pipeline configuration',
  },
  {
    name: 'LeadSource',
    model: LeadSource,
    scopeField: 'organizationId',
    reason: 'Google Sheet and Meta Lead Ads configuration',
  },
  {
    name: 'AuditLog',
    model: AuditLog,
    scopeField: 'organizationId',
    reason: 'security audit trail — records who did what, not lead data',
  },
]);

export interface ModelClassification {
  /** Registered models that are in neither list. Never deleted; always printed. */
  unclassified: string[];
  /** Listed in both lists — a contradiction, not a preference. */
  conflicting: string[];
  /** Listed but not registered: a stale entry left behind by a rename or a deletion. */
  missing: string[];
}

export interface ClassifyModelsParams {
  registered: readonly string[];
  deleteNames?: readonly string[];
  preserveNames?: readonly string[];
}

/**
 * Compares the two lists against what Mongoose actually has registered. The point is that adding
 * a model later cannot quietly opt out: it shows up in `unclassified` until somebody decides.
 */
export const classifyRegisteredModels = ({
  registered,
  deleteNames = DELETE_TARGETS.map((entry) => entry.name),
  preserveNames = PRESERVED_COLLECTIONS.map((entry) => entry.name),
}: ClassifyModelsParams): ModelClassification => {
  const deleted = new Set(deleteNames);
  const preserved = new Set(preserveNames);
  const known = new Set(registered);

  return {
    unclassified: registered.filter((name) => !deleted.has(name) && !preserved.has(name)).sort(),
    conflicting: [...deleted].filter((name) => preserved.has(name)).sort(),
    missing: [...deleted, ...preserved].filter((name) => !known.has(name)).sort(),
  };
};

export interface ResetArgs {
  apply: boolean;
  organization: string | null;
  help: boolean;
  /** Non-empty means "print these and exit 1"; never means "carry on with what we understood". */
  errors: string[];
}

export const USAGE = [
  'Usage: npm run reset:conversation-data [-- <options>]',
  '',
  '  --apply                     Actually delete. Without it nothing is written.',
  '  --organization <slug|id>    Limit the reset to one organization. Default: all of them.',
  '  --help                      Print this and exit.',
].join('\n');

/**
 * Deliberately strict. An unknown flag is an error rather than something to ignore, because the
 * flag most likely to be mistyped is the one that narrows the blast radius.
 */
export const parseResetArgs = (argv: readonly string[]): ResetArgs => {
  const args: ResetArgs = { apply: false, organization: null, help: false, errors: [] };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? '';

    if (token === '--apply') {
      args.apply = true;
      continue;
    }

    if (token === '--help' || token === '-h') {
      args.help = true;
      continue;
    }

    if (token === '--organization' || token.startsWith('--organization=')) {
      // A value that looks like a flag is a missing value, not a slug: `--organization --apply`
      // must not resolve to the organization literally called "--apply", and must certainly not
      // fall through to "no organization given", which means all of them.
      const value = (
        token === '--organization' ? (argv[index + 1] ?? '') : token.slice('--organization='.length)
      ).trim();

      if (value === '' || value.startsWith('-')) {
        args.errors.push('--organization needs a slug or id, for example --organization vistaar.');
        continue;
      }

      args.organization = value;

      if (token === '--organization') {
        index += 1;
      }

      continue;
    }

    args.errors.push(`Unrecognised argument: ${token}`);
  }

  return args;
};

/** A slug is lowercased on the way into `Organization`, so it is lowercased on the way out too. */
export const buildOrganizationLookup = (value: string): Record<string, unknown> =>
  mongoose.isValidObjectId(value) ? { _id: value } : { slug: value.trim().toLowerCase() };

export interface ResetScope {
  organizationId: string | null;
  label: string;
}

export const ALL_ORGANIZATIONS: ResetScope = Object.freeze({
  organizationId: null,
  label: 'ALL ORGANIZATIONS',
});

/** The filter for one collection under the current scope. `{}` means every organization. */
export const scopedFilter = (
  collection: Pick<ManagedCollection, 'scopeField'>,
  scope: ResetScope,
): Record<string, unknown> =>
  scope.organizationId === null ? {} : { [collection.scopeField]: scope.organizationId };

export interface CountedCollection extends ManagedCollection {
  count: number;
}

export interface ResetPlan {
  scope: ResetScope;
  deletable: CountedCollection[];
  preserved: CountedCollection[];
  totalDeletable: number;
  leadSourceCount: number;
  classification: ModelClassification;
}

const formatCount = (count: number): string => count.toLocaleString('en-US');

const renderRows = (rows: readonly CountedCollection[]): string[] => {
  const nameWidth = Math.max(...rows.map((row) => row.name.length), 0);
  const countWidth = Math.max(...rows.map((row) => formatCount(row.count).length), 0);

  return rows.map(
    (row) =>
      `  ${row.name.padEnd(nameWidth)}  ${formatCount(row.count).padStart(countWidth)}  ${row.reason}`,
  );
};

export interface CreateConversationDataResetOptions {
  deleteTargets?: readonly ManagedCollection[];
  preservedCollections?: readonly ManagedCollection[];
  /** Everything Mongoose has registered, which is what the two lists are checked against. */
  registeredModelNames?: () => string[];
  config?: Pick<Env, 'LEAD_IMPORT_ENABLED'>;
  log?: (line: string) => void;
}

export const createConversationDataReset = ({
  deleteTargets = DELETE_TARGETS,
  preservedCollections = PRESERVED_COLLECTIONS,
  registeredModelNames = () => Object.keys(mongoose.models),
  config = env,
  log = (line: string): void => {
    console.log(line);
  },
}: CreateConversationDataResetOptions = {}) => {
  const countAll = async (
    collections: readonly ManagedCollection[],
    scope: ResetScope,
  ): Promise<CountedCollection[]> => {
    const counted: CountedCollection[] = [];

    for (const collection of collections) {
      counted.push({
        ...collection,
        count: await collection.model.countDocuments(scopedFilter(collection, scope)),
      });
    }

    return counted;
  };

  /** Read-only. Everything printed in either mode is computed here first. */
  const buildPlan = async (scope: ResetScope): Promise<ResetPlan> => {
    const deletable = await countAll(deleteTargets, scope);
    const preserved = await countAll(preservedCollections, scope);

    return {
      scope,
      deletable,
      preserved,
      totalDeletable: deletable.reduce((total, row) => total + row.count, 0),
      leadSourceCount: preserved.find((row) => row.name === 'LeadSource')?.count ?? 0,
      classification: classifyRegisteredModels({
        registered: registeredModelNames(),
        deleteNames: deleteTargets.map((entry) => entry.name),
        preserveNames: preservedCollections.map((entry) => entry.name),
      }),
    };
  };

  /**
   * The one thing that turns a cleanup into a flood. `LeadSubmission` is the ledger that stops an
   * already-imported row being imported again, so deleting it makes every historical row look
   * new. Printed whenever a source exists at all, not only when importing is currently on: the
   * flag is one dashboard toggle away from being on again.
   */
  const renderLeadLedgerWarning = (plan: ResetPlan): string[] => {
    if (plan.leadSourceCount === 0) {
      return [];
    }

    const importing = config.LEAD_IMPORT_ENABLED === true;

    return [
      '',
      '!! WARNING — deleting LeadSubmission wipes the import ledger.',
      `   ${formatCount(plan.leadSourceCount)} lead source(s) are configured and LEAD_IMPORT_ENABLED=${String(importing)}.`,
      importing
        ? '   The next poll will re-import EVERY historical row as a brand-new lead, which will'
        : '   Importing is off right now, but the moment it is turned back on the next poll will',
      importing
        ? '   refill the dashboard you are trying to empty.'
        : '   re-import EVERY historical row as a brand-new lead.',
      '   Before --apply: pause or delete the lead sources, or set LEAD_IMPORT_ENABLED=false, or',
      "   move each source's importFromTime forward so the history falls outside the window.",
    ];
  };

  const renderClassificationWarning = (plan: ResetPlan): string[] => {
    const { unclassified, conflicting, missing } = plan.classification;

    if (unclassified.length === 0 && conflicting.length === 0 && missing.length === 0) {
      return [];
    }

    const lines = ['', '!! MODEL LISTS ARE OUT OF DATE.'];

    if (unclassified.length > 0) {
      lines.push(
        `   Registered but in neither list, so NOT deleted: ${unclassified.join(', ')}.`,
        '   Add each one to DELETE_TARGETS or PRESERVED_COLLECTIONS in this script on purpose.',
      );
    }

    if (conflicting.length > 0) {
      lines.push(`   Listed as both deleted and preserved: ${conflicting.join(', ')}.`);
    }

    if (missing.length > 0) {
      lines.push(`   Listed but not registered (stale entry): ${missing.join(', ')}.`);
    }

    return lines;
  };

  const printPlan = (plan: ResetPlan, apply: boolean): void => {
    log('');
    log('WAM CRM AI — conversation data reset');
    log(
      apply
        ? 'Mode:  APPLY (this deletes data and cannot be undone)'
        : 'Mode:  DRY RUN (nothing is deleted; re-run with --apply to perform it)',
    );
    log(`Scope: ${plan.scope.label}`);
    log('');
    log(
      `${apply ? 'Deleting' : 'Would delete'} — ${formatCount(plan.deletable.length)} collections, ${formatCount(plan.totalDeletable)} documents:`,
    );
    renderRows(plan.deletable).forEach(log);
    log('');
    log(`Preserved — ${formatCount(plan.preserved.length)} collections, left untouched:`);
    renderRows(plan.preserved).forEach(log);
    renderClassificationWarning(plan).forEach(log);
    renderLeadLedgerWarning(plan).forEach(log);
  };

  const deleteAll = async (scope: ResetScope): Promise<CountedCollection[]> => {
    const deleted: CountedCollection[] = [];

    for (const collection of deleteTargets) {
      const result = await collection.model.deleteMany(scopedFilter(collection, scope));

      deleted.push({ ...collection, count: result.deletedCount ?? 0 });
    }

    return deleted;
  };

  /**
   * Counts every preserved collection again after the deletes. A reset that silently took the
   * WhatsApp session with it is the failure this whole script is shaped around, so the run says
   * out loud that the numbers did not move rather than leaving it to be assumed.
   */
  const verifyPreserved = async (
    before: readonly CountedCollection[],
    scope: ResetScope,
  ): Promise<{ ok: boolean; lines: string[] }> => {
    const after = await countAll(preservedCollections, scope);
    const changed = after.filter((row) => {
      const previous = before.find((entry) => entry.name === row.name);

      return previous !== undefined && previous.count !== row.count;
    });

    if (changed.length === 0) {
      return {
        ok: true,
        lines: [
          `Preserved collections re-counted: all ${formatCount(after.length)} unchanged, including the WhatsApp session.`,
        ],
      };
    }

    return {
      ok: false,
      lines: [
        '!! PRESERVED DATA CHANGED DURING THE RESET. Investigate before trusting this install:',
        ...changed.map((row) => {
          const previous = before.find((entry) => entry.name === row.name)?.count ?? 0;

          return `   ${row.name}: ${formatCount(previous)} -> ${formatCount(row.count)}`;
        }),
      ],
    };
  };

  const run = async ({
    scope,
    apply,
  }: {
    scope: ResetScope;
    apply: boolean;
  }): Promise<{ ok: boolean; plan: ResetPlan }> => {
    const plan = await buildPlan(scope);

    printPlan(plan, apply);

    if (!apply) {
      log('');
      log('Nothing was deleted. Re-run with --apply to perform this reset.');

      return { ok: true, plan };
    }

    const deleted = await deleteAll(scope);
    const totalDeleted = deleted.reduce((total, row) => total + row.count, 0);

    log('');
    log(`Deleted — ${formatCount(totalDeleted)} documents:`);
    renderRows(deleted).forEach(log);
    log('');

    const verification = await verifyPreserved(plan.preserved, scope);

    verification.lines.forEach(log);
    log('');
    log(
      verification.ok
        ? 'Reset complete. The install now looks like a fresh one, with its configuration intact.'
        : 'Reset finished, but the preserved counts moved. See above.',
    );

    return { ok: verification.ok, plan };
  };

  return { buildPlan, printPlan, deleteAll, verifyPreserved, run };
};

export type ConversationDataReset = ReturnType<typeof createConversationDataReset>;

/**
 * Resolves `--organization` to a real tenant, or throws. Failing here is the point: a slug that
 * matches nothing must never fall through to "no filter", which is every organization.
 */
export const resolveScope = async (
  organization: string | null,
  organizationModel: {
    findOne: (filter: Record<string, unknown>) => PromiseLike<{ _id: unknown; slug?: string } | null>;
    find: (filter: Record<string, unknown>) => PromiseLike<Array<{ slug?: string }>>;
  } = Organization,
): Promise<ResetScope> => {
  if (organization === null) {
    return ALL_ORGANIZATIONS;
  }

  const found = await organizationModel.findOne(buildOrganizationLookup(organization));

  if (!found) {
    const known = (await organizationModel.find({}))
      .map((entry) => entry.slug)
      .filter((slug): slug is string => typeof slug === 'string' && slug !== '');

    throw new Error(
      `No organization matches "${organization}". ` +
        (known.length > 0
          ? `Known slugs: ${known.sort().join(', ')}.`
          : 'This database has no organizations at all.'),
    );
  }

  const id = String(found._id);

  return { organizationId: id, label: `organization ${found.slug ?? id} (${id})` };
};

const main = async (): Promise<void> => {
  const args = parseResetArgs(process.argv.slice(2));

  if (args.errors.length > 0) {
    args.errors.forEach((error) => {
      console.error(error);
    });
    console.error('');
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }

  if (args.help) {
    console.log(USAGE);
    return;
  }

  await connectDatabase();

  try {
    const scope = await resolveScope(args.organization);
    const reset = createConversationDataReset();
    const { ok } = await reset.run({ scope, apply: args.apply });

    if (!ok) {
      process.exitCode = 1;
    }
  } finally {
    await disconnectDatabase();
  }
};

/**
 * Only when run as a script. Importing this file — which the tests do, for the lists and the
 * argument parsing — must never open a database connection, let alone delete anything.
 */
const isDirectRun = (): boolean => {
  const entry = process.argv[1];

  return typeof entry === 'string' && path.resolve(entry) === fileURLToPath(import.meta.url);
};

if (isDirectRun()) {
  main().catch(async (error: unknown) => {
    const err = error as { name?: string; message?: string };
    console.error('Conversation data reset failed.', { name: err?.name, message: err?.message });
    await disconnectDatabase().catch(() => {});
    process.exitCode = 1;
  });
}
