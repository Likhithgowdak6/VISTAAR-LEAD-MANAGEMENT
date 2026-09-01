/**
 * The reset script deletes real data irreversibly, so the parts that decide *what* gets deleted
 * are tested rather than trusted: the two model lists, the completeness check that catches a
 * model nobody classified, the argument parser (a mistyped flag must never widen the scope), and
 * the run itself against injected doubles.
 *
 * Importing the script must not connect to anything - the entry-point guard at the bottom of it
 * is what keeps that true, and this file relies on it.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../config/env.js', () => ({
  env: { NODE_ENV: 'test', LOG_LEVEL: 'silent', LEAD_IMPORT_ENABLED: false },
}));

const mongoose = (await import('mongoose')).default;

const {
  ALL_ORGANIZATIONS,
  DELETE_TARGETS,
  PRESERVED_COLLECTIONS,
  buildOrganizationLookup,
  classifyRegisteredModels,
  createConversationDataReset,
  parseResetArgs,
  resolveScope,
  scopedFilter,
} = await import('./reset-conversation-data.js');

type ManagedCollection = (typeof DELETE_TARGETS)[number];
type ResetOptions = Parameters<typeof createConversationDataReset>[0];

const ORG_ID = '65b0f0f0f0f0f0f0f0f0f0f1';

const names = (collections: readonly ManagedCollection[]): string[] =>
  collections.map((entry) => entry.name);

describe('the delete and preserve lists', () => {
  it('deletes exactly the lead and conversation collections', () => {
    expect(names(DELETE_TARGETS)).toEqual([
      'Conversation',
      'Message',
      'Contact',
      'ActivityLog',
      'AiBrainApproval',
      'AiDraft',
      'FollowUpTask',
      'Note',
      'LeadSubmission',
      'RealtimeOutboxEvent',
      'IdempotencyRecord',
    ]);
  });

  it('preserves configuration, identity and the audit trail, each named on purpose', () => {
    expect(names(PRESERVED_COLLECTIONS)).toEqual([
      'WhatsAppAuthState',
      'WhatsAppAccount',
      'Organization',
      'User',
      'RefreshSession',
      'AiKnowledge',
      'Stage',
      'Tag',
      'LeadSource',
      'AuditLog',
    ]);
  });

  it('never lists the live WhatsApp session as deletable', () => {
    // Deleting it means re-scanning the QR code on an already re-paired connection. This is the
    // single most damaging thing the script could get wrong, so it gets its own assertion.
    expect(names(DELETE_TARGETS)).not.toContain('WhatsAppAuthState');
    expect(names(PRESERVED_COLLECTIONS)).toContain('WhatsAppAuthState');
  });

  it('never lists the security audit trail as deletable', () => {
    expect(names(DELETE_TARGETS)).not.toContain('AuditLog');
    expect(names(PRESERVED_COLLECTIONS)).toContain('AuditLog');
  });

  it('classifies every model Mongoose has registered', () => {
    // The forcing function. Importing the script registers all of them, so a model added later
    // and left out of both lists fails here rather than being silently skipped in production.
    expect(
      classifyRegisteredModels({ registered: Object.keys(mongoose.models) }),
    ).toEqual({ unclassified: [], conflicting: [], missing: [] });
  });

  it('gives every collection a reason, because the output is what an operator acts on', () => {
    [...DELETE_TARGETS, ...PRESERVED_COLLECTIONS].forEach((entry) => {
      expect(entry.reason.length).toBeGreaterThan(0);
    });
  });
});

describe('classifyRegisteredModels', () => {
  it('reports a registered model that is in neither list', () => {
    expect(
      classifyRegisteredModels({
        registered: ['Conversation', 'Organization', 'Invoice'],
        deleteNames: ['Conversation'],
        preserveNames: ['Organization'],
      }).unclassified,
    ).toEqual(['Invoice']);
  });

  it('reports a model claimed by both lists as a contradiction', () => {
    expect(
      classifyRegisteredModels({
        registered: ['Conversation'],
        deleteNames: ['Conversation'],
        preserveNames: ['Conversation'],
      }).conflicting,
    ).toEqual(['Conversation']);
  });

  it('reports a listed model that no longer exists', () => {
    expect(
      classifyRegisteredModels({
        registered: ['Conversation'],
        deleteNames: ['Conversation', 'OldThing'],
        preserveNames: [],
      }).missing,
    ).toEqual(['OldThing']);
  });
});

describe('parseResetArgs', () => {
  it('is a dry run across every organization with no arguments at all', () => {
    expect(parseResetArgs([])).toEqual({
      apply: false,
      organization: null,
      help: false,
      errors: [],
    });
  });

  it('performs the reset only when --apply is passed', () => {
    expect(parseResetArgs(['--apply']).apply).toBe(true);
  });

  it('accepts --organization in both spellings', () => {
    expect(parseResetArgs(['--organization', 'vistaar']).organization).toBe('vistaar');
    expect(parseResetArgs(['--organization=vistaar']).organization).toBe('vistaar');
  });

  it('refuses an unknown flag instead of ignoring it', () => {
    // The flag most likely to be mistyped is the one that narrows the blast radius: silently
    // dropping `--org vistaar` would turn a one-organization reset into every organization.
    const parsed = parseResetArgs(['--org', 'vistaar', '--apply']);

    expect(parsed.errors).toContain('Unrecognised argument: --org');
    expect(parsed.errors).toContain('Unrecognised argument: vistaar');
  });

  it('refuses --organization with no value, rather than treating the next flag as the value', () => {
    expect(parseResetArgs(['--organization', '--apply']).errors).toHaveLength(1);
    expect(parseResetArgs(['--organization']).errors).toHaveLength(1);
    expect(parseResetArgs(['--organization=']).errors).toHaveLength(1);
  });

  it('reads both options together', () => {
    expect(parseResetArgs(['--organization', 'vistaar', '--apply'])).toEqual({
      apply: true,
      organization: 'vistaar',
      help: false,
      errors: [],
    });
  });

  it('understands --help', () => {
    expect(parseResetArgs(['--help']).help).toBe(true);
    expect(parseResetArgs(['-h']).help).toBe(true);
  });
});

describe('organization scoping', () => {
  it('looks an organization up by id when the value is one, and by slug otherwise', () => {
    expect(buildOrganizationLookup(ORG_ID)).toEqual({ _id: ORG_ID });
    expect(buildOrganizationLookup('  Vistaar  ')).toEqual({ slug: 'vistaar' });
  });

  it('scopes a collection on organizationId, and Organization on its own _id', () => {
    const scope = { organizationId: ORG_ID, label: 'organization vistaar' };

    expect(scopedFilter({ scopeField: 'organizationId' }, scope)).toEqual({
      organizationId: ORG_ID,
    });
    expect(scopedFilter({ scopeField: '_id' }, scope)).toEqual({ _id: ORG_ID });
  });

  it('uses an empty filter - every organization - only when none was asked for', () => {
    expect(scopedFilter({ scopeField: 'organizationId' }, ALL_ORGANIZATIONS)).toEqual({});
  });

  it('resolves a slug that exists', async () => {
    const organizationModel = {
      findOne: vi.fn(async () => ({ _id: ORG_ID, slug: 'vistaar' })),
      find: vi.fn(async () => []),
    };

    await expect(resolveScope('vistaar', organizationModel)).resolves.toEqual({
      organizationId: ORG_ID,
      label: `organization vistaar (${ORG_ID})`,
    });
  });

  it('throws on a slug that matches nothing, rather than falling through to every organization', async () => {
    const organizationModel = {
      findOne: vi.fn(async () => null),
      find: vi.fn(async () => [{ slug: 'vistaar' }, { slug: 'acme' }]),
    };

    await expect(resolveScope('vistar', organizationModel)).rejects.toThrow(
      'No organization matches "vistar". Known slugs: acme, vistaar.',
    );
  });

  it('returns the every-organization scope when no --organization was given', async () => {
    const organizationModel = {
      findOne: vi.fn(async () => null),
      find: vi.fn(async () => []),
    };

    await expect(resolveScope(null, organizationModel)).resolves.toEqual(ALL_ORGANIZATIONS);
    expect(organizationModel.findOne).not.toHaveBeenCalled();
  });
});

/** A stand-in collection that remembers what it was asked, and never talks to a database. */
const fakeCollection = (name: string, count: number, scopeField: 'organizationId' | '_id' = 'organizationId') => {
  const deleteMany = vi.fn(async () => ({ deletedCount: count }));
  const countDocuments = vi.fn(async () => count);

  return {
    entry: { name, model: { countDocuments, deleteMany }, scopeField, reason: `${name} reason` },
    countDocuments,
    deleteMany,
  };
};

