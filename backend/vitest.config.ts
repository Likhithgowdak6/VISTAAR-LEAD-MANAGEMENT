import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./tests/setup.ts'],
    // bcrypt cost 12 + multi-login flows can exceed the default 5s under suite load
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
