import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as endpointsApi from '../api/endpoints';
import { ApiError } from '../api/client';
import { AuthProvider, useAuth } from '../auth/AuthContext';
import { type AuthResponse } from '../types';

vi.mock('../api/endpoints');

const authPayload = (accessToken: string) =>
  ({
    data: {
      accessToken,
      user: { id: 'u1', name: 'Asha Menon' },
      organization: { id: 'o1', name: 'Acme' },
      permissions: ['conversations.read_all'],
    },
  }) as AuthResponse;

const ConcurrentRequestProbe = () => {
  const { authedRequest, bootstrapping } = useAuth();
  const [result, setResult] = useState('');

  if (bootstrapping) {
    return <span>Bootstrapping</span>;
  }

  return (
    <>
      <button
        type="button"
        onClick={async () => {
          const request = async (token: string | null) => {
            if (token === 'access-token-1') {
              throw new ApiError({
                status: 401,
                code: 'SESSION_NOT_ACTIVE',
              });
            }

            return token;
          };

          const tokens = await Promise.all([authedRequest(request), authedRequest(request)]);
          setResult(tokens.join(','));
        }}
      >
        Run concurrent requests
      </button>
      <output>{result}</output>
    </>
  );
};

afterEach(() => {
  vi.clearAllMocks();
});

describe('AuthProvider refresh coordination', () => {
  it('shares one refresh across concurrent authenticated requests', async () => {
    const refresh = vi.mocked(endpointsApi.refresh);
    refresh.mockResolvedValueOnce(authPayload('access-token-1'));
    refresh.mockResolvedValue(authPayload('access-token-2'));

    render(
      <AuthProvider>
        <ConcurrentRequestProbe />
      </AuthProvider>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Run concurrent requests' }));

    expect(await screen.findByText('access-token-2,access-token-2')).toBeInTheDocument();
    expect(refresh).toHaveBeenCalledTimes(2);
  });
});
