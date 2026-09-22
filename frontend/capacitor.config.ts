import type { CapacitorConfig } from '@capacitor/cli';

/**
 * The Android wrapper around the existing React dashboard.
 *
 * This ships the built SPA inside the app and points it at a hosted API — it does NOT bundle the
 * backend. The backend has to run somewhere permanent: it holds the WhatsApp socket open, polls
 * Meta, and runs the morning jobs. None of that can live on a handset that sleeps.
 *
 * `androidScheme: 'https'` is the important line. It makes the WebView's origin `https://localhost`
 * rather than `http://`, which means the browser treats it as a secure context — required for the
 * `SameSite=None; Secure` refresh cookie to be stored at all. Two consequences for the server:
 *
 *   1. `https://localhost` must be in the backend's FRONTEND_ORIGIN allowlist.
 *   2. AUTH_COOKIE_CROSS_SITE=true, and the API must be served over real HTTPS.
 *
 * Get either wrong and the symptom is identical and misleading: signing in succeeds, then the
 * first refresh throws the user straight back out.
 */
const config: CapacitorConfig = {
  appId: 'com.vistaarverse.leadmanagement',
  appName: 'Vistaar Leads',
  webDir: 'dist',
  android: {
    // The app talks to one hosted API over TLS, so cleartext stays off. Leaving it on is how a
    // staging http:// URL quietly ships to production.
    allowMixedContent: false,
  },
  server: {
    androidScheme: 'https',
  },
};

export default config;
