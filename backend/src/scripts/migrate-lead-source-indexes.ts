/**
 * One-off index migration for the Meta Lead Ads source kind.
 *
 * `LeadSource` used to carry a plain unique index on `(organizationId, sheetId, gid)`. A Meta
 * source has no `sheetId`, so under that index every Meta source in an organization would collide
 * on the same all-null key. The model now declares the same key pattern as a *partial* index
 * filtered on `sheetId: { $type: 'string' }`, which covers every sheet source ever written —
 * including the ones that predate the `kind` field — and excludes Meta sources entirely.
 *
 * MongoDB will not change an existing index's options in place: `createIndex` with the same key
 * pattern and different options fails with IndexOptionsConflict, and Mongoose's autoIndex only
 * logs that. So the old index has to be dropped once, after which the application recreates the
 * partial one on its own.
 *
 * Existing sheet sources keep importing throughout: the index is a guard on *creating* a
 * duplicate source, not something the poller reads.
 *
 *   npm run migrate:lead-source-indexes            # report only
 *   npm run migrate:lead-source-indexes -- --apply # drop and rebuild
 */
import { connectDatabase, disconnectDatabase } from '../config/database.js';
import { LeadSource } from '../modules/lead-sources/lead-source.model.js';

const apply = process.argv.includes('--apply');

const LEGACY_SHEET_INDEX_NAME = 'organizationId_1_sheetId_1_gid_1';

interface ExistingIndex {
  name?: string;
  key?: Record<string, unknown>;
  partialFilterExpression?: Record<string, unknown>;
}

const run = async (): Promise<void> => {
  await connectDatabase();

  const collection = LeadSource.collection;
  const indexes = (await collection.indexes()) as ExistingIndex[];
  const legacy = indexes.find((index) => index.name === LEGACY_SHEET_INDEX_NAME);

  if (!legacy) {
    console.log(`No ${LEGACY_SHEET_INDEX_NAME} index found — nothing to migrate.`);
  } else if (legacy.partialFilterExpression) {
    console.log(`${LEGACY_SHEET_INDEX_NAME} is already partial — nothing to migrate.`);
  } else if (!apply) {
    console.log(
      `${LEGACY_SHEET_INDEX_NAME} exists without a partial filter. Re-run with --apply to drop it.`,
    );
  } else {
    await collection.dropIndex(LEGACY_SHEET_INDEX_NAME);
    console.log(`Dropped ${LEGACY_SHEET_INDEX_NAME}.`);
  }

  if (apply) {
    // Recreates both partial indexes exactly as the model declares them.
    await LeadSource.syncIndexes();
    console.log('Rebuilt LeadSource indexes from the model.');
  }

  const after = (await collection.indexes()) as ExistingIndex[];
  after.forEach((index) => {
    console.log(`  ${index.name ?? '(unnamed)'} ${JSON.stringify(index.key ?? {})}`);
  });

  await disconnectDatabase();
};

run().catch(async (error: unknown) => {
  const err = error as { name?: string; message?: string };
  console.error('Lead source index migration failed.', { name: err?.name, message: err?.message });
  await disconnectDatabase().catch(() => {});
  process.exitCode = 1;
});
