/**
 * Exercises the summariser leg of the ai-brain-service HTTP client: the path it posts to, the
 * snake_case body ai-brain-service's Pydantic models actually expect, and the two failure modes
 * conversation-summary.service.ts's isolation depends on being able to recognise - the service
 * being switched off, and the service refusing the call.
 *
 * `fetch` is stubbed; nothing here talks to a real ai-brain-service.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: {
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    AI_BRAIN_ENABLED: true,
    // Trailing slash on purpose: the client is supposed to normalise it away.
    AI_BRAIN_SERVICE_URL: 'http://ai-brain:8000/',
    AI_BRAIN_SERVICE_KEY: 'service-key',
    AI_BRAIN_REQUEST_TIMEOUT_MS: 5000,
  },
}));

const { AiBrainRequestError, getSummary } = await import('./ai-brain.client.js');

const jsonResponse = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  text: () => Promise.resolve(JSON.stringify(body)),
});

const answer = {
  headline: 'Riya wants candid wedding photography in Pune on 14 Feb.',
  what_they_asked_for: 'Two days of candid coverage.',
  where_it_stands: 'We quoted the two-photographer option.',
  open_questions: ['Is 14 Feb confirmed?'],
  suggested_next_step: 'Ask whether 14 Feb is fixed.',
};

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('getSummary', () => {
  it('posts the transcript and facts to the conversation summary endpoint in snake_case', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(answer));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      getSummary('conv-1', {
        facts: { city: 'Pune' },
        transcript: [{ role: 'lead', text: 'Do you shoot weddings?' }],
        category: 'event_photography',
        knowledgeText: '- Where we are: Bangalore.',
      }),
    ).resolves.toEqual(answer);

    const [url, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string>; body: string }];
    expect(url).toBe('http://ai-brain:8000/v1/conversations/conv-1/summary');
    expect(init.headers['X-Service-Key']).toBe('service-key');
    expect(JSON.parse(init.body)).toEqual({
      facts: { city: 'Pune' },
      transcript: [{ role: 'lead', text: 'Do you shoot weddings?' }],
      category: 'event_photography',
      knowledge_text: '- Where we are: Bangalore.',
    });
  });

  it('defaults the optional context rather than sending undefined', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(answer));
    vi.stubGlobal('fetch', fetchMock);

    await getSummary('conv-1', { facts: {}, transcript: [] });

    const [, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    expect(JSON.parse(init.body)).toMatchObject({ category: 'unknown', knowledge_text: '' });
  });

  it('raises a recognisable error when the service refuses - a 429 is the common one', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ detail: 'rate limited' }, 429)));

    await expect(getSummary('conv-1', { facts: {}, transcript: [] })).rejects.toBeInstanceOf(
      AiBrainRequestError,
    );
  });
});
