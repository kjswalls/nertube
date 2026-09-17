import { defineConfig } from 'vitest/config';

/**
 * `npm test` is the unit suite (`lib/*.test.ts`). It must not try to run the
 * Playwright specs: both frameworks export a `test()`, both match
 * `**\/*.spec.ts` by default, and Vitest importing `@playwright/test` fails with
 * "Playwright Test did not expect test() to be called here".
 *
 * The end-to-end suite has its own runner and its own command —
 * `playwright.config.ts` and `npm run e2e`.
 */
export default defineConfig({
  test: {
    exclude: ['**/node_modules/**', '**/dist/**', '**/.next/**', 'e2e/**'],
  },
});
