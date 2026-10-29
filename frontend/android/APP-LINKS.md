# Android App Links

Why this file exists: `public/.well-known/assetlinks.json` is strict JSON and cannot carry a
comment, but the one value in it — a signing-certificate fingerprint — is both opaque and
machine-specific. This is where that value comes from and how to check it is right.

## What it does

The backend puts `https://vistaarcrm.duckdns.org/?conversation=<id>` (and `&reminder=<id>`) into
WhatsApp notifications — see `backend/src/utils/deep-link.ts`. The intent filter in
`app/src/main/AndroidManifest.xml` claims that host, and `assetlinks.json` is Android's proof
that the claim is legitimate: at install time Android fetches

    https://vistaarcrm.duckdns.org/.well-known/assetlinks.json

and hands the link to this app with no prompt only if the package name and the installed build's
signing certificate are both listed there.

## The fingerprint currently listed

`09:2A:64:...:79:EB` is the **debug** signing certificate from this workstation's
`~/.android/debug.keystore`. That is the certificate the installed app actually carries today:
`app/build.gradle` has no `signingConfig` on the `release` build type, so there is no release
keystore in this project and every APK installed so far has been debug-signed.

Read it back with:

```bash
keytool -list -v -keystore ~/.android/debug.keystore -alias androiddebugkey -storepass android
```

## When this has to change

Add a second entry to `sha256_cert_fingerprints` (do not replace the first unless debug builds
are no longer installed) whenever any of these becomes true:

- A **release keystore** is created and wired into `app/build.gradle`. Use that keystore's
  SHA-256.
- The app is published through **Google Play App Signing**. Play re-signs the upload, so the
  fingerprint that matters is the one under *Play Console → Release → Setup → App signing →
  App signing key certificate*, not the upload key's.
- Someone builds a debug APK on a **different machine**. Each machine generates its own
  `debug.keystore`, so its fingerprint differs.

A mismatch fails **silently**: Android falls back to showing a browser/app chooser, or just opens
the browser.

## Verifying it actually worked

Served correctly (must be `200`, `content-type: application/json`, and **no redirect**):

```bash
curl -sI https://vistaarcrm.duckdns.org/.well-known/assetlinks.json
```

Android's own view, on a connected handset with the app installed:

```bash
adb shell pm get-app-links com.vistaarverse.leadmanagement
```

`verified` is the state to look for. `legacy_failure` or `1026` means the file was unreachable or
did not match. Android only re-verifies at install, so reinstall after fixing the file.

Force a re-check without reinstalling:

```bash
adb shell pm verify-app-links --re-verify com.vistaarverse.leadmanagement
```
