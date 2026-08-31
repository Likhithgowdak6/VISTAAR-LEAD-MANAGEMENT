import { InvalidAiProviderError } from './ai.errors.js';

export const AI_PROVIDER_NAMES = Object.freeze({
  ANTHROPIC: 'anthropic',
  GROK: 'grok',
  GROQ: 'groq',
} as const);

export type AiProviderName = (typeof AI_PROVIDER_NAMES)[keyof typeof AI_PROVIDER_NAMES];

export const AI_PROVIDER_METHODS = Object.freeze(['generateReplyDraft'] as const);

export type AiProviderMethod = (typeof AI_PROVIDER_METHODS)[number];

export interface GenerateReplyDraftParams {
  systemPrompt?: string;
  threadText?: string;
  instructions?: string;
}

export interface GenerateReplyDraftResult {
  draftText: string;
}

export interface AiProvider {
  name: string;
  generateReplyDraft: (params?: GenerateReplyDraftParams) => Promise<GenerateReplyDraftResult>;
}

export const assertAiProvider = (provider: unknown): AiProvider => {
  if (!provider || typeof provider !== 'object') {
    throw new InvalidAiProviderError('Provider must be an object.');
  }

  const candidate = provider as Partial<AiProvider> & Record<string, unknown>;

  if (!candidate.name || typeof candidate.name !== 'string') {
    throw new InvalidAiProviderError('Provider must expose a name.');
  }

  const missingMethods = AI_PROVIDER_METHODS.filter(
    (methodName) => typeof candidate[methodName] !== 'function',
  );

  if (missingMethods.length > 0) {
    throw new InvalidAiProviderError(`Provider is missing methods: ${missingMethods.join(', ')}`);
  }

  return candidate as AiProvider;
};
