import { connectDatabase, disconnectDatabase } from '../config/database.js';
import { env } from '../config/env.js';
import { findAccountById } from '../modules/whatsapp-accounts/whatsapp-account.repository.js';
import { serializeWhatsAppAccount } from '../modules/whatsapp-accounts/whatsapp-account.serializer.js';
import { listAuthStateKeysForAccount } from '../modules/whatsapp-auth-states/whatsapp-auth-state.repository.js';

const getArgValue = (name: string): string | null => {
  const prefix = `--${name}=`;
  const arg = process.argv.find((item) => item.startsWith(prefix));

  return arg ? arg.slice(prefix.length) : null;
};

const accountId = getArgValue('accountId') ?? env.WHATSAPP_POC_ACCOUNT_ID;

if (!accountId) {
  throw new Error('Provide --accountId=<id> or set WHATSAPP_POC_ACCOUNT_ID locally.');
}

try {
  await connectDatabase();

  const account = await findAccountById({
    accountId,
  } as never);

  if (!account) {
    throw new Error('POC account not found.');
  }

  const authStateKeys = (await listAuthStateKeysForAccount({
    organizationId: account.organizationId,
    whatsappAccountId: account._id,
  } as never)) as Array<{
    namespace: string;
    keyId: string;
    status: string;
    lastWrittenAt: Date | null;
  }>;

  console.log('Safe account details:', serializeWhatsAppAccount(account));
  console.log(
    'Encrypted auth-state key summary:',
    authStateKeys.map((key) => ({
      namespace: key.namespace,
      keyId: key.keyId,
      status: key.status,
      lastWrittenAt: key.lastWrittenAt,
    })),
  );
  console.log('No auth payload, phone, JID or QR was printed.');
} finally {
  await disconnectDatabase();
}
