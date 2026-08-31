import express, { type Request, type Response } from 'express';
import qrcode from 'qrcode';

import { connectDatabase, disconnectDatabase } from '../config/database.js';
import { connectRedis, disconnectRedis } from '../config/redis.js';
import { env } from '../config/env.js';
import { createOutboundDeliveryService } from '../modules/whatsapp/delivery/outbound-delivery.service.js';
import { createInboundMessageIngestionService } from '../modules/whatsapp/ingestion/inbound-message.service.js';
import { createBaileysProvider } from '../modules/whatsapp/providers/baileys.provider.js';
import { createSingleSessionService } from '../modules/whatsapp/sessions/single-session.service.js';

const app = express();
app.use(express.json());

const PORT = Number(process.env.PHASE5_REAL_PROVIDER_PORT ?? 3002);

let latestQr: string | null = null;
let lastQrAt: string | null = null;
let lastSafeInboundAt: string | null = null;

interface SafeInboundEvent {
  receivedAt: string;
  provider: unknown;
  eventType: unknown;
  messageIdPresent: boolean;
  safe: unknown;
  persistence: {
    persisted: boolean;
    duplicate: boolean;
    leadId: string | null;
  };
}

const safeInboundEvents: SafeInboundEvent[] = [];

const persistInboundEnabled = env.WHATSAPP_PERSIST_INBOUND_ENABLED === true;
const persistenceCounters = {
  persisted: 0,
  duplicate: 0,
  ignored: 0,
  notPersisted: 0,
};

const provider = createBaileysProvider({
  renderQr: ((params: { qr?: string; qrOutput?: string } = {}) => {
    const { qr } = params;
    if (!qr) {
      return;
    }

    latestQr = qr;
    lastQrAt = new Date().toISOString();

    console.log(`Phase 5 real provider QR ready. Open http://localhost:${PORT}/qr`);
    console.log('Scan only with POC-WhatsApp-01. Do not paste QR, phone, JID or auth payload.');
  }) as never,
} as never);

const inboundMessageService = persistInboundEnabled ? createInboundMessageIngestionService() : null;

const service = createSingleSessionService({
  provider,
  inboundMessageService,
} as never);

interface IngestionResultLike {
  persisted?: boolean;
  duplicate?: boolean;
  ignored?: boolean;
  leadId?: string | null;
}

const recordPersistenceOutcome = (
  ingestionResult: IngestionResultLike | null | undefined,
): void => {
  if (!ingestionResult) {
    persistenceCounters.notPersisted += 1;
    return;
  }

  if (ingestionResult.persisted) {
    persistenceCounters.persisted += 1;
  } else if (ingestionResult.duplicate) {
    persistenceCounters.duplicate += 1;
  } else if (ingestionResult.ignored) {
    persistenceCounters.ignored += 1;
  } else {
    persistenceCounters.notPersisted += 1;
  }
};

const outboundDeliveryEnabled = env.WHATSAPP_OUTBOUND_DELIVERY_ENABLED === true;
const deliveryCounters = {
  ticks: 0,
  delivered: 0,
  failed: 0,
};

const deliveryService = createOutboundDeliveryService({
  sessionService: service,
} as never);

let deliveryTimer: ReturnType<typeof setInterval> | null = null;
let deliveryTickRunning = false;

const runDeliveryTick = async (): Promise<void> => {
  if (deliveryTickRunning) {
    return;
  }

  const runtime = service.inspectSingleSession() as {
    running?: boolean;
    accountId?: string | null;
    organizationId?: string | null;
  };

  if (!runtime.running || !runtime.accountId || !runtime.organizationId) {
    return;
  }

  deliveryTickRunning = true;

  try {
    const result = (await deliveryService.drainQueue({
      organizationId: runtime.organizationId,
      whatsappAccountId: runtime.accountId,
    } as never)) as { delivered: number; failed: number };

    deliveryCounters.ticks += 1;
    deliveryCounters.delivered += result.delivered;
    deliveryCounters.failed += result.failed;

    if (result.delivered > 0 || result.failed > 0) {
      console.log('Phase 8 outbound delivery tick:', {
        delivered: result.delivered,
        failed: result.failed,
      });
    }
  } catch (error: unknown) {
    const err = error as { code?: string; name?: string };
    console.error('Phase 8 outbound delivery tick failed safely.', {
      code: err?.code,
      name: err?.name,
    });
  } finally {
    deliveryTickRunning = false;
  }
};

let shuttingDown = false;

const getSafeStatus = () => ({
  service: service.inspectSingleSession(),
  hasQr: Boolean(latestQr),
  lastQrAt,
  lastSafeInboundAt,
  safeInboundCount: safeInboundEvents.length,
  persistInboundEnabled,
  persistence: {
    ...persistenceCounters,
  },
  outboundDeliveryEnabled,
  delivery: {
    ...deliveryCounters,
  },
});

