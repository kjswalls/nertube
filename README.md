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
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | `vitest run` |
| `npm run db:verify` | Rebuild a local database and run the SQL tests |
| `npm run db:types` | Regenerate `lib/database.types.ts` from the local database (needs Docker) |
| `npm run seed:demo` | Dev-only: create the user, two seeded channels and the 8-video week fixture |

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
`postgres`).

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
