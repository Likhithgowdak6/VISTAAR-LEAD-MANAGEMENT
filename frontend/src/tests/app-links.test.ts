/**
 * The three files that have to agree for a WhatsApp link to open the app instead of a browser.
 *
 * WHY A TEST AND NOT A COMMENT. App Link verification fails SILENTLY: if the package name in
 * assetlinks.json drifts from the one Gradle actually builds, or a fingerprint is pasted with a
 * character missing, Android does not crash, warn, or log anywhere anybody looks - it quietly
 * falls back to opening the browser, which is the exact bug this feature exists to fix and is
 * indistinguishable from it having never been implemented. Nothing else in this repo reads
 * these three files together.
 *
 * THESE DO NOT PROVE VERIFICATION SUCCEEDS. That needs the file served over real HTTPS with no
 * redirect, and a handset to install on - `adb shell pm get-app-links` is the only thing that
 * reports it. See android/APP-LINKS.md.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

// `process.cwd()` is the frontend package root under Vitest - the same anchor
// templates-nav-removed.test.ts uses to read source files.
const read = (relative: string) => readFileSync(join(process.cwd(), relative), 'utf8');

const manifest = read(join('android', 'app', 'src', 'main', 'AndroidManifest.xml'));
const buildGradle = read(join('android', 'app', 'build.gradle'));
const assetLinks = read(join('public', '.well-known', 'assetlinks.json'));

/** `applicationId "com.example"` -> `com.example`. The only id Android actually installs under. */
const applicationId = /applicationId\s+"([^"]+)"/.exec(buildGradle)?.[1];

describe('the intent filter', () => {
  it('claims the host the backend puts in notification links', () => {
    // buildConversationDeepLink resolves this origin from FRONTEND_ORIGIN - see
    // backend/src/utils/deep-link.ts. A filter for any other host routes nothing.
    expect(manifest).toContain('android:scheme="https"');
    expect(manifest).toContain('android:host="vistaarcrm.duckdns.org"');
  });

  it('IS MARKED autoVerify, which is what removes the chooser', () => {
    // Without it Android treats these as ordinary web intents: the first tap raises an
    // "open with" sheet, and picking Chrome once makes the browser the permanent default.
    expect(manifest).toContain('<intent-filter android:autoVerify="true">');
  });

  it('carries the three things a web intent needs to resolve', () => {
    expect(manifest).toContain('android.intent.action.VIEW');
    expect(manifest).toContain('android.intent.category.DEFAULT');
    expect(manifest).toContain('android.intent.category.BROWSABLE');
  });

  it('leaves the launcher filter alone', () => {
    // The app still has to be openable from its icon. A second filter must be additive.
    expect(manifest).toContain('android.intent.action.MAIN');
    expect(manifest).toContain('android.intent.category.LAUNCHER');
  });
});

describe('assetlinks.json', () => {
  const parsed = JSON.parse(assetLinks) as Array<{
    relation: string[];
    target: { namespace: string; package_name: string; sha256_cert_fingerprints: string[] };
  }>;

  it('is a statement list Android will accept', () => {
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0]?.relation).toContain('delegate_permission/common.handle_all_urls');
    expect(parsed[0]?.target.namespace).toBe('android_app');
  });

  it('NAMES THE PACKAGE GRADLE ACTUALLY BUILDS', () => {
    // The drift this file is most likely to suffer, and the one with no symptom other than
    // links opening the browser again.
    expect(applicationId).toBeTruthy();
    expect(parsed[0]?.target.package_name).toBe(applicationId);
  });

  it('lists at least one well-formed SHA-256 fingerprint', () => {
    // 32 bytes, colon-separated, uppercase hex. A truncated or lowercase paste is accepted by
    // JSON and rejected by Android.
    const fingerprints = parsed[0]?.target.sha256_cert_fingerprints ?? [];

    expect(fingerprints.length).toBeGreaterThan(0);
    fingerprints.forEach((fingerprint) => {
      expect(fingerprint).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    });
  });
});
