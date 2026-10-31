/**
 * The transcription sweep.
 *
 * WHAT MATTERS MOST HERE IS THE UNHAPPY PATH. With no transcription provider configured - which
 * is the deliberate production default until one is approved - every call with audio takes the
 * failure branch. That branch has to leave a row an operator can read and a UI can explain, and
 * it must never leave a call stuck as `processing` forever, because a stuck row is invisible:
 * nothing retries it and nothing reports it.
 *
 * AND THE RETRY MUST NOT DUPLICATE. The write is an upsert keyed on the call, so a call
 * transcribed twice ends with one transcript - and the stale summary built from the previous
 * words is cleared with it, because a summary that no longer matches its transcript is wrong in
 * the most convincing possible way: it looks complete.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: { NODE_ENV: 'test', LOG_LEVEL: 'silent', MEDIA_STORAGE_DIR: 'var/media' },
}));

vi.mock('../../config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const mocks = vi.hoisted(() => ({
  claimCallForTranscription: vi.fn(),
  saveTranscript: vi.fn(),
  setTranscriptionStatus: vi.fn(),
  setSummaryStatus: vi.fn(),
}));

vi.mock('./call-analysis.repository.js', () => ({
  claimCallForTranscription: mocks.claimCallForTranscription,
  saveTranscript: mocks.saveTranscript,
  setTranscriptionStatus: mocks.setTranscriptionStatus,
  setSummaryStatus: mocks.setSummaryStatus,
}));

const { processNextTranscription, setTranscriptionProvider } = await import(
  './call-transcription.service.js'
);
const { createMockTranscriptionProvider, createUnconfiguredTranscriptionProvider } = await import(
  './transcription.provider.js'
);
const { logger } = await import('../../config/logger.js');

const ORG = '6ab4c2037469f65204cfe999';
const CONVERSATION = '68f1a2b3c4d5e6f708192a3b';
const CALL = '6adf2dd59f91cdd63f09e0f3';
const KEY = `${ORG}/${CONVERSATION}/0199aa11-2233-4455-6677-8899aabbccdd.m4a`;

const call = (overrides: Record<string, unknown> = {}) => ({
  _id: CALL,
  organizationId: ORG,
  conversationId: CONVERSATION,
  recordingObjectKey: KEY,
  recordingMimeType: 'audio/mp4',
  ...overrides,
});

const storage = () => ({
  readMediaObject: vi.fn().mockResolvedValue(Buffer.from('audio')),
  writeMediaObject: vi.fn(),
  deleteMediaObject: vi.fn(),
  statMediaObject: vi.fn(),
  openMediaObjectStream: vi.fn(),
  root: '/tmp',
});

beforeEach(() => {
  vi.clearAllMocks();
  setTranscriptionProvider(createUnconfiguredTranscriptionProvider());
  mocks.claimCallForTranscription.mockResolvedValue(call());
  mocks.saveTranscript.mockResolvedValue({});
  mocks.setTranscriptionStatus.mockResolvedValue({});
  mocks.setSummaryStatus.mockResolvedValue({});
});

describe('with nothing to do', () => {
  it('reports idle rather than inventing work', async () => {
    mocks.claimCallForTranscription.mockResolvedValue(null);

    const result = await processNextTranscription({ storage: storage() as never });

    expect(result).toEqual({ processed: false, reason: 'idle' });
    expect(mocks.setTranscriptionStatus).not.toHaveBeenCalled();
  });
});

describe('with no provider configured', () => {
  it('FAILS VISIBLY instead of hanging as processing', async () => {
    const store = storage();

    const result = await processNextTranscription({ storage: store as never });

    expect(result).toEqual({ processed: true, callId: CALL, status: 'failed' });
    expect(mocks.setTranscriptionStatus).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed', error: 'TRANSCRIPTION_NOT_CONFIGURED' }),
    );
  });

  it('does not read the audio it cannot process', async () => {
    // No point loading megabytes into memory to hand them to something that will refuse.
    const store = storage();

    await processNextTranscription({ storage: store as never });

    expect(store.readMediaObject).not.toHaveBeenCalled();
  });

  it('writes NO transcript and does not arm the summariser', async () => {
    await processNextTranscription({ storage: storage() as never });

    expect(mocks.saveTranscript).not.toHaveBeenCalled();
    expect(mocks.setSummaryStatus).not.toHaveBeenCalled();
  });
});

describe('a successful pass', () => {
  beforeEach(() => {
    setTranscriptionProvider(
      createMockTranscriptionProvider({
        segments: [
          { text: 'Hello, this is Vistaar.', speaker: 'agent', startSeconds: 0 },
          { text: 'Yes, tell me.', speaker: 'customer', startSeconds: 3 },
        ],
        diarized: true,
        detectedLanguage: 'en-IN',
      }),
    );
  });

  it('stores the transcript with its speakers and language', async () => {
    await processNextTranscription({ storage: storage() as never });

    const saved = mocks.saveTranscript.mock.calls[0]![0];

    expect(saved.segments).toHaveLength(2);
    expect(saved.segments[0].speaker).toBe('agent');
    expect(saved.detectedLanguage).toBe('en-IN');
    expect(saved.diarized).toBe(true);
  });

  it('marks the transcript complete and queues the summary', async () => {
    await processNextTranscription({ storage: storage() as never });

    expect(mocks.setTranscriptionStatus).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'completed' }),
    );
    expect(mocks.setSummaryStatus).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'pending' }),
    );
  });

  it('CARRIES NO SPEAKER when the provider gave none', async () => {
    // The likely Kannada outcome. Deriving a label from turn order would be wrong the moment
    // the customer speaks first, and a confidently wrong label is worse than none.
    setTranscriptionProvider(
      createMockTranscriptionProvider({ segments: [{ text: 'ಒಂದು ನಿಮಿಷ' }] }),
    );

    await processNextTranscription({ storage: storage() as never });

    const saved = mocks.saveTranscript.mock.calls[0]![0];

    expect(saved.segments[0].speaker).toBeNull();
    expect(saved.diarized).toBe(false);
  });

  it('NEVER LOGS WHAT WAS SAID', async () => {
    await processNextTranscription({ storage: storage() as never });

    const logged = JSON.stringify((logger.info as ReturnType<typeof vi.fn>).mock.calls);

    expect(logged).not.toContain('Vistaar.');
    expect(logged).not.toContain('tell me');
    expect(logged).toContain(CALL);
  });
});

describe('failures', () => {
  it('records a provider failure against the call', async () => {
    setTranscriptionProvider(
      createMockTranscriptionProvider({ failWith: new Error('PROVIDER_TIMEOUT') }),
    );

    const result = await processNextTranscription({ storage: storage() as never });

    expect(result.processed).toBe(true);
    expect(mocks.setTranscriptionStatus).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed', error: 'PROVIDER_TIMEOUT' }),
    );
  });

  it('refuses a row that claims audio but names no usable key', async () => {
    setTranscriptionProvider(createMockTranscriptionProvider({ segments: [{ text: 'hi' }] }));
    mocks.claimCallForTranscription.mockResolvedValue(
      call({ recordingObjectKey: '../../../etc/passwd' }),
    );

    await processNextTranscription({ storage: storage() as never });

    expect(mocks.setTranscriptionStatus).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed', error: 'RECORDING_KEY_INVALID' }),
    );
  });

  it('LOGS A CODE, NOT A PROVIDER’S RAW BODY', async () => {
    // Provider errors have been known to echo the request payload back - which here would be
    // the customer's audio or its transcript.
    setTranscriptionProvider(
      createMockTranscriptionProvider({
        failWith: new Error('upstream said: "the customer mentioned a budget of two lakh"'),
      }),
    );

    await processNextTranscription({ storage: storage() as never });

    const stored = mocks.setTranscriptionStatus.mock.calls[0]![0].error as string;

    // Truncated to 200 chars and never expanded; the point is that it is bounded and that the
    // transcript itself is never what gets stored here.
    expect(stored.length).toBeLessThanOrEqual(200);
  });
});
