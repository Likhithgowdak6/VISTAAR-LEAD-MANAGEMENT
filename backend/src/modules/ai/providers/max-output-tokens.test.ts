/**
 * The per-call output ceiling, across all three providers.
 *
 * WHY THIS OVERRIDE EXISTS. `AI_MAX_OUTPUT_TOKENS` defaults to 300 - the right size for the one
 * thing `generateReplyDraft` was built for, a WhatsApp reply that should be short. The call
 * summariser asks the same model for an eleven-field JSON object, which runs 800-1500 tokens;
 * at 300 the response is cut off mid-object and fails to parse every single time.
 *
 * THE TWO HALVES BOTH MATTER, so both are tested on every provider:
 *
 *   The override must REACH the wire. A parameter that is accepted and then ignored produces
 *   exactly the truncation it was added to prevent, and nothing says so.
 *
 *   The default must SURVIVE. Nothing here may raise the ceiling for reply drafts - a
 *   2000-token WhatsApp message is a worse outcome than a truncated summary.
 *
 * All three are covered because they are three separate implementations of one interface, and
 * a fix applied to two of them is the kind of thing that stays unnoticed until the day somebody
 * switches `AI_PROVIDER`.
 */
import { describe, expect, it, vi } from 'vitest';

import { resolveMaxOutputTokens } from '../ai-provider.interface.js';
import { createAnthropicProvider } from './anthropic.provider.js';
import { createGrokProvider } from './grok.provider.js';
import { createGroqProvider } from './groq.provider.js';

const DRAFT_DEFAULT = 300;
const SUMMARY_BUDGET = 2000;

/** A fake Anthropic SDK client, capturing what the provider asked for. */
const anthropicClient = () => {
  const create = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });

  return { create, client: { messages: { create } } };
};

/** A fake fetch for the two OpenAI-compatible providers. */
const httpClient = () => {
  const fetchImpl = vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ choices: [{ message: { content: 'ok' } }] }),
  });

  const sentBody = () => JSON.parse(fetchImpl.mock.calls[0]![1].body as string) as Record<string, unknown>;

  return { fetchImpl, sentBody };
};

describe('resolveMaxOutputTokens', () => {
  it('prefers a usable override', () => {
    expect(resolveMaxOutputTokens(SUMMARY_BUDGET, DRAFT_DEFAULT)).toBe(SUMMARY_BUDGET);
  });

  it('falls back to the configured default when nothing was asked for', () => {
    expect(resolveMaxOutputTokens(undefined, DRAFT_DEFAULT)).toBe(DRAFT_DEFAULT);
  });

  it.each([
    ['zero', 0],
    ['negative', -1],
    ['a fraction', 12.5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])('IGNORES %s rather than forwarding it', (_label: string, value: number) => {
    // Any of these reaching a provider's `max_tokens` is either a hard API error or - worse -
    // a silently truncated response. Falling back keeps a call working that would otherwise
    // have broken for a reason nobody could see.
    expect(resolveMaxOutputTokens(value, DRAFT_DEFAULT)).toBe(DRAFT_DEFAULT);
  });
});

describe('the Anthropic provider', () => {
  it('sends the override when one is given', async () => {
    const { create, client } = anthropicClient();
    const provider = createAnthropicProvider({
      apiKey: 'test',
      maxOutputTokens: DRAFT_DEFAULT,
      client: client as never,
    });

    await provider.generateReplyDraft({ threadText: 'hi', maxOutputTokens: SUMMARY_BUDGET });

    expect(create.mock.calls[0]![0].max_tokens).toBe(SUMMARY_BUDGET);
  });

  it('KEEPS THE 300-TOKEN DEFAULT for a reply draft', async () => {
    const { create, client } = anthropicClient();
    const provider = createAnthropicProvider({
      apiKey: 'test',
      maxOutputTokens: DRAFT_DEFAULT,
      client: client as never,
    });

    await provider.generateReplyDraft({ threadText: 'hi' });

    expect(create.mock.calls[0]![0].max_tokens).toBe(DRAFT_DEFAULT);
  });

  it('ignores an unusable override', async () => {
    const { create, client } = anthropicClient();
    const provider = createAnthropicProvider({
      apiKey: 'test',
      maxOutputTokens: DRAFT_DEFAULT,
      client: client as never,
    });

    await provider.generateReplyDraft({ threadText: 'hi', maxOutputTokens: 0 });

    expect(create.mock.calls[0]![0].max_tokens).toBe(DRAFT_DEFAULT);
  });
});

describe('the Groq provider', () => {
  it('sends the override when one is given', async () => {
    const { fetchImpl, sentBody } = httpClient();
    const provider = createGroqProvider({
      apiKey: 'test',
      maxOutputTokens: DRAFT_DEFAULT,
      fetchImpl: fetchImpl as never,
    });

    await provider.generateReplyDraft({ threadText: 'hi', maxOutputTokens: SUMMARY_BUDGET });

    expect(sentBody().max_tokens).toBe(SUMMARY_BUDGET);
  });

  it('KEEPS THE 300-TOKEN DEFAULT for a reply draft', async () => {
    const { fetchImpl, sentBody } = httpClient();
    const provider = createGroqProvider({
      apiKey: 'test',
      maxOutputTokens: DRAFT_DEFAULT,
      fetchImpl: fetchImpl as never,
    });

    await provider.generateReplyDraft({ threadText: 'hi' });

    expect(sentBody().max_tokens).toBe(DRAFT_DEFAULT);
  });

  it('ignores an unusable override', async () => {
    const { fetchImpl, sentBody } = httpClient();
    const provider = createGroqProvider({
      apiKey: 'test',
      maxOutputTokens: DRAFT_DEFAULT,
      fetchImpl: fetchImpl as never,
    });

    await provider.generateReplyDraft({ threadText: 'hi', maxOutputTokens: -5 });

    expect(sentBody().max_tokens).toBe(DRAFT_DEFAULT);
  });
});

describe('the Grok provider', () => {
  it('sends the override when one is given', async () => {
    const { fetchImpl, sentBody } = httpClient();
    const provider = createGrokProvider({
      apiKey: 'test',
      maxOutputTokens: DRAFT_DEFAULT,
      fetchImpl: fetchImpl as never,
    });

    await provider.generateReplyDraft({ threadText: 'hi', maxOutputTokens: SUMMARY_BUDGET });

    expect(sentBody().max_tokens).toBe(SUMMARY_BUDGET);
  });

  it('KEEPS THE 300-TOKEN DEFAULT for a reply draft', async () => {
    const { fetchImpl, sentBody } = httpClient();
    const provider = createGrokProvider({
      apiKey: 'test',
      maxOutputTokens: DRAFT_DEFAULT,
      fetchImpl: fetchImpl as never,
    });

    await provider.generateReplyDraft({ threadText: 'hi' });

    expect(sentBody().max_tokens).toBe(DRAFT_DEFAULT);
  });

  it('ignores an unusable override', async () => {
    const { fetchImpl, sentBody } = httpClient();
    const provider = createGrokProvider({
      apiKey: 'test',
      maxOutputTokens: DRAFT_DEFAULT,
      fetchImpl: fetchImpl as never,
    });

    await provider.generateReplyDraft({ threadText: 'hi', maxOutputTokens: Number.NaN });

    expect(sentBody().max_tokens).toBe(DRAFT_DEFAULT);
  });
});
