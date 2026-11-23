import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Repository from './whatsapp-account.repository.js';
vi.mock('../../config/env.js', () => ({ env: { NODE_ENV: 'test', LOG_LEVEL: 'silent', WHATSAPP_CLOUD_ENABLED: true } }));
vi.mock('./whatsapp-account.repository.js', async (original) => ({
  ...await original<typeof Repository>(),
  findAccountById: vi.fn(), findCloudAccountByPhoneNumberId: vi.fn(), saveCloudCredentials: vi.fn(),
}));
vi.mock('../whatsapp/cloud/whatsapp-cloud.client.js', () => ({ fetchCloudPhoneNumber: vi.fn(), connectCloudWebhookSubscription: vi.fn() }));
vi.mock('../whatsapp/cloud/embedded-signup.client.js', () => ({ registerSignupPhone: vi.fn() }));
vi.mock('../whatsapp/cloud/cloud-credentials.service.js', () => ({
  encryptCloudAccessTokenForStorage: vi.fn(() => ({ ciphertext: 'encrypted-token' })),
  cloudAccessTokenLast4: vi.fn(() => 'last'), decryptCloudAccessTokenFromStorage: vi.fn(),
}));
import { connectCloudAccountForActor } from './whatsapp-account.service.js';
import * as repo from './whatsapp-account.repository.js';
import { fetchCloudPhoneNumber, connectCloudWebhookSubscription } from '../whatsapp/cloud/whatsapp-cloud.client.js';
import { registerSignupPhone } from '../whatsapp/cloud/embedded-signup.client.js';

const input = { organizationId: 'org-1', accountId: 'acc-1', actor: { _id: 'admin-1' },
  phoneNumberId: '123456789', wabaId: '987654321', accessToken: 'business-token-value', registrationPin: '123456' };
const account = { _id: 'acc-1', organizationId: 'org-1', provider: 'cloud', status: 'disconnected', cloud: {} };
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(repo.findAccountById).mockResolvedValue(account as never);
  vi.mocked(repo.findCloudAccountByPhoneNumberId).mockResolvedValue(null);
  vi.mocked(fetchCloudPhoneNumber).mockResolvedValue({ id: '123456789', displayPhoneNumber: '+911234567890', verifiedName: 'Customer business', qualityRating: 'GREEN' });
  vi.mocked(repo.saveCloudCredentials).mockResolvedValue({ ...account, status: 'active', cloud: { phoneNumberId: '123456789' } } as never);
});

describe('Embedded Signup reuses verified Cloud connection', () => {
  it('verifies and subscribes before registration, then saves only after registration succeeds', async () => {
    const calls: string[] = [];
    vi.mocked(connectCloudWebhookSubscription).mockImplementation(async () => { calls.push('verify-and-subscribe'); });
    vi.mocked(registerSignupPhone).mockImplementation(async () => { calls.push('register'); });
    vi.mocked(repo.saveCloudCredentials).mockImplementation(async () => { calls.push('save'); return { ...account, status: 'active' } as never; });
    await connectCloudAccountForActor(input);
    expect(calls).toEqual(['verify-and-subscribe', 'register', 'save']);
    expect(registerSignupPhone).toHaveBeenCalledWith(input.phoneNumberId, input.accessToken, input.registrationPin);
    expect(repo.findAccountById).toHaveBeenCalledWith({ accountId: 'acc-1', organizationId: 'org-1' });
  });
  it('refuses a different workspace or missing target before contacting Meta', async () => {
    vi.mocked(repo.findAccountById).mockResolvedValue(null);
    await expect(connectCloudAccountForActor(input)).rejects.toThrow('ACCOUNT_NOT_FOUND');
    expect(fetchCloudPhoneNumber).not.toHaveBeenCalled();
    expect(registerSignupPhone).not.toHaveBeenCalled();
  });
  it('refuses to register a number linked to another account', async () => {
    vi.mocked(repo.findCloudAccountByPhoneNumberId).mockResolvedValue({ _id: 'other-account' } as never);
    await expect(connectCloudAccountForActor(input)).rejects.toThrow('CLOUD_PHONE_ALREADY_CONNECTED');
    expect(fetchCloudPhoneNumber).not.toHaveBeenCalled();
    expect(registerSignupPhone).not.toHaveBeenCalled();
    expect(repo.saveCloudCredentials).not.toHaveBeenCalled();
  });
  it('does not register or save when WABA ownership verification fails', async () => {
    vi.mocked(connectCloudWebhookSubscription).mockRejectedValue(new Error('account mismatch'));
    await expect(connectCloudAccountForActor(input)).rejects.toThrow('account mismatch');
    expect(registerSignupPhone).not.toHaveBeenCalled();
    expect(repo.saveCloudCredentials).not.toHaveBeenCalled();
  });
  it('preserves stored credentials when number registration fails', async () => {
    vi.mocked(registerSignupPhone).mockRejectedValue(new Error('incorrect PIN'));
    await expect(connectCloudAccountForActor(input)).rejects.toThrow('incorrect PIN');
    expect(repo.saveCloudCredentials).not.toHaveBeenCalled();
  });
  it('does not register existing manual credential connections', async () => {
    await connectCloudAccountForActor({ ...input, registrationPin: undefined });
    expect(registerSignupPhone).not.toHaveBeenCalled();
    expect(repo.saveCloudCredentials).toHaveBeenCalledTimes(1);
  });
});
