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
  /**
   * The same `@/` that `tsconfig.json` gives the application and that every
   * component imports with. Without it a pure module under `components/` can be
   * typechecked but not unit-tested, which quietly pushes testable logic into
   * `lib/` for the resolver's sake rather than for a reason.
   */
  resolve: {
    alias: { '@': new URL('.', import.meta.url).pathname.replace(/\/$/, '') },
  },
});
