/* eslint-disable react-refresh/only-export-components -- shared test helpers, not a component module */
import { render } from '@testing-library/react';
import type { ReactNode } from 'react';

import { AuthProvider } from '../auth/AuthContext';

type AuthPayloadOptions = {
  permissions?: string[];
  role?: string;
};

export const AUTH_PAYLOAD = ({ permissions, role = 'admin' }: AuthPayloadOptions = {}) => ({
  data: {
    accessToken: 'access-token-1',
    user: { id: 'u1', name: 'Asha Menon', role },
    organization: { id: 'o1', name: 'Acme' },
    permissions,
  },
});

/**
 * Renders a component inside a real AuthProvider whose session is restored from a mocked
 * `refresh` (so `authedRequest` has a token and the given permissions/role).
 */
export const renderAuthed = (ui: ReactNode) => render(<AuthProvider>{ui}</AuthProvider>);
