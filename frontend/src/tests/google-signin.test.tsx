import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import GoogleSignIn from '../components/GoogleSignIn';
import { apiFetch } from '../api/client';
const { acceptSession, initialize, renderButton } = vi.hoisted(() => ({ acceptSession: vi.fn(), initialize: vi.fn(), renderButton: vi.fn() }));
vi.mock('../auth/AuthContext', () => ({ useAuth: () => ({ acceptSession }) }));
vi.mock('../api/client', () => ({ apiFetch: vi.fn() }));
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('google', { accounts: { id: { initialize, renderButton } } });
});
afterEach(() => vi.unstubAllGlobals());
it('uses the server nonce and accepts the verified application session', async () => {
  const session = { data: { accessToken: 'application-token' } };
  vi.mocked(apiFetch).mockResolvedValueOnce({ data: { nonce: 'browser-nonce' } }).mockResolvedValueOnce(session);
  render(<GoogleSignIn clientId="web-client" inviteCode="" />);
  await waitFor(() => expect(initialize).toHaveBeenCalled());
  expect(initialize.mock.calls[0][0]).toMatchObject({ client_id: 'web-client', nonce: 'browser-nonce' });
  await act(async () => { initialize.mock.calls[0][0].callback({ credential: 'google-token' }); });
  await waitFor(() => expect(acceptSession).toHaveBeenCalledWith(session));
});
it('chooses a verified workspace without asking for a workspace address', async () => {
  vi.mocked(apiFetch).mockResolvedValueOnce({ data: { nonce: 'browser-nonce' } })
    .mockResolvedValueOnce({ data: { selectionRequired: true, workspaces: [{ id: 'org-one', name: 'Studio One' }] } })
    .mockResolvedValueOnce({ data: { accessToken: 'chosen-token' } });
  render(<GoogleSignIn clientId="web-client" inviteCode="" />);
  await waitFor(() => expect(initialize).toHaveBeenCalled());
  await act(async () => { initialize.mock.calls[0][0].callback({ credential: 'google-token' }); });
  fireEvent.click(await screen.findByRole('button', { name: 'Studio One' }));
  await waitFor(() => expect(acceptSession).toHaveBeenCalled());
  expect(apiFetch).toHaveBeenLastCalledWith('/auth/google', { method: 'POST', body: {
    credential: 'google-token', organizationId: 'org-one', inviteCode: '' } });
});
