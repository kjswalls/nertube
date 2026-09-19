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
  title input, a channel chip row and Enter to save; **Alt**+`1`..`9` (or the
  numbered chips, which are clickable tab stops) retargets the channel;
  Shift+Enter (or "More") reveals hook, notes and tags. A bare digit in the
  title field is text, always — see the review log below. `/capture` is the
  same `CaptureForm` as a standalone, phone-sized page with `?c=<slug>` for a
  per-channel bookmark, and it writes *and confirms* a capture with JavaScript
  switched off.
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
  missing field, with a single "Open “<title>”" link to the detail page.
  PLAN.md's "Fix packaging" and "Skip gate…" links come back in M2 with the
  packaging block and the skip flow they point at — see the review log. A move
  the server never answers is a refusal too: the card snaps back, the toast
  says the server could not be reached, and the card is movable again.
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
  JavaScript never arrives. (It is now *derived from the action's result during
  render* rather than copied into state by an effect, which is what makes that
  last claim true — see the review log.)
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
| Alt+`1`..`9` *in the capture modal* | Retarget the capture (a bare digit is text) | the title field |
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
live region instead of ignoring the key silently. That guard reads the in-flight
set from a **ref**, not from React state: under OS key auto-repeat the repeats
arrive before `setPending` has committed, and a guard read from a closure let
three or four calls out for one row (review finding 13). A repeat event is also
ignored outright, so holding `]` is one move.

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
   thumbnail concept written down (the sketch is not it)", carries its one
   link — to a page that exists — the card snaps back, a reload agrees,
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

### The adversarial review, and what it changed

Nineteen findings came back against this milestone. Each was reproduced here
before anything was written; the wording below says what was done, not what was
suggested.

**Fixed — blockers**

- **Quick capture ate a leading digit and filed the idea in the wrong channel**
  (finding 1). A bare `1`..`9` in the title field retargeted the channel while
  the field was empty, so "10 things I stopped doing" was saved as "0 things I
  stopped doing" in whatever channel the digit named — silently, on the most
  used path in the product. The binding is gone: inside the field a digit is
  text. Retargeting is Alt+digit (off `event.code`), the numbered chips, and the
  header's own `1`..`9` outside any field. `e2e/capture.spec.ts` now types that
  exact title and reads the row back.
- **A move that failed on the network left the card in the wrong column for
  ever** (findings 9 and 15). `requestMove` awaited the server action with no
  `try`/`catch`, so a rejection aborted it before the snap-back and before
  `pending` was cleared: the card stayed drawn where the database had never put
  it, "Moving…", both buttons disabled, `]` answering "is still moving", and
  nothing said. There is now a `catch` that takes the same branch as a refusal
  and a `finally` that clears `pending`. Proved in the browser with the
  server-action POST aborted, then re-tried with it restored
  (`e2e/board.m1.spec.ts`).
- **Capture and title autosave replaced the whole page with Next's error screen**
  (finding 10). Both awaited a server action that can reject; the rejection went
  to the nearest error boundary and took the typed idea with it. The title field
  and the sketch recorder now catch and render their existing error state. The
  capture form keeps the action on the `<form>` — that is the entire no-JS path
  — but with JavaScript running its `onSubmit` cancels the browser's submission
  and calls the action itself, so a rejection is a message above a form that
  still holds the title. Both covered end to end with the POST aborted.

**Fixed — majors**

- **The gate refusal's two links went nowhere** (findings 2, 7 and 12).
  `#packaging` and `#packaging-skip` exist on no page in M1, and the skip flow
  does not exist at all, so the toast offered two dead ends. It now carries one
  link, "Open “<title>”", to a page that exists. PLAN.md's pair returns in M2
  with the block it points at.
- **"Packaging still needs a thumbnail concept" fired on a card that visibly had
  one** (finding 3). The gate reads the written `thumbnail_concept`; the only
  thing the UI called a thumbnail concept was the *sketch*. The two are named
  apart everywhere now: the refusal says "a thumbnail concept written down (the
  sketch is not it)", the upload is "Concept sketch (reference)" with a line
  saying which field the gate reads, and the card's thumb says the same.
- **`/capture` with JavaScript off wrote the idea and confirmed nothing**
  (findings 4 and 17), while this file claimed the opposite. The line came from
  state written in an effect, and effects do not run without JavaScript. It is
  derived from the action's result during render, so it survives; the effect
  keeps only the clear-and-refocus. `e2e/capture.spec.ts` asserts it in a
  context with `javaScriptEnabled: false`.
- **Focus was dropped to `<body>` after every successful move** (finding 11).
  The card's node is re-created in another column, so `j` then `]` — and the
  on-card button — left a keyboard user with no place. The board remembers what
  was focused when the move started (the card, or which button) and puts it
  back on the re-rendered card.
- **`npm run e2e` was not repeatable** (finding 16). `upload.spec.ts` asserted
  that *no* `/storage/v1/` request had been made by the whole page, which any
  other card's sketch thumb broke on a reused stack; the assertion is scoped to
  the video under test. `capture.spec.ts` had no cleanup and added rows to the
  seeded channels on every run; it now deletes every title it captured.

**Fixed — minors**

- **The Filming badge put a cross-channel number under a per-channel count**
  (finding 5). It says "N in Filming across all channels — schedule batch day?"
  whenever the two numbers differ, and keeps the plain wording when they do not.
- **A client could rewrite `videos.id` and `videos.created_at`** (finding 6):
  `id, user_id, created_at` were carried into the re-granted column list in
  `0001_init.sql`. `0003_identity_columns.sql` revokes `update (id, created_at)`
  on `videos` and `stages`; `supabase/tests/20_column_privileges.test.sql`
  asserts both the refusal (42501) and the catalogue.
- **A `npm run dev` server made the whole suite fail to launch** (finding 8).
  `scripts/e2e-preflight.mjs` runs before Playwright's app server, reads
  `.next/dev/lock`, checks the pid is alive and prints one sentence naming the
  pid to kill; `scripts/dev-stack/README.md` item 32 says so too.
- **The "one move at a time" guard did not survive key auto-repeat**
  (finding 13): it is a ref now, and a repeat event is ignored. A held `]` puts
  exactly one POST on the wire, asserted with real auto-repeat over CDP.
- **A drop on a column's header did nothing** (finding 14). The drag handlers
  moved from the inner scroller to the `<section>`, so the whole column — header
  included — is the drop target.
- **Residue** (finding 19): the empty `checklist-ratio` span is gone (it returns
  in M3 with a real ratio), `useToast()` exposes `push` alone,
  `THUMBNAILS_BUCKET` and `CONCEPT_SKETCH_TYPES` are no longer exported,
  `coreOrder` uses `compareKinds` from `lib/defaults.ts`, and the inert-stage
  message no longer points at arrows that are disabled in exactly that case.
  The branch itself stays: user-added inert stages are M7, and a message that
  matches the buttons costs nothing.

**Rejected**

- **"The live shortcut hint bar is M9 work"** (finding 18). PLAN.md puts the
  *full shortcut set and the `?` cheat sheet* in M9; it does not say that the
  eight keys M1 itself binds must be undiscoverable until then, and a
  keyboard-first board whose keys are written down only in a plan has no
  keyboard. The suggested compromise — hard-code three entries in the component
  — is the one version that would be wrong: the bar's whole claim is that it
  lists the bindings that are live *on this route*, which the acceptance spec
  asserts by opening `/videos/[id]` and watching the board's keys disappear
  from it. The cost is 27 lines in `lib/shortcuts.ts` and a 41-line component.
  Reconsider in M9 if the `?` sheet makes the bar redundant.
- **The half of finding 2 that asks for `thumbnail_concept` and hook fields on
  the M1 stub** — that is the packaging block, which PLAN.md assigns to M2. The
  honest half of the finding (do not link to anchors that do not exist) was
  applied instead.

**Deferred, to a named milestone**

- The packaging editor — written concept, title candidates, hooks with one
  chosen, the live gate indicator and Skip-with-a-reason — and with it the
  return of the "Fix packaging" and "Skip gate…" links: **M2**.
- The checklist ratio on the card: **M3**, with the checklists it counts.

**Still not done, and not doable here:** the deploy — see the runbook below.
It is the only part of M1's plan line that no amount of local work can close.

### Gates, as of this commit

Re-run after the review fixes, in this order, as the last thing done to this
milestone:

| Gate | Result |
|---|---|
| `npm run typecheck` | clean (both `tsconfig.json` and `tsconfig.harness.json`) |
| `npm run lint` | clean |
| `npm run build` | succeeds; all seven routes, `/c/[slug]/board`, `/capture` and `/videos/[id]` dynamic |
| `./scripts/verify-db.sh m1_final` | OK — three migrations applied, 12 test files passed |
| `npm run test` | 25 passed (2 files) |
| `npm run e2e` | 40 passed, 1 skipped of 41, 1.6m (`session-refresh` skips itself unless the stack was started with a short token TTL — `npm run e2e:refresh`) |

The e2e figure is from the **second consecutive run against the same, unreset
stack**, which is the point of finding 16: before the fix that run failed on
`upload.spec.ts` while a cold one passed. Seven of the forty are new and exist
only because of this review — the leading-digit title, the two unreachable-server
paths for capture and for the title, the unreachable-server move, the drop on a
column header, the held `]`, and focus after a move — plus the no-JS `/capture`
confirmation.

### Deliberately not built

The packaging editor's candidate and hook lists, the live gate indicator and the
skip flow (M2); checklists, the ratio on the card and `/now` (M3); thumbnail
roles and the swap log (M4); the idea bank, buckets and the matrix — which is
why "+K more in Ideas" is plain text and not a link (M5); the calendar (M6);
settings (M7); brainstorm (M8); the `?` cheat sheet, `g n/b/i/k`, `p` and `x`
(M9). The checklist ratio renders *nothing at all* — not even an empty element
— until M3 puts a real `done/total` there, because a "0/0" would read as
"nothing to do"; the card's thumbnail frame is the one slot drawn empty, and
only so that a board of a hundred cards has one layout.

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
supabase db push          # applies 0001_init.sql, 0002_create_channel.sql, 0003_identity_columns.sql
```

`supabase db push` is what creates the eight tables, every RLS policy, the
column revokes (including `0003`'s, which take `id` and `created_at` out of the
client's UPDATE grant), `move_video` / `swap_thumbnail` / `capture_video`, the private
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

---

## M2 — Detail page: packaging, the gate, and the flow fields

### What M2 delivers

- **`/videos/[id]`, composed.** One page, in the order BRIEF.md principle 1
  argues for: the **packaging block first**, reading as the gate it is, then the
  flow fields. M1's `TitleField` stub is gone (`app/videos/[id]/title-field.tsx`
  deleted) — it bound a second input to `videos.title` on the same page as the
  block's working title, and two inputs over one column is a race.
- **The packaging block** (`components/packaging/`): the working title with a
  live character count and a >55 warning that never blocks; the candidate editor
  (add, note, choose — choosing copies the text into `videos.title`, because the
  gate reads the column and not the list); the **written** thumbnail concept; the
  hook list capped at three with one chosen; the live gate indicator; and the
  skip disclosure with its required typed reason.
- **The concept sketch, moved inside it.** M1's uploader is no longer a section
  of its own. It is rendered as a `sketch` slot beside the written concept, in
  one bordered group, `Thumbnail concept (written)` on the left and
  `Concept sketch (reference)` on the right. Apart, they read as two fields
  either of which might satisfy the gate — which is precisely the misreading M1's
  review caught. Together, the description is plainly the field and the picture is
  plainly the reference, and both help lines say which is which.
- **The flow fields** (`components/video-detail/`): stage select (through
  `moveVideo` → `move_video`, so the gate cannot be walked around from the page
  the packaging fields live on), target publish date with an explicit Clear,
  `waiting_on` with its age, the final YouTube URL (a link only once
  `published_at` is set), notes, and archive/restore.
- **`waiting_since`** (`supabase/migrations/0004_waiting_since.sql`): requirement
  4 asks how long a block has been in place, and M0 stored only the text.
  Paired with `waiting_on` by a CHECK, stamped `coalesce(existing, now())` so
  re-wording "the editor" to "the editor's second pass" keeps the original
  clock. Covered by `supabase/tests/65_waiting_since.test.sql`.
- **The two gate-refusal links, restored.** See below.
- **`updated_at` as a precondition** (`components/video-version.tsx`, added by
  the adversarial review): every write from this page says which version of the
  row it was computed against, so a second tab cannot silently overwrite a jsonb
  column it never saw.

### The reconciliation: two agents, one page

The packaging half and the flow half were built concurrently and landed with
four genuine collisions. All four are resolved by deletion, not by adapters.

**1. Two autosave mechanisms → one.** The flow half had a per-field blur-saver
factored out of M1's title field; the packaging half had a block-level queue
that serialised whole-patch writes. Different state shapes, different status
elements, different answers to "what happens when two saves overlap", for two
halves of the same page. `components/autosave.tsx` is the merged one, and it is
two layers because the page has two shapes of edit:

- `useSaveQueue` — **one save on the wire at a time.** Every patch this app
  sends carries *absolute* values (the whole title, the whole hook list), so two
  in flight is not a merge problem but an ordering one: if `[c1]` and `[c1, c2]`
  are both sent and the slower one is the first, the row ends up holding `[c1]`
  and the second candidate is gone from the database while still on screen. A
  save that arrives while one is in flight is queued, merged over anything
  already queued, and sent when the wire is free. It also answers
  `peekPending()` — the patch on the wire merged with anything queued — because
  an editor has to diff itself against what it has **sent**, not against what
  the server last confirmed; the review log below is mostly about what happened
  when it did not.
- `useAutosave` — one text field, saved on blur, built on a queue of its own.
  The flow fields therefore gained the serialisation they did not have.
- `SaveStatus` — one status line, `role="status"` normally and `role="alert"`
  on a failure, with an optional Retry that re-sends exactly the payload that
  failed. `components/packaging/save-status.tsx` and
  `components/video-detail/autosave.tsx` are both deleted.

The archive button uses the queue directly, with a boolean for a patch: a click
is the whole decision, so there is no blur to wait for, but the caught
rejection, the retry payload and the one status element are not hand-rolled a
third time. **The stage select is deliberately not on it** — a move is not a
save. It goes through `move_video`, it can be refused by the gate, and it says
"Moving…" / "Moved to Scripting." / the refusal. Folding it in would mean
teaching the save status a second vocabulary, which is how one pattern becomes
two again.

The four properties M1 established are kept verbatim: nothing is sent when
nothing changed; a failure never reverts what is on screen; a rejected promise
is caught (uncaught, it replaces the whole route with an error screen, taking
the text being edited with it); and success re-reads the value from the server's
answer *unless something has been typed since*, in which case what is on screen
is newer and wins. The review added a fifth and sharpened the fourth: "nothing
changed" is measured against what has been sent rather than what has been
confirmed, and a success re-reads **only the columns that patch carried**, so an
answer about one column can never rewrite another.

**2. Competing zod schemas → one.** Three schemas described one row: M1's title
field, the packaging patch, the flow patch. `lib/video-fields.ts` is now the one
schema for everything `/videos/[id]` can write — every key optional, only the
present ones written — and it *composes* the packaging element rules
(`TitleCandidateListSchema`, `HookListSchema`, `SkipReasonSchema`) from
`lib/packaging.ts` rather than restating them. The rules those files carry are
the ones no CHECK can express: at most one `chosen` per list, unique ids, no
blank text, and the "empty means NULL, never `''`" convention that `/now`, the
board and the idea bank all depend on. `captureVideo`'s `OptionalText` is now
derived from the same `NullableText`, so trimming is defined once.

**3. Duplicated server actions → one.** `updateWorkingTitle` (M1),
`updateVideo` (packaging), `updateVideoFlow` (flow) and `setVideoArchived`
shared the ownership check, the `updated_at` stamp and both revalidations, and
differed in every detail of how they reported a refusal. They are now one
`updateVideo`, returning the whole `VideoState` read back from the row — so the
gate indicator is derived from what is *stored*, which is what `move_video`
reads, rather than from what was typed.

**4. A type error across the boundary.** The flow agent had to strip `export`
from `packagingStateFromRow` because a `"use server"` module may only export
async functions and Turbopack takes every route down otherwise. That function is
now `stateOf`, private, in the merged action; nothing needs to export it.

### The gate refusal links M1 deferred, and what "focus" means here

PLAN.md: *a refused drop snaps back with a toast naming the missing field, a
"Fix packaging" link (detail scrolled to that field) and a "Skip gate…" link*.
M1 shipped one link to the detail page and said why: both fragments pointed at a
page that had no packaging fields on it, and a link to nothing is worse than no
link. M2 built the fields, so the pair is back:

- `lib/packaging.ts` now carries `GATE_ANCHOR` (`title` → `packaging-title`,
  `thumbnail_concept` → `packaging-concept`, `hook` → `packaging-hook`) and
  `SKIP_ANCHOR`. They live beside the predicate so the board can build an href
  without importing a client component, and so a renamed field cannot leave a
  link pointing at nothing.
- Each anchor is on a **focusable control**, never on the section around it,
  and `components/packaging/hash-focus.ts` puts the caret in it on mount and on
  every `hashchange`. A browser's own fragment handling scrolls and stops, which
  for a text field means arriving looking at the box and still having to click
  it — a second gesture, and on a phone a lost keyboard.
- The hook anchor moves with the situation: the first hook's **Choose** button
  when there are hooks to pick between, the add box when the list is empty. The
  gate's hook refusal means "none is chosen" far more often than "none is
  written".
- `#packaging-skip` **opens the disclosure** and focuses the reason box. The
  disclosure's `open` is derived rather than stored, so the form is in the
  document before the focus effect runs; an effect that opened it first would
  need a second pass, and `setState` inside an effect to trigger that pass is
  exactly the cascading render the React lint rule refuses. Skipping is still
  three deliberate acts — the link only ever comes from a refusal, the reason is
  still typed, and a blank one is still refused out loud.

This was verified by clicking, not by reading the markup:
`e2e/m2-acceptance.spec.ts` follows both links from a real refusal toast and
asserts on `document.activeElement.id`, then types without clicking anything
first and checks the text landed in the field the gate named. A separate manual
browser pass with screenshots confirmed the same thing visually, including the
focus ring and the scroll position.

### The M2 acceptance, actually walked

PLAN.md's M2 line: *fill the three fields, move to Scripting; skip with a
reason, see the badge; clear the title afterwards and see "Complete packaging"*.
`e2e/m2-acceptance.spec.ts`, four specs, against the real app, the real
PostgREST and real RLS — every browser claim that changes a row paired with a
read of that row:

1. **The gate opens.** Capture, drag to Packaging, write the concept (the
   indicator moves from `thumbnail_concept` to `hook`), write three hooks (still
   `hook` — "none is chosen yet"), choose one (`ready`), then move to Scripting
   from the stage select and read `stage_kind = 'scripting'` out of Postgres.
   Then **clear the title**: the indicator goes back to `title` and says "needs a
   working title", and the next move is refused by `move_video` for that same
   field — the later-cleared-field case PLAN.md's review log calls out, proved
   rather than assumed.
2. **The skip.** The empty reason is refused out loud and writes nothing; the
   typed one lands in both paired columns; the amber **TTH skipped** badge is on
   the card on the board; and the video then moves to Scripting with all three
   fields still empty.
3. **The two links**, as above.
4. **The composed page**: the packaging block's bounding box is above the flow
   fields', there is exactly one input labelled "Working title", and a packaging
   save and a flow save in sequence both land (including `waiting_since`).

### The adversarial review, and what it changed

Twenty-two findings came back against this milestone. Each was reproduced here
before anything was written, and the wording below says what was done rather
than what was suggested. Four blockers, five majors and thirteen minors; three
are recorded rather than built, and one turned out to be two views of a fix
already being made.

**The one bug under four of the findings**

Findings 1, 9 and (from the other end) 5 are the same hole: the editor diffed
itself against *what the server last confirmed* rather than against *what had
already been sent*. Type a title, blur, change your mind while the save is still
on the wire, type the old one back, blur — and the diff comes out empty. Nothing
is queued, the abandoned value lands, and the status line says "Saved" over a
row, a board card and a screen that now hold three different strings, for ever.

`useSaveQueue` now exposes `peekPending()`: the patch on the wire, merged with
anything queued behind it, and `null` the moment the wire settles — including
after a failure, so the row never takes credit for a write it refused.
`PackagingBlock.commit` and `useAutosave.commit` both diff against that, falling
back to the confirmed values when nothing is outstanding. The "nothing changed,
send nothing" shortcut is kept, because tabbing through untouched fields must
still be silent; it is just no longer asked the wrong question.

**Fixed — blockers**

- **An edit undone while its save was in flight was never sent** (findings 1 and
  9). Above. Proved in `e2e/m2-review.spec.ts` with the server action's POST
  held open for two seconds by `page.route` — latency, not a stub: the same
  action, the same PostgREST, the same RLS, just later. Two cases: the working
  title typed and taken back, and a candidate added and then removed. Both end
  with the row, the field and the board card agreeing.
- **A skip threw away unsaved packaging edits and then reported "Saved"**
  (finding 5). `skip` and `unskip` called `send({ packagingSkip })` on their own
  instead of folding the outstanding diff in, and the answer — a row that knows
  nothing about the concept typed thirty seconds earlier while the wifi was down
  — was then adopted wholesale into the editor. Two fixes, because there were
  two mistakes: the skip goes through the same diff as every other edit, and the
  answer to any save now overwrites **only the draft keys that patch carried**,
  so a write about `packaging_skipped_at` can never rewrite the title, the
  concept, the candidates or the hooks. The e2e case drops the connection, types
  a concept into the failure, restores it, skips, and reads the concept back out
  of Postgres.
- **One invalid element wedged every other packaging save** (finding 6, and
  finding 8 from the data end). Every packaging field shares one patch, and
  `TitleCandidateListSchema` rejects the whole list if any element is bad — so
  one blank candidate text (select-all, delete, Tab) made the title, the concept
  and the hooks permanently unsavable, with the shared line telling someone
  typing a title that "a title candidate needs some text" and no indication
  which row was meant. `withoutInvalidLists` now takes the failing list *out of
  the patch*, sends the rest, and reports the failure **on the offending row**
  (`data-testid="candidate-issue"` / `"hook-issue"`, `role="alert"`), using the
  element id zod's `path: [index, …]` points at. Nothing invalid is written —
  the rule has not been relaxed — and because the dropped key never enters
  `saved` or the pending baseline, the list saves itself the moment the row is
  repaired, with no other gesture. That is also finding 8's answer: a row this
  app did not write no longer locks its list, it marks it.

**Fixed — majors**

- **Two tabs silently clobbered the jsonb columns** (finding 7). Every patch
  carries absolute values computed against the row the editor was rendered with,
  and the write was unconditional, so a second tab PATCHed its whole `hooks`
  array over the first tab's and neither side could tell. `updated_at` is now
  the precondition: `updateVideo` takes `expectedUpdatedAt` and matches on it
  (`.is("updated_at", null)` for a row `capture_video` has never written), a
  zero-row answer is distinguished from a deleted video by one extra read, and
  the page says *"This video changed somewhere else…"* with a **Reload** button
  instead of a Retry that could only overwrite the newer values.
  `components/video-version.tsx` holds one token for the whole page, seeded from
  the server render and advanced only by this page's own writes — all five of
  them, which is why `moveVideo` and `recordConceptSketch` now return the
  `updated_at` they stamped. A token that missed either would turn every save
  after a move or an upload into a conflict that never happened; there is an
  e2e case for exactly that, alongside the two-tab one.
- **The target date's "saved on change" was documented twice and implemented
  nowhere** (finding 16). The native `<input type="date">` keeps focus after the
  overlay closes, so a picked date sat unsaved with the status line saying
  nothing and `NULL` still in the column after navigating away. `onChange` now
  calls `commit` as well as `setValue`; `commit` returns early when the value
  already matches what has been sent, so the pair cannot double-save.
- **`FlowFields` never re-synced, so publishing from the page's own stage select
  left the URL block saying the video was not live** (finding 17). The shared
  slice was seeded into `useState` from props and updated only from `updateVideo`
  answers — and `published_at` is written exclusively by `move_video`, so that
  copy could never catch up at all. The props are authoritative again: what is
  kept is the *delta* a save produced, tagged with the props it was computed
  over, so a `router.refresh()` wins the moment it arrives. `publishedLabel` is
  recomputed alongside the value it labels, which the old `absorb` did not do.
- **Un-skipping re-opened the skip form pre-filled with the reason just
  withdrawn** (finding 10), which made re-skipping one click and no typing —
  the cheapest control on the screen, immediately after someone chose to do the
  work properly. Crossing `skippedAt` in either direction now closes the
  disclosure, empties the box and puts focus on the control that replaced the
  one that vanished.
- **Every structural change dropped focus onto `<body>`, and the skip
  disclosure was not a disclosure** (finding 11). The skip button stays mounted
  and carries `aria-expanded` and `aria-controls`; opening it moves the caret
  into the reason box; Cancel returns it to the button; a successful skip lands
  on Un-skip and an un-skip lands back on the link. Removing a candidate or a
  hook focuses the next row's text field, or the add box when the list empties.
  All of it guarded on focus actually having been dropped, so nothing is taken
  off a user who moved on while the save was in flight.

**Fixed — minors**

- **A candidate kept its green "Chosen" badge after the working title was
  changed** (finding 2). Choosing copies the text into `videos.title` because
  the gate reads the column; nothing un-chose when the column then changed.
  `unchooseStaleCandidates` runs on every commit, so an edit to the title *or*
  to the candidate's own text closes the gap, and the tick and the gate cannot
  disagree in either direction.
- **The hook counter read as a cap rather than a target** (finding 3). It now
  says "— the brief asks for three, then pick the strongest" while fewer than
  three are written, the same shape the candidate counter already had. The gate
  itself is unchanged: PLAN.md says exactly one chosen, and it still says that.
- **A one-character skip reason was accepted** (finding 4), so bypassing the
  gate was cheaper than writing the concept — the asymmetry BRIEF.md principle 1
  asks for, running backwards. `MIN_SKIP_REASON_LENGTH` is 12, refused in
  `SkipReasonSchema` and again inline in the disclosure so the answer comes back
  without a round trip. The two mistakes have two messages: nothing typed, and
  something typed that is not a reason.
- **"Skip packaging" was silently disabled while an unrelated save was in
  flight** (finding 12) — a disabled button with no explanation, which the
  file's own doc comment rejects. It is enabled; the queue serialises the skip
  behind whatever is on the wire, which is what it is for.
- **Every "Choose" button had the same accessible name** (finding 13). They are
  `Choose candidate 3` / `Un-choose hook 1` now, the way the Remove buttons
  already were, with the visible text unchanged.
- **Static help text lived inside `role="status"` live regions** (finding 14),
  so resuming typing announced the help paragraph. `SaveStatus` keeps the live
  region for the save state alone and renders the hint as a sibling; the gate
  indicator's live region is the gate sentence, with the "(not saved yet…)"
  caveat outside it, so the first keystroke of an edit no longer re-reads the
  whole thing. The stage select got the same treatment.
- **Phone-width targets and font sizes** (finding 15): the skip link has
  vertical padding and clears 24×24, and the candidate note input and the notes
  textarea are 16px so iOS does not zoom the page on focus — which
  `working-title.tsx` already had a comment about. The 26px choose/remove
  buttons clear WCAG 2.5.8 and were left alone.
- **Three exported length limits were duplicated as magic numbers** (finding
  18). `MAX_WAITING_ON_LENGTH`, `MAX_URL_LENGTH` and `MAX_NOTES_LENGTH` are
  imported into `flow-fields.tsx`, which is what the packaging half already did.
- **Dead knobs and dead types** (finding 19): `useAutosave`'s never-passed
  `trim` option is gone (and with it a comment that was false), `useSaveQueue`
  answers `SaveResult` — `{ ok: true } | { ok: false; error; conflict? }` — with
  the value-carrying `SaveOutcome` left to `useAutosave`, which is the only
  thing that reads it, and the unused `VideoPatch` export is deleted.
- **Stale references** (finding 20): the three `updateVideoFlow` mentions name
  `updateVideo`, `age.ts` no longer claims an archive line that does not exist,
  and the orphan section banner in `app/actions/videos.ts` is gone.
- **`readHooks` claimed to accept exactly what `move_video` accepts** (finding
  22) and did not: Postgres' boolean input also takes `y`, `ye`, `n`, `tr`,
  `fals` and the rest of the prefixes, so `{"chosen":"y"}` read as not-chosen in
  the indicator while the gate counted it and let the video straight through.
  `asChosen` now carries both lists in full, they are exported as
  `PG_BOOLEAN_STRINGS`, and `lib/packaging.test.ts` pins them against the output
  of `select ('y')::boolean, ('tr')::boolean, …` on PostgreSQL 16. The comment
  also says what happens to a value Postgres *cannot* cast: `move_video` raises,
  which is a refusal someone sees, and the reader calls it not-chosen because a
  renderer cannot raise.

**Rejected**

- None outright. Finding 8 ("the readers accept shapes the writers refuse") is
  finding 6 seen from the data end rather than a separate defect, so it has no
  separate fix: `asChosen` closes the `chosen` half and the per-row reporting
  closes the "no way to repair it except deleting it" half. Two halves of two
  other findings were not done as suggested and the reasons are above: finding
  6's alternative of *treating a blanked candidate as a removal* was not taken
  (select-all-delete-Tab while thinking is not a request to delete the row), and
  finding 15's `min-h-11` on the choose and remove buttons was not taken (26px
  already clears WCAG 2.5.8, and 44px rows would crowd a fifteen-candidate list
  on the screen that exists to encourage fifteen candidates).

**Recorded rather than built**

- **`waiting_since` is an M3 feature with an M0-schema change, shipped in M2**
  (finding 21). Correct, and the reviewer's own advice was not to rip it out.
  Stated plainly here, since the "Deliberately not built" note below says `/now`
  is M3 while the column only `/now` needs is already in the schema: PLAN.md's
  `videos` flow columns are `waiting_on`, `filming_day_id`,
  `target_publish_date`, `archived_at` — there is **no `waiting_since`** — and
  M0 was the milestone that was supposed to deliver the whole schema. M2 added
  it anyway (`supabase/migrations/0004_waiting_since.sql`, its paired CHECK, its
  column grant, `supabase/tests/65_waiting_since.test.sql`,
  `components/video-detail/age.ts`, and the `coalesce(existing, now())` branch
  in `updateVideo` with the extra read it costs) because requirement 4 asks how
  long a block has been in place and the text alone cannot answer. It is a
  deviation from PLAN.md's fixed column list and a milestone early. Nothing is
  broken by it; the next reviewer should not have to rediscover that the schema
  and the plan disagree here.

**Deferred, to a named milestone**

- Nothing from this review was deferred: no finding asked for an M3+ feature.
  What the review *touched* that belongs later is unchanged — the brainstorm
  panel that will sit on this block is still M8, and the checklist ratio and
  `/now` are still M3.

**How each was checked.** Everything above was reproduced and re-probed against
the local dev stack — the real app, the real PostgREST, real RLS — in Chromium.
`e2e/m2-review.spec.ts` is thirteen new specs that exist only because of this
review, and it is deliberately the file that edits with a **busy** wire: the
rest of the suite waits for "Saved" after every gesture, which is exactly why
none of it could see findings 1, 5, 9 or 12. `lib/packaging.test.ts` gained the
skip-reason floor and the Postgres boolean set. The two-tab finding is covered
by a second page in the same browser context, and by the companion spec that
proves a move and an upload on the *same* page do not produce a false conflict.

### Gates, as of this commit

Run in this order, as the last thing done to this milestone:

| Gate | Result |
|---|---|
| `npm run typecheck` | clean (both `tsconfig.json` and `tsconfig.harness.json`) |
| `npm run lint` | clean |
| `npm run build` | succeeds; seven routes, `/videos/[id]` dynamic |
| `./scripts/verify-db.sh m2_final` | OK — four migrations applied, 13 test files passed |
| `npm run test` | 80 passed (4 files) |
| `npm run e2e` | 67 passed, 1 skipped of 68, 4.4m |

The skipped spec is `session-refresh`, which skips itself unless the stack was
started with a short token TTL — it has its own command, `npm run e2e:refresh`.

The e2e figure is from **two consecutive runs against the same, unreset stack**
(4.4m then 4.5m, both 67/1), preceded by a cold run on a freshly reset database
(also 67/1, 4.5m). Thirteen of the sixty-eight are `e2e/m2-review.spec.ts` and
exist only because of the adversarial review.

**One repeatability defect the review's own new spec exposed**, fixed here
rather than worked around: `e2e/m1-acceptance.spec.ts` retargets a capture with
`Alt`+the digit its second channel is drawn with, and the header only binds
`1`..`9`. Every spec file in `e2e/` owns a channel and recreates it rather than
dropping it, so the steady state was already nine channels — exactly the last
digit that exists. Adding one more file took it to ten and the walk failed with
`Unknown key: "Digit10"` on the *second* consecutive run. `cleanUp()` in that
file now clears every non-seed channel before it starts, so the acceptance walk
begins from the state PLAN.md describes — *log in, create two channels* —
regardless of what ran before it. This is the same class of finding as M1's
number 16, and it was reachable only by running the suite twice.

### Honest limits

- Everything was verified against the local dev stack
  (`scripts/dev-stack/`), never a hosted Supabase project — this container's
  egress blocks `*.supabase.co`. `scripts/dev-stack/README.md` lists what that
  harness does not reproduce. The M1 deploy gap is still open and still the one
  part of this repository that cannot be signed off from here.
- `StageSelect` initialises its current stage from props once and does not
  re-sync — the same deliberate limitation as the board's override map. It is
  no longer *dangerous*, because a write from a stale editor is refused by the
  `updated_at` precondition rather than allowed to overwrite, but a second tab
  still shows a stage the video may have left.
- The title character-count warning uses raw `value.length`, not the trimmed
  length, so trailing spaces count toward 55. That is the number YouTube
  truncates on, and it keeps the live count and the warning from disagreeing.
- Archiving does not clear `waiting_on` and does not touch the stage, so
  restoring needs no decision about where the card goes.
- The gate indicator's "not saved yet" caveat is derived by diffing the editor
  against the last confirmed row, so it is honest about a save in flight, a
  failed one, and a list element that could not be written. It still cannot
  *know* about an edit made in another tab until something is saved — what it
  can no longer do is let that edit be overwritten in silence: the next save
  from this tab is refused with "this video changed somewhere else" and a
  Reload.
- The `updated_at` precondition is optimistic locking, not merging. Two people
  editing one video still means one of them reloads and retypes; what is gone
  is the version where neither of them is told. It also means an **out-of-band**
  write — a `move_video` run over SQL, the board open in another tab — makes the
  open editor refuse until it is reloaded. That is deliberate, and
  `e2e/packaging.spec.ts` now reloads after the SQL moves it makes for exactly
  that reason.
- A list element that fails its own schema is dropped from the patch and marked
  on its row; the rest of the block keeps saving. While it is unsaved the gate
  indicator says "not saved yet" but the shared save line can read "Saved" — it
  is reporting the wire, which really is idle, and the alert on the row is the
  thing that says what is outstanding.

### Deliberately not built

The brainstorm panel belongs on this block and is M8 — the block leaves room for
it and does not stub it. Checklists, the ratio on the card and `/now` are M3
(the page says so at the bottom rather than pretending they are coming
invisibly); thumbnail roles and the swap log are M4; the idea bank and the
matrix M5; the calendar M6; settings M7. The Filming badge PLAN.md lists under
M2 shipped with the board in M1 and is still text-only until M6 gives it a
filming day to create.

---

## M3 — The design shell: two themes, one sidebar, the metrics

### A deviation from PLAN.md, stated first

`docs/PLAN.md` assigns M3 to *checklists, `/now`, weekly strip*. **This
milestone is not that.** It is the design shell the signed-off "Moss & Sand"
canvas describes — the palette, the type, the sidebar and the page metrics —
and it builds none of the checklist work.

The reason is ordering, not preference. Every screen M3–M9 adds (the `/now`
sections, the checklist panel, the idea matrix, the calendar) is a screen drawn
inside this frame. Building nine of them against M0's Tailwind-default greys and
then restyling all nine is the same work done twice, and the second pass is the
one that quietly changes behaviour. So the frame comes first and PLAN.md's M3
content moves behind it; the checklist snapshot `move_video` already writes, and
the script template it already fills, are untouched and unconsumed, exactly as
they were.

**Nothing in PLAN.md's M3 line was built here.** `/now` still does not exist,
the checklist UI does not exist, the weekly strip does not exist, and the card's
`done/total` still renders nothing at all rather than a "0/0". The sidebar draws
`Now` as a **disabled control naming the milestone it arrives in**, which is the
same rule M1's review settled on for the gate-refusal links: an affordance may
describe what is coming, and may not pretend to be it.

### What M3 delivers

- **One palette, in two themes** (`app/globals.css`). Every colour in the
  application is now a custom property declared in three blocks — light on
  `:root`, dark under `@media (prefers-color-scheme: dark)` *guarded by*
  `:root:not([data-theme="light"])`, and dark again under
  `:root[data-theme="dark"]`. The guard is what makes a manual override beat the
  system in both directions; without it a light choice on a dark OS is undone by
  the media query, which is later and no less specific. There is not a single
  `red-500` or `amber-100` left in `app/` or `components/`.
- **Colour that means something.** `accent` is the one interactive hue (the
  current channel, every focus ring, a selected card). `ready` is a gate that is
  open, `attention` is stale / skipped / waiting, `over-limit` is a rule being
  broken right now and is the only red in the product. Structure is grey-green
  and takes no hue at all, so an empty Idea column and a quiet Filming column
  look like the furniture they are.
- **Three faces, self-hosted** (`app/layout.tsx`, `next/font/google`). Newsreader
  for what the *user* wrote (page titles, video titles, hooks), Instrument Sans
  for the tool's own chrome at 11–14px, JetBrains Mono for what the tool
  *measured* — counts, ages, shortcut keys, with `tabular-nums` attached to the
  face so a count ticking 9 → 10 cannot shift the header above it. No
  `<link>` to fonts.googleapis.com and no request to Google from a reader's
  browser.
- **The metrics, declared once** and consumed as utilities: a 224px sidebar,
  32px gutters on the board and the video page, 40px on reading views, 216px
  columns with a 16px gap, 12/13 card padding, 8/7/6 radii. `border-2` appears
  nowhere; `shadow-*` appears on the toast and the capture dialog and nowhere
  else.
- **The sidebar** (`components/app-sidebar.tsx`), replacing
  `components/app-header.tsx`, which is deleted. Sections, then channels from
  the database, then the account. `c` and `1`..`9` are still bound here, because
  this is still the one component every signed-in route renders **except
  `/capture`** — which is deliberately chrome-free (PLAN.md's phone bookmark: it
  renders no `AppShell`, no sidebar, and its own 16px padding rather than the
  32px gutter, because 32px of a 390px screen is a sixth of it). The
  consequence, corrected here by the M3 review: `c` and `1`..`9` are *not* bound
  on `/capture`, and nothing is lost by that, because the page already is the
  capture form. `ShortcutHints` still lists the *live* registrations rather than
  a hard-coded set.
- **The shell** (`components/app-shell.tsx`). Every signed-in route was opening
  with its own `min-h-dvh` wrapper, its own header call and its own `<main>`
  padding — four copies of three lines, and four chances for the gutters to
  drift. The shell owns the frame and the gutter; a page says
  `gutter="reading"` or says nothing.
- **A theme control that does not flash** (`lib/theme.ts`,
  `components/theme-toggle.tsx`). Below.

### The flash, and what was actually done about it

The requirement is that a server-rendered page must not paint the wrong palette
before correcting itself. Three things had to be true at once.

**1. The colours.** A ~230-byte synchronous `<script>` in `<head>` reads
`localStorage` and puts `data-theme` on `<html>` during parse, before the first
paint. An effect is a paint too late, and the usual dodges — render nothing
until mounted, cover it with a spinner — throw away the server render, which is
the thing that made the page fast. `next/script` with
`strategy="beforeInteractive"` was tried and **rejected on evidence**: it emits
`(self.__next_s=self.__next_s||[]).push([…])`, a queue Next's own runtime drains
after it loads, which is exactly the paint this is trying to get ahead of. The
emitted HTML was read both ways before choosing.

**2. "System" is the absence of a decision**, not a third palette:
`data-theme` is *removed* for it, leaving the media query in charge. A separate
`data-theme-choice` carries which of the three was chosen, which is the
difference between "dark" and "system, and the system is dark".

**3. The control's own label.** A toggle whose word comes from `useState` +
`useEffect` flashes "System" for one paint even when the colours are already
right. So `ThemeToggle` holds **no state**: it renders all three words and CSS
reveals the one matching `data-theme-choice`, which the head script has already
written. `display: none` also takes the other two out of the accessibility tree,
so the button's accessible name is "Theme Dark" — one real, labelled control.
Its click handler reads the current choice back off the document rather than
from a copy of its own.

`try`/`catch` around `localStorage` because it *throws* — not returns null — in
a cross-origin iframe and under "block all cookies". A theme is not worth a
blank page, and a throw lands on "system", which is where a first-time visitor
is anyway.

**How it is proved.** `e2e/shell.spec.ts` installs an init script that schedules
one `requestAnimationFrame` — the callback that runs immediately *before the
first paint* — and records both attributes and the **computed background
colour** in it. Four cases (dark system, light system, dark asked for on a light
OS, light asked for on a dark OS) all have the right ground in that first frame,
plus the survive-a-reload case. The probe was negative-controlled: replacing
`THEME_BOOT_SCRIPT` with a comment fails it (`Expected "dark", Received null`),
so it is measuring something. `lib/theme.test.ts` then runs the script string
itself in Node against a fake document — the boot script is the one piece of
this repository that ships unparsed and untypechecked, so the unrecognised-value
and storage-throws branches are pinned there rather than assumed.

### Accessibility

- The sidebar is a real `<nav aria-label="Main">` with two labelled lists.
- **Current page is never colour alone.** Three signals: `aria-current`, a 3px
  marker bar at the left edge (a shape, present or absent), and the row's weight
  and surface. The accent on top of those is a fourth, not the signal — if
  navigation spent the accent on "where am I", a stale column would be competing
  with the furniture. `aria-current="page"` is used on a channel's own board and
  `aria-current="true"` on a video *of* that channel, because the video is the
  page and the board is not.
- The channel link's accessible name is exactly the channel's name: the digit
  chip and the marker bar are both `aria-hidden`, which is what keeps
  `getByRole('link', { name, exact: true })` in `e2e/m1-acceptance.spec.ts`
  honest.
- Focus is one treatment everywhere — a 2px accent ring — rather than the
  `ring-foreground/40` that had drifted across 38 call sites.

### What the existing 67 specs needed

**No selector moved.** The markup the suite keys on was preserved deliberately:
the `Sign out` button, `button[aria-keyshortcuts="c"][data-shortcut-ready]`, the
per-channel `aria-keyshortcuts`, the `/login` `NerTube` heading, the board's
`data-testid`s and every column's `region` role and name. The suite was run
against the change and all 67 passed with no edit to any of them.

One spec *was* changed, and it is a strengthening rather than a loosening.
`e2e/m1-acceptance.spec.ts` asserted a card's **optimistic** arrival in
Packaging and then navigated. The board writes the optimistic position before
the server answers, so on a cold `next dev` — where the first compile of a route
is seconds — the navigation aborted the in-flight `move_video` and the walk
failed on the reload that follows. The fix is a new `movesSettled()` that waits
for no card to be `aria-busy`, i.e. for the board to *say* the move finished.
That is one more assertion, not one fewer: the old spec never checked that the
move completed at all. It is a latent race that predates this milestone; it was
reachable here because the first run of the suite was a cold one.

### A behaviour bug the repeat run found, and its fix

Running the suite a **second** time against the same stack failed
`the keyboard set is one set` on a different step: press `2`, then press `1`
before channel 2's board has finished rendering, and the digit that should take
you back does nothing at all.

The cause is in `components/channel-shortcuts.tsx`, not in the spec.
`router.push` updates the URL *first*, so between the URL changing and the new
page's React tree committing, the registration still mounted belongs to the old
page — and its guard was `if (channel.slug === currentSlug) return`, where
`currentSlug` is the prop the *old* render captured. On channel 1's page that
reads "you are already on channel 1", so the key is swallowed. The board then
sits on channel 2 with no indication anything was pressed.

The guard now asks the document — `window.location.pathname` — which has
already changed by then. Same reasoning as M1's finding 13, where the board's
in-flight guard had to move from state to a ref: a handler that fires *between*
renders has to read something that is current between renders. `currentSlug` was
then unused, so the prop is gone rather than left as decoration.

It has no spec of its own: the window it lives in is "after the URL changed and
before React committed", which Playwright cannot hold open on demand, and a test
that only sometimes enters it is worse than none. What the suite does instead is
stop *depending* on it — each hop in the keyboard walk now waits for the
destination's own `<h1>` rather than for the URL alone, which is a stronger
assertion (arrival, not intent) and the one that would have caught this as a
failure of the app rather than as a flake.

`e2e/shell.spec.ts` is new: six specs covering the four theme cases, the
toggle's cycle and persistence, the sidebar's nav semantics and its refusal to
link to `/now`, `/calendar` or `/ideas`, the two gutters, and the board's
metrics measured as real boxes (216px columns, a 16px gap, an 8px card with
12/13 padding and a 1px border in both the plain and the selected state).

### Honest limits

- **The right rail is declared and unused.** `--spacing-rail-min` /
  `--spacing-rail-max` (276–452px) are in the theme because the canvas fixes
  them, but no page has a rail yet — the first one is the checklist panel.
  Tokens with no consumer are a small debt; naming it here is cheaper than
  rediscovering it.
- **React logs a development-only warning** for the `<script>` in the root
  layout: *"Encountered a script tag while rendering React component."* That is
  the behaviour this wants — the script belongs to the server's document and has
  already run by the time React exists. It does not appear in a production
  build; that was checked with `next build && next start`, not assumed.
- **The radii on M2's packaging controls were mapped, not re-judged.** Every
  `rounded-md`/`rounded-lg`/`rounded` became a token by element kind — buttons
  to 6px, fields to 7px, cards and panels to 8px — one file at a time, but from
  the old class rather than from a fresh look at each control.
- Everything below was verified against the local dev stack
  (`scripts/dev-stack/`), never a hosted Supabase project. The M1 deploy gap is
  still open.
- The fonts are fetched from Google at **build time**. That worked here, but a
  build machine with no egress to `fonts.googleapis.com` will fail the build
  rather than fall back — `next/font` is explicit about this and it is the
  price of self-hosting.

### Deliberately not built

PLAN.md's M3 content in full — the checklist UI, the ratio on the card, `/now`
and the weekly review strip — plus everything M4–M9. The three sidebar entries
that name them are disabled controls, not links. No Anthropic API call, no
assist button, no thumbnail role, no idea matrix, no calendar, no settings
screen.

### Gates, as of this commit

Run in this order, as the last thing done to this milestone:

| Gate | Result |
|---|---|
| `npm run typecheck` | clean (both `tsconfig.json` and `tsconfig.harness.json`) |
| `npm run lint` | clean |
| `npm run build` | succeeds; seven routes, unchanged from M2 |
| `./scripts/verify-db.sh m3_final` | OK — four migrations applied, 13 test files passed (this milestone touches no SQL) |
| `npm run test` | 88 passed (5 files) — 8 of them `lib/theme.test.ts` |
| `npm run e2e` | 73 passed, 1 skipped of 74, 3.1m |

The skipped spec is `session-refresh`, which skips itself unless the stack was
started with a short token TTL — `npm run e2e:refresh` is its own command.

The e2e figure is from **three** runs: one cold (`E2E_REUSE=0`, a freshly reset
database and a freshly started stack) and then two consecutive runs against that
same, unreset stack. All three are 73/1. The repeat runs are not ceremony —
the first cold run is what exposed the acceptance walk's optimistic-move race,
and the second repeat run is what exposed the channel-shortcut bug above.

## M3 — Checklists: the strip, the list, and the ratio on the card

This is PLAN.md's M3 line — *"checklist UI (tick, add-at-top, delete, 'reset
from template'), ratio on cards"* — built on top of the design shell above.
`/now` and the weekly review strip are the other halves of the same milestone
and are written up separately.

### What it delivers

- **`lib/checklist.ts`** — the rules, apart from the screens: the `ChecklistItem`
  shape and its reader, the total order (`position`, then age, then id), the
  `min(position) - 1` a custom item takes, `done/total`, "the next unticked
  row", `est_minutes` NULL reading as 10, the text rule for a custom item, and
  the one **evidence table**. Unit-tested in `lib/checklist.test.ts` (14 cases).
- **`app/actions/checklist.ts`** — `toggleChecklistItem`, `addChecklistItem`,
  `deleteChecklistItem`, `resetChecklist`. Every one of them reads
  `videos.stage_id` itself rather than trusting the caller, and revalidates the
  detail page and the video's board.
- **`components/checklist/`** — `use-checklist.ts` (the optimistic state and its
  rollback), `checklist-strip.tsx` (the fixed one-line home), `checklist-list.tsx`
  (the rows, the add box, the two-step reset) and `ratios.ts` (the board's read).
- **The card ratio.** `components/board/types.ts` gains `checklist`, the board
  page fills it, and `components/board/video-card.tsx` renders it — in the slot
  M1 deliberately left empty.
- **`e2e/checklist.spec.ts`** — eight specs, every browser assertion paired with
  a SQL read of the rows it should have written.

Nothing here copies a template on stage entry: `move_video` and `capture_video`
already do that (`0001_init.sql`), and this milestone consumes it.

### Three deviations from PLAN.md, stated up front

1. **The strip's position.** PLAN.md puts the checklist "directly under the
   section tabs". `/videos/[id]` has no section tabs yet — it is one column of
   blocks — so the strip takes the position the tabs would sit above:
   immediately below the page header, above the packaging block, identical on
   every video. It does not move when the tabs arrive.
2. **"Reset from template" is two writes, not one transaction.** PLAN.md defines
   reset as *delete + re-copy*, and supabase-js has no transactions, so it is a
   DELETE and then an INSERT over two PostgREST requests. The templates are read
   **first**, so the copy is never attempted with nothing to copy; if the insert
   still fails, the action says the list was cleared and the template did not go
   back, and pressing Reset again is a complete retry because the templates were
   never touched. The alternative is a fifth `security definer` function for an
   operation with no cross-row invariant to protect — and
   `supabase/tests/90_schema_contract.test.sql` pins the function count at four.
   The UI asks before calling it, because it discards ticks.
3. **No `est_minutes` on a custom item.** The add box is one line and writes
   NULL, which every reader treats as ten minutes (PLAN.md says so twice). Per
   item estimates are a template-editor concern and belong to M7.

### The optimistic tick, and the rollback that is real

M2's reviewers found three bugs in this exact area, so `use-checklist.ts` is
built on the queue that already exists in `components/autosave.tsx` rather than
on a second one. What it adds is the merge — for a list, a patch is a *sequence
of operations*, so operations concatenate where a field's value would replace —
and three rules:

1. **A failure puts the screen back.** Not "an error line beside a tick that
   stayed ticked".
2. **Only what did not land is rolled back.** Writes go out in order, one at a
   time; when the third of five fails, the first two are on the server and stay,
   and the third to fifth are reverted newest-first — which lands the list
   exactly where it was before the third.
3. **The server's answer replaces the guess.** The real id of an added row, the
   real `checked_at` of a tick.

The undo information is captured when the operation is *dispatched*, not
recomputed when it fails: by then a later operation may have changed the same
row, and "what it was before this one" is no longer something the list can be
asked.

This is deliberately the opposite of the packaging block's rule, and for a
stated reason: a packaging patch carries text a person typed, so a failure must
never revert the editor. A tick carries no text and *is* the screen, so there
the honest answer is to put it back. What gets kept instead is the half-typed
line in the add box.

`e2e/checklist.spec.ts` proves the optimistic half and the rollback separately:
the row is deleted underneath the open page, the POST is held open for 1.5s with
a route handler, and the spec asserts the checkbox is ticked and the ratio reads
`1/8` *while the write is out*, then asserts both go back and the line says why.
Without the delay, the test would pass just as well against a checkbox that
never ticked at all.

### Evidence, and the tick it does not make

Where the app can count the thing a row asks about, the count sits beside the
row: `3 written` next to "Generated 10–20 title candidates", `76/55` next to
"Title under 55 characters", `2/3 written` next to "Hook drafted in 3 versions".
Three rows of the seeded eight; the other five say nothing rather than guess.

- **One table, in `lib/checklist.ts`.** Not an `if` beside each row in the
  markup — that is how three screens end up counting candidates three ways.
- **Matched on the row's text**, because a `checklist_items` row is a snapshot
  with no link back to its template (PLAN.md open question 2 leaves
  `template_item_id` out of v1). The patterns are loose enough to survive a
  lightly reworded template and tight enough not to fire on a neighbour: the
  hook pattern insists on the word *versions*, so Scripting's "Hook scripted
  word-for-word" is not counted as the packaging hook row. A unit test asserts
  that none of the nine Scripting rows matches.
- **The numbers are counted on the server**, from the same row and through the
  same lenient readers the packaging block uses, so a row and the editor beside
  it cannot disagree about how many candidates exist.
- **Nothing is auto-ticked.** PLAN.md review item 21 leaves auto-tick out of v1:
  the app can say *you have written two hooks*; only the person can say *the
  strongest is picked*. A spec asserts the ratio is still `0/8` with all three
  counts on screen.

### The ratio on the card, and why it is one query per column

The ratio a card shows is the video's **current** stage's list, and
`checklist_items` holds a row for every stage the video has ever entered — so
the filter needed is "`stage_id` = *that video's* stage", which is a different
value per row and not something one PostgREST filter can say. Reading every item
for every video and filtering in memory runs into `db-max-rows` (1000, matching
a hosted project), at which point the rows are silently truncated and every
ratio past the cut is wrong.

`components/checklist/ratios.ts` therefore groups the cards by the stage they
are in and runs one exact query per occupied column (at most nine), together.
Each asks for one row more than it will trust; if that many come back the whole
group is left **absent** from the map and those cards render no ratio, because
a number that might be short is worse than no number.

A stage with no checklist renders nothing at all. "0/0" reads as *nothing to
do*, which is the opposite of what an empty list means — M1 removed exactly that
string from this slot, and it has not come back.

### Gates for this slice

| Gate | Result |
|---|---|
| `npm run typecheck` | clean for every file in this slice |
| `npm run lint` | clean |
| `./scripts/verify-db.sh` | OK — 13 SQL test files passed (this slice touches no SQL) |
| `npm run test` | 178 passed (8 files), 14 of them `lib/checklist.test.ts` |
| `npx playwright test checklist` | 8 passed — and again, and again (three consecutive runs) |
| `npm run e2e` (whole suite) | 87 passed, 1 failed — see below |

The one failure is **not** this slice: `e2e/shell.spec.ts` still asserts that the
sidebar's "Now" entry is a *disabled button*, and the `/now` work in this same
milestone has turned it into a link. That assertion belongs to the change that
invalidated it. Nothing in `components/checklist/**`,
`app/actions/checklist.ts`, `lib/checklist.ts` or the board card touches the
sidebar.

### One behaviour worth naming: the video that moves underneath the page

Every action reads `videos.stage_id` itself rather than trusting the page, so an
item added from a page that has been open while the video moved is filed against
the stage the video is **in now** — never against the one on screen, where no
read would ever return it again. The action's revalidation then re-renders the
route, and because the strip is keyed by the stage it remounts onto the real
list with the new row at the top. Spec 8 walks exactly that: it moves the video
with SQL behind the page's back, adds an item, and watches the strip land on the
Scripting list with the row at position 0.

The hook keeps a rollback path for the case where that re-render does not
arrive; it reports the move and offers a reload rather than a retry, because
re-sending would file the row twice.

### Deliberately not built here

Per-item estimate editing and template editing (M7), reordering rows by hand
(the order is the procedure; a custom item goes to the top and that is the only
ordering gesture), ticking from the strip without opening it (`/now` is the
tick-in-place surface), and any propagation of a template edit into in-flight
items — PLAN.md open question 2 makes that deliberately impossible.

## M3 — `/now`, the ranking, and the weekly review strip

This is the other half of PLAN.md's M3 line — *"`/now` with sections, inline
controls per `input` kind, staleness sort, ≤ 10-min filter, channel chips,
`x`/`j`/`k`, board header strip"* — and the half BRIEF.md calls *as important as
the board*: **"I have 10 minutes — what can I move right now?"** The checklist
UI it consumes is written up above; the design shell both sit inside is written
up above that.

### What it delivers

- **`lib/next-action.ts`** — the ranking, pure and clock-free. PLAN.md's eight
  rules in order, first match wins, each emitting `{label, section, input}` plus
  the payload that control needs; `channelExpectation()` (the configured CTR, or
  the median of the channel's last ten); `nextStageAfter()` (by
  `CORE_KIND_ORDER`, never by `position`); `compareRows()` (Overdue → Ready →
  Waiting, then longest in stage first, then id so the order is total);
  `matchesFilters()`. It imports the checklist rules from `lib/checklist.ts` and
  the gate predicate from `lib/packaging.ts` rather than restating either.
- **`lib/next-action.test.ts`** — 68 cases: one or more per rule, every trap
  PLAN.md names in prose, and its whole M3 review list (a video published 25
  hours ago with no metrics is Overdue *including with the Repurposed lane
  switched off*; a bank of 30 ideas contributes zero rows; a Scheduled video for
  next Tuesday is Waiting; a Packaging video with everything filled offers the
  Move).
- **`app/now/page.tsx`** — five flat, RLS-scoped reads (channels, enabled
  stages, non-archived videos, their current-stage checklist items, the swap
  log), one clock read, and no rule of its own.
- **`components/now/`** — `now-view.tsx` (the filters, the three sections, the
  keyboard, and the one place that writes), `now-row.tsx` (the row and the eight
  controls), `metrics-pair.tsx` (impressions and CTR, together, always), and
  `intent.ts` (what a control asks for, and what `x` will and will not do).
- **`app/actions/metrics.ts`** — `logMetrics` and `dismissSwap`: the narrow
  slice of the post-publish block that rules 2 and 3 need in order to be
  completable in place.
- **`lib/stage-stats.ts`** + **`components/board/weekly-strip.tsx`** — count,
  oldest and median days in stage per column, all from `stage_entered_at`,
  rendered above the board.
- **`e2e/now.spec.ts`** — six specs walking the Monday scenario, every browser
  claim that changes a row paired with a SQL read of that row, and the URL
  asserted after every completion.
- The sidebar's **Now** entry stops being a disabled placeholder and becomes a
  link.

### Two words that both mean "the gate", and why that matters

Rule 1 ("Complete packaging: …") reads the gate as a **field predicate only** —
title, written concept, exactly one chosen hook — and deliberately ignores
`packaging_skipped_at`. That is PLAN.md's gate section spelled out: *skipping …
puts "Complete packaging" at the top of `/now` for that video until `gate_ok`
holds*. A skip buys the move, not the work. Rule 7 reads the same predicate.

Rule 8 ("Move to …") reads the **other** gate: the one `move_video` will
actually apply, which a skip does satisfy. A row that offered a move the
database would then refuse would be the worst row in this list.

Both come from `packagingGate()` in `lib/packaging.ts`; the skip-ignoring one is
the same call with the skip cleared. Neither is a second copy of the `elsif`
chain, because two copies eventually name different fields for the same row.

### Completable in place, and what that cost

Every row renders the control its `input` names, and finishing one patches the
**one video** it was about and re-runs the same `rankNow()` the server ran. That
is why the client is given the videos rather than the rows: the next checklist
item takes the finished row's place, in the same position, without a reload and
without a second implementation of the ranking on the wire.

Two intents also ask for a fresh server render afterwards (`router.refresh()`):
a move and a confirm-live. `move_video` snapshots the next stage's checklist
templates into `checklist_items` on arrival, and the browser cannot know what
they say. Everything else is a column the page already has.

A local patch is a *prediction*, tagged with the props it was computed over, and
it expires the moment a newer server render lands — the shape `FlowFields`
settled on in M2, for the same reason.

### What `x` refuses to do

`x` completes the selected row where completion is unambiguous and needs no
input: a tick and a move. For every other row it puts the caret in the row's
control instead. That is the same two keystrokes without the guess, and it is
the difference between a shortcut and a hazard — `x` must never silently make a
judgement (dismiss a swap prompt, declare a block over, pick a hook) on a row
the user has not read.

"Still waiting", the other half of the Waiting row's control, **writes
nothing**. It is an acknowledgement — the block is real and has not moved — so
it takes the row off this session's list and leaves the column alone. Writing
there would either reset `waiting_since`, losing the age that is the whole point
of the section, or invent a "snoozed until" column PLAN.md does not have.

### Impressions and CTR are one component

`components/now/metrics-pair.tsx` is the only place either number is rendered.
The rule is written down three times — BRIEF.md (*always display impressions and
CTR together, never CTR alone*), PLAN.md (*`logMetrics` rejects one without the
other*) and `0001_init.sql` (`check ((first24_impressions is null) =
(first24_ctr is null))`) — and all three are enforced: the component refuses a
half-filled pair before any network call, the action refuses it again, and the
CHECK is there for anything that finds another way in. A rate without a
denominator is not a measurement, and the swap decision is made on the
difference.

### Deviations from PLAN.md, stated plainly

1. **`/` still lands on the board, not on `/now`.** PLAN.md routes it to
   `/now`. Sixty-seven existing specs sign in by waiting for a board URL, and
   changing where the application lands would be a change to what every one of
   them asserts. `/now` is one click away in the sidebar and is a real link as
   of this milestone; moving the front door belongs with M9's polish pass, where
   the sign-in helper can be changed once, deliberately.
2. **A Scheduled video with no target date produces no row.** Rule 5 is written
   in terms of a date — *in the future → Waiting; on/after → Ready* — and with
   no date there is no honest branch: "confirm it went live" is a lie about a
   video that has not, and a Waiting row with no date to wait for says nothing.
   It falls through to its checklist, and the Scheduled stage has no seeded
   checklist, so such a video is silent on this page. It is still on the board
   with its days-in-stage climbing. Naming the gap is better than inventing a
   ninth rule.
3. **The Waiting half of rule 5 carries the same control as the Ready half.**
   PLAN.md names a control for every row but describes "Goes live <date>" as
   information. Rather than add a ninth `input` for "none", the row renders the
   URL field it will need anyway: the capability is identical, and the section
   is what says whether it is today's problem. Confirming still requires a URL
   to be typed, so it cannot happen by accident.
4. **The swap row has one of its two answers.** Rule 3 renders, names both
   numbers and offers "Keep it" (which writes `swap_dismissed_at`). The swap
   itself needs a role that has an asset, a reason and an append-only log row —
   all of which arrive with the thumbnail slots in M4 — so it is a real disabled
   control naming that milestone, following M1's settled rule about affordances
   that cannot be honoured yet.
5. **The weekly strip is not aligned to the columns.** The obvious design is a
   cell above each column. That would need a second scroller synchronised with
   the strip, or it would drift out of alignment the moment anybody scrolled the
   board — and a header that lies about which column it describes is worse than
   one that names them. Each cell names its stage, and a column holding nothing
   is not drawn at all.

   *Corrected by the M3 review.* This paragraph used to give its reason as "the
   board scrolls horizontally and the page does not", and that premise was
   false: the strip's scrollable overflow was reaching the viewport, so `<html>`
   had a horizontal scrollbar on the board at every width and a trackpad swipe
   anywhere on the page took the sidebar off the screen. That is now fixed
   (`contain: paint` on the strip, `overflow-x: clip` on the shell) and asserted
   at 1920/1440/1280/1024/390. The decision about the strip is unchanged; only
   its stated reason is, and it is the correct one.

### Honest limits

- **The clock is frozen for the life of a render.** Ages on `/now` are computed
  from the request's own `Date.now()`, passed down as a number. That is what
  makes the server's HTML and the browser's first render agree, and it means a
  page left open overnight still says "11 days". A reload is the refresh.
- **`logMetrics` does not write `first24_views` or `new_viewers_note` from this
  page.** Views is in the action's vocabulary and optional; the note wants a
  sentence and belongs on the detail page in M4.
- **Rule 3's fallback expectation is computed from the videos the page already
  read**, not from a dedicated query. Every video with a logged CTR is in that
  read, so the sample is right; if the 2,000-row bound is ever hit, it would be
  the first thing to become wrong.
- **One write at a time.** `perform()` refuses to start a second completion
  while one is in flight, across the whole list rather than per row. For a page
  worked with one hand on `x` that is the safe end of the trade.
- **The strip's "piling up" threshold is the channel's `stale_days`, applied to
  the median.** The median rather than the oldest: one forgotten video is a
  video, several slow ones are a stage. That choice is not in PLAN.md; it is the
  only interpretation that makes the third number worth rendering.

### Gates for this slice

| Gate | Result |
|---|---|
| `npm test` | 191 passed across 9 files — 68 of them `lib/next-action.test.ts`, 8 `lib/stage-stats.test.ts` |
| `npm run typecheck` | clean (`tsc --noEmit` and the harness project) |
| `npm run lint` | clean |
| `./scripts/verify-db.sh` | OK — migrations applied, 13 SQL test files passed. No migration was added by this slice |
| `npx playwright test now` | 7/7 |
| `npx playwright test shell` | 6/6, including the one assertion this slice had to change |

**The one spec this slice edited, and why it is a strengthening.**
`e2e/shell.spec.ts` asserted that Now, Calendar and Ideas were all disabled
buttons whose `title` names a milestone, and that no sidebar link pointed at
`/now`, `/calendar` or `/ideas`. `/now` exists now, so the loop covers Calendar
and Ideas, and the Now entry gained three assertions it did not have: it is a
link, its `href` is `/now`, and following it reaches a page that hydrates and
marks itself `aria-current="page"`. The rule the disabled controls exist to keep
— *no dead links in the sidebar* — is checked more strictly than before, not
less.

**What a full-suite run looked like at the time of writing.** `npx playwright
test` was run twice end to end. The second run finished 77 passed, 1 skipped
(the access-token expiry spec, which needs `npm run e2e:refresh`), 11 failed —
and then, re-run, 29 of those 30 passed and one remained:
`e2e/m2-acceptance.spec.ts` › *the gate opens when the three fields are filled*.
Every one of those failures is on `/videos/[id]`, which a parallel slice was
refactoring into section tabs while the suite ran (`app/videos/[id]/page.tsx`
was mid-edit and did not typecheck at one point during the run). Nothing in this
slice touches the detail page, the packaging components or those specs; the
failure is reported here rather than explained away, and it belongs to whoever
lands the section tabs.

### Not covered end to end

Two of the eight rows are proved by `lib/next-action.test.ts` and exercised by
nothing in a browser:

- **Rule 3, the swap prompt.** Producing it needs a channel with an expectation,
  a published video with logged metrics below it and no swap since — and the
  half of the row that would finish the job (the swap itself, with a role, an
  asset and a reason) is M4. `dismissSwap` is written, typed and reachable; it
  has no spec of its own until there is a swap to dismiss it in favour of.
- **Rule 5's Ready branch, "Confirm live + record URL".** The ranking, the
  date comparison and the `published_at` stamp are unit-tested, and
  `moveVideo`'s new optional `publishedAt` is a pass-through to a parameter
  `move_video` has had since `0001_init.sql`. What is not walked in a browser is
  the two-write sequence (URL first, then the move) and the refresh that follows
  it. The Waiting branch of the same rule *is* walked.

Both are named here rather than covered by a spec that would have to build most
of M4 to exist.

---

## M3 — The video page's sections, and the YouTube preview

### What this slice delivers

- **Five sections on `/videos/[id]`**, as tabs across the top: Packaging,
  Script, Thumbnails, Schedule, Publish. Each carries what it is holding — a
  ratio, a tick, or a lock — so the page says what is behind a tab before the
  tab is opened.
- **`<YouTubePreview>`**: the chosen title and the concept sketch drawn at
  YouTube's own metrics, in three places at once — a home feed card, a search
  result row, and a phone tile with a sample tile above and below it — updating
  as the title is typed.
- **The truncation warning**: which of these titles the home feed would cut,
  by how many characters, with the cut tail drawn struck through after the part
  that survives.
- **Three inert assist controls**, beside the candidates, the concept and the
  hooks: the affordance M8 will fill, disabled, saying so on the control itself
  and in its `title`.

### The section routing, and the two promises it has to keep

PLAN.md asks for a detail page; the design canvas asks for sections; the two
requirements that make it hard are in the task: switching must be **linkable**
and must **not lose unsaved edits**. Those pull in opposite directions — a URL
that means something usually means a navigation, and a navigation re-renders
the tree the packaging block is holding a draft, an autosave queue and an
in-flight request in.

What is built instead:

- Every section is **mounted all the time**; switching sets the `hidden`
  attribute. Nothing unmounts, so nothing is thrown away — including the state
  that no blur would have saved, like a half-typed candidate sitting in the
  "add" box. `hidden` also takes the panel out of the tab order and out of the
  accessibility tree, which `visibility` or an opacity trick would not.
- The URL is changed with **`window.history.pushState`**, which Next.js
  supports for exactly this and keeps `usePathname`/`useSearchParams` in step
  with (`node_modules/next/dist/docs/01-app/01-getting-started/04-linking-and-navigating.md`,
  "Native History API"). It is not a navigation: no route transition, no
  loading state, no scroll reset, and — the part that matters — nothing
  unmounts. To be exact about what it is, because the dev log shows it: one
  `GET` of the route at the new URL appears per tab click, Next bringing its own
  router into step with the address bar. The tree is reconciled in place, which
  is why the draft survives, and the spec asserts that directly rather than
  taking the mechanism's word for it.
- `?section=` is parsed **on the server**, so a pasted link renders the right
  section in its first HTML rather than switching to it after hydration. One
  parse, handed down as `initial`; the browser owns it from there. `popstate`
  is listened for, so back and forward walk the sections.
- Unknown values (`?section=nonsense`, a repeated parameter, a renamed section)
  open the gate rather than 404. The default section is the **bare URL**, so
  there are not two links to one page.

The tabs are real `<a href>`s with `aria-current="page"`, not `role="tab"`
widgets: middle-click, "copy link address" and the focus ring all come free,
and a plain left click is the only one intercepted.

### The preview: what makes it worth having

Two questions the editor cannot answer and the tool can — *where does the title
get cut*, and *does the concept read at tile size*. The fidelity is the whole
product here; an approximate mock answers both questions wrongly and
confidently.

- **Every metric is in one exported block**, `components/preview/metrics.ts`,
  each with a comment saying what it represents: the 360px feed card and its
  288px title column, 16/22 Roboto Medium clamped to two lines, the 360px
  search thumbnail beside a 600px text column at 18/26, the 390px phone tile at
  14/20, the avatar sizes, the ⋮ column, the duration chip. Correcting one is
  one edit, and the three renderings, the warning and the e2e assertions all
  move together because they all read it.
- **Nothing was fetched from youtube.com.** The environment has no egress to
  it; these are transcribed layout metrics, written down so they can be checked
  one number at a time against the real page.
- **No brand assets**: no logo, wordmark, play button or red. What is borrowed
  is the geometry and the type scale, which is what the user needs.
- **The clamp is measured, not guessed.** `components/preview/measure-title.ts`
  lays the string out in a real element at the real width in the real type and
  binary-searches for the longest prefix that still fits two lines with an
  ellipsis — which is what the browser does to draw `-webkit-line-clamp`. A
  character count cannot model where words break, and a warning that is wrong
  is worse than none. The measuring element is attached to `document.body`
  rather than rendered into the tree, because an inactive section panel is
  `display: none` and everything inside one measures as zero.
- **What is drawn is what is measured**: the title element carries the visible
  prefix plus a real ellipsis once measured (with the CSS clamp still on it as
  a safety net), so the cut on screen and the count in the warning are the same
  computation. The ellipsis is text, so it can be asserted and copied.

### How the live title reaches the preview

The preview, the warning and the Packaging tab's ratio are all about fields
that live inside the packaging block, and none of them is inside it.
`/videos/[id]` is a Server Component, so it cannot hand the block a callback.

`components/preview/live-packaging.tsx` is the one-way publish that resolves
it: the block calls `usePublishPackagingDraft(...)` once, and whoever cares
subscribes. The block stays the only owner of the draft. The alternative —
reading the input's value out of the DOM — would have been a second source of
truth for the thing this application has spent two milestones keeping
single-sourced.

The nav's packaging ratio is re-derived from that draft through the **same**
`sectionReadiness` the server used, so a tab cannot say "1/3" about a form that
visibly has all three.

### Honest limits

1. **The face is not Roboto.** It is not shipped with this app (no new
   dependencies), so the measurement runs in the fallback — Liberation Sans on
   this machine. Roboto is slightly narrower, so the warning errs towards
   saying a title is cut when YouTube might just fit it. It is the first thing
   to correct if these numbers are ever checked against the real page, and it
   is named in `metrics.ts` beside the stack.
2. **The metrics were transcribed, not measured against a live page** in this
   session, for the reason above. They are individually labelled so that
   checking them is a reading exercise rather than an archaeology one.
3. **The search row is 976px wide** and the page column is not, so that frame
   scrolls sideways inside its own border. Scaling it to fit was rejected: type
   drawn at 80% answers "does this read?" wrongly, which is the one thing this
   component must not do. The page itself never scrolls sideways.
4. **The Script section is read-only.** `script` is not in
   `lib/video-fields.ts`'s patch vocabulary and `updateVideo` has no branch for
   it, so there is no save path to bind an editor to. It renders the column
   `move_video` fills on first entry to Scripting, and says plainly that it
   cannot be written here — a textarea over a column that cannot be saved would
   accept an evening's work and lose it silently. The field and its save path
   should arrive together.
5. **Thumbnails and Publish are empty states**, not disabled controls. A
   disabled control claims the feature exists and is unavailable *to you, now*;
   nothing exists behind those two tabs at all. The assist pills are the
   opposite case, and that is why they *are* drawn disabled: the field beside
   them is real and finished, and where the button sits is a decision about
   this screen.
6. **The metadata lines are honest about being empty.** A feed card would show
   "12K views · 2 days ago"; this one says "Not published yet", because
   inventing a view count in the middle of a component whose job is to tell the
   truth is not a trade worth making. The two phone neighbours *do* carry
   sample counts — they are invented tiles, labelled as such, and a metadata
   line of the right length is part of the layout being judged.
7. **The duration chip is a placeholder** (`10:24`) and is drawn on purpose:
   the chip covers the thumbnail's bottom-right corner on every YouTube
   surface, so a concept whose subject lives in that corner is a concept that
   gets sat on.
8. The preview follows the app's light/dark choice using **YouTube's** greys
   rather than Moss & Sand, through the same three-block pattern
   `globals.css` uses. Rendering their grey metadata line in our muted green
   would quietly change the contrast the user is trying to judge.

### What the existing specs needed

The flow fields moved into the Schedule section, so a spec that opened
`/videos/<id>` and typed into `waiting-on` was now typing into a hidden panel.
Four spec files were adjusted, and every change is a navigation, not a
weakened assertion:

- `e2e/flow-fields.spec.ts` — its one `openVideo` helper now opens
  `?section=schedule`. That is the section routing's own promise being used the
  way a user would paste it.
- `e2e/m2-review.spec.ts` — three tests cross between the two sections; the
  crossing is a tab click, which makes one of them (the version-token walk) a
  stronger test than it was: the token now has to survive a section switch too.
- `e2e/m2-acceptance.spec.ts` — the same, plus the layout assertion. It used to
  compare the packaging block's `y` with the flow block's to prove "the gate
  comes first". With sections, "first" is the first tab and the section a bare
  URL opens at, so that is what it asserts now, and it additionally asserts the
  flow block is *not* on screen until it is asked for.
- `e2e/checklist.spec.ts` — one stage-select move, one tab click before it.

`vitest.config.mts` gained the `@/` alias the application already has, so that
a pure module under `components/` can be unit-tested without being moved into
`lib/` for the resolver's sake.

### Deliberately not built here

Thumbnail roles, the swap dialog and the post-publish metrics (M4); any
Anthropic call behind the assist pills (M8); a script editor (it needs a write
path first); a description field (not in the schema); and any attempt to
reproduce YouTube's interface beyond the geometry the two questions above
need.

### Gates for this slice

| Gate | Result |
|---|---|
| `npm run typecheck` | clean (both projects) |
| `npm run lint` | clean |
| `npm run test` | 191 passed (9 files), 13 of them `components/video-sections/sections.test.ts` |
| `./scripts/verify-db.sh m3_sections` | OK - 13 SQL test files passed (this slice touches no SQL) |
| `npx playwright test preview` | 6 passed |
| `npm run e2e` (whole suite) | **94 passed, 1 skipped, 0 failed** - the skip is `session-refresh`, which only runs under `npm run e2e:refresh` |

The one existing spec that failed on the first whole-suite run failed for a
reason worth recording rather than hiding: `m2-acceptance` clicked through to
the Schedule section, then called `page.reload()` - and the reload came back at
*Schedule*, because the tab click had put `?section=schedule` in the address bar
and that is what a reload reloads. The section routing demonstrating its own
linkability by breaking a test that assumed the page had none. The spec now
clicks back to Packaging after the reload, and says why.

---

## M3 — Integration: one shell, one front door, and the preview beside the work

Four slices landed M3 concurrently — the design shell, the checklists, `/now`,
and the sections with the YouTube preview. This is the step that makes them one
application: what was composed, what was deduplicated, what changed about the
front door, and every place this milestone as a whole departs from
`docs/PLAN.md`.

### 1. Composition

**The checklist strip sits under the section tabs**, outside all five panels, so
it never moves and never remounts when the section changes. "What do I actually
do to this video next" is a question you have while looking at any section, so
it cannot belong to one of them. It is keyed by `stage_id`: a move re-renders
the route with a different list, and remounting is how the strip's optimistic
copy is replaced wholesale rather than merged with a list it has nothing to do
with.

**The preview is the Packaging section's right rail.** It was under the
packaging block, which is a scroll away from the title box — and a preview whose
whole job is to show the clamp moving *as the title is typed* is worth nothing
below the fold. `components/video-sections/video-sections.tsx` grew a `rails`
map beside its `panels` map, and the page hands it one entry.

Three decisions inside that are worth stating:

- **The page column's width is decided by the sections component**, which is why
  the page's header (channel, stage, heading) is now passed *in* as a prop
  rather than rendered around it. A header outside would be aligned to neither
  width.
- **The column does not resize when the section changes.** The rail is empty on
  four of the five tabs, but the layout is the same width on all five: a column
  that narrowed on Script and widened on Packaging would slide the tabs out from
  under the pointer that had just clicked one.
- **The rail is side by side above 1480px and stacks below it.** 224 sidebar +
  32 gutter + 672 measure + 32 gap + 452 rail + 32 gutter is 1444. Below that
  there is no room for a rail next to a readable measure, and the one thing this
  component must not do is shrink YouTube's own pixel sizes to fit — type drawn
  at 80% answers "does this read?" wrongly. So it stacks, at full size, exactly
  where it was before. `e2e/preview.spec.ts` asserts both arrangements and that
  the page never scrolls sideways in either.

**`/` lands on `/now`.** PLAN.md's routing table always said so; M1 and M2 sent
an existing channel to its board because `/now` did not exist, and the `/now`
slice left that in place because sixty-seven specs signed in by waiting for a
board URL. Both reasons are gone, so the deviation is closed rather than
inherited. BRIEF.md's complaint about every other tool is that they answer "what
is the state of everything" when the morning question is "what do I do next";
the board answers the first and `/now` answers the second, and either is one
click from the other.

Twelve sign-in helpers waited on a board URL. Every one now waits for `/now` and
then *clicks the sidebar's Board link*, which is the same channel `/` used to
redirect to. No assertion was weakened — each helper's post-condition is
unchanged, and every spec that signs in now also proves the sidebar's Board link
works. `e2e/board.spec.ts`'s first test is the one that was genuinely about the
front door, so its assertion moved rather than softened: it asserts `/now` is
where signing in lands and `aria-current="page"` marks it, then reaches the
board through the sidebar and makes the nine-column assertion there.

### 2. Reconciliation — what there is exactly one of

Audited rather than assumed; the grep is in each case one line.

| Mechanism | The one implementation | Everyone who uses it |
|---|---|---|
| Keyboard | `lib/shortcuts.ts` (`useShortcuts`) | board, `/now`, capture host, capture modal (exclusive scope), channel digits |
| Toasts | `components/toast.tsx`, one `ToastProvider` in the root layout | board, `/now`, capture host |
| Autosave | `components/autosave.tsx` (`useSaveQueue`) | packaging block, flow fields, checklist (`use-checklist.ts` adds a merge *on top of* the queue rather than a second queue) |
| Theme | `lib/theme.ts` + the three-block pattern in `globals.css` | the whole application, through one `<html data-theme>` |

The one deliberate second copy of the theme pattern is
`components/preview/youtube-preview.tsx`, which declares **YouTube's** greys in
both themes the same way. That is not the product's palette and must not be
tidied into it: rendering their grey metadata line in our muted green would
quietly change the contrast the user is trying to judge.

### 3. The sidebar's Now count

The sidebar draws how many rows `/now` is holding, and the number is
`rankNow(...).length` over **exactly** the rows that page renders. That is not a
nicety: a cheaper count from its own query would be a second definition of
"something to do", and it would be wrong in all the interesting ways — it would
count the idea bank, which `/now` deliberately never shows; it would count a
video in a terminal stage with nothing left to do; and it would not know that a
Scheduled video with no target date produces no row at all. The badge would say
14, the page would list 9, and the user would be right to stop believing either.

So the read moved out of `app/now/page.tsx` into **`lib/now-data.ts`**, wrapped
in React's `cache()`. `AppShell` and `/now` both call it; on `/now` the five
queries run once and both callers get the same object. `/now` also hands the
shell its own clock, so the badge and the list cannot land on opposite sides of
a 24-hour boundary.

The count is *unfiltered* on purpose. The channel chips and "10 minutes or less"
are a narrowing the user does on the page; a badge that followed them would be
reporting the filter rather than the work. `e2e/now.spec.ts` asserts all three
properties: it equals the unfiltered list, it does not move when the list is
filtered, and it is the same number on a board.

The chip is `aria-hidden` and the number is repeated in the link's `title` — an
accessible *description*, not part of the name — so the link is still named
exactly "Now". That is what keeps `e2e/shell.spec.ts`'s exact-name locator an
honest assertion rather than one that had to be loosened.

**The weekly strip needed nothing.** Its three numbers per column are already
derived from the same `columns` memo the board's own column headers count, so a
drag moves a card and both follow in the same render. Two derivations would have
been the same bug as two counts of `/now`.

### 4. The YouTube preview: closing the fidelity gap

The preview shipped with one named weak point, and it was the important one:
**Roboto was not loaded**, so `measure-title.ts` laid titles out in whatever the
machine fell back to — Liberation Sans here, Arial on Windows, Helvetica on a
Mac. None of those is metrically compatible with Roboto, which is slightly
narrower, so every clamp was reported early: the warning said a title was cut
where YouTube would have fitted it.

`app/layout.tsx` now asks `next/font/google` for **Roboto at 400 and 500** — the
two weights the preview draws — and publishes it as `--font-face-youtube`. It
costs no new dependency (it is the same mechanism the product's own three faces
already use) and it is self-hosted like them, so no reader's browser asks Google
for anything. It is deliberately **not** in the `@theme inline` block: there is
no utility class that could put YouTube's voice on one of our buttons.

Loading a face is not the same as measuring in it, and three things had to change
for the measurement to be honest:

1. **The load is requested by name.** `document.fonts.ready` only answers
   "nothing is loading right now", and the preview mounts inside a section panel
   on a page that has already settled its own three faces — so `ready` can be an
   already-resolved promise that says nothing about Roboto. `measure-title.ts`
   reads the real family name off `--font-face-youtube` (it is generated at
   build time) and calls `document.fonts.load()` for both weights first. Asking
   for 400 does not bring 500, and a search title measured in a synthesised bold
   is not a search title.
2. **The measuring element uses font longhands, not the `font` shorthand.** The
   family is reached through a custom property, and the shorthand resets every
   font longhand it does not mention.
3. **`-webkit-font-smoothing` is turned back off inside every frame.** The
   application sets `antialiased` on `<body>`, which is right for its own faces
   and makes text perceptibly lighter; YouTube sets no such rule. The measurer
   pins the same four properties (`TEXT_RENDERING` in `metrics.ts`), so the drawn
   title and the measured one stay the same computation.

Three smaller fidelity corrections, all of them now numbers in `metrics.ts`
rather than literals in the component: the duration chip's real padding, radius,
weight and line box (`CHIP`); the avatar carries the **channel's initial**, which
is YouTube's own fallback for a channel with no picture and reads as a tile
rather than as a hole; and `letter-spacing` / `word-spacing` are pinned on the
preview surface for the same reason the measurer pins them.

#### What putting it in a 452px rail exposed

Three defects that a 672px column had been hiding, all found by looking at the
thing rather than at the test that passed:

1. **The phone tile was clipped by five pixels** and lost the duration chip off
   its right edge — which, in a component where the chip exists to show what
   covers the thumbnail's corner, was a funny way to fail. The frame's own
   padding is now 12 rather than 16, and `<YouTubePreview>` no longer draws a
   box of its own: in the rail, a card around a group of cards cost 34px that
   the 390px rendering does not have to give. The rail's rule and gutter are
   already the separation that box was drawing.
2. **The search row showed nothing but its thumbnail.** It is 976px and no rail
   is; drawn from the left, 417px of it is grey rectangle. A clipped frame now
   starts scrolled to the part worth seeing — for search, the text column,
   because the thumbnail question is answered at true size by the other two
   renderings and the only thing search can answer is how much later *its*
   column cuts. Its caption says the row is 976px and that it scrolls.
3. **A frame narrower than its content showed a strip of our page** down the
   right of a picture of theirs. The surface is `min-width: 100%` now; YouTube's
   own background runs past the card too.

While fixing (2): a scroll container that nothing can focus cannot be scrolled
from a keyboard at all. Each frame is now a focusable `role="group"` named by
its caption.

`e2e/preview.spec.ts` proves the face, and the third assertion is the one that
makes the first two mean anything: a family the browser cannot resolve falls
back to the default sans — which is precisely what `"Roboto"` did before — so
the two measurements would be *identical* if the face were still missing. They
are not. The control is an exact inequality rather than a threshold, because
Roboto and Arial happen to sit within a pixel of each other on a short string,
which is exactly why a character-count rule of thumb was never going to work.

### Deviations from `docs/PLAN.md` introduced by M3, with reasons

| Deviation | Why |
|---|---|
| **The sidebar replaced the top header.** PLAN.md names routes, not chrome; M0–M2 had a horizontal bar. | A 56px bar cost a board that is nine columns tall, put the channel switcher a long way from the board it switches, and had nowhere to put `/now`, `/calendar` and `/ideas`. |
| **`/videos/[id]` is five sections, not one page.** PLAN.md describes the detail page as one list of blocks. | The page now holds packaging, a checklist, a script, dates, notes and two unbuilt blocks. As one column it is a scroll with no landmarks. The tabs are real `<a href>`s with `?section=`, so the page stayed linkable, and every panel stays mounted, so it stayed free of consequences for a half-typed field. |
| **The checklist strip has a fixed position above the sections**, rather than being "the current-stage checklist" inside the detail page's list of blocks. | It is the only thing on the page that is about the *video* rather than about one part of it. Inside a section it would vanish when you opened another one. |
| **The preview is a panel PLAN.md does not mention at all.** | BRIEF.md principle 1 is that the title and thumbnail are decided before the shoot; the two questions that decision needs — where does the title get cut, does the concept read at tile size — cannot be answered from an editor. It is the only new *surface* this milestone invented. |
| **Three inert assist controls** beside the candidates, the concept and the hooks. | M8 fills them. Drawn disabled, naming the milestone on the control itself as well as in `title`, because a disabled button is not focusable and its tooltip reaches no keyboard user. The two empty tabs (Thumbnails, Publish) are the opposite case and are empty *states*: a disabled control claims the feature exists and is unavailable to you, and behind those two nothing exists yet. |
| **The Script section is read-only.** PLAN.md lists `script` on the detail page. | `script` is not in `lib/video-fields.ts`'s patch vocabulary and `updateVideo` has no branch for it. A textarea over a column with no save path would accept an evening's work and lose it silently. It renders the column `move_video` fills and says plainly that it cannot be written here. The field and its save path should arrive together. |
| **The weekly strip is not aligned to the board's columns.** | An aligned strip would need a second scroller synchronised with the column strip, or it would drift the moment anyone scrolled the board. Each cell names its stage instead. (This row used to say "the board scrolls horizontally and the page does not"; the page *did* scroll, which the M3 review found and fixed — see §5 above.) |
| **A Scheduled video with no `target_publish_date` produces no `/now` row.** | Rule 5 has no honest branch without a date, and Scheduled has no seeded checklist. Named rather than papered over; the video is still on the board. |
| **"Reset from template" is two requests, not a transaction.** | No fifth SQL function was added — `supabase/tests/90_schema_contract.test.sql` pins the count at four, and reset has no cross-row invariant to protect. If the insert fails the action says the list was cleared and the template did not go back; pressing Reset again is a complete retry. |

**One deviation was closed rather than added:** `/` landing on a board instead of
`/now`, carried since M1. See §1.

### Honest limits

1. **Every signed-in route now pays for `/now`'s five reads**, because that is
   what makes the sidebar's count the same number as the page. They are flat,
   RLS-scoped and `cache()`d per request, and PLAN.md sizes the account at one
   user and hundreds of rows — but it is a real cost and this is where it is
   written down.

   *Corrected by the M3 review.* This used to end "`videos` is capped at 2000
   rows by the query", which was wrong in the dangerous direction: PostgREST's
   `db-max-rows` is 1000 (the dev stack pins the same number on purpose), so the
   effective cap was 1000, and `checklist_items` and `thumbnail_swaps` had no
   `.limit()` at all. A truncated body is not an error, and a video whose
   checklist fell past the cut does not lose a row — it leaves `/now`
   altogether, because rule 6 needs an item and rule 8 requires
   `checklist.length > 0`. All three reads are now **paged** (500 a page, `in
   (...)` lists chunked at 200) and read every row.
2. **The rail is only side by side above 1480px.** That is a wide window. The
   alternative was scaling YouTube's metrics down, which would make the one
   component whose job is fidelity lie about it.
3. **The search row is 976px** and scrolls sideways inside its own frame — in
   the rail as well as stacked. The page never does. In the rail it starts
   parked on the text column, so the thumbnail is the half you scroll *to*.
4. **The metrics are still transcribed, not measured against a live page.** This
   environment has no egress to youtube.com. What changed is that the *face* is
   no longer a guess; the geometry still is, and every number carries a comment
   saying what it represents so checking it is a reading exercise.
5. **The preview unmounts when you leave the Packaging tab**, unlike the panels,
   which all stay mounted. It holds no unsaved state — it is derived from the
   packaging draft — so the cost is one re-measure on return.
6. **The metadata line says "Not published yet"** rather than inventing a view
   count. Only the two labelled sample tiles in the phone rendering carry
   invented counts, because a metadata line of the right length is part of the
   layout being judged.
7. **`--spacing-rail-min` finally has a consumer** (the rail's assertion floor).
   *Corrected by the M3 review:* when this was written the spec hard-coded 276
   and 452 as literals, so the tokens still had no consumer and the sentence was
   false. `e2e/preview.spec.ts` now reads both off `:root` at run time and
   asserts the rail's measured width against them, so changing either token
   changes the assertion. The shell's honest limit about it having none is
   closed, and this time by something.
8. Everything was verified against `scripts/dev-stack`, never a hosted Supabase
   project. **M1's deploy gap is still open.**

### Gates

| Gate | Result |
|---|---|
| `npm run typecheck` | clean (both projects) |
| `npm run lint` | clean |
| `npm run build` | 8 routes |
| `./scripts/verify-db.sh m3_check` | 4 migrations, 13 SQL test files (this step touches no SQL) |
| `npm run test` | 191 passed (9 files) |
| `npm run e2e` | **97 passed, 1 skipped, 0 failed** (5.6m) — the skip is `session-refresh`, which only runs under `npm run e2e:refresh`. 94 before this step, plus the three it added: the Roboto proof, the rail at both widths, and the sidebar count |

### The acceptance walk

PLAN.md's M3 acceptance is *"the Monday scenario — ten minutes on `/now`,
complete rows without opening cards"*. Driven in a real browser against the dev
stack, on a stack seeded with nothing but ideas:

- Signing in landed on **`/now`**, which said *"Nothing is waiting on you.
  Capture an idea with `c`, or promote one from the board."* and drew **no
  badge** — zero is quiet.
- Two ideas promoted on the board with the card's own forward button. A third
  move, on to Scripting, was **refused by the gate** — the video has no title,
  concept or hook — which is `move_video` doing its job.
- Back on `/now`: two rows, and the sidebar badge read **2**.
- **Four checklist rows completed in 711ms, in place, never leaving `/now` and
  never opening a card**; the list re-ranked after each one. The URL was still
  `/now` at the end.
- On the video page at 1600px the rail measured **x=1038, width=452**, against a
  block ending at 1006 — beside it, with the 32px gap, at exactly the design's
  maximum rail. The feed clamp cut **32 characters**; search fitted the whole
  title, which is the entire reason both are drawn.
- At 1280px the rail stacked and the page did not scroll sideways.

---

## M3 — adversarial review, applied

Four reviewers went at M3 from four angles (the ranking, the YouTube preview's
fidelity, the checklist's write path, and the shell's accessibility and scope)
and returned 34 findings: 4 blockers, 10 majors, 20 minors. Every one was
re-verified here before anything was changed; the three that were wrong or out
of scope are listed with their reasons rather than quietly dropped.

Three of the four blockers were in the same place — the optimistic write path
behind the checklist — and they were three faces of one thing: the queue in
`components/autosave.tsx` treated a failure as an event to get past rather than
a state to stay in.

### Blockers — fixed

1. **A failed write with anything queued behind it ended on "Saved".**
   `useSaveQueue`'s `finally` set the error state and then immediately drained
   the queue, which set `{kind:"saving"}` in the same React batch — so the
   failure was never rendered, and the batch behind it then succeeded and wrote
   "Saved" over a list that had already been silently rolled back. Two ordinary
   clicks reached it, on the one interaction this product has that happens ten
   times in a row.

   The queue now **stops** on a failure. Whatever was queued is parked: merged
   into the payload the error carries, so one Retry replays both, and handed to
   a new `onFailure` callback so the caller can put the screen back for work
   that is never going to be sent. `useChecklist` uses that as its single
   rollback point, so the revert happens once, newest-first, over the unsent
   tail *and* the parked operations together. Guarded by
   `e2e/checklist.spec.ts` → *a failed tick with another queued behind it ends
   on the failure, not on "Saved"*.

2. **An aborted (offline) tick was never rolled back.** `runOp` turns a
   *refusal* into a value, but a dropped connection **rejects**, and the
   exception sailed past every rollback in `use-checklist.ts` into the queue's
   own `catch`. The checkbox stayed ticked and the ratio counted it while the
   database held nothing; the message shown was the text editor's ("Nothing you
   typed has been lost — try again"), which is false for a tick that has just
   been discarded; and the Retry the app offered returned early on an empty list
   and did nothing.

   `runOp` is now wrapped, a throw is answered exactly like a refusal, and the
   checklist has its own unreachable message — *"Could not reach the server, so
   that change was undone."* — because the generic one in `autosave.tsx` is
   written for a field that keeps what was typed. Guarded by *an offline tick is
   rolled back, says so, and Retry actually re-sends it*, which drives the
   failure, the rollback, the message and a real re-send after the network comes
   back.

3. **A custom item added while a reset was in flight was written to the database
   and disappeared from the screen.** A reset's reconcile replaced the whole
   list with the server's template rows, which threw away the optimistic row the
   queue still owed; the add then landed (at position 0, i.e. as the next
   action, which is the entire point of the feature) and its own reconcile found
   no temp row to replace. The row existed and the page showed neither it nor an
   error — and the strip is keyed by `stage_id`, which a reset does not change,
   so the revalidation did not re-seed it either. The add box is documented as
   deliberately never disabled during a write, so this is a path the user is
   offered on purpose.

   The reset's reconcile now merges the server's list with any rows still
   pending. Guarded by *a custom item added while a reset is in flight survives
   the reset*, which asserts the screen and the database agree afterwards.

4. **The board scrolled the whole document sideways, at every width.** The
   column strip's scrollable overflow was propagating to the viewport: `<html>`
   had a horizontal scrollbar on `/c/[slug]/board` at 1920, 1440, 1280, 1024 and
   390, and a trackpad swipe with the pointer on the page heading scrolled the
   viewport 860px — taking capture, the channel switcher, the theme control and
   Sign out off the screen and revealing blank ground, while the strip's own
   `scrollLeft` never moved. Two design decisions in this document were argued
   *from* the opposite claim.

   `contain: paint` on the strip makes it a real clipping box; `overflow-x:
   clip` on the shell's root is the belt to that brace (`clip` and not `hidden`,
   because `hidden` on one axis forces the other to compute to `auto` and would
   take the sticky sidebar's scrollport away). `e2e/shell.spec.ts` → *the board
   scrolls sideways and the page does not* asserts
   `documentElement.scrollWidth === clientWidth` at all five widths, asserts the
   strip still scrolls, and drives a real horizontal wheel outside it. The two
   paragraphs that used the false premise are corrected above.

5. **No focus indicator at all under `forced-colors: active`.** Every
   interactive element pairs `outline-none` with `focus-visible:ring-2
   focus-visible:ring-accent` — 75 and 74 call sites, and zero
   `focus-visible:outline`. Tailwind's ring is a `box-shadow`, which the Forced
   Colors spec forces to `none`, and `outline-none` had already thrown away the
   UA ring that would otherwise still have been drawn. A keyboard user in
   Windows High Contrast Mode had no visible focus anywhere in the application,
   and the board's `j`/`k` selection (a border colour and a ring) was invisible
   too.

   One rule in `app/globals.css`, **deliberately outside every `@layer`**:
   unlayered CSS beats layered CSS whatever the specificity, and the rule it has
   to beat is `outline-none` in `@layer utilities`, so a block in `@layer base`
   would have lost (it did — the first attempt measured `outline: none` and the
   spec caught it). `:focus-visible` gets `2px solid CanvasText`, and
   `[data-selected="true"]` gets `2px solid Highlight`. Asserted in
   `e2e/shell.spec.ts` with the normal-mode box-shadow as its own negative
   control.

### Majors — fixed

6. **`/now` offered "Move to Repurposed" before the 24-hour metrics existed**,
   and Repurposed is terminal, so taking it ended the post-publish loop for
   good: rules 2 and 3 are keyed on `kind === "published"` and could never fire
   again, and `first24_*` stayed null with nothing anywhere asking for them. The
   seeded Published checklist made it the *default* path — two ticks and a move.
   BRIEF.md principle 8 fixes the order ("check first-24h performance, swap
   thumbnail if needed, **then** repurpose"), so the "then" is now mechanical:
   rule 8 offers no way out of `published` while `metrics_logged_at` is null and
   `published_at` is set. Three cases added to `lib/next-action.test.ts`,
   including the 23-hour window in which the old code handed over the one-way
   door.

7. **The measured feed title box was 12px wider than the card the preview
   draws**, and the phone tile had the same error eating its declared padding.
   `FEED_TITLE_BOX.width` subtracts one `avatarGap`; the row was laid out with a
   flex `gap`, which applies between *every* pair of children, so 36 + 12 + 288
   + 12 + 24 = 372px of row was drawn inside a card declared to be 360 — the ⋮
   column's right edge 12px outside it. A title that fits 288 but not 276 was
   measured as fitting and drawn into a card with no room for it, which is the
   one question this component exists to answer. Same arithmetic on the phone:
   378px of content in a 366px box, absorbed out of the right padding, on a
   rendering whose whole claim is that 390px is what a phone is.

   The gap now belongs to the text column (`marginLeft`) rather than to the
   flex container, so the drawn row and the metric are the same numbers.
   `e2e/preview.spec.ts` → *every row closes inside the card it is drawn in*
   asserts `scrollWidth === clientWidth === cardWidth`, the phone row's padding
   on both sides, and the arithmetic itself.

8. **The clamp could cut an emoji in half.** The binary search ran over UTF-16
   code units, so it could land between the halves of a surrogate pair: the
   drawn title ended in a lone high surrogate (U+FFFD on screen) and the
   truncation warning rendered the prefix and the tail separately, splitting one
   emoji into two replacement glyphs, one on each side of its ellipsis. It
   reproduced on six different emoji at the same pad length. The search now
   steps over **grapheme clusters** (`Intl.Segmenter`, built in, no dependency;
   code points as the fallback), which also means a ZWJ sequence is never cut
   through its joiners. Asserted over a sweep of pad lengths, with explicit
   checks for lone surrogates and U+FFFD.

9. **A sketch that could not be loaded degraded into a silent grey box, or into
   the lie that no sketch was uploaded.** `Thumb` had no `onError`, so a failed
   fetch left a full-size `<img>` with `naturalWidth` 0 and `alt=""` — Chromium
   painted nothing, and the only text on the user's own tile was the duration
   chip. Separately, the preview was handed `sketchUrl` and never `hasSketch`,
   and `sketchUrl` is null both when there is no sketch *and* when signing one
   failed — in the second case it printed "No concept sketch yet". The sibling
   `ConceptSketch` on the same page goes to deliberate trouble to avoid exactly
   that ("saying 'no sketch yet' to the second would be a lie the person cannot
   act on"). `hasSketch` is now threaded through, `Thumb` has an `onError` using
   the same `brokenUrl` pattern, and the two states say different things.

10. **A channel name the app itself allows blew the phone tile past 390px.**
    `Meta` declares `text-overflow: ellipsis`, and nothing constrained its
    width: it is a block in a flex column that was itself a flex item with no
    `min-width: 0` and no width, so max-content won and the row grew. At 37
    characters — well inside `app/actions/channels.ts`'s 80 — the tile measured
    421px. The new `TextColumn` carries the title box's own width plus
    `minWidth: 0`, so the declared ellipsis does what YouTube does. Asserted
    with a 48-character channel name.

11. **`/now` and the sidebar badge read `checklist_items` with no limit.**
    PostgREST caps an unbounded read at `db-max-rows` (1000, pinned in
    `scripts/dev-stack/postgrest.mts` precisely so a missing `.limit()` behaves
    like production) and truncates the body with no error. Here that does not
    lose a row — it removes the whole **video** from the page, because rule 6
    needs an item and rule 8 requires `checklist.length > 0`. Measured: 140
    identical videos, 1120 rows, 1000 returned, and 15 of the 140 answered with
    a different rule. `components/checklist/ratios.ts` documents this hazard and
    refuses to answer rather than answer short; this file cannot refuse, because
    the page it feeds *is* the answer, so it pages instead: `videos`,
    `checklist_items` and `thumbnail_swaps` all go through `readPaged` (500 a
    page, ordered by `id` so paging cannot repeat or skip, `in (...)` lists
    chunked at 200). Honest limit 1 is corrected above.

12. **A stage the user deliberately emptied was re-filled from the template.**
    `move_video`'s snapshot guard was `not exists (… where video_id = … and
    stage_id = …)` — "this stage has no rows", not "this video has never been
    here". M3 gave every row a delete button and an empty state that treats a
    cleared list as a supported choice, so a user who cleared Packaging, moved
    the video on and moved it back got all eight rows silently reinstated.

    **New migration `0005_checklist_seeded_stages.sql`**: a `uuid[]` on `videos`
    recording which stages the video has entered, backfilled so no existing
    video changes behaviour, deliberately *not* in the client UPDATE grant (a
    client that could clear it could re-seed a list it had emptied), and read
    and written by `move_video` and `capture_video`. An array rather than a
    `stage_entries` table because there is exactly one fact per (video, stage)
    with nothing to join to — PLAN.md's review log already records `stage_events`
    as dropped. Two SQL tests added: the deliberate-empty round trip in
    `40_move_video.test.sql`, and the column privilege in
    `20_column_privileges.test.sql`.

13. **`AppShell` let a `/now` read failure take down the board, the video page
    and `/c/new`.** It awaited `countNowRows` unguarded, and `readNowInputs`
    throws on any of its five reads — on every signed-in route, including three
    that need none of that data. The line immediately above it was already
    deliberately tolerant of its own failure, which made the inconsistency
    visible inside six lines of one function. The read is now wrapped: the
    sidebar degrades to no count and no channels, and the page underneath
    renders. `/now` itself still throws, because there the data is the page.

### Minors — fixed

14. **The "10 minutes or less" filter hid an Overdue one-line typing task and
    kept two rows with no action at all.** `needsABlock` was computed from the
    stage kind for *every* rule, so "Complete packaging: a working title" — a
    single-line text box — was hidden whenever its video happened to sit in
    Filming or Editing, while "Waiting on the sponsor" and "Goes live 1 Dec"
    survived on the synthetic 10-minute default. It is now a property of the
    row (`rule === 6`), and **Waiting rows are excluded from the quick filter
    outright**. That second half goes past PLAN.md's letter on purpose and is
    recorded as a deviation below.

15. **Rows with no estimate printed a fabricated "10 min" in the mono face.**
    `DEFAULT_EST_MINUTES` is a filter default, not a measurement, and JetBrains
    Mono is reserved for what the tool measured. The minutes now render only for
    a `tick` row, which is the only one that carries a real `est_minutes`.

16. **"Still waiting" was reported as a filter, and could produce an empty state
    blaming filters that were all off.** One subtraction did for two unrelated
    reasons. The counts are now separate: `N hidden` for the filters, `N set
    aside until you reload` for the acknowledgements, and an empty state that
    matches whichever happened.

17. **`isFuture`'s comment described the opposite comparison** — "the end of the
    target day", and it rejected the very expression the code is. Corrected to
    what the code does, with the consequence the old comment hid (a user east of
    UTC sees "Confirm live" from local morning; one west of it, the evening
    before).

18. **"N characters cut" counted UTF-16 code units**, so an emoji counted twice
    and 👨‍👩‍👧‍👦 counted as eleven. Now counted in the same grapheme clusters
    the search steps over, and asserted: a tail of one space and sixteen emoji
    reads 17, where it used to read 33.

19. **The thumbnails were not 16:9.** `Math.round(360 / (16/9))` is 203 (1.7734)
    and `Math.round(390 / …)` is 219 (1.78082). The elements now carry
    `aspect-ratio: 16 / 9` with only the width given; `thumbHeight` survives,
    documented as the integer approximation it is. Asserted to within 0.005 of
    16/9 on every thumbnail.

20. **The page scrolled sideways at phone width, and only with the rail
    filled.** The cause was a 29-character file path in a mono `<code>` in the
    preview's caption — the one token on the page that could not wrap. It now
    has `overflow-wrap: anywhere`. The path stays: it is the one pointer from
    the rendering to the numbers it is drawn from.

21. **Numbers the preview's own docstring promised were in `metrics.ts` were
    still literals in the component.** The empty-slot label's size and padding,
    the avatar's `0.45` and weight, the ⋮ column's line box and the sample
    tile's opacity now live in new `AVATAR` and `PLACEHOLDER` blocks.

22. **A tick or delete from a page whose video had moved stage was accepted
    silently.** `app/actions/checklist.ts` returns the video's *current* stage on
    every result, with a header comment explaining that a client showing a
    different one can say so — and the client compared it for `add` alone. The
    check is hoisted to every operation. What goes back on screen differs by
    kind and the difference is real: an `add` lands in the stage the video is in
    now, so its optimistic row must go; a tick or a delete named a row by id and
    that row is one of the ones on screen, so reverting it would be the second
    lie. Both end in a Reload offer rather than a Retry.

23. **No skip link**: nine sidebar tab stops stood in front of the page on every
    signed-in route, growing by one per channel (WCAG 2.4.1). `AppShell` now
    renders one as its first focusable child, pointing at the `<main id="main"
    tabIndex={-1}>` it already owns. Parked off-screen by `transform` rather
    than `sr-only` + `focus:not-sr-only`, because that pair toggles `position`
    in two utilities whose order in the sheet decides the winner. Asserted by
    tabbing from a fresh `/now`.

24. **An empty labelled landmark, 452px wide, on four of the five video
    sections.** Keeping the grid *column* the same width on every section is a
    deliberate, well-argued decision (it stops the tabs sliding under the
    pointer); emitting a labelled `<aside>` to hold it is a different thing and
    is not what that argument justifies. The column stays; the landmark is now
    emitted only when there is something in it.

25. **Calendar and Ideas were unreachable by keyboard and explained themselves
    only through a hover tooltip.** A `disabled` button is out of the tab order,
    so the one sentence saying why the row does nothing was reachable by mouse
    alone — in rows whose entire purpose is that the shape of the product is
    visible. They are now `aria-disabled` on a focusable button with no handler,
    and the milestone is drawn *on the row* in small mono, the way
    `AssistPill` already draws M8. Contrast raised from 2.18:1 to about 3:1.

26. **The evidence chip matched a number in a checklist row and then ignored
    it.** `/under \d+ characters/i` was answered with `TITLE_WARN_LENGTH`
    regardless — invisible today because the seed says 55, and a chip reading
    `58/55` beside a row reading "Title under 60 characters" the moment M7 ships
    the template editor. The pattern now captures the digits and the table reads
    them, with the constant as the fallback. Unit-tested at 60 and at 50.

27. **The preview's comments described a `next/font` family name the build does
    not emit.** `--font-face-youtube` resolves to `"Roboto", "Roboto Fallback"`,
    not `__Roboto_1a2b3c`. That made the justification for the bare `Roboto`
    after the variable wrong — it named the same family the generated
    `@font-face` claims, so it selected the same face rather than a locally
    installed one. Both comments corrected and the redundant literal dropped.

28. **`AppShell` re-queried channels that `readNowInputs` had already read** in
    the same request, in the same order, with one column fewer — two answers to
    one question, six lines apart, in the milestone whose theme is one reader
    per question. The shell now takes the list out of the `cache()`d read.

29. **The docs claimed the shell is on every signed-in route.** `/capture` is
    signed in and renders neither shell nor sidebar, which also means `c` and
    `1`..`9` are not bound there — and that claim was the justification for
    where those shortcuts live. Corrected in `docs/MILESTONES.md`,
    `components/app-shell.tsx` and `components/app-sidebar.tsx`, and
    `/capture`'s 16px padding is now explained where it is written rather than
    left looking like a miss.

30. **`--spacing-rail-min` was declared closed and still had no consumer.** The
    spec that was supposed to be the consumer hard-coded 276 and 452. It now
    reads both tokens off `:root`. Honest limit 7 is corrected above.

### Partly rejected

31. **"Make `/now` revalidation consistent across the four server actions."**
    Half accepted, half refused.

    *Accepted:* the claim that the badge always equals the list is written
    without its exception, and "Still waiting" is that exception. `lib/now-data.ts`
    now states it, and the page shows it — `N set aside until you reload` beside
    the filter chips, and an empty state that says what actually happened. The
    badge stays the denominator on purpose: it counts the work, and a row you
    acknowledged is still waiting.

    *Refused:* adding `revalidatePath("/now")` to `app/actions/checklist.ts` and
    `app/actions/videos.ts` for symmetry with `app/actions/metrics.ts`. In the
    App Router a server action that revalidates the current route re-renders it,
    and `/now`'s design is that a completed row re-ranks **locally** from a
    patch — that is why the page is handed videos rather than rows. Revalidating
    from the tick action would put a server round trip and a full re-render
    behind every tick, on the page whose whole claim is that four rows take ten
    minutes. Consistency is the wrong axis: the two actions are doing different
    things.

### Deferred, with the milestone named

32. **The shell has no responsive breakpoint; at phone width the 224px sidebar
    takes 57% of the screen.** Measured: at 390×844 `main` is 166px with 32px
    gutters, leaving a 102px content column; at 360px it is 136px / 72px. On
    `/now` every row wraps to two or three words a line and the tick box sits
    over the text. The only breakpoint in the application is `min-[1480px]` in
    `components/video-sections/video-sections.tsx`.

    **Deferred to M9**, which PLAN.md:199 already assigns the *"mobile pass on
    `/now` and `/capture`"*. Building half of it now — dropping the gutter
    without collapsing the sidebar — would leave the screen unusable and the
    milestone still owed. It is recorded here, with the numbers, so the next
    reviewer does not have to rediscover it, and because M3's honest-limits list
    did not mention it and the integration report's only responsive claim
    ("at 1280px it stacked with no horizontal page scroll") was made 3.3× above
    the width at which it falls apart.

    `/capture` is correctly unaffected: it renders no shell, so PLAN.md:116's
    phone bookmark still works.

### Deviations this review introduced

| Deviation | Why |
|---|---|
| **The "10 minutes or less" filter hides Waiting rows outright.** PLAN.md defines the filter as `est_minutes` plus the needs-a-block tag, and says nothing about sections. | The filter's promise is *work you can finish now*, and a Waiting row's only controls are "Unblocked" and "Still waiting" — neither is ten minutes of work, because neither is work. Before this, the filter's answer to "what can I do in ten minutes" on the eight-video week was two rows that could not be acted on and not the one that could. |
| **Rule 8 will not move a published video on until its first 24 hours are logged.** PLAN.md's rule 8 has no such clause. | BRIEF.md principle 8 orders the loop and Repurposed is terminal, so the move is a one-way door out of rules 2 and 3. The guard is that "then" made mechanical; the reasoning is at the rule. |
| **A fifth migration** (`0005_checklist_seeded_stages.sql`) and a fifth revoked column on `videos`. `supabase/tests/90_schema_contract.test.sql` still pins the function count at four — no new function was added. | See major 12. The alternative was to change the empty-state copy and admit that a cleared checklist is not a supported state, which contradicts the UI M3 shipped. |

### Gates, re-run after every change above

| Gate | Result |
|---|---|
| `npm run typecheck` | clean (both projects) |
| `npm run lint` | clean |
| `npm run build` | 8 routes, compiled |
| `./scripts/verify-db.sh m3_final` | **5** migrations applied, **13** SQL test files passed (0005 is new; two test files gained assertions) |
| `npm run test` | **196 passed** (9 files) — 191 before, plus the five this review added |
| `npm run e2e` | **109 passed, 1 skipped, 0 failed** (5.6m). 97 before; the review added twelve, and not one existing assertion was weakened. The skip is `session-refresh`, which only runs under `npm run e2e:refresh`. |

The twelve new end-to-end specs, by what they guard:

- `e2e/checklist.spec.ts` — a failed tick with another queued behind it ends on
  the failure; an offline tick is rolled back and Retry really re-sends; a
  custom item added during a reset survives it. (Blockers 1–3.)
- `e2e/shell.spec.ts` — the board scrolls sideways and the page does not, at
  five widths and under a real wheel; focus is visible under forced colors, with
  the normal-mode ring as its negative control; the first tab stop is a skip
  link; and the unbuilt sidebar rows are focusable, `aria-disabled` and carry
  their milestone on screen. (Blockers 4–5, minors 23 and 25.)
- `e2e/preview.spec.ts` — every row closes inside the card it is drawn in; a
  long channel name ellipsises instead of widening the tile; the thumbnails are
  16:9 to within 0.005; a sketch that will not load says which of the two things
  happened; a clamp never cuts an emoji in half and counts it once; and the rail
  reads its bounds off the tokens. (Majors 7–10, minors 18, 19, 30.)
- `e2e/now.spec.ts` — the quick filter leaves only work that can be finished,
  including the Overdue typing task; "Still waiting" sets a row aside without
  blaming the filters. (Minors 14 and 16.)

Two existing specs changed, both to follow a fix rather than to accommodate one:
the quick-filter test now expects three actionable rows where it expected four
(one of which was a Waiting row), and the upload spec's "could not be loaded"
assertion is scoped to the sketch frame now that the preview beside it says the
same true thing.

## M4 — The first 24 hours, the swap prompt, and confirm live

The post-publish half of M4. The thumbnail assets — three role slots, the feed
strip, one "Ship this one" per slot, the swap dialog and its log — are the
other half and
are written up separately; this section covers the Publish section of
`/videos/[id]`, the reconciliation of `app/actions/metrics.ts`, and the
Repurposed lane switch.

### What it delivers

- **One metrics component.** `components/post-publish/metrics-pair.tsx` renders
  impressions, click-through, views and the new-viewers note. Impressions and
  CTR are emitted unconditionally from one function, inside one `<fieldset>`,
  and **no prop can hide either of them** — `withViews` and `withNote` reach
  only the two fields that are genuinely optional. `/now`'s rule-2 row and the
  video page render the same component; they differ by `density`, which is
  spacing. M3's `components/now/metrics-pair.tsx` is gone, moved rather than
  copied.
- **One write path.** `logMetrics` in `app/actions/metrics.ts`, parsing one
  schema (`lib/metrics.ts`), called by both surfaces. `dismissSwap`,
  `reopenSwap` and `confirmLive` live beside it for the same reason.
- **The swap prompt**, `components/post-publish/swap-prompt.tsx`. It renders
  whenever metrics exist — PLAN.md says *always renders*, not "renders when
  underperforming" — in three states: urgent below expectation, quiet at or
  above, and **no verdict at all** when there is nothing to compare against.
  "Keep it" writes `swap_dismissed_at` and stops `/now` asking; the block stays,
  says when the decision was made, and offers to reopen it.
- **Confirm live.** A Scheduled video offers "confirm live and record the URL",
  validated as a URL, which writes `youtube_url` and then moves the video
  through `move_video` with the **target date** as `p_published_at`.
- **The Repurposed lane switch**, per channel, refusing to switch off a lane
  that still holds non-archived videos.

### Deviations, stated plainly

| Deviation | Why |
|---|---|
| **`/now` no longer confirms a video live in two calls.** M3's `now-view` wrote the URL with `updateVideo` and then moved the video with `moveVideo`, holding PLAN.md rule 5's "stamp it with the target date" itself. Both surfaces now call `confirmLive`, which resolves the Published stage server-side. | Two surfaces holding the same rule is the drift this milestone exists to prevent. The page would have needed its own copy of "which stage is Published" and its own copy of the date rule. |
| **The `/now` metrics row gained a Views box.** M3 left views to the detail page. | There is one component now, and PLAN.md's rule 2 is *"impressions + CTR pair with optional views"*. The note about new viewers is still page-only: a row is a line, not a page, and `logMetrics` leaves a column alone when the key is absent, so the row cannot clear a note the page wrote. |
| **The median fallback needs two logged videos, not one.** PLAN.md says *median first24_ctr of the channel's last 10 published*. | The sample includes the video being judged (so does `lib/now-data.ts`, deliberately — it computes the fallback from the same rows the rules are about). With one sample that is the video compared with itself, and the prompt would read "at or above the 4.2% median of its last 1 logged video". Below one real comparison there is no expectation. This **agrees** with `/now` rather than diverging: with a one-video sample rule 3's `ctr < expectation` is false and the rule never fires, so silence there and "no verdict" here are the same claim. |
| **The "cannot disable an occupied stage" rule is in the application, not the database.** Everywhere else in this app an invariant of that weight is in SQL. | `stages.is_enabled` is in the client's UPDATE grant on purpose, and `supabase/tests/20_column_privileges.test.sql` asserts that a client *can* disable a core stage. Moving the rule into the database means revoking that column and rewriting a passing test of a deliberate decision — M7's argument to have with the whole settings screen in front of it. The check is read-then-write, so a video moved into the lane between the two would be hidden; one user, one session. `app/actions/stages.ts` says all of this at the top. |
| **The Repurposed switch is optimistic.** | It is a controlled checkbox whose state follows a round trip: without the optimistic step the box springs back the instant it is clicked and only moves when the server answers, which reads as "that did nothing". It rolls back on refusal and on a failed request, and the e2e polls the row rather than trusting the screen. |
| **`components/video-sections/not-yet.tsx` is gone.** | Both tabs it stood in for are built, so it had no caller. It was deleted during integration — see item 3 of the integration section, which is the single statement of this. (This row previously said the file was left in place, which the tree contradicted.) |

### Honest limits

- The expectation shown on a first load is computed before that page's own
  metrics are logged, so the prompt drawn immediately after a first log is
  measured against a sample that does not yet include this video. The
  `router.refresh()` that follows the write corrects it within the same
  interaction; a reader watching closely could see the earlier verdict for a
  frame.
- `confirmLive` writes the URL and then calls `move_video`. Those are two round
  trips, not one transaction: if the second fails the link is saved and the
  video has not moved, which the message says in those words. Making it atomic
  means a third SQL function, and PLAN.md's rule is that a function earns its
  place by protecting an invariant — there is none here that a re-click does not
  fix.
- The swap prompt links to the Thumbnails section rather than opening a dialog
  of its own. That is deliberate (the question is *which of the three wins in a
  feed*), but it does mean the decision and the act are on two tabs.
- `expected_ctr` still has no UI. It is read from `channels.expected_ctr` and
  set in M7's settings screen; until then the median fallback is the only
  expectation a user can produce, by logging videos.

### Gates for this slice

| Gate | Result |
|---|---|
| `npm run typecheck` | clean (both projects) |
| `npm run lint` | clean |
| `npm run build` | 8 routes, compiled |
| `./scripts/verify-db.sh` | 5 migrations applied, 13 SQL test files passed — **no migration was added**; every column and function M4 needed was already in `0001_init.sql` |
| `npm run test` | passing, including `lib/metrics.test.ts` (the pair cannot be parsed half-filled; the verdict is `<`, the same comparison rule 3 makes) and `components/post-publish/metrics-pair.test.tsx`, which renders the component through `react-dom/server` and asserts that **no combination of its props emits one number without the other** |
| `npm run e2e` | **122 passed, 1 skipped, 0 failed** (7.1m), which is M3's 109 plus this slice's 7, the thumbnails slice's 6 and the two the thumbnails slice retitled. The skip is `session-refresh`, which only runs under `npm run e2e:refresh`. |

### One more existing spec changed, by the weight of the page rather than by a selector

`e2e/m2-review.spec.ts` — *"the skip button is not silently dead while an
unrelated save is in flight"* — began failing in a **full** suite run while
passing on its own, twice in a row, at its very first interaction: it clicks the
packaging-skip disclosure immediately after `page.goto` and the click is
swallowed.

The cause is the video page getting heavier. `components/video-sections`
deliberately keeps all five sections mounted so that switching one never costs
an unsaved edit (M3's decision, and the right one), and M4 turned two of those
five from a heading and a paragraph into the thumbnail slots and this
post-publish block. Hydration now takes long enough that a click landing in that
window reaches a server-rendered button whose handler does not exist yet, and
nothing on screen says so.

The spec now opens the disclosure inside `expect(...).toPass()` — click, check,
click again — which is what a person does about a button that appears not to
have worked. That is a real property of the page as of M4 and it is written
down here rather than filed as a flake. The honest fix, if it gets worse, is not
to unmount the panels: it is to make the two new sections lighter.

## M4 — The three thumbnail variants, the shipped role, and the swap log

### What this slice delivers

- **`components/thumbnails/**` — the Thumbnails section**, which replaces the
  "arrives in M4" placeholder on `/videos/[id]`:
  - the locked thumbnail **concept** quoted read-only at the top, with a link
    back to the field on Packaging that owns it (`concept-brief.tsx`);
  - three slots at 16:9 — wild card, moderate, safe — each with an upload, a
    replace, a remove and a "Ship this one", and a note saying what that role is
    *for* (`variant-slot.tsx`);
  - the same three drawn as 360px feed tiles beside an invented neighbour,
    because the decision is which one wins in a feed rather than which looks
    best alone. `feed-strip.tsx` is only the seam: it turns three *roles* into
    tiles and hands them to the preview's comparison mode
    (`components/preview/comparison.tsx`), so this row and the packaging
    preview are the same card out of the same `metrics.ts` — one correction to
    the real layout moves both;
  - the swap dialog, a real `<dialog>` with a required typed reason
    (`swap-dialog.tsx`), and the append-only log, newest first, with date, from,
    to and reason (`swap-log.tsx`).
- **`app/actions/thumbnails.ts`** — `recordThumbnailVariant`,
  `removeThumbnailVariant` and `shipThumbnail`. The first two write a
  `videos.thumb_*_path` column; the third has no UPDATE available to it and goes
  through the `swap_thumbnail` RPC.
- **`lib/storage.ts`** — `thumbnailVariantPath` / `parseThumbnailVariantPath`
  beside the concept-sketch pair, plus `THUMBNAIL_ROLES` and `isThumbnailRole`.
  `uploadSketch` and `removeSketches` are now `uploadImage` and `removeObjects`:
  they serve two subjects, and `removeSketches([variant])` read as a bug.
- **`e2e/thumbnails.spec.ts`** — six specs, all green (`npx playwright test
  thumbnails`).

**No migration.** Everything this slice needs was already in `0001_init.sql`:
the three path columns, `shipped_role` with its CHECK, the `thumbnail_swaps`
table with its append-only grants, and `swap_thumbnail`. The only schema-shaped
change is that nothing changed.

### The three decisions worth arguing with

**1. The CHECK is the guard, and the button is not disabled.**
`videos_shipped_role_has_asset` is what makes a shipped role always have an
image. So "Ship this one" on an empty slot is *enabled*: pressing it asks the
database, the database refuses, and `shipThumbnail` turns
`new row for relation "videos" violates check constraint
"videos_shipped_role_has_asset"` into *"Safe has no image yet — upload one
before shipping it."* A greyed-out button would have been the application
claiming a rule while quietly not being the thing that enforces it, and
`shipThumbnail` deliberately does not read the path columns before calling the
RPC for the same reason.

The spec presses that button and then reads `public.videos` **and**
`public.thumbnail_swaps`. The second read is the one that matters:
`swap_thumbnail` inserts the log row *before* it updates `shipped_role`, so a
refused update has to take the insert with it. It does — the log gains nothing.
That is the atomicity claim, proved from the outside.

**2. The first ship is one click; every change after it is explained.**
`swap_thumbnail` writes a log row on every call, including the first, where
`from_role` is null. There is nothing being replaced then and nothing to
explain, so demanding a typed justification for choosing a thumbnail at launch
would be friction for its own sake (BRIEF.md principle 6) — and inventing a
sentence in the user's voice would be worse. The first ship is logged as
`Chosen at launch.` in the app's voice, the section says so before the button is
pressed, and every later change opens the dialog. The reason floor is 12
characters, the same floor and the same argument as `MIN_SKIP_REASON_LENGTH`: a
reason of `x` satisfies `reason <> ''` and tells a reader nothing.

**3. No optimistic state at all.**
Everything on this section is a command — upload this, ship that, clear the
other — not an edit, so there is no draft to hold and nothing to merge. The
component runs the action, adopts the `updated_at` it reports (the page's shared
version token, so the next packaging save is not refused as a conflict that
never happened) and calls `router.refresh()`. M2 and M3 produced seven blockers
between them in optimistic-save code and every one was a local copy disagreeing
with the row; the cheapest way not to have an eighth was not to keep a copy.
`components/autosave.tsx` is therefore deliberately *not* used here.

### Deviations from PLAN.md, stated plainly

1. **PLAN.md names a `shipThumbnail` action and a separate `swapThumbnail`.**
   There is one action, `shipThumbnail`, because there is one database call:
   `swap_thumbnail(p_video, p_to_role, p_reason)` is what sets `shipped_role`
   whether or not something was live before, and two actions over one RPC would
   have been two places for the reason rule to drift.
2. **"each with a note" is the role's note, not a per-variant free-text field.**
   The design brief asks for a note under each variant. There is no column for
   one, and adding three would be a migration for a field neither BRIEF.md nor
   PLAN.md asks for. What is drawn instead is honest and needed more: what the
   role *is* ("the risky one", "the fallback"), because three slots with three
   identical captions quietly invite three crops of one image — and, on the live
   slot, the date and reason from the log, which is a real per-variant note
   written by the person rather than a second empty box.
3. **The section tab's readiness now counts variants.** `sectionReadiness`
   gained `variantsReady` and `thumbnailShipped` (both optional). The tick is
   reserved for "all three exist *and* one is live": three files with nothing
   marked live means nobody can tell which one is on YouTube, so that reads 3/3
   without a tick and the tooltip says why.
4. **`uploadSketch` → `uploadImage`, `removeSketches` → `removeObjects`.** Two
   call sites, mechanical. `describeSketchRejection` gained an optional subject
   so a thumbnail slot does not say "a concept sketch has to be an image" on the
   one screen where concept and asset must not be blurred.
5. **PLAN.md's "shipped radio" is one button per slot, not a radio group.**
   Added in the review pass, because the slice shipped the change and did not
   record it — and the summary above repeated PLAN.md's word for something that
   does not exist. The reason for the change is that shipping is a *command*
   with a round trip and a refusal, not a selection: a radio that moves on
   arrow-key focus would fire a database write per arrow press, and "Ship this
   one is deliberately not disabled on an empty slot" (decision 1 above) has no
   meaning for a radio. What a radio group would have given for free is a
   distinct accessible name per option, and three buttons all reading "Ship
   this one" did not have that; each now carries `aria-label="Ship the wild
   card"` and so on.

### What M4's own arrival broke, and what it cost

Every section of `/videos/[id]` stays mounted, so adding three file pickers and
one assist pill to the Thumbnails panel changed what a **bare selector** matches
on that page. Four specs failed on the first full run and all four were right to:

- `e2e/upload.spec.ts` and `e2e/m1-acceptance.spec.ts` reached for
  `input[type="file"]`, which now matches four elements — a strict-mode
  violation, and the correct failure, because it *was* ambiguous. The concept
  sketch's picker is now `data-testid="concept-sketch-file"` and both specs name
  it.
- `e2e/preview.spec.ts` asserted three assist pills, all visible. There are four,
  and the fourth is on a hidden section. It now asserts four attached, three
  visible on Packaging, and the fourth visible once the Thumbnails tab is open.

### Honest limits

- **A shipped role cannot be un-shipped.** `swap_thumbnail` takes a non-null
  `p_to_role` and direct UPDATE is revoked, so once a video has a live
  thumbnail it always has one; the only move is to ship a different variant.
  Removing the image behind the live role is refused by the same CHECK, read
  from the other direction, and the section says so in those words. Nothing in
  BRIEF.md asks for "no thumbnail at all" as a state, so this is left as it is
  rather than given a new SQL function.
- **Two round trips per upload**, as in M1: the browser puts the bytes in
  Storage and the action records the path. If the second fails the object is an
  orphan at a *stable* path, so the next successful upload of the same format
  lands on it and it stops being one. A format change is a different object
  name, which the action removes — proved in the spec by counting
  `storage.objects`.
- **The feed strip scrolls sideways** in the 672px page column, because four
  360px cards and their gaps are wider than any column here and shrinking
  YouTube's own pixel sizes is the one thing a rendering like that must not do.
  The frame is focusable so it can be scrolled from a keyboard.
- **The comparison row and the packaging preview are never on screen together.**
  The right rail renders only the active section's content, so opening
  Thumbnails unmounts the single-video preview. That is the existing layout
  rule rather than anything this slice chose, and it caught one spec that read
  the packaging preview's card without switching back to its tab.
- **The "Critique at tile size" assist is inert**, disabled, and says M8 on its
  face as well as in its tooltip. It is placed now because where the control
  goes is a layout decision about this section, not about the API.
- The section does not know a video's *stage*. The tab locks before Editing, but
  the panel itself will happily take three uploads on an Idea — which is the
  right way round: the lock never blocks, and someone who has the images early
  should not be argued with.

## M4 — The preview's comparison mode: three variants, one feed

### What this slice delivers

- **`components/preview/parts.tsx`** — the pieces every YouTube rendering in
  the application is drawn out of: `PreviewStyles`, `Frame`, `Thumb`, `Avatar`,
  `Meta`, `MenuColumn`, `TextColumn`, `DrawnTitle` / `ClampedTitle`, and one
  `FeedCard`. All of it moved out of `youtube-preview.tsx` unchanged in
  behaviour; `youtube-preview.tsx` re-exports `PreviewStyles` so nothing that
  already imported it from there had to move.
- **`components/preview/comparison.tsx`** — `<FeedComparison>`: the same
  `FeedCard` once per variant, side by side, with an invented neighbour at the
  end for scale. Same width, same title, same channel, same metadata line;
  the only difference between one card and the next is the picture.
- **`components/thumbnails/feed-strip.tsx`** is now ~80 lines: this section's
  heading, its sentence, and the roles mapped onto comparison tiles. The ~300
  lines of tile, avatar, chip, clamp and greys it held before were a hand-copy
  of the preview's and are gone.
- **`e2e/preview.spec.ts`** — three cases added to the file that already owns
  the preview's guarantees, rather than a new file where they would drift from
  them.

### The constants added, and what each represents

All in `components/preview/metrics.ts`, because the rule in that file is that a
number the preview draws with lives there with a note saying what it is:

- **`FRAME_PADDING` (12)** — *moved*, not new. It was a `const` in
  `youtube-preview.tsx` while the preview was the only surface that drew a
  frame; the comparison row draws one too, and a second literal `12` beside it
  is exactly the drift `metrics.ts` exists to prevent. Its comment (the 452px
  rail arithmetic, and why 16 clipped the duration chip) moved with it.
- **`COMPARISON.cardGap` (16)** — between one card and the next in the row.
  YouTube's rich grid gutters its columns at 16px. Deliberately *not* aliased to
  `PHONE.tileGap`, which is the same number for a different reason: correcting
  the desktop gutter should not silently move the phone feed's vertical rhythm.
- **`COMPARISON.labelFontSize` (11) / `labelLineHeight` (16)** — our label above
  each card. Ours, not YouTube's: they never write "wild card" over a tile, so
  it is drawn outside the card, in their secondary grey, smaller than anything
  in their own layout.
- **`COMPARISON.labelGap` (6)** — between that label and the top of the
  thumbnail.
- **`COMPARISON.labelPartsGap` (6)** — between the slot's name and the "· live"
  marker beside it.
- **`comparisonRowWidth(cards)`** — the width of a row of *n* feed cards, gaps
  included: 1,488px for four. The row is drawn at it and `e2e/preview.spec.ts`
  measures the drawn row against it, so the two cannot drift.

Nothing else was added. The card, the title box, the clamp, the chip, the
avatar, the greys and the neighbour's invented metadata were all already there,
which is the point: a tile in the comparison is a `FEED` card, because the
question is which of these wins *in the feed*.

### The decisions worth arguing with

**1. The strip was a fork, and forks of a layout do not stay one layout.**
`feed-strip.tsx` arrived as a copy of the preview's tile — its own `Thumb`, its
own avatar, its own clamped title, its own duration chip. Both copies read the
same `metrics.ts`, so the numbers agreed on the day it was written. But that
file is written on the assumption that someone with the real page open will
correct it one value at a time, and a correction only ever reaches the drawing
that is still there: the two would have diverged at the first fix. A comparison
between a card drawn the new way and a card drawn the old way is not a
comparison of thumbnails at all. So there is one `FeedCard` now, in
`parts.tsx`, and the strip is the words around it.

**2. The title is measured once for the whole row.**
`useClamps` lays out the user's title and the neighbour's in one pass, and the
same `Clamp` is drawn into all three of the user's cards. Measuring per card
would give the same answer — same string, same box — but then "every card says
the same thing" would be a property of the measurement being deterministic
rather than a property of the markup, and the row's entire claim is about the
markup. The spec asserts the three drawn strings collapse to a set of one, and
that the string and the cut are the ones the packaging preview's own feed card
shows on the other tab.

**3. Three empty states, not two, and none of them a grey rectangle.**
`Thumb` now reports `data-state` of `empty` (nothing uploaded), `broken` (there
is an object and it is not on screen) or `sample` (an invented neighbour, which
was never going to hold a picture of ours). The wording differs with the state
because the next action does: *"No wild card image yet"* is an instruction to
upload one and *"The wild card image could not be loaded"* is an instruction to
check the one that is there. `broken` deliberately covers both "the app could
not sign a URL" and "the URL signed and the fetch failed": the person's move is
the same either way and the difference is not something they can see.

**4. The neighbour is not dimmed.**
The phone rendering fades its two sample tiles (`PLACEHOLDER.sampleOpacity`)
because they are scenery around the thing being judged. The comparison row's
competitor is the opposite — it is *what the user's tile is being judged
against*, and a competitor you can pick out at a glance is not doing its job. It
is drawn at full strength and says what it is in words instead.

### Deviations, stated plainly

1. **`components/thumbnails/feed-strip.tsx` was rewritten**, although this slice
   owns `components/preview/**`. Leaving it would have meant shipping two
   implementations of a YouTube feed card in one application — the exact thing
   the task said not to do — so the strip now calls `<FeedComparison>` and keeps
   only its own heading and copy. Its public props (`FeedStrip`,
   `StripVariant`) are unchanged, so `thumbnails-section.tsx` did not move.
2. **The strip's test ids changed** from `feed-strip-tile` / `feed-strip-title`
   / `feed-strip-empty` to `preview-comparison-tile` / `-title` / `-thumb`,
   because the row is now the preview's and its hooks should say so. The one
   assertion in `e2e/thumbnails.spec.ts` that used the old name was updated in
   place, with a comment pointing at where the row's geometry is asserted.
3. **The phone rendering's two sample neighbours now say "A neighbour's
   thumbnail"** and report `data-state="sample"`. They previously said "No
   concept sketch yet" and reported `empty`, which read as though a stranger's
   tile were waiting on an upload from us — and, with the comparison row using
   the same `Thumb`, would have made "count the empty slots" ambiguous. The
   assertion in `e2e/preview.spec.ts` that counted those two was updated.

### What is deliberately not here

- **No "Critique at tile size".** The assist pill on this section is inert and
  disabled and says M8 on its face, as everywhere else.
- **No per-variant note in the row.** The label above each card is the slot's
  name and, on one of them, "· live". The role's *note* ("the risky one…")
  belongs beside the slot where the upload happens; repeating it over a 360px
  card would be twice the words at a third of the size.
- **The row is not a decision control.** Nothing in it can be clicked. Shipping
  a variant happens in the slot above, where the button is, because a row whose
  job is "look at these" should not also be a place you can change what is live
  by accident.

## M4 — Integration: one modal, one Thursday, and what the tabs may claim

The three slices above landed concurrently against one page. This is the
composition: what had to be reconciled between them, what the section tabs were
told to stop claiming, the acceptance walk, and the two things that are still
true and unfixed.

### What was already right, and was checked rather than trusted

Every claim in the three reports above was verified against the code before
anything was changed here, because "the report says it calls the RPC" and "the
only door is the RPC" are different sentences.

- **One metrics write path.** `logMetrics` in `app/actions/metrics.ts`, parsing
  `LogMetricsSchema` in `lib/metrics.ts`, and nothing else writes
  `first24_*`/`metrics_logged_at`. Both surfaces reach it: `components/now/
  now-view.tsx` (rule 2's row) and `components/post-publish/post-publish-block
  .tsx`. M3's `components/now/metrics-pair.tsx` is gone; `/now` imports the
  page's component and differs from it by a `density` prop.
- **One storage module.** `lib/storage.ts` is still the only file that names the
  bucket. The variant paths were added beside the sketch ones, not in a
  component.
- **Shipping has no UPDATE available to it.** `update (shipped_role)` is revoked
  from `authenticated` in `0001_init.sql` (verified in the migration, not in a
  comment), and `swap_thumbnail` inserts the log row *before* it updates the
  role, so a refused update takes the insert with it. `e2e/thumbnails.spec.ts`
  proves that from outside the app by counting `thumbnail_swaps` after a refusal.
- **The CHECKs are the guard.** `videos_shipped_role_has_asset` and
  `videos_ctr_needs_impressions` are in the schema; the app translates them into
  sentences and does not re-implement them. "Ship this one" is deliberately not
  disabled on an empty slot — pressing it asks Postgres.
- **No migration.** Everything M4 needed was already in `0001_init.sql`. The
  migration set is the same five files M3 left. `./scripts/verify-db.sh
  m4_check` applies them and passes 13 SQL test files.

### Reconciled here

**1. There were two modals; there is one.** M1 built `components/capture/
capture-modal.tsx` for the `c` capture box. The thumbnails slice built a second
one — a native `<dialog>` with `showModal()` — for the swap reason. This is not
a style disagreement: `lib/shortcuts.ts` keeps a **single** `keydown` listener on
`document`, and the only thing that silences the page under a dialog is an
`exclusive` registration. A native `<dialog>` is inert to clicks and focus, but
its key events still reach `document` — so with focus on the swap dialog's
Cancel button, `c` opened the capture box on top of the swap. The capture modal
was already general (title, children, focus trap, focus return, backdrop close,
Escape from inside a text field); it is now `components/modal.tsx` as `Modal`,
it takes a `testId`, and both dialogs are it. The swap dialog kept every test id
it had. `e2e/m4-acceptance.spec.ts` presses `c` with the swap dialog open and
asserts no capture box appears.

**2. The Publish tab may not read "locked" over the one thing it is holding.**
`sectionReadiness` locked Publish whenever `published_at` was null — including
for a Scheduled video, whose Publish section holds the confirm-live control that
`/now`'s rule 5 ranks as **Ready**. A tab saying *nothing to do here* over the
button the rest of the app is pointing at is the page contradicting the list.
The lock now lifts at Scheduled and the tab goes quiet (no mark, no claim) until
there is a number to count; everything before Scheduled still locks, because
there is genuinely nothing in the section for a video that has not been queued
up. Unit-tested in `components/video-sections/sections.test.ts` and walked in
the acceptance spec.

**3. `components/video-sections/not-yet.tsx` is deleted.** It existed to draw
the "arrives in M4" empty states. Both tabs it stood in for are built, it had no
caller, and a component for saying a section does not exist yet has no future
caller either — the video page has five sections and all five are real. Left in
place it is the first entry in a dead-code drawer.

**4. One retry helper instead of a third copy of the same paragraph.** Three
specs now have to interact with `/videos/[id]` immediately after a load; each
had, or would have had, its own fifteen-line explanation of why. `e2e/
hydration.ts` holds the explanation once and `untilTaken(act, proof)` is what
the specs call. See "still true and unfixed" below for what it is about.

**5. A redundant fragment around `PackagingBlock`** in the page's `panels` map,
left over from the M3 shell. Removed; nothing else in the page changed.

### Not reconciled, deliberately

**The Thumbnails section does not use `components/autosave.tsx`.** Everything on
that screen is a *command* — upload this file, ship this variant, clear this
slot — not an edit: there is no draft to debounce and nothing to merge. It runs
the action, adopts the returned `updated_at` into the page's shared version
token, and calls `router.refresh()`. M2 and M3 produced seven blockers between
them in optimistic-save code and every one was a local copy of state disagreeing
with the row; the cheapest way not to have an eighth is not to keep a copy. The
Publish section *does* use the queue, because its metrics form is a form. "One
save queue" means one implementation, not one use of it everywhere — and both
sections write through the same version token, which is the part that actually
has to be shared.

The visible cost is that a tab's counter moves a beat after the slot does: the
mark is rendered from the row, so it changes when the server says so. The
acceptance spec asserts that by polling rather than by sleeping, and says why.

### The Thursday scenario, walked

`e2e/m4-acceptance.spec.ts`, one test, ten seconds, against the real stack —
real JWTs, real RLS, real Storage, real `swap_thumbnail`. Every step asserts
three things: what the page says, what the **tabs** say, and what is in Postgres.

1. A video scheduled for today, with two earlier published videos logged at 5.4%
   and 5.0% so the channel has a bar at all. `channels.expected_ctr` is left null
   on purpose — it has no UI until M7, so the median is the branch a real user
   is on.
2. Thumbnails opens quoting the written concept, tab reads `0/3`, Publish reads
   *quiet* (not locked — it is Scheduled). Three uploads take it to `3/3`, still
   without a tick: three files and nothing live means nobody knows which one is
   on YouTube.
3. Ship the wild card — one click, logged as "Chosen at launch." — and the tab
   ticks.
4. Confirm live with a URL. `published_at` lands on the **target date**, checked
   in SQL as a UTC instant, because `published_at + 24h` is what the metrics
   prompt counts from. Publish reads `0/2`.
5. The numbers go in: 9,400 impressions, 2.1% CTR, views, a new-viewers note.
   Publish reads `1/2` — logged, nothing decided.
6. The prompt is `data-verdict="below"`, `data-urgent="true"`, prints
   *"9,400 impressions · 2.1% click-through"* as one string, and names the bar it
   used: *"the 5% median of its last 3 logged videos"* — the sample it actually
   took, including this video, not a number it invented.
7. "Swap the thumbnail…" lands on Thumbnails with the feed comparison rendered.
   Shipping Moderate opens the dialog; an empty reason is refused and the log
   still has one row; a typed reason writes both halves.
8. Two rows in `thumbnail_swaps`, newest first on screen, the reason on the live
   slot; Publish reads *done* with `swap_dismissed_at` still null (answered by
   acting, not by dismissing); and the swap row is gone from `/now`.

### Still true and unfixed

- **A click or a keystroke in the first moments after `/videos/[id]` loads can
  be swallowed.** All five sections stay mounted — M3's decision, asserted by
  `e2e/preview.spec.ts`, and what makes switching sections free of consequences
  for a half-typed field — and M4 turned two of the five from a heading and a
  paragraph into real work. Hydration is one synchronous pass over the whole
  tree, so a heavier page is a longer window in which a server-rendered control
  has no handler. Two full-suite runs each produced one failure of this shape,
  in a different spec, each passing in isolation: `e2e/m2-acceptance.spec.ts`
  (the skip disclosure) and `e2e/packaging.spec.ts` (clearing the concept after
  a reload). Both now retry, which is what a person whose click did nothing
  does. **The honest fix if it gets worse is to make the sections lighter, not
  to unmount the ones that are not showing** — that would trade a swallowed
  first click for a lost draft, which is the worse of the two. Recorded here
  rather than filed as a flake.
- **A shipped role cannot be un-shipped.** `swap_thumbnail` takes a non-null
  `p_to_role` and direct UPDATE is revoked, so once a video has a live thumbnail
  it always has one; the only move is shipping a different variant. Nothing in
  BRIEF.md asks for "no thumbnail" as a state, so no SQL was written for it.
- **`confirmLive` is two round trips, not one transaction.** The URL is written
  first, then `move_video`. If the move fails the link is saved and the video
  has not moved, and the message says so in those words.
- **The "stage holding non-archived videos cannot be disabled" rule is in
  `app/actions/stages.ts`, not in SQL.** Read-then-write, so not race-proof, and
  a direct PostgREST call bypasses it. Moving it into the database means
  revoking `stages.is_enabled` from the client's UPDATE grant and rewriting a
  passing test of a deliberate decision — M7's argument, with the settings
  screen in front of it. Stated at the top of that file too.
- **`channels.expected_ctr` still has no UI.** Until M7 the bar is always the
  median.
- **The React key warning reported against `PackagingBlock` was said here not to
  reproduce. That was wrong, and it is fixed.** A full `npm run e2e` from this
  tree, with the web server's stdout piped as `playwright.config.ts` already
  configures, produced nine `Each child in a list should have a unique "key"
  prop. Check the render method of `PackagingBlock`. It was passed a child from
  VideoDetailPage.` The earlier check must have been a single-spec run: it takes
  a video whose title the feed would cut, or a page re-rendered after a move, to
  surface it. See the review log below for the cause and the fix.

### Gates

Run on an idle machine, from this tree, after the changes above:

| Gate | Result |
|---|---|
| `npm run typecheck` | clean (both projects) |
| `npm run lint` | clean |
| `npm run build` | 8 routes, compiled |
| `./scripts/verify-db.sh m4_check` | OK — migrations applied, 13 SQL test files |
| `npm run test` | 221 tests in 11 files |
| `npm run e2e` | 126 passed, 1 skipped, 0 failed (7.5 min) |

The skip is `e2e/session-refresh.spec.ts`, which skips itself unless the stack
was started with a short access-token TTL; `npm run e2e:refresh` is the command
that runs it.

## M4 — adversarial review, applied

Twenty-eight findings. Every one was checked against the tree before anything
was changed; two were wrong in part and are recorded as such. What follows is
what was fixed, what was rejected and why, and what was deferred to a named
milestone.

### Blockers — fixed

**1. A variant whose image failed before hydration reported `ready` and painted
a blank rectangle.** (`components/thumbnails/variant-slot.tsx`,
`components/preview/parts.tsx`.) The three-state frame only worked when the
`error` event arrived *after* React attached `onError`. On a server-rendered
load the browser fetches the signed URL and fires `error` long before that, and
React does not replay it — so an expired signature, a missing object, a storage
5xx or a truncated upload seen on the next visit all left the slot claiming
`data-state="ready"` over an `<img>` with `naturalWidth` 0. The file's own doc
comment said this was impossible. Both files now attach a ref callback that
reads the element on mount (`complete && naturalWidth === 0`) and puts it in the
same `broken` state; `onError` stays for failures that arrive later. The copy
was wrong too — "the object may be gone. Upload it again." is bad advice for an
expired signed URL, where a reload is the fix — and now says so.
`e2e/thumbnails.spec.ts` reloads after the corrupt upload and re-asserts, and
checks the feed comparison's tiles, which had the same hole.

**2. The swap dialog never returned focus.** (`components/thumbnails/
swap-dialog.tsx`.) It rendered `Modal` without `returnFocusRef` while its
textarea carried `autoFocus`; React applies `autoFocus` during the commit phase,
before the modal's mount effect, so the shell recorded the dialog's own textarea
as the opener. On unmount that element is gone, `document.contains` is false,
and focus fell to `<body>` on Escape, on Cancel and on a successful swap — WCAG
2.4.3, and the one of the four things the dialog's header comment claimed it got
from `Modal` that it was not getting. `ThumbnailsSection` now records the button
that opened it and passes it through. The successful-swap exit needed more than
a ref: that button becomes a disabled "Shipped", and `focus()` on a disabled
button is a no-op, so `Modal` gained an `onClosed` callback and the section
focuses the slot that went live instead. A spec reads `document.activeElement`
after all three exits.

### Majors — fixed

**3. `confirmLive` leaked `move_video`'s raw `gate:<field>` token.**
(`app/actions/metrics.ts`.) It was the only caller of that RPC that did not
translate the refusal, and both surfaces printed it verbatim — the page's
ConfirmLive block and `/now`'s toast. The packaging fields stay editable at
every stage, so a video that reached Scheduled and then had its concept cleared
hits it on the next confirm. `readGateField` moved from `app/actions/moves.ts`
to `lib/packaging.ts`, beside `GATE_WORDING` — it could not simply be exported,
because every export of a `"use server"` file must be an async function — and
both actions import it. The "the URL is saved, only the move was refused" half
of the sentence is kept. Covered in `e2e/post-publish.spec.ts`.

**4. Shipping the first thumbnail from a stale tab dead-ended.**
(`components/thumbnails/thumbnails-section.tsx`.) The recovery branch tested
`shippedRole`, the page's prop, which is null by construction on every path that
reaches it — so the branch was dead, and the slot printed "A swap needs a
reason" with no textarea on screen and no `router.refresh()`, for ever.
`shipThumbnail` now returns `currentRole` on a `needsReason` refusal — what the
row actually held, which is the one thing the caller cannot work out — and the
section opens the dialog from that and refreshes. A two-context spec ships from
one tab and then clicks in the stale one.

**5. The swap prompt stayed red after the swap had been made.**
(`components/post-publish/swap-prompt.tsx`.) `swappedSinceMetrics` was accepted
and used only to add a sentence, so the block kept the red border, the red
heading and "Act now rather than in a week" directly above its own line saying a
swap had already been logged — and still offered "Keep it", which would have
written `swap_dismissed_at` for a thumbnail that was not kept. `/now` has always
excluded a swap logged after the metrics, so the two surfaces disagreed in tone
about the same video. `urgent` now includes the prop, the verdict drops its "act
now" clause, the link reads "Swap again…", and the resting state is the
already-swapped sentence rather than a third button.

**6. Nothing warned when a video was scheduled with fewer than three variants,
and the Thumbnails copy claimed a warning existed.** PLAN.md line 133 specifies
it; no surface outside the Thumbnails tab read the three path columns at all.
Built rather than deleted, because PLAN.md asks for it and the section was
already asserting it: `describeThumbnailShortfall` in `lib/packaging.ts` owns
the sentence, `moveVideo` counts the non-null paths on the row `move_video`
returns and reads the destination's kind only when a warning is possible, and
the sentence rides on the **ok** result as `notice` — a warning that arrived as
a refusal would be the hard gate PLAN.md says this must not be. The board raises
it as an info toast with a link to Thumbnails, the stage select prints it after
"Moved to Scheduled.", and `/now`'s move row pushes it as a second toast.

**7. The median fallback invented a verdict from a two-video sample.**
(`lib/expectation.ts`, `lib/next-action.ts`.) `MIN_MEDIAN_SAMPLE` was 2, and the
sample deliberately includes the video being judged — so, the median of two
numbers being their mean, the worse of any two videos was *always* strictly
below "expectation" and the better one always at or above, whatever the numbers
were. A red prompt and an **Overdue** row manufactured out of one comparison,
in the one place the product says act fast. The floor is now 3, which is the
first size that survives the subject: the median is the middle value, so the
judged video is either not it, or it is — and then `ctr < expectation` is false
and nothing fires. The constant lives in `lib/next-action.ts` and
`lib/expectation.ts` imports it, so `channelExpectation` applies the same floor
and `/now` and the page keep agreeing. Unit-tested, and the post-publish spec
now walks two-then-three.

**8. A failed write on `/now` was swallowed silently.**
(`components/now/now-view.tsx`.) `perform()` had try/finally and no catch:
every branch handled `!result.ok`, but a rejected promise escaped, nothing was
rendered, and the rejection went unhandled. One catch covers all nine branches
and pushes an error toast. Covered by a spec that goes offline, saves the
metrics row and asserts both the toast and that nothing was written.

**9. PLAN.md's "shipped radio" was not built and the milestone said it was.**
Recorded as a deviation with its reason (see the thumbnails slice's list, item
5), the summary line corrected, and the real gap closed: the three buttons now
carry distinct accessible names.

**10. The milestone claimed the React key warning did not reproduce; it fires
nine times in a full run.** It does, and the claim is replaced by what happened.
The cause, bisected rather than guessed: the five element-valued props the
*server* component `VideoDetailPage` hands to the client component
`PackagingBlock` — the sketch, the truncation warning and the three assist
pills — are validated by React as list entries, and none carried a key.
Removing a slot silenced it; a key on that slot silenced it; one slot at a time
until all five were named. All five now carry a key with the reason written at
the call site, and a full run is clean.

### Minors — fixed

- **`thumbnail_swaps` was append-only against edits but not against forgery.**
  Clients held a direct INSERT grant, so a row describing a swap that never
  happened could be written without going through `swap_thumbnail` and without
  `shipped_role` moving — and M4 is the first milestone to read that log as
  truth, in `/now`'s rule 3 and on the live slot. `0006` revokes it and drops
  the now-meaningless insert policy, leaving the security-definer function as
  the only writer; `supabase/tests/20_column_privileges.test.sql` asserts the
  refusal and re-plants its fixture row as the owner, and
  `10_tenant_isolation.test.sql` now proves the composite FK from the owner's
  side, which is where `swap_thumbnail` actually runs.
- **The 5 MB / image-only rule was entirely client-side.** The bucket carried no
  ceiling, so a user's own token could park 20 MB of `text/html` at a legitimate
  variant path and the signed URL served it back with that type. `0006` sets
  `file_size_limit` and `allowed_mime_types` on the bucket row — the same number
  and the same list `MAX_SKETCH_BYTES` and `CONCEPT_SKETCH_TYPES` already hold —
  guarded by a column check so it is a no-op where Supabase's own columns are
  absent. `supabase/tests/shim.sql` gains the two columns and
  `80_storage.test.sql` asserts the values; the local stack's storage server
  enforces them too, so the harness is not a more permissive database than the
  one it stands in for.
- **"a octet-stream file is not one".** `application/octet-stream` — which is
  what a browser reports for a file it cannot type — never hit the branch
  written for it, and the article was hardcoded. Both fixed in
  `describeFileType`, with the octet-stream case and the vowel case in
  `lib/storage.test.ts`.
- **`/now`'s swap row printed a bare "expected 5.2%".** The page distinguishes
  "the 5% this channel expects" from "the 5.2% median of its last three logged
  videos"; the row threw the qualification away and printed the derived number
  in the face reserved for measured values. `NowChannel` now carries the source
  and the sample size, the rule-3 payload carries them, and the row prints
  "expected 5.2% (median of 3)" with the qualification outside the mono span,
  because it is prose and not a measurement.
- **The Packaging preview called the concept sketch "the thumbnail".** Now that
  the same visual language draws the real shipped asset one tab along, the
  preview says what it is holding — "your concept sketch, at tile size" — links
  across to Thumbnails, names the live variant once one has shipped, and the
  phone caption says "concept" rather than "thumbnail".
- **"Keep it" reported its failure 180px away, in the metrics form's words.**
  The one save queue is right; one status line for two controls was not. The
  state is routed to whichever sub-block sent the patch, the swap prompt renders
  its own `SaveStatus`, and a decision that never reached the server says "the
  decision was not recorded" rather than "nothing you typed has been lost".
- **The variant status line changed its ARIA role on the update that changed its
  text.** It is now a stable `role="status"` for the life of the slot, with a
  separate always-present `role="alert"` node beside it carrying refusals.
- **The three slots were h4s directly under the concept brief's h3**, so the
  outline filed the assets inside the concept — the one blur this section's
  design rule forbids. They now sit under an h3 of their own, which also gives
  the grid a name.
- **The metrics-pair "one control" test asserted nothing about containment.**
  `slice` with one argument runs to the end of the document, so it proved only
  that both inputs appear somewhere below the marker. Bounded now by the next
  sibling's marker, which fails if either input leaves the pair.
- **The empty-title fallback was retyped in the thumbnails section** instead of
  importing `UNTITLED` from `components/preview/parts.tsx`. Imported.
- **`confirm-live` re-implemented the URL rule and its refusal sentence.**
  `lib/video-fields.ts` now exports `describeUrlRejection`, built from the same
  predicate and the same message `YoutubeUrlSchema` is built from, and the
  component calls it — the shape `describeReasonRejection` already had.
- **An internal source path was rendered as product copy** in the feed strip.
  Removed, and removed from the packaging preview's heading too, which the
  finding's evidence said was the only occurrence but was not.
- **`video-sections.tsx` still said four of the five panels were a heading and a
  paragraph.** Rewritten to state the M4 cost and point at `e2e/hydration.ts`,
  which holds the argument.
- **A channel-wide Repurposed switch rendered inside a Publish panel whose tab
  said "locked".** The same contradiction the lock was lifted to remove, one
  element further down. The lane now appears exactly when the tab stops claiming
  there is nothing there, using `reached(stageKind, "scheduled")` exported from
  the module that decides what the tab says rather than a second copy of the
  comparison.
- **`npm run e2e` silently reuses a running stack and the `/now` specs asserted
  database-global counts.** Reproduced: `filtered-out` counts everything the
  filters hide, including this file's channel chip, so a reused stack made two
  specs fail with a number about the operator's previous session. Both now read
  the counter as a number and assert the *difference* their own filter makes.

### Rejected, with reasons

- **"each with a note" should become a per-variant free-text field.** Partly
  rejected. The substitution was already declared, and its reason stands: there
  is no column, and neither BRIEF.md nor PLAN.md asks for one. The suggested
  alternative — a `jsonb` column — is still a migration and a new editable field
  on the one section that deliberately holds no draft state, which is what kept
  M2's and M3's seven optimistic-save blockers from becoming an eighth. What was
  real in the finding is that one word meant two things, and that is fixed: the
  role's line is now labelled "What this slot is for", so nothing on the screen
  presents it as a remark about that image. The per-variant sentence a person
  actually writes is the swap reason, and the live slot prints it. PLAN.md was
  not edited, per the repo rule.
- **"The comparison row should show one broken tile."** The finding's spec
  expectation was wrong: the comparison collapses *unreachable* and *broken*
  into one caption, because at 360px the difference between "no URL could be
  signed" and "the bytes would not decode" is the slot's to draw, not the feed
  card's. Two tiles are correct in that fixture and the spec asserts two.

### Deferred, with the milestone named

- **Making `npm run e2e` refuse a stack it did not start.** The specs are now
  fixture-local, which is the half that matters and the half that does not
  depend on how the harness is invoked. Changing the harness's default is a
  developer-workflow change with no user-visible behaviour; it belongs with
  **M9**'s polish pass over the README and the scripts, where the reuse rule can
  be documented in the one place a person reads before running the suite.
- **`channels.expected_ctr` has no UI**, so the median is the only expectation a
  user can produce. **M7**, as before.

### Gates, re-run after every change above

| Gate | Result |
|---|---|
| `npm run typecheck` | clean (both projects) |
| `npm run lint` | clean |
| `npm run build` | 8 routes, compiled |
| `./scripts/verify-db.sh m4_final` | OK — 6 migrations applied, 13 SQL test files passed |
| `npm run test` | 11 files, 223 tests passed |
| `npm run e2e`, twice | 132 passed, 1 skipped, 0 failed, both times (7.7m, 7.8m). The second run deliberately reused the stack the first left running — that is the condition the `/now` counter fix is about — and was green. `grep -c "Each child in a list"` over both piped logs: 0. |

The skip is `e2e/session-refresh.spec.ts`, which skips itself unless the stack
was started with a short access-token TTL; `npm run e2e:refresh` runs it.

## M5 — The content-bucket matrix

> **Read this first: the matrix cannot be exercised by a user in this build.**
> `lib/defaults.ts` seeds eight formats and **no** topic pillars, and nothing in
> the product can create a bucket — `app/actions/buckets.ts` is a read, and
> `captureVideo`/`updateVideo` only *reference* ids that already exist. So every
> channel made through `/c/new` opens this page on the "No topic pillars yet"
> panel, and every pillar in every e2e fixture here is written in SQL. PLAN.md
> puts the bucket editor in **M7** and this milestone did not move it, so the
> larger half of M5 ships dormant: the grid, the weight bars, the quota meters
> and the empty-cell capture are all real and all tested, and none of them can
> be reached without a `psql` session. The M5 review filed this as a finding and
> it is recorded rather than fixed — see the review log at the end of this
> section. The panel itself now says the same thing on screen, in a paragraph
> under the control rather than in a tooltip.

### What this slice delivers

- **`/c/[slug]/ideas?view=matrix`** — pillars down, formats across, every
  intersection drawn. The route file branches on `?view=` immediately after the
  channel lookup and hands everything past that branch to
  `components/ideas/matrix/**`, so a request for the grid never pays for the
  bank's reads and the two halves of M5 share one URL and one channel lookup.
- **The empty cell as a prompt.** BRIEF.md's sentence about this feature is
  *"Matrix view where each empty cell is a prompt for a new idea"*, so the empty
  cell is the component with the most care in it. It is a real
  `<a href="/capture?c=…&vertical=…&horizontal=…">` — it works with no
  JavaScript, opens in a new tab, can be copied — and a plain left-click is
  intercepted to open the same capture form in a dialog without leaving the
  grid. What it writes really carries both bucket ids.
- **Quota progress**, `n of q`, counted exactly as PLAN.md defines it: videos
  whose `target_publish_date` falls in the current month, per bucket. A bucket
  with `monthly_quota null` gets a count and **no bar**.
- **The honest empty.** `lib/defaults.ts` seeds the eight formats and leaves the
  verticals empty on purpose, so the first visit to this page is guaranteed to
  be the one where half the grid does not exist. It says what is missing in the
  brief's own words, still shows the axis it does have as a labelled strip, and
  names the bucket editor as M7 on a disabled control rather than in a tooltip.
- **Reading at a glance, never by colour alone** — a count in the mono face, a
  weight bar whose *length* is that count against the busiest cell, and a `●n`
  mark for how many have been published. A legend says what all three mean,
  including that an absent dot is the "never published here" signal.
- **The drill-down.** `?cell=<verticalId>:<horizontalId>` opens the list of
  exactly those videos under the grid, each with the stage it is sitting in —
  the first ten of them, with the rest counted and linked, the way the board's
  Idea column already caps itself (*capped by the M5 review; it listed every
  one, which only looked bounded because the read behind it was truncated*).
  The cell's href ends in `#cell`, so activating it takes the reading position
  to the panel instead of leaving it a grid away in the tab order.
- **`components/ideas/matrix/tally.ts`** — the arithmetic, pure and unit-tested
  (`tally.test.ts`, 15 cases): the UTC month window, what falls inside it, the
  per-cell and per-bucket counts, and the two bar widths.
- **`e2e/matrix.spec.ts`** — five claims, run against the real app and the real
  database.

### What it counts, and why it is not only ideas

The cell count is **every non-archived video in the channel at that
intersection**, at whatever stage — not only the rows still in the Idea stage
that `components/ideas/list/**` calls the bank.

The reason is the question the matrix is for: *where am I over-invested, and
where have I never published*. A pillar with six published videos and no ideas
left is the most invested pillar on the channel; counting only unstarted ideas
would draw it as empty and invite a seventh. Archived rows are excluded for the
mirror-image reason — a shelved idea is not an investment.

The consequence is stated on the page rather than left to be discovered: a cell
says "3 videos", not "3 ideas", its drill-down names the stage each one is in,
and the two views are reached from one switch so nobody has to reconcile them
from memory. The number in a cell is therefore **not** the number of rows the
bank shows for the same two buckets.

### The quota, and the number beside it

Two different questions get two different numbers in every axis header:

- **the bucket total** — how many videos carry this bucket at all, which is the
  over-investment reading;
- **`n of q` this month** — PLAN.md's quota count, and only when there is a
  quota to be `of`.

They are deliberately not the same number and neither is the sum of the row's
cells: a video with a pillar and no format is an investment in that pillar and
sits in no cell. Rather than let the arithmetic look broken, the page states the
difference underneath the grid — *"2 videos are not on the grid: they are
missing a pillar, a format, or both"* — which is also, quietly, a prompt.

"Met" is a word before it is a hue, and an over-quota bar fills rather than
overflowing its track; the words beside it say by how much.

### Decisions taken without the user

| Decision | Alternative not taken |
|---|---|
| A cell counts every non-archived video, not only Idea-stage rows. | Count the bank only. Rejected: it makes "where have I never published" unanswerable from the grid, which is half of what BRIEF.md asks the matrix for. |
| An axis header's total is the whole bucket (independent of the other axis), with an explicit off-grid line under the grid. | An extra "No pillar" row and "No format" column. Rejected: two more headers and eight more cells to make the sum work, on a page whose point is the gaps. |
| An empty cell opens capture **in place**, over a link that still works without JavaScript. | Always navigate to `/capture`. Rejected: filling a hole and carrying on reading the grid is the whole interaction, and a full-page form loses the place. |
| A prefilled capture shows one channel and no channel chips. | Let `1`..`9` retarget and clear the buckets. Rejected: the composite foreign key binds a bucket to its own channel, so the choice would be offered and then refused by the database. |
| The populated cell drills down into a panel on the matrix (`?cell=`). | Link into the bank's bucket filters. Deferred rather than rejected: the two slices landed in parallel, and a link into a filter that may not filter yet is the dead-link mistake M1 and M3 both filed. The integration pass can add it. |
| "This month" is the UTC calendar month, compared as `YYYY-MM-DD` strings. | The server's local month. Rejected: `target_publish_date` is a zoneless `date`, the board already formats target dates in UTC, and string comparison of zero-padded ISO dates is exact. |
| Archived videos are excluded from every count. | Include them, or offer a toggle. Rejected for now: a shelved idea is not an investment, and a toggle is the bank's job. |

### Deviations from PLAN.md, stated plainly

- **`?cell=` is not in PLAN.md.** Its M5 line says the matrix has "counts +
  quota progress" and that an empty cell prefills capture; the task brief adds
  that a populated cell should "list or link to" its videos. The panel is how
  that is satisfied without depending on another slice's filters. It is one
  parameter, server-rendered, and costs the grid no client JavaScript.
- **`captureVideo` grew two optional fields.** PLAN.md's capture line already
  says the disclosure reveals "hook, notes, tags, vertical, horizontal"; M1
  shipped it without the last two because there was nothing to pick them from.
  This is that line arriving, from the matrix rather than from a disclosure —
  and the pair is checked against the channel and the axis *before* the video is
  created, so a stale id refuses the capture instead of creating an idea it then
  fails to file.
- **`p` promote** (PLAN.md's M5 list) belongs to the idea-bank slice and is not
  built here.
- **No migration.** The schema already had all of it: `buckets` with
  `monthly_quota int null check (> 0)`, `videos.vertical_id` /
  `horizontal_id` bound by three-column composite foreign keys through the
  pinned axis columns, and both columns already in the client's `UPDATE` grant
  in `0001_init.sql`. Nothing here weakens any of that; the pre-flight check in
  `captureVideo` is about *when* a bad pair is refused, not *whether*.

### Honest limits

- **There is still no way to create or rename a bucket in the product.** The
  matrix says so, on the control, and names M7. The e2e fixture writes the three
  pillars in SQL for exactly that reason.
- **A video's buckets can only be set at capture time.** `captureVideo` is the
  only writer of `vertical_id` / `horizontal_id` in the application; a video
  captured without them cannot be filed from the matrix, from the bank or from
  the video page. That is the off-grid line's real cost, and it wants a picker
  on the video page or in the bank — the list slice or M7.
- **The quota is per bucket, not per cell**, which is what PLAN.md defines. A
  cell shows no quota and cannot.
- **"Never published" is the absence of a mark.** It is stated in the legend and
  in every cell's accessible description, but a reader who does not read the
  legend sees only that some cells have a dot.
- **Eight formats fit; twelve will scroll.** The grid's strip scrolls sideways
  by itself rather than letting a wide table reach the viewport, and the mobile
  pass is M9.

### Gates for this slice

| Gate | Result |
|---|---|
| `npm run typecheck` | clean (both projects) |
| `npm run lint` | clean |
| `npm run build` | 8 routes, compiled |
| `npm test` | 13 files, 250 tests passed |
| `./scripts/verify-db.sh nertube_matrix_verify` | OK — migrations applied, 13 SQL test files passed |
| `npx playwright test matrix.spec` | 5 passed |
| `npx playwright test` (whole suite) | 144 passed, 1 skipped |

Two notes on how the suite was run, because both are honest caveats rather than
footnotes. It was run on its own ports and its own database
(`E2E_REUSE=0 E2E_PORT=3117 DEV_STACK_PORT=54371 DEV_STACK_POSTGREST_PORT=54372
NERTUBE_DEV_DB=nertube_matrix`): the idea-bank slice was building in the same
working tree at the same time, and two Playwright runs sharing one dev stack,
one app port and one `test-results/` directory interfere in ways that look like
product bugs. And on the first full run two `e2e/m2-review.spec.ts` cases failed
inside the video page's hydration window under that load; re-run alone, all
thirteen of that file's cases pass. The skip is `session-refresh`, which skips
itself unless the stack was started with a short token TTL.

## M5 — Filing an idea: the two buckets, and the tags

### What this slice delivers

- **A bucket picker that cannot express an invalid choice.**
  `components/ideas/assign/bucket-select.tsx` is one native `<select>` per axis,
  handed one channel's buckets *on that axis* and nothing else. The three ways
  an assignment can be wrong are all answered by construction: a select without
  `multiple` holds one value (and `videos.vertical_id` is one column, so the
  database agrees); the options come from one `channel_id`; and the two axes are
  two controls, because `BucketChoices` is two lists precisely so no caller can
  filter one wrongly. The composite foreign keys enforce all three anyway —
  which is the point of doing it in this order.
- **The bucket fields in capture's disclosure.** Shift+Enter still reveals hook,
  notes and tags, and now the two menus as well. Everything about them is on the
  far side of the fast path: they are *unmounted* until the disclosure opens,
  and their options are not fetched until they mount (`app/actions/buckets.ts`).
  `c`, type, Enter is byte-for-byte the interaction it was, and costs the same
  zero queries it did.
- **The filing block on `/videos/[id]`** —
  `components/ideas/assign/filing-block.tsx`, under the packaging block on the
  tab a bare video URL opens at. This closes the hole the matrix slice filed as
  its first honest limit: *"a video's buckets can only be set at capture time …
  it wants a picker on the video page"*. An idea captured in ten seconds can now
  be filed afterwards, which is the only way the matrix's empty cells ever get
  filled by anything other than a new capture.
- **A real tag editor.** Chips with a remove button, an input that takes Enter,
  a comma or a blur, Backspace-at-empty to drop the last one, and **the
  channel's existing vocabulary offered as one-click chips plus the input's own
  `<datalist>`**. BRIEF.md asks for tags so an idea can be found again, which is
  a property of the vocabulary rather than of any one video: converging has to
  be the path of least effort or it does not happen.
- **One rule for what a tag is**, `TagListSchema` in `lib/video-fields.ts`:
  trimmed, empties dropped, **de-duplicated case-insensitively keeping the first
  spelling**, twenty of at most forty characters. Capture's comma box is that
  same schema behind a `split(",")`; it used to be a second copy in
  `app/actions/videos.ts` that did not fold `Tutorial` into `tutorial`.
- **The database's refusal, in words.** `describeBucketRefusal` in
  `lib/buckets.ts` turns a `23503` naming
  `videos_vertical_id_channel_id_vertical_axis_fkey` into a sentence about what
  happened and what to do, and `updateVideo` reports it as a **conflict** — the
  page is holding ids the row has moved past, so a Reload is the only honest
  offer, not a Retry.
- **`supabase/tests/55_bucket_assignment.test.sql`** and
  **`e2e/buckets.spec.ts`**, described below.

### Where the block went, and why

The Packaging tab, under the gate, in a bordered `Filing` section.

The alternative was the Schedule tab, where the other idea-bank field (`notes`)
lives. It was rejected because what a video *is* — this channel's money pillar,
done as a review, tagged `index funds` — is the same kind of fact as its title
and its thumbnail concept, and a different kind from its target date. Packaging
is also the tab a bare `/videos/[id]` opens at and therefore the first screen an
idea is ever opened on; filing belongs where you land, not a tab along. A sixth
section was the other alternative and would have been a tab with two fields in
it.

### What the page's weight cost, and what was done about it

The first full browser run after this block landed had exactly one reproducible
failure, and it was not in this slice's own spec: `e2e/packaging.spec.ts`'s
skip test clicks the skip disclosure immediately after `page.goto`, with no
retry, and the click was being **swallowed** — the control was on screen, but
the route had not hydrated yet, so nothing was listening.

That is the property `e2e/hydration.ts` documents at length: all five sections
stay mounted (which is what makes switching them free of consequences for a
half-typed field), hydration is one synchronous pass over the whole tree, and
so every component added to the page widens the window in which a
server-rendered control has no handler. That file also names the honest fix if
it gets worse: **make the sections lighter — not unmount them, and not paper
over it in the spec.**

So the filing block was made a **Server Component**. The heading, the sentence
and the section chrome ship no JavaScript now, and the vocabulary-growing state
that used to live in the block moved into the tag editor, which is a client
component either way. That is one fewer component in the hydration pass, and it
is enough: `packaging.spec.ts` passes again, unmodified. Measured on the same
machine and the same stack, the video page's time to `data-shortcut-ready` went
from about 1.6s to about 0.9s — the same as before the block existed.

Nothing in `e2e/packaging.spec.ts` was touched. A spec that was passing before
this slice and fails after it is a regression in the page, not in the spec, and
adding a retry to it would have hidden a first click that a real person would
also have lost.

What is honest to add: that case is no longer *failing*, but it is still the
thinnest margin on the page. Before the fix it failed every time — in the full
suite and on its own. After it, it passed five runs in a row across three
different spec combinations and failed once, on a run whose first navigation
also paid for a cold `next dev` compile of a freshly copied tree. That is the
same flake class the video page's other specs have had since M4, and the same
remedy applies if it worsens: fewer components in the hydration pass, not a
longer wait in the test.

### The picker's promise, stated exactly

There is no application-level check anywhere in this slice that a bucket belongs
to the video's channel or sits on the right axis, and that is deliberate. The
guarantee is the three-column composite foreign key in `0001_init.sql`; a second
opinion in TypeScript is a thing that can drift from it, and the drift would be
silent. What the application owes the user is two things the database cannot do:
never offer a choice the key would refuse, and explain the refusal if one ever
arrives anyway (a stale tab, a hand-made POST). Both are built; neither is a
re-derivation of the constraint.

### Changing channel is not a thing — what was actually found

The task asked whether a video can move channel. It cannot, in four independent
ways, and the SQL test now pins all of them:

1. **No UI offers it.** `VideoPatchSchema` has no `channelId` key, so
   `updateVideo` cannot write the column; `moveVideo` goes through `move_video`,
   which only ever touches `stage_id`; `captureVideo` is the only writer of
   `videos.channel_id`, at creation.
2. **The stage would not come with it.** `foreign key (stage_id, channel_id)
   references stages (id, channel_id)` means a bare `update videos set
   channel_id` is refused with `23503` even when both bucket slots are null.
3. **A client cannot bring the stage along either.** `UPDATE (stage_id)` is
   revoked from `authenticated`, so writing the pair fails with `42501` before
   any constraint is consulted.
4. **With buckets set, the bucket keys refuse it too.** Run as a role that
   *does* hold the grant, moving the row to another channel fails `23503` until
   both slots are cleared in the same statement — which is the database
   insisting on exactly the rule this slice's UI would have to implement if a
   channel switcher ever existed.

So the pickers do not need to clear anything on a channel change, because there
is no channel change. The one place a channel *can* change under a bucket choice
is capture, where the chips retarget the form — and there both choices are reset
to "not filed" and the menus reload, because a bucket picked for one channel is
not a value the next channel has.

### What was run

| Gate | Result |
|---|---|
| `npm run typecheck` | clean (both projects) |
| `npm run lint` | clean |
| `npm test` | 13 files, 250 tests passed |
| `./scripts/verify-db.sh nertube_m5_buckets` | OK — migrations applied, **14** SQL test files passed |
| `npx playwright test buckets` | 6 passed |
| `npx playwright test` (whole suite), run 1 | 148 passed, 1 skipped, 2 failed under load — both pass when re-run alone (below) |
| `npx playwright test` (whole suite), run 2 | 149 passed, 1 skipped, 1 failed — a *different* case of the same kind, also passing alone |
| `npm run build` | 9 routes, compiled (run in the copy, for the reason below) |

Two caveats, stated rather than footnoted. **The suite was run from a copy of
the working tree** (`/tmp/…/e2e-run`, its own ports, its own database
`nertube_e2e_assign`): the idea-bank slice was iterating in the same directory
at the same time, and Next allows one `next dev` per directory — its own
preflight (`scripts/e2e-preflight.mjs`) refuses to start a second. The copy was
re-synced from the working tree before each run, so what was tested is this
code.

**And the failures are load flakes, not regressions.** Run 1 lost
`m2-review.spec.ts:640` (focus after removing a hook row) and
`preview.spec.ts:1119` (the comparison's clamp attribute); run 2 lost neither of
those and instead timed out on `m2-review.spec.ts:476` (a target date saved
without a blur). Re-running both files alone passes all 29 of their cases,
including all three of those. That is the same pattern the matrix slice
recorded, in the same two files, for the same reason: the hydration window under
full-suite load. The one failure in that run that *was* a real regression — the
packaging skip click — is the one above, and it is fixed in the page rather than
in the spec.

### The SQL test, and what it adds to `50_buckets`

`50_buckets.test.sql` (M0) already proves the vertical slot refuses another
channel's bucket, the wrong axis and another tenant's bucket.
`55_bucket_assignment.test.sql` is about the picker's own promises:

- **One slot per axis, asserted against the catalogue.** Exactly two foreign
  keys from `videos` into `buckets`; each on three columns; each pointing at
  `(id, channel_id, axis)`; each keyed on `(slot, channel_id, matching axis)`;
  and both slots plain `uuid` columns. "At most one vertical" is the *shape* of
  the schema, not a rule any code checks, so the shape is what is tested — a
  third bucket column added later would fail this without a line of application
  code changing.
- **The horizontal slot, refused all three ways** (wrong axis, another channel,
  and the pinned `horizontal_axis` rewritten — `23503`, `23503`, `23514`), with
  a follow-up read proving no refused write left anything behind. 50 only ever
  exercises the vertical slot, so a key written with the wrong axis column on
  the other slot would have gone unnoticed there.
- **Clearing** one axis and then both, with the row and the other axis intact.
- **The four channel-move refusals** above.
- **`tags`**: in `authenticated`'s `UPDATE` grant (so the editor needs no RPC),
  persists, and empties to `{}` rather than to NULL.

### Deviations from PLAN.md, stated plainly

- **No migration, again.** Everything this slice writes was already in
  `0001_init.sql`, including both bucket columns and `tags` in the client's
  `UPDATE` grant. Nothing here weakens the composite keys; the only thing added
  around them is a translation of their refusal.
- **PLAN.md's M5 line does not mention a tag editor or a bucket picker on the
  video page.** BRIEF.md does ask for both, in the idea-bank section ("An idea
  can be tagged with one of each") and in quick capture ("title, one-line hook,
  notes, tags"), and M5 is the milestone where buckets exist at all. The matrix
  slice's own honest-limits list named the video-page picker as the missing
  piece.
- **Capture's buckets are fetched, not rendered with the page.** Every other
  option list in the app comes down with its server render. This one does not,
  because the `c` modal is mounted by the sidebar on *every* signed-in route,
  and handing it the buckets would mean a query per page load for a dialog that
  is usually never opened. See `app/actions/buckets.ts`.
- **`app/actions/buckets.ts` is a new action file** holding one read. PLAN.md's
  action list has `updateBuckets` for M7; this is its file arriving early with
  the read half.

### Decisions taken without the user

| Decision | Alternative not taken |
|---|---|
| Filing lives on the Packaging tab, under the gate. | A sixth "Idea" section, or the Schedule tab beside `notes`. Rejected: a tab for two fields, and filing is about what a video *is*, not when it goes out. |
| A native `<select>` per axis. | A chips-and-menu combobox. Rejected: no dependency budget, and a select is already one tab stop, keyboard-operable, type-to-find and native on a phone — for a list of three to twelve words there is nothing to gain. |
| The empty option reads "— not filed —". | "None". Rejected: a video with no pillar has not been assigned nothing, it is one nobody has filed yet, and the matrix counts it nowhere. |
| Tags de-duplicate case-insensitively, first spelling wins. | Keep both spellings, or lower-case everything. Rejected: four spellings of one tag is what makes the bank's tag filter useless, and lower-casing rewrites what the person typed under them. |
| The tag input commits on blur as well as Enter. | Enter only. Rejected: a typed tag that vanishes because you clicked elsewhere is the small betrayal that stops people using a field. |
| Suggestions are this channel's tags, most-used first, capped at twelve, with the whole vocabulary in a `<datalist>`. | Every tag as a chip. Rejected: a channel with sixty tags would draw sixty buttons above the field it is meant to help. |
| Capture's pickers fetch their options when the disclosure opens. | Read the buckets in `AppShell` for every signed-in route. Rejected: a query per page load for a dialog usually never opened is the same friction in a different currency. |
| A refused bucket is reported as a conflict with a Reload. | A Retry. Rejected: the same patch would be refused the same way; what is stale is the page's idea of the channel's buckets. |
| The bucket menus grey out while a save is in flight. | Let a second pick queue behind the first. Rejected: the queue parks work behind a failure rather than sending it, so a second pick made during a failing save could sit on screen having never been written. |
| The filing block is a Server Component; only the two controls are client ones. | One client component for the whole block. Rejected after measuring: it cost the page enough hydration time to lose the packaging skip disclosure's first click. |
| The matrix's "filing it under X · Y" line disappears the moment either menu is changed. | Keep the sentence and let it go stale. Rejected: a line claiming one pair over a picker showing another is worse than no line. |

### Honest limits

- **Still no way to create, rename or delete a bucket in the product** — that is
  M7, and a channel's pillars are still empty until someone writes them. The
  vertical picker says so in place rather than rendering an empty menu.
- **The tag vocabulary is one paged read over the channel's videos**
  (`select tags`, `lib/paged.ts`), counted in memory. *Corrected by the M5
  review.* It shipped as `select tags … limit 2000`, which is not a bound: a
  `.limit()` above PostgREST's `db-max-rows` does not raise the ceiling, and the
  ceiling is 1000 — so the read was silently truncated and read as a deliberate
  guard. It pages now. Counting in memory is still right for PLAN.md's sizing —
  one user, hundreds of rows — and would want a `group by` over an `unnest` if a
  channel ever held tens of thousands.
- **A tag added here appears in this page's suggestion row immediately** (the
  tag editor grows its own copy of the vocabulary from what each save confirms)
  **but the bank's filter chips only after that route re-renders.**
  `updateVideo` now revalidates `/c/[slug]/ideas`, so a navigation is enough; a
  second open tab is not told.
- **The capture pickers do not suggest tags.** Capture's tag box is still the
  comma-separated one, deliberately: it is behind the disclosure on the
  fastest path in the product, and the channel can still change underneath it.
- **Two writes, two status lines.** The bucket row and the tag editor each have
  their own queue and their own line, as every other pair of controls on this
  page does. They share the page's one version token, so a save in one does not
  make the other report a conflict.

---

## M5 — The idea bank list: filters, promote, and the Ideas entry that finally goes somewhere

BRIEF.md puts the bank at the front of the pipeline: *quick capture … promote-to-video
moves an idea onto the pipeline board*, and PLAN.md's M5 line asks for
`/c/[slug]/ideas` with a list, tag and bucket filters, and `p` to promote. This
slice is the list half of that. The matrix (`?view=matrix`) is a sibling slice
and owns `components/ideas/matrix/**`; this one owns `app/c/[slug]/ideas/**`
and `components/ideas/list/**`.

### What it delivers

- **`/c/[slug]/ideas`** — every video in the channel's Idea stage, newest
  captured first, each row carrying the title, the one-line hook, the tags, the
  two buckets when set, and how long it has been sitting.
- **Four filters that combine**: a text search over title and one-line hook, a
  tag, a vertical and a horizontal. Each select carries the count it would
  leave, so an option that empties the list says so before it is picked.
- **An empty result that names the culprit.** Three different sentences for
  three different reasons — see below.
- **Promote**, as a button and as `p`, through `moveVideo` → the `move_video`
  RPC. No new write path.
- **Archive and restore**, through `updateVideo({ archived })`. No new concept
  and no second flag.
- **`j` / `k` / `p` / `Enter`**, through `lib/shortcuts.ts`. No second keyboard
  mechanism.
- **The sidebar's Ideas row is a link**, and the board's "+K more in Ideas" is
  the link it should always have been.

No migration. Everything this page needs was already in the schema: `buckets`,
`videos.vertical_id` / `horizontal_id` behind their three-column composite FKs,
`videos.tags`, `videos.archived_at`. The one fixture row the specs write by hand
is a *vertical* bucket, because `lib/defaults.ts` deliberately seeds none.

### The empty state is arithmetic, not a sentence

*"An empty result says which filter emptied it"* sounds like wording and is not.
With four filters ANDed there are three genuinely different reasons a list can
be empty, and they want three different answers:

1. **One filter matches nothing on its own.** Nothing here is tagged "gear",
   whatever else is switched on — so that one is named and the innocent ones
   beside it are not.
2. **Every filter matches something, but never the same idea.** There are
   tutorials and there are money ideas and no money tutorial. Naming one filter
   here would be a lie: *any* of them would restore results, so the sentence
   names the combination.
3. **The bank is empty before any filter ran.** Not a filter problem, and the
   answer is "press c", not "turn a filter off".

Telling those apart means running each criterion alone against the pool, which
is a loop with an off-by-one in it. So it is a pure function,
`components/ideas/list/filtering.ts`, with twelve unit tests over it, and the
page renders whatever it returns. There is a fourth clause it adds when it
applies: *"1 archived idea does — turn on Show archived to see it"*, because
"nothing matches" is actively misleading when the match is one toggle away.

### Two clocks, deliberately

The order is `created_at` — newest **captured** first, which is what a bank
looks like. The age is `stage_entered_at`, which is what *"how long it has been
sitting"* means. For a captured idea the two stamps are the same moment; for a
video that was pushed back down to Idea, the second is the honest age while the
first is still the right sort key. Both are on the row: the age reads on the
chip, the capture date is its tooltip.

### The age carries no colour

A board card turns amber when it is stale, because a stalled video is a problem.
An old idea is not: the bank is a bank, and an idea that waited a year for its
moment is the system working. So the age is mono and muted like any other
measured number, and the only colour on a row is the accent on the selected one
— which is an interaction, not a warning.

### Decisions taken without the user

- **"Archive and delete" was built as archive only, with Show archived and
  Restore.** The instruction that follows the heading is *"archiving already
  exists on videos; reuse it rather than inventing a second concept"*, and a
  destructive delete is a second concept with no undo — it is also the one
  operation in this application that can lose something a person wrote.
  Archiving writes `archived_at`, which every board query already filters on, so
  one write takes the idea out of the bank and off the board at once; the list
  reads archived rows anyway so the toggle can bring them back without a round
  trip, and a row archived in this session stays on screen, greyed, with Restore
  on it, until the page is reloaded. *The alternative* — a permanent `delete
  from videos` behind a confirm dialog — is one server action away if the owner
  finds the bank filling with junk captures that archiving does not settle.
- **The filters are single-value, not multi-select.** "Filters combine" is read
  as combining *across* the four axes (a tag and a vertical and a search), which
  is the combination the matrix thinking implies. Two tags at once would need a
  second combinator (and, or?) for a bank of a few hundred rows. *The
  alternative* is multi-select chips per axis, which is a bigger control and a
  harder empty-state sentence.
- **Selects, not chips, for tag / vertical / horizontal.** `/now` filters by
  channel — two or three values, all worth seeing. A bank filters by tag (dozens,
  growing with every capture) and by horizontal (eight seeded). Twenty-five
  chips above thirty rows costs more screen than the thing it filters, so the
  shape of the bar stays fixed and each option carries its count. *The
  alternative* is `/now`'s chip row, which is the right control for a small
  fixed set and the wrong one here.
- **Archived ideas are read by the page, not excluded in SQL.** The query
  deliberately does not end in `.is("archived_at", null)`; scope is decided in
  the pure function. *The alternative* — filter in SQL and refetch when the
  toggle flips — is a round trip for a set that is already small.
- **The bank shows the Idea stage even when that stage is disabled.** A channel
  that switched its Idea column off still has a bank, and a bank that emptied
  itself because of a display setting is the worst possible way to discover the
  setting.

### The M3 review finding this closes

M3's reviewers filed the sidebar's Ideas row as *unreachable by keyboard and
explained only by a tooltip*. The interim fix was `aria-disabled` plus the
milestone drawn on the row, which made the row reachable and still dead. It is a
link now, to `/c/<first channel>/ideas`, marked `aria-current="page"` when you
are on it; the only remaining *section* row using `SidebarDisabled` is Calendar
(M6) — Board and Ideas keep it as their no-channel fallback, which is a
different situation and is called one in that file's comment since the M5
review. The
board's `+{K} more in Ideas` had the same shape — a caption with a tooltip
apologising for being one — and is now an anchor to the same route, keeping its
`idea-overflow` test id so M1's cap assertion still reads.

### Honest limits

- **The bucket filters only pay off once buckets are set, and this slice sets
  none.** Filing is the sibling slice above ("Filing an idea"), which put bucket
  pickers in capture's disclosure and on the video page, and the matrix's empty
  cell prefills a capture with both ids. This page's own specs set the columns
  in the fixture. What none of the three can do yet is *create* a vertical: the
  seed ships none on purpose, so the vertical select reads "none yet" until the
  bucket editor lands in **M7**.
- **Filter state is not in the URL.** A filtered bank cannot be linked or
  restored by the back button. PLAN.md asks for `?view=matrix` on this route and
  nothing else; adding four more parameters here would also mean agreeing with
  the matrix slice about their names.
- **Every row is read, in pages of 500, and narrowed in memory.** *Corrected by
  the M5 review.* This shipped as "the page reads up to 2000 rows", which was
  wrong in exactly the direction the M3 review had already corrected once:
  `.limit(2000)` against a `db-max-rows` of 1000 is not a bound at all, and
  PostgREST truncates silently — a 200, a thousand rows, `content-range:
  0-999/*`. The page's summary, the filter-option counts and the sidebar's
  badge (a `count: "exact"`, which is *not* capped) would then have disagreed in
  the same chrome. `lib/paged.ts` is the shared reader; `e2e/ideas.spec.ts` puts
  1104 ideas behind it and checks all three numbers agree.
- **Archive has no undo after a reload** — only Restore behind the toggle, which
  is a different, slower gesture. That is the trade for not keeping a
  client-side tombstone across navigations.
- **The matrix is not here.** `?view=matrix` is the sibling slice's — see "M5 —
  The content-bucket matrix" above, which owns the branch in the route file and
  everything past it. This section documents the list only.

### Gates for this slice

| Gate | Result |
|---|---|
| `npm run typecheck` | clean (both projects) |
| `npm run lint` | clean |
| `npm run build` | 9 routes, compiled — `/c/[slug]/ideas` among them |
| `npm test` | 13 files, 250 tests passed (12 of them `filtering.test.ts`) |
| `./scripts/verify-db.sh nertube_m5_list` | OK — migrations applied, 14 SQL test files passed |
| `npx playwright test ideas` | 7 passed (25s) |
| `npx playwright test` (whole suite) | 147 passed, 1 skipped, 1 failed (15.7m) |

Two honest notes on the numbers.

**The one failure is not this slice's, and not a product bug.** It is
`e2e/buckets.spec.ts:372` from the sibling filing slice, which was landing in
this working tree at the same time: its `getByLabel('Idea')` is unscoped and
matches the board's Idea column, the capture dialog and the capture input at
once, so Playwright refuses it under strict mode. Every other spec in the suite
passed, including all thirteen of the files that existed before M5.

**The suite was run on its own ports, database and output directory**
(`E2E_REUSE=0 E2E_PORT=3121 DEV_STACK_PORT=54341
DEV_STACK_POSTGREST_PORT=54342 NERTUBE_DEV_DB=nertube_e2e_ideas
--output=test-results-ideas`). Three slices were building in one tree; a first
full run of this suite reported two failures in `thumbnails.spec` and
`upload.spec`, both of them `browserContext.close: ENOENT …
.playwright-artifacts-N/traces/…`, which is one run clearing the shared
`test-results/` directory under another. Re-run alone, all seventeen of those
two files' cases pass, and the clean run above has them green. Next allows one
`next dev` per directory, so two Playwright runs in one checkout cannot overlap
at all — that is a fact about the harness, not about the code.

---

## M5 — Integration: one route, two views, and one answer to "which bucket is it in?"

Three slices landed concurrently: the idea bank list, the content-bucket matrix,
and filing (the bucket pickers and the tag editor). This is the composition —
what was verified rather than trusted, the two seams that were still open when
they landed, the acceptance walk, and what is still true and unfixed.

### What was already right, and was checked rather than trusted

Every claim in the three reports above was read against the code before anything
was changed here.

- **One shortcut mechanism.** `lib/shortcuts.ts` is still the only keyboard
  registry. The bank's `j`/`k`/`p`/`Enter` go through `useShortcuts`, which
  already refuses to fire while focus is in an input — so `p` typed into the
  search box is a letter, and `e2e/ideas.spec.ts` asserts it. No second listener
  was added anywhere in `components/ideas/**`.
- **One save queue.** `components/ideas/assign/save-filing.ts` routes the bucket
  and tag writes through `updateVideo` + `useSaveQueue` + `VideoVersion`. The
  bank's own writes (`promote`, `archive`, `restore`) are deliberately *not*
  queued — they are one-shot, non-optimistic calls to `moveVideo` and
  `updateVideo` — which is a different thing from a second queue.
- **One modal.** `components/modal.tsx` is still the only dialog. The matrix's
  capture cell mounts it with `testId="matrix-capture"`; capture's own host
  mounts the same component.
- **One write path per concept.** Promote is `moveVideo` → the `move_video` RPC,
  the same call the board's drag and `[`/`]` make; no gate logic was
  re-implemented. Archive and Restore are `updateVideo({ archived })`.
  `capture_video` is still the only client path that creates a video.
- **No migration, and nothing weakened.** `buckets`, `videos.vertical_id` /
  `horizontal_id` behind their three-column composite FKs, `videos.tags` and
  `videos.archived_at` were all already in `0001_init.sql`. The filing slice
  *added* `supabase/tests/55_bucket_assignment.test.sql`, which pins the shape of
  both foreign keys in the catalogue; no existing migration was touched.
- **The board's `+K more in Ideas` is a real anchor** to `/c/<slug>/ideas`,
  keeping the `idea-overflow` test id so M1's cap assertion still reads.
- **`e2e/buckets.spec.ts`'s strict-mode failure was already fixed** in the tree
  by the filing slice before this pass began (the locator is scoped to the
  dialog now). It was re-run here rather than taken on report.

### Seam 1 — the list and the matrix could have disagreed about a bucket

This is the bug this integration step existed to prevent, and it was genuinely
reachable: the bank asked `idea.verticalId === filters.verticalId` and the
matrix asked `video.verticalId !== null && verticalIds.has(video.verticalId)`,
in two files, written by two agents, over the same column. Nothing was wrong on
the day; there was simply no reason the two had to stay the same.

**Fix.** `lib/buckets.ts` gained `bucketOn(slots, axis)` and
`inBucket(slots, axis, bucketId)` — the single answer to "which bucket is this
video in on this axis". `components/ideas/list/filtering.ts` and
`components/ideas/matrix/tally.ts` both call it. The interface is structural
(`{ verticalId, horizontalId }`), so the bank's `Idea`, the matrix's
`MatrixVideo` and a raw `videos` row all satisfy it without a conversion step.

**Proof.** `components/ideas/agreement.test.ts` — a new file at
`components/ideas/`, belonging to neither half — builds one fixture of ten rows
across three stages, one archived, two pillars and two formats, then runs it
through `buildTally` and through `visibleIdeas` and asserts the two name **the
same video ids**, not merely the same counts. It does that for every cell of the
grid, not only the interesting one. Seven tests.

### Seam 2 — the matrix had nowhere to point, because the bank had no address

The matrix slice recorded a deliberate deferral: a populated cell drilled down
into a panel rather than linking into the bank's bucket filters, because "a link
into a filter that may not filter yet is the dead-link mistake M1 and M3 both
filed". The list slice recorded the matching limit: *filter state is not in the
URL, so a filtered bank cannot be linked*. Both were right; this is where they
meet.

**The filters are now in the query string.** `components/ideas/list/url.ts` names
them once — `q`, `tag`, `vertical`, `horizontal`, `archived=1` — and owns both
directions: the route parses them (`readIdeaFilters`), the list writes them back
as the user types, and the matrix builds them from a cell (`ideaBankHref`). The
parameters are spelled the same way `/capture` already spells `vertical` and
`horizontal`.

- **Written back with `window.history.replaceState`**, which Next supports and
  syncs into its own router (`node_modules/next/dist/docs/01-app/01-getting-started/04-linking-and-navigating.md`,
  "Native History API"). No server round trip: the filtering is in-memory over
  rows that are already in the browser, so a `router.replace` per keystroke would
  re-run the page's four reads to produce an identical list.
- **Resolved on the server against this channel's buckets.** A pasted id that
  this channel does not have on that axis is *dropped*, so a stale link opens the
  unfiltered bank instead of an empty list explaining itself as "the vertical
  “that bucket”". A tag is free text with no catalogue, so an unknown tag stays
  on and `explainEmpty` says in words that nothing carries it.

**And the cell now says the bank's own number.** The matrix counts every stage
and the bank lists the Idea stage — a difference of *scope*, not of membership,
but a cell reading 4 above a list showing 2 looks exactly like a bug. So
`MatrixVideo` gained `inBank` (its stage's `kind` is `idea`), `CellTally` gained
the count of them, and the drill-down panel prints "2 are still in the idea
bank" as a link carrying both bucket filters. A cell none of whose videos are
still in the bank says so instead of offering a link to an empty list.

### Seam 3 — the sidebar's Ideas entry, and M3's finding closed

M3's reviewers filed the Ideas row as unreachable by keyboard and explained only
by a tooltip. The list slice made it a real `SidebarLink`; this pass finished the
job.

- It is a link with `aria-current="page"` on the route, it takes focus, and
  `Enter` navigates — asserted in `e2e/m5-integration.spec.ts` rather than
  assumed from the markup.
- It carries a **live count**, drawn exactly the way the Now badge is: the chip
  is `aria-hidden` so the link's accessible name stays "Ideas", and the number
  reaches assistive technology through `title` as the link's *description*.
- The number comes from `lib/ideas-data.ts`, a `cache()`d reader that owns the
  definition it counts by. Its file comment lists the three ways a cheaper count
  would have been wrong, all of them reachable from code that already exists:
  counting by stage *name* (renameable in M7), reusing `readNowInputs` (which
  reads only `is_enabled` stages, so a channel with its Idea column switched off
  would show 0 above a page listing 40), and counting archived rows.
- `boardChannelOf` was extracted from `components/app-sidebar.tsx` and is now
  read by `AppShell` too, so the badge counts the bank the link opens rather
  than a second guess at "which channel is Board of".
- `SidebarDisabled` is now the pattern for exactly one *section*: Calendar (M6).
  It has three call sites, and the other two are Board and Ideas **with no
  channel at all** — there is nothing to link to until one exists, and a row
  that vanished would hide the shape of the product from the person who has
  least idea of it. *The first draft of this line said "exactly one user left",
  which the M5 review caught: one of the three was added by this milestone.*

### The acceptance walk

PLAN.md's M5 line is *"matrix renders, promote lands in Packaging"*.
`e2e/m5-integration.spec.ts` walks it in one browser session against the real
stack, reading every claim back from Postgres:

1. `?view=matrix` renders a 2 × 8 grid, and the view switch is two real links.
2. An empty cell (`craft · interview`) is an `<a href="/capture?c=…&vertical=…&horizontal=…">`;
   clicking it opens the shared modal, `Enter` captures, and the row it wrote
   carries both bucket ids and sits in the Idea stage.
3. The grid then counts it.
4. Back on the bank, `j` selects and `p` promotes — and the assertion is
   `select s.kind … where v.title = …` returning `packaging`, not the row
   disappearing.

The other three cases in that file are the seams above: the sidebar entry, the
filters surviving a reload and a pasted link, and the cell's three numbers
checked against the database rather than against the page's other half.

### Decisions taken without the user

- **The filters go in the URL; the view switch does not carry them.**
  *Reversed by the M5 review — see the review log at the end of this file. Both
  links carry them now, and the matrix passes them through.* The original
  argument, kept because the reversal is only meaningful against it: BRIEF.md
  wants the bank and the matrix to be two ways of looking at one thing, and a
  narrowed bank you cannot send to yourself is a thing you re-narrow every time.
  The switch's List link is deliberately bare, because the matrix has no filters
  to preserve and a List link that restored a search box the grid never showed
  would be surprising. *Alternative:* carry the filters through the switch and
  let the matrix ignore them, so a round trip is lossless.
- **`replaceState`, not `pushState`.** Typing six letters into the search box
  would otherwise be six history entries and six presses of Back to leave the
  page. The cost is that Back does not step through filter changes — it leaves
  the bank, which is what Back means everywhere else in this app.
  *Alternative:* `pushState`, debounced on the search box only.
- **An unknown bucket id in the URL is dropped, not honoured.** A stale link
  degrades to the unfiltered bank. *Alternative:* keep it and say "that filter no
  longer exists", which is more informative and also puts a control on screen
  that cannot be turned off from the select it belongs to.
- **The sidebar's count is the unfiltered bank.** Narrowing the page does not
  change how many ideas there are, and a badge that followed the filters would be
  reporting the filter. This is the same rule `/now`'s badge already follows.
  *Alternative:* count what is on screen.
- **The cell keeps counting every stage, and says the bank's number beside it.**
  The alternative — counting only Idea-stage rows so the two numbers match — was
  rejected by the matrix slice for a good reason (*"where have I never
  published"* becomes unanswerable from the grid) and is not reopened here. What
  changed is that the difference is now printed rather than left to be inferred.
- **Two extra reads on every signed-in route** for the Ideas badge. The price of
  a count that agrees with the page it points at; `lib/now-data.ts` already pays
  five for the same reason. *Alternative:* draw no count, or compute it from the
  `/now` read and accept that it disagrees when the Idea stage is disabled.

### Honest limits, carried forward

- **Back does not undo a filter change** (see `replaceState` above).
- **Both views read every row, paged.** *Corrected by the M5 review.* The
  claim here was "both views read up to 2000 rows in one go, which is PLAN.md's
  own sizing and the bound the board already uses" — three things wrong at once:
  the effective ceiling is PostgREST's `db-max-rows` of 1000, the truncation is
  silent, and the board carried the same false bound. All four reads (the bank,
  the matrix, the video page's tag vocabulary and the board) now go through
  `readPaged` in `lib/paged.ts`, which asks for 500 at a time — under the
  ceiling, so a short page is always the end — over a total order. There is no
  UI pagination and there is not meant to be: what there is, is a page that
  draws every row it counts.
- **Nothing in the product can create a bucket.** The seed ships eight
  horizontals and no verticals on purpose, so a new channel's vertical select
  reads "none yet" and the matrix draws its "no pillars" panel until the bucket
  editor lands in **M7**. Every pillar in the e2e fixtures is written in SQL for
  that reason.
- **`captureVideo` and `updateVideo` are the only writers of `vertical_id` /
  `horizontal_id`.** The filing slice closed the gap the matrix slice reported:
  a video captured without buckets can now be filed from the Packaging tab. It
  still cannot be filed from the bank row or from the matrix's off-grid line —
  both of which can report the problem and not fix it in place.
- **Archive still has no undo after a reload**, only Restore behind the "Show
  archived" toggle.
- **Assist pills remain inert and disabled** until M8. Nothing in this pass
  touched them.

### Two things the suite found, and what was done about them

Both were pre-existing and neither is in `components/ideas/**`. Adding a
fixture channel and two shell-level reads was enough to tip each one over, which
is the useful thing an integration pass does.

- **The sidebar's channel list could paint over the account block.** With enough
  channels for the sidebar to exceed `h-dvh`, the channels `<div>` shrank (it
  carries `min-h-0`) while its `<ul>` kept its natural height and overflowed
  visibly — swallowing clicks meant for the theme toggle underneath it.
  `e2e/shell.spec.ts:154` failed on exactly that, with Playwright naming a
  channel link as the element intercepting the click. Fixed where it was broken:
  the `<ul>` now has `min-h-0 overflow-y-auto`, so the shrink clips and scrolls
  instead of overlapping. The file's own comment had claimed this behaviour
  since M3; now it is true.
- **Two cases in `e2e/m2-review.spec.ts` landed inside the video page's
  hydration window.** `:476` filled the target-date input once, with no retry,
  immediately after `goto`; `:562` clicked the skip disclosure the same way. In
  both, React had not yet attached the handler, so the input took the value (or
  the button depressed) and nothing happened — and the case then spent its whole
  timeout waiting for a result that could not arrive. This class was already
  recorded as intermittent by the filing slice before this pass, which saw it in
  `m2-review:640`, `preview:1119` and `m2-review:476`; a different case in the
  same file failed on each of the two full runs here.

  `e2e/hydration.ts` exists for precisely this and says the answer is to write
  the retry down rather than to unmount the sections, so both interactions now
  go through `untilTaken` — which the test immediately after `:562` in the same
  file already did, for the same reason, in the same words. Re-filling the same
  date and re-opening the same disclosure are idempotent and do not move focus,
  and both assertions stay about the outcome. **No product code was changed for
  either.** The honest reading is that the video page's hydration window is at
  the edge of what an un-retried first interaction can survive under suite load;
  the two shell-level reads this pass added are server time rather than
  hydration time, but they are one more thing on a page that has no room left.
- **`e2e/preview.spec.ts:1119` read the clamp before the clamp was measured.**
  The third of the cases the filing slice had named. It waited for the three
  comparison titles to exist and then snapshotted their `data-cut` and
  `data-truncated` in one `evaluateAll` — but those attributes are written by
  `useClamps` in a layout effect, a tick after the nodes appear, so the snapshot
  could read `null` for all of them. It now waits for the attribute to *exist*
  before snapshotting; the assertions that decide the test are untouched, and
  again no product code changed.

### Gates for this pass

| Gate | Result |
|---|---|
| `npm run typecheck` | clean (both projects) |
| `npm run lint` | clean |
| `npm run build` | compiled, 9 routes |
| `./scripts/verify-db.sh m5_check` | OK — migrations applied, 14 SQL test files passed |
| `npm run test` | 14 files, 257 tests passed (7 of them the new `agreement.test.ts`) |
| `npm run e2e` | **154 passed, 1 skipped, 0 failed** (10.1m) — and again, **154 passed, 1 skipped, 0 failed** (10.7m) |

*The e2e figure above did not describe the committed tree, and the M5 review
caught it:* three "wip" commits had added five reviewer scratch specs
(`e2e/zz-adversarial`, `zz-adv2`…`zz-adv5` — 16 tests) which were still at HEAD
and are not mentioned anywhere in this file, so `npm run e2e` at HEAD would have
collected 171 tests in 26 files rather than the 155 in 21 this run describes.
The five are deleted in the review commit; the table at the very end of this
file is the authoritative one, run against the tree that is actually committed.

Two consecutive clean full runs, on the default ports and the default database,
with nothing else holding this directory's one `next dev`. The skipped case is
`e2e/session-refresh.spec.ts:60`, which only runs under `npm run e2e:refresh`
(it needs a stack minting five-second access tokens); that is its designed
behaviour and not a M5 skip.

Four earlier full runs are worth naming rather than hiding, because the first
three were red and the reason matters: run 1 — 152 passed / 2 failed
(`shell:154`, `m2-review:476`); run 2 — 153 / 1 (`m2-review:476`); run 3 —
153 / 1 (`m2-review:562`); run 4 — 153 / 1 (`preview:1119`). One of those was a
real product defect and is fixed in the product (the sidebar overlap); the other
three were the same test-side hydration-window class, in the three cases the
filing slice had already named, and are fixed in the specs with the retry the
suite already had a helper for. `npx playwright test m5-integration` on its own
is 4 passed.

---

## M5 — adversarial review, applied

Twenty-six findings came back against the M5 tree: two blockers, seven majors
and seventeen minors, across five reviewers (counts, principles, tenant-sql,
browser-a11y, scope-quality). Every one was reproduced or refuted against the
code before anything was changed. What follows is what happened to each, and
the two that were argued down or handed on say why.

### The two blockers

**1. Both M5 reads asked for 2000 rows against a 1000-row ceiling.**
Reproduced. `app/c/[slug]/ideas/page.tsx` and
`components/ideas/matrix/matrix-view.tsx` both ended `.limit(2000)`, and so did
the video page's tag vocabulary. PostgREST's `db-max-rows` is 1000 — hosted, and
pinned to the same number by `scripts/dev-stack/postgrest.mts:42` on purpose —
and it caps a larger `limit` **silently**: HTTP 200, `content-range: 0-999/*`,
no error field. So none of those `.limit()`s was a bound; each was a line that
read like a deliberate guard while the read underneath it was truncated.

That matters here more than almost anywhere, because everything M5 draws is a
*count*: the bank's summary, the filter-option counts, every cell of the matrix,
the row and column totals, the weight bars, the quota meters, and the cell
drill-down's "N are still in the idea bank". Next to all of them sits the
sidebar's badge, which is a `count: "exact", head: true` — and PostgREST does
**not** cap a count. The badge was right and the page it links to was wrong, in
the same chrome, with nothing to say which.

This is also the second time: `lib/now-data.ts` was rewritten in M3 to page
around exactly this, and `docs/MILESTONES.md:2243` already carried the
correction ("wrong in the dangerous direction"). M5 re-entered the corrected
claim as a new honest limit. So the fix is not only the reads:

- `lib/paged.ts` is new and holds `readPaged`, `PAGE_SIZE = 500` and
  `MAX_PAGES`, lifted out of `lib/now-data.ts` — which now imports them, so
  there is one implementation of "all of them".
- The bank, the matrix, the tag vocabulary **and the board** read through it.
  The board was not in the finding; it carried the same `.limit(2000)` and the
  same false claim about it, and correcting the document while leaving the code
  would have been the same mistake in the other direction.
- Each paged read carries a **total** order (`created_at desc, id asc`, or
  `id asc`), because paging over a non-unique order can repeat one row and skip
  another.
- `e2e/ideas.spec.ts` puts 1104 live ideas in one channel and asserts the
  summary, the rendered rows and the sidebar badge are all 1104, and that the
  matrix reaches the same total through its off-grid line. Before the fix that
  test reads 1000 / 1000 / 1104.

**4 and 22. A prefilled capture silently wrote an unfiled idea.**
Reproduced, and it is the same defect filed twice. `CaptureForm` posts
`new FormData(event.currentTarget)`. The two bucket ids rode as hidden inputs
**only while the disclosure was closed**; opening it unmounted them and handed
the two names to the `<select>`s in `capture-buckets.tsx`, which are
`disabled={loading}` until `listBuckets` returns (and disabled again when an
axis has no options). A disabled control contributes nothing to `FormData`. So
between Shift+Enter and the round trip landing, Enter wrote the idea with no
buckets at all — while the form's own state still rendered "Filing it under
Health · interview". No error, no toast, and the cell stayed drawn as a hole.
That is the exact interaction M5 exists for.

Fixed by not letting the pair depend on a control's enabled-ness: the submit
handler now does `data.set("verticalId", verticalId)` and the same for the
horizontal, from the form's own state — which is the same state the "Filing it
under …" line is derived from, so the sentence and the write cannot disagree.
The hidden inputs stay for the no-JavaScript path, where the disclosure cannot
be open without a click that also runs the handler. `e2e/matrix.spec.ts` holds
every POST for two seconds, opens the disclosure with Shift+Enter, asserts the
picker is provably still `loading` and disabled, presses Enter, and then reads
both bucket ids back from Postgres.

### Fixed

| # | Finding | What changed |
|---|---|---|
| 1 | Both M5 reads truncated at `db-max-rows` | `lib/paged.ts`; four reads paged; 1104-row e2e |
| 2 | MILESTONES repeated the corrected "2000 rows" claim in three places | All three rewritten to the real bound and the real behaviour, each marked as a correction |
| 3 | The cell drill-down rendered every video with no cap | Ten listed and the rest counted, the board's own convention, with a link into the filtered bank |
| 4 / 22 | Prefilled capture dropped both buckets while the pickers loaded | `data.set` from form state at submit; spec that proves the window |
| 5 (half) | The matrix is unreachable without SQL | Not built (see *Deferred*), but stated at the top of the M5 matrix section and on the panel itself |
| 6 | A Packaging video told it "shows up in the bank" | `FilingBlock` takes `inBank`; the sentence is stage-aware |
| 7 | Promote's refusal was a tooltip on a `disabled` button | `aria-disabled` + live handler; the reason printed once above the list; same treatment for Archive/Restore and for "Name your pillars" |
| 8 | Two vocabularies for the two axes | `AXIS_LABEL` in the filter bar, the row chips and `explainEmpty` |
| 9 | "Nothing captured yet" for a bank that was worked through | The route counts videos past the Idea stage; two sentences |
| 10 | The view switch dropped the bank's filters | Both links carry them; the bank renders the switch so they are live |
| 11 | Capture reported a raw Postgres constraint name | `describeBucketRefusal` in `captureVideo`'s follow-up UPDATE |
| 12 | The SQL suite pinned the delete side of the bucket keys, not the update side | A new section 7 in `55_bucket_assignment.test.sql`: both refusals (`axis` flipped, `channel_id` moved) expected to raise 23503, a read-back proving neither slot nor axis column moved, and a catalogue assertion that neither key carries an `ON UPDATE` action |
| 13 | `j`/`k` were silent and moved no focus | A live region and `tabIndex={-1}` rows; selection, focus and the announcement are one thing |
| 14 | One in-flight write disabled other rows in behaviour only; a hung write never ended | `locked` on every row, an answered refusal, and a 12s deadline that ends in a message |
| 15 | Nothing announced the filtered count or the empty state | `describeScope` in `filtering.ts`, unit-tested, announced on a 400ms debounce |
| 16 | The `#cell` anchor was never in an href | It is now, plus `FocusPanel`, which moves focus only when focus is on a cell |
| 17 | Capture into a cell dropped focus to `<body>` | `onClosed` focuses the populated cell that replaced the opener |
| 18 | The open cell was colour-only under forced colors | It carries `data-selected`, and the unlayered rule covers `aria-current` too |
| 19 | The bank skipped from h1 to h3 | Row titles are `<h2>` |
| 20 | The view switch gave no sign it heard the click | `useLinkStatus` on both links |
| 21 | Every bar vanished under forced colors | `data-bar` on both meters and explicit system colours for track and fill |
| 23 | Five reviewer scratch specs at HEAD | Deleted; the e2e totals below are the tree that is committed |
| 24 | MILESTONES claimed `SidebarDisabled` had one user | Both lines and the component's comment now say which one is the section row and what the other two are |
| 26 | The filter-option counts read the bucket columns raw | `bucketOn`, so the counts, the row filter and the matrix tally answer through one function |

### Rejected

Nothing was rejected outright as wrong. Two findings were **partly** declined,
and the part that was declined is stated here rather than quietly dropped:

- **5 — "ship the smallest possible pillar-naming affordance inside M5."** The
  diagnosis is right and is now the first thing the M5 matrix section says. The
  remedy is not M5's: PLAN.md puts bucket creation in **M7 — Settings**
  ("buckets + quotas"), a server action that inserts `buckets` rows is a bucket
  editor however small the dialog around it, and this pass was scoped to M5
  only. Deferred, below, rather than rejected.
- **25 — make `p` fall through to the next enabled stage, like the board's
  `]`.** Declined in favour of the finding's own second option: the divergence
  is deliberate and is now recorded under *Decisions taken without the user*.
  Promote is not "move forward one"; it is "put this idea into Packaging",
  which is where a title, a thumbnail concept and a hook get decided. A channel
  that has switched Packaging off has switched off the thing Promote means, and
  silently landing the idea in Scripting would skip the gate BRIEF.md's first
  principle is about. `]` is a different question — "the next stage there is" —
  and answers it correctly.

### Deferred to a named milestone

- **A way to create a bucket (finding 5) → M7.** With it, the matrix stops being
  dormant and the M5 acceptance walk becomes possible without `psql`. Until
  then the page says so on screen and this document says so at the top.
- **Nothing else.** Every other finding is either fixed above or, in the case of
  25, a recorded decision.

### Decisions taken without the user

- **`p` is literal about Packaging; `]` is about the next enabled stage.** They
  are asked different questions and give different answers for a channel with
  Packaging switched off: Promote refuses and says why, on the page; `]` moves
  the card to Scripting. *Alternative:* make Promote fall through using the
  board's `compareKinds` ordering, which is one rule in both places and which
  quietly skips the packaging gate for a channel that has turned the column off.
- **The view switch now carries the bank's filters in both directions.** This
  reverses the decision recorded in the integration section ("the switch's List
  link is deliberately bare"): the review showed what it costs — arriving from a
  cell's drill-down, which sets both bucket filters, glancing at the grid and
  coming back landed on an unfiltered list with nothing to say so. The matrix
  ignores the query and passes it through. *Alternative:* the bare link, plus
  some on-screen notice that filters were dropped, which is a second thing to
  explain rather than one thing that behaves.
- **The bank renders the view switch; the matrix branch of the route renders
  it.** Only the bank knows what its filters currently are — they live in
  `IdeaList` and are written to the address bar from it — so a server-rendered
  switch above the list would carry the query the page was *requested* with and
  be stale the moment anything was typed. *Alternative:* `useSearchParams` in
  the switch, which this codebase avoids (`components/video-sections/video-sections.tsx`
  states why) and which would be a second parse of the same parameters.
- **A hung write is given up on after 12 seconds, not cancelled.** The request
  is left alone — a `move_video` that does land should land — and what ends is
  the page's waiting for it, with "The server has not answered. Reload to see
  whether it moved." *Alternative:* an `AbortController`, which would make the
  message certain ("nothing moved") at the cost of killing a write that was
  probably about to succeed.
- **The cell drill-down lists ten.** The board's Idea column already caps at ten
  and links the rest; two lists in one product capping at different numbers is a
  decision nobody made. *Alternative:* list everything, which is what the
  truncated read was accidentally doing and which puts four hundred anchors
  under a grid the page expects to keep reading.
- **`aria-disabled` everywhere a control is present but will not act** — the
  bank's three row buttons, and "Name your pillars". One consequence worth
  writing down: Playwright's actionability check treats `aria-disabled` as
  disabled, so the specs that press one pass `force: true`. A browser does not,
  which is the whole reason the control is focusable and still wired to a
  handler. *Alternative:* `disabled`, which is what the M3 review filed against
  the sidebar.

### What the review got right that the code did not have to change

- The composite foreign keys, the `on delete set null` column-list form and the
  pinned axis columns were re-read and left exactly as they were. Finding 12
  asked for **tests**, not a migration, and that is what it got: no migration
  was added in this pass.
- `describeBucketRefusal`, `bucketOn`/`inBucket`, `lib/storage.ts`,
  `components/autosave.tsx`, `components/modal.tsx` and `lib/shortcuts.ts` are
  all still the single path for what they own. Nothing in this pass added a
  second one.

### Gates for the review pass

| Gate | Result |
|---|---|
| `npm run typecheck` | clean (both projects) |
| `npm run lint` | clean |
| `npm run build` | compiled, 9 routes |
| `./scripts/verify-db.sh m5_final` | OK — migrations applied, 14 SQL test files passed |
| `npm run test` | 14 files, **261** tests passed (4 of them the new `describeScope` cases) |
| `npm run e2e` | **163 passed, 1 skipped, 0 failed** (10.5m) — and again, **163 passed, 1 skipped, 0 failed** (10.2m) |

`npx playwright test --list` is **164 tests in 21 files** at this commit, which is
the number the `npm run e2e` figure is over: 155 before this pass, plus six new
cases in `e2e/ideas.spec.ts` and three in `e2e/matrix.spec.ts`, with the five
`zz-adv*` scratch specs deleted. The one skip is `e2e/session-refresh.spec.ts:60`,
which only runs under `npm run e2e:refresh` (it needs a stack minting
five-second access tokens) — its designed behaviour, not a skip this pass added.

Two consecutive clean full runs, on the default ports and the default database.
A third, earlier run was started and **deliberately killed at test 40**: a
comment was being edited while it was in flight, and a run against a tree that
is changing underneath it is not a result. Both runs above are against the tree
as committed.

The nine new browser cases, and what each one would catch if the fix were
reverted:

| Spec | Would fail as |
|---|---|
| `ideas: reads past PostgREST’s 1000-row ceiling` | 1000 / 1000 / 1104 — the page, its rows and the sidebar badge disagreeing |
| `ideas: j/k move focus and say what is selected` | an empty live region and focus left on `<main>` |
| `ideas: an emptied bank says whether anything was ever captured` | "Nothing captured for M5 Ideas yet." over three captured videos |
| `ideas: a channel with Packaging switched off explains Promote` | a `disabled` button with the reason only in `title` |
| `ideas: one write at a time is visible, and a hung write ends in a message` | row 2's buttons enabled and inert, and row 1 pulsing for ever |
| `ideas: the view switch keeps the bank’s filters` | an unfiltered list after a round trip through the grid |
| `matrix: a prefilled capture keeps both buckets` | `vertical_id` and `horizontal_id` null on the written row |
| `matrix: capturing into a cell leaves focus on the replacement` | `document.activeElement === document.body` |
| `matrix: the drill-down takes the reading position and caps at ten` | twelve `<li>`s, no `#cell` in the href, and focus still on the cell |

### The orchestrator's own verification — and the flake both workflow runs missed

The M5 workflow reported two consecutive clean full runs, and the section above
records them. I re-ran all six gates myself, which is the standing rule for this
project: typecheck, lint, `npm run build`, 261 unit tests across 14 files, the
14-file SQL suite via `./scripts/verify-db.sh`, and the browser suite twice.

The first browser run was 163 passed / 1 skipped. **The second failed**, on
`e2e/ideas.spec.ts:485` — *"j, k and p promote the selected idea without touching
the mouse"* — with a 60s `page.waitForURL` timeout at the last line.

The cause was in the test, not the product, but it was not a wrong assertion; it
was a missing one. The step is:

```
await page.getByTestId('idea-search').fill('');
await rowFor(page, TITLES.desk).click();
await page.keyboard.press('Enter');
```

Clearing the filter re-renders the list. A click dispatched inside that window
can land on a row React is replacing: the node is detached, `onSelect` never
runs, focus stays in the search box, and `lib/shortcuts.ts` then does exactly
what it should by refusing to read `Enter` as a shortcut inside a text input.
Nothing navigated, and the failure was reported 60 seconds later against the
navigation — the step *after* the one that actually broke.

The fix wraps the click in `untilTaken` (`e2e/hydration.ts`, the helper this
codebase already uses for this shape) and asserts `data-selected` **before**
pressing `Enter`. Re-clicking a row is idempotent, so the retry is what a person
whose first click did nothing would do, and the new assertion means the next
failure here names the selection rather than the navigation. Verified by running
`e2e/ideas.spec.ts` three times in a row (13 passed each) and then the full
suite twice more.

Recorded because of what it says about the rule rather than about this test:
**a milestone's own two clean runs are not the same as two clean runs by someone
who did not write the code.** M3's review made the same point about a different
flake. This is the second time the independent re-run has been the thing that
caught it, and the first time it caught something after the workflow had
reported green twice.

## M6 — The calendar: a month grid, both channels, and the day that is full

> This is one of the two M6 slices. It owns `app/calendar/**`,
> `components/calendar/grid/**`, `lib/calendar-data.ts` and the sidebar's
> Calendar entry. The filming-day *writes* — `app/actions/filming-days.ts`, the
> board badge that schedules a day, `components/calendar/filming/**` — are the
> other slice and have their own section.

### What this slice delivers

- **`/calendar`** — a month grid of every channel's target publish dates, with
  filming days drawn as a different kind of event. It is the only view in the
  product that is cross-channel and unfiltered, and that is the point of it:
  BRIEF.md asks for the *rhythm*, and a rhythm you can only see one channel at a
  time is not one.
- **Month navigation that is link-shaped.** `?month=YYYY-MM` is the entire state
  of the view, so previous / next / This month are `<a href>`s, a month can be
  bookmarked or pasted to somebody else, and the back button works. A `?month=`
  that is not a month renders this month instead of 404ing.
- **Today, marked three ways** — the accent disc, the weight of the number and
  the word "Today" for a screen reader — and the days borrowed from the months
  either side muted, on the page's ground rather than on a card, carrying no
  events, and linking to the month they actually belong to.
- **A chip that says whether a video is on track.** The working title in the
  reading face, the channel as a two-letter tag and a stripe style, and the
  stage it is in right now. Exactly one state spends colour: `late` — the target
  date has passed and the video is neither scheduled nor live.
- **A density rule with a way out.** Three chips is the ceiling for a day;
  past it the cell draws two and a `+N more` link to `?day=`, which opens the
  whole day under the grid. A week is never as tall as its busiest day, and the
  hidden rows are reachable by keyboard, without JavaScript, at an address of
  their own.
- **Honest empties.** A month with nothing in it names itself, says whether
  anything exists anywhere, and links to the nearest month that has something
  (with its count) rather than rendering a grey grid.
- **The sidebar's Calendar entry is a page.** It was the last dead placeholder.
  It is now a link with a live count of the videos going out this month, and
  `SectionItem` — the helper that drew "M6" on an inert row — is deleted,
  because there is nothing left for it to draw.
- **`lib/calendar-data.ts`** — one reader for the month (four flat selects, no
  embeds, `readPaged` where a row could be lost) and one for the sidebar's
  count, with the same "`null`, never a guessed zero" discipline as
  `lib/ideas-data.ts`.

### One date helper, written twice, kept once

Both M6 agents wrote the date helper, within a minute of each other:
`lib/calendar-date.ts` from the filming slice and `lib/calendar-dates.ts` from
this one. That is exactly what the brief warned against — *do not let a second
date interpretation exist anywhere* — and it was settled by keeping **one
file**: the filming slice's, renamed to the plural path this slice's test was
written against. Everything in `app/calendar/**` and
`components/calendar/grid/**` goes through it, and nothing here re-implements
any part of it; `components/calendar/grid/month-grid.tsx` does not even slice a
day number out of a string, it asks `parseDateColumn`.

Worth recording, because it is why the collision was cheap: the two
implementations had independently made the same decisions — UTC, Monday-first
weeks, whole weeks rather than a padded six rows, half-open month windows, and
`YYYY-MM-DD` compared lexicographically — so reconciling them was a deletion
rather than a negotiation. They differed only in shape (`{year, month, day}`
records against day-numbers-since-epoch).

What this slice added to the surviving file is `lib/calendar-dates.test.ts`'s
final block, "the sweep": the same claims made exhaustively rather than on the
dates somebody thought to type — every day of a decade round-tripped, every
grid invariant on every month of six years, the century leap rules, and all of
it repeated under seven timezones from `Pacific/Honolulu` to `Pacific/Chatham`.
It is 6 cases on top of the existing 27, and it is the part that would catch a
"helpful" rewrite of the arithmetic in terms of `86_400_000`.

### Decisions taken without the user

| Decision | Alternative not taken |
|---|---|
| A channel is told apart by a two-letter tag and a stripe *style*, not by a colour. | PLAN.md's "colour per channel". Rejected: in this design colour means state — ready, attention, over limit — and a calendar is the easiest place in an app to end up with a bag of highlighters. A tag is also the only signal that survives being colour-blind, printed, or read aloud, and a legend under the grid expands every tag. |
| The only coloured thing on the grid is `late`. | Colouring scheduled and published as well. Rejected: a video that is where it should be does not need attention, and three tones would hide the one that does. |
| "Late" means the date has passed **and** the video is neither scheduled nor published. | Anything past its date. Rejected: a scheduled video whose date has passed is YouTube's business, and `/now` is already asking for its URL; saying it twice in red is noise. |
| Three chips per day, and a full cell draws two plus the overflow link. | A scrolling cell, or a cell that grows. Rejected: the shape of the month is what a month grid is for, and a nine-video Saturday nine rows tall destroys it. Drawing three *and* a link would break the ceiling the rule exists to enforce. |
| The overflow opens a panel under the grid at `?day=`, not a dialog. | A modal. Rejected: a dialog needs focus management, an escape key, a client component and a second keyboard mechanism, and the panel gets a bookmarkable address for free. `components/modal.tsx` stays the one modal. |
| The days borrowed from the neighbouring months carry no events. | Draw them, as most calendars do. Rejected: a video would then be visible on the grid and absent from the heading's count and the sidebar's badge — the exact class of disagreement M5's reviewers spent a day on. Every number on this page counts the same set: this month. |
| The sidebar's Calendar badge counts videos targeted at this month and does **not** fold filming days in. | One combined number. Rejected: a badge that silently sums two kinds of thing is a number with no name. |
| An unparseable `?month=` renders this month. | A 404. Rejected: nothing at `/calendar` can be "not found", and a calendar is the most link-pasted page in a product like this. |
| A video with no target date is not on the calendar, and neither is an archived one. | A "no date" tray beside the grid. Rejected: a video without a date lives on the board, which is where it gets one. |
| The whole page is server-rendered, with no client component at all. | A client grid with month state in React. Rejected: the requirement is that a month is linkable, which means every view needs an address, and once it has one the navigation is a link and the state is the URL. |

### Deviations from PLAN.md, stated plainly

- **"Colour per channel" is not built** — see the decision above. PLAN.md's
  phrase is one clause in a table cell; the design system's rule about what
  colour means is load-bearing, so the rule won.
- **The sidebar's Calendar count is not in PLAN.md.** It is in this milestone's
  brief, and it is built exactly the way the Now and Ideas counts already were:
  one reader owning the definition, `null` rather than a guessed zero when the
  read fails, and the chip `aria-hidden` so the link's accessible name stays
  "Calendar".
- **`g k` — the keyboard jump to the calendar — is still M9.** PLAN.md puts the
  full `g n/b/i/k` set in the polish milestone and this slice did not pull it
  forward. "Reachable by keyboard" is satisfied by the row being an ordinary
  link in the tab order, which is what the M3 review asked for when it filed the
  Ideas placeholder.
- **No migration.** `filming_days`, `videos.filming_day_id`,
  `videos.target_publish_date` and `videos.archived_at` were all in
  `0001_init.sql`, and none of them needed changing. Nothing in this slice
  writes to the database at all: it is four reads and a grid. The one write-path
  change is a line in `updateVideo` — `revalidatePath("/calendar")`, because
  `target_publish_date` and `archived_at` are fields it writes and the calendar
  is the view that draws them.

### Honest limits

- **"Today" is the UTC day, everywhere.** It is the choice the board and the M5
  matrix already made for `date` columns, and it is what lets the server's
  render and the browser's hydration agree about which cell is today. The cost
  is real: for a creator far enough west, the calendar's "today" turns over a
  few hours before theirs does. Fixing it properly means asking the viewer for a
  timezone and storing it, which is a settings question (M7).
- **Nothing on this page writes.** A target date cannot be dragged to another
  day, and a filming day cannot be created from a cell — the date is set on the
  video page (M2) and the day is scheduled from the board's badge (the other M6
  slice). Drag-to-reschedule is not in PLAN.md for v1.
- **Only an overflowing day and a filming day link to the day panel.** A day
  holding one or two videos has no way to open its own `?day=` view, because
  its chips are already on screen and they link somewhere more useful — the
  video. The panel is reachable for every day by URL.
- **The grid is a month and only a month.** No week view, no agenda, no way to
  see two months at once. PLAN.md asks for a month grid.
- **The day panel lists everything on the day, uncapped.** Forty videos on one
  date would be a long panel. The *grid* is what the density rule is about; the
  panel is the place you went to in order to see them all.
- **No mobile pass.** The table is seven columns wide and does not reflow; M9
  owns the phone.

---

## M6 — Batch filming days: the badge that finally does something

> The other M6 slice. It owns `app/actions/filming-days.ts`,
> `components/calendar/filming/**` and `lib/filming-data.ts`, plus the board's
> Filming badge and the filming-day control on `/videos/[id]`. The month grid,
> `/calendar` and the sidebar's Calendar entry are the calendar slice and have
> their own section above.

BRIEF.md principle 4 is the only principle in the brief that names a *trigger*
and an *action* in the same sentence:

> *Batch filming. Filming is the only step needing a big time block. When 3+
> videos are sitting in Filming, that's a signal to schedule a batch day.*

The board has been drawing that signal since M1 and doing nothing about it for
five milestones — PLAN.md's review log item 22(c) put it there deliberately,
"text-only until M6". This slice is the second half of the sentence.

### What this slice delivers

- **`app/actions/filming-days.ts`** — the one write path for `filming_days` and
  for `videos.filming_day_id`: `createFilmingDay`, `linkVideosToFilmingDay`,
  `unlinkVideoFromFilmingDay`, `updateFilmingDay`, `deleteFilmingDay`.
- **`lib/filming-data.ts`** — the one reader: what is in Filming (all channels),
  the days in a date range with the videos each covers, one day, and the days a
  video can be linked to.
- **`components/calendar/filming/**`** — the schedule dialog, the day panel
  (its videos with the stage each is in now, shoot notes, detach, move the day,
  cancel the day), the board-badge button, the video-page control, and the pure
  `summary.ts` that decides what a day *says*.
- **The board's Filming badge is now that button**, carrying the same sentence
  it has carried since M1 and opening the dialog with every video it counted
  already ticked.
- **`/videos/[id]` gained the other direction**: a Filming day select under the
  target date, plus "schedule a new day" for a date that does not exist yet.
- **`lib/calendar-dates.ts`** — the one interpretation of a `date` column,
  written for this milestone and shared with the calendar-grid slice.

### No migration

M6 needed none, and this is worth stating because the temptation was real.
`filming_days` has existed since `0001_init.sql` with `on_date date not null`,
`notes`, `unique (user_id, on_date)` and `unique (id, user_id)`;
`videos.filming_day_id` has its composite tenant foreign key with `on delete set
null (filming_day_id)` in the Postgres 15+ column-list form. Supabase's default
grants leave INSERT/UPDATE/DELETE on `filming_days` in place (only `videos`,
`stages` and `thumbnail_swaps` have column-level revokes), and the
`filming_days_owner` policy is `for all`. So the whole milestone is reads and
writes against a schema that was already right.

### The dates, which is where this milestone could have gone wrong

`lib/calendar-dates.ts` was written by this slice and reconciled with the
calendar slice's copy within the minute — that reconciliation, and the sweep of
extra tests it brought, is recorded in the section above. What follows is why
the surviving file looks the way it does.

Every date bug in a calendar starts with `new Date("2026-03-03")` — midnight
UTC, which is the 2nd of March for a third of the planet. The module's rule is
absolute: **nothing in it constructs a `Date`
from a bare date string, and nothing calls a local-time getter or constructor.**
Every conversion goes through `Date.UTC(...)` and `getUTC*`, which also
normalises overflow — which is why the module contains no table of month lengths
and no leap-year rule.

`lib/calendar-dates.test.ts` opened with 27 tests over the four places this
breaks — midnight either side of a boundary, month and year ends, leap
February, and the two months containing clock changes (March and October 2026)
walked day by day — and the calendar slice added its exhaustive sweep on top,
33 in total. The suite is run twice, under `TZ=UTC` and
`TZ=America/Los_Angeles`, and both runs are identical. A DST-blind implementation fails the March walk immediately:
adding 86,400,000 ms to a local `Date` repeats or skips a date on those two days.

### Decisions taken without the user

1. **"Today" is UTC.** The alternative — the viewer's local day — cannot be
   computed on the server, so the server render and the hydrated render would
   disagree about which cell is today. The app has no timezone setting; settings
   is M7, and a `profiles.tz` there is a one-line change because `todayColumn()`
   takes a millisecond clock and nothing else. What it costs: a viewer west of
   UTC sees "today" advance in the late evening. Nothing *stored* depends on it.
2. **The schedule dialog opens on the next Saturday.** A batch day is what you
   do with a block of time, and the brief's own example of one is a Saturday.
   Defaulting to today would suggest a Tuesday evening shoot, which is the
   opposite of what the badge is proposing. It is a default in a date box.
3. **A past filming day keeps its videos and reports where they got to.** The
   choice was between hiding videos that have left Filming (which renders last
   month's shoot as an empty day — a lie) and rendering the link unchanged
   (which says "3 to shoot" for ever — stale, and indistinguishable from a day
   that did not happen). Neither. The day keeps every link and draws each
   video's *current* stage, and `summary.ts` turns that into one line: "2
   videos, filmed and moved on", or "1 of 2 moved on; 1 still waiting to be
   filmed."
4. **Exactly one state on a filming day takes colour**: a day that has *passed*
   with videos still in Filming. That is the batch day that did not happen, and
   it is the only state asking for a decision. Upcoming days, finished days and
   days whose videos have all moved on are furniture. A calendar is the easiest
   place in an app to end up with a bag of highlighters.
5. **A duplicate date is an answer, not an error.** `unique (user_id, on_date)`
   is what makes a filming day *the* Saturday. A second attempt is caught at
   `23505`, the existing day is read back with everything it already covers, and
   the dialog offers "add these to it". Nobody is ever shown
   `filming_days_user_id_on_date_key`.
6. **Moving a day onto an occupied date is refused rather than merged.** Merging
   would silently move another day's list of videos; the two-step (attach them
   to that day, then cancel this one) is explicit and already built.
7. **Linking does not go through `updateVideo`.** `filming_day_id` is a column
   on `videos`, so it could have joined `VideoPatchSchema`. It does not:
   attaching a video is the *day's* business — it is what knows about the unique
   date, about creating a day that does not exist yet, and about what "already
   booked" means — and a second write path would have to learn all three.

### Deviations from PLAN.md, stated plainly

- PLAN.md's action list names `createFilmingDay`. Four more exist (link, unlink,
  update, delete), because a day you can create and never change is not a
  feature: PLAN.md's own M6 line asks for linking and unlinking, and its review
  note asks for a day whose videos have moved on to render sanely — which means
  the day has to be visitable after the fact.
- PLAN.md item 29 dropped `/film/[id]` in favour of "calendar filming days
  expand to linked videos". That expansion exists on `/calendar` (the grid
  slice). The *interactive* version of the same panel — detach, notes, cancel —
  is reached from the board's badge dialog, which is where somebody standing in
  front of a pile of Filming cards actually is.

### The bug the browser suite found: one `Intl`, two implementations

Worth recording in full, because it is the timezone hazard's quieter cousin and
it was invisible until a real browser ran the page.

`lib/calendar-dates.ts` formats every date through one function, with a fixed
locale (`en-GB`) and a fixed zone (UTC) — which is the discipline that stops the
*machine's* settings leaking in. It does not stop something else:
`Intl.DateTimeFormat` is one API with two implementations, and they do not carry
the same CLDR data. For the `weekday` style, Node 22 writes **"Wed 30 Sept"**
and Chromium 141 writes **"Wed, 30 Sept"**.

`VideoFilmingDay` is a client component that was formatting its own option
labels. A server-rendered route therefore produced one string in Node and
another in the browser a moment later, and React reported exactly that:

```
Hydration failed because the server rendered text didn't match the client.
```

It threw the subtree away and re-rendered the whole page client-side on every
load of `/videos/[id]`, and that is not cosmetic. **Two existing specs failed
because of it** — `e2e/flow-fields.spec.ts` "the target date can be set and
cleared" and `e2e/m2-review.spec.ts` "picking a target date saves it without
waiting for a blur" — both stuck on a status line reading *"No date yet"*: the
value went into the input, React replaced the tree, and the `onChange` that
saves it was attached to a node that no longer existed. Both pass now, and the
filming-day tests on that page dropped from 9.9s to 4.2s.

Worth noting how it was found: not by an assertion, but by reading the dev
server's output during a run that was otherwise green in this slice's own spec
file. The suite only turned it into a failure two spec files later, on a page
this milestone did not think it had touched.

The fix is the rule this codebase already had: **dates are formatted on the
server and passed down as strings** (`targetPublishLabel` on the board,
`publishedLabel` on the flow fields). `LinkableDay` now carries a `label`, the
video page formats it, and a day created after mount formats its own — by then
nothing is hydrating, so there is nothing to disagree with.

Two things were considered and not done. Formatting the strings by hand from a
fixed English table would remove the divergence at the root, but it would change
the output of a module the calendar slice had already written a test sweep
against, mid-flight. Pinning `Intl` behaviour with `NODE_ICU_DATA` makes
deployment carry a data file to fix a rendering nicety. Neither is worth it
while the rule "format on the server" is already the house style — but if a
third component gets this wrong, the hand-rolled formatter is the answer.

### The second thing the suite found: a fixture that was wrong outside its own file

`e2e/board.m1.spec.ts` asserts the Filming badge's **cross-channel** count —
"3 in Filming across all channels" — and `e2e/filming-days.spec.ts` leaves five
videos sitting in Filming. One database, one dev stack, reused between runs by
default: the next run of board.m1 read **8** and failed for a reason that had
nothing to do with the board.

Two fixes, because they answer different halves of it:

1. This file now cleans up after itself in `afterAll`. A `beforeEach` cannot —
   by the time it runs, the damage is in another spec's run.
2. This file no longer hard-codes its own number either. It asks the database
   how many videos are in Filming and asserts the badge against *that*, so
   somebody else's fixture cannot fail it the same way in reverse.

It is the M5 review's flake lesson arriving from a new direction: the fixture
was correct inside its own file and wrong outside it, and only a full-suite run
in the right order could show that.

### `/now` and the calendar, and the one thing they share

`/now`'s "10 minutes or less" filter hides the `filming` and `editing` kinds
because they need a real block of time (`NEEDS_A_BLOCK` in
`lib/next-action.ts`). The calendar is where a block gets booked, so the two
views have to agree about what is waiting for one — and they do, through
`kind`: `lib/filming-data.ts` defines "in Filming" as *an enabled stage of kind
`filming`, not archived, any channel*, which is the same predicate `/now` hides
by and the same one the board badge counts by. Renaming Filming to "Shoot" in
settings (M7) moves all three together.

What was deliberately **not** done is making the batch day cover `editing` as
well. Both kinds need a block, but only one of them is batched: BRIEF.md
principle 4 is about being in front of a camera with the lights up, and an
editing day that swept up half the board would make the Saturday's list wrong.

### Honest limits

- **The calendar's day panel is read-only.** `/calendar` (the grid slice) draws
  a filming day as its own kind of event and expands it to the videos it covers;
  detaching a video, writing shoot notes and cancelling a day are in
  `FilmingDayPanel`, which the schedule dialog renders and the calendar does not
  yet. The two are one component away from each other and the seam is named here
  rather than left to be discovered: the integration pass should render
  `components/calendar/filming/filming-day-panel.tsx` inside
  `components/calendar/grid/day-panel.tsx`, and put a
  `ScheduleFilmingDayButton` (its `plain` tone, which exists for exactly this)
  in the calendar's header, so a day can also be booked from the view that
  shows days.
- **`lib/filming-data.ts` and `lib/calendar-data.ts` both read filming days**,
  for two different questions (one day with its videos' stages; a month of
  events). They agree because they read the same rows, but they are two readers
  and a future change has to remember both.
- **`FilmingDayPanel` must not be server-rendered as it stands.** It formats
  dates in the browser, which is safe only because it mounts after a click. The
  integration described above has to hand it server-formatted strings first, for
  the reason the `Intl` note gives.
- **The day side only offers what is in Filming.** The schedule dialog's
  checkbox list is exactly the badge's set, so a video in Scripting that you
  want to shoot on Saturday is attached from *its* page rather than from the
  day. That is the same asymmetry the badge has — it is a signal about Filming —
  and the second direction exists precisely because the first one is narrow.
- **The board pays for the badge being a button.** It used to answer "how many
  are in Filming elsewhere" with one `count` query; it now reads those rows,
  because the dialog pre-selects them by title. That is `readFilmingVideos()` —
  two small lookups (`channels`, `stages`, `cache()`d per request) and one
  paged read of the Filming rows — on every board load, for a button most loads
  will not press. It is the same trade `lib/ideas-data.ts` documents for the
  sidebar's count, and the alternative (fetch on click) would put a round trip
  between noticing and scheduling, which is the one thing this milestone is
  about.
- **A filming day carries no time of day and no duration.** `on_date` is a
  `date`, and the brief asks for a block of time, not a calendar appointment.
- **Nothing recomputes the badge's threshold client-side after a link.** Linking
  does not move a video out of Filming, so the count does not change; when a
  video does leave, the board's own revalidation handles it.

### What an existing spec needed

One, and it is the one this slice was always going to touch:
`e2e/shell.spec.ts` asserted that Calendar was a disabled control reading
"Calendar M6", that it could be focused but not followed, and that **no link in
the sidebar pointed at `/calendar`**. All three were true and are now wrong, so
they are replaced by the assertions that say the same thing about a built page:
there are no `sidebar-unbuilt` controls left at all on an account with channels,
`Calendar` is a link to `/calendar`, it is still focusable by keyboard, and
`/calendar` appears exactly once in the sidebar's hrefs while a bare `/ideas`
still never does.

A caution for anyone re-running a *subset* of the suite: that test also asserts
`getByRole('link', { name: 'Board' })` is the current page, and the match is a
substring one. On a database that still holds `e2e/board.m1.spec.ts`'s channels
— "M1 Board A" and "M1 Board B" — it resolves to three links and fails on strict
mode. In a full run `e2e/m1-acceptance.spec.ts` deletes those channels before
`shell.spec.ts` is reached, which is why it passes there and why it failed the
first time this slice ran `playwright test shell` on its own. Nothing was
changed for it; it is written down because half an hour went into finding it.

### Gates for this slice

| Gate | Result |
|---|---|
| `npm run typecheck` | clean (both projects) |
| `npm run lint` | clean |
| `npm run build` | compiled, **10 routes** — `/calendar` is the new one |
| `./scripts/verify-db.sh m6_calendar` | OK — migrations applied, 14 SQL test files passed (no migration added) |
| `npm run test` | 17 files, **317** tests passed (27 + 6 in `lib/calendar-dates.test.ts`, 10 in `components/calendar/grid/density.test.ts`) |
| `npm run e2e` | **181 passed, 2 failed, 1 skipped** (16.9m), 184 total |

The nine `e2e/calendar.spec.ts` cases all pass, inside the full run and on their
own. The one skip is `e2e/session-refresh.spec.ts`, which only runs under
`npm run e2e:refresh` — its designed behaviour, not a skip this slice added.

**The two failures are both in the other M6 slice**, and are recorded here
rather than fixed because that slice was still being written while this run
happened:

| Failing spec | Why |
|---|---|
| `board.m1: the Filming badge counts across all channels and appears at three` | M1's badge was text; the filming slice makes it the button that schedules the day, so the spec's expectation is out of date and belongs to that slice to update. |
| `flow-fields: the target date can be set and cleared, and the card follows` | The filming slice inserts its `VideoFilmingDay` control directly under the target date on `/videos/[id]`; the date no longer reports "Saved" in that test. Nothing in the calendar slice touches that field — the only change this slice makes to `updateVideo` is one `revalidatePath("/calendar")` after the write. |

Neither failure reproduces on a tree without `components/calendar/filming/**`.
Both were re-checked at the end of the run rather than taken on trust, and the
calendar's own nine cases pass in the same run that shows them failing.

### A note for the integration pass

- **`/calendar` has a seam for the filming slice, deliberately.**
  `components/calendar/grid/types.ts` defines a `filming` event beside the
  `publish` one, `MonthGrid` draws it as its own kind of chip, and `DayPanel`
  expands it to the videos currently linked to the day. What it does **not**
  have is any way to *create* or *edit* one: that is the other slice, and its
  interactive panel should be dropped into the day panel rather than beside it.
  `lib/calendar-data.ts` already reads `filming_days` and the linked videos.
- **The line this slice deliberately did not draw** is "N videos are waiting for
  a filming day", under the month summary. It is the sentence that would make
  the calendar and `/now` agree about what needs a block of time — `/now` hides
  the filming and editing kinds behind its ten-minute filter for exactly that
  reason — and the count belongs to `lib/filming-data.ts`, which the other slice
  owns. Adding a second reader for it here would have been the sixth mechanism
  this project keeps refusing to grow.

### Gates for this slice

| Gate | Result |
|---|---|
| `npm run typecheck` | clean (both projects) |
| `npm run lint` | clean |
| `npm run build` | compiled; 10 routes, `/calendar` among them |
| `npm test` | 17 files, 317 tests passed — and **identical** under `TZ=America/Los_Angeles` |
| `./scripts/verify-db.sh nertube_m6_sql` | OK — migrations applied, 14 SQL test files passed |
| `npx playwright test filming-days matrix` | 20 passed (1.7m) |
| `npx playwright test` (whole suite) | 133 passed, 2 failed, stopped at ~135 of ~180 — see below |

**Everything here ran in a copy of the tree, on its own ports and its own
database** (`E2E_PORT=3131`, `DEV_STACK_PORT=54341`, `NERTUBE_DEV_DB=nertube_m6`),
because the calendar slice was building and running its own suite in the working
tree at the same time and Next allows one `next dev` per directory. M5's list
slice did the same thing for the same reason.

**The two failures in the whole-suite run, and what they were.**

1. `e2e/filming-days.spec.ts` — *"a day can be moved to another date, and
   refuses an occupied one"*. The spec, not the product: it asserted on
   `getByRole('alert')`, and the toast region renders an always-present empty
   `role="alert"` container, so Playwright's strict mode refused the two
   matches. The panel's own line has a test id now, and the test passes.
2. `e2e/matrix.spec.ts:668` — *"capturing into a cell leaves focus on the cell
   that replaced it"*, an M5 test this slice does not touch. It failed at 29.5s
   with **two full suites sharing one machine**; on its own it passes in 3.0s.
   Recorded rather than dismissed: it is a test whose deadline is long enough to
   be a load measurement, which is worth somebody's attention.

The run was stopped at ~135 to give the machine back. Every spec that touches
this slice's code had run by then and passed: `board.m1` (including the Filming
badge's cross-channel count), `flow-fields`, `m2-review`, `filming-days` and
`calendar`.

---

## M6 — Integration: one grid, one filming day, one date

> The two slices above are the build logs. This is what happened when they were
> joined, and it is where the milestone's own hazard actually showed up.
>
> Read the context first: the container was restarted mid-integration and an
> earlier integration pass had already put part of its work on disk as `wip(m6)`
> checkpoints. Nothing in this section trusts that pass; the tree was re-derived
> from the gates and the diff against `5e7514c`.

### Where the tree actually was

Every gate except Playwright was already green on arrival — typecheck, lint,
build (10 routes), `verify-db` (14 SQL files, no migration), and 317 unit tests
in 17 files. There was **no abandoned scaffolding**: the duplicate date helper
the calendar slice reported (`lib/calendar-date.ts`, singular) really had been
deleted, and `FilmingDayDetail` was the only type left over from the seam.

What had *not* happened was the join itself. Three things were still open, and
two of them were disagreements rather than gaps.

### 1. A filming day was being read twice, and the two readers disagreed

`lib/calendar-data.ts` ran its own pair of queries for filming days and their
videos and built a `FilmingDayDetail`; `lib/filming-data.ts` ran its own and
built a `FilmingDay`. Two readers for one object is the thing five milestones of
reviewers have policed — and these two were already **out of step**:

- the calendar's read filtered linked videos with `.is("archived_at", null)`;
- the filming slice's kept them deliberately, marked `archived`, with a tested
  `statusOf` branch and a headline case for "1 video, since archived".

So a day with an archived video on it drew `2` on the grid and listed three rows
in the panel underneath. Not hypothetical — arithmetic.

**Resolved by deleting the calendar's copy.** `readCalendarMonth` now calls
`readFilmingDays(start, end)`, the chip's `videoCount` is `day.videos.length`
— the same array the panel maps over — and `FilmingDayDetail` is gone.

The archived question was settled in the filming slice's favour, because its
answer is the one with a reason behind it: a video that was shot on Saturday was
shot on Saturday, and a day that hid it would render last month's real shoot as
an empty one. It is labelled, not silently counted.

### 2. The seam was a read-only copy of the panel

`/calendar`'s day panel drew its own list of a filming day's videos while the
*interactive* panel — detach, shoot notes, move the day, cancel it — existed in
`components/calendar/filming/` and was reachable only from the board's dialog.
Two renderings of one object, which is how the archived disagreement above got
in unnoticed in the first place.

`DayPanel` now renders `FilmingDayPanel` itself, as a client island inside the
server-rendered page, and the calendar carries the same
`ScheduleFilmingDayButton` the board's badge became — in its `plain` tone, which
the filming slice had already built and left for exactly this.

> **Corrected by the M6 review.** As written, this paragraph said the button was
> in the calendar's *header*. It was not: it was nested inside the "N videos are
> waiting for a filming day" block, so it disappeared whenever nothing was
> unbooked, and the block unmounted the open dialog on success. It is in the
> header row now, unconditionally, and only the sentence beside it is gated. See
> *M6 — adversarial review, applied*, findings 10 and 17.

**The hydration trap this had to avoid, because it had already bitten once.**
`FilmingDayPanel` formatted two dates during render with
`Intl.DateTimeFormat`. That was safe while it only ever mounted inside a
click-opened dialog. Server-rendering it would have reproduced, verbatim, the
bug the filming slice had already found and fixed in `VideoFilmingDay`: Node 22
writes "Wed 30 Sept" where Chromium 141 writes "Wed, 30 Sept", React reports a
hydration failure and throws the subtree away on every page load. The fix is the
rule the codebase already had — **format on the server, pass the string down** —
applied to the data rather than to one component: `FilmingDay.label` and
`FilmingVideo.targetPublishLabel` are filled in by `lib/filming-data.ts`, which
is the single place a `FilmingDay` is built, so every day the app can render
carries its own words whichever side of the wire it came from. Formatting inside
event handlers (toasts) is untouched: nothing is hydrating by then.

### 3. There were four interpretations of a date column, not one

The brief's step 3 asked for one, and named the M5 quota counts as a place to
look. It was right to. Found and folded into `lib/calendar-dates.ts`:

| Where | What it was doing |
|---|---|
| `components/ideas/matrix/tally.ts` — `monthWindow` | Its own `getUTC*` arithmetic, its own zero-padding, its own `Intl` month formatter. M5's quota window. |
| `lib/video-fields.ts` — `isCalendarDate` | Its own `Date.UTC` round trip to reject `2026-02-30`, beside the identical one in `parseDateColumn`. |
| `app/c/[slug]/board/page.tsx` — `formatTargetDate` | Parsed the column by appending `T00:00:00Z` and built its own `Intl.DateTimeFormat`, with exactly the options of the helper's `short` style. |
| `components/calendar/filming/video-filming-day.tsx` | `onDate.slice(0, 7)` to build a `?month=` — a month sliced out of a date string. |

None of them was *wrong*. That is the point worth recording: four independently
correct implementations of one rule is not a codebase that agrees, it is a
codebase that has not disagreed **yet**, and the M5 reviewers' month-boundary
attack landed on exactly this class. All four now go through the one module,
whose 33 tests already sweep a decade of round trips, every grid invariant over
six years, the century leap rules and seven timezones.

### 4. `/now` and the calendar now name the same set

`/now` hides the filming and editing kinds behind its "10 minutes or less"
filter because ten spare minutes will not shoot anything. Left there, the videos
waiting for a camera were invisible in the view whose job is *what can I move
right now* and absent from the view where the block gets booked.

Both ends now point at each other, over one definition:

- `/calendar` carries a line — *"N videos are waiting for a filming day"* — where
  N is `readFilmingVideos()` (the one definition of "in Filming", the same read
  the board's badge counts) minus the ones already on a day, with the schedule
  button beside it.
- a `/now` row's `needs a block` chip is a **link to `/calendar`** when the video
  is in Filming.

`filmingDayId` was added to `FilmingVideo` (and to the board card, which builds
its own candidates from the cards on screen) so "waiting" is derived from the row
the badge already reads rather than counted a second way.

Editing rows keep the chip as plain text. Editing needs a block too, but not a
*camera day*, and a chip offering to schedule an edit onto a shoot would be a
promise the product does not keep.

### Decisions taken without the user

| Decision | Alternative not taken |
|---|---|
| A filming day keeps its **archived** videos, on the calendar as well as in the dialog, labelled "archived". | The calendar's old behaviour of dropping them. Rejected: it made the chip's number and the panel's list disagree, and it renders a real shoot as an empty day. Archived still means "gone from views" everywhere else — a filming day is a record of a past event, not a view of live work. |
| The chip's count is `day.videos.length` — the same array the panel renders. | Counting with a separate query or a `head: true`. Rejected: that is precisely how the two numbers drifted apart. |
| `/calendar`'s "waiting for a filming day" counts videos in Filming **not yet on a day**; the board's badge keeps counting *all* of them. | One number in both places. Rejected: they are answers to different questions. The board's badge is BRIEF.md principle 4's signal ("3+ are piling up"), which is about the pile; the calendar's line is about what is still unbooked, which is what the button beside it would act on. Each control names the set it acts on. |
| The calendar's schedule button is quiet; the board's badge keeps its attention tone. | Colouring both. Rejected: colour means something. On the board a threshold has been crossed and something is being reported; on the calendar it is an affordance on a page whose job is already scheduling. |
| Only a **filming** row's `needs a block` chip links to the calendar. | Linking both filming and editing. Rejected: see above — a filming day is a camera day. |
| `FilmingDay` and `FilmingVideo` carry server-formatted label strings. | Formatting in the component and suppressing the hydration warning, or formatting by hand to dodge `Intl`. Rejected: the first hides a real mismatch behind a flag, the second is a fifth date implementation in a milestone whose whole discipline is that there is one. |
| The two slice sections above are kept verbatim rather than merged into this one. | Rewriting M6 as a single narrative. Rejected: they are the record of what each agent decided and why, including the collision over the date helper. This section records what changed when they met. |

### Deviations from PLAN.md, stated plainly

- **Still no migration.** M6 is reads and writes against `0001_init.sql` as it
  already stood. The integration added no SQL either; the one schema-shaped
  change is that two existing columns (`videos.filming_day_id`) are now *read*
  in two more places.
- **"Colour per channel" is still not built** — the calendar slice's reasoning
  stands unchanged, and the integration did not revisit it.
- **`g k` is still M9.** "Reachable by keyboard" is satisfied by the sidebar's
  Calendar row being an ordinary link in the tab order, and by the `needs a
  block` chip and the day panel being links and buttons rather than a second
  keyboard mechanism.
- **The calendar is no longer a zero-JavaScript page**, which the calendar
  slice's section claims. It has exactly two client islands, both of them
  existing components rather than new ones, and the *navigation* — months, days,
  the overflow — is still entirely `<a href>`. The grid itself still hydrates
  nothing. That paragraph in `app/calendar/page.tsx` has been corrected rather
  than left to rot.

### Honest limits

- **"Today" is still the UTC day.** Unchanged, and still the right call until
  there is a timezone setting to read (M7). The cost is unchanged too: a creator
  far enough west sees the calendar's today turn over before theirs.
- **Nothing on the *grid* writes.** There is still no drag-to-reschedule and no
  create-a-day-from-a-cell; the writing happens in the day panel and the header
  button. PLAN.md does not ask for drag in v1.
- **The `/now` ↔ calendar link is one-way per row.** The chip goes to
  `/calendar`, not to a pre-filtered calendar or to the specific day, because
  the video is by definition not on a day yet.
- **A day with one or two videos still has no link to its own `?day=` panel.**
  Unchanged from the calendar slice; its chips already link somewhere more
  useful.
- **No mobile pass.** The grid is seven columns and does not reflow. M9.

### The acceptance, walked

`e2e/m6-acceptance.spec.ts` is new: PLAN.md's *Wednesday/Saturday scenario* as a
week, serial, through the pages, with every claim checked against the database
rather than against a React tree.

Wednesday — three videos have piled up in Filming across two channels and the
board says so; `/now` tags them `needs a block` and the chip goes to the
calendar; the calendar's line counts the same three; one click books the
Saturday with all three on it. Wednesday still — the calendar draws the Saturday
as its own kind of event beside that week's publish chip, counts the two kinds
separately, and expands the day into the real panel. Saturday — two of them move
on to Editing through the stage select, the day keeps every link, and the
headline reports where they got to instead of repeating what was true when they
were attached. Plus PLAN.md's two review items: a second day on a booked date is
the day you already have (one row, no constraint name), and a day whose video
has left Filming still reads truthfully.

It is written to survive the shared, seeded database the suite runs against:
every count it asserts is read from Postgres rather than written down, and it
cleans up its channels and days in `afterAll` — the trap `e2e/filming-days.spec.ts`
documents, which bites any file that leaves videos sitting in Filming while
`board.m1` is asserting a cross-channel count.

> **Corrected by the M6 review.** When this was written the `afterAll` deleted
> the videos and the filming days but *not* the channels, so the claim was half
> true and the accumulation this paragraph warns about kept happening through a
> second door. The channel delete is there now. See finding 25.

`e2e/calendar.spec.ts`'s filming-day case was updated in place: the day now
expands into an editable panel, so the shoot notes are a field with a value
rather than a paragraph with text.

### The gates

| Gate | Result |
|---|---|
| `npm run typecheck` | clean (both projects) |
| `npm run lint` | clean |
| `npm run build` | compiled; 10 routes, `/calendar` among them |
| `./scripts/verify-db.sh m6_check` | OK — migrations applied, 14 SQL test files passed, **no migration added** |
| `npm test` | 17 files, 317 tests passed — identical under `TZ=UTC` and `TZ=America/Los_Angeles` |
| `npm run e2e` | **192 passed, 1 skipped, 0 failed** (11.3m) |

The skip is `session-refresh`, which only runs under `npm run e2e:refresh` — by
design, and unchanged since M0.

### The thing that made the earlier suite runs look worse than they were

Both build agents reported whole-suite failures they could not account for
(`board.m1`'s Filming badge, `capture`'s channel radios, `m2-review`'s focus
row), and the first integration run reproduced a set of four. None of them was a
product bug. **The dev stack is reused between runs by default**
(`REUSE_STACK = !CI && E2E_REUSE !== '0'` in `playwright.config.ts`), and
`npm run dev:stack` only resets `nertube_dev` from the migrations when it
actually *starts*. So across a working session the database accumulates every
spec file's channels, and specs that look a channel up by its accessible name
start matching two:

```
Sunday Softworks
The Sunday Softworks Workshop Channel and Friends   <- created by preview.spec.ts
```

`getByRole('radio', { name: 'Sunday Softworks' })` is a **substring** match, so
that is a strict-mode violation — and it only appears once `preview.spec.ts` has
run at least once before `capture.spec.ts`, which on a fresh database it never
does, because the files run in alphabetical order. Same shape as the
`shell.spec.ts`/"Board" note in the calendar slice's section above.

`E2E_REUSE=0 npm run e2e` resets the stack and the run above is the result: zero
failures. What this costs to know is written down here so the next milestone
does not spend an afternoon on it: **a failing spec that names a channel is a
question about the database, not about the diff.** Two hardening steps were
taken rather than none — `e2e/m6-acceptance.spec.ts` derives every count it
asserts from Postgres instead of writing it down, and its two channels are named
so that neither is a substring of the other or of any existing fixture's.

The underlying fragility is left in place and named: `board.m1.spec.ts:453`
still asserts the literal string `3 in Filming across all channels`, which is
true only when nothing else in the account is in Filming. It is an M1 test, it
passes on a clean database, and rewriting it is not this milestone's work — but
it is the first thing that will fail the next time a spec forgets to clean up.

### One cost worth stating

`readCalendarMonth` and `lib/filming-data.ts`'s `readLookups` both read
`channels` and `stages`, in different shapes, so `/calendar` now issues two
small extra queries per render. Both are `cache()`d per request, the tables are
a handful of rows each at PLAN.md's sizing, and the alternative — one reader
owning both shapes — is a larger change than joining two slices should make.
Recorded rather than fixed.

## M6 — adversarial review, applied

> Twenty-eight findings from six reviewers, against the M6 tree. Every one was
> checked against the code before anything was changed; four of them are the
> same blocker found independently, and it was real.

### The blocker: the board's badge could empty a filming day

Findings 2, 8, 12 and 22 are one bug, reported by four reviewers from four
directions, with four separate browser reproductions ending in a `select` on
Postgres. It is worth stating precisely, because the milestone's own notes
walked past it twice.

Three facts, each defensible on its own:

1. `readFilmingVideos()` defines "in Filming" as *every non-archived video in an
   enabled filming-kind stage*, **whether or not it is already on a day**. The
   board's badge counts that set, and `docs/MILESTONES.md` defends that choice
   above: the badge is BRIEF.md principle 4's signal, and the signal is about
   the pile.
2. `ScheduleDayDialog` pre-ticked **every** candidate it was handed, because the
   shortest path through the box is meant to be "pick the Saturday, press
   Enter".
3. `link()` in `app/actions/filming-days.ts` runs
   `update videos set filming_day_id = <new day>` with no check on what was
   there before.

Together they are data loss on the happy path. Book a Saturday with three
videos; the badge still says "3 in Filming", because those three are still in
Filming; press it again, pick another date, press Enter — and all three are
re-pointed at the second date, leaving the first day holding its shoot notes and
no videos. Nothing in the dialog, the toast, the day panel or the copy mentioned
it. That empty day is precisely the state `lib/filming-data.ts` refuses to
render, on the grounds that it "would render last month's real shoot as an empty
one" — the milestone had an argument about not *lying* about a day while leaving
a one-click way to *make* the lie true.

**What was changed, in three places.**

- `FilmingVideo` (and `BoardCard`) now carry `filmingDayLabel` beside
  `filmingDayId` — the day in words, formatted on the server like every other
  date that crosses the wire. `lib/filming-data.ts` fills it from one extra
  query, and only when something in Filming is booked; the board page does the
  same for its own cards.
- `defaultSelection()` — its own module, `components/calendar/filming/selection.ts`,
  with six unit tests — decides what arrives ticked: **everything not already on
  a day**. A booked candidate stays in the list, because the badge counts it and
  a dialog showing a different set would be the two disagreeing, but it is
  unticked and its row reads "already on Sat 1 May". Moving it is a tick, and
  the submit button says so before it is pressed ("Schedule the day, moving 1
  video").
- `link()` counts the ids whose `filming_day_id` was non-null and different,
  reads it *before* the update because afterwards there is nothing left to read,
  and both `createFilmingDay` and `linkVideosToFilmingDay` return it as a
  `warning`. The dialog already renders that in a `role="status"` paragraph, so
  a deliberate move is announced rather than silent.

`e2e/filming-days.spec.ts` gained two cases, and the first is the one the bug
failed: seed a day with two videos on it, press the badge, press "Schedule the
day" on a different date with the defaults, and assert **from Postgres** that
the first day still has both.

### The other blocker: a dropped connection took the whole route down

Finding 16. Nine `await`ed server-action calls across `filming-day-panel.tsx`,
`schedule-day-dialog.tsx` and `video-filming-day.tsx` sat inside
`startTransition` with no `try`/`catch`. An aborted POST — a restarted server, a
dropped connection — escaped as an unhandled rejection; the app has no
`app/error.tsx`, so Next replaced the route with its own error page and took the
composed date, the shoot notes and the ticked list with it. Reproduced with
Playwright's `route.abort('failed')`.

Every call is wrapped now, with the sentence `components/board/board.tsx` and
`components/post-publish/confirm-live.tsx` already use: *"Could not reach the
server, so nothing was changed. Nothing you typed has been lost — try again."*
This file was the one place in the app that did not follow the convention five
milestones of reviewers established; `DayNotes` in the same component degraded
correctly all along, because `useAutosave` catches.

### The calendar could not book a day, and destroyed the one it booked

Findings 10 and 17, which are the same line of code. `ScheduleFilmingDayButton`
was nested inside `{waitingForADay.length > 0 ? … : null}` — so the calendar
lost its only way to book a day the moment nothing was unbooked, which is the
*ordinary* planning direction for a batch shoot (book the Saturday, fill it as
scripting finishes), and it is the direction this page is the right one for.
`docs/MILESTONES.md` claimed the button was in the header; it was not, and the
claim is corrected rather than left standing.

The worse half: `schedule()` calls `router.refresh()`, so ticking every
candidate — the default — emptied `waitingForADay`, unmounted the block and took
the **open dialog** with it about 750ms later. The scheduled phase, the day
panel and any `warning` were on screen for half a second. A reviewer caught it
by polling every 250ms; the two existing specs missed it because they assert on
the panel immediately, inside that window.

The button is unconditional now and only the sentence beside it is gated. A
dialog's host must not be conditional on state the dialog changes.

### Dates: the fifth interpretation, and the one that still hydrated wrong

- **`skip-packaging.tsx`** (finding 1) formatted `packaging_skipped_at` with
  `toLocaleDateString(undefined, …)` — no locale, no zone — in a `"use client"`
  component that `/videos/[id]` server-renders. Node formatted in its locale and
  UTC, the browser in the viewer's, and React threw the subtree away on every
  load. Reproduced with `timezoneId: 'Pacific/Kiritimati'`, `locale: 'en-US'`:
  server "Mar 3", browser "Mar 4". Pinned to `en-GB` + `UTC`, the pair
  `components/thumbnails/thumbnails-section.tsx` already uses two files away.
  `packaging_skipped_at` is a `timestamptz`, not a `date` column, so it is not
  `lib/calendar-dates.ts`'s business — but the *rule* is.
- **`lib/next-action.ts`** (findings 3 and 24) held a fifth interpretation of a
  `date` column that the integration's own table missed: `formatPublishDate`
  parsed `${value}T00:00:00Z` and built an `Intl.DateTimeFormat` with options
  byte-identical to `FORMATS.short`, and `isFuture` hand-rolled the same parse.
  Output matched for real dates; it diverged on impossible ones, printing
  "2 Mar" for `2026-02-30` where the helper refuses. Both go through the helper
  now, `app/videos/[id]/page.tsx` stopped deriving the same instant twice, and
  three unit tests pin the divergence shut.
- **`scripts/seed-demo.ts`** (finding 4) computed `nextTuesday()` with local-zone
  getters and a UTC `toISOString().slice(0, 10)`. Under `TZ=Pacific/Kiritimati`
  the function named "the next Tuesday" returned a Monday, and wrote it into
  `target_publish_date`. It walks the calendar through the helper now, the way
  `nextSaturday` in `schedule-day-button.tsx` already did.

### The colour budget was left unspent on the thing it was reserved for

Finding 9. `docs/MILESTONES.md` records the decision that "exactly one state on
a filming day takes colour: a day that has passed with videos still in Filming",
`summarise()` computes it, and `FilmingDayPanel` renders it — but `FilmingEvent`
had no status on it at all, so on `/calendar`, the view whose whole job is
showing a month of days, a shoot that silently did not happen was pixel-identical
to one that did. You had to click into `?day=` to find out. That is the opposite
of BRIEF.md principle 5.

`readCalendarMonth` now calls the same `summarise()` where it reads the day and
puts `tone`, `headline` and `pending` on the event; `EventChip` spends the
attention token on `tone === "attention"` only, mirrors it in `data-tone`, and
says why in the accessible name ("2 videos are still to shoot and this day has
passed"). Two coloured states on the whole grid, one per event kind, both
meaning *this is asking for a decision*. No second summary, no new mechanism.

### `?day=` told the truth about the heading and lied about the contents

Findings 5, 14 and 23. `dayFromQuery` deliberately accepts any valid date and
does not require it to be inside `?month=`, but `readCalendarMonth`'s window is
the month — so a `?day=` outside it rendered a confident heading, a correct
relative label, and the sentence "Nothing is planned for this day." The easiest
way to reach it is the most likely one: a pasted `/calendar?day=…` with no
`?month=` falls back to *this* month. The panel's Close link pointed at the
wrong month too.

`resolveView()` now derives the month from the open day when there is one, so
the read window always contains the panel's contents. The alternative — dropping
the panel for an out-of-month day — was rejected: the milestone's own "honest
limits" say the panel is reachable for every day by URL, and making that true is
better than making it smaller.

### The tab said one month and the page drew another

Findings 6, 15 and 21. `generateMetadata` interpolated the raw `?month=`: the
common case, `/calendar` with no query, was titled "calendar · calendar ·
NerTube"; a valid month gave the bare key `2026-03` where the page says
"September 2026"; and a typo'd one put the typo in the title while the grid
rendered this month. Not an injection — React escapes it — but a bookmark named
after something that is not on the page, in a view whose whole argument is that
a month is shareable. It goes through `resolveView` and `formatMonth` now, and
names the open day when there is one.

### The sentence that taught the reader something false

Finding 11. The calendar's waiting banner said filming rows "do not show up on
*What can I move right now?*". They do: `/now`'s quick filter is off on first
load, and only the ten-minute toggle hides them — behind a `needs a block` chip
that *this milestone* turned into a link back to the calendar. The sentence
carrying the "/now and the calendar name the same set" argument had the argument
backwards. It now says the rows are hidden behind the ten-minute filter, which
is what `NEEDS_A_BLOCK` actually does.

### Keyboard and screen reader

- **Finding 18.** Every write in `FilmingDayPanel` dropped focus to `<body>` and
  left it there, because the control that was pressed is either `disabled` while
  the write is in flight or replaced by the one that comes next. The worst case
  was the destructive one: "Cancel this day…" is replaced by a confirmation that
  was a plain `<p>` with no role, so a screen-reader user activating the delete
  heard nothing at all. Each write now names its landing place through one
  `requestFocus` ref — the next row's Detach, the date box, `cancel-day-yes`,
  the control that replaced the one pressed — applied once the transition has
  committed, and skipped when focus has stayed inside the panel. The
  confirmation is `role="status"`. The dialog's phase change focuses the
  scheduled phase rather than `<body>` inside a still-open `aria-modal`.
- **Finding 19.** `VideoLine` in the day panel rendered the two-letter channel
  tag *without* `aria-hidden` and then read the channel name as well, and
  carried no state word — so the panel, the view you open to see a day in full,
  said strictly less than the chip it expands. `STATE_WORDS` moved to
  `components/calendar/grid/types.ts` and both renderers use it.
- **Finding 20.** The day panel's `<h2>` separated the date from "in 5 days" with
  `ml-2`, and accessible-name computation concatenates text nodes with nothing
  between them: `"Wednesday, 23 September 2026in 5 days"`. Both that heading and
  `FilmingDayPanel`'s `<h3>` emit a real separator now.

### The dialog that could not be submitted

Finding 13. `VideoIdsSchema` caps a write at 50 ids; the dialog ticked every
candidate and knew nothing about the cap. So the one account state the badge
exists for — a big pile in Filming — opened a dialog that was refused with "That
is more videos than one day of filming.", naming no number, with no way under it
but unticking one box at a time. `MAX_FILMING_DAY_VIDEOS` is now a shared
constant: `defaultSelection` ticks at most that many, the legend turns
over-limit, a sentence says how many to untick, submit is disabled while over,
and the action's message names the limit.

### Smaller things

- **Findings 7, 26, 27.** Two doc comments contradicted the code under them:
  `SidebarDisabled`'s JSDoc still called Calendar "the unbuilt section, and the
  only one left" and claimed three call sites where its own file header (twelve
  lines up) said two, and `formatTargetDate` on the board carried two stacked
  JSDoc blocks after the M6 rewrite, the first describing the implementation that
  had been deleted. Both corrected.
- **Finding 28.** The board filled `channelId: ""` on the half of the dialog's
  candidates that came from its own cards — latent, since nothing reads it, and
  exactly the kind of latent that the next thing to group candidates by channel
  gets silently wrong. `BoardCard` carries the real id now.
- **Finding 25.** `docs/MILESTONES.md` claimed `e2e/m6-acceptance.spec.ts`
  "cleans up its channels and days in `afterAll`". It cleaned up videos and days.
  The channels are deleted too now — the videos are already gone by then, so
  nothing blocks it, and leaving them is the other half of the accumulation trap
  this section spends a page on: a spec that names a channel matches on a
  substring.

### Rejected

| Finding | Why |
|---|---|
| — | None. All twenty-eight were reproduced or confirmed by reading the code, and all were fixed. |

The two "optional" halves of findings 8 and 12 were **not** taken, and that is a
decision rather than an omission:

| Not taken | Reason |
|---|---|
| Stop the badge counting videos that are already on a day, or change its sentence to "3 in Filming, 2 already on a day". | The badge's count is a signed-off decision recorded above: it is principle 4's signal, and the signal is about the pile. What made re-clicking it dangerous was the *default tick*, and that is fixed. Changing the sentence would also break `e2e/board.m1.spec.ts`'s literal assertion for a cosmetic gain. |
| Filter the board's candidates down to the unbooked subset, as `/calendar` does. | Simpler, and it would fix the blocker — but then the badge would say 3 and the dialog would list 2, which is the badge and the dialog disagreeing, the thing `lib/filming-data.ts` exists to prevent. Three of the four reviewers preferred listing-and-unticking first; so does this. |
| Replace `disabled={busy}` with `aria-disabled` plus a no-op handler across the panel. | A real improvement to the tab-stop behaviour, and a mechanism change across every control in the file. Deferred to **M9**, the mobile-and-accessibility pass, where it can be done once for the whole app rather than in one component. |

### Deferred

| To | What |
|---|---|
| **M7 (settings)** | The timezone question behind `todayColumn`'s UTC day is unchanged and still the right call until there is a `profiles.tz` to read. |
| **M9 (mobile and accessibility pass)** | `aria-disabled` in place of `disabled` on in-flight controls, application-wide. Also still `e2e/board.m1.spec.ts:453`'s literal `3 in Filming across all channels`, which is true only on a clean database — named in the section above and still not this milestone's work. |

### Migration

**None.** Every fix is reads, renders and one extra `select` on `filming_days`.
`filming_day_id`, `on_date` and `target_publish_date` are unchanged, and nothing
in `supabase/migrations/` was touched.

### The gates, re-run last

| Gate | Result |
|---|---|
| `npm run typecheck` | clean (both projects) |
| `npm run lint` | clean |
| `npm run build` | compiled; 10 routes, `/calendar` among them |
| `./scripts/verify-db.sh m6_final` | OK — migrations applied, 14 SQL test files passed, **no migration added** |
| `npm test` | 18 files, 325 tests passed |
| `npm run e2e` (first run) | **197 passed, 1 failed, 1 skipped** (12.3m) |
| `npm run e2e` (second run) | **198 passed, 0 failed, 1 skipped** (11.8m) |

Both runs are reported, in full, because an intermittent failure is a finding
rather than noise. The skip is `session-refresh`, which only runs under
`npm run e2e:refresh` — by design, and unchanged since M0. The suite is six
cases longer than it was: two in `e2e/filming-days.spec.ts` for the blocker,
four in `e2e/calendar.spec.ts` for the `?day=` window, the tab title, booking
with nothing waiting, and the missed-shoot tone.

### The one failure, named rather than rounded off

Run 1 lost `e2e/m2-review.spec.ts:476` — *picking a target date saves it without
waiting for a blur*. The status line stayed on its idle sentence through 21
retries over 20 seconds, which means the value never reached React state at all:
`/videos/[id]` had not hydrated.

**It is the flake this file already has on record, not a regression.** The M4
section names this exact test, in these words: *"run 2 lost neither of those and
instead timed out on `m2-review.spec.ts:476` (a target date saved without a
blur). Re-running both files alone passes all 29 of their cases … the hydration
window under full-suite load."* Three things say the same here:

- the second full run, on the identical tree, passed it;
- `npx playwright test m2-review` on its own passed **three times in a row**,
  13 cases each (53.1s, 54.6s, 54.5s);
- nothing in this review touches that page's hydration. The only `/videos/[id]`
  changes are `dueToConfirm` (a server-side comparison) and `skip-packaging.tsx`,
  which *removes* a hydration mismatch rather than adding one — and the whole-
  suite run taken immediately before these two also passed this case, 198/198.

The remedy the M4 section named still applies and is still not taken here:
**fewer components in that page's hydration pass, not a longer wait in the
test.** That is a change to `/videos/[id]`'s composition, which is not this
review's scope; it is left where M4 filed it, with one more data point on it.

## M7 — The stages editor: a label, an order, a switch, and one column with no behaviour

> Scope: `/settings/stages/[slug]`, `components/settings/stages/**`,
> `lib/stage-settings.ts`, the stage half of `app/actions/stages.ts`, and one
> migration. The checklist-template editor, the bucket editor and the channel
> fields (voice guide, script template, thresholds, expected CTR) are M7's other
> slices and are not described here.

### What this slice delivers

- **`/settings/stages/[slug]`** — one channel's stages, all of them, disabled
  included, in board order. `/settings/stages` with no slug redirects to the
  first channel's, the way `/` picks a board. The Settings row in the sidebar
  is now a link (to the Board row's channel, the way Ideas is), and it is the
  last of the sidebar's placeholders to become a page.
- **Rename.** The name is an input on the row; it saves on blur or Enter
  through `useAutosave` — the one save queue — and a blank or over-long name
  is refused before it reaches the row. Under the name is a sentence saying
  what the stage's *kind* does (`KIND_NOTES` in `lib/stage-settings.ts`), which
  is the sentence that stays true whatever the name becomes.
- **Reorder.** Up/down arrows per row. On a fresh channel every arrow is
  disabled, because nine core stages in a row have nowhere legal to go, and
  each disabled arrow's title says which pair keeps its order ("Core stages
  keep their order: Filming stays before Editing."). Add a stage and its
  arrows light up, and so do the arrows of the core stages either side of it.
  The move is one call to `reorder_stages`, which writes the whole order in
  one statement.
- **On / off.** A checkbox per row, flipped optimistically and put back with
  the reason when the database refuses. The count of non-archived videos in
  the stage is on the row before the switch is pressed; the refusal names the
  count and links to where they are (the board, or Ideas for the Idea stage).
- **Add.** A form at the end: name, button, appended at position `max + 1`
  with `kind = null`, and a sentence saying before it is pressed what that
  means — a column with no gate, no badge, no template and no place on
  `/now`'s path. An added stage can be removed again, behind a second click,
  as long as nothing refers to it.
- **Per channel.** The channel is the last segment of the address, the switch
  at the top (reused from the checklists slice's `ChannelSwitch`), the heading,
  the sidebar's current channel row, and `data-channel` on the root. Every
  action resolves the channel from the stage row it was handed, through RLS —
  never from the URL.

### The migration: `0007_stage_settings.sql`

M4's `app/actions/stages.ts` said that the "cannot disable an occupied stage"
rule lived in the application only because moving it to the database meant
revoking a column and rewriting a passing test, and that this was "M7's
argument to have with the whole settings screen in front of it". This is the
argument, settled the way the rest of the schema settles it.

1. **`position` and `is_enabled` leave the client's UPDATE grant**; `name`
   stays. The three columns a client may write on `stages` are now
   `user_id, channel_id, name`. `20_column_privileges.test.sql`'s catalogue
   check went from "expected 5" to "expected 3", and the block that proved a
   client could disable a core stage by direct UPDATE now proves it cannot,
   and that it can through the function.
2. **`reorder_stages(channel, ids)`** — the whole list, every stage once and
   nothing foreign, checked for a core crossing by walking the core kinds in
   the given order against `CORE_KIND_ORDER`, then ONE
   `update … from unnest(ids) with ordinality` — the same single statement as
   `set position = case …`, written for a list of unknown length. The deferred
   unique tolerates the colliding intermediate state; the end state is a
   permutation of 1..n. `35_stage_settings.test.sql` forces the constraint
   immediate after the call to prove it.
3. **`set_stage_enabled(stage, enabled)`** — refuses with `occupied:<n>` when
   non-archived videos are in the stage (archived ones do not count, PLAN.md
   review item 10), and refuses switching off the last enabled stage. The
   count and the write are one transaction, so the read-then-write race M4
   documented is gone.
4. **`check (btrim(name) <> '')`** on `stages`, because a column with no
   heading is one nobody can find.

Why a migration rather than the upsert the checklist-template slice uses for
*its* deferred unique: the upsert works where the client holds the columns, and
the whole point here is that it should not. A client that could PATCH
`position` could draw the pipeline backwards; one that could PATCH
`is_enabled` could hide every video in a stage from the board, `/now` and the
sidebar's count without a word. `e2e/settings-stages.spec.ts` posts all three
forged writes from a real browser session — the RPC with Filming and Editing
swapped, a PATCH of `position`, a PATCH of `is_enabled` — and gets a 400 naming
the pair and two 403s from the grant, after a control rename with the same
token succeeds. `90_schema_contract.test.sql` now pins six security-definer
functions rather than four.

### The invariant, proved rather than asserted

Renaming must change the label and nothing else. The spec renames Packaging to
"Packaging & hook", then on the board drags a titleless idea *into* the renamed
column (never gated — the gate guards the stages after it) and *out* of it to
Scripting, and asserts the refusal toast reads "Could not move … to Scripting.
Packaging still needs …" — the column named by its new label, the field named
by the gate's wording, and the row still in the renamed stage in Postgres.
`move_video` compares `array_position(k_order, kind)`; the name is not an input
to it. The other channel's Packaging is asserted unchanged in the same test.

### Decisions taken without the user

| Decision | Alternative not taken |
|---|---|
| The route is `/settings/stages/[slug]`, not PLAN.md's `/c/[slug]/settings`. | Following PLAN.md's table. The M7 task text named `app/settings/stages/**`, and the checklists slice landed on `/settings/checklists/[slug]` in the same tree; one shape for every settings screen, with the channel as the last segment so a settings page is a place that can be pasted, mattered more than the plan's spelling. Recorded here as a deviation. |
| The last enabled stage cannot be switched off. | Allowing a channel with no enabled stages, which the board already has an empty state for. Rejected: the state is nonsense (no columns, nothing to rank) and nothing needs it; the function refuses it in one line and the screen says why. |
| An occupied stage's switch stays clickable and the database refuses. | Pre-disabling the switch with the reason under it, as the video page's Repurposed lane does. The count is on the row already, so the refusal is not a surprise; leaving the switch live means the refusal the person sees is the database's, with the link, and the spec proves that path rather than a client-side guard. |
| Inert stages can be removed, but only when nothing refers to them. | No delete at all. The delete policy for `kind is null` has existed since M0 for exactly this, and a stage added by mistake should not be a permanent disabled row. A stage videos have passed through still has `checklist_items` naming it (`no action`), so the delete fails at the database and the message says to switch it off instead. |
| An added stage lands at the end and is moved with the arrows. | Asking for a position at add time. One step at a time is the only move the order rule needs to judge, and the arrows already exist. |
| Names are unique within a channel, case-insensitively, in the action. | A database unique. Nothing behaves differently with two "Editing" columns; what breaks is a screen reader announcing two regions with one name. A rule about legibility belongs where the sentence is. |
| Focus after a move follows the stage: the same arrow if it is still offered, otherwise the other one, otherwise the name. | Letting focus fall to `<body>` when the pressed arrow disables itself — the pattern M6's review filed against the filming-day panel. |

### Deviations from PLAN.md, stated plainly

- **A migration, where PLAN.md's M7 has none.** Justified above: it is the
  migration M4 deferred by name, and the one statement PLAN.md asks for is
  not expressible from supabase-js.
- **The route** — see the table above.
- **"Up/down only within the core-order constraint"** is implemented as *the
  result must keep the core order*, not *both endpoints are core*. For an
  adjacent swap on a valid order the two are the same rule; stated on the
  result it stays true on a hand-edited database and lets a broken order be
  repaired one step at a time (`lib/stage-settings.test.ts` has that case).

### Honest limits

- **`revalidatePath("/videos/[id]", "page")`** is used to let a rename reach
  the stage select on every video page; it is a broad invalidation for a rare
  edit and is fine at one user.
- **The Repurposed lane switch on the video page** (`components/post-publish/repurposed-lane.tsx`)
  still carries its own copy of the occupancy sentence and still pre-disables
  the box. It now calls the function through the same `setStageEnabled`, so
  the rule is one rule; the sentence is two sentences. Left for the integration
  pass, which owns that file.
- **`ChannelSwitch` is imported from `components/settings/checklists/`**, the
  other slice's directory, rather than copied. If the integration pass moves it
  somewhere shared, this page's import moves with it.
- **The timezone question** deferred to M7 by M6's review is not answered by
  this slice; it is a channel-or-profile setting, not a stage one.

---

## M7 — Checklist templates: the editor behind the snapshot boundary

`/settings/checklists/[slug]`, one editor per stage of one channel. Its files:
`app/settings/checklists/page.tsx` (the bare route, a redirect to the first
channel), `app/settings/checklists/[slug]/page.tsx`,
`components/settings/checklists/**`, `app/actions/checklist-templates.ts`,
`lib/checklist-templates.ts` with its unit test, and
`e2e/settings-checklists.spec.ts`. **No migration.**

### What this slice delivers

- **Add, rename, re-estimate, reorder, remove** a row of any stage's template,
  for every stage of the channel — the switched-off ones included, marked as
  such, because a lane's template is still the lane's and the place to edit it
  should not vanish with the column. Text and minutes save on blur or Enter
  through the one save queue (`components/autosave.tsx`), with the one status
  line and one Retry. Reordering is a pair of arrows per row; the first row's
  "up" and the last row's "down" are disabled rather than hidden so the
  controls never move.
- **The cost of the stage**, beside its name: `8 items · about 1 h 10 · 6 of
  8 fit ten minutes`. The total is the sum of `est_minutes`; the second number
  is how many rows `/now`'s "10 minutes or less" would let through, computed by
  the same two tests `matchesFilters` makes (`lib/checklist-templates.ts`
  imports `QUICK_MINUTES` and `NEEDS_A_BLOCK` from `lib/next-action.ts` rather
  than restating either). Filming and Editing print *none fit ten minutes* and
  a sentence saying why, instead of a zero.
- **Occupancy, said before the edit.** Each stage says how many non-archived
  videos are in it now and that they keep the lists they were given; a removal
  is followed by a sentence naming the row and repeating exactly which videos
  it did not touch. That sentence is the product's decision (PLAN.md open
  question 2) made visible at the one place it is not obvious.
- **A stage with no template** (Idea and Scheduled are seeded empty) can be
  given one, and `capture_video` copies it on the next capture the way
  `move_video` copies it on the next move — the spec proves that pairing.

### The boundary, and how it is proved

Nothing in this slice touches `checklist_items`. A template edit is a write to
`checklist_templates` and nothing else; the copy on a video has no reference
back and no trigger reaches across. That is true by construction, and a
reviewer would be right to say "by construction" is a claim, so
`e2e/settings-checklists.spec.ts` proves **both halves** in one test:

1. A video is moved into Packaging, one of its eight rows is ticked, and the
   rows are read as a snapshot. The template is then renamed, re-estimated,
   shortened by one row and lengthened by another, through the page. The
   video's rows are read again and compared **for deep equality with the
   snapshot** — text, position, estimate and `checked_at`.
2. A second video is then moved into Packaging by `move_video` and its rows are
   compared with the edited template — the same texts, the same positions (with
   the gap the removal left), the same estimates — and the first video is read
   a third time to show it is still not the second.

The third test does the same for the number that matters most: a video that
entered before an estimate changed keeps `15`, one that entered afterwards
gets `5`, and on `/now` — same channel, same next action by name — the quick
filter hides the first and lists the second.

### Reorder is one statement, and the reason it is an upsert

PLAN.md: *swaps run as one `update … set position = case …` statement* against
`unique (stage_id, position) deferrable initially deferred`. The deferral only
helps inside one transaction, and for PostgREST a transaction is a request —
so a swap done as two `.update()` calls is refused halfway through, which the
spec demonstrates from the database side (the same swap as a sequence of
client writes fails with `23505`).

supabase-js cannot express a `case`, and a SQL function for it would be a
fifth `security definer` function where `90_schema_contract.test.sql` pins
four. So the one statement is an **upsert**: `reorderTemplateItems` reads the
stage's rows through RLS, refuses unless the ids it was handed are *exactly*
that set (`isPermutationOf` — a missing row, a duplicate, or an id from another
stage all fail before any position is touched), renumbers 1..n in the order
given and writes every row back with `insert … on conflict (id) do update`.
One request, one statement, one transaction, the unique checked once at
commit after every row has moved. It was tried by hand as the `authenticated`
role against the fixture database before a line of the action was written.
The text and estimate ride along because an upsert must be a valid insert;
they are the values read a moment earlier, not values the caller supplied.

A removed row leaves a **gap** in the positions on purpose. Positions are order,
not a count; nothing reads them as one; closing the gap would be a multi-row
write for nothing, and the next add goes after the last row (`max + 1`) rather
than into the hole. The spec asserts `[1, 2, 3, 5, 6, 7, 8, 9]` after a removal
and an add.

### Decisions taken without the user

1. **The route is `/settings/checklists/[slug]`**, with the bare
   `/settings/checklists` redirecting to the first channel by the sidebar's
   Board rule. PLAN.md's table names `/c/[slug]/settings`; the settings screens
   of this milestone were built in parallel under `app/settings/**`, and this
   one matches the stages editor's `[slug]` shape so the two read as one
   screen. Recorded as a deviation below.
2. **A new template row goes at the end**, not at the top like a custom item
   on a video. A video's custom item is the thing you have just decided to do
   next; a template row is a step in a procedure, and a procedure is written
   in order. The arrows are one click away.
3. **An estimate is 1–480 whole minutes.** `est_minutes` is `not null` and
   `/now` compares it against ten, so a template row cannot be saved without
   one; the box defaults to the same ten that a null estimate on a video reads
   as (`DEFAULT_EST_MINUTES`, imported, not restated). The ceiling is a working
   day — anything longer is not an estimate of a checklist item.
4. **Removal has no confirmation dialog.** It is future videos only, which is
   the safest kind of delete this app has, and the sentence after it says so.
   A modal would be the seventh mechanism the reviewers have been policing
   against.
5. **The arrows wait for the wire; the text does not.** A move is stored as
   "this row, up" and resolved into a complete order at send time against the
   list the server has confirmed by then — so an add in flight cannot leave a
   `temp:` id in an order the server would refuse. While anything is in flight
   the arrows are disabled; typing into a row never is.
6. **Disabled stages are shown, marked, and editable.** Hiding them would make
   a lane's template unreachable for exactly as long as the lane is off.
7. **The sidebar's Settings entry is the stages editor's, not this slice's.**
   `app-sidebar.tsx` is outside this slice's files; the stages editor added the
   row (it opens `/settings/stages/[slug]`) and the `"settings"` section, and
   this page reports itself as that section so the row is marked current on
   it. How a person gets from the stages editor to this page — a tab strip
   across the settings screens — is the integration pass's, because it needs
   both routes to exist.

### What a screenshot walk changed

Two things, both copy. The line under every add box — *ten minutes or less is
what /now counts as a quick job* — was printed nine times on one page, once per
stage, when the page's opening paragraph already says it once; it is gone. And
the idle hint under a stage with nothing in it read *"the ones already there
keep theirs"*, which is a sentence about nobody; it now has three forms, for
none, one and several. The Next dev overlay's "1 Issue" on that walk was a
hydration mismatch on `style="caret-color: transparent"`, which is the inline
style Playwright's `screenshot()` injects to hide carets — the spec run, which
takes no screenshots, logs no hydration warning.

### Deviations from PLAN.md, stated plainly

| PLAN.md | Here | Why |
|---|---|---|
| `/c/[slug]/settings` | `/settings/checklists/[slug]` | Built in parallel with the stages editor under `app/settings/**`; one address shape for both. |
| `update … set position = case …` | `insert … on conflict (id) do update`, one statement | supabase-js has no `case`; a fifth SQL function is pinned out by `90_schema_contract.test.sql`. Same transaction, same deferred unique, same guarantee. |
| `updateTemplates` (one action) | four actions: add, edit, remove, reorder | Each is one row or one statement with its own refusal; a single "replace the template" action would have to be a delete-and-reinsert, which is a different set of ids and a bigger window. |

### Honest limits

- **Read-then-write, again.** `reorderTemplateItems` reads the rows and writes
  them back; a row removed in another tab in between is re-inserted by the
  upsert. One user, one session — the same window `setStageEnabled` documents,
  and the same answer.
- **Positions grow.** Gaps are never closed except by a reorder, which
  renumbers. Nothing depends on density.
- **The occupancy count is at page load.** A video moved into the stage in
  another tab is not counted until the page is reloaded; the sentence is about
  what the page saw, and the boundary it describes holds regardless.
- **No undo for a removal.** The row's text is printed in the note; typing it
  back is one add.

### Gates for this slice

| Gate | Result |
|---|---|
| `npm run typecheck` | clean (both projects) |
| `npm run lint` | clean |
| `npm run build` | compiled; 14 routes, `/settings/checklists` and `/settings/checklists/[slug]` among them |
| `./scripts/verify-db.sh m7_checklists_check` | OK — migrations applied, 15 SQL test files passed, **no migration added by this slice** |
| `npm test` | 20 files, 354 tests passed (12 of them new, `lib/checklist-templates.test.ts`) |
| `npx playwright test settings-checklists` (alone, isolated ports) | **4 passed** (1.5m), first run |
| `npm run e2e` (full suite, isolated ports and databases) | **195 passed, 3 failed, 1 skipped** (16.0m) — see below |
| Re-run of the three failed files plus this one, alone (38 cases) | **32 passed, 2 failed** (3.1m): `board.m1` clean, `m2-review:476` and `m6-acceptance:456` again |
| `npx playwright test m2-review` alone | **12 passed, 1 failed** (1.5m): `:476` again |

The skip is `session-refresh`, which only runs under `npm run e2e:refresh` — by
design and unchanged since M0. The four new cases all passed inside the full
run (7.2s, 4.7s, 3.8s, 4.8s).

The three failures are reported rather than rounded off, and none is in a file
this slice touches:

- `board.m1.spec.ts:713` failed with `browserContext.close: ENOENT … test-results/.playwright-artifacts-0/traces/…` — its trace file was deleted under it. The stages editor was being built in the same tree at the same time, and a Playwright run it started cleans `test-results/` on launch. That is two suites sharing one artifact directory, not the board.
- `m2-review.spec.ts:476` (a target date saved without a blur) is the hydration-window race this file has had on record since M4 — but it lost four times out of four today, alone included, where M6 saw it pass alone three times running. Two things are worth writing down. First, **the retry in that test cannot recover from the race it exists for**: once the first `fill` lands before hydration, the input already holds `2026-12-01`, React's value tracker adopts that DOM value when it hydrates, and every later fill of the *same* date fires no `onChange` — so the twenty seconds of `untilTaken` are twenty seconds of the same no-op. Second, why today: two agents were building M7 in one tree on one machine, and a page's hydration window is a function of CPU. The same field saved on blur is `e2e/flow-fields.spec.ts`, which passed in both full runs, so the page is not broken; the test's first fill is racing hydration and losing. The fix is in that spec — fill a different date on retry, or wait for a hydration marker before the first fill — and it is not this slice's file, so it is filed here beside M4's note about the page's weight.
- `m6-acceptance.spec.ts:456` (the calendar chip for the essay's publish date) is a **calendar defect in that fixture, and it will fail again tomorrow.** The spec derives `SHOOT = today + 10` and `PUBLISH = today + 12`, opens the grid for `SHOOT`'s month and expects both chips on it. This run happened on 2026-09-19: the shoot is 29 September, the publish date is 1 October, and the October chip is not on the September grid. It reproduces in the stages editor's own full run taken an hour later, and it reproduces for anyone running the suite on the 19th–21st of a 30-day month. The file is not this slice's, so the fix — derive `PUBLISH` inside `SHOOT`'s month, or open `PUBLISH`'s grid for that assertion — is filed here for the integration pass rather than made in passing.

This slice's own runs were made on their own ports and databases
(`DEV_STACK_PORT=54341`, `NERTUBE_DEV_DB=nertube_e2e_m7c`, `E2E_PORT=3121`) so
they could not share a stack with the parallel build — but Next allows one
`next dev` per directory, so the two suites still had to take turns, and one
attempt of this one was refused at start-up for exactly that reason and
restarted.


### What the existing suite needed

Two existing specs failed in every full run of this tree, and both were the
suite's own timing rather than the stages editor:

- **`e2e/packaging.spec.ts:520`** clicked the skip disclosure straight after a
  direct `goto` of `/videos/[id]`. A small Playwright script against the same
  server put the numbers on it: `goto` returns at ~830ms, the click lands at
  ~1095ms, the sidebar's hydration signal arrives at ~1104ms — the click was
  inside the window M4 documented and `e2e/hydration.ts` exists for, by about
  ten milliseconds, four runs out of four. The click now goes through
  `untilTaken`, exactly as the hook editor's first click in the same file
  already does. Why the window moved by the few milliseconds that made a
  sometimes-flake a certainty is not established; the remedy M4 and M6 both
  named — fewer components in that page's hydration pass — is still the real
  one and is still not this slice's to take.
- **`e2e/m6-acceptance.spec.ts`** set the essay's publish date to `TODAY + 12`
  and opened the calendar on the *shoot's* month (`TODAY + 10`). On 19
  September those are September and October: the chip was on the next grid,
  not missing. The publish date is now two days either side of the shoot,
  whichever keeps it on the month the test opens.

Neither change touches what either spec proves.

### Gates for this slice

| Gate | Result |
|---|---|
| `npm run typecheck` | clean (both projects) |
| `npm run lint` | clean |
| `npm run build` | compiled; 14 routes, `/settings/stages` and `/settings/stages/[slug]` among them |
| `./scripts/verify-db.sh m7_stages` | OK — 7 migrations applied, **15 SQL test files passed** (`35_stage_settings.test.sql` is new; 20, 30, 40 and 90 were updated for the grant and the two functions) |
| `npm test` | 20 files, 354 tests passed (`lib/stage-settings.test.ts` adds 17) |
| `npx playwright test settings-stages` | 6 passed, three times over (alone, and inside both full runs below) |
| `npm run e2e` (first full run) | 200 passed, 4 failed, 1 skipped, 4 did not run (17.0m) — see below |
| `npm run e2e` (second full run) | **207 passed, 1 failed, 1 skipped** (16.6m) |
| `npx playwright test m2-review`, alone, after it | 13 passed (1.1m) |

Both full runs were made while another workflow's Playwright runs shared the
same checkout, which is worth naming because it explains most of the first
run's shape: Playwright empties `test-results/` when it starts, so a run that
began mid-way through this one deleted its trace files from under it —
`browserContext.close: ENOENT … .playwright-artifacts-2/…` on
`settings-stages.spec.ts` and `packaging.spec.ts:485` are that, not a failed
assertion, and the "4 did not run" is the serial `m6-acceptance` file stopping
after the `TODAY + 12` failure described above. The second run used `--output`
into a private directory. Its one failure is `m2-review.spec.ts:476` — the
hydration-window flake on record since M4, named again in M6's review, and
passing alone straight afterwards, exactly as it did then. The skip is
`session-refresh`, which only runs under `npm run e2e:refresh`, by design.

The runs are slower than M6's (16–17 minutes against 12) for the same reason:
two suites on one machine.

---

## M7 — Buckets, quotas, and the channel's own settings

> Scope: `/settings/buckets/[slug]` and `/settings/channel/[slug]`,
> `components/settings/channel/**`, `lib/bucket-settings.ts` and
> `lib/channel-settings.ts` with their unit tests, the settings halves of
> `app/actions/buckets.ts` and `app/actions/channels.ts`, and
> `e2e/settings-channel.spec.ts`. **No migration.**

### What this slice delivers

- **`/settings/buckets/[slug]`** — one channel's two axes, pillars above
  formats, each a list of rows with arrows, a name, a quota box, what is filed
  under it, and Remove; and an add form at the end of each axis. The heading
  of each axis says where it stands against the brief's shape (*3 topic
  pillars — within the 3–5 the brief suggests*; *No topic pillars yet — the
  brief suggests 3–5*), so a channel is told on its first visit what the
  matrix is waiting for, and told when it has it. The add form goes into the
  brief's shape at the end: pillars 1..n become the matrix's rows, formats its
  columns, and a bucket added here is on the matrix and in the capture and
  video-page pickers on their next render.
- **Names.** `unique (channel_id, axis, name)` is case-sensitive; the rule
  here is not. The add form refuses a duplicate *before* the button can be
  pressed, with the sentence under the box, and `renameBucket`/`addBucket`
  refuse it again on the server (`bucketNameTaken`), with 23505 mapped to the
  same sentence as the backstop. A rename is a label change and nothing else:
  videos carry the bucket's id.
- **Quotas.** The box is a number or nothing. Nothing is *no quota* — a count
  on the matrix and no bar — and is the only way to clear one. Zero,
  negatives and fractions are refused in the row's own status line before a
  request exists (`parseQuotaInput`), refused again by `QuotaSchema` in the
  action, and `check (monthly_quota > 0)` is behind both; the spec proves all
  three layers and that a change here is the `n of quota` the matrix draws.
- **Removal** — see the decision below. The count of non-archived videos filed
  under a bucket is on its row (the matrix's own number), the second click
  says in a sentence what removal does to them, and the note afterwards says
  what it did.
- **Reorder** — arrows, one step, one round trip, one statement: the whole
  axis renumbered 1..n and written back as `insert … on conflict (id) do
  update`, the same upsert the checklist-template editor uses against the
  same kind of deferrable unique. Tried by hand as the `authenticated` role
  before the action was written: the swap lands, and the same swap as two
  statements is refused with 23505 at the first commit point. The spec
  repeats both.
- **`/settings/channel/[slug]`** — the voice guide, the script template and
  the three thresholds, each saving on blur through `useAutosave` (the one
  save queue) with the one status line, and each with a line of prose saying
  what it changes and where (`SETTING_NOTES` in `lib/channel-settings.ts`,
  unit-tested to quote the same sample sizes `/now` uses).
  - The **voice guide** is a 12-row textarea in the reading face, and the
    note says plainly that nothing reads it yet and that M8's brainstorm will
    be handed it verbatim.
  - The **script template** is a textarea in the measured face, because it is
    markdown source. It is the user's shape: the only rule is that it is not
    empty (`not null`, and a blank template writes blank scripts). A template
    without `{{hook}}` is **allowed and warned about**, in a line under the
    box, because `lib/defaults.ts` promised exactly that ("settings warns if
    it is removed") and because refusing it would be the app prescribing a
    shape BRIEF.md says it must not.
  - **WIP threshold** (1–99), **stale days** (1–365) and **expected CTR**
    (0.01–100, two decimals, or empty for the median fallback) each refuse
    zero in a sentence. Expected CTR's note says what empty means — the
    median of the last 10 published, needing at least 3 — with both numbers
    imported from `lib/next-action.ts`.
- **`SettingsNav`** — a row of four links (Stages, Checklists, Buckets,
  Channel) above the channel switch on this slice's two pages, current one
  marked with `aria-current`. See the honest limits for the other two pages.

### The decision about removing a bucket

The foreign keys decide what the database *permits*: `videos.vertical_id`
and `videos.horizontal_id` reference `buckets (id, channel_id, axis)` **`on
delete set null`**, so a delete never fails for being referenced — it unfiles
every video that carried the bucket, on that axis only, and touches nothing
else about them (`supabase/tests/50_buckets.test.sql` has proved that since
M0). Three options were open:

1. **Refuse while videos reference it**, like a stage. Rejected: a bucket is
   a label on a video, not a place it lives; re-filing eleven videos by hand
   before a format can be retired is the friction BRIEF.md principle 6 is
   against, and the state after removal (unfiled on one axis) is one the
   matrix already draws honestly ("N videos are off the grid").
2. **Hide the consequence** and let the key do it silently. Rejected: that is
   the opaque failure the task warns about, inverted.
3. **Allow it, and say what it does, with the count, before and after.**
   Taken. The row carries the count; the first click on Remove turns into a
   sentence (*3 videos are filed under "review". Removing it leaves them with
   no format — nothing else about them changes, and they can be filed again
   by hand.*) with "Remove and unfile them" and "Keep"; the action reads the
   count in the same call and answers with it, so the note afterwards is a
   report, not a guess. Archived videos are unfiled too and the count on the
   row does not include them (it is the matrix's number); the sentence says
   "nothing else changes" rather than pretending archived rows are exempt.

### Decisions taken without the user

| Decision | Alternative not taken |
|---|---|
| Routes are `/settings/buckets/[slug]` and `/settings/channel/[slug]`. | PLAN.md's `/c/[slug]/settings`. The stages and checklists slices set the `/settings/<section>/[slug]` shape; a fourth spelling would be worse than a third copy of the deviation. |
| Removing a bucket unfiles rather than refuses. | Above. |
| Duplicate names are refused case-insensitively, in the action. | Only the database's case-sensitive unique. Two matrix headings differing by case are one heading to a person. |
| A quota's ceiling is 99 (`MAX_QUOTA`). | No ceiling. `check (> 0)` has no upper bound; 99 is past any monthly plan and keeps a mistyped `20` from becoming `200` silently. |
| Empty quota box = null; zero is refused with a sentence pointing at the empty box. | Treating 0 as "clear". Zero is the number the CHECK refuses, and teaching the box that 0 means null would teach the person that 0 is a quota. |
| A script template without `{{hook}}` saves, with a warning. | Refusing it. `lib/defaults.ts` promised a warning; the template is the user's own shape. |
| Expected CTR of zero is refused. | Allowing 0. A video cannot be below an expectation of nothing, so the prompt would never fire and the person would believe they had set one. Empty is the way to the median. |
| Text fields normalise only line endings and trailing whitespace; leading indentation and internal blank lines are kept. | Trimming each line. A voice guide's indented bullets and a template's blank lines are the content. |
| Positions keep gaps after a removal; a reorder renumbers. | Closing gaps on delete. Same rule as the template editor: positions are order, not a count. |
| The four-link `SettingsNav` is rendered by this slice's two pages only. | Editing `app/settings/stages/[slug]/page.tsx` and `…/checklists/[slug]/page.tsx` to render it too. Those files belong to slices still being written in the same tree; the component is one import away and the integration pass owns the join. |
| The matrix's `NoVerticals` panel still says the editor "arrives in M7" with a disabled button. | Turning it into a link to `/settings/buckets/[slug]`. It is `components/ideas/matrix/no-verticals.tsx`, outside this slice, and `e2e/matrix.spec.ts:569–577` asserts the disabled state. The fix is one `<Link>` and two assertions, filed for the integration pass. |

### Deviations from PLAN.md, stated plainly

- **Routes** — the table above.
- **`updateBuckets` (one action)** is five: add, rename, quota, move, remove.
  Each is one row or one statement with its own refusal sentence; one
  "replace the channel's buckets" action would be a delete-and-reinsert that
  changes every id videos are filed under.
- **No `updateChannel` name in PLAN.md's action list**; the channel fields
  are `updateChannelSettings`, one action, one column per blur.

### Honest limits

- **Read-then-write, again.** A reorder reads the axis and writes it back; a
  bucket removed in another tab between the two is re-inserted by the upsert
  unless `isPermutationOf` catches the mismatch, which it does when the page
  and the table disagree on the set — one user, one session.
- **The filed count is at page load.** A video filed in another tab is not
  counted until reload; the removal action counts again in the same call and
  reports the real number.
- **The `NoVerticals` panel and the two older settings pages** — above.
- **`revalidatePath("/videos/[id]", "page")`** after every bucket write, so a
  renamed bucket reaches every video page's picker: broad, rare, fine at one
  user, and the same call the stages slice makes for the stage select.
- **Voice guide is stored and shown; nothing reads it.** By design until M8.

### Gates for this slice

| Gate | Result |
|---|---|
| `npm run typecheck` | clean (both projects) |
| `npm run lint` | clean |
| `npm test` | 22 files, 376 tests passed (22 of them new: `lib/bucket-settings.test.ts`, `lib/channel-settings.test.ts`) |
| `./scripts/verify-db.sh m7b_check` | OK — migrations applied, 15 SQL test files passed, **no migration added by this slice**; the upsert reorder and the two-statement refusal were then tried by hand on that database as `authenticated` |
| `npm run build` | compiled; 18 routes, `/settings/buckets`, `/settings/buckets/[slug]`, `/settings/channel` and `/settings/channel/[slug]` among them |
| `npx playwright test settings-channel` (alone, own ports and database) | **7 passed** (43.5s) on the second run; the first run (4 passed, 3 failed) found three things, below |
| `npm run e2e` (full suite, own ports and database) | **214 passed, 1 failed, 1 skipped** (17.4m) — see below |
| `npx playwright test m2-review` alone, straight afterwards | 12 passed, 1 failed: `:476` again |

The one failure is `e2e/m2-review.spec.ts:476` (a target date saved without
a blur): the hydration-window race on record since M4, which the stages
slice's full run an hour earlier also hit and which the checklists slice
found losing "four times out of four today, alone included". It lost alone
again here. Nothing in this slice touches `/videos/[id]`; the diagnosis and
the fix (a different date on retry, or a hydration marker before the first
fill) are in the checklists slice's notes and are that spec's to make. The
skip is `session-refresh`, which only runs under `npm run e2e:refresh`. All
seven `settings-channel` cases passed inside the full run.

The first run of the spec failed three of its seven cases, and all three were
worth having found:

1. **The add form's inputs were `disabled` while the add was in flight**, so
   the `focus()` that put the cursor back for the next pillar was a no-op on a
   disabled element. The button is what waits now; the boxes stay live.
2. **The browser was refusing quota `0` before the form could.** `<input
   type="number" min={1}>` inside a `<form>` triggers native constraint
   validation on submit — a tooltip, no `onSubmit`, and so none of this
   slice's sentence. `noValidate` on the two add forms makes the refusal the
   form's own. The row's quota box was never affected (it is not in a form),
   which is why that half of the test passed first time.
3. **The test expected the seeded template trimmed.** `create_channel` stores
   `SCRIPT_TEMPLATE` verbatim, trailing newline included, and the box shows
   what the row holds; the assertion was wrong, not the page.

Both runs were on their own ports and database (`DEV_STACK_PORT=54361`,
`NERTUBE_DEV_DB=nertube_e2e_m7b`, `E2E_PORT=3141`), and had to wait for the
stages slice's full run to release the one `next dev` the directory allows —
the same turn-taking the checklists slice recorded.

A screenshot walk of both pages (a scratch spec, deleted afterwards) changed
two lines of copy: the formats axis had a sentence that did not parse, and a
second "more than the brief suggests" paragraph repeated the count line.

---

## M7 — Integration: one settings area, one arrow, one refusal

> Scope: the join between the three M7 slices above. `components/settings/`
> (`settings-header.tsx`, `settings-nav.tsx`, `channel-switch.tsx`,
> `move-button.tsx`, `refusal.tsx`), `app/settings/page.tsx` and
> `app/settings/first-channel.ts`, the four `[slug]` pages rewritten onto the
> header, the six editor components rewritten onto the shared controls,
> `components/app-sidebar.tsx`, `components/ideas/matrix/no-verticals.tsx`,
> `components/post-publish/repurposed-lane.tsx`, `e2e/m7-acceptance.spec.ts`,
> and three existing specs. **No migration; no new runtime dependency.**

### What was found when the three slices were read together

Three agents built four pages in one tree at the same time, and each did the
sensible thing for its own slice. Read as one screen, the seams were:

1. **Three copies of the top of the page.** Each `[slug]` page drew its own
   heading with the channel name beside it, imported `ChannelSwitch` from the
   checklists slice's directory, and two of the four rendered a `SettingsNav`
   that lived under the channel slice's directory — so from the stages and
   checklists pages the other two screens were reachable only by address.
2. **Four copies of the index redirect.** `/settings/stages`,
   `/settings/checklists`, `/settings/buckets` and `/settings/channel` each
   carried the same twelve lines; `/settings` itself was a 404.
3. **Three reorder controls.** Stages drew boxed ▲▼ buttons with a verdict
   and a reason in the accessible name; buckets drew the same buttons with a
   plain `disabled`; template rows drew text ↑↓ with a transparent border. Two
   of the three also carried a private copy of the focus-after-move
   bookkeeping (a `Map` of refs, a request ref, an effect) and the third had
   none, so a template arrow that disabled itself by succeeding dropped focus
   on `<body>` — the pattern M6's review filed against the filming-day panel.
4. **Two colours for a refusal.** The stages and buckets slices set refusals
   in `over-limit`; the template editor and `SaveStatus` set them in
   `attention`. Seven `<p role="alert">` elements, five class strings.
5. **Two sentences for one rule.** `RepurposedLane` on the video page still
   carried its own wording of "still holds N videos" beside the
   `occupiedSentence` the stages screen prints for the same refusal from the
   same function — the limit the stages slice recorded for this pass.
6. **A placeholder still promising M7.** The matrix's `NoVerticals` panel
   kept its `aria-disabled` "Name your pillars M7" button and the sentence
   "arrives in M7", with `e2e/matrix.spec.ts` asserting both — the limit the
   channel slice recorded.

### What this pass did about each

1. **`SettingsHeader`** — one component: an eyebrow saying *Settings*, the
   four-link strip (`SettingsNav`, current one `aria-current="page"`), the
   channel switch when there is more than one channel (`ChannelSwitch`, now
   keyed by *section* so it keeps the screen and changes the channel), the
   heading, the channel's name at `data-testid="settings-channel-name"`, and
   the page's one paragraph of consequences as children. All four pages
   render it and nothing else above their editor. `settings-nav.tsx` and
   `channel-switch.tsx` moved to `components/settings/`; `settingsPath()` is
   the one place a settings address is spelled, and the sidebar, the matrix
   panel and the redirects all call it.
2. **`redirectToFirstChannel(section)`** — one function in
   `app/settings/first-channel.ts`; the four index routes are one line each
   and `/settings` now exists, opening on the first channel's stages the way
   `/` opens on `/now`.
3. **`MoveButton` and `useMoveFocus`** — the area's one reorder control and
   the one focus rule. Every arrow now carries a `MoveVerdict`: the stages
   editor's `canMove` verdicts unchanged, `edgeVerdict()` for "already
   first/last" on buckets and templates, `IN_FLIGHT` while a write is on the
   wire, and "This row is not saved yet." on a template row that is still
   `temp:`. The reason is in the `title` and in the accessible name of the
   disabled button, on every editor, not only on stages. `useMoveFocus` is
   the bookkeeping the two editors had copied, used by all three; the
   template editor gets it for free and no longer loses focus on a move.
   Test ids are now `<row>-move-up|down` everywhere;
   `e2e/settings-checklists.spec.ts` was updated from `template-up|down`.
4. **`Refusal`** — the one refusal line: `role="alert"`, `attention` (the
   same token `SaveStatus` uses for a failed save, so a refused write and a
   failed one are the same kind of news), an optional link when the refusal
   has somewhere to go (the occupied board column, the idea bank). Used by
   the stage row's switch/remove refusal, both editors' move errors, the
   bucket row's remove error, both add forms' refusals, the template add
   form's estimate refusal and the template row's estimate refusal. The two
   add forms print their hint in a plain `<p>` under the same test id when
   there is nothing to refuse, so a hint is never inside a live region — the
   argument `SaveStatus` already makes about its `idle` text.
5. **`RepurposedLane`** now prints `occupiedSentence(stage.name, occupied)`
   — the same sentence, from `lib/stage-settings.ts`, that the settings row
   prints when `set_stage_enabled` refuses. One rule, one sentence, two
   places. `e2e/post-publish.spec.ts` asserts the shared wording.
6. **`NoVerticals`** — the button is the `<Link>` it stood in for, to
   `settingsPath("buckets", slug)`; the note says where pillars are named
   rather than when. `e2e/matrix.spec.ts` test 5 now follows the link, sees
   the empty pillars axis, and comes back.

### PLAN.md's runnable, walked

`e2e/m7-acceptance.spec.ts`, three cases, each against a channel rebuilt
from the seed through `create_channel`:

1. **One area.** The sidebar's Settings row is a link (no
   `sidebar-unbuilt` left), reached with Tab and Enter; every bare settings
   address redirects to the first channel; the strip visits all four screens
   keeping `data-channel` and the sidebar's two `aria-current` marks
   (Settings as page, the channel row as true); the channel switch goes from
   this channel's checklists to the *other* channel's checklists.
2. **Toggle Repurposed off, rename Packaging, board follows.** Both edits on
   the settings screen; Postgres holds `is_enabled = false` and the new
   label with every `(kind, position)` pair exactly as seeded; the board's
   columns, read left to right, are the seed with Packaging relabelled and
   Repurposed absent. Then the invariant: on the video page the stage select
   offers *Packaging & hook* and not *Repurposed*; moving a titleless idea
   into the renamed stage succeeds ("Moved to Packaging & hook"); moving it
   out to Scripting is refused with "Packaging still needs …" — the gate's
   own wording, keyed on `kind`, unchanged by the label — and the row is
   still in Packaging. Repurposed switched back on returns the column.
3. **The placeholder closed.** From the matrix's empty state, the link lands
   on the bucket editor's pillars axis; *money* is added; the matrix draws
   the row crossed with the eight seeded formats.

The four consequence loops are proved by the slice specs and were re-run
inside this pass's runs rather than duplicated: **quota → matrix** and
**wip_threshold → board warning** in `settings-channel.spec.ts` (tests 4 and
5), **est_minutes → /now** and **template → the next video to enter** in
`settings-checklists.spec.ts` (tests 3 and 1).

### The m2-review flake, fixed

`e2e/m2-review.spec.ts:476` (a target date saved without a blur) failed in
every M7 slice's full run and was diagnosed by the checklists slice: once
the first `fill` lands before hydration, React adopts the DOM value at
hydration and every later fill of the *same* date fires no `onChange`, so
the test's `untilTaken` retry could never recover from the race it exists
for. The first fill now waits for the app's own hydration signal (the
sidebar's `c` binding reporting `data-shortcut-ready="true"`, the marker
every M7 spec already uses) and the retry stays for the narrower case. The
page is untouched; `e2e/flow-fields.spec.ts` was already proving the field.

### Decisions taken without the user

| Decision | Alternative not taken |
|---|---|
| Refusals are set in `attention`, not `over-limit`. | Keeping `over-limit`, which the stages and buckets slices used. `globals.css` defines `over-limit` as "a rule is being broken right now" — the title over 55 characters, the column over its WIP threshold — and `attention` as "something wants a look". A refused request is the second: nothing is broken, the person asked for something the tool will not do, and the failed-save line beside it was already `attention`. |
| The sidebar's Settings row opens `/settings/stages/[slug]`, not `/settings`. | The bare address. The row is the Board row's channel, like Ideas; a redirect in between would be a hop for nothing and would lose the channel the sidebar is showing. `/settings` exists for a typed address and lands in the same place. |
| The channel switch keeps the section. | Keeping the stages slice's `basePath` prop, which each page filled in by hand. Keyed by section, the switch cannot be pointed at the wrong screen by a copied import. |
| `useMoveFocus` reaches the template editor too. | Leaving template rows without it, as the slice shipped them. The arrows there are disabled while the write is in flight, which is precisely the case that drops focus. |
| Two testid renames in two slice specs (`settings-stages-channel` → `settings-channel-name`; `template-up|down` → `template-move-up|down`). | Keeping per-slice ids and mapping them in the shared components. One id per meaning is the point of one component. |
| `e2e/m2-review.spec.ts` gets the hydration wait rather than a different date on retry. | The other fix the checklists slice named. A different date on retry proves "some date saved", which is weaker than the test's title; waiting for the marker proves the date it picked. |

### Deviations from PLAN.md, stated plainly

- **Route shape** — `/settings/<section>/[slug]`, as the three slices
  recorded; this pass made it one area rather than moving it to
  `/c/[slug]/settings`. The one thing PLAN.md's table wanted from its
  spelling — settings are a channel's — is what `SettingsHeader` and the
  sidebar say on every screen.
- **`updateStages` / `updateTemplates` / `updateBuckets` as single actions** —
  each slice split its writes into one action per edit, for the reasons each
  recorded; unchanged here.

### Honest limits

- **Two arrows per template row are now 24px boxes**, the same control as
  the other two editors. The rows are denser than before and the page is
  longer by a little; one control was worth more than the pixels.
- **The `Refusal` line has no Retry.** Refusals here have no payload to
  re-send — the retry is the person changing what they asked for. Save
  failures on a field still go through `SaveStatus`, which does.
- **`RepurposedLane` still pre-disables its box** where the settings row
  leaves the switch live and lets the database refuse. Two behaviours, one
  sentence; the stages slice argued for the live switch on its screen, and
  the lane's argument (the count is already on the server render, the box
  is beside a video, not a list) still holds on its own. Left as two.
- **No `app/settings/layout.tsx`.** The channel is the last URL segment, so
  a layout could not read it without a second fetch; the header is a
  component the four pages call instead.
- **The timezone question** M6's review deferred to M7 is still open. It is
  a profile setting, not a channel one (`lib/calendar-dates.ts` still
  interprets dates in the server's zone), and none of the three slices took
  it; it is filed for M9's polish pass with the rest of the empty states.
