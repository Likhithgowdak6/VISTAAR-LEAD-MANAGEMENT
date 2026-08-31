export interface AiProviderErrorOptions {
  code?: string;
  cause?: unknown;
}

export class AiProviderError extends Error {
  readonly code: string;

  constructor(message: string, { code = 'AI_PROVIDER_ERROR', cause }: AiProviderErrorOptions = {}) {
    super(message, { cause });
    this.name = 'AiProviderError';
    this.code = code;
  }
}

export class AiProviderNotReadyError extends AiProviderError {
  constructor(message = 'AI provider is not ready yet.') {
    super(message, {
      code: 'AI_PROVIDER_NOT_READY',
    });
    this.name = 'AiProviderNotReadyError';
  }
}

export class InvalidAiProviderError extends AiProviderError {
  constructor(message = 'Invalid AI provider implementation.') {
    super(message, {
      code: 'INVALID_AI_PROVIDER',
    });
    this.name = 'InvalidAiProviderError';
  }
}

// ADR-005's disable switch: thrown whenever AI_ENABLED is false, regardless of provider state.
export class AiDisabledError extends AiProviderError {
  constructor(message = 'AI features are disabled.') {
    super(message, {
      code: 'AI_DISABLED',
    });
    this.name = 'AiDisabledError';
  }
}

// ADR-005's cost/rate-limit control.
export class AiRateLimitedError extends AiProviderError {
  constructor(message = 'AI draft rate limit exceeded.') {
    super(message, {
      code: 'AI_RATE_LIMITED',
    });
    this.name = 'AiRateLimitedError';
  }
}
