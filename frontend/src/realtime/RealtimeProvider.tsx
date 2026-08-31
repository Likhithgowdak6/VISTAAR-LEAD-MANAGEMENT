import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from 'react';

import { API_BASE_URL } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { parseSseBuffer } from './parse-sse';

export type RealtimeHandler = (event: unknown) => void;

export interface RealtimeContextValue {
  subscribe: (handler: RealtimeHandler) => () => void;
}

interface RealtimeProviderProps {
  children: ReactNode;
}

const RealtimeContext = createContext<RealtimeContextValue | null>(null);

const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 15000;

export const RealtimeProvider = ({ children }: RealtimeProviderProps) => {
  const { token, isAuthenticated } = useAuth();
  const subscribersRef = useRef(new Set<RealtimeHandler>());

  const dispatch = useCallback((event: unknown) => {
    subscribersRef.current.forEach((handler) => {
      try {
        handler(event);
      } catch {
        // A misbehaving subscriber must not break delivery to the others.
      }
    });
  }, []);

  useEffect(() => {
    if (!isAuthenticated || !token) {
      return undefined;
    }

    const controller = new AbortController();
    let stopped = false;
    let reconnectDelay = RECONNECT_MIN_MS;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const connect = async () => {
      try {
        const response = await fetch(`${API_BASE_URL}/realtime/stream`, {
          headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
          credentials: 'include',
          signal: controller.signal,
        });

        if (!response.ok || !response.body) {
          throw new Error(`Realtime stream failed: ${response.status}`);
        }

        reconnectDelay = RECONNECT_MIN_MS;

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          buffer += decoder.decode(value, { stream: true });
          const { events, rest } = parseSseBuffer(buffer);
          buffer = rest;
          events.forEach(dispatch);
        }
      } catch {
        // Fall through to reconnect unless we were intentionally stopped.
      }

      if (!stopped) {
        reconnectTimer = setTimeout(() => {
          void connect();
        }, reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
      }
    };

    void connect();

    return () => {
      stopped = true;
      controller.abort();
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
      }
    };
  }, [token, isAuthenticated, dispatch]);

  const subscribe = useCallback((handler: RealtimeHandler) => {
    subscribersRef.current.add(handler);
    return () => {
      subscribersRef.current.delete(handler);
    };
  }, []);

  const value = useMemo<RealtimeContextValue>(() => ({ subscribe }), [subscribe]);

  return <RealtimeContext.Provider value={value}>{children}</RealtimeContext.Provider>;
};

// eslint-disable-next-line react-refresh/only-export-components
export const useRealtime = (): RealtimeContextValue => {
  const context = useContext(RealtimeContext);

  if (!context) {
    // A no-op fallback keeps components usable outside a provider (e.g. in tests).
    return { subscribe: () => () => {} };
  }

  return context;
};
