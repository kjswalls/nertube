import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Playwright's output. Traces, screenshots and the temporary JavaScript it
    // drops into `.playwright-artifacts-*` while a suite runs are build output,
    // never source — and linting them turns `npm run lint`, one of this
    // project's six gates, into a command whose answer depends on whether a
    // browser happens to be open. The glob matches the per-suite directories
    // the e2e scripts pass with `--output` as well as the default one, the same
    // way `.gitignore`'s `/test-results*/` does.
    "test-results*/**",
    "playwright-report/**",
    "blob-report/**",
  ]),
]);

export default eslintConfig;
