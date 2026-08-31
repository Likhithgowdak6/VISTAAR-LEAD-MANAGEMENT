import { connectDatabase, disconnectDatabase } from '../config/database.js';
import { createSingleSessionService } from '../modules/whatsapp/sessions/single-session.service.js';

const service = createSingleSessionService();

let shuttingDown = false;

const shutdown = async (signal: string): Promise<void> => {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;

  console.log(`${signal} received. Stopping Phase 5 single WhatsApp session safely.`);

  try {
    await service.stopSingleSession({
      disconnectCode: 'local_script_shutdown',
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

await connectDatabase();

const result = await service.startSingleSession();

console.log('Phase 5 single WhatsApp session start requested.');
console.log('Safe runtime session:', result.session);
console.log(
  'Use only disposable number POC-WhatsApp-01. Do not paste QR/JID/phone/auth payload into chat or evidence.',
);
console.log('Press Ctrl+C to stop this local POC session.');

setInterval(() => {
  const session = service.inspectSingleSession();
  console.log('Phase 5 safe session heartbeat:', session);
}, 30000);
