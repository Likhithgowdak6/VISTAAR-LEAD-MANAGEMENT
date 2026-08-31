import { connectDatabase, disconnectDatabase } from '../config/database.js';
import { Contact } from '../modules/contacts/contact.model.js';
import {
  decryptContactEmailFromStorage,
  decryptContactPhoneFromStorage,
  decryptContactProviderJidsFromStorage,
  decryptAccountJidFromStorage,
  decryptAccountPhoneFromStorage,
} from '../modules/privacy/protected-pii.service.js';
import { getCurrentKeyVersion } from '../modules/security/encryption-keyring.service.js';
import { type EncryptedField } from '../modules/security/encrypted-field.schema.js';
import { WhatsAppAccount } from '../modules/whatsapp-accounts/whatsapp-account.model.js';
import { WhatsAppAuthState } from '../modules/whatsapp-auth-states/whatsapp-auth-state.model.js';
import { decryptAuthStatePayloadFromStorage } from '../modules/whatsapp-auth-states/whatsapp-auth-state.repository.js';

const hasEncryptedField = (value: unknown): value is EncryptedField =>
  Boolean(value && typeof value === 'object');

interface FieldInspectResult {
  present: boolean;
  needsRotation: boolean;
  error: boolean;
}

export interface InspectEncryptedFieldParams {
  encryptedField: unknown;
  currentKeyVersion: string;
  decrypt: (encryptedField: EncryptedField) => unknown;
}

const inspectEncryptedField = ({
  encryptedField,
  currentKeyVersion,
  decrypt,
}: InspectEncryptedFieldParams): FieldInspectResult => {
  if (!hasEncryptedField(encryptedField)) {
    return {
      present: false,
      needsRotation: false,
      error: false,
    };
  }

  try {
    decrypt(encryptedField);

    return {
      present: true,
      needsRotation: encryptedField.keyVersion !== currentKeyVersion,
      error: false,
    };
  } catch {
    return {
      present: true,
      needsRotation: false,
      error: true,
    };
  }
};

export interface RotationStats {
  currentKeyVersion: string;
  whatsappAccountRecordsChecked: number;
  contactRecordsChecked: number;
  whatsappAuthStateRecordsChecked: number;
  recordsNeedingRotation: number;
  errors: number;
  writesPerformed: boolean;
}

export interface UpdateRecordStatsParams {
  stats: RotationStats;
  fieldResults: readonly FieldInspectResult[];
}

const updateRecordStats = ({ stats, fieldResults }: UpdateRecordStatsParams): void => {
  const presentResults = fieldResults.filter((result) => result.present);

  if (presentResults.some((result) => result.needsRotation)) {
    stats.recordsNeedingRotation += 1;
  }

  stats.errors += presentResults.filter((result) => result.error).length;
};

export interface InspectWithKeyVersionParams {
  currentKeyVersion: string;
  stats: RotationStats;
}

const inspectWhatsAppAccounts = async ({
  currentKeyVersion,
  stats,
}: InspectWithKeyVersionParams): Promise<void> => {
  const accounts = await WhatsAppAccount.find({})
    .select('+encryptedPhone +encryptedJid')
    .lean()
    .exec();

  stats.whatsappAccountRecordsChecked = accounts.length;

  for (const account of accounts) {
    updateRecordStats({
      stats,
      fieldResults: [
        inspectEncryptedField({
          encryptedField: account.encryptedPhone,
          currentKeyVersion,
          decrypt: decryptAccountPhoneFromStorage as (field: EncryptedField) => unknown,
        }),
        inspectEncryptedField({
          encryptedField: account.encryptedJid,
          currentKeyVersion,
          decrypt: decryptAccountJidFromStorage as (field: EncryptedField) => unknown,
        }),
      ],
    });
  }
};

