import { type Express } from 'express';
import { type Server } from 'node:http';

import app from './app.js';
import { connectDatabase, disconnectDatabase } from './config/database.js';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { connectRedis, disconnectRedis } from './config/redis.js';
import { createAutoGreetRunner } from './modules/ai-brain/auto-greet-runner.js';
import {
  createBookingCountdownRunner,
  createDigestRunner,
  createMorningReadRunner,
} from './modules/ai-brain/daily-jobs-runner.js';
import { createEventReminderRunner } from './modules/ai-brain/event-reminder-runner.js';
import { createNurtureRunner } from './modules/ai-brain/nurture-runner.js';
import { createOwnerCallEscalationRunner } from './modules/ai-brain/owner-call-escalation-runner.js';
import { createLeadImportRunner } from './modules/lead-sources/lead-import.runner.js';
import {
  startRealtimeSubscriber,
  stopRealtimeSubscriber,
} from './modules/realtime/realtime.hub.js';
import { createRealtimeOutboxRunner } from './modules/realtime/realtime-outbox.runner.js';
import { createDeliveryRunner } from './modules/whatsapp/delivery/delivery-runner.js';
import { getSessionManager } from './modules/whatsapp/sessions/session-manager.instance.js';

interface BackgroundRunnerHandle {
  start: () => boolean;
  stop: () => void;
}

let deliveryRunner: BackgroundRunnerHandle | null = null;
let realtimeOutboxRunner: BackgroundRunnerHandle | null = null;
let leadImportRunner: BackgroundRunnerHandle | null = null;
let nurtureRunner: BackgroundRunnerHandle | null = null;
let morningReadRunner: BackgroundRunnerHandle | null = null;
let digestRunner: BackgroundRunnerHandle | null = null;
let bookingCountdownRunner: BackgroundRunnerHandle | null = null;
let autoGreetRunner: BackgroundRunnerHandle | null = null;
let eventReminderRunner: BackgroundRunnerHandle | null = null;
let ownerCallEscalationRunner: BackgroundRunnerHandle | null = null;

export interface ListenForRequestsParams {
  appInstance: Express;
  port: number;
}

const listenForRequests = ({ appInstance, port }: ListenForRequestsParams): Promise<Server> =>
  new Promise((resolve, reject) => {
    const handleError = (error: Error) => {
      reject(error);
    };

    const server = appInstance.listen(port, () => {
      server.off('error', handleError);
      resolve(server);
    });

    server.once('error', handleError);
  });

