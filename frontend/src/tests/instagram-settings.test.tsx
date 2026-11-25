/**
 * The Instagram settings panel.
 *
 * TWO THINGS IT MUST NEVER GET WRONG.
 *
 * **Automation must not start by itself.** Connecting an account, or writing a welcome, must not
 * begin messaging customers — only the switch does, and the copy has to say so.
 *
 * **An empty Page list must not be silent.** It reads as "we have no Pages" when it usually means
 * "the stored Facebook authorisation could not ask" — a different problem with a different fix,
 * and the one the reauthorization action exists for.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  useAuth: vi.fn(),
  listInstagramAccounts: vi.fn(),
  listInstagramCandidates: vi.fn(),
  connectInstagramAccount: vi.fn(),
  updateInstagramAutomation: vi.fn(),
  disconnectInstagramAccount: vi.fn(),
}));

vi.mock('../api/instagram', () => ({
  listInstagramAccounts: mocks.listInstagramAccounts,
  listInstagramCandidates: mocks.listInstagramCandidates,
  connectInstagramAccount: mocks.connectInstagramAccount,
  updateInstagramAutomation: mocks.updateInstagramAutomation,
  disconnectInstagramAccount: mocks.disconnectInstagramAccount,
}));

vi.mock('../auth/AuthContext', () => ({ useAuth: mocks.useAuth }));
vi.mock('../hooks/useMobileBackLayer', () => ({ useMobileBackLayer: () => undefined }));

const { ApiError } = await import('../api/client');
const InstagramPanel = (await import('../components/settings/InstagramPanel')).default;

const account = (over: Record<string, unknown> = {}) => ({
  id: 'acc1',
  instagramAccountId: '17841400000000001',
  username: 'vistaarevents',
  pageId: '1234',
  pageName: 'Vistaar Events',
  accessTokenLast4: 'bcd1',
  status: 'active',
  lastError: null,
  lastErrorAt: null,
  lastInboundAt: null,
  automationEnabled: false,
  welcomeReply: null,
  keywordReplies: [],
  ...over,
});

const candidate = (over: Record<string, unknown> = {}) => ({
  pageId: '1234',
  pageName: 'Vistaar Events',
  instagram: { id: '17841400000000001', username: 'vistaarevents' },
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.useAuth.mockReturnValue({
    permissions: ['settings.manage'],
    authedRequest: (make: (token: string) => unknown) => Promise.resolve(make('t')),
  });
  mocks.listInstagramAccounts.mockResolvedValue({ data: [] });
  mocks.listInstagramCandidates.mockResolvedValue({ data: [] });
});

describe('before anything is connected', () => {
  it('says Instagram reuses the Facebook connection, so nobody hunts for a second login', async () => {
    render(<InstagramPanel />);

    expect(await screen.findByText(/no second login/i)).toBeInTheDocument();
  });

  it('offers a connectable account', async () => {
    mocks.listInstagramCandidates.mockResolvedValue({ data: [candidate()] });

    render(<InstagramPanel />);

    expect(await screen.findByText('@vistaarevents')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect' })).toBeInTheDocument();
  });

  it('explains a Page with no Instagram account rather than hiding it', async () => {
    // "My Page is not in the list" is a much harder question than "this Page has no Instagram
    // account attached".
    mocks.listInstagramCandidates.mockResolvedValue({
      data: [candidate({ instagram: null })],
    });

    render(<InstagramPanel />);

    expect(
      await screen.findByText(/no Instagram professional account attached/i),
    ).toBeInTheDocument();
  });

  it('says connecting does not start automatic replies', async () => {
    mocks.listInstagramCandidates.mockResolvedValue({ data: [candidate()] });
    mocks.connectInstagramAccount.mockResolvedValue({ data: account() });

    render(<InstagramPanel />);

    fireEvent.click(await screen.findByRole('button', { name: 'Connect' }));

    expect(await screen.findByRole('status')).toHaveTextContent(/off until you turn them on/i);
  });
});

describe('when the Facebook authorisation cannot list Pages', () => {
  const refuse = (code: string, message: string) =>
    mocks.listInstagramCandidates.mockRejectedValue(new ApiError({ status: 409, code, message }));

  it('offers a reconnect action instead of an empty list', async () => {
    refuse('META_NOT_CONNECTED', 'Connect Facebook first under Lead Sources.');

    render(<InstagramPanel />);

    expect(await screen.findByText('Facebook needs reconnecting')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reconnect Facebook' })).toBeInTheDocument();
  });

  it('shows the reason the server gave', async () => {
    refuse('META_NOT_CONNECTED', 'Connect Facebook first under Lead Sources.');

    render(<InstagramPanel />);

    expect(await screen.findByText(/Connect Facebook first/i)).toBeInTheDocument();
  });

  it('names the missing Instagram permissions, which an older grant will not have', async () => {
    refuse('META_PAGES_UNAVAILABLE', 'Meta would not list your Pages.');

    render(<InstagramPanel />);

    expect(await screen.findByText(/Instagram permissions/i)).toBeInTheDocument();
  });

  it('sends the admin to the one screen that can fix it', async () => {
    refuse('META_NOT_CONNECTED', 'Connect Facebook first.');

    const onNavigate = vi.fn();

    render(<InstagramPanel onNavigate={onNavigate} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Reconnect Facebook' }));

    expect(onNavigate).toHaveBeenCalledWith('lead-sources');
  });

  it('still shows a working connected account alongside the warning', async () => {
    // The connected account keeps working even when the user token can no longer list Pages.
    mocks.listInstagramAccounts.mockResolvedValue({ data: [account()] });
    refuse('META_NOT_CONNECTED', 'Connect Facebook first.');

    render(<InstagramPanel />);

    expect(await screen.findByText('Facebook needs reconnecting')).toBeInTheDocument();
    expect(screen.getByText('@vistaarevents')).toBeInTheDocument();
  });
});

describe('a connected account', () => {
  beforeEach(() => {
    mocks.listInstagramAccounts.mockResolvedValue({ data: [account()] });
  });

  it('reads as auto-replies off until somebody turns them on', async () => {
    render(<InstagramPanel />);

    expect(await screen.findByText('Auto-replies off')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Turn on automatic replies' })).toBeInTheDocument();
  });

  it('warns that turning it on messages customers with nobody present', async () => {
    mocks.updateInstagramAutomation.mockResolvedValue({
      data: account({ automationEnabled: true }),
    });

    render(<InstagramPanel />);

    fireEvent.click(await screen.findByRole('button', { name: 'Turn on automatic replies' }));

    expect(await screen.findByRole('status')).toHaveTextContent(/without anybody present/i);
  });

  it('saves a welcome without turning automation on', async () => {
    // Writing a reply is not consenting to send it.
    mocks.updateInstagramAutomation.mockResolvedValue({ data: account() });

    render(<InstagramPanel />);

    fireEvent.change(await screen.findByLabelText('Welcome reply'), {
      target: { value: 'Thanks for getting in touch' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save replies' }));

    await waitFor(() => expect(mocks.updateInstagramAutomation).toHaveBeenCalled());

    const sent = mocks.updateInstagramAutomation.mock.calls[0]![0];
    expect(sent.welcomeReply).toBe('Thanks for getting in touch');
    expect(sent).not.toHaveProperty('automationEnabled');
  });

  it('adds and removes keyword rules', async () => {
    render(<InstagramPanel />);

    fireEvent.click(await screen.findByRole('button', { name: 'Add keyword' }));

    expect(screen.getByLabelText('Keyword 1')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));

    expect(screen.queryByLabelText('Keyword 1')).not.toBeInTheDocument();
  });

  it('explains that the first matching keyword wins', async () => {
    // The order in the list is the priority, which is something an admin can see and reorder.
    render(<InstagramPanel />);

    expect(await screen.findByText(/first one that matches wins/i)).toBeInTheDocument();
  });

  it('shows the error Instagram gave, word for word', async () => {
    mocks.listInstagramAccounts.mockResolvedValue({
      data: [
        account({
          status: 'needs_attention',
          lastError:
            'Instagram refused the send for lack of permission. Allow Access to Messages must be on.',
        }),
      ],
    });

    render(<InstagramPanel />);

    expect(await screen.findByText(/Allow Access to Messages/i)).toBeInTheDocument();
    expect(screen.getByText('Needs attention')).toBeInTheDocument();
  });

  it('asks before disconnecting, and says what stays', async () => {
    render(<InstagramPanel />);

    fireEvent.click(await screen.findByRole('button', { name: 'Disconnect' }));

    const dialog = await screen.findByRole('dialog', { name: /Disconnect Instagram/ });

    expect(dialog).toHaveTextContent(/Conversations already in your inbox stay/i);
    expect(mocks.disconnectInstagramAccount).not.toHaveBeenCalled();
  });

  it('never renders the page token, because none is returned', async () => {
    render(<InstagramPanel />);

    await screen.findByText('@vistaarevents');

    expect(document.body.textContent).not.toContain('bcd1');
  });
});

describe('loading and failure', () => {
  it('shows a spinner first', () => {
    mocks.listInstagramAccounts.mockReturnValue(new Promise(() => {}));

    render(<InstagramPanel />);

    expect(screen.getByText(/Loading Instagram settings/i)).toBeInTheDocument();
  });

  it('reports a failed load rather than an empty panel', async () => {
    mocks.listInstagramAccounts.mockRejectedValue(new Error('Upstream unavailable.'));

    render(<InstagramPanel />);

    expect(await screen.findByRole('alert')).toHaveTextContent(/Upstream unavailable/i);
  });
});
