import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import { ApiError } from '../api/client';
import {
  login as loginRequest,
  logout as logoutRequest,
  refresh as refreshRequest,
} from '../api/endpoints';

export interface AuthUser {
  id: string;
  name: string;
  role: string;
  mustChangePassword?: boolean;
  email?: string;
}

export interface AuthOrganization {
  id: string;
  name: string;
}

export interface AuthState {
  token: string | null;
  user: AuthUser | null;
  organization: AuthOrganization | null;
  permissions: string[];
}

export interface LoginCredentials {
  organizationSlug: string;
  email: string;
  password: string;
}

export interface AuthContextValue extends AuthState {
  isAuthenticated: boolean;
  bootstrapping: boolean;
  login: (credentials: LoginCredentials) => Promise<void>;
  logout: () => Promise<void>;
  authedRequest: <T>(makeRequest: (token: string | null) => Promise<T>) => Promise<T>;
  applyUser: (nextUser: AuthUser | null | undefined) => void;
}

interface AuthApiData {
  accessToken?: string | null;
  user?: AuthUser | null;
  organization?: AuthOrganization | null;
  permissions?: string[];
}

interface AuthApiPayload {
  data?: AuthApiData | null;
}

interface AuthProviderProps {
  children: ReactNode;
}

const AuthContext = createContext<AuthContextValue | null>(null);
const REFRESH_LOCK_NAME = 'wam-crm-refresh-session';

const EMPTY_AUTH: AuthState = {
  token: null,
  user: null,
  organization: null,
  permissions: [],
};

const readAuthPayload = (payload: unknown): AuthState => {
  const data = (payload as AuthApiPayload | null | undefined)?.data ?? {};

  return {
    token: data.accessToken ?? null,
    user: data.user ?? null,
    organization: data.organization ?? null,
    permissions: data.permissions ?? [],
  };
};

const getErrorStatus = (error: unknown): number | undefined => {
  if (!(error instanceof ApiError)) {
    return undefined;
  }

  return (error as ApiError & { status?: number }).status;
};

const requestRefreshWithBrowserLock = (): Promise<unknown> => {
  if (typeof navigator === 'undefined' || !navigator.locks) {
    return refreshRequest();
  }

  return navigator.locks.request(REFRESH_LOCK_NAME, () => refreshRequest());
};

export const AuthProvider = ({ children }: AuthProviderProps) => {
  const [auth, setAuth] = useState<AuthState>(EMPTY_AUTH);
  const [bootstrapping, setBootstrapping] = useState(true);
  const tokenRef = useRef<string | null>(null);
  const refreshPromiseRef = useRef<Promise<AuthState> | null>(null);

  const applyAuth = useCallback((next: AuthState) => {
    tokenRef.current = next.token;
    setAuth(next);
  }, []);

  const clearAuth = useCallback(() => {
    tokenRef.current = null;
    setAuth(EMPTY_AUTH);
  }, []);

  const refreshAuthState = useCallback((): Promise<AuthState> => {
    if (!refreshPromiseRef.current) {
      refreshPromiseRef.current = requestRefreshWithBrowserLock()
        .then((payload) => readAuthPayload(payload))
        .finally(() => {
          refreshPromiseRef.current = null;
        });
    }

    return refreshPromiseRef.current;
  }, []);

  const login = useCallback(
    async ({ organizationSlug, email, password }: LoginCredentials) => {
      const payload: unknown = await loginRequest({ organizationSlug, email, password });
      applyAuth(readAuthPayload(payload));
    },
    [applyAuth],
  );

  const logout = useCallback(async () => {
    try {
      await logoutRequest();
    } catch {
      // Ignore network/logout errors; the session is cleared locally regardless.
    } finally {
      clearAuth();
    }
  }, [clearAuth]);

  // Try to restore a session from the refresh cookie on first load.
  useEffect(() => {
    let active = true;

    (async () => {
      try {
        const nextAuth = await refreshAuthState();
        if (active) {
          applyAuth(nextAuth);
        }
      } catch {
        if (active) {
          clearAuth();
        }
      } finally {
        if (active) {
          setBootstrapping(false);
        }
      }
    })();

    return () => {
      active = false;
    };
  }, [applyAuth, clearAuth, refreshAuthState]);

  /**
   * Runs an authenticated request builder with the current token. On a 401 it refreshes
   * once and retries; if the refresh fails the session is cleared and the error rethrown.
   */
  const authedRequest = useCallback(
    async <T,>(makeRequest: (token: string | null) => Promise<T>): Promise<T> => {
      try {
        return await makeRequest(tokenRef.current);
      } catch (error: unknown) {
        if (getErrorStatus(error) !== 401) {
          throw error;
        }

        try {
          applyAuth(await refreshAuthState());
        } catch (refreshError: unknown) {
          clearAuth();
          throw refreshError;
        }

        return makeRequest(tokenRef.current);
      }
    },
    [applyAuth, clearAuth, refreshAuthState],
  );

  /**
   * Replaces the cached profile without a round trip — used after the user changes their own
   * password, so the refreshed `mustChangePassword: false` clears the forced-change gate.
   */
  const applyUser = useCallback((nextUser: AuthUser | null | undefined) => {
    setAuth((current) => ({ ...current, user: nextUser ?? current.user }));
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      ...auth,
      isAuthenticated: Boolean(auth.token),
      bootstrapping,
      login,
      logout,
      authedRequest,
      applyUser,
    }),
    [auth, bootstrapping, login, logout, authedRequest, applyUser],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

// eslint-disable-next-line react-refresh/only-export-components
export const useAuth = (): AuthContextValue => {
  const context = useContext(AuthContext);

  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider.');
  }

  return context;
};
