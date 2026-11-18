/**
 * What stands in for a session on a Cloud account.
 *
 * Almost everything here is about REFUSING to send: a paused number, a disconnected one, a Cloud
 * send attempted against a Baileys account, a token that will not decrypt. Each of those refusals
 * has to be NEEDS_ATTENTION rather than transient, because the delivery queue reads that to decide
 * whether to spend three attempts and fifteen minutes reaching the same answer.
 *
 * The other theme is that credentials are re-read on EVERY send. That is a deliberate design
 * choice with a cost, and the test for it is what stops somebody adding a cache without noticing
 * that a disconnected number would keep sending from it.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../config/env.js', () => ({
  env: { NODE_ENV: 'test', LOG_LEVEL: 'silent' },
}));

const { buildTemplateComponents, createCloudRuntime } = await import('./cloud-runtime.service.js');
const { CLOUD_FAILURE_KINDS, WhatsAppCloudError } = await import('./cloud.errors.js');
const { ACCOUNT_STATUSES } = await import('../../../constants/account-statuses.js');

const ACCOUNT_ID = 'account-1';
const ORG_ID = 'org-1';

const account = (overrides: Record<string, unknown> = {}) => ({
  _id: { toString: () => ACCOUNT_ID },
  organizationId: { toString: () => ORG_ID },
  provider: 'cloud',
  status: ACCOUNT_STATUSES.ACTIVE,
  encryptedCloudToken: { ciphertext: 'x' },
  cloud: { phoneNumberId: '109876543210987', wabaId: '102233445566778' },
  ...overrides,
});

const runtime = (overrides: Record<string, unknown> = {}) =>
  createCloudRuntime({
    findAccount: vi.fn().mockResolvedValue(account()),
    sendText: vi.fn().mockResolvedValue({ providerMessageId: 'wamid.X' }),
    sendTemplate: vi.fn().mockResolvedValue({ providerMessageId: 'wamid.T' }),
    sendMedia: vi.fn().mockResolvedValue({ providerMessageId: 'wamid.M' }),
    uploadMedia: vi.fn().mockResolvedValue('media-1'),
    decryptToken: vi.fn().mockReturnValue('token'),
    ...overrides,
  } as never);

const expectNeedsAttention = async (promise: Promise<unknown>) => {
  try {
    await promise;
    expect.unreachable('should have thrown');
  } catch (error) {
    const err = error as InstanceType<typeof WhatsAppCloudError>;

    expect(err).toBeInstanceOf(WhatsAppCloudError);
    expect(err.failureKind).toBe(CLOUD_FAILURE_KINDS.NEEDS_ATTENTION);
    // The queue reads this to fail the message now rather than retrying to the same answer.
    expect(err.permanent).toBe(true);
  }
};

describe('resolveCredentials', () => {
  it('resolves phone number id, WABA id and the decrypted token', async () => {
    const credentials = await runtime().resolveCredentials({
      accountId: ACCOUNT_ID,
      organizationId: ORG_ID,
    });

    expect(credentials).toEqual({
      accountId: ACCOUNT_ID,
      organizationId: ORG_ID,
      phoneNumberId: '109876543210987',
      wabaId: '102233445566778',
      accessToken: 'token',
    });
  });

  it('scopes the lookup to the organisation', async () => {
    const findAccount = vi.fn().mockResolvedValue(account());

    await runtime({ findAccount }).resolveCredentials({
      accountId: ACCOUNT_ID,
      organizationId: ORG_ID,
    });

    expect(findAccount).toHaveBeenCalledWith({
      accountId: ACCOUNT_ID,
      organizationId: ORG_ID,
      includeEncrypted: true,
    });
  });

  it('refuses an account that no longer exists', async () => {
    await expectNeedsAttention(
      runtime({ findAccount: vi.fn().mockResolvedValue(null) }).resolveCredentials({
        accountId: ACCOUNT_ID,
      }),
    );
  });

  it('refuses a Baileys account', async () => {
    await expectNeedsAttention(
      runtime({
        findAccount: vi.fn().mockResolvedValue(account({ provider: 'baileys' })),
      }).resolveCredentials({ accountId: ACCOUNT_ID }),
    );
  });

  it.each([
    ACCOUNT_STATUSES.PAUSED,
    ACCOUNT_STATUSES.DISCONNECTED,
    ACCOUNT_STATUSES.REMOVED,
    ACCOUNT_STATUSES.BLOCKED,
  ])('refuses a %s account', async (status) => {
    await expectNeedsAttention(
      runtime({
        findAccount: vi.fn().mockResolvedValue(account({ status })),
      }).resolveCredentials({ accountId: ACCOUNT_ID }),
    );
  });

  it('refuses an account with no phone number id', async () => {
    await expectNeedsAttention(
      runtime({
        findAccount: vi.fn().mockResolvedValue(account({ cloud: { phoneNumberId: null } })),
      }).resolveCredentials({ accountId: ACCOUNT_ID }),
    );
  });

  it('refuses an account whose token is missing', async () => {
    await expectNeedsAttention(
      runtime({ decryptToken: vi.fn().mockReturnValue(null) }).resolveCredentials({
        accountId: ACCOUNT_ID,
      }),
    );
  });

  /**
   * Checked BEFORE the credentials, because a paused number has working credentials and "paused"
   * is an instruction, not a fault - the message the agent reads should say so.
   */
  it('reports a paused account as paused rather than as a missing token', async () => {
    await expect(
      runtime({
        findAccount: vi.fn().mockResolvedValue(
          account({ status: ACCOUNT_STATUSES.PAUSED, encryptedCloudToken: null }),
        ),
        decryptToken: vi.fn().mockReturnValue(null),
      }).resolveCredentials({ accountId: ACCOUNT_ID }),
    ).rejects.toThrow(/paused/i);
  });
});

