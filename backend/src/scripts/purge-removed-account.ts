/**
 * Permanently deletes an ALREADY SOFT-REMOVED WhatsApp account and everything it owns.
 *
 * Why this exists as a script rather than a button: a soft-removed account is hidden from the
 * accounts list by design (twice - once in the API, once in the browser), so there is nothing
 * left to click Remove on. Numbers removed before the "delete its history too" checkbox shipped
 * are stranded in exactly that state, holding their brand key hostage, and this is the way out.
 *
 * It reuses `purgeAccountData` and `hardDeleteAccount` - the same two functions the checkbox
 * calls - rather than hand-rolling deletes, so there is one definition of what "everything it
 * owns" means and no chance of the script and the button disagreeing.
 *
 * Refuses to touch an account that is not already `removed`. A live number must go through the
 * app, where the session is closed first and the action is audited.
 *
 *   npx tsx src/scripts/purge-removed-account.ts <organization-slug> <brand-key>
 *   npx tsx src/scripts/purge-removed-account.ts <organization-slug> <brand-key> --dry-run
 *
 * IRREVERSIBLE. Take a database dump first.
 */
import { connectDatabase, disconnectDatabase } from '../config/database.js';
import { ACCOUNT_STATUSES } from '../constants/account-statuses.js';
import { Organization } from '../modules/organizations/organization.model.js';
import {
  countAccountReferences,
  findAccountByBrandKey,
  hardDeleteAccount,
  purgeAccountData,
} from '../modules/whatsapp-accounts/whatsapp-account.repository.js';

const [organizationSlug, brandKey, ...flags] = process.argv.slice(2);
const dryRun = flags.includes('--dry-run');

if (!organizationSlug || !brandKey) {
  console.error(
    'Usage: npx tsx src/scripts/purge-removed-account.ts <organization-slug> <brand-key> [--dry-run]',
  );
  process.exit(1);
}

try {
  await connectDatabase();

  const organization = await Organization.findOne({ slug: organizationSlug }).exec();

  if (!organization) {
    throw new Error(`No organization with slug "${organizationSlug}".`);
  }

  const account = await findAccountByBrandKey({
    organizationId: organization._id,
    brandKey,
  });

  if (!account) {
    throw new Error(`No WhatsApp account with brand key "${brandKey}" in ${organizationSlug}.`);
  }

  if (account.status !== ACCOUNT_STATUSES.REMOVED) {
    throw new Error(
      `"${brandKey}" is ${account.status}, not removed. Remove it from the app first - that closes the live session and writes an audit entry.`,
    );
  }

  const references = await countAccountReferences({
    accountId: account._id,
    organizationId: organization._id,
  });

  console.log(`Account : ${account.name} (${account.brandKey})  id=${account._id.toString()}`);
  console.log(`Removed : ${account.removedAt?.toISOString() ?? 'unknown'}`);
  console.log(
    `Owns    : ${references.conversations} conversations, ${references.messages} messages, ${references.leadSources} lead sources`,
  );

  if (dryRun) {
    console.log('\n--dry-run: nothing was deleted.');
  } else {
    const purged = await purgeAccountData({
      accountId: account._id,
      organizationId: organization._id,
    });
    const deletion = await hardDeleteAccount({
      accountId: account._id,
      organizationId: organization._id,
    });

    console.log('\nDeleted:');
    Object.entries(purged)
      .filter(([key]) => key !== 'total')
      .forEach(([key, count]) => console.log(`  ${key.padEnd(16)} ${count}`));
    console.log(`  ${'authStates'.padEnd(16)} ${deletion.deletedAuthStates}`);
    console.log(`  ${'account'.padEnd(16)} ${deletion.deletedAccounts}`);
    console.log(`\nBrand key "${brandKey}" is now free.`);
  }
} catch (error: unknown) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await disconnectDatabase();
}
