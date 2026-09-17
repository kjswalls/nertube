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

---

## M1 — Capture, board, drag-and-drop, upload

### What M1 delivers

- **Quick capture.** `c` anywhere signed in opens a modal with one focused
  title input, a channel chip row and Enter to save; `1`..`9` retargets the
  channel *while the title is still empty*; Shift+Enter (or "More") reveals
  hook, notes and tags. `/capture` is the same `CaptureForm` as a standalone,
  phone-sized page with `?c=<slug>` for a per-channel bookmark.
  `captureVideo` goes through the `capture_video` RPC — `INSERT` on `videos` is
  revoked — and lands every idea in that channel's Idea stage.
- **The board.** `/c/[slug]/board`: enabled stages as columns in `position`
  order, real counts, WIP warning on `WIP_KINDS` only, cross-channel Filming
  batch badge at three, days-in-stage with the amber stale treatment past
  `channels.stale_days`, the Idea column capped at ten with "+K more in Ideas",
  Published/Repurposed cards dropping off 30 days after `published_at`.
- **Moving a card, three ways and one gate.** Native HTML5 drag (no library),
  two real `<button>`s on every card, and `[` / `]` on the selected card. All
  three call `moveVideo` → `move_video`, so the packaging gate, the
  `stage_entered_at` stamp and the checklist snapshot are the database's, not
  the board's. A refusal snaps the card back and raises a toast naming the
  missing field, with "Fix packaging" and "Skip gate…" links.
- **The detail stub.** `/videos/[id]`: working title autosaved on blur, and the
  concept-sketch upload — browser → Storage with the user's own session, then
  `recordConceptSketch` records the path — with the signed-URL thumb on the
  board card, signed for the whole board in one `createSignedUrls` call.
- **One keyboard and one toast** (see the reconciliation log below).

### Running it locally

```bash
npm install
npm run dev:stack          # prints the two NEXT_PUBLIC_ values; paste into .env.local
npm run dev                # http://localhost:3000, sign in as the stack's seed user
```

`npm run e2e` drives the whole thing in a real browser against its own stack;
`./scripts/verify-db.sh [dbname]` is still the SQL suite. There is **no hosted
Supabase project for this app**, so everything below was verified against the
local stack — `scripts/dev-stack/README.md` lists what that harness does not
reproduce.

### The reconciliation: three agents, one application

M1 was built by three parallel agents (capture, board, detail-stub + upload) and
landed with four collisions. What was done about each:

- **Two shortcut implementations, then two listeners.** `lib/shortcuts.ts` was
  written twice in the same minute and one `Write` overwrote the other; what
  survived was a hook that attached *its own* `document` listener per call site.
  Two call sites meant two listeners, no way for a modal to take the keyboard
  away from the page under it, and no way to see the whole key set. It is now a
  **single registry**: one `keydown` listener for the entire application,
  attached when the first binding registers and removed with the last.
  `useShortcuts(bindings, { enabled, exclusive })` registers; the registry
  dispatches newest-registration-first, one `run` per keydown. `exclusive` is
  what the capture dialog uses to make the board's keys inert while it is open —
  previously `j` pressed with focus on the dialog's close button moved a card
  behind the dialog.
- **Two transient-message mechanisms.** The board had `board-toast.tsx`; the
  capture host had its own `role="status"` line. Both now go through
  `components/toast.tsx`, mounted once in the root layout: `error` renders
  `role="alert"` (a refused drop), `info` renders `role="status"` (a capture
  landed), each with its own timeout and a dismiss button. `board-toast.tsx` is
  deleted. The only message *not* routed through it is `/capture`'s own inline
  "Captured …" line, which is part of the form and is what the page shows when
  JavaScript never arrives.
- **Competing card components.** `components/board-column.tsx` (M0's empty
  shell) was already deleted by the board agent in favour of
  `components/board/board-column.tsx`; nothing imported the old one. The card's
  thumbnail slot and the board's `BoardCard` type were extended by the upload
  agent rather than forked, so there is one `VideoCard`.
- **Type errors across the boundaries.** None survived: `npm run typecheck`
  (both projects) and `npm run lint` are clean, and `app/actions/videos.ts` —
  written by capture, appended to by upload — has one owner per export.
- **A duplicated PNG encoder** in the specs is now `e2e/png.ts`, imported by
  both files that need real image bytes.

### The keyboard set

One mechanism, one listener, and the keys are listed by the application itself:
`components/shortcut-hints.tsx` renders the *live registrations*, so the header
advertises exactly the keys that work on the route being looked at and cannot
drift from them. (The full `?` cheat sheet is M9; this is the part that could
not wait.)

| Key | What it does | Where it is bound |
|---|---|---|
| `c` | Capture an idea | the header, so everywhere signed in |
| `1`..`9` | Switch channel (the digit is drawn on the chip) | the header |
| `1`..`9` *in the capture modal, title empty* | Retarget the capture | the title field |
| `j` / `k` | Select the next / previous card | the board |
| `[` / `]` | Move the selected card back / forward by `CORE_KIND_ORDER` | the board |
| `Enter` | Open the selected card | the board |
| `Escape` | Close the capture dialog; on the board, clear the selection | the dialog / the board |

