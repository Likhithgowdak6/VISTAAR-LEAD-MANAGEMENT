import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ConnectMetaButton from '../components/accounts/ConnectMetaButton';
import type * as MetaSignup from '../lib/meta-embedded-signup';
import * as api from '../api/endpoints';
import { loadFacebookSdk, parseSignupEvent, type FacebookSdk } from '../lib/meta-embedded-signup';

vi.mock('../api/endpoints');
vi.mock('../lib/meta-embedded-signup', async (original) => ({
  ...await original<typeof MetaSignup>(), loadFacebookSdk: vi.fn(),
}));
const { authedRequest } = vi.hoisted(() => ({ authedRequest: (fn: (token: string) => unknown) => fn('session-token') }));
vi.mock('../auth/AuthContext', () => ({ useAuth: () => ({ authedRequest }) }));

const finish = { type: 'WA_EMBEDDED_SIGNUP', event: 'FINISH', data: { phone_number_id: '123456789', waba_id: '987654321' } };
const message = (data = finish, origin = 'https://www.facebook.com') => {
  act(() => window.dispatchEvent(new MessageEvent('message', { origin, data: JSON.stringify(data) })));
};
let callback: Parameters<FacebookSdk['login']>[0];
let sdk: FacebookSdk;
beforeEach(() => {
  vi.clearAllMocks();
  sdk = { init: vi.fn(), login: vi.fn((cb) => { callback = cb; }) };
  vi.mocked(loadFacebookSdk).mockResolvedValue(sdk);
  vi.mocked(api.getEmbeddedSignupConfig).mockResolvedValue({ data: { available: true, appId: '12345', configId: '98765', graphVersion: 'v27.0' } });
  vi.mocked(api.startEmbeddedSignup).mockResolvedValue({ data: { state: 'a'.repeat(64) } });
  vi.mocked(api.exchangeEmbeddedSignup).mockResolvedValue({ data: { exchanged: true } });
  vi.mocked(api.completeEmbeddedSignup).mockResolvedValue({ data: { id: 'account', name: 'Official number' } as never });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });
const launch = async () => {
  const connected = vi.fn();
  const view = render(<ConnectMetaButton accountId="account" onConnected={connected} />);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Connect with Meta' })).toBeInTheDocument());
  fireEvent.change(screen.getByLabelText('WhatsApp two-step verification PIN'), { target: { value: '123456' } });
  fireEvent.click(screen.getByRole('button', { name: 'Connect with Meta' }));
  return { connected, ...view };
};

