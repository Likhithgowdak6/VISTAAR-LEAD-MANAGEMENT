/**
 * The connection these integration tests are allowed to use, and nothing else.
 *
 * THE WHOLE POINT OF THIS FILE IS THE GUARD. Everything below exists so that a test suite which
 * creates, mutates and deletes real documents cannot - by typo, by a stray environment variable,
 * or by somebody copying a file - be pointed at the development database, let alone production.
 *
 * `MONGODB_URI` IS DELIBERATELY NOT READ. Not from `.env`, not from `process.env`, not through
 * `config/env.ts`. The URI below is a literal, so the destination of these writes is decided
 * here and is visible in one place. `connectDatabase()` from `src/config/database.ts` is
 * likewise never called: it is the function that reads the real URI, and the one way to be sure
 * it cannot fire is to connect with mongoose directly instead.
 *
 * THREE INDEPENDENT CHECKS, and every one of them must pass:
 *   1. the host parses to a loopback address;
 *   2. the database name is EXACTLY the integration database, not merely similar to it;
 *   3. the URI carries no credentials - a username or password in a local test URI means
 *      somebody has pasted something they should not have.
 *
 * CLEANUP IS SCOPED, NEVER WHOLESALE. Each run mints its own organisation id, every document it
 * writes carries that id, and teardown deletes by that id alone. There is no `dropDatabase`, no
 * `dropCollection` and no unfiltered `deleteMany` anywhere in this suite, so a run against a
 * database that happens to hold other data cannot destroy any of it.
 */
import mongoose, { Types } from 'mongoose';

/**
 * The only connection string this suite may use.
 *
 * A replica set is not optional: the services under test call `runInTransaction`, which uses
 * `readConcern: 'snapshot'`, and a standalone `mongod` rejects that. `docker-compose.yml`
 * already starts `mongo:8` with `--replSet rs0` and initiates it from the healthcheck.
 */
export const INTEGRATION_MONGO_URI =
  'mongodb://127.0.0.1:27017/wam_crm_ai_itest?replicaSet=rs0';

/** The one database name that may be written to. Compared exactly, not by prefix. */
export const INTEGRATION_DB_NAME = 'wam_crm_ai_itest';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export class UnsafeIntegrationTargetError extends Error {
  constructor(message: string) {
    super(`Refusing to connect: ${message}`);
    this.name = 'UnsafeIntegrationTargetError';
  }
}

/**
 * Proves a URI points at a local, disposable, credential-free test database.
 *
 * Exported and pure so it can be unit-tested WITHOUT a database - see db.guard.test.ts, which
 * runs in the ordinary mocked suite. The guard is the one piece of this directory that must be
 * known-good before a server exists, because it is what stands between a test run and somebody's
 * real data.
 */
export const assertSafeIntegrationUri = (uri: string): URL => {
  let parsed: URL;

  try {
    parsed = new URL(uri);
  } catch {
    throw new UnsafeIntegrationTargetError('the URI could not be parsed.');
  }

  if (parsed.protocol !== 'mongodb:') {
    // `mongodb+srv:` resolves through DNS and is how every hosted cluster is addressed. It has
    // no business here at all.
    throw new UnsafeIntegrationTargetError(
      `expected the mongodb: scheme, got ${parsed.protocol}`,
    );
  }

  if (!LOOPBACK_HOSTS.has(parsed.hostname)) {
    throw new UnsafeIntegrationTargetError(
      `the host ${parsed.hostname} is not a loopback address.`,
    );
  }

  if (parsed.username !== '' || parsed.password !== '') {
    throw new UnsafeIntegrationTargetError(
      'the URI carries credentials, which a local test database must not need.',
    );
  }

  // `pathname` is "/<db>". Compared exactly: `wam_crm_ai_itest_backup` and `wam_crm_ai` must
  // both be refused, which a `startsWith` or `includes` check would not do.
  const database = parsed.pathname.replace(/^\//, '');

  if (database !== INTEGRATION_DB_NAME) {
    throw new UnsafeIntegrationTargetError(
      `the database is "${database}", not "${INTEGRATION_DB_NAME}".`,
    );
  }

  return parsed;
};

/**
 * A fresh organisation id for this run.
 *
 * Every document the suite writes hangs off it, which is what makes teardown safe: deleting
 * "everything this run created" is expressible as a single, narrow filter rather than as
 * "everything in these collections".
 */
export const newRunOrganizationId = (): Types.ObjectId => new Types.ObjectId();

export const connectIntegrationDatabase = async (): Promise<typeof mongoose> => {
  assertSafeIntegrationUri(INTEGRATION_MONGO_URI);

  if (mongoose.connection.readyState === 1) {
    return mongoose;
  }

  // Short selection timeout so a missing server fails in seconds with a clear message, rather
  // than hanging until vitest's own timeout and reporting something unhelpful.
  await mongoose.connect(INTEGRATION_MONGO_URI, { serverSelectionTimeoutMS: 3000 });

  // Belt and braces: assert what we are ACTUALLY connected to, not what we asked for. A
  // connection reused from elsewhere in the process would be caught here.
  const connectedTo = mongoose.connection.name;

  if (connectedTo !== INTEGRATION_DB_NAME) {
    await mongoose.disconnect();
    throw new UnsafeIntegrationTargetError(
      `connected to "${connectedTo}" instead of "${INTEGRATION_DB_NAME}".`,
    );
  }

  return mongoose;
};

export const disconnectIntegrationDatabase = async (): Promise<void> => {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
};

/**
 * Collections this suite writes to, and therefore the only ones it may delete from.
 *
 * Listed explicitly rather than discovered from `db.listCollections()`: a discovered list would
 * silently grow to include collections this suite never created, which is exactly the blast
 * radius the scoped cleanup exists to prevent.
 */
const OWNED_COLLECTIONS = [
  'conversations',
  'messages',
  'followuptasks',
  'activitylogs',
  'contacts',
  'users',
  'realtimeoutboxevents',
] as const;

/**
 * Deletes only what this run created.
 *
 * Filtered on `organizationId` in every case. A collection that does not exist, or that has no
 * matching documents, is a no-op rather than an error - so a run that failed early still tidies
 * up what it managed to write.
 */
export const cleanupRunData = async (organizationId: Types.ObjectId): Promise<void> => {
  if (mongoose.connection.readyState !== 1) {
    return;
  }

  if (mongoose.connection.name !== INTEGRATION_DB_NAME) {
    throw new UnsafeIntegrationTargetError(
      'cleanup aborted - the live connection is not the integration database.',
    );
  }

  const db = mongoose.connection.db;

  if (!db) {
    return;
  }

  for (const collection of OWNED_COLLECTIONS) {
    await db.collection(collection).deleteMany({ organizationId });
  }
};
