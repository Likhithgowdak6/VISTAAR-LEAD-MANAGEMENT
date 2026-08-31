import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import App from '../App';
import * as endpointsApi from '../api/endpoints';
import { ApiError } from '../api/client';

// Tests may use `any` for Vitest mocks of untyped endpoint modules.
const endpoints = endpointsApi as any;

vi.mock('../api/endpoints');

const authPayload = {
  data: {
    accessToken: 'access-token-1',
    user: { id: 'u1', name: 'Asha Menon' },
    organization: { id: 'o1', name: 'Acme' },
    permissions: ['conversations.read_all'],
  },
};

beforeEach(() => {
  endpoints.listConversations.mockResolvedValue({ data: [] });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('login flow', () => {
  it('shows the login screen when there is no session, then signs in', async () => {
    endpoints.refresh.mockRejectedValue(new ApiError({ status: 401, code: 'NO_SESSION' } as any));
    endpoints.login.mockResolvedValue(authPayload);

    render(<App />);

    const heading = await screen.findByRole('heading', { name: 'Sign in' });
    expect(heading).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Organization'), { target: { value: 'acme' } });
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'asha@acme.com' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'secret-123' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() =>
      expect(endpoints.login).toHaveBeenCalledWith({
        organizationSlug: 'acme',
        email: 'asha@acme.com',
        password: 'secret-123',
      }),
    );

    expect(await screen.findByText('Conversations')).toBeInTheDocument();
    expect(screen.getByText('Asha Menon')).toBeInTheDocument();
  });

  it('shows an error and stays on the login screen when credentials are rejected', async () => {
    endpoints.refresh.mockRejectedValue(new ApiError({ status: 401, code: 'NO_SESSION' } as any));
    endpoints.login.mockRejectedValue(
      new ApiError({
        status: 401,
        code: 'INVALID_CREDENTIALS',
        message: 'Invalid credentials.',
      } as any),
    );

    render(<App />);

    await screen.findByRole('heading', { name: 'Sign in' });
    fireEvent.change(screen.getByLabelText('Organization'), { target: { value: 'acme' } });
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'asha@acme.com' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'wrong' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid credentials.');
    expect(screen.getByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
  });
});
