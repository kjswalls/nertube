# NerTube

A personal YouTube production pipeline tool. Where other tools chase AI ideation,
NerTube owns the production middle: moving a video from a captured idea to a
published URL. It keeps several videos alive at once across per-channel stages
(Idea → Packaging (TTH) → Scripting → Filming → Editing → Publish Prep →
Scheduled → Published → Repurposed), makes it structurally awkward to skip the
packaging gate (title + thumbnail concept + hook before a word is scripted), and
answers the question that actually matters in a spare ten minutes: *what can I
move right now?* Multi-channel, keyboard-driven, with an idea bank, content
buckets, per-stage checklists, three-thumbnail launches with a swap log, and a
Claude-backed brainstorm for titles and hooks.

See `docs/BRIEF.md` for the requirements and `docs/PLAN.md` for the plan this
build follows.

## Stack

Next.js 16 (App Router) + TypeScript, Tailwind CSS v4, Supabase (Postgres, auth,
storage), Anthropic API server-side only, deployed on Vercel.

## Running the app

```bash
npm install
cp .env.example .env.local   # then fill in real values
npm run dev                  # http://localhost:3000
```

`.env.local` is gitignored and is the only place real keys belong.
`.env.example` lists the variable names with empty placeholders.

Other scripts:

| Script | What it does |
|---|---|
| `npm run dev` | Next dev server |
| `npm run build` | Production build |
| `npm run start` | Serve the production build |
| `npm run lint` | ESLint |
| `npm run typecheck` | `tsc --noEmit` over both programs: the app, and `tsconfig.harness.json` (the dev stack, the Playwright specs, the unit tests) |
| `npm test` | `vitest run` |
| `npm run db:verify` | Rebuild a local database and run the SQL tests |
| `npm run db:types` | Regenerate `lib/database.types.ts` from the local database (needs Docker) |
| `npm run seed:demo` | Dev-only: create the user, two seeded channels and the 8-video week fixture |
| `npm run dev:stack` | Dev-only TEST harness: local Supabase stand-in (see below) |
| `npm run dev:stack:smoke` | Drive a running dev stack with supabase-js and report what works |
| `npm run dev:stack:stop` | Stop a dev stack that was killed without being able to clean up |
| `npm run e2e` | Playwright end-to-end against the real app and the dev stack |
| `npm run e2e:refresh` | The session-refresh spec on its own stack, ports and database, with a 5-second access token, to exercise `proxy.ts`'s session refresh |

## The local dev stack (a TEST harness)

`npm run dev:stack` starts a local, Docker-free stand-in for Supabase so the
real app can be driven in a real browser against real Postgres with real
row-level security. It lives in `scripts/dev-stack/` and has its own
[README](scripts/dev-stack/README.md).

```bash
npm run dev:stack   # resets nertube_dev, seeds it, serves http://127.0.0.1:54321
npm run dev         # the app, pointed at that origin
npm run e2e         # Playwright end-to-end; starts both of the above itself
```

It runs the SQL test suite against a throwaway `nertube_test` (so the tests have
to pass before it will serve anything), builds the database it actually serves
from the shim and the migrations alone, seeds one user and two channels through
the real `create_channel` / `capture_video` functions as the `authenticated`
role, runs the real **PostgREST** binary in front of the database (as
`authenticator`, not as a superuser), and serves one origin carrying
`/rest/v1`, `/auth/v1` and `/storage/v1` behind a Kong-style api-key check. It
prints the URL and the anon key to paste into `.env.local`, and takes PostgREST
down with it on Ctrl-C — or on a plain `kill`, which npm does not forward and
which the stack therefore watches for itself. `npm run dev:stack:stop` clears up
after a `kill -9`, the one case nothing can catch.

**It is a test harness that approximates Supabase. It is never used in
production, it is never deployed, and the application does not import a line of
it. It exists only because Docker is unavailable in this environment**, so
`supabase start` cannot run and no page that needs data could otherwise be
opened at all. Where Docker is available, `supabase start` is the authority.

