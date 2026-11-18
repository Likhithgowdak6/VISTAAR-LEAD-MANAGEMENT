/**
 * The WhatsApp Cloud API client, exercised entirely against a stubbed `fetch` — nothing here
 * talks to Meta, and there is no code path in this file that could.
 *
 * What is actually being pinned down: the token travels in a HEADER and never in a URL, the
 * version is in the path, recipients are reduced to digits whatever shape they arrive in, and
 * Meta's error codes are collapsed into retry-or-not. That last one carries the most weight —
 * a closed 24-hour window retried three times is fifteen minutes of an agent believing a message
 * went out.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../config/env.js', () => ({
  env: { NODE_ENV: 'test', LOG_LEVEL: 'silent' },
}));

const {
  CLOUD_API_VERSION,
  CLOUD_MAX_TEXT_LENGTH,
  buildCloudUrl,
  describeCloudMedia,
  downloadCloudMedia,
  fetchCloudPhoneNumber,
  fetchCloudTemplates,
  connectCloudWebhookSubscription,
  sendCloudMedia,
  sendCloudTemplate,
  sendCloudText,
  toCloudRecipient,
  uploadCloudMedia,
} = await import('./whatsapp-cloud.client.js');
const { CLOUD_FAILURE_KINDS, CLOUD_WINDOW_CLOSED_CODE, WhatsAppCloudError } = await import(
  './cloud.errors.js'
);

const TOKEN = 'test-token-not-a-real-credential';
const PHONE_NUMBER_ID = '109876543210987';
const WABA_ID = '102233445566778';

const jsonResponse = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  text: () => Promise.resolve(JSON.stringify(body)),
  headers: { get: () => null },
});

const metaError = (code: number, status = 400) =>
  jsonResponse({ error: { code, message: 'Meta prose that must not be shown to anyone' } }, status);

const sentOk = (id = 'wamid.TEST') => jsonResponse({ messages: [{ id }] });

describe('connectCloudWebhookSubscription', () => {
  const options = { wabaId: WABA_ID, phoneNumberId: PHONE_NUMBER_ID, accessToken: TOKEN };
  it('checks membership before subscribing the token app', async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: PHONE_NUMBER_ID }] }))
      .mockResolvedValueOnce(jsonResponse({ success: true }));
    await connectCloudWebhookSubscription({ ...options, fetchFn });
    expect(fetchFn.mock.calls[0]?.[0]).toContain(`${WABA_ID}/phone_numbers`);
    expect(fetchFn.mock.calls[1]?.[0]).toContain(`${WABA_ID}/subscribed_apps`);
    expect(fetchFn.mock.calls[1]?.[1]).toMatchObject({ method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` } });
  });
  it('never subscribes an unrelated business account', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ data: [{ id: '99999999999' }] }));
    await expect(connectCloudWebhookSubscription({ ...options, fetchFn })).rejects.toMatchObject({ code: 'WHATSAPP_CLOUD_ACCOUNT_MISMATCH' });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
  it('follows cursors on the Graph host instead of trusting paging URLs', async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ data: [], paging: { next: 'https://untrusted.test/', cursors: { after: 'page2' } } }))
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: PHONE_NUMBER_ID }] }))
      .mockResolvedValueOnce(jsonResponse({ success: true }));
    await connectCloudWebhookSubscription({ ...options, fetchFn });
    expect(fetchFn.mock.calls[1]?.[0]).toContain('https://graph.facebook.com/');
    expect(fetchFn.mock.calls[1]?.[0]).toContain('after=page2');
  });
  it('does not report a connection when subscription is refused', async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: PHONE_NUMBER_ID }] }))
      .mockResolvedValueOnce(jsonResponse({ success: false }));
    await expect(connectCloudWebhookSubscription({ ...options, fetchFn })).rejects.toMatchObject({ code: 'WHATSAPP_CLOUD_SUBSCRIPTION_FAILED' });
  });
});

describe('buildCloudUrl', () => {
  it('pins the Graph version into the path', () => {
    expect(buildCloudUrl({ path: `${PHONE_NUMBER_ID}/messages` })).toBe(
      `https://graph.facebook.com/${CLOUD_API_VERSION}/${PHONE_NUMBER_ID}/messages`,
    );
  });

  it('drops undefined params rather than sending them empty', () => {
    const url = buildCloudUrl({ path: 'x', params: { a: '1', b: undefined } });

    expect(url).toContain('a=1');
    expect(url).not.toContain('b=');
  });
});

describe('response body safety', () => {
  it('keeps the request timeout active while reading JSON', async () => {
    const fetchFn = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => ({
      ok: true, status: 200,
      text: () => new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted')))),
    }));
    await expect(fetchCloudPhoneNumber({ phoneNumberId: PHONE_NUMBER_ID, accessToken: TOKEN, fetchFn, timeoutMs: 20 }))
      .rejects.toMatchObject({ code: 'WHATSAPP_CLOUD_NETWORK_ERROR' });
  });
  it('stops a streamed download as soon as it exceeds the size cap', async () => {
    const read = vi.fn().mockResolvedValueOnce({ done: false, value: new Uint8Array(60) })
      .mockResolvedValueOnce({ done: false, value: new Uint8Array(60) });
    const releaseLock = vi.fn();
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, headers: { get: () => null }, body: { getReader: () => ({ read, releaseLock }) } });
    await expect(downloadCloudMedia({ url: 'https://lookaside.fbcdn.net/x', accessToken: TOKEN, maxBytes: 100, fetchFn }))
      .rejects.toMatchObject({ code: 'WHATSAPP_CLOUD_MEDIA_TOO_LARGE' });
    expect(read).toHaveBeenCalledTimes(2);
    expect(releaseLock).toHaveBeenCalledOnce();
    expect(fetchFn.mock.calls[0]?.[1].signal.aborted).toBe(true);
    expect(fetchFn.mock.calls[0]?.[1].redirect).toBe('error');
  });
  it('rejects cleartext CDN URLs before sending a token', async () => {
    const fetchFn = vi.fn();
    await expect(downloadCloudMedia({ url: 'http://lookaside.fbcdn.net/x', accessToken: TOKEN, fetchFn }))
      .rejects.toMatchObject({ code: 'WHATSAPP_CLOUD_MEDIA_URL_INVALID' });
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe('toCloudRecipient', () => {
  it.each([
    ['+91 98765 43210', '919876543210'],
    ['919876543210@s.whatsapp.net', '919876543210'],
    ['919876543210:12@s.whatsapp.net', '919876543210'],
    ['(919) 876-543210', '919876543210'],
  ])('reduces %s to digits', (input, expected) => {
    expect(toCloudRecipient(input)).toBe(expected);
  });

  it('refuses something that is not a phone number, permanently', () => {
    try {
      toCloudRecipient('nope');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(WhatsAppCloudError);
      // Permanent, because retrying a malformed recipient produces the same malformed recipient.
      expect((error as InstanceType<typeof WhatsAppCloudError>).permanent).toBe(true);
    }
  });
});

describe('sendCloudText', () => {
  let fetchFn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchFn = vi.fn().mockResolvedValue(sentOk());
  });

  it('posts the Cloud message envelope and returns the provider message id', async () => {
    const result = await sendCloudText({
      phoneNumberId: PHONE_NUMBER_ID,
      accessToken: TOKEN,
      to: '+91 98765 43210',
      text: 'Hello',
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    expect(result.providerMessageId).toBe('wamid.TEST');

    const [url, init] = fetchFn.mock.calls[0]!;

    expect(url).toContain(`/${PHONE_NUMBER_ID}/messages`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '919876543210',
      type: 'text',
      text: { preview_url: false, body: 'Hello' },
    });
  });

  /**
   * The single most important assertion in this file. A token in a query string ends up in proxy
   * logs, error pages and Meta's own redirect URLs; a token in a header does not.
   */
  it('sends the token as a Bearer header and never in the URL', async () => {
    await sendCloudText({
      phoneNumberId: PHONE_NUMBER_ID,
      accessToken: TOKEN,
      to: '919876543210',
      text: 'Hello',
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    const [url, init] = fetchFn.mock.calls[0]!;

    expect(init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(String(url)).not.toContain(TOKEN);
  });

  it('refuses an empty body without spending a request', async () => {
    await expect(
      sendCloudText({
        phoneNumberId: PHONE_NUMBER_ID,
        accessToken: TOKEN,
        to: '919876543210',
        text: '   ',
        fetchFn: fetchFn as unknown as typeof fetch,
      }),
    ).rejects.toThrow(WhatsAppCloudError);

    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('refuses a body over the WhatsApp limit without spending a request', async () => {
    await expect(
      sendCloudText({
        phoneNumberId: PHONE_NUMBER_ID,
        accessToken: TOKEN,
        to: '919876543210',
        text: 'x'.repeat(CLOUD_MAX_TEXT_LENGTH + 1),
        fetchFn: fetchFn as unknown as typeof fetch,
      }),
    ).rejects.toThrow(WhatsAppCloudError);

    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('refuses a malformed phone number id rather than interpolating it into a URL', async () => {
    await expect(
      sendCloudText({
        phoneNumberId: '../me',
        accessToken: TOKEN,
        to: '919876543210',
        text: 'Hello',
        fetchFn: fetchFn as unknown as typeof fetch,
      }),
    ).rejects.toThrow(WhatsAppCloudError);

    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('refuses a missing token without spending a request', async () => {
    await expect(
      sendCloudText({
        phoneNumberId: PHONE_NUMBER_ID,
        accessToken: '',
        to: '919876543210',
        text: 'Hello',
        fetchFn: fetchFn as unknown as typeof fetch,
      }),
    ).rejects.toThrow(WhatsAppCloudError);

    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe('error classification', () => {
  const sendWith = (response: unknown) =>
    sendCloudText({
      phoneNumberId: PHONE_NUMBER_ID,
      accessToken: TOKEN,
      to: '919876543210',
      text: 'Hello',
      fetchFn: vi.fn().mockResolvedValue(response) as unknown as typeof fetch,
    });

  /**
   * 131047 is the whole reason this integration needed templates. It must be permanent: the
   * 24-hour window does not reopen because the queue asked a second time.
   */
  it('treats a closed service window as permanent, with its own code', async () => {
    try {
      await sendWith(metaError(131_047));
      expect.unreachable('should have thrown');
    } catch (error) {
      const err = error as InstanceType<typeof WhatsAppCloudError>;

      expect(err.code).toBe(CLOUD_WINDOW_CLOSED_CODE);
      expect(err.permanent).toBe(true);
      expect(err.failureKind).toBe(CLOUD_FAILURE_KINDS.PERMANENT);
    }
  });

  it.each([
    [190, CLOUD_FAILURE_KINDS.NEEDS_ATTENTION, true],
    [131_026, CLOUD_FAILURE_KINDS.PERMANENT, true],
    [132_001, CLOUD_FAILURE_KINDS.PERMANENT, true],
    [133_010, CLOUD_FAILURE_KINDS.NEEDS_ATTENTION, true],
    [130_429, CLOUD_FAILURE_KINDS.RATE_LIMITED, false],
    [131_048, CLOUD_FAILURE_KINDS.RATE_LIMITED, false],
    [1, CLOUD_FAILURE_KINDS.TRANSIENT, false],
  ])('maps Meta code %i to %s (permanent=%s)', async (code, kind, permanent) => {
    try {
      await sendWith(metaError(code as number));
      expect.unreachable('should have thrown');
    } catch (error) {
      const err = error as InstanceType<typeof WhatsAppCloudError>;

      expect(err.failureKind).toBe(kind);
      expect(err.permanent).toBe(permanent);
      expect(err.metaCode).toBe(code);
    }
  });

  /**
   * Meta's own prose names the recipient's number in `error_data.details` and changes without
   * notice. Showing it would leak a lead's phone number into an error toast.
   */
  it('never surfaces Meta prose in the thrown message', async () => {
    await expect(sendWith(metaError(131_047))).rejects.not.toThrow(/Meta prose/);
  });

  it('treats a 5xx with no envelope as transient', async () => {
    try {
      await sendWith({ ok: false, status: 503, text: () => Promise.resolve('<html>oops'), headers: { get: () => null } });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as InstanceType<typeof WhatsAppCloudError>).permanent).toBe(false);
    }
  });

  it('treats a network failure as transient', async () => {
    try {
      await sendCloudText({
        phoneNumberId: PHONE_NUMBER_ID,
        accessToken: TOKEN,
        to: '919876543210',
        text: 'Hello',
        fetchFn: vi.fn().mockRejectedValue(new Error('ECONNRESET')) as unknown as typeof fetch,
      });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as InstanceType<typeof WhatsAppCloudError>).permanent).toBe(false);
    }
  });

  it('treats a 200 carrying an error envelope as the failure it is', async () => {
    await expect(sendWith(jsonResponse({ error: { code: 190 } }, 200))).rejects.toThrow(
      WhatsAppCloudError,
    );
  });
});

describe('sendCloudTemplate', () => {
  it('sends the name, language and parameters — never the wording', async () => {
    const fetchFn = vi.fn().mockResolvedValue(sentOk('wamid.TPL'));

    await sendCloudTemplate({
      phoneNumberId: PHONE_NUMBER_ID,
      accessToken: TOKEN,
      to: '919876543210',
      templateName: 'welcome_lead',
      languageCode: 'en_US',
      components: [{ type: 'body', parameters: [{ type: 'text', text: 'Riya' }] }],
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    const body = JSON.parse(fetchFn.mock.calls[0]![1].body);

    expect(body.type).toBe('template');
    expect(body.template.name).toBe('welcome_lead');
    expect(body.template.language).toEqual({ code: 'en_US' });
    expect(body.template.components).toEqual([
      { type: 'body', parameters: [{ type: 'text', text: 'Riya' }] },
    ]);
  });

  /** Meta rejects an empty components array on templates that declare no parameters. */
  it('omits components entirely when the template takes none', async () => {
    const fetchFn = vi.fn().mockResolvedValue(sentOk());

    await sendCloudTemplate({
      phoneNumberId: PHONE_NUMBER_ID,
      accessToken: TOKEN,
      to: '919876543210',
      templateName: 'hello_world',
      languageCode: 'en_US',
      components: [],
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    expect(JSON.parse(fetchFn.mock.calls[0]![1].body).template).not.toHaveProperty('components');
  });

  it('refuses a template with no language', async () => {
    const fetchFn = vi.fn();

    await expect(
      sendCloudTemplate({
        phoneNumberId: PHONE_NUMBER_ID,
        accessToken: TOKEN,
        to: '919876543210',
        templateName: 'welcome_lead',
        languageCode: '  ',
        fetchFn: fetchFn as unknown as typeof fetch,
      }),
    ).rejects.toThrow(WhatsAppCloudError);

    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe('media', () => {
  it('uploads as multipart and lets FormData set its own Content-Type', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ id: 'media-123' }));

    const mediaId = await uploadCloudMedia({
      phoneNumberId: PHONE_NUMBER_ID,
      accessToken: TOKEN,
      data: Buffer.from('bytes'),
      mimeType: 'image/jpeg',
      fileName: 'photo.jpg',
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    expect(mediaId).toBe('media-123');

    const init = fetchFn.mock.calls[0]![1];

    expect(init.body).toBeInstanceOf(FormData);
    // Overriding it would strip the multipart boundary and Meta would blame the file.
    expect(init.headers).not.toHaveProperty('Content-Type');
  });

  it('refuses an empty buffer', async () => {
    const fetchFn = vi.fn();

    await expect(
      uploadCloudMedia({
        phoneNumberId: PHONE_NUMBER_ID,
        accessToken: TOKEN,
        data: Buffer.alloc(0),
        mimeType: 'image/jpeg',
        fetchFn: fetchFn as unknown as typeof fetch,
      }),
    ).rejects.toThrow(WhatsAppCloudError);

    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('sends a caption on an image but not on audio, which WhatsApp would drop', async () => {
    const fetchFn = vi.fn().mockResolvedValue(sentOk());

    await sendCloudMedia({
      phoneNumberId: PHONE_NUMBER_ID,
      accessToken: TOKEN,
      to: '919876543210',
      kind: 'image',
      mediaId: 'media-123',
      caption: 'Look',
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    expect(JSON.parse(fetchFn.mock.calls[0]![1].body).image).toEqual({
      id: 'media-123',
      caption: 'Look',
    });

    fetchFn.mockClear();

    await sendCloudMedia({
      phoneNumberId: PHONE_NUMBER_ID,
      accessToken: TOKEN,
      to: '919876543210',
      kind: 'audio',
      mediaId: 'media-456',
      caption: 'Ignored',
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    expect(JSON.parse(fetchFn.mock.calls[0]![1].body).audio).toEqual({ id: 'media-456' });
  });

  it('sends a filename only on a document', async () => {
    const fetchFn = vi.fn().mockResolvedValue(sentOk());

    await sendCloudMedia({
      phoneNumberId: PHONE_NUMBER_ID,
      accessToken: TOKEN,
      to: '919876543210',
      kind: 'document',
      mediaId: 'media-789',
      fileName: 'quote.pdf',
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    expect(JSON.parse(fetchFn.mock.calls[0]![1].body).document.filename).toBe('quote.pdf');
  });

  it('resolves a media id to a download URL', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ url: 'https://lookaside.fbcdn.net/x', mime_type: 'image/jpeg', file_size: 10 }),
      );

    const descriptor = await describeCloudMedia({
      mediaId: '123456789012345',
      accessToken: TOKEN,
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    expect(descriptor.url).toBe('https://lookaside.fbcdn.net/x');
    expect(descriptor.mimeType).toBe('image/jpeg');
  });

  /**
   * The media id arrives in a webhook body. Without a host check, a crafted describe response
   * could steer a Bearer-token-bearing request at any server on the internet.
   */
  it('refuses to download from a host that is not Meta', async () => {
    const fetchFn = vi.fn();

    await expect(
      downloadCloudMedia({
        url: 'https://attacker.example.com/steal',
        accessToken: TOKEN,
        fetchFn: fetchFn as unknown as typeof fetch,
      }),
    ).rejects.toThrow(WhatsAppCloudError);

    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('refuses a host that merely ends with a Meta name', async () => {
    const fetchFn = vi.fn();

    await expect(
      downloadCloudMedia({
        url: 'https://evil-fbcdn.net/x',
        accessToken: TOKEN,
        fetchFn: fetchFn as unknown as typeof fetch,
      }),
    ).rejects.toThrow(WhatsAppCloudError);

    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('downloads from a Meta CDN host with the Bearer token attached', async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => '5' },
      arrayBuffer: () => Promise.resolve(new TextEncoder().encode('bytes').buffer),
    });

    const bytes = await downloadCloudMedia({
      url: 'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=123',
      accessToken: TOKEN,
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    expect(bytes.toString()).toBe('bytes');
    expect(fetchFn.mock.calls[0]![1].headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('refuses an oversized file from its Content-Length, before transferring it', async () => {
    const arrayBuffer = vi.fn();
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => '999999' },
      arrayBuffer,
    });

    await expect(
      downloadCloudMedia({
        url: 'https://lookaside.fbcdn.net/x',
        accessToken: TOKEN,
        maxBytes: 100,
        fetchFn: fetchFn as unknown as typeof fetch,
      }),
    ).rejects.toThrow(WhatsAppCloudError);

    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  /** A missing or lying Content-Length is not a reason to accept an unbounded file. */
  it('refuses an oversized file even when Content-Length is absent', async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => null },
      arrayBuffer: () => Promise.resolve(new Uint8Array(500).buffer),
    });

    await expect(
      downloadCloudMedia({
        url: 'https://lookaside.fbcdn.net/x',
        accessToken: TOKEN,
        maxBytes: 100,
        fetchFn: fetchFn as unknown as typeof fetch,
      }),
    ).rejects.toThrow(WhatsAppCloudError);
  });
});

describe('fetchCloudPhoneNumber', () => {
  it('reads back the verified name so an admin can see which number they connected', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({
        id: PHONE_NUMBER_ID,
        display_phone_number: '+91 98765 43210',
        verified_name: 'Vistaar Verse',
        quality_rating: 'GREEN',
      }),
    );

    const summary = await fetchCloudPhoneNumber({
      phoneNumberId: PHONE_NUMBER_ID,
      accessToken: TOKEN,
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    expect(summary).toEqual({
      id: PHONE_NUMBER_ID,
      displayPhoneNumber: '+91 98765 43210',
      verifiedName: 'Vistaar Verse',
      qualityRating: 'GREEN',
    });
  });
});

describe('fetchCloudTemplates', () => {
  it('returns approved and unapproved templates alike', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({
        data: [
          { name: 'welcome', language: 'en_US', status: 'approved', category: 'utility', components: [] },
          { name: 'promo', language: 'en_US', status: 'REJECTED', category: 'MARKETING', components: [] },
        ],
      }),
    );

    const templates = await fetchCloudTemplates({
      wabaId: WABA_ID,
      accessToken: TOKEN,
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    // An agent who cannot see that their template was rejected has no way to understand why
    // their messages stopped going out.
    expect(templates.map((template) => template.status)).toEqual(['APPROVED', 'REJECTED']);
  });

  it('drops a template with no name or no language, which cannot be sent', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({
        data: [
          { name: 'ok', language: 'en_US', status: 'APPROVED', components: [] },
          { name: 'no_language', status: 'APPROVED', components: [] },
          { language: 'en_US', status: 'APPROVED', components: [] },
        ],
      }),
    );

    const templates = await fetchCloudTemplates({
      wabaId: WABA_ID,
      accessToken: TOKEN,
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    expect(templates).toHaveLength(1);
    expect(templates[0]!.name).toBe('ok');
  });

  it('follows paging but stops at the page cap', async () => {
    const page = (next: string | undefined) =>
      jsonResponse({
        data: [{ name: 'x', language: 'en_US', status: 'APPROVED', components: [] }],
        paging: next ? { next } : {},
      });

    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(page('https://graph.facebook.com/next-1'))
      .mockResolvedValueOnce(page('https://graph.facebook.com/next-2'))
      .mockResolvedValueOnce(page(undefined));

    const templates = await fetchCloudTemplates({
      wabaId: WABA_ID,
      accessToken: TOKEN,
      maxPages: 2,
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(templates).toHaveLength(2);
  });

  it('refuses a malformed WABA id rather than building a URL from it', async () => {
    const fetchFn = vi.fn();

    await expect(
      fetchCloudTemplates({
        wabaId: 'me/accounts',
        accessToken: TOKEN,
        fetchFn: fetchFn as unknown as typeof fetch,
      }),
    ).rejects.toThrow(WhatsAppCloudError);

    expect(fetchFn).not.toHaveBeenCalled();
  });
});
