import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

import { connectDatabase, disconnectDatabase } from '../config/database.js';
import { createSingleSessionService } from '../modules/whatsapp/sessions/single-session.service.js';

const normalizeLocalPairingPhoneNumber = (phoneNumber: unknown): string => {
  const normalizedPhoneNumber = String(phoneNumber ?? '')
    .trim()
    .replace(/^\+/, '')
    .replace(/[\s()-]/g, '');

  if (!/^\d{8,15}$/.test(normalizedPhoneNumber)) {
    throw new Error(
      'Invalid pairing phone number. Use country code + number as digits only, for example 919876543210.',
    );
  }

  return normalizedPhoneNumber;
};

const service = createSingleSessionService();

let shuttingDown = false;

const shutdown = async (signal: string): Promise<void> => {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;

  console.log(`${signal} received. Stopping Phase 5 pairing-code session safely.`);

  try {
    await service.stopSingleSession({
      disconnectCode: 'local_pairing_code_script_shutdown',
    } as never);
  } finally {
    await disconnectDatabase();
    process.exit(0);
  }
};

process.on('SIGINT', () => {
  void shutdown('SIGINT');
});
process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});

const readlineInterface = readline.createInterface({
  input,
  output,
});

console.log('Phase 5 pairing-code login is local-only.');
console.log('Use only POC-WhatsApp-01.');
console.log('Do not paste the phone number or pairing code into chat or evidence.');

const phoneNumberInput = await readlineInterface.question(
  'Enter POC phone with country code, digits only, no plus sign: ',
);

readlineInterface.close();

const pairingPhoneNumber = normalizeLocalPairingPhoneNumber(phoneNumberInput);

await connectDatabase();

const result = await service.startSingleSession({
  pairingPhoneNumber,
  qrOutput: 'none',
  pairingCodeRequestDelayMs: 5000,
  onPairingCode: async () => {
    console.log('Pairing code was requested successfully.');
    console.log('Enter it on the disposable WhatsApp phone under Linked devices.');
  },
  onPairingCodeError: async ({ error }: { error?: unknown } = {}) => {
    console.log('Pairing code request failed safely.');
    console.log('Safe error summary:', error);
    console.log('Do not paste phone, pairing code, JID, auth payload or raw provider logs.');
  },
} as never);

console.log('Phase 5 pairing-code WhatsApp session start requested.');
console.log('Safe runtime session:', result.session);
console.log('Phone number was used only locally for WhatsApp pairing-code request.');
console.log('Do not paste phone, pairing code, JID or auth payload into chat or evidence.');
console.log('Press Ctrl+C to stop this local POC session.');

setInterval(() => {
  const session = service.inspectSingleSession();
  console.log('Phase 5 safe pairing session heartbeat:', session);
}, 30000);