The database and PostgREST in it are real; GoTrue and Storage are
re-implemented to the shape `@supabase/supabase-js` parses. What that costs is
listed in full under
["What this harness does not reproduce"](scripts/dev-stack/README.md#what-this-harness-does-not-reproduce)
— roughly: no email, magic links, OTP, OAuth, SSO, MFA or `auth.admin.*`; no
rate limiting or lockout; no JWKS or asymmetric signing keys; no refresh-token
reuse detection; none of Kong beyond the api-key check; only the `public` schema
over REST; no Realtime, Edge Functions, Supavisor, `pg_cron`/`pg_net`/
`pg_graphql` or Studio; and in Storage no image transforms, resumable uploads,
`move`/`copy`, public buckets, CDN or Range requests, with a simplified `list()`.
**A passing local run is not a passing hosted run.** If a behaviour on that list
matters, check it against a real project.

`npm run e2e` is the acceptance test for all of the above: it signs in through
the real login form with the seeded credentials, lands on a board, asserts the
nine seeded stage columns, asserts a wrong password shows an error without
signing in, and asserts a signed-out browser is bounced from the board to
`/login`. It writes a screenshot into the gitignored `e2e/screenshots/`.
It also asserts the browser's session cookie names this origin, so the suite
cannot silently be driving an app pointed somewhere else; Playwright starts the
application server itself for the same reason. `npm run e2e:refresh` drives the
session-refresh path by starting its own stack — own ports, own database — with
a five-second access token, the only way to watch `proxy.ts` rotate a token, and
the check that found the harness's one real fidelity bug (rotating refresh
tokens with no reuse interval, which signed the user out mid-render). It fails
rather than skips if it ever finds itself talking to a stack that mints
hour-long tokens.
Playwright uses the Chromium already installed at `/opt/pw-browsers` via
`executablePath`; `playwright install` must never run here.

## Database

The normal local workflow is the Supabase CLI Docker stack:

```bash
npx supabase start
npx supabase db reset
```

