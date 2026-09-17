# Milestones

One section per milestone from `docs/PLAN.md`'s build order: what it delivers,
how to run it, and the log of its adversarial review.

## M0 — Scaffold, auth, RLS, full schema

### What M0 delivers

- **The app skeleton.** Next.js 16 (App Router, TypeScript, Tailwind v4), the
  root `proxy.ts` session refresh and route guard, `@supabase/ssr` clients for
  the server (`lib/supabase/server.ts`), the browser (`lib/supabase/client.ts`,
  storage only) and the proxy, and `lib/supabase/require-user.ts` as the one
  server-side guard.
- **Auth.** `/login` (email + password, no sign-up screen), the `signIn` /
  `signOut` server actions, and `?next=` sanitising shared by both
  (`lib/safe-path.ts`).
- **The whole schema**, `supabase/migrations/0001_init.sql`: eight tables with
  their CHECKs, the composite tenant FKs (`unique (id, user_id)` on every
  parent), RLS on every table, the column privileges that make the SQL functions
  the only write path, the private `thumbnails` bucket and its storage policy,
  and the plpgsql functions `move_video`, `swap_thumbnail` and `capture_video`.
  `supabase/migrations/0002_create_channel.sql` adds `create_channel`, which
  writes a channel and its entire seed in one transaction.
- **Channel creation.** `createChannel` (`app/actions/channels.ts`) over
  `create_channel`, seeded from `lib/defaults.ts` (nine stages, the seven
  checklist templates with `est_minutes`, the eight format buckets, the script
  template with its `{{hook}}` placeholder).
- **`/c/[slug]/board`** rendering the nine seeded columns, with the header
  channel switcher.
- **The fixtures and harnesses.** `scripts/seed-demo.ts` (the user, two
  channels, the 8-video week and the idea bank), twelve SQL test files under
  `supabase/tests/`, and `lib/defaults.test.ts` checking the seed content
  against `docs/BRIEF.md`.

### Running it locally

```bash
npm install
cp .env.example .env.local     # then fill in the two NEXT_PUBLIC_ values
npm run dev                    # http://localhost:3000
```

With no `.env.local` the app answers every page with a readable 503 "NerTube is
not configured" page rather than an unexplained 500.

The normal database workflow is the Supabase CLI stack (`supabase start`,
`supabase db reset`), then `npm run seed:demo` to create the demo user and the
fixture. `npm run db:types` regenerates `lib/database.types.ts`.

### The database harness, and its caveat

This repository is also checked in an environment with **no Docker daemon**, so
`supabase start` and `supabase db reset` cannot run. `./scripts/verify-db.sh
[dbname]` is the stand-in:

```bash
./scripts/verify-db.sh m0_final
```

It drops and recreates the named database on a plain PostgreSQL 16 server,
applies `supabase/tests/shim.sql`, applies every migration in order, then runs
every `supabase/tests/*.test.sql`, stopping at the first error.

**Caveat.** The shim is a re-creation of the Supabase-specific pieces the
migrations depend on — the `auth` schema and `auth.uid()`, the `storage` schema
with `storage.foldername()`, the `anon` / `authenticated` / `service_role` roles
and Supabase's default table grants. It is close, not identical: there is no
PostgREST, no GoTrue and no Storage API in front of it, so it exercises schema,
constraints, RLS policies, privileges and the SQL functions, and nothing above
them. `scripts/seed-demo.ts` in particular cannot run against it (it needs
GoTrue and PostgREST) and is only typechecked and linted here. Two review
findings were about the shim being *more permissive* than the real thing rather
than about the app; both are fixed, but the lesson stands — where Docker is
available, `supabase db reset` is the authority.

`lib/database.types.ts` is hand-written for the same reason: `supabase gen types
--db-url` still shells out to Docker.

**Since M0 closed**, `scripts/dev-stack/` puts the missing layers back: it runs
the real PostgREST binary in front of a database built by `verify-db.sh`, and
re-implements enough of GoTrue and Storage to serve one Supabase-shaped origin,
so the real app can be signed into and driven in a real browser (`npm run
dev:stack`, `npm run e2e`). It does not change the caveat above — it is still a
test harness, `scripts/seed-demo.ts` still needs `auth.admin.*` and still cannot
run, and `scripts/dev-stack/README.md` lists in full which Supabase behaviours
it does not reproduce.