const closeHttpServer = (server: Server | null | undefined): Promise<void> =>
  new Promise((resolve, reject) => {
    if (!server || !server.listening) {
      resolve();
      return;
    }

    server.close((error?: Error | null) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });

export interface DisconnectDependenciesParams {
  disconnectDatabaseFn: () => Promise<unknown>;
  disconnectRedisFn: () => Promise<unknown>;
}

const disconnectDependencies = async ({
  disconnectDatabaseFn,
  disconnectRedisFn,
}: DisconnectDependenciesParams): Promise<void> => {
  const results = await Promise.allSettled([disconnectRedisFn(), disconnectDatabaseFn()]);

  const failedResult = results.find((result) => result.status === 'rejected');

  if (failedResult && failedResult.status === 'rejected') {
    throw failedResult.reason;
  }
};

export interface StartServerParams {
  appInstance?: Express;
  port?: number;
  connectDatabaseFn?: () => Promise<unknown>;
  connectRedisFn?: () => Promise<unknown>;
  disconnectDatabaseFn?: () => Promise<unknown>;
  disconnectRedisFn?: () => Promise<unknown>;
  startRealtimeSubscriberFn?: () => Promise<unknown>;
  stopRealtimeSubscriberFn?: () => Promise<unknown>;
  createRealtimeOutboxRunnerFn?: () => BackgroundRunnerHandle;
  createDeliveryRunnerFn?: () => BackgroundRunnerHandle;
  createLeadImportRunnerFn?: () => BackgroundRunnerHandle;
  createNurtureRunnerFn?: () => BackgroundRunnerHandle;
  createMorningReadRunnerFn?: () => BackgroundRunnerHandle;
  createDigestRunnerFn?: () => BackgroundRunnerHandle;
  createBookingCountdownRunnerFn?: () => BackgroundRunnerHandle;
  createAutoGreetRunnerFn?: () => BackgroundRunnerHandle;
  createEventReminderRunnerFn?: () => BackgroundRunnerHandle;
  createOwnerCallEscalationRunnerFn?: () => BackgroundRunnerHandle;
  reconnectSessionsFn?: () => Promise<unknown>;
  stopSessionsFn?: () => Promise<unknown>;
}

export const startServer = async ({
  appInstance = app,
  port = env.PORT,
  connectDatabaseFn = connectDatabase,
  connectRedisFn = connectRedis,
  disconnectDatabaseFn = disconnectDatabase,
  disconnectRedisFn = disconnectRedis,
  startRealtimeSubscriberFn = startRealtimeSubscriber,
  stopRealtimeSubscriberFn = stopRealtimeSubscriber,
  createRealtimeOutboxRunnerFn = createRealtimeOutboxRunner,
  createDeliveryRunnerFn = createDeliveryRunner,
  createLeadImportRunnerFn = createLeadImportRunner,
  createNurtureRunnerFn = createNurtureRunner,
  createMorningReadRunnerFn = createMorningReadRunner,
  createDigestRunnerFn = createDigestRunner,
  createBookingCountdownRunnerFn = createBookingCountdownRunner,
  createAutoGreetRunnerFn = createAutoGreetRunner,
  createEventReminderRunnerFn = createEventReminderRunner,
  createOwnerCallEscalationRunnerFn = createOwnerCallEscalationRunner,
  reconnectSessionsFn = () => getSessionManager().reconnectPersistedSessions(),
  stopSessionsFn = () => getSessionManager().stopAll(),
}: StartServerParams = {}): Promise<Server> => {
  const rollbackSteps: (() => Promise<unknown> | unknown)[] = [
    disconnectDatabaseFn,
    disconnectRedisFn,
  ];

  try {
    await connectDatabaseFn();
    await connectRedisFn();
    rollbackSteps.push(stopRealtimeSubscriberFn);
    await startRealtimeSubscriberFn();

    realtimeOutboxRunner?.stop();
    const startedRealtimeOutboxRunner = createRealtimeOutboxRunnerFn();
    realtimeOutboxRunner = startedRealtimeOutboxRunner;
    rollbackSteps.push(() => {
      startedRealtimeOutboxRunner.stop();
      if (realtimeOutboxRunner === startedRealtimeOutboxRunner) {
        realtimeOutboxRunner = null;
      }
    });
    startedRealtimeOutboxRunner.start();

    const startedDeliveryRunner = createDeliveryRunnerFn();
    deliveryRunner = startedDeliveryRunner;
    rollbackSteps.push(() => {
      startedDeliveryRunner.stop();
      if (deliveryRunner === startedDeliveryRunner) {
        deliveryRunner = null;
      }
    });
    startedDeliveryRunner.start();

    const startedLeadImportRunner = createLeadImportRunnerFn();
    leadImportRunner = startedLeadImportRunner;
    rollbackSteps.push(() => {
      startedLeadImportRunner.stop();
      if (leadImportRunner === startedLeadImportRunner) {
        leadImportRunner = null;
      }
    });
    startedLeadImportRunner.start();

    const startedNurtureRunner = createNurtureRunnerFn();
    nurtureRunner = startedNurtureRunner;
    rollbackSteps.push(() => {
      startedNurtureRunner.stop();
      if (nurtureRunner === startedNurtureRunner) {
        nurtureRunner = null;
      }
    });
    startedNurtureRunner.start();

    const startedMorningReadRunner = createMorningReadRunnerFn();
    morningReadRunner = startedMorningReadRunner;
    rollbackSteps.push(() => {
      startedMorningReadRunner.stop();
      if (morningReadRunner === startedMorningReadRunner) {
        morningReadRunner = null;
      }
    });
    startedMorningReadRunner.start();

    const startedDigestRunner = createDigestRunnerFn();
    digestRunner = startedDigestRunner;
    rollbackSteps.push(() => {
      startedDigestRunner.stop();
      if (digestRunner === startedDigestRunner) {
        digestRunner = null;
      }
    });
    startedDigestRunner.start();

    const startedBookingCountdownRunner = createBookingCountdownRunnerFn();
    bookingCountdownRunner = startedBookingCountdownRunner;
    rollbackSteps.push(() => {
      startedBookingCountdownRunner.stop();
      if (bookingCountdownRunner === startedBookingCountdownRunner) {
        bookingCountdownRunner = null;
      }
    });
    startedBookingCountdownRunner.start();

    const startedAutoGreetRunner = createAutoGreetRunnerFn();
    autoGreetRunner = startedAutoGreetRunner;
    rollbackSteps.push(() => {
      startedAutoGreetRunner.stop();
      if (autoGreetRunner === startedAutoGreetRunner) {
        autoGreetRunner = null;
      }
    });
    startedAutoGreetRunner.start();

    const startedEventReminderRunner = createEventReminderRunnerFn();
    eventReminderRunner = startedEventReminderRunner;
    rollbackSteps.push(() => {
      startedEventReminderRunner.stop();
      if (eventReminderRunner === startedEventReminderRunner) {
        eventReminderRunner = null;
      }
    });
    startedEventReminderRunner.start();

    const startedOwnerCallEscalationRunner = createOwnerCallEscalationRunnerFn();
    ownerCallEscalationRunner = startedOwnerCallEscalationRunner;
    rollbackSteps.push(() => {
      startedOwnerCallEscalationRunner.stop();
      if (ownerCallEscalationRunner === startedOwnerCallEscalationRunner) {
        ownerCallEscalationRunner = null;
      }
    });
    startedOwnerCallEscalationRunner.start();

    // Restore sessions for accounts that were connected before the process stopped. Best-effort:
    // a reconnect failure must never prevent the server from coming up.
    rollbackSteps.push(stopSessionsFn);
    try {
      await reconnectSessionsFn();
    } catch (error: unknown) {
      const errorRecord =
        error && typeof error === 'object' ? (error as { code?: unknown; name?: unknown }) : {};

      logger.error(
        { code: errorRecord.code, name: errorRecord.name },
        'Startup session reconnect failed safely.',
      );
    }

    return await listenForRequests({
      appInstance,
      port,
    });
  } catch (error) {
    for (const rollback of rollbackSteps.reverse()) {
      try {
        await rollback();
      } catch {
        // Preserve the startup failure while still attempting every remaining rollback.
      }
    }

    throw error;
  }
};

export interface StopServerParams {
  server?: Server | null;
  disconnectDatabaseFn?: () => Promise<unknown>;
  disconnectRedisFn?: () => Promise<unknown>;
  stopRealtimeSubscriberFn?: () => Promise<unknown>;
}

export const stopServer = async ({
  server,
  disconnectDatabaseFn = disconnectDatabase,
  disconnectRedisFn = disconnectRedis,
  stopRealtimeSubscriberFn = stopRealtimeSubscriber,
}: StopServerParams = {}): Promise<void> => {
  let httpServerError: unknown = null;

  try {
    ownerCallEscalationRunner?.stop();
    ownerCallEscalationRunner = null;
    eventReminderRunner?.stop();
    eventReminderRunner = null;
    digestRunner?.stop();
    digestRunner = null;

    bookingCountdownRunner?.stop();
    bookingCountdownRunner = null;

    autoGreetRunner?.stop();
    autoGreetRunner = null;
    morningReadRunner?.stop();
    morningReadRunner = null;
    nurtureRunner?.stop();
    nurtureRunner = null;
    leadImportRunner?.stop();
    leadImportRunner = null;
    deliveryRunner?.stop();
    deliveryRunner = null;
    realtimeOutboxRunner?.stop();
    realtimeOutboxRunner = null;
    await getSessionManager().stopAll();
    await stopRealtimeSubscriberFn();
    await closeHttpServer(server);
  } catch (error) {
    httpServerError = error;
  }

  let dependencyError: unknown = null;

  try {
    await disconnectDependencies({
      disconnectDatabaseFn,
      disconnectRedisFn,
    });
  } catch (error) {
    dependencyError = error;
  }

  if (httpServerError) {
    throw httpServerError;
  }

  if (dependencyError) {
    throw dependencyError;
  }
};