Rules the registry enforces for all of them: nothing fires from an `input`,
`textarea`, `select`, contenteditable or `role="textbox"`/`"searchbox"`/
`"combobox"`; nothing fires with Ctrl/Meta/Alt; `Enter`/`Space` stand aside on
natively-activated controls; a `preventDefault()`ed or IME-composing event is
ignored. Bindings that do not exist on a route are simply not registered —
pressing `j`, `k`, `[`, `]`, `Enter` or `Escape` on `/videos/[id]` does nothing
and raises nothing, which is asserted in the suite (`pageerror` count is zero).

One deliberate limit: a second `]` pressed while the first move for that card is
still in flight is dropped rather than queued — two `move_video` calls racing
over one row's `stage_entered_at` is worse — and the board now says so in its
live region instead of ignoring the key silently.

### The M1 acceptance, actually walked

`e2e/m1-acceptance.spec.ts` (5 specs, serial) does PLAN.md's M1 acceptance
through the pages, with nothing pre-seeded, and pairs every browser assertion
with a read of the served database:

1. **Two channels, eight ideas, dragged, reloaded, still there.** Both channels
   are created on `/c/new`; eight ideas are typed into the `c` modal — four on
   channel A's board, two aimed at B with the retarget digit from A's board, two
   from B's board. Postgres then says: eight rows, four per channel, every one
   in its own channel's Idea stage. Three are moved (two drags, one `]`), both
   boards are reloaded, and the three are in Packaging with a fresh
   `stage_entered_at` — in the browser *and* in the database.
2. **Dragging an idea past Packaging is refused.** Idea → Scripting on an idea
   with a title and nothing else: the toast says "Packaging still needs a
   thumbnail concept", carries both links, the card snaps back, a reload agrees,
   and `stage_id` *and* `stage_entered_at` are byte-identical to what they were.
   The same video is then moved Idea → Packaging with `]` (allowed) and refused
   again on the next `]` — same RPC, same refusal.
3. **A sketch uploaded on the detail page shows on the card.** Real bytes
   through the real picker; the picture on the page comes from a
   `/storage/v1/object/sign/thumbnails/…` URL and decodes at the fixture's
   pixel size; `videos.thumbnail_concept_path` names the stable path and
   `storage.objects` holds exactly one object for that video; the board card
   then shows the same image from the board's single batched signing call.
4. **The two revokes, from the browser** (below).
5. **The keyboard set is one set** — the hint bar lists `c`, `1–9`, `j`/`k`,
   `[`/`]` on the board and drops the board keys on `/videos/[id]`; a digit
   switches channel; a digit typed into the capture field is text; `j` in that
   field is text; Escape closes without writing; `j` selects and Escape clears.

### The revoked writes, proved from a client session

PLAN.md's M1 review line is *`update videos set stage_id` from the browser
client fails (revoke)*. Spec 4 above signs in inside the page (the same
`/auth/v1/token?grant_type=password` grant the app uses), then makes three
requests with that token: a control write to a column the client *is* granted,
the revoked column, and a direct INSERT. Reproduced by hand against the same
stack, with the same token, the answers are:

```
=== PATCH videos SET stage_id ===
{"code":"42501","details":null,"hint":null,"message":"permission denied for table videos"}
HTTP 403
=== POST videos (direct INSERT) ===
{"code":"42501","details":null,"hint":null,"message":"permission denied for table videos"}
HTTP 403
=== control: PATCH videos SET waiting_on ===
HTTP 204
```

The control is the point: the session is real, the row is the user's own, and
the same request shape succeeds on a column the grant allows. So the two 403s
are the column revoke and the table revoke from `0001_init.sql`, not a broken
token — and `move_video` / `capture_video` really are the only write paths for a
stage change and for a new video.

### Gates, as of this commit

| Gate | Result |
|---|---|
| `npm run typecheck` | clean (both `tsconfig.json` and `tsconfig.harness.json`) |
| `npm run lint` | clean |
| `npm run build` | succeeds; all seven routes, `/c/[slug]/board`, `/capture` and `/videos/[id]` dynamic |
| `./scripts/verify-db.sh m1_check` | OK — migrations applied, 12 test files passed |
| `npm run test` | 25 passed (2 files) |
| `npm run e2e` | 33 passed, 1 skipped of 34 (`session-refresh` skips itself unless the stack was started with a short token TTL — `npm run e2e:refresh`) |

### Deliberately not built

