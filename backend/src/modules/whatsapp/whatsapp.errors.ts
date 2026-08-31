export interface WhatsAppProviderErrorOptions {
  code?: string;
  cause?: unknown;
}

export class WhatsAppProviderError extends Error {
  readonly code: string;

  constructor(
    message: string,
    { code = 'WHATSAPP_PROVIDER_ERROR', cause }: WhatsAppProviderErrorOptions = {},
  ) {
    super(message, { cause });
    this.name = 'WhatsAppProviderError';
    this.code = code;
  }
}

export class WhatsAppProviderNotReadyError extends WhatsAppProviderError {
  constructor(message = 'WhatsApp provider runtime is not ready yet.') {
    super(message, {
      code: 'WHATSAPP_PROVIDER_NOT_READY',
    });
    this.name = 'WhatsAppProviderNotReadyError';
  }
}

export class InvalidWhatsAppProviderError extends WhatsAppProviderError {
  constructor(message = 'Invalid WhatsApp provider implementation.') {
    super(message, {
      code: 'INVALID_WHATSAPP_PROVIDER',
    });
    this.name = 'InvalidWhatsAppProviderError';
  }
}
