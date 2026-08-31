import Anthropic from '@anthropic-ai/sdk';

import { AiProviderNotReadyError } from '../ai.errors.js';
import {
  AI_PROVIDER_NAMES,
  assertAiProvider,
  type AiProvider,
  type GenerateReplyDraftParams,
} from '../ai-provider.interface.js';

const DEFAULT_MODEL = 'claude-sonnet-5';
const DEFAULT_MAX_OUTPUT_TOKENS = 300;

export interface CreateAnthropicProviderOptions {
  apiKey?: string;
  model?: string;
  maxOutputTokens?: number;
  client?: Anthropic;
}

export const createAnthropicProvider = ({
  apiKey,
  model = DEFAULT_MODEL,
  maxOutputTokens = DEFAULT_MAX_OUTPUT_TOKENS,
  client,
}: CreateAnthropicProviderOptions = {}): AiProvider => {
  // Lazily built so a missing key only breaks the call site that actually needs it, not every
  // process that imports this module (mirrors how the Baileys provider defers connection setup).
  let sdkClient: Anthropic | null = client ?? null;

  const getClient = (): Anthropic => {
    if (sdkClient) {
      return sdkClient;
    }

    if (!apiKey) {
      throw new AiProviderNotReadyError('ANTHROPIC_API_KEY is not configured.');
    }

    sdkClient = new Anthropic({ apiKey });
    return sdkClient;
  };

  return assertAiProvider({
    name: AI_PROVIDER_NAMES.ANTHROPIC,

    async generateReplyDraft({
      systemPrompt,
      threadText,
      instructions,
    }: GenerateReplyDraftParams = {}) {
      const anthropic = getClient();

      const userContent = [threadText, instructions].filter(Boolean).join('\n\n');

      const response = await anthropic.messages.create({
        model,
        max_tokens: maxOutputTokens,
        system: systemPrompt,
        messages: [
          {
            role: 'user',
            content: userContent,
          },
        ],
      });

      const textBlock = response.content.find((block) => block.type === 'text');

      return {
        draftText: textBlock?.text?.trim() ?? '',
      };
    },
  });
};
