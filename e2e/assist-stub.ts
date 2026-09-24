import http from 'node:http';

/**
 * A local stand-in for the far end of `/v1/messages` (M11).
 *
 * `e2e/spend-cap.spec.ts` drives the **real** provider — `lib/assist/anthropic.ts`,
 * the installed SDK, the request it builds, the usage it reads back — with only
 * the socket's other end replaced by this. The app is pointed here by
 * `NERTUBE_TEST_ANTHROPIC_STUB` (set in `playwright.config.ts`) and only for a
 * request carrying the `nertube-test-assist=stub` cookie; see
 * `lib/assist/test-stub.ts`. Nothing in this repository reaches the real API.
 *
 * It answers every POST with one canned message whose `usage` is fixed, so the
 * cost of a call is known in advance, and it records every request it gets, so
 * a spec can prove that a refused call never left the server.
 */

/** `E2E_ASSIST_STUB_PORT` moves it, for a second suite running beside the first. */
export const ASSIST_STUB_PORT = Number(process.env.E2E_ASSIST_STUB_PORT ?? 54377);
export const ASSIST_STUB_ORIGIN = `http://127.0.0.1:${ASSIST_STUB_PORT}`;

/** What every stubbed call reports, and therefore costs. */
export const STUB_USAGE = { input_tokens: 2000, output_tokens: 3200 } as const;
/** claude-opus-5 at $5 / $25 per million: 2,000 × 5 + 3,200 × 25 = 90,000 µ$. */
export const STUB_COST_MICROS = 90_000;
export const STUB_MODEL = 'claude-opus-5';

export interface StubRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: Record<string, unknown>;
}

export interface AssistStub {
  readonly requests: StubRequest[];
  /** How long each answer waits before it is sent — for asks in flight together. */
  delayMs: number;
  /** When set, every request is answered with this error status and no usage. */
  errorStatus: number | null;
  close(): Promise<void>;
}

/** Twelve titles with reasons and a pick, in the shape `schema.ts` asks for. */
function answer(): string {
  return JSON.stringify({
    suggestions: Array.from({ length: 12 }, (_unused, index) => ({
      text: `Stubbed title number ${index + 1} about the spend cap`,
      rationale: `A reason for stubbed title ${index + 1}, long enough to read as one.`,
    })),
    recommended_index: 0,
    recommended_reason: 'The first stubbed title is the plainest of the twelve.',
  });
}

export async function startAssistStub(): Promise<AssistStub> {
  const requests: StubRequest[] = [];
  const control: { delayMs: number; errorStatus: number | null } = { delayMs: 0, errorStatus: null };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        body = {};
      }
      requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
      const send = () => {
        if (control.errorStatus !== null) {
          res.writeHead(control.errorStatus, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'stubbed failure' } }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id: `msg_stub_${requests.length}`,
            type: 'message',
            role: 'assistant',
            model: STUB_MODEL,
            content: [{ type: 'text', text: answer() }],
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: { ...STUB_USAGE, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          }),
        );
      };
      if (control.delayMs > 0) setTimeout(send, control.delayMs);
      else send();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(ASSIST_STUB_PORT, '127.0.0.1', () => resolve());
  });
  return {
    requests,
    get delayMs() {
      return control.delayMs;
    },
    set delayMs(value: number) {
      control.delayMs = value;
    },
    get errorStatus() {
      return control.errorStatus;
    },
    set errorStatus(value: number | null) {
      control.errorStatus = value;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
