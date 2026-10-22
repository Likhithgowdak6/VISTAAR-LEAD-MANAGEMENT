/**
 * The safety guard, tested WITHOUT a database.
 *
 * Deliberately a `.test.ts` and therefore part of the ordinary mocked suite, not the staged
 * integration run. The guard is what stands between a suite that deletes real documents and
 * somebody's development or production data, so it must be known-good before any server exists -
 * proving it only when MongoDB happens to be up would be proving it exactly when it no longer
 * matters.
 *
 * `assertSafeIntegrationUri` is pure, so every case below is a string. Nothing here connects to
 * anything.
 */
import { describe, expect, it } from 'vitest';

import {
  INTEGRATION_DB_NAME,
  INTEGRATION_MONGO_URI,
  UnsafeIntegrationTargetError,
  assertSafeIntegrationUri,
} from './db.js';

describe('the integration target that IS allowed', () => {
  it('accepts the one hardcoded URI this suite ships with', () => {
    expect(() => assertSafeIntegrationUri(INTEGRATION_MONGO_URI)).not.toThrow();
  });

  it('that URI is loopback, unauthenticated and named for a test database', () => {
    // Pins the constant itself, not just the checker. If somebody edits the URI to point
    // somewhere convenient, this fails before the checker is ever consulted.
    expect(INTEGRATION_MONGO_URI).toContain('127.0.0.1');
    expect(INTEGRATION_MONGO_URI).toContain(`/${INTEGRATION_DB_NAME}`);
    expect(INTEGRATION_MONGO_URI).not.toContain('@');
  });

  it('requires a replica set, because the services under test use transactions', () => {
    // `runInTransaction` uses readConcern "snapshot", which a standalone mongod rejects. A URI
    // without this is a suite that fails confusingly rather than safely.
    expect(INTEGRATION_MONGO_URI).toContain('replicaSet=rs0');
  });

  it('accepts localhost as well as the dotted form', () => {
    expect(() =>
      assertSafeIntegrationUri(`mongodb://localhost:27017/${INTEGRATION_DB_NAME}`),
    ).not.toThrow();
  });
});

describe('targets that must be refused', () => {
  const refused: [string, string][] = [
    ['a remote host', `mongodb://db.internal.example:27017/${INTEGRATION_DB_NAME}`],
    ['a hosted cluster', `mongodb+srv://cluster0.abcd.mongodb.net/${INTEGRATION_DB_NAME}`],
    ['a LAN address', `mongodb://192.168.1.40:27017/${INTEGRATION_DB_NAME}`],
    ['the development database', 'mongodb://127.0.0.1:27017/wam_crm_ai'],
    ['no database at all', 'mongodb://127.0.0.1:27017'],
    ['something unparseable', 'not-a-uri'],
  ];

  for (const [label, uri] of refused) {
    it(`refuses ${label}`, () => {
      expect(() => assertSafeIntegrationUri(uri)).toThrow(UnsafeIntegrationTargetError);
    });
  }

  it('refuses a database whose name merely STARTS with the test name', () => {
    // The check is an exact comparison on purpose. `startsWith` or `includes` would accept
    // `wam_crm_ai_itest_backup` - plausibly somebody's real restore - and delete from it.
    expect(() =>
      assertSafeIntegrationUri(`mongodb://127.0.0.1:27017/${INTEGRATION_DB_NAME}_backup`),
    ).toThrow(/not "wam_crm_ai_itest"/);
  });

  it('refuses the production database even on loopback', () => {
    // An SSH tunnel makes a production cluster look like 127.0.0.1. Loopback alone is not
    // enough, which is why the database name is checked independently.
    expect(() => assertSafeIntegrationUri('mongodb://127.0.0.1:27017/wam_crm_ai_prod')).toThrow(
      UnsafeIntegrationTargetError,
    );
  });

  it('refuses the +srv scheme even when everything else looks local', () => {
    // ISOLATES THE SCHEME RULE. The `mongodb+srv:` case above is also caught by the loopback
    // check, so it cannot prove the scheme check exists. This one is loopback, correctly named
    // and credential-free - only the scheme can refuse it. It matters because +srv discards the
    // host and resolves the real destination through DNS SRV records, so a "127.0.0.1" that
    // reads as local can resolve to a hosted cluster.
    expect(() =>
      assertSafeIntegrationUri(`mongodb+srv://127.0.0.1/${INTEGRATION_DB_NAME}`),
    ).toThrow(/expected the mongodb: scheme/);
  });

  it('refuses a URI carrying credentials', () => {
    // A local disposable database needs no username. One appearing here means a connection
    // string was pasted in from somewhere real.
    expect(() =>
      assertSafeIntegrationUri(`mongodb://admin:hunter2@127.0.0.1:27017/${INTEGRATION_DB_NAME}`),
    ).toThrow(/credentials/);
  });

  it('names what it refused, so a failure is self-explaining', () => {
    expect(() => assertSafeIntegrationUri('mongodb://10.0.0.5:27017/wam_crm_ai_itest')).toThrow(
      /10\.0\.0\.5 is not a loopback address/,
    );
  });
});

/**
 * Two properties of db.ts that no behavioural test can express, because they are about what the
 * file does NOT do. Both are read off the source with comments stripped - the doc comments in
 * db.ts discuss `MONGODB_URI` and `dropDatabase` at length precisely to explain their absence,
 * and a scan that could not tell prose from code would be satisfied by deleting the
 * explanation and keeping the danger.
 */
describe('what db.ts must never contain', () => {
  const codeOf = async (): Promise<string> => {
    const fs = await import('node:fs/promises');
    const source = await fs.readFile(new URL('./db.ts', import.meta.url), 'utf8');

    return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  };

  it('never reads the application’s own connection string', async () => {
    // THE RULE THAT MAKES THE REST SAFE. If this module read the env var, a developer with a
    // production URI in their shell would point the whole suite at it without touching a file.
    const code = await codeOf();

    expect(code).not.toContain('MONGODB_URI');
    expect(code).not.toContain('process.env');
    expect(code).not.toContain('connectDatabase(');
  });

  it('never drops a database or a collection', async () => {
    // "Cleanup deletes only this run's records" is the claim the whole design rests on. A
    // future edit adding a convenient dropDatabase would otherwise pass every other test here.
    const code = await codeOf();

    expect(code).not.toContain('dropDatabase');
    expect(code).not.toContain('dropCollection');
    expect(code).not.toMatch(/\.drop\(/);
  });

  it('never deletes without an organizationId filter', async () => {
    // Every deleteMany in the file must be scoped to the run. An unfiltered one would empty a
    // collection that may hold a developer's own data.
    const code = await codeOf();
    const deletes = code.match(/deleteMany\([^)]*\)/g) ?? [];

    expect(deletes.length).toBeGreaterThan(0);

    for (const call of deletes) {
      expect(call).toContain('organizationId');
    }
  });
});
