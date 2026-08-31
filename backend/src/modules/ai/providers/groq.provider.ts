import { AiProviderError, AiProviderNotReadyError } from '../ai.errors.js';
import {
  AI_PROVIDER_NAMES,
  assertAiProvider,
  type AiProvider,
  type GenerateReplyDraftParams,
} from '../ai-provider.interface.js';

const DEFAULT_MODEL = 'llama-3.3-70b-versatile';
const DEFAULT_MAX_OUTPUT_TOKENS = 300;
const GROQ_API_BASE_URL = 'https://api.groq.com/openai/v1';

interface ChatCompletionChoice {
  message?: {
    content?: string | null;
  };
}

interface ChatCompletionResponse {
  choices?: ChatCompletionChoice[];
}

export interface CreateGroqProviderOptions {
  apiKey?: string;
  model?: string;
  maxOutputTokens?: number;
  fetchImpl?: typeof fetch;
}

// Groq Cloud's API is OpenAI-chat-completions-compatible, so a plain fetch call covers the one
// method this adapter needs — no extra SDK dependency for a single endpoint. Not to be confused
// with xAI's Grok (grok.provider.js) — different company, different API, different key format.
export const createGroqProvider = ({
  apiKey,
  model = DEFAULT_MODEL,
  maxOutputTokens = DEFAULT_MAX_OUTPUT_TOKENS,
  fetchImpl = fetch,
}: CreateGroqProviderOptions = {}): AiProvider => {
  return assertAiProvider({
    name: AI_PROVIDER_NAMES.GROQ,

    async generateReplyDraft({
      systemPrompt,
      threadText,
      instructions,
    }: GenerateReplyDraftParams = {}) {
      if (!apiKey) {
        throw new AiProviderNotReadyError('GROQ_API_KEY is not configured.');
      }

      const userContent = [threadText, instructions].filter(Boolean).join('\n\n');

      const response = await fetchImpl(`${GROQ_API_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          max_tokens: maxOutputTokens,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userContent },
          ],
        }),
      });

      if (!response.ok) {
        const errorBody = await response.text().catch(() => '');
        throw new AiProviderError(`Groq API request failed (${response.status}): ${errorBody}`);
      }

      const payload = (await response.json()) as ChatCompletionResponse;
      const draftText = payload.choices?.[0]?.message?.content?.trim() ?? '';

      return { draftText };
    },
  });
};
