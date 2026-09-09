import { type Server } from 'node:http';

import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { silenceLibsignalConsole } from './observability/silence-libsignal-console.js';
import { startServer, stopServer } from './server-lifecycle.js';

// Before anything opens a WhatsApp socket: libsignal logs whole session records - ratchet
// private keys included - straight to the console, with no logger to configure. See the module.
silenceLibsignalConsole();

let server: Server | undefined;
let shutdownPromise: Promise<void> | null = null;

const getErrorMessage = (error: unknown): string => {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  return String(error);
};

const shutdown = (signal: string): Promise<void> => {
  if (shutdownPromise) {
    return shutdownPromise;
  }

  shutdownPromise = (async () => {
    logger.info({ signal }, 'Shutting down WAM backend.');

    try {
      await stopServer({ server });

      logger.info('WAM backend shutdown completed.');
    } catch (error: unknown) {
      logger.error({ reason: getErrorMessage(error) }, 'WAM backend shutdown failed.');
      process.exitCode = 1;
    }
  })();

  return shutdownPromise;
};

// Without these the process would die silently on a stray rejection, taking
// every live WhatsApp session and SSE client with it and leaving no record.
process.on('unhandledRejection', (reason: unknown) => {
  logger.error({ reason: getErrorMessage(reason) }, 'Unhandled promise rejection.');
});

process.on('uncaughtException', (error: Error) => {
  logger.fatal({ err: error }, 'Uncaught exception. Shutting down.');
  process.exitCode = 1;
  void shutdown('uncaughtException');
});

try {
  server = await startServer();

  logger.info({ port: env.PORT }, 'WAM backend running.');

  process.once('SIGINT', () => {
    void shutdown('SIGINT');
  });

  process.once('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
} catch (error: unknown) {
  logger.error({ reason: getErrorMessage(error) }, 'Failed to start WAM backend.');
  process.exitCode = 1;
}
