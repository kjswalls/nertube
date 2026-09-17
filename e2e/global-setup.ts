import { API_KEY_EXP, API_KEY_IAT, GATEWAY_URL } from '../scripts/dev-stack/shared';
import { apiKey } from '../scripts/dev-stack/jwt';

/**
 * One check, before any test runs: the origin the app under test has been
 * pointed at is this harness, and it is ready.
 *
 * Playwright's `webServer` entries wait for `${GATEWAY_URL}/health` to answer
 * 2xx, and *anything* listening on that port can do that. `/health` names
 * itself, so this asserts the name rather than the status code. It is the
 * companion to `reuseExistingServer: false` on the app server: that stops a
 * foreign app being tested, this stops a foreign backend being tested.
 */
export default async function globalSetup(): Promise<void> {
  let body: unknown;
  try {
    const response = await fetch(`${GATEWAY_URL}/health`, {
      headers: { apikey: apiKey('anon', API_KEY_IAT, API_KEY_EXP) },
    });
    body = await response.json();
  } catch (error) {
    throw new Error(
      `nothing usable answered ${GATEWAY_URL}/health: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const health = body as { service?: string; status?: string };
  if (health.service !== 'nertube-dev-stack') {
    throw new Error(
      `${GATEWAY_URL} is answering, but it is not the dev stack: /health reported ` +
        `service=${JSON.stringify(health.service)}. Something else owns that port; ` +
        'the suite will not run against it.',
    );
  }
  if (health.status !== 'ok') {
    throw new Error(
      `the dev stack on ${GATEWAY_URL} reports status=${JSON.stringify(health.status)}, not "ok".`,
    );
  }
}
