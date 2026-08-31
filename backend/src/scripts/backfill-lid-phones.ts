/**
 * Backfills `encryptedPhone` for contacts that were first seen through an unresolved `@lid`
 * sender, so the audited phone-reveal has something to return for leads that predate
 * LID resolution at ingestion.
 *
 * Resolution order per contact:
 *   1. The Mongo-backed `lid-mapping` keystore, which is what a live Baileys session reads.
 *   2. The Phase 5 local auth-state directory, kept as a fallback because the POC wrote its
 *      mappings to disk before auth state moved into Mongo.
 *
 * Ongoing traffic does not need this — ingestion now resolves the LID itself and fills the gap
 * on the next inbound message. Read-only unless `--apply` is passed.
 *
 *   node src/scripts/backfill-lid-phones.js            # report only
 *   node src/scripts/backfill-lid-phones.js --apply    # write
 */
import fs from 'node:fs';
import path from 'node:path';

import { type Types } from 'mongoose';

import { connectDatabase, disconnectDatabase } from '../config/database.js';
import { Contact } from '../modules/contacts/contact.model.js';
import { attachContactPhoneIfMissing } from '../modules/contacts/contact.repository.js';
import {
  decryptContactProviderJidsFromStorage,
  extractPhoneFromJid,
} from '../modules/privacy/protected-pii.service.js';
import {
  WHATSAPP_AUTH_STATE_NAMESPACES,
  WhatsAppAuthState,
} from '../modules/whatsapp-auth-states/whatsapp-auth-state.model.js';
import { decryptAuthStatePayloadFromStorage } from '../modules/whatsapp-auth-states/whatsapp-auth-state.repository.js';

const LOCAL_AUTH_DIR = '.phase5-local-auth';

const apply = process.argv.includes('--apply');

const maskPhone = (phone: unknown): string =>
  typeof phone === 'string' && phone.length > 6
    ? `${phone.slice(0, 4)}****${phone.slice(-2)}`
    : '****';

const lidUserOf = (jid: unknown): string | null => {
  const value = String(jid ?? '').trim();
  return value.endsWith('@lid') ? (value.slice(0, -'@lid'.length).split(':')[0] ?? null) : null;
};

export interface ResolveFromAuthStateParams {
  organizationId: Types.ObjectId;
  lidUser: string;
}

/**
 * Reads the reverse mapping Baileys keeps in the Mongo auth-state store. Baileys asks for
 * `keys.get('lid-mapping', ['<lidUser>_reverse'])`, which the adapter stores under the `keys`
 * namespace as `lid-mapping:<lidUser>_reverse`. Any account in the org may hold the mapping.
 */
const resolveFromAuthState = async ({
  organizationId,
  lidUser,
}: ResolveFromAuthStateParams): Promise<string | null> => {
  const namespace = WHATSAPP_AUTH_STATE_NAMESPACES.KEYS;
  const keyId = `lid-mapping:${lidUser}_reverse`;

  const record = await WhatsAppAuthState.findOne({ organizationId, namespace, keyId })
    .select('+encryptedPayload')
    .exec();

  if (!record) {
    return null;
  }

  try {
    const payload = decryptAuthStatePayloadFromStorage({
      namespace: record.namespace,
      keyId: record.keyId,
      encryptedPayload: record.encryptedPayload,
    } as never);

    return typeof payload === 'string' ? payload : null;
  } catch {
    return null;
  }
};

/** Falls back to the Phase 5 on-disk mapping written by the original POC session. */
const resolveFromLocalFiles = (lidUser: string): string | null => {
  const file = path.join(LOCAL_AUTH_DIR, `lid-mapping-${lidUser}_reverse.json`);

  if (!fs.existsSync(file)) {
    return null;
  }

  try {
    const value: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
};

const run = async (): Promise<void> => {
  await connectDatabase();

  const contacts = await Contact.find({
    source: 'whatsapp',
    $or: [{ encryptedPhone: null }, { encryptedPhone: { $exists: false } }],
  })
    .select('+encryptedPhone +encryptedProviderJids leadId displayName organizationId')
    .exec();

  console.log(`Contacts missing a phone: ${contacts.length}`);
  console.log(apply ? 'Mode: APPLY (writing)\n' : 'Mode: DRY RUN (use --apply to write)\n');

  let resolved = 0;
  let written = 0;

  for (const contact of contacts) {
    let jids: unknown[];

    try {
      jids =
        (decryptContactProviderJidsFromStorage(contact.encryptedProviderJids) as
          unknown[] | null | undefined) ?? [];
    } catch {
      console.log(
        `${contact.leadId} | ${contact.displayName} | provider JIDs unreadable — skipped`,
      );
      continue;
    }

    const lidUser = jids.map(lidUserOf).find(Boolean);

    if (!lidUser) {
      console.log(`${contact.leadId} | ${contact.displayName} | no @lid JID — skipped`);
      continue;
    }

    const pnJid =
      (await resolveFromAuthState({ organizationId: contact.organizationId, lidUser })) ??
      resolveFromLocalFiles(lidUser);
    // The mapping stores a bare phone or a device-suffixed JID; both normalize through here.
    const phone = extractPhoneFromJid(
      pnJid?.includes('@') ? pnJid : pnJid ? `${pnJid}@s.whatsapp.net` : null,
    ) as string | null | undefined;

    if (!phone) {
      console.log(`${contact.leadId} | ${contact.displayName} | no mapping for LID — skipped`);
      continue;
    }

    resolved += 1;

    if (!apply) {
      console.log(`${contact.leadId} | ${contact.displayName} | would set ${maskPhone(phone)}`);
      continue;
    }

    const updated = await attachContactPhoneIfMissing({
      contactId: contact._id,
      organizationId: contact.organizationId,
      phone,
    } as never);

    if (updated) {
      written += 1;
      console.log(`${contact.leadId} | ${contact.displayName} | set ${maskPhone(phone)}`);
    } else {
      console.log(`${contact.leadId} | ${contact.displayName} | already had a phone — untouched`);
    }
  }

  console.log(
    `\nResolvable: ${resolved}/${contacts.length}${apply ? ` | written: ${written}` : ''}`,
  );

  await disconnectDatabase();
};

run().catch(async (error: unknown) => {
  const err = error as { name?: string; message?: string };
  console.error('Backfill failed.', { name: err?.name, message: err?.message });
  await disconnectDatabase().catch(() => {});
  process.exitCode = 1;
});
