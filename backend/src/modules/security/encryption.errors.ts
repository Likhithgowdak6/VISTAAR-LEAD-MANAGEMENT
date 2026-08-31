export interface EncryptionErrorOptions {
  code?: string;
  cause?: unknown;
}

export class EncryptionConfigurationError extends Error {
  readonly code: string;

  constructor(
    message: string,
    { code = 'ENCRYPTION_CONFIGURATION_ERROR', cause }: EncryptionErrorOptions = {},
  ) {
    super(message, { cause });
    this.name = 'EncryptionConfigurationError';
    this.code = code;
  }
}

export class EncryptionOperationError extends Error {
  readonly code: string;

  constructor(
    message = 'Unable to process encrypted field.',
    { code = 'ENCRYPTION_OPERATION_ERROR', cause }: EncryptionErrorOptions = {},
  ) {
    super(message, { cause });
    this.name = 'EncryptionOperationError';
    this.code = code;
  }
}
