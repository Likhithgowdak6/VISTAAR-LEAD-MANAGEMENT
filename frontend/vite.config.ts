import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * The API is proxied rather than called cross-origin, so the browser only ever talks to one
 * host. That keeps a public tunnel (ngrok) to a single endpoint: no second tunnel for the API,
 * no CORS allowlist to keep in step with a URL that changes, and the auth cookies stay
 * same-site. Set VITE_API_BASE_URL=/api/v1 (the default in .env) for this to be used.
 */
const API_TARGET = process.env.VITE_API_PROXY_TARGET ?? 'http://localhost:5001';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // Vite refuses requests whose Host header it does not recognise, which blocks a tunnelled
    // domain outright. A leading dot allows any subdomain, so a rotating ngrok URL keeps
    // working without editing this file. Scoped to tunnel providers rather than opened to
    // everything, so an arbitrary hostname pointed at this machine is still refused.
    allowedHosts: [
      'localhost',
      '.ngrok-free.dev',
      '.ngrok-free.app',
      '.ngrok.dev',
      '.ngrok.app',
      '.ngrok.io',
    ],
    proxy: {
      '/api': {
        target: API_TARGET,
        changeOrigin: true,
        // The realtime feed is a long-lived SSE stream; it must not be buffered or timed out.
        timeout: 0,
        proxyTimeout: 0,
      },
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: './src/tests/setup.ts',
  },
});
