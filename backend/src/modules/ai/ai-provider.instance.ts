import { env } from '../../config/env.js';
import { AI_PROVIDER_NAMES, type AiProvider } from './ai-provider.interface.js';
import { createAnthropicProvider } from './providers/anthropic.provider.js';
import { createGrokProvider } from './providers/grok.provider.js';
import { createGroqProvider } from './providers/groq.provider.js';

let instance: AiProvider | null = null;

const buildProvider = (): AiProvider => {
  if (env.AI_PROVIDER === AI_PROVIDER_NAMES.GROK) {
    return createGrokProvider({
      apiKey: env.XAI_API_KEY,
      model: env.AI_MODEL,
      maxOutputTokens: env.AI_MAX_OUTPUT_TOKENS,
    });
  }

  if (env.AI_PROVIDER === AI_PROVIDER_NAMES.GROQ) {
    return createGroqProvider({
      apiKey: env.GROQ_API_KEY,
      model: env.AI_MODEL,
      maxOutputTokens: env.AI_MAX_OUTPUT_TOKENS,
    });
  }

  return createAnthropicProvider({
    apiKey: env.ANTHROPIC_API_KEY,
    model: env.AI_MODEL,
    maxOutputTokens: env.AI_MAX_OUTPUT_TOKENS,
  });
};

/**
 * Lazily-created, process-wide AI provider. `setAiProvider` lets tests inject a fake so draft
 * generation can be exercised through the real HTTP routes without calling a real AI API —
 * mirrors `session-manager.instance.js`'s getSessionManager/setSessionManager pattern.
 */
export const getAiProvider = (): AiProvider => {
  if (!instance) {
    instance = buildProvider();
  }

  return instance;
};

export const setAiProvider = (nextProvider: AiProvider | null): void => {
  instance = nextProvider;
};