### Deliberately not built yet

Everything M1 and later in `docs/PLAN.md`. Concretely, and to save anyone
looking: quick capture and the `c` modal, `/capture`, drag and drop, the cards
themselves, WIP and staleness badges (M1); `/videos/[id]`, the packaging block
and the skip UI (M2); checklist UI, `/now`, `lib/next-action.ts` and the weekly
strip (M3); thumbnails, the swap dialog and the post-publish block (M4); the
idea bank, buckets and the matrix (M5); `/calendar` and filming days (M6);
`/c/[slug]/settings` (M7); the brainstorm module and `@anthropic-ai/sdk` (M8);
the full shortcut set and the mobile pass (M9). The schema for all of it exists
and is tested; the UI does not.

`app/page.tsx` routes to `/c/new` or the first channel's board and nothing else
— `/now` does not exist yet, so it is not linked.

### Review log

Twenty findings from the adversarial review. All twenty reproduced; all twenty
are addressed, by eighteen fixes (two pairs of findings turned out to be the same
hole seen from two angles).

**Fixed**

- **F1 + F8** *(blocker, rls; major, schema-fidelity — one hole seen twice)* Core
  stages were deletable from any client: the delete policy keys on `kind`, but
  `kind` was client-writable, so `update stages set kind = null` followed by a
  delete removed eight of the nine core stages of a fresh channel. Confirmed.
  Fixed by revoking table-level `UPDATE` on `stages` and re-granting every
  column but `kind`, the same shape already used on `videos`.
  `20_column_privileges` and `30_stages` now do update-then-delete, not just
  delete.
- **F2** *(major, rls)* `anon` and `authenticated` held `TRUNCATE` on all eight tables,
  and RLS does not apply to `TRUNCATE`. Confirmed against the catalogue. Fixed
  by revoking `TRUNCATE`, `REFERENCES` and `TRIGGER` from both roles and from
  the schema's default privileges; asserted in `20_column_privileges`.
- **F3 + F11** *(major, rls; minor, schema-fidelity — one hole seen twice)* The
  "SQL functions are the only write path" guarantee covered `UPDATE` only; a
  plain `INSERT` created a video already in Published with `shipped_role` and
  `published_at` set. Confirmed. Fixed by revoking `INSERT` on `videos`
  outright and adding `capture_video(p_channel, p_title)`, which always lands
  the row in the channel's Idea stage — `stage_id` is `NOT NULL` with no
  default, so no column list would have left a usable client insert behind.
- **F4** *(minor, rls)* `thumbnail_swaps` is specified as an append-only log but
  clients could rewrite a reason, backdate `swapped_at` or delete the history.
  Confirmed. Fixed: select + insert policies only, `UPDATE`/`DELETE` revoked,
  and `swapped_at` left out of the insert grant so only the default can set it.
- **F5** *(minor, rls)* `checklist_items` had no channel binding, so within one tenant
  an item on a video in channel A could name a stage in channel B. Confirmed.
  Fixed by giving `checklist_items` a `channel_id` with composite FKs to both
  `videos (id, channel_id)` and `stages (id, channel_id)` (and the matching
  `unique (id, channel_id)` on `videos`) — the same pattern `videos` already
  uses for its stage. This is a deviation from PLAN.md's literal column list
  for that table; the reasoning is PLAN.md's own tenant-binding argument
  applied one level down.
- **F6** *(minor, rls)* The shim's `auth.uid()` cast before it nullif'd, so an empty
  `request.jwt.claims` — what PostgREST leaves for an unauthenticated request —
  raised instead of returning NULL, and the logged-out path could not be tested
  at all. Confirmed. Fixed to Supabase's actual shape (`auth.role()` and
  `auth.email()` too), and `supabase/tests/05_logged_out.test.sql` now asserts
  zero rows from every table and a clean `42501` from all four RPCs.
