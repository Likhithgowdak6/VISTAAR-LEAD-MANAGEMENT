import { defineConfig } from 'vitest/config';

/**
 * The staged MongoDB integration suite. Run by `npm run test:integration`, NEVER by `npm test`.
 *
 * SEPARATE ON PURPOSE, TWICE OVER. The default config has no `include`, so it picks up
 * `**\/*.test.ts` - and every file here is named `*.integration.ts`, which that glob does not
 * match. This config does the reverse. So the two suites cannot run each other by accident, and
 * `npm test` stays green on a machine with no database, which is what makes it usable in CI and
 * on a laptop.
 *
 * `tests/integration/db.guard.test.ts` is the deliberate exception: it is a `.test.ts`, runs in
 * the DEFAULT suite, and proves the connection guard without needing a server. The guard is the
 * one thing that must be known-good before any of this connects to anything.
 *
 * NO SETUP FILE. The default config loads `tests/setup.ts`, which documents that everything is
 * mocked; loading it here would be misleading, and these tests mock nothing but the AI client.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/integration/**/*.integration.ts'],
    // Sequential. The suites share one database and one set of indexes, and two files seeding
    // conversations at once would make "the sweep found exactly one" depend on timing.
    fileParallelism: false,
    // Real network round-trips to a container, plus index builds on first run.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