const inspectContacts = async ({
  currentKeyVersion,
  stats,
}: InspectWithKeyVersionParams): Promise<void> => {
  const contacts = await Contact.find({})
    .select('+encryptedPhone +encryptedEmail +encryptedProviderJids')
    .lean()
    .exec();

  stats.contactRecordsChecked = contacts.length;

  for (const contact of contacts) {
    updateRecordStats({
      stats,
      fieldResults: [
        inspectEncryptedField({
          encryptedField: contact.encryptedPhone,
          currentKeyVersion,
          decrypt: decryptContactPhoneFromStorage as (field: EncryptedField) => unknown,
        }),
        inspectEncryptedField({
          encryptedField: contact.encryptedEmail,
          currentKeyVersion,
          decrypt: decryptContactEmailFromStorage as (field: EncryptedField) => unknown,
        }),
        inspectEncryptedField({
          encryptedField: contact.encryptedProviderJids,
          currentKeyVersion,
          decrypt: decryptContactProviderJidsFromStorage as (field: EncryptedField) => unknown,
        }),
      ],
    });
  }
};

const inspectWhatsAppAuthStates = async ({
  currentKeyVersion,
  stats,
}: InspectWithKeyVersionParams): Promise<void> => {
  const authStates = await WhatsAppAuthState.find({}).select('+encryptedPayload').lean().exec();

  stats.whatsappAuthStateRecordsChecked = authStates.length;

  for (const authState of authStates) {
    updateRecordStats({
      stats,
      fieldResults: [
        inspectEncryptedField({
          encryptedField: authState.encryptedPayload,
          currentKeyVersion,
          decrypt: (encryptedPayload: EncryptedField) =>
            decryptAuthStatePayloadFromStorage({
              namespace: authState.namespace,
              keyId: authState.keyId,
              encryptedPayload,
            } as never),
        }),
      ],
    });
  }
};

export interface PrintSummaryParams {
  logger: Pick<Console, 'log'>;
  stats: RotationStats;
}

const printSummary = ({ logger, stats }: PrintSummaryParams): void => {
  logger.log('Encryption rotation dry-run completed.');
  logger.log(`Current key version: ${stats.currentKeyVersion}`);
  logger.log(`WhatsAppAccount records checked: ${stats.whatsappAccountRecordsChecked}`);
  logger.log(`Contact records checked: ${stats.contactRecordsChecked}`);
  logger.log(`WhatsAppAuthState records checked: ${stats.whatsappAuthStateRecordsChecked}`);
  logger.log(`Records needing rotation: ${stats.recordsNeedingRotation}`);
  logger.log(`Errors: ${stats.errors}`);
  logger.log('No writes were performed.');
};

export interface RunKeyRotationDryRunOptions {
  connect?: boolean;
  logger?: Pick<Console, 'log'>;
}

export const runKeyRotationDryRun = async ({
  connect = true,
  logger = console,
}: RunKeyRotationDryRunOptions = {}): Promise<RotationStats> => {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Encryption rotation dry-run must not run in production.');
  }

  const currentKeyVersion = getCurrentKeyVersion() as string;
  const stats: RotationStats = {
    currentKeyVersion,
    whatsappAccountRecordsChecked: 0,
    contactRecordsChecked: 0,
    whatsappAuthStateRecordsChecked: 0,
    recordsNeedingRotation: 0,
    errors: 0,
    writesPerformed: false,
  };

  if (connect) {
    await connectDatabase();
  }

  try {
    await inspectWhatsAppAccounts({
      currentKeyVersion,
      stats,
    });
    await inspectContacts({
      currentKeyVersion,
      stats,
    });
    await inspectWhatsAppAuthStates({
      currentKeyVersion,
      stats,
    });

    printSummary({
      logger,
      stats,
    });

    return stats;
  } finally {
    if (connect) {
      await disconnectDatabase();
    }
  }
};

if (import.meta.url === `file://${process.argv[1]}`) {
  runKeyRotationDryRun().catch((error: unknown) => {
    console.error('Encryption rotation dry-run failed safely.');
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