const buildReset = ({
  deletable = [fakeCollection('Conversation', 3), fakeCollection('Message', 40)],
  preserved = [fakeCollection('WhatsAppAuthState', 7), fakeCollection('LeadSource', 0)],
  registered,
  leadImportEnabled = false,
}: {
  deletable?: ReturnType<typeof fakeCollection>[];
  preserved?: ReturnType<typeof fakeCollection>[];
  registered?: string[];
  leadImportEnabled?: boolean;
} = {}) => {
  const lines: string[] = [];
  const reset = createConversationDataReset({
    deleteTargets: deletable.map((item) => item.entry),
    preservedCollections: preserved.map((item) => item.entry),
    registeredModelNames: () =>
      registered ?? [...deletable, ...preserved].map((item) => item.entry.name),
    config: { LEAD_IMPORT_ENABLED: leadImportEnabled },
    log: (line: string) => lines.push(line),
  } as unknown as ResetOptions);

  return { reset, lines, deletable, preserved, output: () => lines.join('\n') };
};

describe('the reset run', () => {
  it('deletes nothing in a dry run and says what it would have deleted', async () => {
    const harness = buildReset();

    const { plan } = await harness.reset.run({ scope: ALL_ORGANIZATIONS, apply: false });

    harness.deletable.forEach((item) => {
      expect(item.deleteMany).not.toHaveBeenCalled();
      expect(item.countDocuments).toHaveBeenCalled();
    });
    expect(plan.totalDeletable).toBe(43);
    expect(harness.output()).toContain('DRY RUN');
    expect(harness.output()).toContain('Would delete');
    expect(harness.output()).toContain('Nothing was deleted.');
  });

  it('reports the preserved collections in the dry run too, not only the doomed ones', async () => {
    const harness = buildReset();

    await harness.reset.run({ scope: ALL_ORGANIZATIONS, apply: false });

    expect(harness.output()).toContain('WhatsAppAuthState');
    expect(harness.output()).toContain('left untouched');
  });

  it('deletes only the delete list when --apply is given, and never a preserved collection', async () => {
    const harness = buildReset();

    await harness.reset.run({ scope: ALL_ORGANIZATIONS, apply: true });

    harness.deletable.forEach((item) => {
      expect(item.deleteMany).toHaveBeenCalledTimes(1);
    });
    harness.preserved.forEach((item) => {
      expect(item.deleteMany).not.toHaveBeenCalled();
    });
    expect(harness.output()).toContain('Reset complete.');
  });

  it('passes the organization filter to every delete', async () => {
    const harness = buildReset();

    await harness.reset.run({
      scope: { organizationId: ORG_ID, label: 'organization vistaar' },
      apply: true,
    });

    harness.deletable.forEach((item) => {
      expect(item.deleteMany).toHaveBeenCalledWith({ organizationId: ORG_ID });
    });
  });

  it('re-counts the preserved collections afterwards and says they did not move', async () => {
    const harness = buildReset();

    const { ok } = await harness.reset.run({ scope: ALL_ORGANIZATIONS, apply: true });

    expect(ok).toBe(true);
    expect(harness.output()).toContain('all 2 unchanged, including the WhatsApp session');
  });

  it('fails loudly if a preserved count moved during the reset', async () => {
    const session = fakeCollection('WhatsAppAuthState', 7);
    let call = 0;

    session.countDocuments.mockImplementation(async () => {
      call += 1;
      return call === 1 ? 7 : 0;
    });

    const harness = buildReset({ preserved: [session, fakeCollection('LeadSource', 0)] });
    const { ok } = await harness.reset.run({ scope: ALL_ORGANIZATIONS, apply: true });

    expect(ok).toBe(false);
    expect(harness.output()).toContain('PRESERVED DATA CHANGED DURING THE RESET');
    expect(harness.output()).toContain('WhatsAppAuthState: 7 -> 0');
  });

  it('warns that deleting the ledger re-imports every historical row, whenever a source exists', async () => {
    const harness = buildReset({
      preserved: [fakeCollection('WhatsAppAuthState', 7), fakeCollection('LeadSource', 2)],
      leadImportEnabled: true,
    });

    await harness.reset.run({ scope: ALL_ORGANIZATIONS, apply: false });

    expect(harness.output()).toContain('deleting LeadSubmission wipes the import ledger');
    expect(harness.output()).toContain('2 lead source(s) are configured and LEAD_IMPORT_ENABLED=true');
    expect(harness.output()).toContain('re-import EVERY historical row as a brand-new lead');
  });

  it('still warns when importing is currently switched off, because that is one toggle away', async () => {
    const harness = buildReset({
      preserved: [fakeCollection('WhatsAppAuthState', 7), fakeCollection('LeadSource', 1)],
      leadImportEnabled: false,
    });

    await harness.reset.run({ scope: ALL_ORGANIZATIONS, apply: false });

    expect(harness.output()).toContain('deleting LeadSubmission wipes the import ledger');
    expect(harness.output()).toContain('LEAD_IMPORT_ENABLED=false');
  });

  it('says nothing about the ledger when no lead source is configured', async () => {
    const harness = buildReset();

    await harness.reset.run({ scope: ALL_ORGANIZATIONS, apply: false });

    expect(harness.output()).not.toContain('import ledger');
  });

  it('never deletes a model nobody classified, but says so loudly', async () => {
    const harness = buildReset({
      registered: ['Conversation', 'Message', 'WhatsAppAuthState', 'LeadSource', 'Invoice'],
    });

    const { plan } = await harness.reset.run({ scope: ALL_ORGANIZATIONS, apply: true });

    expect(plan.classification.unclassified).toEqual(['Invoice']);
    expect(harness.output()).toContain('MODEL LISTS ARE OUT OF DATE');
    expect(harness.output()).toContain('NOT deleted: Invoice');
    // Nothing outside the delete list was touched: the run only ever calls deleteMany on it.
    expect(harness.deletable.map((item) => item.deleteMany.mock.calls.length)).toEqual([1, 1]);
  });
});