describe('Connect with Meta', () => {
  it.each(['code-first', 'assets-first'])('completes once with %s callbacks and never asks for API credentials', async (order) => {
    const { connected } = await launch();
    expect(sdk.login).toHaveBeenCalledWith(expect.any(Function), {
      config_id: '98765', response_type: 'code', override_default_response_type: true, extras: { setup: {} },
    });
    expect(screen.queryByLabelText('Access token')).not.toBeInTheDocument();
    if (order === 'assets-first') message();
    act(() => callback({ authResponse: { code: 'short-lived-code' } }));
    await waitFor(() => expect(api.exchangeEmbeddedSignup).toHaveBeenCalledWith(expect.objectContaining({ code: 'short-lived-code' })));
    if (order === 'code-first') {
      expect(api.completeEmbeddedSignup).not.toHaveBeenCalled();
      message();
    }
    await waitFor(() => expect(connected).toHaveBeenCalledTimes(1));
    message();
    act(() => callback({ authResponse: { code: 'duplicate-code' } }));
    expect(api.completeEmbeddedSignup).toHaveBeenCalledTimes(1);
    expect(api.completeEmbeddedSignup).toHaveBeenCalledWith(expect.objectContaining({ phoneNumberId: '123456789', wabaId: '987654321', pin: '123456', state: 'a'.repeat(64) }));
    expect(screen.getByLabelText('WhatsApp two-step verification PIN')).toHaveValue('');
  });
  it('waits for the server exchange before completing', async () => {
    let resolve!: (value: { data: { exchanged: boolean } }) => void;
    vi.mocked(api.exchangeEmbeddedSignup).mockReturnValue(new Promise((done) => { resolve = done; }));
    await launch();
    act(() => callback({ authResponse: { code: 'code' } }));
    message();
    expect(api.completeEmbeddedSignup).not.toHaveBeenCalled();
    await act(async () => resolve({ data: { exchanged: true } }));
    await waitFor(() => expect(api.completeEmbeddedSignup).toHaveBeenCalledTimes(1));
  });
  it('ignores spoofed origins even with valid-looking assets', async () => {
    await launch();
    act(() => callback({ authResponse: { code: 'code' } }));
    message(finish, 'https://attackerfacebook.com');
    await waitFor(() => expect(api.exchangeEmbeddedSignup).toHaveBeenCalledTimes(1));
    expect(api.completeEmbeddedSignup).not.toHaveBeenCalled();
    message();
    await waitFor(() => expect(api.completeEmbeddedSignup).toHaveBeenCalledTimes(1));
  });
  it('shows setup guidance and does not load the SDK when not configured', async () => {
    vi.mocked(api.getEmbeddedSignupConfig).mockResolvedValue({ data: { available: false } });
    render(<ConnectMetaButton accountId="account" onConnected={vi.fn()} />);
    expect(await screen.findByText(/awaiting platform setup/)).toBeInTheDocument();
    expect(loadFacebookSdk).not.toHaveBeenCalled();
    expect(api.startEmbeddedSignup).not.toHaveBeenCalled();
  });
  it('handles cancellation without connecting or exchanging a token', async () => {
    await launch();
    message({ ...finish, event: 'CANCEL' });
    expect(await screen.findByRole('alert')).toHaveTextContent('cancelled');
    act(() => callback({ authResponse: { code: 'late-code' } }));
    expect(api.exchangeEmbeddedSignup).not.toHaveBeenCalled();
    expect(api.completeEmbeddedSignup).not.toHaveBeenCalled();
  });
  it('rejects unsupported account-only or Business App coexistence flows', async () => {
    await launch();
    message({ ...finish, event: 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING' });
    expect(await screen.findByRole('alert')).toHaveTextContent('does not support');
    expect(api.completeEmbeddedSignup).not.toHaveBeenCalled();
  });
  it('removes callbacks on unmount, including a late code', async () => {
    const { unmount } = await launch();
    unmount(); message();
    act(() => callback({ authResponse: { code: 'late-code' } }));
    expect(api.exchangeEmbeddedSignup).not.toHaveBeenCalled();
  });
  it('keeps the connection incomplete after a server failure and offers a new attempt', async () => {
    vi.mocked(api.exchangeEmbeddedSignup).mockRejectedValue(new Error('Meta refused authorization'));
    await launch();
    message();
    act(() => callback({ authResponse: { code: 'code' } }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Meta refused authorization');
    expect(api.completeEmbeddedSignup).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Prepare a new connection' }));
    await waitFor(() => expect(api.startEmbeddedSignup).toHaveBeenCalledTimes(2));
  });
  it('times out abandoned windows and ignores late results', async () => {
    const timers = vi.spyOn(window, 'setTimeout');
    await launch();
    expect(screen.getByRole('button', { name: /Connecting with Meta/ })).toBeDisabled();
    const timer = timers.mock.calls.find((call) => call[1] === 5 * 60_000);
    expect(timer).toBeDefined();
    act(() => (timer![0] as () => void)());
    expect(screen.getByRole('alert')).toHaveTextContent('timed out');
    act(() => callback({ authResponse: { code: 'late-code' } }));
    expect(api.exchangeEmbeddedSignup).not.toHaveBeenCalled();
    timers.mockRestore();
  });
});

describe('Meta session event validation', () => {
  it.each(['https://facebook.com.evil.test', 'https://attackerfacebook.com', 'http://www.facebook.com', 'null'])('rejects %s', (origin) => {
    expect(parseSignupEvent({ origin, data: JSON.stringify(finish) })).toBeNull();
  });
  it('ignores malformed payloads and refuses missing or path-injected IDs', () => {
    const origin = 'https://www.facebook.com';
    expect(parseSignupEvent({ origin, data: 'invalid json' })).toBeNull();
    expect(parseSignupEvent({ origin, data: { ...finish, event: 'STEP' } })).toBeNull();
    expect(parseSignupEvent({ origin, data: { ...finish, data: {} } })).toEqual({ kind: 'unsupported' });
    expect(parseSignupEvent({ origin, data: { ...finish, data: { phone_number_id: '../other', waba_id: '987654321' } } })).toEqual({ kind: 'unsupported' });
  });
});
