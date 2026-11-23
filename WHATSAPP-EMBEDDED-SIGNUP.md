# Connect with Meta — WhatsApp SaaS onboarding

Customers can open **Team & Accounts → WhatsApp Numbers**, create an **Official WhatsApp API**
account, then choose **Connect → Connect with Meta**. They authorize their own WhatsApp assets in
Meta's popup instead of copying tokens and IDs. They choose a six-digit WhatsApp two-step verification
PIN before opening Meta (or supply the existing PIN). This is not the SMS verification code.

## Platform setup (once per SaaS installation)

This integration uses Embedded Signup **v4**, the current Meta implementation. It is intended for
Tech Providers, with customers paying Meta directly. It does not implement a Solution Partner credit
line, WABA-only onboarding, multi-WABA onboarding, or WhatsApp Business App coexistence/history sync.
Unsupported completion types fail with an explanation rather than marking a number connected.

1. Complete Meta's Tech Provider onboarding, business verification, and required App Review / Advanced
   Access for the WhatsApp permissions used by the app. Development mode is for app-role testing;
   building this button does not grant access to arbitrary customer assets.
2. Under **Facebook Login for Business → Settings**, enable the OAuth / JavaScript SDK settings in
   Meta's implementation guide. Add the actual HTTPS workspace domain and exact allowed redirect URI.
3. Create a **WhatsApp Embedded Signup** configuration for Cloud API phone-number onboarding. Select
   only required products/assets/permissions. Save the Configuration ID.
4. Configure the platform variables in `backend/.env` (never in Vite variables):

   ```dotenv
   WHATSAPP_CLOUD_ENABLED=true
   WHATSAPP_EMBEDDED_SIGNUP_APP_ID=<platform-meta-app-id>
   WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID=<facebook-login-for-business-configuration-id>
   WHATSAPP_CLOUD_APP_SECRET=<platform-meta-app-secret>
   WHATSAPP_CLOUD_WEBHOOK_VERIFY_TOKEN=<platform-generated-verification-token>
   ```

   App ID falls back to `META_APP_ID`; app secret falls back to `META_APP_SECRET`. If a separate
   WhatsApp app is used, set both WhatsApp-specific values consistently. These are **platform**
   settings; customers never enter the platform app secret. Existing encryption key settings are
   required for both temporary and permanent business-token storage.
5. In the WhatsApp product, verify the existing HTTPS webhook callback
   `/api/v1/whatsapp/cloud/webhook` using the platform verify token. Subscribe to `messages` and
   `account_update` as required by Meta. Keep signature verification enabled.
6. Deploy the Node backend and rebuilt frontend, restart `vistaar`. The new routes are under
   `/api/v1/whatsapp-accounts/:accountId/cloud/signup/*`, already routed to Node by `deploy/Caddyfile`.
   Python images and existing QR connections require no changes for this feature.
7. Use the HTTPS website in a browser for onboarding, with Meta popups allowed. Embedded webviews
   and the Android app are not an independently verified Embedded Signup entry point.

If setup is incomplete, the connection modal explains that platform setup is pending. Manual
credential connection remains available as an alternative. Cloud choices are still hidden when
`WHATSAPP_CLOUD_ENABLED` is false, preserving existing installations.

## What happens on connection

- Only an authenticated account manager with a changed password may use the four signup endpoints.
- The configuration response contains public App/Configuration IDs only, never the app secret.
- A random ten-minute attempt is bound to organization, admin user, and existing Cloud account.
- The Facebook JS SDK opens directly from the user's click. Only exact approved Facebook origins
  are accepted for session events; the server independently checks phone-to-WABA membership.
- The short-lived code is exchanged immediately on the server, independently of session-event
  arrival order. The business token is encrypted using the existing Cloud token encryption before
  it is temporarily stored in Redis, with a ten-minute expiry. No tokens/codes/PINs are written
  to browser storage or emitted to the console.
- Redis atomic GETDEL makes each code exchange and completion single-use across Node instances.
  Redis is required; failures do not fall back to memory. Failed/expired attempts require starting
  again; a consumed code is never retried automatically.
- The existing account service verifies the number with Meta, verifies WABA membership and
  subscribes the app to the WABA, then registers the phone with the supplied PIN. Only after success
  does it save the encrypted token and mark the account active. Existing active-account credentials
  remain unchanged if validation/subscription/registration fails.
- A preflight collision check rejects a phone already connected elsewhere; the existing global
  unique phone-number index remains the final guarantee against ambiguous inbound tenant routing.
- The customer sees the verified name and number. Meta may also require them to add their own
  payment method in WhatsApp Manager. The popup finishing alone does not prove real message delivery.

Cancellation, SDK load errors, denied login, unsupported flows, timeouts, and server errors display
actionable feedback. Listeners are removed when the modal closes, and late callbacks are ignored.

## Release acceptance

Use a role-enabled Meta test customer first, then a separate customer business after app approval.
Confirm actual number ownership, subscription, registration, encrypted storage, inbound messages,
delivery receipts, sending within the service window, and approved-template sending outside it.
Verify cancellation, denied access, cross-tenant/account attempts, expired/replayed attempts, and
popup blockers. No automated local test contacts Meta, sends a message, or onboards a real number.

Token expiration or revocation still requires reconnecting; automated business-token renewal and
account-update lifecycle processing are not introduced by this change. Existing outbound provider
error handling reports invalid tokens. Do not promise permanent authorization.

## Primary references

- [Meta Embedded Signup implementation (v4)](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/implementation)
- [Onboarding customers as a Tech Provider](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-customers-as-a-tech-provider)

Implementation reviewed against these references on 2026-11-23. No historical billing data is
imported, and no existing QR accounts are converted or replaced.
