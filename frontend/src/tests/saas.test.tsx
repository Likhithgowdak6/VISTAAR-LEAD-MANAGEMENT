import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import LoginPage from '../pages/LoginPage';
import WorkspaceSettings from '../components/WorkspaceSettings';
import { getSignupOptions, getWorkspace, updateWorkspace, type WorkspaceDetails } from '../api/endpoints';

const { login, register, authedRequest } = vi.hoisted(() => ({
  login: vi.fn(), register: vi.fn(), authedRequest: vi.fn(),
}));
vi.mock('../auth/AuthContext', () => ({ useAuth: () => ({ login, register, authedRequest }) }));
vi.mock('../api/endpoints', () => ({ getSignupOptions: vi.fn(), getWorkspace: vi.fn(), updateWorkspace: vi.fn() }));
const workspace: WorkspaceDetails = {
  id: 'one', name: 'Studio One', slug: 'studio-one', plan: 'beta', billingStatus: 'not_configured',
  limits: { users: 5, whatsappAccounts: 1 }, usage: { users: 1, whatsappAccounts: 0 },
  profile: {}, onboarding: { businessProfile: false, whatsappConnected: false, knowledgeAdded: false },
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSignupOptions).mockResolvedValue({ data: { enabled: true, inviteRequired: false } });
  vi.mocked(getWorkspace).mockResolvedValue({ data: workspace });
  vi.mocked(updateWorkspace).mockResolvedValue({ data: { ...workspace, name: 'New Studio' } });
  login.mockResolvedValue(undefined);
  register.mockResolvedValue(undefined);
  authedRequest.mockImplementation((request) => request('token'));
});

describe('workspace signup', () => {
  it('keeps the existing sign-in form and adds registration using the same card', async () => {
    const { container } = render(<LoginPage />);
    expect(screen.getByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(container.querySelector('section.glass')).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: 'Create a workspace' }));
    expect(screen.getByRole('heading', { name: 'Create workspace' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Business'), { target: { value: 'Studio One' } });
    fireEvent.change(screen.getByLabelText('Your name'), { target: { value: 'Owner One' } });
    expect(screen.queryByLabelText('Organization')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'owner@example.com' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'correct-horse-battery' } });
    fireEvent.submit(screen.getByRole('form', { name: 'Create workspace' }));
    await waitFor(() => expect(register).toHaveBeenCalledWith({ organizationName: 'Studio One',
      name: 'Owner One', email: 'owner@example.com',
      password: 'correct-horse-battery', inviteCode: '' }));
    expect(login).not.toHaveBeenCalled();
  });

  it('leaves existing login usable when registration is closed', async () => {
    vi.mocked(getSignupOptions).mockResolvedValue({ data: { enabled: false, inviteRequired: false } });
    render(<LoginPage />);
    await waitFor(() => expect(getSignupOptions).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: 'Create a workspace' })).not.toBeInTheDocument();
    fireEvent.submit(screen.getByRole('form', { name: 'Sign in' }));
    await waitFor(() => expect(login).toHaveBeenCalled());
  });

  it('shows invite input and registration errors', async () => {
    vi.mocked(getSignupOptions).mockResolvedValue({ data: { enabled: true, inviteRequired: true } });
    register.mockRejectedValue(new Error('Workspace address is in use'));
    render(<LoginPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Create a workspace' }));
    expect(screen.getByLabelText('Invite code')).toBeRequired();
    fireEvent.submit(screen.getByRole('form', { name: 'Create workspace' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Workspace address is in use');
  });
});

describe('workspace settings', () => {
  it('shows actual usage and links to existing onboarding pages', async () => {
    const navigate = vi.fn();
    render(<WorkspaceSettings onNavigate={navigate} />);
    expect(await screen.findByText('Workspace: Studio One')).toBeInTheDocument();
    expect(screen.getByText('Team: 1 / 5')).toBeInTheDocument();
    expect(screen.getByText('WhatsApp: 0 / 1')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open accounts' }));
    expect(navigate).toHaveBeenCalledWith('team-and-accounts');
    fireEvent.click(screen.getByRole('button', { name: 'Open AI knowledge' }));
    expect(navigate).toHaveBeenCalledWith('ai-knowledge');
  });

  it('saves business details through the authenticated API', async () => {
    render(<WorkspaceSettings />);
    const name = await screen.findByLabelText('Business name');
    fireEvent.change(name, { target: { value: 'New Studio' } });
    fireEvent.change(screen.getByLabelText('Industry'), { target: { value: 'Photography' } });
    fireEvent.submit(screen.getByRole('form', { name: 'Workspace settings' }));
    await waitFor(() => expect(updateWorkspace).toHaveBeenCalledWith({ token: 'token',
      name: 'New Studio', industry: 'Photography', timezone: 'Asia/Kolkata' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Workspace saved');
  });
});
