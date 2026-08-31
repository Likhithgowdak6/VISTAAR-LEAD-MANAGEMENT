import { createInboundMessageIngestionService } from '../ingestion/inbound-message.service.js';
import {
  createWhatsAppSessionManager,
  type WhatsAppSessionManager,
} from './session-manager.service.js';

let instance: WhatsAppSessionManager | null = null;

/**
 * Lazily-created, process-wide session manager. `setSessionManager` lets tests inject a fake
 * so the account API can be exercised without opening real WhatsApp sockets.
 */
export const getSessionManager = (): WhatsAppSessionManager => {
  if (!instance) {
    instance = createWhatsAppSessionManager({
      inboundMessageService: createInboundMessageIngestionService(),
    });
  }

  return instance;
};

export const setSessionManager = (nextManager: WhatsAppSessionManager | null) => {
  instance = nextManager;
};