Where Docker is not available, `npm run db:verify` is the stand-in. It drops and
recreates a throwaway database on a plain PostgreSQL server, applies
`supabase/tests/shim.sql` (which recreates the Supabase-specific pieces: the
`auth` and `storage` schemas, `auth.uid()`, `storage.foldername()`, the
`anon`/`authenticated`/`service_role` roles and Supabase's default grants), then
applies every `supabase/migrations/*.sql` in order and runs every
`supabase/tests/*.test.sql`. It exits non-zero on the first error.

```bash
npm run db:verify              # uses the default database name
npm run db:verify -- mydbname  # or name your own
```

It reads `PGHOST`, `PGPORT` and `PGUSER` (defaults `127.0.0.1`, `5432`,
`postgres`), and refuses to run at all unless `PGHOST` is loopback — its first
statement is `drop database ... with (force)`, and `PGHOST`/`PGPASSWORD` are
exactly what you would export to reach a hosted database.
`scripts/verify-db.sh --no-tests` stops after the migrations; that is how
`npm run dev:stack` builds a serving database without the test fixtures.

`npm run db:types` regenerates `lib/database.types.ts` with the Supabase CLI.
The CLI is an npm dev dependency used for that one job. Note that
`gen types --db-url` still shells out to Docker to run postgres-meta, so it
needs a Docker daemon even though it is pointed at a plain database URL; without
one it fails with `LegacyDockerRunError`. `NERTUBE_DB_URL` overrides the
database it reads (the default is `nertube_dev` on localhost).

The committed `lib/database.types.ts` was written by hand from
`supabase/migrations/0001_init.sql` for exactly that reason, and checked column
by column against the catalogue of a database built by `npm run db:verify`. Once
Docker is available, `npm run db:types` should overwrite it wholesale. The script
writes to a temporary file and only moves it into place on success, so running it
without Docker leaves the committed file alone instead of replacing it with the
CLI's error blob.

## Where writes happen

**The browser Supabase client is used only for Storage uploads and reads.**
Thumbnail images and concept sketches go straight from the browser to Supabase
Storage — that keeps them clear of Vercel's 4.5 MB request body limit — and
signed URLs are read back for display.

**Every database write goes through a server action.** No component writes to a
table with the browser client. Server actions are the single write path, which
is what makes the invariants enforceable: the stage move and thumbnail swap are
plpgsql functions called over `rpc()`, and `videos.stage_id`,
`stage_entered_at`, `published_at` and `shipped_role` have their `UPDATE`
privilege revoked from the `authenticated` role, so those functions are the only
way to change them. `INSERT` on `videos` is revoked outright for the same reason
— a plain insert would otherwise create a video on the far side of the gate — so
`capture_video()` is the only way a video comes into existence, and it always
lands in the Idea stage. `stages.kind` is likewise not client-writable, which is
what makes the "core stages cannot be deleted" delete policy hold: the policy
keys on `kind`, so a writable `kind` would let a client launder a core stage into
an inert one and then delete it. `thumbnail_swaps` has no client `UPDATE` or
`DELETE` at all (it is an append-only log), and `TRUNCATE` — which RLS does not
apply to — is revoked from `anon` and `authenticated` on every table. RLS is on
for every table; the browser's anon key can read and write nothing that does not
belong to the signed-in user.

## The brainstorm, and what to set in Vercel

The title / hook / concept suggestions and the thumbnail critique are one
feature behind one interface — `AssistProvider` in `lib/assist/types.ts`. Two
implementations ship: `lib/assist/anthropic.ts`, which calls Claude, and
`lib/assist/fake.ts`, which returns deterministic fixtures with no network at
all. The app depends only on the interface; `app/actions/assist.ts` picks an
implementation from the environment and imports it lazily, so a process running
the fixtures never even loads the vendor SDK.

**The key is server-side only and must stay that way.** `lib/assist/anthropic.ts`
is the one file that reads `ANTHROPIC_API_KEY`, and its first line is
`import "server-only"` — a client component that reached it would fail the build
rather than ship a key to a browser. The client sends a video id and a kind and
nothing else; the prompt, the voice guide and the past titles are all assembled
on the server, so a browser can never spend the key on something of its own.
`npm run build` followed by a grep of `.next/static` for `ANTHROPIC_API_KEY`,
`api.anthropic.com` and `x-api-key` is the check, and it finds nothing.

### Variables

Set these in Vercel under **Project → Settings → Environment Variables**, as
server-side variables (no `NEXT_PUBLIC_` prefix — that prefix is what inlines a
value into the browser bundle):

| Variable | Required | What it does |
|---|---|---|
| `ANTHROPIC_API_KEY` | **Yes**, for the real provider | Your Anthropic API key. Server-side only. Nothing else in this repository reads it, and no value for it is written down anywhere here. |
| `ANTHROPIC_MODEL` | No | Overrides the model id. Defaults to the one `lib/assist/anthropic.ts` pins. Set it to migrate models without a deploy of new code. |
| `ASSIST_PROVIDER` | No | `fake` forces the fixtures. Leave it **unset in production.** Anything else, including unset, means Claude. |
| `ASSIST_FAKE_SCENARIO` | No | Only read by the fixtures: makes them answer with a named failure, for driving the error paths. Never set it in production. |

Everything else the app needs (`NEXT_PUBLIC_SUPABASE_URL`,
`NEXT_PUBLIC_SUPABASE_ANON_KEY`) is listed in `.env.example`;
`SUPABASE_SERVICE_ROLE_KEY`, `SEED_EMAIL` and `SEED_PASSWORD` are read by
`scripts/`, never by the app, and do not belong in a Vercel deployment.

### Which implementation answers

The rule is one pure function, `selectAssistProvider` in `lib/assist/select.ts`,
with a unit test per case:

| `ASSIST_PROVIDER` | key present | `NODE_ENV` | answers |
|---|---|---|---|
| `fake` | either | any | the fixtures |
| anything else non-empty | either | any | Claude |
| unset | yes | any | Claude |
| unset | no | `production` | Claude — and the panel says "no API key configured" |
| unset | no | anything else | the fixtures |

A **production** deployment with no key deliberately does *not* fall back. The
fixtures return plausible titles with plausible reasons; a deployment where the
key was never pasted would, if it fell back, hand you invented titles and let
you believe a model wrote them — the one failure in this feature nobody can
notice from outside. So it fails with a sentence naming the variable instead.

A **development** checkout with no key does fall back, so a fresh clone is
reviewable without a paid account — and wherever the fixtures answer, every
panel says so, on every answer, in the attention colour: *these came from this
app's built-in fixtures, not from Claude.* Which implementation answered is
stored with the result in `videos.brainstorm_last`, so a panel reopened tomorrow
makes the same admission. The fixtures are never silent about being fixtures.

(That sentence points here rather than naming `ANTHROPIC_API_KEY`, on purpose:
the panels are client components, so a variable spelled in one of them would
appear in `.next/static` and cost the grep above its only useful answer, which
is *nothing*.)

`npm run e2e` sets `ASSIST_PROVIDER=fake` explicitly in `playwright.config.ts`,
so the suite can never spend money or depend on a third party being up.

## Channels

`createChannel` (`app/actions/channels.ts`) is the only way a channel comes into
existence. It slugifies the name and calls `create_channel()`, which writes the
channel, its nine stages, a checklist template per stage and the format buckets
in one transaction. The content is still read from `lib/defaults.ts` — the single
copy — and handed to the function as jsonb; `scripts/seed-demo.ts` writes the
same rows from the same file.

Seeding is all-or-nothing, and literally so. supabase-js has no transactions, so
doing this as four round trips meant a failure part way through committed a
channel with no columns — and PLAN.md deliberately gives `channels` no delete
policy, so nothing could remove it. Rather than add a delete path (an earlier
`discard_empty_channel()` RPC turned out to be a channel-delete button for any
video-less channel, configuration and all), the write moved into the database.
`INSERT` on `channels` is revoked from clients, so an unseeded channel cannot be
created at all. `supabase/tests/95_create_channel.test.sql` covers the happy
path, the failed seed leaving nothing behind, and both closed doors.

## Authentication

Email + password, one user. There is deliberately no sign-up screen: the single
account is created once, out of band, and signups are then turned off.

Create the user either way:

- **Supabase dashboard** — Authentication → Users → *Add user*, with
  *Auto Confirm User* checked; or
- **locally** — `npx supabase start`, then Authentication → Users in Studio at
  http://127.0.0.1:54323, or `scripts/seed-demo.ts`, which calls
  `auth.admin.createUser` with the service-role key.

Then disable further signups: `[auth] enable_signup = false` in
`supabase/config.toml` for local dev, and Authentication → Sign In / Providers →
*Allow new users to sign up* off in the hosted project.

How it hangs together:

- `proxy.ts` (root) runs before every request except `_next/static`,
  `_next/image` and `favicon.ico`. It refreshes the session and redirects anyone
  signed out to `/login?next=<path>`. `/login` is matched too and only skips the
  redirect: it is the one place that can write refreshed auth cookies onto a
  response, and the login page calls `getUser()` like everything else, so leaving
  it out meant an expired token was rotated at Supabase with nowhere to put the
  result — signing the user out on the page they came to sign in on.
- `?next=` is reduced to a path on this site by `lib/safe-path.ts`, which parses
  the value rather than checking its first two characters (the URL parser strips
  tab/CR/LF, so `/<tab>/evil.com` is `//evil.com` by the time a browser reads the
  `Location` header). Both the page and the `signIn` action use that one copy.
- `app/login` posts to the `signIn` server action in `app/actions/auth.ts`, which
  passes auth-server messages through and replaces transport failures (Node's
  bare "fetch failed") with one that names the likely cause. `signOut` is in the
  same file.
- `lib/supabase/require-user.ts` is the guard every server component and server
  action starts with; it returns the request's client together with the user.
- Every authorization check uses `supabase.auth.getUser()`, never
  `getSession()` — only `getUser()` verifies the token with the auth server.
- The service-role key is never read by the app, only by `scripts/`.

## Conventions worth knowing

- With no `.env.local`, the proxy answers every page with a readable 503 setup
  page instead of an unexplained 500.
- Next 16 renamed the request middleware convention: session refresh lives in a
  root `proxy.ts` (typed with `NextProxy` / `ProxyConfig` from `next/server`).
  `middleware.ts` still works but is deprecated and warns at build time.
- `cookies()` from `next/headers` is async — always `await` it.
- Server-side auth guards use `supabase.auth.getUser()`, never `getSession()`.
