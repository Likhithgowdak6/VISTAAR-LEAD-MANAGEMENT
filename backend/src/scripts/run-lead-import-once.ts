/**
 * One-shot lead import against the local database. Runs the same `drain()` the background
 * runner calls, so it exercises the real fetch → parse → map → import path without waiting for
 * (or enabling) the poll interval.
 */
import { connectDatabase, disconnectDatabase } from '../config/database.js';
import { createLeadImportService } from '../modules/lead-sources/lead-import.service.js';

const main = async () => {
  await connectDatabase();

  const counts = await createLeadImportService().drain();

  console.log('Lead import finished:', counts);

  await disconnectDatabase();
};

main().catch(async (error: unknown) => {
  console.error('Lead import failed:', error);
  await disconnectDatabase();
  process.exitCode = 1;
});