const shutdown = async (signal: string): Promise<void> => {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;

  console.log(`${signal} received. Stopping Phase 5 real provider manual server safely.`);

  if (deliveryTimer) {
    clearInterval(deliveryTimer);
    deliveryTimer = null;
  }

  try {
    await service.stopSingleSession({
      disconnectCode: 'phase5_real_provider_manual_shutdown',
    } as never);
  } finally {
    await disconnectRedis();
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

app.get('/status', (_req: Request, res: Response) => {
  res.json(getSafeStatus());
});

app.get('/qr', async (_req: Request, res: Response) => {
  if (!latestQr) {
    const status = getSafeStatus();

    return res.send(`
      <html>
        <body style="font-family: Arial; padding: 24px;">
          <h2>No QR available</h2>
          <p>Running: ${(status.service as { running?: boolean }).running}</p>
          <p>Provider: ${(status.service as { provider?: string }).provider ?? 'not-started'}</p>
          <p>QR available: ${status.hasQr}</p>
          <p>If already connected, QR will not be shown.</p>
          <p>If starting, refresh after 3 seconds.</p>
        </body>
      </html>
    `);
  }

  const qrImage = await qrcode.toDataURL(latestQr);

  res.send(`
    <html>
      <body style="font-family: Arial; padding: 24px;">
        <h2>Phase 5 Real Provider QR</h2>
        <p>Scan only with disposable POC-WhatsApp-01.</p>
        <p>Do not screenshot, paste, or store this QR.</p>
        <img src="${qrImage}" style="width: 320px; height: 320px;" />
      </body>
    </html>
  `);
});

app.get('/inbound-safe', (_req: Request, res: Response) => {
  res.json({
    count: safeInboundEvents.length,
    events: safeInboundEvents.slice(-10),
  });
});

app.get('/conversations-safe', (_req: Request, res: Response) => {
  res.json({
    persistInboundEnabled,
    persistence: {
      ...persistenceCounters,
    },
  });
});

app.get('/outbound-safe', (_req: Request, res: Response) => {
  res.json({
    outboundDeliveryEnabled,
    delivery: {
      ...deliveryCounters,
    },
  });
});

app.post('/send', async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as { to?: unknown; message?: unknown; text?: unknown };
  const { to, message, text } = body;
  const finalText = message ?? text;

  if (!to || !finalText) {
    return res.status(400).json({
      success: false,
      error: "Both 'to' and 'message' are required.",
    });
  }

  try {
    const result = await service.sendTextMessage({
      to,
      text: finalText,
    } as never);

    res.json({
      success: true,
      result,
    });
  } catch (error: unknown) {
    const err = error as { message?: string; code?: string };
    res.status(500).json({
      success: false,
      error: err?.message ?? 'Send failed safely.',
      code: err?.code,
    });
  }
});

await connectDatabase();
await connectRedis();

interface InboundMessageLike {
  provider?: unknown;
  eventType?: unknown;
  messageId?: unknown;
  safe?: unknown;
}

const startResult = await service.startSingleSession({
  onInboundMessage: async (
    inboundMessage: InboundMessageLike,
    ingestionResult: IngestionResultLike | null | undefined,
  ) => {
    lastSafeInboundAt = new Date().toISOString();

    recordPersistenceOutcome(ingestionResult);

    const safeEvent: SafeInboundEvent = {
      receivedAt: lastSafeInboundAt,
      provider: inboundMessage.provider,
      eventType: inboundMessage.eventType,
      messageIdPresent: Boolean(inboundMessage.messageId),
      safe: inboundMessage.safe,
      persistence: ingestionResult
        ? {
            persisted: Boolean(ingestionResult.persisted),
            duplicate: Boolean(ingestionResult.duplicate),
            leadId: ingestionResult.leadId ?? null,
          }
        : {
            persisted: false,
            duplicate: false,
            leadId: null,
          },
    };

    safeInboundEvents.push(safeEvent);

    if (safeInboundEvents.length > 20) {
      safeInboundEvents.shift();
    }

    console.log('Phase 5 real provider inbound received safely:', safeEvent);
  },
} as never);

console.log('Phase 5 real provider manual server start requested.');
console.log('Safe runtime session:', startResult.session);
console.log(`Status endpoint: http://localhost:${PORT}/status`);
console.log(`QR endpoint: http://localhost:${PORT}/qr`);
console.log(`Safe inbound endpoint: http://localhost:${PORT}/inbound-safe`);
console.log(`Safe conversations endpoint: http://localhost:${PORT}/conversations-safe`);
console.log(`Send endpoint: POST http://localhost:${PORT}/send`);
console.log(
  persistInboundEnabled
    ? 'Phase 6 inbound persistence is ENABLED. Inbound messages will be stored in the CRM.'
    : 'Phase 6 inbound persistence is DISABLED. Set WHATSAPP_PERSIST_INBOUND_ENABLED=true to store.',
);

if (outboundDeliveryEnabled) {
  console.log(`Safe outbound endpoint: http://localhost:${PORT}/outbound-safe`);
  console.log(
    `Phase 8 outbound delivery is ENABLED. Draining queued messages every ${env.WHATSAPP_OUTBOUND_POLL_INTERVAL_MS}ms.`,
  );
  deliveryTimer = setInterval(() => {
    void runDeliveryTick();
  }, env.WHATSAPP_OUTBOUND_POLL_INTERVAL_MS);
} else {
  console.log(
    'Phase 8 outbound delivery is DISABLED. Set WHATSAPP_OUTBOUND_DELIVERY_ENABLED=true to deliver.',
  );
}

console.log('Use only disposable POC-WhatsApp-01.');
console.log('Do not paste QR, phone, full JID, auth payload or raw provider logs.');

app.listen(PORT, () => {
  console.log(`Phase 5 real provider manual server running on http://localhost:${PORT}`);
});
