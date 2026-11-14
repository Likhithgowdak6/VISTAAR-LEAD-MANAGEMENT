# Continue with Google

Workspace addresses are no longer requested at signup or sign-in. Internal workspace identifiers
are generated automatically. Existing password accounts can still sign in using email and password.
Google users with multiple active workspaces choose a business after Google verifies their identity.

## Activate

1. In Google Cloud, configure an OAuth consent screen and create an OAuth client of type **Web application**.
2. Add your frontend origin to **Authorized JavaScript origins**, e.g. https://crm.example.com.
   For local development also add http://localhost:5173 (or the actual Vite origin).
3. Set GOOGLE_AUTH_CLIENT_ID in backend/.env to the Web client ID and restart crm-api.
   Compose passes it to the API. This Google Identity Services popup flow does not need a client
   secret or an authorized redirect URI. It is separate from the Calendar OAuth integration.
4. Open the login page and click Continue with Google. If the consent screen is in testing mode,
   add your pilot users as test users in Google Cloud.

Only a verified Google-issued Gmail/Google Workspace identity is accepted. The backend validates
RS256 signatures against Google's keys, audience, issuer, expiry, verified email and a browser-bound,
Redis-backed single-use nonce. No Google access or refresh token is stored. Existing Gmail accounts
can be matched to their verified address; mismatched Google subjects and disabled accounts are refused.
Unknown identities receive a free workspace only when signup is open and any invitation code is valid.

Google's official button is only shown when GOOGLE_AUTH_CLIENT_ID is configured. Do not put a client
secret in VITE_ variables. HTTPS is required in production. This initial integration targets the web
login; native Capacitor Google sign-in needs its own supported native auth flow before shipping an APK.

Live sign-in requires a real Google Cloud client ID and allowed origin; unit tests use signed test
JWTs and isolated HTTP/Redis/database doubles.

Reference: https://developers.google.com/identity/gsi/web/guides/verify-google-id-token

Local configuration now reuses the existing Google OAuth client ID from the Calendar setup.
No Calendar client secret was changed. Confirm that this client has the frontend origin authorized,
then restart crm-api (or recreate its Compose container) to load GOOGLE_AUTH_CLIENT_ID.