- **F7** *(minor, rls)* The shim granted clients `ALL` on `storage.buckets` without
  enabling RLS, so the harness was more permissive than real Supabase and would
  not have caught a missing bucket policy. Confirmed (an authenticated user
  could flip the private bucket to public). Fixed by enabling RLS on
  `storage.buckets` in the shim, with assertions in `80_storage`.
- **F9** *(major, schema-fidelity)* `discard_empty_channel` was a channel-delete RPC
  for any video-less channel — including a long-lived, hand-configured one —
  against PLAN.md's "no channel delete in v1". Confirmed. Rather than guard it,
  the underlying problem was fixed: channel creation is now a single
  transaction (`create_channel`), the RPC is gone, and `INSERT` on `channels`
  is revoked from clients so a half-seeded channel cannot exist to need
  cleaning up.
- **F10** *(major, schema-fidelity)* `scripts/seed-demo.ts` seeded no videos, so the
  8-video week PLAN.md makes every milestone's review start from did not exist.
  Confirmed. Fixed: the main channel gets the eight in-flight videos (including
  a Packaging video with everything filled, a Scheduled video for next Tuesday,
  and one published 25h ago with no metrics logged), both channels get an idea
  bank, and the stage checklists are snapshotted the way `move_video` would.
- **F12** *(minor, schema-fidelity)* Three Scripting checklist rows carried
  `est_minutes 5`, below the 10–15 band PLAN.md gives body items — and `/now`'s
  "≤ 10 min" filter reads that column. Confirmed. Raised to 10, and
  `lib/defaults.test.ts` now pins the bands instead of asserting `> 0`.
- **F13** *(minor, schema-fidelity)* Seeded horizontal bucket names were Title-Cased
  where BRIEF.md and PLAN.md give them lowercase. Confirmed. Lowercased, with
  the test updated.
- **F14** *(blocker, next-auth)* Open redirect: the `?next=` check looked at the first
  two characters only, and `next=/%09/evil.com` survived it — the URL parser
  strips tab/CR/LF, so the browser reads the emitted `Location` as
  `//evil.com`. Confirmed. Fixed by parsing the value against a fixed base and
  rejecting anything that lands on another origin, in one shared
  `lib/safe-path.ts` used by both the page and the action.
- **F15** *(major, next-auth)* `?next=/%0Aevil` crashed the route with an unhandled
  `ERR_INVALID_CHAR` 500. Confirmed. Same fix: the parser strips the control
  character, so `/evil` is what reaches the header. Re-probed: `/%09/evil.com`
  and `//evil.com` now render `next="/"`, `/%0Aevil` renders `next="/evil"`,
  and `/c/new` survives intact.
- **F16** *(major, next-auth)* `/login` was excluded from the proxy matcher, so the
  token refresh its own `getUser()` triggered was rotated at Supabase and
  thrown away — signing the user out on the login page. Fixed by matching
  `/login` and skipping only the redirect branch for it.
- **F17** *(minor, next-auth)* The matcher exempted every path ending in an image
  extension, anywhere in the tree, though `public/` does not exist. Confirmed.
  Dropped; `_next/static`, `_next/image` and `favicon.ico` still cover what the
  app actually serves.
- **F18** *(major, runtime)* `npm run db:types` truncated `lib/database.types.ts`
  before running, so a failed run (guaranteed without Docker) replaced the
  hand-written 527-line file with a JSON error blob and broke typecheck and
  build. Confirmed. Fixed by writing to a temp file and moving it into place
  only on success; re-probed, the committed file now survives a failed run.
- **F19** *(minor, runtime)* With no `.env.local` every route returned a bare 500.
  Confirmed. The proxy now catches the configuration error and answers with a
  readable 503 setup page — it sees every page request, so one place covers
  them all.
- **F20** *(minor, runtime)* The login form showed Node's raw "fetch failed" when
  Supabase was unreachable, under the password field where it reads as a
  credentials error. Confirmed. `signIn` now branches on
  `isAuthRetryableFetchError` and names the likely cause; auth-server messages
  still pass through verbatim.

**Rejected**

None. Every finding reproduced. Findings 8 and 11 are findings 1 and 3 seen from
the schema-fidelity angle rather than separate defects, so each pair has one fix;
findings 14 and 15 are two symptoms of one sanitiser bug and likewise share a fix.

