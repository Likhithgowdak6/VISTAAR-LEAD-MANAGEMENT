import { connectDatabase, disconnectDatabase } from '../config/database.js';
import { ACCOUNT_STATUSES } from '../constants/account-statuses.js';
import { Organization } from '../modules/organizations/organization.model.js';
import {
  createAccountRecord,
  findAccountByBrandKey,
} from '../modules/whatsapp-accounts/whatsapp-account.repository.js';
import { serializeWhatsAppAccount } from '../modules/whatsapp-accounts/whatsapp-account.serializer.js';

const POC_BRAND_KEY = 'phase-5-disposable-poc';
const ORGANIZATION_SLUG = process.env.SEED_ORGANIZATION_SLUG ?? 'vistaar-media';

try {
  await connectDatabase();

  const organization = await Organization.findOne({
    slug: ORGANIZATION_SLUG,
  }).exec();

  if (!organization) {
    throw new Error(`Organization not found for slug ${ORGANIZATION_SLUG}. Run seed first.`);
  }

  const existingAccount = await findAccountByBrandKey({
    organizationId: organization._id,
    brandKey: POC_BRAND_KEY,
  } as never);

  const account =
    existingAccount ??
    (await createAccountRecord({
      organizationId: organization._id,
      name: 'Phase 5 Disposable POC',
      description:
        'Disposable-number-only WhatsApp POC account. Do not use client or business-critical numbers.',
      brandKey: POC_BRAND_KEY,
      status: ACCOUNT_STATUSES.PENDING,
      settings: {
        outboundIntervalMs: 5000,
        aiEnabled: false,
      },
    } as never));

  console.log('Phase 5 disposable POC account is ready.');
  console.log('Safe account details:', serializeWhatsAppAccount(account));
  console.log('Set this locally only:');
  console.log(`WHATSAPP_POC_ACCOUNT_ID=${account._id.toString()}`);
  console.log('Do not record or paste any real phone number, QR string, JID or auth payload.');
} finally {
  await disconnectDatabase();
}
