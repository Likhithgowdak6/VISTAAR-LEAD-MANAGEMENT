import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import App from '../App';
import * as endpointsApi from '../api/endpoints';
import { ApiError } from '../api/client';

// Tests may use `any` for Vitest mocks of untyped endpoint modules.
const endpoints = endpointsApi as any;

vi.mock('../api/endpoints');

afterEach(() => {
  vi.clearAllMocks();
});

describe('App', () => {
  it('renders the sign-in screen when no session can be restored', async () => {
    endpoints.refresh.mockRejectedValue(new ApiError({ status: 401, code: 'NO_SESSION' } as any));

    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
  });
});