**How each was checked.** The database findings (1–9 and 11) were reproduced
directly against a database built by `./scripts/verify-db.sh`, and each now has a
SQL test that fails without its fix. Findings 12 and 13 are pinned by
`lib/defaults.test.ts`. Finding 10's fix is the seed script, which needs GoTrue
and PostgREST and is therefore only typechecked and linted here — see the harness
caveat above; it is the one fix in this list with no automated check behind it.
The `?next=` findings (14, 15) and the unconfigured 500 (19) were reproduced
against a running `next dev` and re-probed after the fix. The `db:types` truncation (18) was reproduced by running the script and
watching the file survive afterwards. Finding 16 — the discarded token refresh on
`/login` — was confirmed by reading the code path rather than by forging an
expired session: the matcher excluded `/login`, the page calls `getUser()`, and
`lib/supabase/server.ts` swallows the `ReadonlyRequestCookiesError` that a
server-component cookie write raises, so there was nowhere for rotated cookies to
go. The reviewer's own trace with a stubbed Supabase shows the rotation
happening and no `set-cookie` coming back.

---

## Local test stack

### What it is

`scripts/dev-stack/` and the Playwright suite in `e2e/`. `npm run dev:stack`
serves one Supabase-shaped origin on `http://127.0.0.1:54321` carrying
`/rest/v1`, `/auth/v1` and `/storage/v1`, in front of a real PostgreSQL database
built from `supabase/tests/shim.sql` and the migrations, with the real
**PostgREST** binary answering every table read, every write and every `rpc()`
as `anon` or `authenticated` with RLS on. GoTrue and the Storage API are
re-implemented — about 1,200 lines — to the shape `@supabase/supabase-js`
parses. `npm run e2e` then drives the real application in a real browser against
it: sign in, land on a board, read the seeded columns, get bounced when signed
out. `scripts/dev-stack/README.md` is the reference.

### Why it exists

This repository is developed in an environment with **no Docker daemon**, so
`supabase start` cannot run and `supabase db reset` cannot run. Without the
stack, nothing above the SQL layer could be executed at all: no page that needs
data could be opened, the login form could never be submitted, and `proxy.ts`'s
session refresh could only be reasoned about. It exists to make M1's cards,
drag-and-drop and capture modal reviewable as *running software* rather than as
a diff. It is never deployed, never imported by the application, and where
Docker is available `supabase start` remains the authority.

### What it cannot prove

A green local run is not a green hosted run, and the difference is written down
in full under
[“What this harness does not reproduce”](../scripts/dev-stack/README.md#what-this-harness-does-not-reproduce)
— thirty-odd numbered items, kept current on purpose, because an undocumented
divergence is worse than a missing feature. The short version:

- **Auth is a subset.** Password and refresh-token grants only; no email, OTP,
  OAuth, SSO, MFA or `auth.admin.*`; no rate limiting; a shared HS256 secret
  instead of JWKS; a simplified refresh-token reuse interval and no reuse
  *detection*. `scripts/seed-demo.ts` still cannot run here.
- **Storage is a subset.** No transforms, resumable uploads, `move`/`copy`,
  public buckets, CDN or Range requests, and `list()` is one level with simple
  sorting and a bounded scan. The *ownership* rule is not faked: it is
  `0001_init.sql`'s policy refusing in Postgres.
- **The gateway is not Kong.** It requires an api key, and that is all: no
  consumers, no ACLs, no rate limits, no HTTPS.
- **The database is the shim's.** Plain PostgreSQL 16 with the `auth` and
  `storage` pieces recreated by hand; no Realtime, Edge Functions, Supavisor,
  `pg_cron`/`pg_net`/`pg_graphql`, Studio or platform limits. The SQL suite runs
  against a throwaway `nertube_test`, and the database that is served is built
  from the migrations alone so it carries no test fixtures.
- **It proves nothing about deployment.** No HTTPS, no real domain, no Vercel,
  no hosted project — and there is no hosted project for this app to check
  against. Anything on the list above has to be verified on real Supabase before
  it can be believed.