The packaging editor's candidate and hook lists, the live gate indicator and the
skip flow (M2); checklists, the ratio on the card and `/now` (M3); thumbnail
roles and the swap log (M4); the idea bank, buckets and the matrix — which is
why "+K more in Ideas" is plain text and not a link (M5); the calendar (M6);
settings (M7); brainstorm (M8); the `?` cheat sheet, `g n/b/i/k`, `p` and `x`
(M9). Two card slots render deliberately empty rather than faked:
`[data-slot="checklist-ratio"]` (a "0/0" would read as "nothing to do") and the
thumbnail frame when there is no sketch.

### The one part of M1 that is NOT done: the deploy

PLAN.md's M1 ends with *deploy to Vercel against a hosted project
(`supabase db push`)*, and *upload a sketch from the deployed app to the hosted
bucket*. **That has not been done and cannot be done from here**: there is no
hosted Supabase project for this application, no Vercel credentials, and neither
may be created in this environment. Nothing in this repository pretends
otherwise — every green result above is against the local harness in
`scripts/dev-stack/`, which explicitly *proves nothing about deployment*.

Everything the deploy needs is in place, so here is the runbook, in order, for a
human who has the accounts:

**1. Create the hosted project.** In the Supabase dashboard, create a project
(one region, any name). From *Project Settings → API* copy:

- the **Project URL** (`https://<ref>.supabase.co`) → `NEXT_PUBLIC_SUPABASE_URL`
- the **anon / publishable key** → `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- the **service role key** → `SUPABASE_SERVICE_ROLE_KEY` (local shell only —
  never a Vercel variable, never anything the browser can reach)

**2. Push the schema.** From the repository root, with the Supabase CLI:

```bash
supabase login
supabase link --project-ref <ref>
supabase db push          # applies 0001_init.sql then 0002_create_channel.sql
```

`supabase db push` is what creates the eight tables, every RLS policy, the
column revokes, `move_video` / `swap_thumbnail` / `capture_video`, the private
`thumbnails` bucket and its owner-only storage policy. Confirm with
`supabase migration list` that both migrations are applied remotely.

**3. Create the one user.** There is no sign-up screen by design. Either
*Authentication → Users → Add user* in the dashboard (tick "auto-confirm"), or,
from a shell that is pointed at the hosted project:

```bash
NEXT_PUBLIC_SUPABASE_URL=https://<ref>.supabase.co \
SUPABASE_SERVICE_ROLE_KEY=<service-role-key> \
SEED_EMAIL=<you@example.com> SEED_PASSWORD=<a real password> \
npm run seed:demo
```

`scripts/seed-demo.ts` creates the user *and* the two-channel, 8-video fixture
every milestone review starts from. It needs GoTrue and PostgREST, so a hosted
project is the first place it can actually run — it has never been executed,
only typechecked and linted (see M0's caveat). Skip it and use the dashboard if
you do not want the fixture in your real data.

**4. Regenerate the types (optional, recommended).**

```bash
NERTUBE_DB_URL=<the project's connection string> npm run db:types
```

`lib/database.types.ts` is hand-written here because `supabase gen types` needs
Docker; against a hosted project it can be generated for real. If it changes,
`npm run typecheck` is the check that it still matches the app.

**5. Deploy.**

```bash
npm i -g vercel        # or use the dashboard
vercel link
vercel env add NEXT_PUBLIC_SUPABASE_URL production
vercel env add NEXT_PUBLIC_SUPABASE_ANON_KEY production
# repeat both for `preview` if preview deployments should work
vercel deploy --prod
```

Only those **two** variables belong in Vercel. `ANTHROPIC_API_KEY` is M8 and
`SUPABASE_SERVICE_ROLE_KEY` is never deployed. With neither set the app answers
every page with the readable 503 setup page rather than a 500, so a missing
variable is visible rather than mysterious.

**6. Walk the acceptance on the deployed app**, because that is the part of M1
this repository cannot sign off:

1. Sign in; create two channels; capture eight ideas (`c`, and `/capture` from a
   phone); drag one; refresh; confirm it persisted.
2. Drag an idea past Packaging and confirm the refusal names the missing field.
3. **Upload a concept sketch from the deployed app** and confirm it appears on
   the detail page and on the card — this is the one behaviour with a real
   dependency the harness only approximates (`createSignedUrls` token shape,
   `upsert` semantics, `Cache-Control`; `scripts/dev-stack/README.md` items
   21–27). Re-upload the same sketch and confirm the storage browser shows
   **one** object at `{user_id}/{video_id}/concept.{ext}`, then upload a
   different format and confirm the old object is gone.
4. `curl` the REST endpoint with the anon key and confirm zero rows, and repeat
   the two revoked writes above against the hosted project.

**Known gap to close on the hosted project**, flagged rather than papered over:
`0001_init.sql` does not set `file_size_limit` or `allowed_mime_types` on the
`thumbnails` bucket row, so the server-side rule is *ownership only* — the 5 MB
and image-type checks are in the browser and are courtesy, not security. A
determined caller can put a large non-image at their own `concept.png`. Closing
it is a migration (or the bucket settings in the dashboard) and belongs to M7 or
a follow-up; it is not something M1 built and hid.
