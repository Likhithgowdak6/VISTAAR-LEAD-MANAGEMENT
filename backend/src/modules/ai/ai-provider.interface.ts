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
  /**
   * A per-call output ceiling, overriding the provider's configured default.
   *
   * WHY THIS EXISTS. `AI_MAX_OUTPUT_TOKENS` defaults to 300, which is the right size for the
   * one thing this method was built for - a WhatsApp reply draft, which should be short. The
   * call summariser asks the same model for an eleven-field JSON object, which does not fit in
   * 300 tokens: the response is cut off mid-object and fails to parse, every time.
   *
   * A PER-CALL OVERRIDE RATHER THAN A BIGGER SHARED DEFAULT, because raising the shared value
   * would let reply drafts grow to the same ceiling - and a 2000-token WhatsApp message is a
   * worse outcome than a truncated summary. The budget belongs next to the call site that
   * needs it.
   */
  maxOutputTokens?: number;
}

/**
 * The output ceiling for one request: the override when it is usable, the configured value
 * otherwise.
 *
 * NONSENSE IS IGNORED, NOT PASSED THROUGH. Zero, a negative, a fraction or NaN reaching a
 * provider's `max_tokens` is either a hard API error or - worse - a silently truncated
 * response, so an unusable override falls back to the configured default rather than breaking
 * a call that would otherwise have worked.
 */
export const resolveMaxOutputTokens = (
  override: number | undefined,
  configured: number,
): number =>
  typeof override === 'number' && Number.isInteger(override) && override > 0
    ? override
    : configured;

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
