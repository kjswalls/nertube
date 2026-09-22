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
   *
   * `server-only` is the M8 addition. `lib/assist/anthropic.ts` and
   * `lib/assist/provider.ts` import it as a build-time tripwire: a client
   * component that reaches the module holding the API key fails the build
   * instead of shipping the key to a browser. It is not a dependency — Next
   * aliases the bare specifier to its own bundled copy and declares the module
   * in `next/types/global.d.ts` — so Node, and therefore Vitest, cannot
   * resolve it on its own and the unit tests would fail on the import alone.
   * This points it at the empty stub Next itself serves under the
   * `react-server` condition, which is exactly what those modules see in the
   * app.
   */
  resolve: {
    alias: {
      '@': new URL('.', import.meta.url).pathname.replace(/\/$/, ''),
      'server-only': new URL(
        './node_modules/next/dist/compiled/server-only/empty.js',
        import.meta.url,
      ).pathname,
    },
  },
});