describe('sending', () => {
  it('sends text with the resolved credentials', async () => {
    const sendText = vi.fn().mockResolvedValue({ providerMessageId: 'wamid.X' });

    const result = await runtime({ sendText }).sendTextMessage({
      accountId: ACCOUNT_ID,
      organizationId: ORG_ID,
      to: '919876543210',
      text: 'Hello',
    });

    expect(sendText).toHaveBeenCalledWith({
      phoneNumberId: '109876543210987',
      accessToken: 'token',
      to: '919876543210',
      text: 'Hello',
    });

    expect(result).toMatchObject({ provider: 'cloud', sent: true, providerMessageId: 'wamid.X' });
  });

  /**
   * The reason there is no credential cache. A number the owner just disconnected must stop
   * sending on the very next message, not when a TTL happens to expire.
   */
  it('re-reads credentials on every send', async () => {
    const findAccount = vi.fn().mockResolvedValue(account());
    const cloud = runtime({ findAccount });

    await cloud.sendTextMessage({ accountId: ACCOUNT_ID, to: '919876543210', text: 'one' });
    await cloud.sendTextMessage({ accountId: ACCOUNT_ID, to: '919876543210', text: 'two' });

    expect(findAccount).toHaveBeenCalledTimes(2);
  });

  it('uploads media first, then sends it by id', async () => {
    const uploadMedia = vi.fn().mockResolvedValue('media-42');
    const sendMedia = vi.fn().mockResolvedValue({ providerMessageId: 'wamid.M' });

    await runtime({ uploadMedia, sendMedia }).sendMediaMessage({
      accountId: ACCOUNT_ID,
      to: '919876543210',
      kind: 'image',
      data: Buffer.from('bytes'),
      mimeType: 'image/jpeg',
      fileName: 'hall.jpg',
      caption: 'The hall',
    });

    expect(uploadMedia).toHaveBeenCalledWith(
      expect.objectContaining({ mimeType: 'image/jpeg', fileName: 'hall.jpg' }),
    );

    expect(sendMedia).toHaveBeenCalledWith(
      expect.objectContaining({ mediaId: 'media-42', kind: 'image', caption: 'The hall' }),
    );
  });

  it('does not send media when the upload fails', async () => {
    const sendMedia = vi.fn();

    await expect(
      runtime({
        uploadMedia: vi.fn().mockRejectedValue(new Error('upload failed')),
        sendMedia,
      }).sendMediaMessage({
        accountId: ACCOUNT_ID,
        to: '919876543210',
        kind: 'image',
        data: Buffer.from('bytes'),
        mimeType: 'image/jpeg',
      }),
    ).rejects.toThrow();

    expect(sendMedia).not.toHaveBeenCalled();
  });

  it('sends a template by name and language', async () => {
    const sendTemplate = vi.fn().mockResolvedValue({ providerMessageId: 'wamid.T' });

    await runtime({ sendTemplate }).sendTemplateMessage({
      accountId: ACCOUNT_ID,
      to: '919876543210',
      templateName: 'welcome_lead',
      languageCode: 'en_US',
      components: [{ type: 'body', parameters: [{ type: 'text', text: 'Riya' }] }],
    });

    expect(sendTemplate).toHaveBeenCalledWith(
      expect.objectContaining({ templateName: 'welcome_lead', languageCode: 'en_US' }),
    );
  });
});

describe('listSendableAccounts', () => {
  it('returns ids only, never credentials', async () => {
    const accounts = await runtime({
      findCloudAccounts: vi.fn().mockResolvedValue([account()]),
    }).listSendableAccounts();

    expect(accounts).toEqual([{ accountId: ACCOUNT_ID, organizationId: ORG_ID }]);
  });
});

describe('buildTemplateComponents', () => {
  it('builds body parameters in order', () => {
    expect(buildTemplateComponents({ bodyParameters: ['Riya', '12th'] })).toEqual([
      {
        type: 'body',
        parameters: [
          { type: 'text', text: 'Riya' },
          { type: 'text', text: '12th' },
        ],
      },
    ]);
  });

  it('puts the header before the body, as Meta expects', () => {
    const components = buildTemplateComponents({
      bodyParameters: ['Riya'],
      headerParameters: ['Vistaar'],
    });

    expect(components.map((component) => component.type)).toEqual(['header', 'body']);
  });

  /** Meta rejects an empty `parameters` array on a component that declares none. */
  it('omits a component entirely when it has no parameters', () => {
    expect(buildTemplateComponents({ bodyParameters: [], headerParameters: [] })).toEqual([]);
    expect(buildTemplateComponents({})).toEqual([]);
  });
});
