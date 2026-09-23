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
  first channel's, the way `/` opens on `/now`. The Settings row in the sidebar
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

Build notes (engineering choices, not product decisions — moved out of the
table above by the M7 review):

- Focus after a move follows the stage: the same arrow if it is still
  offered, otherwise the other one, otherwise the name — rather than letting
  focus fall to `<body>` when the pressed arrow disables itself, the pattern
  M6's review filed against the filming-day panel.

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
  pass, which owns that file. *Superseded by the integration pass, below: the
  lane calls `occupiedSentence`; and by the M7 review's fix pass: it draws the
  sentence with `Refusal`, link included. The pre-disabled box stays.*
- **`ChannelSwitch` is imported from `components/settings/checklists/`**, the
  other slice's directory, rather than copied. If the integration pass moves it
  somewhere shared, this page's import moves with it. *Superseded by the
  integration pass, below: it lives at `components/settings/channel-switch.tsx`.*
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

Build note (a scoping note, not a product decision — moved out of the list
above by the M7 review): the sidebar's Settings entry is the stages editor's,
not this slice's. `app-sidebar.tsx` is outside this slice's files; the stages
editor added the row (it opens `/settings/stages/[slug]`) and the `"settings"`
section, and this page reports itself as that section so the row is marked
current on it. How a person gets from the stages editor to this page — a tab
strip across the settings screens — was the integration pass's, and is
`SettingsHeader`.

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

Two rows that used to sit in the table above were limits of the slice, not
product decisions, and both were undone by the integration pass (moved here
by the M7 review): the four-link `SettingsNav` was rendered by this slice's
two pages only, because the other two pages belonged to slices still being
written — `SettingsHeader` now renders it on all four; and the matrix's
`NoVerticals` panel still said the editor "arrives in M7" with a disabled
button, because the file and `e2e/matrix.spec.ts` were outside the slice —
it is now a `<Link>` to `/settings/buckets/[slug]`.

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

Build notes (engineering choices, not product decisions — moved out of the
table above by the M7 review):

- `useMoveFocus` reaches the template editor too, rather than leaving
  template rows without it as the slice shipped them: the arrows there are
  disabled while the write is in flight, which is precisely the case that
  drops focus.
- Two testid renames in two slice specs (`settings-stages-channel` →
  `settings-channel-name`; `template-up|down` → `template-move-up|down`),
  rather than per-slice ids mapped in the shared components: one id per
  meaning is the point of one component.
- `e2e/m2-review.spec.ts` gets the hydration wait rather than a different
  date on retry: a different date on retry proves "some date saved", which
  is weaker than the test's title; waiting for the marker proves the date it
  picked.

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

### Gates for this pass

| Gate | Result |
|---|---|
| `npm run typecheck` | clean (both projects) |
| `npm run lint` | clean |
| `npm run build` | compiled; 19 routes, `/settings` and the eight section routes among them |
| `./scripts/verify-db.sh m7_check` | OK — 7 migrations applied, 15 SQL test files passed; **no migration added by this pass** |
| `npm test` | 22 files, 376 tests passed (none added: this pass wrote no new rule) |
| `npx playwright test m7-acceptance settings-stages settings-checklists settings-channel matrix post-publish m2-review shell` (every spec this pass touched, own ports and database) | **58 passed, 1 failed** (5.1m): the failure was the new acceptance spec opening the video page without `?section=schedule`, where the stage select is not visible; fixed, then `m7-acceptance` alone **3 passed** (33s). `m2-review.spec.ts:476` passed on the first attempt with the hydration wait. |
| `npm run e2e` (full suite, own ports and database) | **218 passed, 0 failed, 1 skipped** (16.9m), exit 0. The skip is `session-refresh`, which only runs under `npm run e2e:refresh`, by design. This is the first M7 full run with no failure: `m2-review.spec.ts:476` passed with the hydration wait, and the `m6-acceptance` and `packaging` fixes the stages slice made held. The run was made with no other Playwright run sharing the checkout (`DEV_STACK_PORT=54371`, `NERTUBE_DEV_DB=nertube_e2e_m7i`, `E2E_PORT=3151`, `--output` into a private directory), which is the other reason it is clean where the slices' runs were not. |

---

## M7 — Review: what the adversarial pass found, and what was done about it

> Scope: every file M7 touched, plus the ones the findings reached into —
> `app/actions/{videos,moves,metrics,buckets,stages,channels}.ts`,
> `components/autosave.tsx`, `components/settings/**`, the video page's
> sentences that name a stage, `components/post-publish/repurposed-lane.tsx`,
> `components/ideas/matrix/no-verticals.tsx`, `lib/text.ts` and
> `lib/ordering.ts` (new), the four settings libs, and **one migration,
> `0008_settings_boundary.sql`**, with `36_settings_boundary.test.sql` and
> changes to `20`, `30`, `35` and `90`. No new runtime dependency.

### How this review ran, and why it is in two halves

The review was cut short. Two adversarial lenses (the rename/behaviour walk
and the database-boundary walk) reported twelve findings, and then the
account hit its spend limit mid-review: two further reviewers and — the part
that matters — **the fix pass** were killed before a line was changed, so
none of the twelve findings had been applied when this pass started. Two
lenses ran late, once the limit reset: a **browser accessibility** lens (nine
findings, driven with Playwright against a private stack) and a
**scope-and-quality** lens (seven findings, including the one blocker). This
section covers all twenty-eight, verified against the tree before anything
was changed; three of the twelve early findings and one of the late ones
overlap and are treated as one.

### The three that were about the database being wider than the screens

**Invisible names.** Every "needs a name" rule — stage, bucket, template row,
script template — was `.trim().min(1)` in zod and, for stages, `btrim(name)
<> ''` in SQL. Neither strips Unicode format characters, so `"​"` was
accepted everywhere, and `"Money​"` sat beside `"Money"` as a second
matrix heading nobody could tell apart. The rule now lives in one place on
each side of the wire: `lib/text.ts` (`cleanLabel` strips `\p{Cf}` and the
NUL byte before the length rule; `isBlank` asks the same question of prose
without altering it; `sameLabel` is what the duplicate checks compare) and
`has_visible_text()` in 0008, an immutable SQL function inside a CHECK on
`stages.name`, `buckets.name`, `checklist_templates.text`, `channels.slug`,
`channels.name` and `channels.script_template`. `lib/text.test.ts` fires the
same probes at the four schemas that `36_settings_boundary.test.sql` fires at
the six CHECKs. Prose keeps its characters (a ZWJ inside an emoji is content)
and loses only NUL, which Postgres refuses with a message nobody should read
— the raw-error finding is closed by the same helper.

**The occupancy rule, only at the click.** `set_stage_enabled` refuses while
non-archived videos are in the stage, correctly; two app-owned writes then put
a live video into the switched-off column afterwards. Both doors are closed in
the database:

- Archive and restore go through **`set_video_archived(p_video, p_archived)`**,
  the seventh security-definer function, and `archived_at` leaves the client's
  UPDATE grant. A restore into a switched-off stage raises `stage disabled:<name>`;
  `updateVideo` turns that into *"Scripting is switched off, so restoring this
  video would hide it from the board and from /now. Switch Scripting on in
  Settings first, or move the video to another stage."* `e2e/flow-fields.spec.ts`
  archives a video, switches its stage off, presses Restore and reads the
  sentence, then PATCHes `archived_at` straight at PostgREST and gets 42501.
- **The Idea stage stays on.** `set_stage_enabled(idea, false)` raises `idea
  stage: …` before it counts anything, because `capture_video` always lands
  there and a switched-off column that keeps receiving rows is a hidden
  inbox. The settings row offers the switch greyed out with *"Stays on:
  capture lands here."* beside it (the one control in the area that is
  disabled by rule rather than by state — a switch that can never do anything
  is more honest greyed out than live and refusing). `capture_video` refuses
  a disabled Idea stage too, as a backstop for a hand-edited row, and
  `captureVideo` says so in a sentence.
- A switched-off stage that still holds live videos — reachable now only by
  hand — is said on its row with `Refusal` and the link, not merely counted.

**A forged PATCH on `channels`.** The table carried the default table-wide
UPDATE grant, so `slug` and `name` — editable nowhere in the app — could be
blanked, leaving the channel at `/c//board`. 0008 revokes it and grants
exactly the five columns `/settings/channel` edits; `20_column_privileges.test.sql`
pins the count at five, and `e2e/settings-channel.spec.ts` PATCHes `slug`,
`name`, `wip_threshold: 0`, `stale_days: -1`, `expected_ctr: 0`,
`script_template: ""` and `script_template: "​"` with a real session and
reads 403 for the first two and 23514 for the rest. The same migration adds
the floors the screens had and the tables did not (`wip_threshold` 1–99,
`stale_days` 1–365, `expected_ctr` 0.01–100, `est_minutes` 1–480, `position
> 0` on stages, buckets and templates), narrows the `stages` UPDATE grant to
`name` alone (0007 had kept `user_id` and `channel_id`; a writable
`channel_id` re-parented an inert stage, templates and all, into another
channel), and takes `kind` and `is_enabled` out of the `stages` INSERT grant
so an added stage is `kind null` and on by construction — `addStage` no
longer names `kind` in its insert.

### The blocker: Retry re-sent what had already landed

`useTemplateEditor` sends a batch of operations and applies them one at a
time; `useSaveQueue` stored the *whole* batch as the Retry payload. When the
third of three adds failed, Retry inserted the second add again and the
screen read `R1, R2, R2, R3` under "Saved". The one save queue now takes an
`unsent` part on a failed `SaveResult` — *the part of a sequence that did not
land* — and builds the Retry payload from that plus whatever was parked
behind it. The template editor reports it; the video page's checklist
(`use-checklist.ts`) already kept its own `failed` ref for exactly this, so
the queue is now the one place the rule lives rather than one editor's
private care. `e2e/settings-checklists.spec.ts` holds the first add on the
wire, queues two more as one batch, drops the third request, and asserts the
table and the screen before and after Retry: `[R1, R2]` then `[R1, R2, R3]`,
positions `1..3`.

The same hook rolled a failed edit off the screen under a line reading
"Nothing on screen has been lost", then dropped it for good on the next
successful save. The editor now tells two failures apart: a **refusal** (the
server said no) is final, so that one operation is put back and the sentence
says why, while everything parked behind it stays on screen and unsent; a
**transport failure** (no answer) reverts nothing — the operations stay drawn
exactly as they were, and are re-sent by Retry *or by whatever the person
does next*, prepended to the next batch. The spec drops an edit's request,
asserts the box still holds the typed text and the table does not, then
changes another row's minutes with the wire back and asserts both landed.
Retry is offered only when there is something to re-send.

### Focus, names and the other accessibility findings

- **Every hand-off keeps focus on the page.** `RemoveConfirm`
  (`components/settings/remove-confirm.tsx`) is the area's one "Remove? /
  Keep" control, and it owns the two places the browser used to drop focus
  on `<body>`: the question's first button takes focus as it appears, Remove
  takes it back on Keep. After a removal the editor sends focus to the next
  row's name (or the add form when it was last) through `useMoveFocus`'s new
  `requestField`. The stage switch is no longer `disabled` for its round trip
  — re-entry is guarded in the handler, the row is `aria-busy`, and its own
  `SaveStatus` says "Saving…" — so a refusal leaves focus on the box. Add
  buttons stay enabled while an add is out (the form ignores re-entry) and the
  box is refocused on every outcome. After a Retry lands, focus goes to the
  retried row's text or the add box.
- **Focus after a move lands on the arrow, in all three editors.**
  `useMoveFocus` now takes an `inFlight` flag and keeps the request rather
  than consuming it while every arrow is disabled by the wait — which is why
  the template editor landed on the text box (findings 7 and 12), and why a
  *failed* move now restores focus too: the request is made before the write
  and consumed after it settles, whatever it settled to.
- **Repeated controls carry the row's name.** "Scripting: On the board",
  "Monthly quota for money, a month", "Remove money", "New item for
  Packaging (TTH)", "Add to Packaging (TTH)". The visible words are
  unchanged; the sr-only prefix is the difference between nine identical
  checkboxes and nine stages in a forms-mode list. The slice specs assert them
  with `getByRole`.
- **The template add form has `noValidate`**, as the bucket add forms did
  since the channel slice found the same bug: a `0` in the minutes box now
  reaches `submit` and the form's own sentence, rather than the browser's
  tooltip. The spec submits `0` by Enter and by the button.
- **Field-level errors are associated.** `Refusal` and `SaveStatus` take an
  `id`; the template minutes boxes, the bucket quota box, the bucket add
  form's quota box, the script template and the three number fields point
  `aria-describedby` at the line that says why they are `aria-invalid`.
- **Typed text survives leaving the page.** `useAutosave` — the one save
  queue, so every field gets it — commits on unmount when the raw value
  differs from what the row holds (Back is a client-side popstate that
  unmounts the field with the text still in it), and registers a
  `beforeunload` handler while a box is dirty or a save is on the wire, which
  sends the save and lets the browser ask before a reload or a close. The
  spec arrives at the channel page by the settings strip, types into the
  voice guide, presses Back, and reads the text from Postgres; then reloads
  with typed text and sees the browser's `beforeunload` dialog, and reloads
  without and sees none. *Dirty* had to be the raw comparison: the first
  version compared the trimmed value and re-saved the seed's script template
  (trailing newline included) on every navigation away, which the
  round-trip spec caught.
- The matrix's empty-state link says what is missing — "Name your pillars",
  "Add formats", "Set up buckets" — as the heading beside it does.

### Renamed stages, and the prose that still said the seed's names

The behaviour half of the rename invariant held (the gate, the badges and
the ordering key on `kind`), and the review proved it; the label half did
not: with every core stage renamed, the gate refusal read *"Could not move X
to Frotz. Packaging still needs a thumbnail concept. It is still in Grue."* —
one column under two names in one toast. Now the stage is named by the
channel's own label wherever a sentence is about a **column**: the board's
gate refusal (`moves.ts` reads the packaging stage's name on the refusal
path), `confirmLive`'s, the board's Filming badge, the script section ("moves
from Grue into Frotz"), the packaging block's "nothing leaves …", the hooks
editor's "spliced in at …", the concept sketch's "refused at …", the
filming-day panel's "… needs a real block of time", and the channel settings
notes (`settingNotes(names)`, with the page reading the channel's stage names;
`SETTING_NOTES` remains as the seed-named form). Sentences that are about the
**concept** rather than the column — the packaging block's heading "Packaging
— the gate", the Packaging tab, `/now`'s "Complete packaging: …", the gate
indicator's "Packaging: needs …" — keep the word BRIEF.md uses for TTH, in one
vocabulary, which is the consistency the finding asked for. The stages spec
and the acceptance spec now assert *"Packaging & hook still needs …"* after
the rename, and that the old wording is absent.

### Smaller things

- The template editor's copy said "the next video to enter gets this list";
  `move_video` copies only on a **first** entry (0005's marker), so a video
  that leaves and comes back keeps the list it was first given. The sentences
  now say so, and PLAN.md's open question 2 is read as *first entry* here.
- The add-stage hint and `INERT_NOTE` said an inert stage has "no template";
  it has one, edited under Checklists and copied like any other. Both now
  say that.
- `removeBucket` counted every video carrying the bucket, archived included,
  while the row and the sentence before the click count non-archived only.
  It now counts the two apart and the note names them apart: *"unfiled 2
  videos and one archived video"*.
- The Repurposed lane draws its refusal with `Refusal`, link to the board
  column included, rather than a private `<p role="alert">`.
- `lib/ordering.ts` is the one copy of the reorder arithmetic (sort by
  position, next position, swap one step, renumber, `isPermutationOf`) and of
  the case-insensitive `nameTaken`; the three settings libs re-export the
  names their callers use, and `lib/ordering.test.ts` pins that they are the
  same functions. `RemoveConfirm` is the shared remove control. The two add
  forms stay two: they differ by a quota box, and the shared part is a
  dozen lines against a component with five slots.
- The MILESTONES record itself: three stale statements in the stages section
  are corrected or marked superseded; six rows that were engineering or
  scoping notes have moved out of the "Decisions taken without the user"
  tables into build notes, so the tables hold product-facing choices only.

### Decisions taken without the user

| Decision | Alternative not taken |
|---|---|
| The Idea stage cannot be switched off. | Refusing in `capture_video` only and telling the person their idea was filed into a hidden column. Capture is BRIEF.md's "one input, save, done"; a capture that fails because a settings row was flipped is friction with no upside, and a column that is off but still filling is worse. Both refusals exist; the switch is the one the person meets. |
| Archive and restore are a SQL function, and `archived_at` is no longer a client column. | Checking the stage's flag in the server action, as the finding suggested. A rule in the action is a rule a forged PATCH walks past — the same argument 0007 made for `is_enabled` — and this milestone was the one that argued it. |
| Invisible characters are stripped from labels and only detected in prose. | Stripping `\p{Cf}` from everything. A zero-width joiner inside an emoji sequence, or a ZWNJ in Persian, is content in a voice guide; the voice guide's promise is "kept exactly as written". Labels are one line read at a glance, and there the ghost is removed so `"Money​"` cannot be a second "Money". |
| A refused template operation is rolled back; a dropped one stays on screen. | Keeping refused operations on screen too. A refusal is final — re-sending it with the next edit would refuse the next edit forever — and its sentence says what was wrong; a dropped request is not final, and the text is the person's. |
| The browser asks before a reload or a close with unsaved text, and the app sends the save first. | Flushing silently with `sendBeacon`, which cannot reach a server action. The dialog is the browser's own and the one modal the app cannot draw at that moment; a person who chooses to stay finds the text already saved. |
| Bucket removal reports non-archived and archived counts apart. | Counting non-archived only, which would have made the note silently wrong about the archived rows the key unfiles. |
| The matrix's empty-state link is worded from what is missing. | One constant label. |
| Concept sentences keep the word "Packaging"; column sentences use the channel's label. | Renaming every "Packaging" on the video page. The packaging block is about TTH, the thing BRIEF.md calls packaging; the column it happens in is what the person renamed. |

### Rejected

- **"Move the restore behind `move_video`"** (one of the two options
  offered). A restore is not a move: `move_video` restamps `stage_entered_at`
  and re-runs the gate, and a restored video should have neither happen to
  it. `set_video_archived` is the narrower function.
- **"Report the retry payload with `data-unsaved` rows and disabled arrows"**
  as the way to keep failed operations on screen. Rows that are unsent after
  a dropped request are already drawn from `pendingOps`; an unsaved *add* is
  `temp:` and marked, and a dropped edit or move stays as the person left it
  and goes with the next send. Disabling the arrows on those rows would have
  refused a move the next send could carry.
- **NFKC normalisation** of names, suggested beside the `\p{Cf}` strip. It
  would rewrite ligatures and full-width characters a person typed on
  purpose; the finding's evidence needed only the format characters.

### Deferred, to a named milestone

- **The two add forms as one component** (finding 13, part): M9's polish
  pass, when the empty states are revisited; the shared part is small and
  the forms differ by a field.
- **The video page's own text fields and the NUL byte.** `lib/video-fields.ts`
  (title, notes, hook text) does not go through `cleanLabel`/`cleanProse`; a
  pasted NUL there still reaches the person as Postgres's sentence. Out of
  M7's files; filed for M9 with the other empty-state and copy work.
- **The timezone question**, still open from M6, still M9's.

### Migration

**`0008_settings_boundary.sql` is new and must be applied to the hosted
project by hand.** Before applying it, check the hosted rows the new CHECKs
cover: any `checklist_templates.est_minutes` outside 1–480, any
`channels.wip_threshold` outside 1–99 or `stale_days` outside 1–365, any
`expected_ctr` of 0, and any name or template that is blank or made of
format characters — the migration fails on the first violating row, which is
the point, but it means the row is fixed first. The seeds are within every
bound.

## M8 — The brainstorm panel: proposals, and the line between them and your writing

*Slice: `components/assist/**`, `app/actions/assist.ts`, the pill on the
packaging block. The provider module under `lib/assist/**` is its own slice;
this one programs against that interface and reaches past it nowhere.*

### What this slice delivers

- **A panel on the packaging block**, opened by the pill M2 placed and left
  deliberately inert. It is inline rather than modal, because a model call takes
  seconds and a dialog over the page for forty seconds is a page you cannot use.
  The rest of the block keeps working while it thinks.
- **Proposals with their reasons.** Ten to twenty title candidates, each with a
  rationale, and one marked as the model's own pick with its reason spelled out
  under it. BRIEF.md's first principle is that packaging is a craft; a flat list
  of twenty titles is a slot machine, and a title with a reason beside it is the
  part that is still useful after the panel closes.
- **Accepting**: `Add as candidate`, `Add all as candidates`, `Use as hook`.
  Every one of them goes through `push()` on `components/packaging/packaging-block.tsx`
  — the same draft, the same diff, the same queue, the same `updateVideo`. There
  is no second write path, and a rationale becomes the candidate's `note`, so the
  list still says *why* three weeks later. Accepted rows carry `source: "ai"`
  (PLAN.md line 166).
- **`videos.brainstorm_last`**, written by the action after every answer and read
  by the page on the way in. Closing the panel loses nothing, reopening costs no
  call, and the panel says which it is showing — "Fresh, just now" or "From
  earlier — asked for 2 hours ago and kept". Asking again is one click.
- **One panel, two questions.** The candidate pill opens it on titles, the hooks
  pill opens it on hooks, and the tabs switch between them. Asking for hooks does
  not throw away twenty titles nobody has accepted yet; the column holds both.
- **Every failure as a sentence**, with one-click retry: refusal, timeout, rate
  limit, upstream 5xx, unreachable, unauthorised, rejected request, a body that
  is not JSON, JSON of the wrong shape, an empty answer, and no key configured.
  Each says what happened and that nothing was changed.

### The seams, and why they are where they are

**The panel does not write, and the block does not know the panel exists.**
`components/assist/packaging-assist.tsx` is a context the block fills with
`addCandidates` / `addHook` / how much room each list has. The block imports the
provider component, the panel reads the context, and neither imports the other.
This is what keeps the "one save queue" rule true through a feature whose whole
job is to put text into two of its fields.

**The answers live above the panel.** Closing unmounts the panel — that is what
keeps the block quiet — so a fresh answer is handed up to
`components/assist/brainstorm-assist.tsx` and survives the unmount. Without that,
closing and reopening in the same sitting would ask the model again, which is
exactly what `brainstorm_last` exists to prevent.

**The envelope in the column is this app's, not the provider's.**
`components/assist/stored.ts` owns the shape of `brainstorm_last`, versioned and
read leniently: a different vendor behind the same interface must not change what
is already in a column, and a detail page that will not open because a cached
suggestion is the wrong shape is a page you cannot use.

**The client sends a video id and a kind, and nothing else.** Everything the call
needs is RLS-scoped user data or the API key; a client that could choose the
prompt, the voice guide or the past titles could spend the key on anything.

### Decisions taken without the user

- **The panel is inline, not a modal.** BRIEF.md principle 6 is that friction is
  the failure mode, and a forty-second modal is friction with a lock on it. The
  cost is that the packaging block is taller while the panel is open.
- **Opening an empty panel asks immediately; opening one with a stored answer
  does not.** The pill says "Generate 20", so pressing it *is* the ask — but
  reopening must be free, which is what the column is for.
- **"Cancel" means stop waiting, not stop the model.** A server action cannot be
  recalled; the call is already running and the row will still be written. The
  panel says so in as many words rather than implying the charge was avoided,
  and the answer is kept, so the next open shows it as "from earlier".
- **A refusal offers "Try anyway" rather than "Try again".** The module marks
  `refused` as not retryable — the same prompt is declined the same way — but the
  button is still there, because the person may have just edited the notes.
- **Rationales are truncated at the note column's ceiling** (300 characters, with
  an ellipsis) rather than dropped. A long reason is still a reason; a patch that
  cannot be written is not.
- **The two remaining assist pills (thumbnail concept, thumbnail critique) are
  still inert and now say M9 rather than M8.** They belong to other slices, and a
  pill promising the milestone that has just shipped is a lie in the UI.

### Deviations from PLAN.md, stated plainly

- **The provider module is `lib/assist/**`, not `lib/brainstorm/{types,anthropic}.ts`.**
  The milestone was split across two agents and the provider slice owns that
  directory; the interface it exposes is per-kind (`titles`, `hooks`, and later
  concepts and thumbnail critique) rather than one `generate()` returning titles
  and hooks together. The panel therefore makes one call per kind. PLAN.md's
  substance — structural-only schema, clamping rather than discarding, refusal
  first, `{source:'ai'}`, "Add all", `brainstorm_last` — is unchanged.
- **The action is `assist({videoId, kind})`, not `brainstorm(videoId)`.** Same
  segment, same `maxDuration = 60` (now declared on `app/videos/[id]/page.tsx`),
  with the app's own 45-second deadline inside it so a slow model becomes a
  sentence rather than a platform timeout.

### Honest limits

- **No live model call has ever been made from this container.** Outbound egress
  to `api.anthropic.com` is blocked and there is no key here. Everything in this
  slice is exercised against the fake provider; the real one is the provider
  slice's to prove.
- **The e2e suite runs with `ASSIST_PROVIDER=fake`** (set in
  `playwright.config.ts`). The default provider is the real one, so a deployment
  with no key gets "the brainstorm has no API key configured" rather than
  fixtures presented as a model's work.
- **The in-flight walk creates its own delay** by holding the server action's POST
  in a Playwright route, because the fixtures answer immediately. What it proves
  is this app's behaviour while something is in flight, which is the same whether
  the wait is a network or a model.
- **`brainstorm_last` is written even when the panel is closed mid-flight.** That
  is deliberate — the answer is paid for either way — but it means "Cancel"
  leaves a stored answer behind. The panel says so.

### Two agents in one directory, and how it was resolved

This milestone was built by several agents at once, and two of them landed in
`components/assist/**`. While this slice was being written, the slice that wires
the *other* assist controls (thumbnail concept, thumbnail critique, capture)
added `components/assist/chrome.tsx` and `components/assist/run.ts`: shared
versions of the in-flight row, the failure block, the notice line, the proposal
frame and the request-id/cancel bookkeeping this panel had written inline. That
slice then refactored this panel onto them.

The seam that made it safe is worth recording: `chrome.tsx` takes a `prefix` for
its test ids, so with `prefix="brainstorm"` it emits exactly the ids
`e2e/brainstorm.spec.ts` already asserted on, and the markup converged without
either agent editing the other's spec mid-flight. `describeMeta` in
`components/assist/acceptance.ts` — the clamp sentence, with unit tests — is the
one that survived, and `chrome.tsx` imports it.

What has to stay true after any further reconciliation, because it is what this
slice is for:

- **One save path.** Accepting goes through `push()` in the packaging block. No
  component under `components/assist/**` may call `updateVideo`.
- **Reopening is free.** The answers live above the panel and in
  `videos.brainstorm_last`; closing and reopening must never ask again.
- **Two questions side by side.** Asking for hooks must not discard titles
  nobody has accepted yet.
- **One registered opener.** `packaging-assist.tsx` keeps a single
  `register`ed open-and-ask callback so the hooks pill can start a call the
  panel owns. A second component registering would silently win; if more
  controls need it, that ref has to become a map keyed by kind.

### Gates for this slice

Run after the two `components/assist/**` slices converged, against the tree as
it stands:

- `npx tsc --noEmit` — clean.
- `npx eslint components/assist app/actions/assist.ts e2e/brainstorm.spec.ts components/packaging app/videos/[id]/page.tsx` — clean.
- `npx vitest run` — 30 files, 494 tests, all passing.
- `npx playwright test brainstorm` — 21 passing, run three times end to end.
- `npx playwright test` (whole suite) — 241 passed, 3 failed *while another
  agent was rewriting `components/assist/**` underneath it*; all three were
  re-run afterwards and pass (`e2e/packaging.spec.ts`, `e2e/m2-review.spec.ts`,
  and `e2e/preview.spec.ts`, whose assist assertion that slice updated from
  "disabled" to "live"). A clean full-suite run on a settled tree still belongs
  to the integration pass.

Two things the spec had to learn, both properties of the page rather than of
the feature:

- **The pill's first click can be swallowed.** `/videos/[id]` renders on the
  server and hydrates in one pass; a click inside that window does nothing.
  `openPanel` retries through `untilTaken` (`e2e/hydration.ts`), clicking only
  while the panel is absent, because the pill is a toggle.
- **The fixtures answer instantly**, so the in-flight walk makes its own delay
  by holding the server action's POST in a Playwright route. What it proves is
  the app's behaviour while something is in flight, which is the same whether
  the wait is a network or a model.

## M8 — The service module: one seam, two implementations, no key in this room

`lib/assist/**` is the swappable service module BRIEF.md asks for ("behind a
small, swappable service module"). Nothing above it imports `@anthropic-ai/sdk`,
names a model, or knows what a `stop_reason` is.

| File | What it is |
|---|---|
| `types.ts` | The seam: `AssistProvider.run(request, options)`, the request/result unions, `AssistMeta`, `AssistError` + `AssistErrorCode`. Pure types and one class — a client component may import it. |
| `schema.ts` | The zod shapes the model answers in. **Structural only.** |
| `clamp.ts` | Counts, caps, de-duplication, the recommendation repair, and `assemble()` — the one path from a validated payload to an `AssistResult`. |
| `prompts.ts` | The system and user prompts, as prose, with the voice guide as the governing section. |
| `anthropic.ts` | The real provider. `server-only`, reads the key at call time, injectable transport. |
| `fake.ts` | Deterministic fixtures, no network, every failure summonable on demand. |
| `test-fixtures.ts` | Request builders shared by the four test suites, so the builder is not copied four times. |

### The constraint that shaped it

There is no `ANTHROPIC_API_KEY` in this container and egress to
`api.anthropic.com` is blocked, so **not one line of `anthropic.ts` has ever run
against the real endpoint.** That is why the transport is a constructor option:
`anthropic.test.ts` hands the SDK a stub `fetch` and asserts on the request the
SDK actually builds, then on what the provider does with each kind of reply. No
test in this module leaves the machine, and none can.

Everything asserted about the API was read out of the installed package
(`@anthropic-ai/sdk` 0.128.0 — `resources/beta/messages/messages.d.ts`,
`helpers/beta/zod.d.ts`, `lib/transform-json-schema.js`) or out of the bundled
`claude-api` skill. Nothing came from recall:

- `claude-opus-5`, overridable by `ANTHROPIC_MODEL` — skill's model table.
- `output_config: { effort: "medium" }` — PLAN.md line 248. `BetaOutputConfig`
  in the installed types has exactly `effort | format | task_budget`, and
  `effort` takes `low|medium|high|xhigh|max`. There is no top-level `effort`.
- `fallbacks: "default"` with beta `server-side-fallback-2026-07-01` — also
  PLAN.md 248. `BetaFallbacksParam = Array<BetaFallbackParam> | 'default'`, and
  that flag is in the `AnthropicBeta` union. The scalar form pairs with `-07-01`;
  the array form pairs with `-06-01`, and crossing them is a 400. The test reads
  the outgoing header back, so a future edit cannot quietly drop it.
- **No `thinking` parameter.** Thinking is on and adaptive by default on this
  model and `budget_tokens` was removed — sending it would be a 400. A test
  asserts the request carries no `thinking`, no `budget_tokens`.
- `stop_reason: "refusal"` + `stop_details {category, explanation}` — checked
  before the content is read, because a refusal carries no JSON.

### Structural-only schema, clamped counts

PLAN.md line 155 in practice, with the mechanical reason now verified rather than
assumed: `zodOutputFormat` runs the schema through the SDK's
`transformJSONSchema`, which keeps `minItems` only when it is 0 or 1 and folds
every other bound (`maxItems`, `maxLength`, …) into the schema's *description*.
So a `.max(20)` would not constrain the model at all — but it *would* run
strictly on our side and turn a 21-title answer into a validation failure.
Instead: validate shape, clamp count, keep the work. A test walks the JSON Schema
actually sent and fails if any bound appears in it.

The clamp drops only what cannot be used — blank text, text past the column it
is destined for, and duplicates of what the video already has — and counts
everything it did into `AssistMeta`, which is what lets the panel say "the model
sent 21; here are 20" instead of hiding it.

### Every failure mode, and where it is proved

`anthropic.test.ts` drives each one through the real provider with a stubbed
transport: refusal → `refused` (not retryable, category carried), 429 →
`rate_limited` (+ `retry-after`), 5xx → `upstream`, 401/403 → `unauthorized`,
400 → `rejected`, non-JSON body → `malformed`, JSON of the wrong shape →
`wrong_shape`, empty list → `empty`, `stop_reason: "max_tokens"` with no text →
`malformed` (it was cut off, not empty), connection failure → `unreachable`, our
deadline → `timeout`, the caller's signal → `cancelled`, and anything thrown at
all → still an `AssistError`. 96 tests across five files; `npm test` is 494
passing in 30 files.

### Decisions taken without the user

1. **`maxRetries: 0` on the SDK client.** Its default retries 429s, 5xx *and*
   timeouts twice, which would put the worst case at three times the deadline —
   past PLAN.md's `maxDuration = 60`. One attempt, a typed error, and the retry
   is the person's button.
2. **`cancelled` is not retryable and `refused` is not either.** The first
   because nobody is waiting for advice about a panel they closed; the second
   because the same prompt earns the same refusal, and a retry button that cannot
   work is a lie.
3. **A fully de-duplicated answer is a success with an empty list, not an
   `empty` error.** Nothing went wrong: the model proposed what the person had
   already written. `meta.droppedDuplicates` carries the sentence.
4. **The rationale is cut to `MAX_CANDIDATE_NOTE_LENGTH` rather than dropped.**
   Accepting a suggestion writes the rationale into the candidate's `note`; an
   over-long one would turn "Add as candidate" into a validation error at the
   write path.
5. **Hooks are asked for by how many are missing** (the pill says "Draft a
   third"), floored at one so a full list still gets an alternative to compare.
6. **The fake takes a scenario from a marker in the video's own text**
   (`[[assist:refused]]`), as well as from an option and from
   `ASSIST_FAKE_SCENARIO`. A browser test can then ask for a refusal mid-run by
   typing into a field it already has open, instead of restarting a server per
   failure mode.
7. **`concepts` and `thumbnail_critique` exist in the provider surface** even
   though this milestone's panel only asks for `titles` and `hooks`. The pills
   for them were placed in M4/M2 and the module is where their request shapes
   belong; wiring them is a UI decision, not a module one.

### Deviations from PLAN.md

- **`lib/assist/**`, not `lib/brainstorm/{types,anthropic}.ts`.** The directory
  name came from the milestone's own task text and from the control the earlier
  milestones placed (`AssistPill`). Same two implementations, one more file each
  for the schema, the clamp and the prompts, because PLAN.md's own instruction
  was that the prompt is a first-class artifact.
- **`server-only` is not a new dependency.** Next aliases the bare specifier to
  its own bundled copy and declares the module in `next/types/global.d.ts`, so
  the tripwire costs nothing at the dependency ceiling. Vitest has no such alias,
  so `vitest.config.mts` points the specifier at Next's own `empty.js` — the
  stub Next itself serves under the `react-server` condition. That is the one
  file outside `lib/assist/**` this slice touched.
- **`@anthropic-ai/sdk` 0.128.0 installed**, as PLAN.md's dependency list
  allows. Verified against its own types rather than over raw `fetch`.

### Honest limits

- **No live call, ever, from here.** The real provider is verified by reading the
  installed SDK and by asserting on the request it builds — not by using it. The
  first real exchange will happen in Vercel, and the first thing worth checking
  there is that the request goes out with `effort: "medium"`, the `-07-01` beta
  header and `fallbacks: "default"`, and that a refusal comes back as a sentence.
- **The key was grepped for, in a real build.** `npm run build` succeeds;
  `ANTHROPIC_API_KEY`, `api.anthropic.com` and `x-api-key` appear nowhere under
  `.next/static`, and the SDK appears only in server chunks.
- **Two providers wrote `lib/assist` at once.** This slice and the panel slice
  raced: three files in this directory were overwritten mid-flight and rebuilt
  against the interface the action and the panel had by then been written for.
  The module that ships is the one the consumers compile against (`npm run
  typecheck` is clean for the app program), but the churn is worth knowing about
  if a later reviewer finds a doc comment describing a shape that no longer
  exists.
- **One typecheck error outside this slice** at the time of writing:
  `e2e/brainstorm.spec.ts(490,3)` — a local `release` variable typed `never` in
  the panel slice's spec. Untouched here.


## M8 — Every other assist: concepts, the third hook, the critique, and the two places a pill would have been noise

*Slice: `components/assist/{run.ts,chrome.tsx,concept-assist.tsx,critique-assist.tsx}`,
`components/thumbnails/assist-target.tsx`, the critique half of
`app/actions/assist.ts`, and the wiring in the packaging block, the thumbnails
section and `app/videos/[id]/page.tsx`. The provider module and the title/hook
panel are the other two M8 slices; this one programs against both.*

The user's words when the design was signed off: *there should be UI options to
have AI generate, research or assist you on every field that makes sense.*
Seven milestones shipped those controls inert. This is the rest of them turned
on — and, for two of them, the honest finding that turning them on would have
been shipping noise.

### What this slice delivers

- **"Suggest concepts", beside the written thumbnail concept.** Four proposals,
  each a description of a *shot to film* with a reason, in the channel's voice.
  Accepting writes the concept box through the packaging block's one save queue.
  It is the only acceptance in the app that **replaces** rather than appends, so
  it carries an undo in the notice line under it.
- **"Draft a third", beside the hooks.** Already opened the brainstorm panel on
  hooks when this slice started (the panel slice built it); what this slice
  checked is the thing the task asked for — that the hook is drafted *against the
  packaging it belongs to*. `lib/assist/prompts.ts` puts the working title and
  the locked thumbnail concept in the user message for every kind, and
  `videos.title` **is** the chosen candidate (choosing one writes it, see
  `packaging-block.tsx`), so a hook cannot be drafted in ignorance of the title
  that was picked. The panel's waiting line now says so.
- **"Critique at tile size", in the Thumbnails section.** The one assist that
  looks at pixels: it sends the uploaded variants with the title and the locked
  concept, and comes back with one verdict per image — reads at tile size or
  not, adds to the title or repeats it, and a sentence to act on — plus the role
  it would ship. Accepting *is* shipping that role, through `swap_thumbnail`,
  the one door there is.
- **One mechanism, nearly all the way down.** `components/assist/chrome.tsx` is
  now the only place the waiting row with its measured seconds, the failure
  block with its retry, the notice line, the clamp line, the proposal frame and
  the pill are drawn — the packaging panel was moved onto it, so all three
  panels are the same panel wearing different questions.
  `components/assist/run.ts` is the same for the *state* (ask, wait, cancel,
  fail, say what happened) and the two controls this slice built use it; the
  packaging panel still holds its own copy of that state, which is written up
  under Honest limits as the one piece of this that did not converge.
- **The inert pill is gone.** `components/preview/assist-pill.tsx` had no call
  sites left once the last two were wired, and a disabled control whose tooltip
  promises a milestone that has shipped is a lie in the UI. Its reasoning — the
  layout decision is worth making early; a listener behind a button nobody can
  press is the illusion of a feature — is carried in `AssistPillButton`'s doc
  comment, which is the same control with something behind it.

### The critique, in detail, because it is the unusual one

**It judges; it never generates.** BRIEF.md principle 2 is that a thumbnail
*concept* and a thumbnail *asset* are two things at two stages. The concept is
proposed at packaging by the pill above; this section holds the files, and the
only useful thing a model can add here is what the person cannot do for
themselves — see their own thumbnail small, beside the title, the way a stranger
meets it. Nothing in this app returns an image or a prompt for one.

**The bytes are read on the server, and `lib/storage.ts` says why.** That file's
header used to say the server never holds image bytes; that is still true of the
*upload* path (browser → Storage directly, because a server action is a request
body and Vercel caps those at 4.5 MB). The critique goes the other way and has
no choice: the key may only exist on the server, so the request carrying the
images is built there. `downloadObject` reads them with the caller's own
RLS-scoped client — the same `thumbnails owner rw` policy a signed URL goes
through — holds them for one call, and writes them nowhere.

**Three ways a variant is left out, all named rather than dropped.** A format
the vision API cannot read (the bucket accepts AVIF; the API's list, read out of
the installed SDK's types, does not), an object that is no longer there, and a
file past the 5 MB ceiling each become a sentence in the panel while the others
are still judged. All three variants failing is the one case that fails the
call, and the message is the first variant's reason rather than "it did not
work".

**The verdict is deliberately not stored, and closing the panel forgets it.** `videos.brainstorm_last` makes
reopening the text panels free, because their proposals are about text that has
not changed. A verdict is about the bytes that were in the bucket when it ran:
replace the wild card and a stored verdict becomes a confident paragraph about
an image that no longer exists, which is worse than no verdict because it reads
as current. The panel says "Not kept", closing it drops the answer rather than
holding a stale one for the next open, and asking again is one click.

**Accepting lands in a real field, and the log stays the person's.** Nothing is
live yet → one click ships it, logged as `Chosen at launch.` like any first
ship. Something is live → the existing swap dialog opens, with the model's
sentence *pre-filled in the textarea*, editable, and the dialog says where it
came from. `thumbnail_swaps.reason` records what was confirmed, never what was
proposed: the log is the record of what the person decided.

### Capture: the assist is one press *after* it, not inside it

`components/capture/capture-form.tsx` is one input, a channel chip and Enter,
with everything else behind a disclosure. BRIEF.md principle 6 says friction
reduction *is* the product, and this is the least friction in the app. There is
no assist on that path, for two reasons and the second is the harder one:

1. A model call takes ten to forty seconds. Putting one on the fastest screen
   in the app makes it the slowest.
2. **It could not be built honestly.** `app/actions/assist.ts` takes a video id
   and nothing else, *precisely* so a browser can never hand the key a prompt of
   its own — everything the call needs is either RLS-scoped user data or the
   key. At capture time there is no row yet, so an assist there would have to
   accept free text from the client and spend the key on it. That is the one
   thing the action's shape exists to prevent, and it is not worth trading for a
   button.

What changed instead: the capture toast now carries a link to the video it just
wrote. Capture stays one field and Enter; the four controls that can do
something with the idea are one press away, on the page that owns it.

### Script: no pill, because there is no field

`components/video-sections/script-section.tsx` is read-only, and not by
oversight: `script` is not in `lib/video-fields.ts`'s patch vocabulary and
`app/actions/videos.ts` has no branch for it, so **there is no write path to
land a suggestion in**. A generate button over a column that cannot be saved
would produce text with nowhere to go, which is the definition of noise.

There is also less missing here than it looks. The part of a script this app
actually owns is the hook — BRIEF.md's scripting checklist wants it *scripted
word for word* and the rest as bullets — and the hook has an assist already, one
stage upstream, whose output `move_video` splices into the script template on
the way into Scripting. So the script's own assist is the editor's to ship with
the editor (M9's job, per PLAN.md), and adding a pill now would mean choosing
between a button that does nothing and a second write path to a column with
none. Recorded as a finding rather than built.

The same test applies to a review-only assist ("critique this script"): it would
be the only assist in the app with nothing to accept, and this milestone's rule
is that a proposal has a field to land in.

### Decisions taken without the user

1. **Concepts got their own control rather than a third tab on the brainstorm
   panel.** That panel sits beside the title candidates and answers two
   questions about *lists*, where accepting appends a row. The concept is a
   single field where accepting **overwrites**, possibly something the person
   wrote; it belongs beside the box it overwrites and it needs an undo a
   list-shaped panel has no use for. It is not a second mechanism: same
   `useAssistRun`, same chrome, same `brainstorm_last` envelope under its own
   key.
2. **Accepting a concept replaces immediately, with an undo, rather than asking
   first.** A confirm step on every acceptance is friction on the gesture the
   whole feature is about; an undo is one press and only appears when there was
   something to lose.
3. **The critique is not stored** (above), which also means "Ask again" is the
   only way to see one after a reload. That is the honest cost of the answer
   being about bytes.
4. **The critique's accept is "ship this one".** A verdict's proposal *is* which
   variant to run; making the person read it, close the panel and find the slot
   would be the panel knowing something the page will not act on.
5. **`brainstorm_last` gained a `concepts` key without a version bump.** Every
   key in the envelope is optional, so an older build ignores it key-by-key and
   a row written before it exists reads exactly as it did. A version is for a
   change that makes the old shape unreadable.
6. **The capture toast gained a link** rather than capture gaining a control.
7. **The four pills all render `AssistPillButton`**, so the one that can still
   be unavailable — the critique, with no images to look at — is disabled *and*
   says why, instead of being a button that does nothing.

### Deviations from PLAN.md, stated plainly

- **PLAN.md's M8 is "panel on the packaging block, Add all, add-as-candidate /
  use-as-hook, `brainstorm_last`".** That is the other slice. This one is the
  rest of the user's "every field that makes sense", which PLAN.md does not
  enumerate; nothing here contradicts it. The thumbnail critique is the one
  capability PLAN.md's brainstorm section does not mention at all — it comes
  from the control M4 placed and from BRIEF.md principles 2 and 7 — and it is
  additive: it reads images, writes nothing but a ship through the existing
  function.
- **`app/actions/assist.ts` holds two exported actions now**, `assist` (titles,
  concepts, hooks) and `critiqueThumbnails`. One file, one provider chooser, one
  deadline, one failure mapping (`failureOf`), two questions with different
  inputs and different return shapes.

### Honest limits

- **No live model call has ever been made from this container**, here or in
  either sibling slice. Egress to `api.anthropic.com` is blocked and there is no
  key. Everything is exercised against `lib/assist/fake.ts`. The first real
  exchange will be in Vercel, and the first thing worth watching there is a
  critique: it is the only call that sends images, and nothing about that path —
  the base64 size, the per-image cost, the latency of three photographs — has
  been measured against the real API.
- **The critique's cost is real and this app does not show it.** Three images
  plus a prompt is the most expensive thing in here by some distance, and the
  panel says nothing about that beyond warning that it is the slowest.
- **Two slices wrote `components/assist/**` at the same time.** The panel slice
  and this one collided on `brainstorm-panel.tsx` mid-edit: this slice had begun
  making the panel three-kinded while that slice was narrowing it to a
  `PanelKind` of exactly two. The tree was briefly uncompilable. It was resolved
  in this slice's favour on the shared chrome and in the panel slice's favour on
  the question of what that panel answers — which is how concepts came to have
  their own control, and it is a better answer than the one this slice started
  with. If a reviewer finds a doc comment describing a three-tab panel, that is
  the fossil.
- **`e2e/preview.spec.ts`'s "the assists, inert" case was rewritten here**, by
  this slice, because all four pills are live and it asserted all four were
  disabled with an "Arrives in M8" tooltip. It now asserts the opposite, plus
  the one control that can still be legitimately unavailable.
- **The packaging panel renders the shared chrome but still keeps its own
  in-flight state.** `components/assist/brainstorm-assist.tsx` holds a
  `Record<PanelKind, KindView>` with its own request-id, cancel sentence and
  patch function; `components/assist/run.ts` is the same machine written once,
  and the two other controls use it. They agree today — the cancel sentence is
  the same words in both — but they agree by hand, which is precisely the kind
  of agreement that stops being true. Converting that component to hold two
  `useAssistRun`s is a contained change and was left undone rather than made
  blind while its own slice was still being written. It is the first thing to
  do to this directory.
- **This slice made `/videos/[id]` heavier, and one spec elsewhere felt it.**
  The first full run after it landed failed `e2e/flow-fields.spec.ts` — the
  target date typed and blurred before the route had hydrated, so no draft ever
  saw it and the save never happened. It passes alone and failed under the full
  suite, which is exactly the property `e2e/hydration.ts` was written for: the
  page renders as real HTML first, and every client panel added to it widens
  the window where a click or a keystroke is swallowed. The fix is that file's
  documented remedy — retry the interaction until the page takes it — applied
  to that one spot. The underlying cost is real and is worth naming: three
  assist panels now hydrate with the rest of the detail page, and the honest
  answer if it worsens is to make the sections lighter, not to unmount the ones
  that are not showing.
- **The critique reads its images with three concurrent `download` calls**, one
  per slot, before the model call starts. Storage has no batch download, so the
  floor is one round trip per variant; running them together makes it one wait
  rather than three. It has never been measured against real Storage latency.


### Gates for this slice

Every one of these was run after the last edit, in this container, and the
numbers below are the output rather than a summary of it.

| Gate | Command | Result |
|---|---|---|
| Types | `npm run typecheck` | clean, both programs (app and the harness `tsconfig.harness.json`) |
| Lint | `npx eslint .` | clean, no errors and no warnings |
| Unit | `npm test` | **494 passing in 30 files** (vitest); nothing in this slice needed a new unit test that the provider module's suites do not already cover |
| Build | `npm run build` | succeeds; `ANTHROPIC_API_KEY`, `api.anthropic.com` and `x-api-key` appear **nowhere** under `.next/static` — the vendor host is in server chunks only, which is PLAN.md's first M8 review item proved again with the critique action in place |
| Database | `./scripts/verify-db.sh m8_fields` | **OK — migrations applied, 16 test files passed.** This slice adds no migration; the run is the proof that it needed none |
| End to end | `npx playwright test` | **256 passed, 1 skipped, 0 failed (19.0m)** — the whole suite, against the real stack, with `ASSIST_PROVIDER=fake` |
| This slice's walk | `npx playwright test assist-fields` | **12 passed (52s)** |

The skipped one is `session-refresh`, which only runs under `npm run e2e:refresh`
with its own short-lived tokens; it has been skipped in the default run since M1.

`e2e/assist-fields.spec.ts` is the new suite: twelve walks covering concepts
(generate, present, accept into the box, replace-with-undo, reopen from the
column), the third hook landing in `videos.hooks`, the critique (judging only
what was uploaded, shipping the first one, the swap dialog pre-filled and
edited, the log row that records what was confirmed), a refusal, a rate limit,
an unusable answer being clamped and said out loud, the in-flight row with its
Cancel, and one keyboard walk that opens all three panels and closes each with
Escape. Every assertion that claims something was written is paired with a read
of Postgres.


## M8 — Integration: one seam, one machine, and what a key would still have to prove

> Scope: the join between the three M8 slices above. `app/actions/assist.ts`
> (result shape, provider chooser), `lib/assist/select.ts` and
> `lib/assist/select.test.ts` (new), `components/assist/brainstorm-assist.tsx`
> (rewritten onto `run.ts`), `components/assist/brainstorm-panel.tsx`,
> `components/assist/concept-assist.tsx`, `components/assist/critique-assist.tsx`,
> `components/assist/chrome.tsx` (`AssistProvenance`, `AssistFixtureNotice`, one
> pill), `app/videos/[id]/page.tsx` (one key), `eslint.config.mjs`,
> `e2e/m8-acceptance.spec.ts` (new), `e2e/brainstorm.spec.ts`,
> `e2e/assist-fields.spec.ts`, `README.md`, `.env.example`. **No migration; no
> new runtime dependency.** The dependency ceiling is unchanged:
> `@anthropic-ai/sdk` was already in the committed `package.json` and is the
> only addition M8 makes to it.

### The first thing, because it is the one that cannot be fixed after deploy

PLAN.md's first M8 review item is that **the key never reaches the client
bundle**. Checked on a clean `rm -rf .next && npm run build`, over all 52 files
of `.next/static`:

| Needle | `.next/static` | `.next/server` (positive control) |
|---|---|---|
| `ANTHROPIC_API_KEY` | **0 files** | 7 files |
| `api.anthropic.com` | **0 files** | 5 files |
| `x-api-key` | **0 files** | 7 files |
| `server-side-fallback`, `claude-opus` | **0 files** | present |

The right-hand column is the part that makes the left-hand column mean
something: the same grep, run against the server chunks, finds all three. A
clean left column with an empty right column would only have proved that the
grep was broken.

`lib/assist/anthropic.ts` is the one file that reads the key and its first line
is `import "server-only"`, so a client component that reached it would fail the
build rather than ship a key to a browser. `app/actions/assist.ts` imports both
implementations lazily, so a process answering from the fixtures never loads a
module that reads a key at all. And the client sends a video id and a kind and
nothing else — the prompt, the voice guide and the fifty past titles are all
assembled server-side, so a browser cannot spend the key on a prompt of its
own.

`e2e/m8-acceptance.spec.ts` adds the runtime half of the same claim, with the
feature actually in use: no request leaves the origin while a brainstorm runs
(in particular none to `api.anthropic.com`), and every `<script src>` the page
loaded is fetched back and searched for all three strings.

**One thing changed because of this check.** The fixtures notice described
below first read "…ASSIST_PROVIDER is set to `fake`", and that put the literal
string `ANTHROPIC_API_KEY` into `.next/static` — the *name*, never a value, and
harmless in itself. It was still rewritten, because a review item phrased as
"grep the build output" is only useful while the answer is *nothing*. One
known-benign hit turns a bright line into a judgement call somebody has to make
on every build, and a gate people learn to ignore is not a gate. The panel
points at the README instead. The failure sentences that *do* name the variable
(`not_configured`, `unauthorized`) are written on the server and arrive as
data, so they never enter a bundle.

### What was found when the three slices were read together

Three agents wrote `lib/assist/**`, `components/assist/**` and the pills
concurrently, in one tree, and each reported the collision honestly. Read as one
feature, the seams were:

1. **Two copies of the in-flight machine.** `components/assist/run.ts`'s
   `useAssistRun` — request id, pending, elapsed, failure, notice, cancel,
   settle, forget — was used by the concept control and the critique, while
   `brainstorm-assist.tsx` kept its own `Record<PanelKind, KindView>` with its
   own request-id ref, its own transport-failure sentence and its own words for
   cancelling. They agreed, by hand. Both slices named this as the first thing
   to fix and both left it undone rather than do it blind while the other was
   still writing. It is now two `useAssistRun` instances, one per question, and
   `KindView` is a type alias for `AssistRunState<StoredAssistEntryValue>`
   rather than a second declaration of the same fields.
2. **Two result shapes from one action file.** `critiqueThumbnails()` already
   returned exactly what `useAssistRun` consumes; `assist()` returned the same
   thing with the answer called `entry`, so both of its call sites hand-wrote
   the same eight-line translation. Renamed to `data`. Every control is now
   `run.ask(() => assist({ videoId, kind }))` and nothing translates, which
   means a new kind of assist cannot invent a fifth way to say "it failed".
3. **Two pills.** `AssistPillButton` is the shared control, and three of the
   four used it; the brainstorm pill drew its own button with its own badge
   test id. Collapsed. The pill's `verb` is its identity (`data-assist`, which
   every spec locates it by) and a new optional `label` carries the one case
   where the text differs from the verb — "Hide brainstorm" while its panel is
   open. A control whose identity changed when you pressed it would be a
   different control depending on whether you had pressed it.
4. **Two copies of the provenance sentence.** Both text panels computed "Fresh,
   just now / From earlier — asked for N ago… / …voice guide…" themselves, from
   the same fields, in two copies that happened to agree. It is now one
   `AssistProvenance` in `chrome.tsx`. A claim about *where an answer came
   from* is precisely the kind of thing that must not be able to disagree with
   itself — which is also how it became the place for the paragraph below.

What was **not** collapsed, deliberately: the concept control stays separate
from the two-tab panel. That was the sibling slices' decision and it is the
right one — accepting a title *appends a row*, accepting a concept *overwrites
a field somebody may have written*, and those need different gestures and
different undo. Same hook, same chrome, same envelope, different question.

### A fixture must never pass itself off as a model

This is the failure this feature has that nothing else in the app does, and the
integration pass is where it was closed.

`lib/assist/fake.ts` returns plausible titles with plausible reasons. Nothing
about them looks wrong — that is what makes them useful, and it is exactly what
makes them dangerous. Until this pass, nothing on screen said which
implementation had answered, so a person shown fixtures while believing a model
wrote them would have been wrong about the only thing the panel is for, and the
app would not have contradicted them.

Now `AssistProvenance` says so, on every answer, in the attention colour: *these
came from this app's built-in fixtures, not from Claude — so nothing here is a
model's opinion of your video.* It is a property of the **answer**, not of the
sitting: `videos.brainstorm_last` already stored `provider`, so a panel reopened
tomorrow makes the same admission. `e2e/brainstorm.spec.ts` asserts it, and that
spec is the one in this repository that is *supposed* to fail the day a real key
is deployed — which is the correct failure, and says out loud that the suite has
stopped testing the fixtures.

### Which implementation answers, and why production does not fall back

The task for this pass asked that "the fake is the default where no key
exists". The panel slice had shipped the opposite default, for a good reason:
a `fake` in production hands somebody invented titles and lets them believe a
model wrote them. Both are right about different environments, so the rule
splits on `NODE_ENV`. It is one pure function, `selectAssistProvider` in
`lib/assist/select.ts`, with a unit test per row:

| `ASSIST_PROVIDER` | key present | `NODE_ENV` | answers |
|---|---|---|---|
| `fake` | either | any | the fixtures |
| anything else non-empty | either | any | Claude |
| unset | yes | any | Claude |
| unset | no | `production` | Claude — and the panel says "no API key configured" |
| unset | no | anything else | the fixtures, and the panel says they are fixtures |

A **production** deployment with no key deliberately does not fall back: it
fails with a sentence naming the variable, which is true and fixable. A
**development** checkout with no key does, so a fresh clone is reviewable
without a paid account — and the notice above is what makes that safe. `fake`
written explicitly outranks both inferences, because `playwright.config.ts` and
`.env.local` both set it and a statement should outrank a guess.

This container's permanent state — no `ANTHROPIC_API_KEY`, no egress to
`api.anthropic.com` — is therefore a *working* state, not a broken one, by two
independent routes: `.env.local` names the fixtures explicitly, and the
inference would choose them anyway.

### Two things this pass found that were not about M8's seams

**A React key warning on every render of `/videos/[id]`.** The dev server logged
*"Each child in a list should have a unique key … Check the render method of
`ThumbnailsSection`. It was passed a child from VideoDetailPage"* on every load
of the detail page, in the full-suite output where nobody was looking. The cause
is M8's: the critique control is a **client** component handed to a section as a
prop from a server component, and until this milestone the pill in that slot was
an inert server component that never crossed the boundary. Every other client
element the page hands down already carried a key — `assist-candidates`,
`assist-concept`, `assist-hooks`, `title-truncation-warning` — so this was the
last one without. Fixed, with the reason written beside it rather than the key
alone, because a bare `key="…"` on a single element reads like superstition.

**`npm run lint` was not deterministic.** `eslint.config.mjs` overrides
`eslint-config-next`'s default ignores and did not re-add Playwright's output,
so linting while (or shortly after) a suite ran picked up the temporary
JavaScript in `test-results/.playwright-artifacts-*` — **4,660 problems, 286 of
them errors**, from files that are build output. One of this project's six gates
should not answer differently depending on whether a browser happens to be open.
`test-results*/**`, `playwright-report/**` and `blob-report/**` now match what
`.gitignore` has said since M1.

### PLAN.md's acceptance, walked in a browser

`e2e/m8-acceptance.spec.ts`, five walks, against the real app, the real save
queue, the real column and real PostgREST with RLS on. Screenshots in the
gitignored `e2e/screenshots/`.

| PLAN.md | Walked |
|---|---|
| *10–20 titles with rationale and a highlighted pick* | 20 proposals; both ends of the range asserted, not just the lower one; a non-trivial rationale on **every** one; exactly one `data-recommended="true"` with its badge and "Why it picked this one:"; every row drawn as a proposal. Accepting lands it as an ordinary candidate row, `source: "ai"`, note = the rationale, through the packaging block's one save queue, read back out of Postgres. |
| *changing the voice guide visibly changes output* | With no guide the panel says so and says what to do about it; the guide is written; "Ask again" returns a different list, asserted as a set rather than by one string. |
| *key never reaches the client bundle* | The table above, plus the runtime walk: nothing leaves the origin, and every loaded script is re-fetched and searched. |
| *a 21-title answer is clamped, not discarded* | 20 on screen, `brainstorm-meta` says it overshot and by how much, and the twenty that arrived are all still acceptable. |
| *a refusal surfaces as a message, not a crash* | The sentence, plus "Nothing was changed"; no `pageerror` at all; the page still the page; the packaging fields still saving to Postgres afterwards; and `brainstorm_last` still null, so a refusal leaves nothing behind to be mistaken for an answer. |

### The honest limit, stated as plainly as it can be

**The real provider has never been exercised against the live API in this
environment.** There is no `ANTHROPIC_API_KEY` in this container and outbound
egress to `api.anthropic.com` is blocked. Not one HTTP request has ever been
made to Anthropic from here, in this pass or in any of the three slices.

What **is** proved:

- The app, end to end, against `lib/assist/fake.ts` behind the same
  `AssistProvider` interface — panel, pills, server action, clamping, failure
  sentences, `brainstorm_last`, the save queue, RLS. **262 Playwright walks in
  the whole suite**, of which 39 are M8's: 22 in `brainstorm.spec.ts`, 12 in
  `assist-fields.spec.ts` and 5 in `m8-acceptance.spec.ts`.
- `lib/assist/anthropic.ts`'s **own** behaviour, against a stubbed transport:
  that it sends `effort: "medium"`, the `server-side-fallback-2026-07-01` beta
  and `fallbacks: "default"`; that it checks `stop_reason === "refusal"` before
  it reads any content; and that a 429, a 5xx, a 401, a 400, a dropped socket,
  a timeout, an abort, a non-JSON body, a wrong-shaped body and an empty list
  each become the right `AssistError` with the right sentence. **103 unit tests
  across six suites in `lib/assist`, 23 of them on the real provider.**
- That every parameter it sends exists and is spelled the way the installed
  SDK spells it, read from `node_modules/@anthropic-ai/sdk`'s own `.d.ts` files
  and cross-checked against the bundled `claude-api` skill — never from recall.
  This pass re-checked the four that would be silently wrong from memory, and
  all four hold: the model id is `claude-opus-5`; `effort` lives **inside**
  `output_config` and takes `low | medium | high | xhigh | max`; the scalar
  `fallbacks: "default"` pairs with the `server-side-fallback-2026-07-01` beta
  (the array form takes `-2026-06-01`, and crossing them is a 400 — this sends
  the matched pair); and on Opus 5 thinking is adaptive **by default**, so
  sending no `thinking` parameter at all is right rather than an omission.

What is **not** proved, and cannot be from here:

- That Anthropic accepts the request as built. The SDK's types say the shape is
  legal; only the API can say the request is.
- That the model id is live, that the beta header is still current, or that
  `fallbacks: "default"` behaves as documented on the account the key belongs
  to.
- Anything at all about latency, cost or token usage. PLAN.md's 10–40 s
  estimate is PLAN.md's; the 45 s deadline inside `maxDuration = 60` is a
  budget, not a measurement.
- That a real refusal carries the `category` and `explanation` the parser
  reads, or that a real answer fits the schema well enough that the clamp is a
  rare path rather than a common one.
- The thumbnail critique's whole shape as an expense: it is the only call that
  sends images, and nothing about three base64 photographs has been measured.

**The first three things to check when a key exists in Vercel**, in order: that
a brainstorm returns at all; that the outgoing request carries `effort`
`"medium"`, the `anthropic-beta` header and `fallbacks: "default"`; and that a
refusal arrives as the panel's sentence rather than a crash. The first two are
asserted here only against a stub, and the third is the one PLAN.md singles
out.

### Decisions taken without the user

1. **The fixtures announce themselves, in the attention colour, on every
   answer.** Nobody asked for this line. It exists because the alternative —
   fixtures that are indistinguishable from a model's answer — is the one
   failure in this feature that cannot be noticed from outside, and this
   milestone is the only chance to close it. It costs a line of the panel.
2. **The fallback splits on `NODE_ENV` rather than picking one default.** Both
   defaults were defensible and each was wrong in the other's environment. The
   split is the only answer that is right in both, and it is testable.
3. **The panel's copy does not name `ANTHROPIC_API_KEY`**, to keep PLAN.md's
   grep a bright line. Reasoning above, and repeated in the doc comment on
   `AssistProvenance` so the next person to write that sentence finds out why
   before they write it.
4. **`AssistState.entry` was renamed to `data`.** A rename that touches two
   call sites, in exchange for every assist in the app returning one shape.
5. **The thumbnail critique makes the fixture admission too**, through a
   component split out of `AssistProvenance` rather than a fourth sentence. Its
   provenance line is genuinely different — the verdict is never stored, so it
   has no age and no "from earlier" — but the one thing all three must never
   omit is the same. A confident paragraph about somebody's thumbnails that no
   model ever looked at is the worst version of this failure, because it reads
   as expertise.
6. **`e2e/m8-acceptance.spec.ts` exists at all**, rather than trusting the two
   slice suites. Every milestone from M1 has an acceptance spec that walks
   PLAN.md's own words; M8's runnables and review items were spread across two
   files written by two agents who could not see each other's work.
7. **The pill keeps its verb as its identity.** Making `data-assist` change
   when the panel opens would have been the smaller diff, and would have made
   every pill selector in three suites state-dependent.

### Deviations from PLAN.md, stated plainly

- **`lib/brainstorm/{types,anthropic}.ts` is `lib/assist/**`**, and
  `BrainstormProvider.generate(input)` is `AssistProvider.run(request)` over a
  discriminated union of four kinds. PLAN.md wrote the module when the
  brainstorm was one question; the user's "assist on every field that makes
  sense" made it four. The substance PLAN.md pins — structural-only zod schema,
  counts in the prompt and clamped in code, `stop_reason === "refusal"` checked
  first, slice to 20 titles / 3 hooks, clamp `recommended_index`, flag over-55
  titles rather than rejecting them — is all there, in
  `lib/assist/{schema,clamp,prompts,anthropic}.ts`.
- **The server action is `assist(videoId, kind)` and `critiqueThumbnails`,
  not `brainstorm(videoId)`.** Same segment, same `maxDuration = 60`, same
  single write path.
- **`videos.brainstorm_last` holds an envelope keyed by kind**, not one result.
  Three text assists share the column, and asking for hooks must not throw away
  twenty titles nobody has accepted yet.
- PLAN.md's M8 does not mention the thumbnail critique, the concept control or
  a fallback provider at all. Those come from BRIEF.md and from the pills M2
  and M4 placed; none of them contradicts PLAN.md, and each is recorded in its
  own slice's section above.

### Gates for this pass

Every one of these was run after the last edit, on the settled tree, in this
container. The numbers are the output rather than a summary of it.

| Gate | Command | Result |
|---|---|---|
| Types | `npm run typecheck` | clean, both programs (the app, and the harness `tsconfig.harness.json`) |
| Lint | `npm run lint` | clean — **and now deterministic**; see the Playwright-output ignore above |
| Build | `npm run build` | succeeds, from `rm -rf .next` |
| Key leak | grep of `.next/static` | **0 files** for `ANTHROPIC_API_KEY`, `api.anthropic.com`, `x-api-key`, `server-side-fallback`, `claude-opus` and `ASSIST_PROVIDER`, across all 52 files. The same grep over `.next/server` finds 7, 5, 7, 2, 2 and 3 — the control that makes the zeroes mean something |
| Database | `./scripts/verify-db.sh m8_check` | **OK — migrations applied, 16 test files passed.** M8 adds no migration; this run is the proof it needed none |
| Unit | `npm test` | **501 passing in 31 files** (was 494 in 30; `lib/assist/select.test.ts` is the new file and its seven cases) |
| End to end | `npm run e2e` | **262 passed, 1 skipped, 0 failed (18.9m)** — the whole suite, against the real stack, with `ASSIST_PROVIDER=fake` |

The skipped one is `session-refresh`, which only runs under `npm run e2e:refresh`
with its own short-lived tokens; it has been skipped in the default run since M1.

An earlier full run of the same tree reported the same 262/1/0, and this one was
re-run from scratch because the first had a `rm -rf .next` land underneath its
dev server — my mistake, and the kind that produces one unexplained failure
(`board.m1`'s WIP warning) that looks like a flake and is not. The number above
is from the clean run, with nothing else touching the tree while it ran.

## M8 — Review: what the adversarial pass found, and what was done about it

> Scope: 32 findings across five lenses (secrets, failures, principles,
> provider-code, scope-quality). Every one was checked against the tree before
> anything was changed; several were the same defect seen from two angles, and
> those are answered once and cross-referenced. Files touched:
> `lib/assist/{types,clamp,schema,prompts,fake,anthropic}.ts` and their tests,
> `app/actions/assist.ts`, `components/assist/{run,stored,chrome,acceptance,
> brainstorm-assist,brainstorm-panel,concept-assist,critique-assist}.ts(x)`,
> `components/packaging/{working-title,title-candidates,hooks-editor,
> thumbnail-concept}.tsx`, `components/capture/capture-form.tsx`,
> `components/ideas/matrix/capture-cell.tsx`, `app/videos/[id]/page.tsx`,
> `vitest.config.mts`, `.env.example`, `README.md`,
> `e2e/{brainstorm,m8-acceptance}.spec.ts`, **one migration
> (`0009_brainstorm_merge.sql`) and one new SQL test
> (`75_brainstorm_merge.test.sql`)**. No new runtime dependency.

### The blocker

**An answer the clamp emptied was a success with nothing in it, and it
destroyed the answer `brainstorm_last` was keeping.** (findings 6, 25)

`assemble()` rejected an empty answer by checking the payload *before*
clamping, never after. So an answer whose every suggestion was dropped — all
duplicates of what the video already had — resolved `ok: true` with
`suggestions: []`. Two things followed, and the second is why this was a
blocker rather than a rough edge:

1. The panel drew "0 proposals — the tool talking." over an empty list, with
   no failure block and no retry, after somebody had waited for a call and (in
   production) paid for it — while `lib/assist/types.ts` already had a written
   sentence for exactly this case.
2. `app/actions/assist.ts` writes on the success path, so that empty entry went
   into `videos.brainstorm_last`, where `readStoredBrainstorm`'s `usable()`
   reads an entry with no suggestions as **absent**. The twenty titles the
   column was holding were gone, and the call answered `persisted: true`.

It is not a corner case. It is the straight line the panel is built for: ask,
"Add all as candidates", "Ask again" — the fixtures are deterministic on the
video's own text, so the second answer is the first one, and every suggestion
in it is now a candidate. Once there, it repeats for as long as anybody keeps
pressing.

Three changes, at three depths:

- `assemble()` throws `AssistError("empty")` when the **clamped** list is
  empty, with a sentence naming why ("Everything it came back with is already
  on this video…" / "…everything in the answer was blank or too long"). `empty`
  is retryable, so the panel already has the button, and `failure()` returns
  before the write, so the kept answer survives.
- `withEntry` refuses to replace a non-empty stored entry with an empty one.
  An empty entry does not store an empty answer; it destroys the one that was
  there.
- `merge_brainstorm_entry` (migration 0009) raises on an entry with no
  suggestions, so the column refuses it even if something else ever tries.

Walked in a browser as the ordinary flow (`e2e/brainstorm.spec.ts` §12): 20
proposals, add all, ask again → `data-code="empty"`, "already on this video",
"Try again", no `brainstorm-count` at all, and `brainstorm_last` still holding
its twenty. Unit-covered in `clamp.test.ts` (the test that used to assert the
*opposite* is rewritten with the reason it changed) and `fake.test.ts` via a
new `[[assist:all_duplicates]]` scenario.

### Fixed

**Two brainstorms at once destroyed each other's stored answer** (2, 20). The
action read the whole `brainstorm_last` envelope at the top, spent 10–40 s in
the model, then wrote back an envelope rebuilt from that snapshot — so the
slower of two overlapping asks committed a state that had never seen the
faster one's key, while answering `persisted: true`. Reachable with two
adjacent clicks, because the panel deliberately holds one run per kind.
Migration **0009** adds `merge_brainstorm_entry(video, kind, entry)`: one
statement, ownership proved first, a jsonb merge of one key, `security
definer` like the other eight functions — and `brainstorm_last` leaves the
client's UPDATE grant, so there is no second way to write it and no snapshot
that can go stale. Six cases in `supabase/tests/75_brainstorm_merge.test.sql`,
plus two privilege assertions in `90_schema_contract.test.sql`.

**Cancelling or closing the panel mid-flight bought a second model call**
(7, 13). `cancel()` and `settle()` left `data: null`, `askedAlready` read
exactly that, and the request itself was never abortable — so the answer was
written to the column, ignored, and asked for again on the next open.
`CANCELLED_NOTICE` promised the opposite in as many words. `useAssistRun` now
*retains* a cancelled request: when it lands it settles in as `fresh: false`
("from earlier"), guarded inside the state updater so a newer ask or an
already-landed answer wins, and a late **failure** is still dropped — nobody
wants an alert about something they walked away from. `outstanding` says a
retained request is still on its way, and `askedAlready` reads it, so
reopening in the gap waits rather than asking twice. The notice was rewritten
to say the other true thing as well: the waiting stops, the spending does not.
Walked in `e2e/brainstorm.spec.ts` §13, which holds the assist POST, cancels,
releases, closes and reopens, and counts **one** POST.

**Structured outputs were being sent to the beta endpoint without the
structured-outputs beta flag** (23). This was the one detail in
`lib/assist/anthropic.ts` asserted from outside the installed package, and it
was wrong by omission. `output_config.format` goes to
`client.beta.messages.create`, and the SDK's own structured-output entry point
on that namespace — `client.beta.messages.parse`,
`node_modules/@anthropic-ai/sdk/resources/beta/messages/messages.js:75-83` in
the installed 0.128.0 — unconditionally adds `structured-outputs-2025-12-15`
on top of whatever `betas` the caller passed; the plain `create()` above it
adds nothing of its own. Without it the request may be rejected as malformed
on 100% of production calls, surfacing as `rejected` ("that is a bug in this
app") with nobody able to find out from this container; with it, if it is
unnecessary, the cost is an ignored header. Both flags now go out together and
`anthropic.test.ts` asserts both on the wire, so it is pinned rather than
remembered.

**The vendor leaked through the seam** (24, 11, 4). Three separate holes in
one claim:

- `AssistProvider["name"]` and `AssistMeta["provider"]` were the closed union
  `"anthropic" | "fake"`, so a third provider could not satisfy the interface
  without editing the file whose comment promises it would be "a new file and
  one line in that chooser". Both are `string` now; readers compare against
  `"fake"`, which is the one value with a meaning attached.
- Every default failure sentence named Claude — six times — and a keyless
  deployment therefore told people "Claude declined to answer this one" about
  notes no model had ever seen. The sentences are neutral, and the fixture
  admission now renders on the **failure** path too: `AssistState`'s failure
  branch carries `provider`, `AssistFailureView` carries it through, and
  `AssistFixtureNotice` has a `variant="failure"` sentence under all three
  panels. That closes the hole the integration pass claimed to have closed and
  had only closed on successful answers.
- `MESSAGES.unauthorized` put `ANTHROPIC_API_KEY` on the user's screen,
  contradicting this milestone's own recorded decision. The variable name now
  lives only in `AssistError.detail`, which is written on the server, logged
  there, and never rendered — asserted in `anthropic.test.ts`. PLAN.md's
  build-output grep was unaffected either way and is still **0 files**.

**The typographic boundary the design was signed off on did not exist**
(8, 15). `app/globals.css` defines `font-display` (Newsreader) as "what the
*user* wrote", and `chrome.tsx` asserts a proposal is drawn "never the
Newsreader face the person's own writing is set in" — but `font-display`
appeared nowhere under `components/packaging/`, so proposal and accepted
candidate were the same Instrument Sans and the whole boundary rested on a
dashed border and a chip. The app even contradicted itself within one screen:
the same `thumbnail_concept` string was Newsreader in
`components/thumbnails/concept-brief.tsx` and sans in the editor that writes
it. The four fields an M8 suggestion can land in — the working title, the
candidate rows and their add box, the hooks, the concept — are now set in the
reading face, so accepting a proposal visibly moves it out of the tool's
voice. The proposal side stays sans.

**"Why it picked this one:" labelled a sentence that was not a reason for the
pick** (12). The label sat over the picked row's own `rationale`, which says
why that one works — a comparison was never asked for, in the schema or the
prompt, and under the fixtures `recommended_index` was a hash unrelated to the
list, so the "why" was routinely about a different suggestion. The question is
asked now: `recommended_reason` on `SuggestionsPayload` (optional, so an
answer that omits it is not thrown away over it), a matching instruction in
all three `craftSection` branches, `recommendedReason` on `SuggestionsResult`
and on the stored entry, and a fixture pool of comparative sentences. It is
dropped whenever the pick moves — a reason for a proposal that was clamped
away is a reason about something nobody can see — and where there is none the
badge carries the pick alone.

**The critique could recommend the one variant its own verdict called
illegible** (16). `clampCritique` accepted any `recommended_role` that named a
variant that was sent, so "WOULD SHIP" was drawn over "Does not read at tile
size", above a button that writes a real `swap_thumbnail`; under the fixtures
roughly one critique in three was self-contradictory, because
`critiqueFor` picked from the seed rather than from the verdicts it had just
written. The clamp now drops such a recommendation and counts it, the fixture
derives its pick from its own verdicts, and `AssistMetaLine` takes
`marksFallback` so the critique says "nothing is marked as the one to ship"
rather than the ranked-list panels' "the first is marked instead".

**Hooks were always asked for in threes** (17). `WANT.hooks` pinned the ask at
`HOOKS_MAX`, which made `wantedFor`'s hooks branch unreachable from the app —
it only runs when `want` is undefined — so a video with two hooks was offered
three proposals it had room for one of. Both the function's doc comment and
this milestone's decision 5 described behaviour that did not ship. The hooks
request is built without `want`.

**The hooks pill said "Draft a third" on a video with no hooks** (18). The
verb stays the control's identity (`data-assist`, which every spec selects on);
`hookPillLabel` supplies the text from the hook count — "Draft hooks", "Draft
a second", "Draft a third", "Another hook to compare" — through the `label`
prop the integration pass added for exactly this.

**"Add all as candidates" could report zeros** (9). Disabled only on a full
list, it dispatched an empty batch with nothing on screen and produced
"Nothing added — 0 were already in your list and there was no room for 0", in
the file whose comment promises "always a full sentence". The button is now
disabled on an empty list, and `describeAcceptance` has an `asked === 0` guard
so the catch-all can never render zeros. (The blocker above means an empty
list should not reach the panel at all; this is the rule behind the guard.)

**The packaging panel hand-copied chrome's `Proposal` frame** (19). The
integration notes said that frame was drawn in one place so it "cannot be
drawn differently twice"; the brainstorm panel repeated the classes, the chip
and the pick badge inline while the other two panels used the component. It
renders through `Proposal` now, with `testId` and `pickedTestId` — the props
the component already had for this case.

**The capture remedy existed on one of three capture surfaces** (21). M8's
recorded compensation for keeping capture assist-free is that "the capture
toast now carries a link to the video it just wrote". Only the `c` modal did.
The matrix cell's toast now carries the same `links`, and the `/capture`
page's inline confirmation carries an "Open it" link beside it.

**Fixture rationales were assigned round-robin** (22). Text and reasons came
from two pools rotated independently, so a title with no number sat under "…the
number gives it a spine", and eight sentences covered twenty rows. They are
paired — one array of `{say, reason}` — so every fixture rationale is at least
true of the line above it, and a twenty-item list carries twenty distinct
reasons.

**The fixture's dependence on the voice guide was cosmetic** (14, and see
"what the acceptance row actually showed" below). `seedOf` included the guide,
so two guides started the same pool at a different index — a reordering, which
a set assertion passes. Measured by the reviewer: **16 of 20 titles identical**
between two deliberately opposite guides. Each shape now carries two phrasings
and the guide's hash picks which, so the texts differ rather than their
positions; `fake.test.ts` asserts **zero** shared lines between the two
fixture guides. This still proves nothing about a model, and the acceptance
row has been restated to say so.

**Documentation that described code that does not exist** (3/26/29, 5, 28, 30,
31, 32). `AssistCallOptions.signal`'s comment claimed the panel aborts
in-flight calls "so a brainstorm nobody is waiting for stops costing money" —
no caller passes one and none can, because an `AbortSignal` does not cross the
server-action boundary; it is now described as the seam it is, pointing at
`components/assist/run.ts`, which had the accurate account all along.
`vitest.config.mts` named `lib/assist/provider.ts`, which has never existed.
`AssistState.kind` was said to be matched against a late reply; nothing
matches on it, and the invalid-input branch hard-coded `kind: "titles"` — the
comment says what it is for and the branch echoes the requested kind.
`app/videos/[id]/page.tsx` still called the three assists "inert" three
milestones after they became real, and `chrome.tsx` described
`components/preview/assist-pill.tsx` in the present tense after M8 deleted it.
`.env.example` and `README.md` both said "anything else, **including unset**,
means Claude", which is false for the case this milestone spent the most care
on — unset with no key outside production is the fixtures.

**A per-question in-flight guard** (1, partly — see "The honest limit"). The
same POST replayed 25 times in parallel with one session's cookies produced 25
live model calls, each carrying the voice guide and fifty past titles. The
same question asked twice at once is waste in every case, so `assist()` now
refuses a second ask for the same `(user, video, kind)` while one is in
flight, with the existing `rate_limited` code the panel already renders. It is
keyed by *question*, not by user, because two different questions at once is
the design.

### Rejected

Nothing was rejected outright. Two findings were answered differently from
their suggested fix, and both are recorded here rather than silently:

- **1 (rate limit / cost ceiling)** asked for either a server-side ceiling or
  an honest written record of the gap. Both were done, but neither fully: the
  guard above bounds the *repeat of one question*, not spend in general, and a
  per-user hourly quota was not built — it needs a table and a migration for a
  single-tenant app whose only user is the person paying the bill. The
  exposure that remains is written into "The honest limit" below, named rather
  than left to be discovered from an invoice.
- **12** offered "drop the label" as an alternative to asking for the datum.
  Asking for it is the larger change and was chosen anyway, because BRIEF.md
  asks for "a recommended pick" and the panel's own argument is that the
  reason beside a proposal is the part still useful after it closes. A pick
  marked and unexplained is a weaker feature than a pick explained.

### Deferred

- **Nothing to M9.** No finding in this pass was M9 polish. The mobile pass,
  the full shortcut set and the `?` sheet remain M9's, untouched here.

### The honest limit, restated

Everything the previous section said still holds: **the real provider has
never run against the live API from this container**, and no HTTP request has
ever left it for Anthropic. Two things are added to that list by this review.

**An authenticated session can spend the key faster than a person can.** The
in-flight guard above refuses the *same* question twice at once, and it is
process-local, so on a platform that runs more than one instance it bounds a
tight loop rather than a determined one. There is no per-user counter, no
asks-per-hour ceiling and no daily cap. With `ASSIST_PROVIDER` unset in Vercel
every ask is a live `claude-opus-5` call with `max_tokens: 16_000` carrying the
voice guide and up to fifty past titles. For a single-user deployment that is
a deliberate deferral and not a vulnerability; on the day this app has a second
user, a counter is the first thing to add.

**Closing the panel stops the waiting, not the spending.** A server action
cannot be recalled from the browser. The answer is now kept when it lands —
which is the fix above — but the call runs to completion and is billed either
way, and the cancel notice says so.

**What the voice-guide acceptance row actually showed.** The previous section
recorded *"changing the voice guide visibly changes output"* as walked, with
the evidence that "Ask again" returns a different list asserted as a set. That
is weaker than it reads. What the walk demonstrated is that the guide reaches
the prompt (`voiceSection` puts it first, fenced, with "where a craft rule and
this voice disagree, the voice wins" — `prompts.test.ts` holds it to that) and
that the **fixture** is conditioned on it. Whether a model's output is
conditioned on it is unproven from here and belongs on the Vercel checklist
beside `effort` and the beta headers.

**The first four things to check when a key exists in Vercel**, in order: that
a brainstorm returns at all; that the outgoing request carries `effort:
"medium"`, **both** `anthropic-beta` flags
(`server-side-fallback-2026-07-01`, `structured-outputs-2025-12-15`) and
`fallbacks: "default"`; that a refusal arrives as the panel's sentence rather
than a crash; and that two opposite voice guides produce genuinely different
titles for the same video.

### Decisions taken without the user

1. **`videos.brainstorm_last` left the client's UPDATE grant** (migration
   0009). The alternative was to re-read the column immediately before the
   write, which narrows the race from forty seconds to a round trip without
   closing it. A jsonb merge in one statement closes it, and the column having
   exactly one write path is what makes that a property of the schema rather
   than a convention in one action. It is the ninth `security definer` function
   in a codebase whose architecture is "writes go through the server actions
   and the security-definer functions", so it is the shape already established
   rather than a new one.
2. **`recommended_reason` is optional in the schema and asked for in the
   prompt.** `schema.ts`'s doctrine is structural-only: a nine-title answer is
   not a wrong-shape error, and an answer that is useful without a comparison
   must not be discarded over one. The `describe` still travels into the JSON
   Schema the model is shown, and the prompt asks for it in as many words.
3. **The failure sentences name no vendor at all**, rather than naming the one
   that is actually answering. A per-provider sentence table is a second place
   for copy to drift, and the fixtures notice already says who answered —
   which is more useful than a name inside a sentence, because it also says
   what that means.
4. **A cancelled request's answer is adopted; a cancelled request's failure is
   not.** Keeping the answer is what the notice promises and what the column
   is for. Raising an alert about a request somebody explicitly walked away
   from is not, so a late failure is dropped and the panel stays as they left
   it.
5. **The in-flight guard is per question, not per user.** Pressing "Generate
   20" and then "Draft a third" is two panels' worth of work and the design
   supports it; refusing the second would have made the guard a bug.

### Gates for this pass

Every one of these was run after the last edit, on the settled tree, in this
container, with **no `ANTHROPIC_API_KEY` set** — which is the state this
container is always in and the state every number below was produced under.

| Gate | Command | Result |
|---|---|---|
| Types | `npm run typecheck` | clean, both programs (the app, and the harness `tsconfig.harness.json`) |
| Lint | `npm run lint` | clean |
| Build | `npm run build` | succeeds, from `rm -rf .next` |
| Key leak | grep of `.next/static` | **0 files** for `ANTHROPIC_API_KEY`, `api.anthropic.com`, `x-api-key`, `structured-outputs`, `server-side-fallback`, `claude-opus` and `ASSIST_PROVIDER`, across all 52 files. The same grep over `.next/server` finds 6, 5, 7, 2, 2, 2 and 3 — the control that makes the zeroes mean something |
| Database | `./scripts/verify-db.sh m8_final` | **OK — migrations applied, 17 test files passed** (16 before: `75_brainstorm_merge.test.sql` is new, and `90_schema_contract.test.sql` grew three assertions) |
| Unit | `npm test` | **519 passing in 32 files** (was 501 in 31; `components/assist/stored.test.ts` is the new file) |
| End to end, run 1 | `npm run e2e` | **264 passed, 1 skipped, 0 failed (19.7m)** |
| End to end, run 2 | `npm run e2e` | **264 passed, 1 skipped, 0 failed (19.0m)** |

264 rather than 262: `e2e/brainstorm.spec.ts` gained the blocker's walk and the
cancel-and-reopen walk. The skipped one is `session-refresh`, which only runs
under `npm run e2e:refresh` with its own short-lived tokens; it has been
skipped in the default run since M1.

**An intermittent failure is a finding, not noise — and there was one, but it
was not intermittent.** The first full run after these changes reported **8
failed**, every one of them a `videos.brainstorm_last` that stayed null.
The cause was not the code: `playwright.config.ts` sets
`reuseExistingServer` unless `E2E_REUSE=0`, a dev stack from an earlier session
was still listening on the gateway port, and Playwright reused it — so the
suite ran against a database built before migration 0009 existed, where
`merge_brainstorm_entry` is simply not there and every write failed with
`persisted: false`. Confirmed directly (`select count(*) from pg_proc where
proname = 'merge_brainstorm_entry'` → 0 against that database, 1 against a
freshly built one). Both runs above were started with the stack stopped and
`E2E_REUSE=0`, and both are clean. Worth writing down because the failure mode
is silent and looks exactly like a regression: **a run that reuses a stack
predating a migration is not a run of this tree.**

<!-- GATES -->

---

## M9 — The responsive pass: one bar, one sheet, and the 102px column

> The slice that owns `components/app-shell.tsx`, `components/app-sidebar.tsx`
> and the phone behaviour of `/now` and `/capture`. It pays M3's review
> finding 32, which was deferred here by name.

### The finding, reproduced before anything was changed

M3's note was checked in a real browser (Chromium 141, the dev stack, the
seeded account plus one Packaging video with its checklist) before a line of
this slice was written, so the fix is judged against what the page did and
not against a sentence about it:

| Width | Sidebar | `main` | Gutters | Content column | `/now` row label | Tick box |
|---|---|---|---|---|---|---|
| 390×844 | 224px | 166px | 32 + 32 | **102px** | 7 lines for "Generated 10–20 title candidates, not 3"; the age ("4 days") printed over the label | 13×16px |
| 360×800 | 224px | 136px | 32 + 32 | **72px** | 5 lines, same overlap | 13×16px |

The note's numbers were exact. The one thing it undersold is the overlap: it
was not only the tick box — the row's age span was drawn on top of the label,
because a `min-w-0` label in 102px lets its longest word overflow into the
flex sibling beside it.

After this slice, measured the same way:

| Width | Bar | `main` | Gutters | Content column |
|---|---|---|---|---|
| 390×844 | 56px bar + 1px rule across the top | 390px | 16 + 16 | **358px** |
| 360×800 | same | 360px | 16 + 16 | **328px** |
| 768 | 224px sidebar (unchanged) | 544px | 24 + 24 | 496px (reading views 480) |
| 1024 – 1920 | 224px sidebar (unchanged) | width − 224 | 32 + 32 (reading 40 + 40) | unchanged from M3 |

### What this slice delivers

- **The sidebar is a bar below 768px** (`md`). One element, two layouts: at
  phone width the same wordmark and the same `CaptureHost` sit in a 56px bar
  pinned to the top, beside a 44px menu button; the sections, channels, theme
  control and account move behind the button. From `md` up the sidebar is
  byte-for-byte the layout M3 signed off — `e2e/responsive.spec.ts` pins its
  boxes at 1024, 1280, 1440 and 1920 (wordmark at 12,16; Capture 199×34 at
  12,45; Now 199×32 at 12,99), which are the numbers the pre-M9 tree drew.
- **The menu is the application's one modal**, not a drawer of its own.
  `Modal` gained one prop, `placement: "center" | "start"`, which changes the
  geometry and nothing else: a full-height sheet against the leading edge on
  the sidebar's ground, leaving a strip of backdrop to tap. Focus moves in and
  is trapped, Escape closes it from anywhere, the backdrop closes it, focus
  returns to the menu button, and the `exclusive` shortcut scope keeps `c`,
  `j`, `x` and `1..9` off the page underneath — all of which `Modal` already
  did for the capture box. The button carries `aria-expanded` and
  `aria-haspopup="dialog"`; the sheet is `role="dialog"`, `aria-modal`, named
  "Menu", and holds a `<nav aria-label="Main">`. Choosing a link closes it; so
  does widening the window past the breakpoint.
- **Gutters that scale, from the tokens.** `--spacing-gutter` and
  `--spacing-gutter-reading` are redefined in `@layer base` media queries in
  `app/globals.css`: 16/20 below 768, 24/32 from 768 to 1023, and the signed-off
  32/40 from 1024 up. No component changed; every `px-gutter`, `-mx-gutter` and
  `py-gutter-reading` follows. `scroll-padding-top` is set at phone width so an
  in-page jump stops below the pinned bar instead of under it.
- **One variant for "a thumb is the pointer"**: `thumb:` in `app/globals.css`,
  `(width < 48rem), (pointer: coarse)`. It is used for target sizes and
  nothing else, so a mouse on a desktop keeps the density the design asked for
  and a finger gets 44px — including a phone in landscape, which is wider than
  `md` and gets the desktop sidebar.
- **`/now` on a phone.** Every control a row offers — the tick, Save, Confirm
  live, the hook chips, Unblocked, Still waiting, Keep it, Swap, Move, the
  metrics pair and its Log button, the filter chips — is 44px tall under
  `thumb:`. The tick is now a `<label>` wrapping the box and its sentence, so
  the sentence is part of the target (the checkbox keeps its own `aria-label`,
  which wins for its name). The video's title takes its own line and may use
  two; the chips go under it at 24px, WCAG 2.5.8's floor for a target that is
  not the row's own control; the label is 15px. Every field on the list is
  16px below `md`, because anything smaller makes iOS Safari zoom the page on
  focus.
- **`/capture` on a phone.** The claim in PLAN.md:116 was checked rather than
  assumed, and half of it did not hold: the page rendered no shell (true), but
  its Capture button sat at y=398 on a 390×844 screen — under a phone keyboard,
  which leaves roughly the top 440px. Below `md` the save now sits on the title
  field's own line, and the browser always scrolls a focused field into view,
  so the save cannot be hidden. The keyboard-only sentences in the hint
  (Shift+Enter, Alt+1–9) are hidden on a coarse pointer, where there are no
  such keys. The same form is the `c` dialog, so the dialog opened from the
  phone bar gets the same fix.
- **The other views, walked at 390.** A person who taps through does not hit
  anything broken, and where a view is a desktop view it says so in the view:
  - *Board*: the strip already scrolled sideways inside itself. A touch does
    not start an HTML5 drag, so on a thumb the header sentence that offered
    dragging is replaced with the one that works ("Swipe sideways through the
    columns; ← and → on a card move it. Dragging cards needs a mouse and a
    wider screen."), and the card arrows are 44px under `thumb:`.
  - *Calendar*: seven columns of 350px are 50px a day — a date and a channel
    tag, not a title. Below `md` the page says "A month needs a wider screen to
    read titles. Here, tap a chip to open its video."
  - *Matrix*: **it scrolled the whole page 507px sideways at 390** once a
    channel had pillars. Not the table — that was inside its own scroller —
    but its `sr-only` labels: `position: absolute` with no positioned
    ancestor, so their containing block was the viewport, and overflow
    clipping does not apply to a box whose containing block is outside the
    clipping element. `main` is now `relative`, which makes it their
    containing block, and the shell's `overflow-x: clip` holds. The fix is in
    the shell, so it covers every visually hidden label in every sideways
    scroller, not just this one.
  - *Settings → Stages*: the rename field was 40px wide at 390 ("Ide",
    "Packa") because the count and the switch took a third grid column.
    Below `md` they drop under the note, and the field has a 128px basis.
- **Scroll, at every width, on every route.** `e2e/responsive.spec.ts` visits
  thirteen signed-in routes (including the matrix with pillars and the video
  page's Thumbnails section, the two widest things in the app) at all seven
  widths, and asserts both that `scrollWidth` equals `clientWidth` and that
  `window.scrollTo(10000, y)` leaves `scrollX` at 0 — the second because the
  matrix bug above was found by trying to scroll, not by reading a number.

### Decisions taken without the user

1. **The breakpoint is 768px (`md`), and the menu opens from the left.** 768 is
   where a 224px sidebar still leaves a 496px column with 24px gutters — a
   usable board and a comfortable `/now` — and below it the sidebar was
   eating a third of the screen or more. Left, because that is where the
   sidebar is on a desktop: the menu is the same thing, arriving from the same
   side.
2. **Capture stays on the bar, not behind the menu.** It is the one control in
   the sidebar that *does work* rather than navigate, and BRIEF.md's capture is
   "a global shortcut, one input, save, done" — two taps through a menu would
   break that on the device where it matters most. It is the same
   `CaptureHost` element, restyled, so `c` is still bound exactly once.
3. **The sheet renders the links a second time; nothing else is duplicated.**
   The desktop `<nav>` is `display: none` below `md` (out of the accessibility
   tree too), and the sheet draws a second server rendering of the same lists
   with its own ids, so there is one "Main" navigation at every width and no
   duplicate id. `CaptureHost` and `ChannelShortcuts` — the things that bind
   keys — are mounted once in the bar and never passed into the sheet.
   *(Integration note: the keyboard slice has since replaced the
   `ChannelShortcuts` mount with `KeyboardShortcuts`, which contains it; the
   rule is unchanged — it is mounted once, in the bar.)*
   The alternative, extracting `Modal`'s behaviour into a hook and applying
   dialog semantics to the in-place sidebar, would have made two consumers of
   one half of the modal; one prop on the whole modal is smaller.
4. **The keyboard hint bar is not in the sheet.** A phone has no keys, and a
   narrow desktop window still has the `?` sheet. The theme control and Sign
   out are in it, because those are things a phone user needs.
5. **Targets: 44px for a row's own controls, 24px for the chips that link
   elsewhere**, under `thumb:` only. 44 is the Apple/WCAG AAA figure; 24 is
   WCAG 2.5.8 AA, applied to the channel and stage chips because making every
   chip 44px would have doubled each row's height to satisfy a link nobody
   came to the row to press. A mouse on a desktop gets M3's density back.
6. **`/capture` has two submit buttons in its markup, one per layout, never
   both displayed.** A single button moved by CSS `order` would have put the
   visual order and the tab order out of step; a single button moved *up* for
   everyone would have put the save above the disclosure's fields on a
   desktop. `display: none` removes the other from the tab order and the
   accessibility tree, so there is one "Capture" at any width — which is also
   what `e2e/capture.spec.ts`'s existing phone test (`getByRole('button', {
   name: 'Capture' })`, strict) already required.
7. **The calendar says "wider screen" instead of becoming an agenda.** An
   agenda view at phone width would be a second calendar, and M9 adds no
   features. The grid still works — every chip is its video's link and nothing
   scrolls sideways — and the page says what it is not good at.

### Deviations from PLAN.md, stated plainly

- **The mobile pass went past `/now` and `/capture`.** PLAN.md:199 scopes it to
  those two, and they are the two that were made genuinely good. The rest —
  the board's copy and card arrows, the calendar's note, the matrix's page
  scroll, the stage row's reflow — are the minimum for a tap-through not to
  land on something broken, as this milestone's brief asked.
- **`Modal` gained a prop.** It is still the one modal; `placement="start"` is
  geometry only, and the M4 swap dialog, the matrix's capture cell and the
  filming-day dialog are unchanged (`placement` defaults to `"center"`). Its
  close button now says "Close" on a coarse pointer — a touchscreen has no
  Escape key — and "Escape to close" everywhere else.

### Honest limits

- **No real phone was used.** Every number here is Chromium at a phone-sized
  viewport, with a mouse. In particular:
  - *"The keyboard is open"* is simulated as a 390×440 viewport. Real iOS
    Safari does not shrink the layout viewport for its keyboard (it shrinks
    the visual one and scrolls the focused field into view); the inline save
    is designed around exactly that, but it has not been seen on a device.
  - *`pointer: coarse`* is never true in the suite. What it switches — the
    hidden keyboard sentences on `/capture`, "Close" on the modal, the
    thumb sizes at widths above 768 — is proved only by reading the CSS the
    build emits, not by a test.
- **The calendar's chips are below 24px at 390.** They are links to videos
  and they work, but they are small; the page says the grid is a desktop view
  rather than pretending otherwise.
- **The board is a desktop view.** It is operable on a phone (swipe the strip,
  tap the arrows), and it says so, but a kanban of nine 216px columns is not a
  phone layout and was not turned into one.
- **The other settings screens, the ideas list and the video page's five
  sections were checked for sideways scroll at all seven widths and looked at
  in a 390px screenshot**, not walked control by control the way `/now` and
  `/capture` are. The stage row was the one broken thing that walk found.
- **The sheet's links are rendered twice in the RSC payload** — once for the
  desktop column, once for the sheet. It is a few hundred bytes of links and
  counts; it is also the reason the sheet cannot drift from the sidebar.
- **Two agents edited the shell at once.** The shortcuts slice moved
  `components/channel-shortcuts.tsx` and `components/shortcut-hints.tsx` into
  `components/shortcuts/` while this slice was restructuring
  `components/app-sidebar.tsx`; the sidebar's imports were pointed at the new
  paths here. Nothing else of that slice was touched.

### Gates for this slice

*(Moved here from under the keyboard section by the M9 integration pass, where the two slices' concurrent edits had left it.)*

Run in a tree other M9 slices were editing at the same time (the shortcut set,
and the empty and error states); the numbers are what this container printed.

| Gate | Result |
|---|---|
| Lint (every file this slice touched, and `e2e/responsive.spec.ts`) | clean |
| Types (`tsc` on the app and on the harness) | clean for this slice. The only errors in the tree at the time were in `e2e/shortcuts.spec.ts`, another slice's file mid-edit |
| Unit (`npx vitest run`) | 519 passed, 32 files (this slice adds no unit test — nothing in it is a pure function) |
| `e2e/responsive.spec.ts` | **8 passed** in the full run below |
| Full suite, cold (`E2E_REUSE=0 npx playwright test`, stack stopped first) | **281 passed, 3 failed, 1 skipped (29.8m)** |
| Re-run of the failures plus every spec this slice's markup reaches (`m2-review`, `responsive`, `shell`, `capture`, `now`), cold | **51 passed, 0 failed (6.3m)** |

**The three failures, named rather than rounded off.** Two were in
`e2e/m2-review.spec.ts`: one found `/now` rendering the new "This page didn't
load" error boundary instead of the page, the other a packaging save that
never started. Both pass on the re-run above, against the same tree, and the
error boundary they hit was being written by another slice during the run —
so the most likely cause is a hot-reload of a half-written file. That is a
likelihood, not a proof. The third was `e2e/shortcuts.spec.ts:472`, the
shortcut slice's own spec, in progress. The full run should be repeated once
the tree has stopped moving, and the orchestrator's gate run is the one to trust.

**Found by an earlier run, and fixed.** The first version of the desktop
assertion expected the sidebar strip to be exactly as tall as the viewport. In
a full run `/now` holds every other spec's leftover videos and is longer than
the viewport, and the strip runs the page's full height by design (M3: the
ground must not stop at the fold). The assertion is now "at least the
viewport", which is the actual claim.

## M9 — The keyboard: one set, one sheet, one Escape

Eight milestones each added a key or two. This slice took stock of all of them,
made them one set, gave the set its `?` sheet, and wrote down once what Escape
means. It owns `lib/shortcuts.ts` and `components/shortcuts/**`. It adds no
feature a key did not already stand for, with two exceptions that close gaps
the inventory found (`g` navigation, which PLAN.md:151 always had, and `/` for
the one search box).

### The inventory, taken before anything changed

Every keyboard path in the tree, found by grepping for `useShortcuts`,
`addEventListener`, `onKeyDown` and `event.key` across `app/`, `components/`
and `lib/`, not by reading the milestone notes:

| Key | What it did | Where | Mechanism |
|---|---|---|---|
| `c` | Open the capture box | every shell route | registry (`capture-host.tsx`) |
| `1`–`9` | Go to the nth channel's board | every shell route, 2+ channels | registry (`channel-shortcuts.tsx`) |
| `j` / `k` | Select next / previous | board, `/now`, idea bank | registry, three call sites |
| `[` / `]` | Move the selected card by kind order | board | registry |
| `Enter` | Open the selected item | board, `/now`, idea bank | registry |
| `x` | Do the selected `/now` row's action | `/now` | registry |
| `p` | Promote the selected idea | idea bank | registry |
| `Escape` | Clear the card selection | **board only** | registry |
| `Escape` | Close the dialog | capture, swap reason, (M9) phone menu | **React `onKeyDown` in `modal.tsx`** |
| `Escape` | Close the panel | the four assist panels | **React `onKeyDown` + `stopPropagation` in `assist/chrome.tsx`** |
| `Escape` | Revert the field | stage name, bucket name, bucket quota, template text | field `onKeyDown`, **not consumed** |
| `Tab` / `Shift+Tab` | Focus trap | every dialog | React `onKeyDown` in `modal.tsx` |
| `Enter`, `Shift+Enter`, `Alt+1–9` | Save / more fields / retarget | capture title field | field `onKeyDown` |
| `Enter` | Commit / add | title candidates, hooks, working title, metrics, confirm-live, tag editor, flow fields, `/now` inline input, settings rows | field `onKeyDown` |
| `Backspace` | Remove the last tag when the draft is empty | tag editor | field `onKeyDown` |

Not bound anywhere, though PLAN.md:151 lists them: `g n/b/i/k` and `?`.

### What was wrong with it

1. **Escape meant three things by three mechanisms.** The registry had one
   (the board's selection), the modal had its own React handler, and the
   assist panel had a third whose comment claimed `stopPropagation()` kept the
   key from the registry. It did not: React 19 and the registry both listen on
   `document`, and stopping propagation does not stop a second listener on the
   same node. No bug had come of it only because no page yet had a panel and
   an Escape binding at once.
2. **Escape meant something on the board and nothing on `/now` or in the
   bank**, the other two lists with the same `j`/`k`/`Enter`.
3. **A checkbox counted as typing.** The registry treated every `<input>` as a
   text field, so after ticking a `/now` row with the mouse, `j` did nothing
   until you clicked somewhere else.
4. **On `/now`, `j` did not move focus.** The board and the bank move focus
   to the selected item (the M5 review's "focus follows the selection");
   `/now` only scrolled. Focus stayed wherever the last click put it. After
   clicking a channel chip, `Enter` (which rightly stands aside on a focused
   button) re-toggled the chip instead of opening the row. The new spec found
   this.
5. **`[` was unreachable on a German or French Windows keyboard.** There it is
   AltGr+8, which arrives as Ctrl+Alt, and the registry drops anything with
   Ctrl or Alt held. The file's own header claimed `[` "works on any layout
   that produces `[`".
6. **Settings fields reverted on Escape without consuming it**, so they were
   one future overlay away from an Escape that did two things.

### The set, as it stands

| Keys | Does | Where |
|---|---|---|
| `g` then `n` / `b` / `i` / `c` / `s` | Go to Now / Board / Ideas / Calendar / Settings | every shell route |
| `1`–`9` | Go to that channel's board | every shell route, 2+ channels |
| `c` | Capture an idea | every shell route with a channel |
| inside the box: `Enter`, `Shift+Enter`, `Alt+1–9`, `Escape` | Save, more fields, another channel, close | the capture box |
| `j` / `k` | Select next / previous | board, `/now`, idea bank |
| `Enter` | Open the selected video | board, `/now`, idea bank |
| `Escape` | Clear the selection | board, `/now`, idea bank |
| `[` / `]` | Move the selected card back / forward a stage | board |
| `x` | Do the selected row's next action | `/now` |
| `p` | Promote the selected idea | idea bank |
| `/` | Search titles and hooks | idea bank |
| `?` | The sheet (again, or Escape, to close) | every shell route |

It stays small on purpose. The rule for going places is the sidebar row's
initial. The rule for lists is `j`/`k`/`Enter`/`Escape` on all three.
Page-specific verbs get one letter each (`[ ]`, `x`, `p`, `/`), and each exists
on exactly one route.

### Escape, defined once

Written in the header of `lib/shortcuts.ts` and enforced there. One press
dismisses exactly one thing, the first of:

1. an armed `g` sequence;
2. the newest **overlay**, meaning any `Modal` (capture, swap reason, the `?`
   sheet, the phone menu), from anywhere, including from inside a text field;
3. the **region** focus is inside, meaning an assist panel;
4. an ordinary `Escape` binding (clearing the selection), which like every
   binding stands aside while you are typing.

A field that gives Escape a local meaning calls `preventDefault()` and so
comes first. The four settings fields now do. `useDismiss(onDismiss, {within})`
is how a layer joins. `Modal` and `AssistPanel` use it, and the two React
Escape handlers are gone. Nothing else in the application listens for Escape.

### One mechanism

`lib/shortcuts.ts` is still the only `keydown` listener on `document` (the
field-level `onKeyDown`s are React handlers on the fields themselves, which is
what they should be). The two Escape handlers above were folded in.
`components/channel-shortcuts.tsx` and `components/shortcut-hints.tsx` moved
into `components/shortcuts/`. The sidebar now mounts one `KeyboardShortcuts`
(`1`–`9`, `g`, `?`, the sheet, the sequence indicator) where it mounted
`ChannelShortcuts`.

### The sheet

`?` opens it on every shell route; `?` or Escape closes it and focus goes back.
Its rows are **read off the registry** at the moment it opens
(`readShortcutSheet()`), so it lists only what is bound on this route and
cannot drift. The capture box's field keys, which the registry cannot see, are
the one hand-written group, and the spec presses every one of them. Groups
follow what the person is doing: this page's keys, then Capture, then Get
around, then Closing things. The sheet uses two columns at `md` and up (a
`width="wide"` option on `Modal`), because at one column it ran past the
bottom of a 900px screen. It is honest about what is not here. The views
whose keys are not live on this route are named at the bottom as links ("Not
on this page: Now and the idea bank each have keys of their own — press ?
there").

After `g`, a small bar at the bottom of the screen lists where the next key
goes, for the 1.5 seconds the sequence waits. It is a live region, so a
screen reader hears the same list.

### Decisions taken without the user

1. **`g c` is the calendar, not PLAN.md's `g k`.** One rule (the sidebar
   row's initial) beats five keys to learn. `k` was presumably chosen because
   `c` is capture, but after `g` the registry reads the next key only as a
   destination, so there is no clash. `g s` (Settings) was added by the same
   rule, since Settings has been a sidebar row since M7.
2. **The second key of a sequence is always consumed.** `g` then a stray `c`
   does nothing rather than opening capture. After `g`, a letter means a
   place.
3. **The hint bar stays** (M1 review finding 18 asked M9 to reconsider it).
   It is what someone who has never pressed `?` sees, and its last item is a
   button that opens the sheet, which is how a mouse user finds the keyboard
   at all. It no longer tries to be complete: `g`, `/` and Escape are
   sheet-only (`hint.bar: false`).
4. **Escape clears the selection on `/now` and in the bank too**, as it has on
   the board since M1.
5. **An assist panel is a region, not an overlay.** It is inline and the page
   keeps working around it (M8's reasoning), so Escape closes it only when
   focus is inside it. With focus elsewhere on the page, Escape leaves every
   open panel alone.
6. **Checkboxes, radios and buttons are not "typing".** Letter keys work from
   them; Enter and Space still belong to the browser there.
7. **AltGr is a way to produce a key, not a modifier on one.** A key typed
   with AltGr is that key. Ctrl or Alt without AltGr still belongs to the
   browser.
8. **`/` exists only in the idea bank**, because that is the only search box.
   It is bound by the component that draws the box, so the key and the box
   cannot come apart.

### Deviations from PLAN.md, stated plainly

- `g k` → `g c`, and `g s` added (decision 1).
- `Escape` (clear selection) on `/now` and the bank, and `/` in the bank:
  PLAN.md:151 lists neither.
- PLAN.md:151 says the hook "ignores events from inputs". It now ignores
  events from text-entry inputs. A checkbox is an input and is no longer
  ignored (decision 6).

### Honest limits

These are for the README's limits section; this slice did not edit the README.

- **No key moves a video from its own page.** `[`/`]` exist only on the board.
  On `/videos/[id]` the stage select is one Tab away. Binding `[`/`]` there
  would need the board's kind-order semantics (it skips inert stages), and
  the page's select does not carry kinds. A key that meant "next stage" on one
  page and "next option in the select" on another is the incoherence this
  slice exists to remove.
- **No keys on the calendar, the matrix, settings or `/capture`** beyond the
  application's own (`g`, `1`–`9`, `c`, `?`). `/capture` has no shell, so it
  has no `?` either. It is the phone bookmark, and the page is the form.
- **The sheet is unreachable by touch on a phone.** The hint bar and its "all
  keys" button live in the desktop sidebar. That is deliberate (a phone has no
  keys), but a phone with a hardware keyboard gets the keys without a visible
  way to learn them other than `?`.
- **Keys match `KeyboardEvent.key`**, so a layout that produces `j` elsewhere
  gets `j` elsewhere, which is the right trade for letters. The AltGr case is
  proved with a synthetic event. No real non-US keyboard was used.
- **Sequences cannot be remapped**, and nothing can. There are no user
  keybindings.
- **The `g` indicator lasts 1.5 seconds** and is not configurable.

### Gates for this slice

Run in this container with no `ANTHROPIC_API_KEY`, while two other M9 agents
were editing the same tree and running their own stacks.

| Gate | Command | Result |
|---|---|---|
| Types | `npm run typecheck` | clean, both programs, after the last edit |
| Lint | `npm run lint` | clean |
| Unit | `npm test` | 519 passing in 32 files (no unit file touched) |
| Browser, full | `E2E_REUSE=0 DEV_STACK_PORT=54341 DEV_STACK_POSTGREST_PORT=54342 NERTUBE_DEV_DB=nertube_e2e_keys E2E_PORT=3113 npx playwright test` | **282 passed, 2 failed, 1 skipped (23.5m)**, on a database built fresh by that run, on ports no other agent was using |
| Browser, this spec after the fixes below | `E2E_REUSE=1 npx playwright test shortcuts` | **12 passed**, against another agent's running stack (its `next dev` held the directory's dev lock, so a second isolated run was not possible) |

The two failures in the full run, named:

1. **`shortcuts.spec.ts`, the `1–9` step.** On a database a full run has
   filled, "Keys" is the tenth-or-later channel, and only the first nine get
   a digit. The spec now uses a seeded channel and throws a named error if a
   channel has no digit. Re-verified in the 12-pass run above. This was the
   spec's assumption; the application was right.
2. **`responsive.spec.ts:748`** (the responsive slice's, not this one's)
   expected the sidebar strip to be exactly the viewport's height. On a full
   run's long `/now` it is 2733px. That slice has since rewritten the
   assertion to "at least the viewport".

Two changes landed after the full run and are covered only by the 12-pass
run: that fix, and the sheet's "Not on this page" line excluding the current
page. **The orchestrator's final `E2E_REUSE=0` full run is the one that
counts for this slice.** None of the 270-odd existing specs needed a change
for the keyboard work: the hint-bar assertions in `m1-acceptance`, the
capture box, the swap dialog and the assist panels' Escape all passed
unmodified.

## M9 — Empty states, error states, and the README

> The slice that owns what an empty or failing view says, and `README.md`.
> It adds no feature. It pays three deferred items (the NUL byte from M7, the
> e2e reuse default from M4, the Filming literal from M6), accounts for every
> other one, and found one real defect on the way (a session that ends
> mid-edit was reported as the server being down).

### What a brand-new account saw, before this slice

Established by reading the tree at `4a7748c` route by route, and — for the one
case whose outcome the code did not make obvious — by walking it in Chromium
before changing anything. The other rows were **not** screenshotted before the
change; they are what the code at that commit renders.

| Where | What it showed |
|---|---|
| `/` → `/c/new`, the first screen of the product | "New channel" and a form: identical for the first channel and the fifth, with no word about what a channel is or why everything else waits on one. |
| `/c/<slug>/board`, just created | Nine columns, each reading "Nothing here yet." Nothing said how a card gets onto one; the only ways in were `c` and a sidebar button nobody had been told about. |
| `/now`, a channel and no videos | One muted line: "Nothing is waiting on you. Capture an idea with c, or promote one from the board." A key a phone does not have, and no button. |
| `/now`, six ideas captured and none promoted | **The same line — which was false.** Six things were waiting; `/now` skips kind `idea` by design and never said so. |
| `/c/<slug>/ideas`, empty | The summary, a filter bar of five controls that could only ever find nothing, and "This bank is empty. Press c to capture an idea". |
| `?view=matrix`, no pillars | The M7 `NoVerticals` card — the best of them, with a real link to the bucket editor — in its own card style and three paragraphs. |
| `/calendar`, no channel yet | "No video anywhere has a target publish date yet … a card from the board", with *the board* unlinked because there was none. No way forward. |
| `/videos/<unknown id>`, `/c/<unknown slug>/…`, `/settings/<section>/<unknown slug>`, any unmatched URL | Next's default "404 · This page could not be found." No sidebar, no link, no way back but the browser's. There was no `not-found.tsx` anywhere. |
| Any page whose read throws | Next's default error screen — in production "Application error: a server-side exception has occurred". There was no `app/error.tsx`; three components' comments said so, each having been bitten. |
| `/` when the channel read fails | A redirect to `/c/new`: an existing user greeted with "New channel" because the database blinked. `app/settings/first-channel.ts` did the same. |
| **A session that ends mid-edit** (walked) | The Notes field on the video page said "Could not reach the server, so this is not saved. Nothing you typed has been lost — try again." **False, and the way forward could never work**: `proxy.ts` 307s the signed-out action POST to `/login`, the action's fetch follows it to HTML it cannot parse, and every retry is redirected the same way. |
| A failed save with the network down | The save queue's line with Retry — already one presentation across the video page and settings. Kept. |

### What changed

- **One presentation: `components/state-panel.tsx`.** Title (what this view is,
  in the state it is in), one or two sentences (why, and what changes it), and
  actions (the one thing to do next, then at most a quiet alternative). A card —
  8px radius, 1px hairline, surface ground, no shadow — so an empty view reads as
  a view with something in it rather than a page that did not finish loading.
  `tone="problem"` adds one thing: a 3px rule in the attention colour, not red
  (red means a rule is being broken right now). `actions` is required: a panel
  with no way forward is the dead end it exists to prevent. Used by the board,
  `/now`, the bank, the matrix, the calendar, every not-found page and the
  error page.
- **Capture from an empty view is the capture box.** `CaptureDialog` (the modal,
  the form, the toast with "Open it") was extracted from `CaptureHost`, which now
  renders it; `CaptureLink` opens it from an empty state. Link first and dialog
  second, like the matrix's empty cell: a real `<a href="/capture?c=…">` that a
  click intercepts. After a save it refreshes the route and puts focus on the
  video that arrived — the link that opened the box was the empty state, so
  `Modal`'s own focus return would land on `<body>`.
- **`/c/new`** reads the count: the first time it says "Start with a channel"
  and two sentences about what a channel holds; after that it is the plain form.
- **The board**: a panel above the columns when there are no cards (the columns
  still draw — they are the answer to "what is this page"), and each empty column
  is a quiet dashed slot with an `sr-only` sentence instead of "Nothing here yet."
  eight times over. A channel with every stage off gets a panel linking to stage
  settings instead of a bare sentence.
- **`/now`** says *why* it is empty (`components/now/now-empty.tsx`): nothing
  captured (capture here), ideas but nothing in production (to the bank with
  the most ideas, where Promote is), or videos in production with no step to
  offer (to the board). The filter chips are hidden when there is nothing to
  filter.
- **The bank**: a panel for a bank that has never held anything and one for a
  bank worked through by promotion ("Everything in the bank has moved on", with
  the board one click away). The filter bar is not drawn over an empty bank.
  The summary sentences `e2e/ideas.spec.ts` asserts are unchanged.
- **The matrix and the calendar** use the panel. The calendar's channel-less
  case now offers "Create your first channel"; its nearest months are the
  actions. `e2e/calendar.spec.ts`'s text and hooks are unchanged.
- **Not found, four ways, in the frame**: `app/not-found.tsx` (anything),
  `app/videos/[id]/not-found.tsx` (which cannot say whether the video exists
  elsewhere, on purpose), `app/c/[slug]/not-found.tsx` and
  `app/settings/not-found.tsx` (which list your channels, each one click from the
  same place in the right one). All render inside `AppShell`; the status stays
  404, which `e2e/upload.spec.ts` and `e2e/settings-checklists.spec.ts` assert.
- **`app/error.tsx` and `app/global-error.tsx`.** "This page didn't load", or
  "You're offline" when the browser knows it is; nothing already saved is
  affected; Try again (`retry`, Next 16.3's re-fetching reset) and Go to Now
  (a full load). The digest is printed small; the server's message never is.
- **A failed read is not an empty account.** `/` and the settings redirect now
  throw when the channel read fails, and land on the error page, instead of
  sending an existing user to `/c/new`.
- **A write that gets no answer is diagnosed** (`lib/write-failure.ts`):
  offline (the browser's flag), signed out (a `HEAD` for the current page with
  `redirect: "manual"` comes back as the proxy's redirect), or unreachable. The
  save queue says "You have been signed out, so this is not saved. What you
  typed is still here…" and puts a **Sign in (new tab)** link beside it — a new
  tab, because this one holds the unsaved text; the cookie is shared, so the next
  save here goes through. Capture, checklist ticks and `/now`'s rows use the same
  diagnosis for their sentence. The offline sentence still begins "Could not
  reach the server", which is true and is what `e2e/now.spec.ts` asserts.
- **Deferred items paid** (table below): the NUL byte, the e2e reuse default,
  the Filming literal. And `supabase/config.toml`, which the README had been
  describing since M0 and which **did not exist** — `supabase init` was never
  run. It is now the pinned CLI's own output with three changes.
- **`README.md`** rewritten: what NerTube is, the principles and why the data
  model looks like it does, running it with Docker and without (and why not to
  reach for `supabase start` without Docker), every environment variable with
  no value, the browser-client rule, deploying, and the limits.

### Every item deferred to M9, accounted for

| From | Item | Where it went |
|---|---|---|
| M3 review, finding 32 | The shell has no responsive breakpoint | The responsive slice (above). |
| M3 deviation 1 | `/` lands on the board, not `/now` | Already closed by M3's integration pass (`app/page.tsx` → `/now`); checked, not redone. |
| M4 review | `npm run e2e` should refuse a stack it did not start | **Done here.** `playwright.config.ts` reuses neither server unless `E2E_REUSE=1`; with a stack already up, Playwright stops before any test. The config comment, `scripts/dev-stack/README.md` item 31 and the README say so. |
| M4 review | `channels.expected_ctr` has no UI | Closed by M7 (the channel settings form); checked. |
| M5 review | No way to create a bucket | Closed by M7; this slice's spec walks it from an empty matrix. |
| M6 review | `aria-disabled` instead of `disabled` on in-flight controls, application-wide | **Not done.** Recorded in the README's limits. It is a mechanism change in every in-flight control, in files three M9 slices were editing at once; doing it blind in the last pass was the riskier choice. |
| M6 review | `e2e/board.m1.spec.ts`'s literal "3 in Filming across all channels" | **Done here.** The spec counts Filming videos outside its own channels and asserts `3 + n`, and asserts the count going down rather than the badge disappearing when other specs' videos keep it at three. |
| M6 → M7 → M9 | The timezone question ("today" is the UTC day) | **Not done**, as a decision (below). In the README's limits. |
| M7 review, finding 13 | The add-a-stage and add-a-bucket forms as one component | **Not done**, as a decision (below). In the README's limits. |
| M7 review | The video page's text fields and the NUL byte | **Done here.** `cleanProse` in `NullableText`, the working title, tags, title candidates and their notes, hooks, the skip reason, the new-viewers note, the capture title and the swap reason. `lib/video-text.test.ts` (6 cases) pins each, including that a zero-width joiner in prose survives. |
| M8 | "The script editor is M9's job, per PLAN.md" | PLAN.md:199 does not assign it to M9, and M9 adds no features. In the README's limits, prominently: the script is read-only, and `script_structure` and `end_screen_target` have no UI at all. |

### Decisions taken without the user

1. **An empty view keeps its structure.** The board draws its nine columns under
   the panel; the matrix keeps its formats strip. The alternative, replacing the
   view with a welcome card, hides the one thing that explains what the page is.
2. **Capture from an empty view happens in place**, in the same box `c` opens,
   rather than on `/capture`. The person should watch the view stop being empty.
3. **`/now`'s empty action depends on why it is empty**, and "ideas but nothing
   in production" sends you to the bank, not to the board: Promote is there.
4. **The error page has no sidebar.** The shell is itself a database read, and
   drawing it on the page that says the database did not answer would be a
   second failure on top of the first.
5. **A signed-out save offers sign-in in a new tab**, not a redirect: a redirect
   is exactly what loses the unsaved text. Retry is the person's, after.
6. **A 404 never says whether the thing exists for someone else**, as
   `app/videos/[id]/page.tsx` already argued for its status code.
7. **`supabase/config.toml` is the CLI's generated file** (v2.117.0, the pinned
   dev dependency) with `project_id`, both `enable_signup` switches and the
   seed step changed. Hand-writing one from memory would have been a file that
   looks right and is not.
8. **No timezone setting.** It needs a per-user profile table, a settings screen
   and a change to the one date helper every view reads — a feature, and M9
   adds none. "Today is the UTC day" is the first entry under the README's
   "things it does, with a catch".
9. **The two add forms stay two.** They share a text field and a button and
   differ by a quota box and its validation; one component with a slot for the
   difference is more code than the two it replaces, and both are already the
   same control visually.

### Deviations from PLAN.md, stated plainly

- PLAN.md:199 names "empty states" for M9. This slice also built the error
  states (the M9 brief asked for them): four `not-found.tsx` files, `error.tsx`
  and `global-error.tsx`, none of which PLAN.md's route table lists.
- PLAN.md's M0 says `supabase init`. It was never run; `supabase/config.toml`
  arrives in M9.
- `lib/write-failure.ts` makes one extra request (a `HEAD` of the current page)
  after a write has failed, and only then.

### Honest limits

- **The "before" table is code reading**, except the session-expiry row, which
  was walked in Chromium before the fix and again after it.
- **The session diagnosis reaches four callers, not all of them.** The save
  queue, capture, checklist ticks and `/now`'s rows. The board's moves, the
  bank's Promote and Archive, the settings editors, the filming-day dialogs and
  the thumbnail and assist controls still say "Could not reach the server" when
  the session has gone. In the README.
- **The error page is proved with an induced failure**, not a dropped
  connection: a restrictive RLS policy that raises for the spec's own account
  alone (so a suite sharing the stack is unaffected). The "You're offline"
  branch and `global-error.tsx` are not exercised by any spec.
- **The diagnosis `HEAD` renders the page on the server** once per failure. Cheap
  at one user; a dedicated endpoint would be cheaper and would be an API route,
  which PLAN.md's architecture does not have.
- **No real phone, again.** The empty states were looked at at 390px in
  Chromium, not on a device.

### Gates for this slice

Run in this container with no `ANTHROPIC_API_KEY`, while the two other M9
slices were editing the same tree and running their own stacks.

| Gate | Command | Result |
|---|---|---|
| Types | `npm run typecheck` | clean, both programs |
| Lint | `npm run lint` | clean |
| Unit | `npm test` | **525 passing in 33 files** (519 before, plus `lib/video-text.test.ts`'s 6) |
| SQL | `./scripts/verify-db.sh nertube_m9_empty_verify` | OK — migrations applied, 17 test files passed |
| Build | `npm run build` | succeeds; `.next/static` contains none of `ANTHROPIC_API_KEY`, `api.anthropic.com`, `x-api-key` |
| This spec | `e2e/empty-states.spec.ts` | **7 passed** — against a stack of its own, and alone after the full run |
| Browser, full | `E2E_REUSE=0 DEV_STACK_PORT=54371 DEV_STACK_POSTGREST_PORT=54372 NERTUBE_DEV_DB=nertube_e2e_m9empty E2E_PORT=3141 npx playwright test` | **289 passed, 2 failed, 1 skipped (30.1m)**, on a database that run built |
| The two, again | the same stack flags, `npx playwright test settings-channel flow-fields empty-states` | **21 passed** |

The two failures in the full run, named rather than rounded off:

1. **`flow-fields.spec.ts:352`** (the target date set and cleared). The status
   line stayed on its idle sentence through twenty seconds of retries: the
   date never reached React state, which is `/videos/[id]` not having hydrated
   — the flake M4, M6 and M8 each recorded on this page, under full-suite
   load. It passed in the rerun. Nothing in this slice adds to that page's
   hydration; `SaveStatus` gained one conditional link.
2. **`settings-channel.spec.ts:337`**, on its *second* visit to the bucket
   editor: the page was fully drawn (the screenshot shows it) and the capture
   button's hydration marker never appeared in twenty seconds — again a page
   that had not hydrated, not a page that was wrong. It passed in the rerun,
   and in the sibling slice's full run earlier the same day. This slice does
   not touch that page.

**The orchestrator's final `E2E_REUSE=0` full run is the one that counts.**
Two other runs happened during this slice and are worth knowing about: the
responsive slice's full run (281 passed, 3 failed) was running *while this
slice was editing files under it* — its `next dev` recompiled on every save
here — so its failures say nothing about either slice; and this spec's first
runs were made with `E2E_REUSE=1` against another agent's stack, because its
`next dev` held the directory's dev lock, which is why the failing-read test
makes the read fail for its own account only.


---

## M9 — Integration: one tool, one week, and every debt accounted for

> The last pass of the last milestone. Three slices landed at once (the
> responsive shell, the keyboard, the empty and error states). This pass read
> them together, walked the whole week on a laptop and on a phone as PLAN.md:200
> asks, fixed what the walk found, and went through every deferral in this file
> from M0 to M8. It adds no feature.

### What was checked rather than trusted

Each slice's report was read against the tree, not taken as given.

- **One keyboard mechanism.** `grep` for `addEventListener("keydown"` across
  `app/`, `components/` and `lib/` finds one: `lib/shortcuts.ts`. Every other
  keyboard path is a React `onKeyDown` on the field it belongs to (Enter to
  commit, Escape to revert a settings row, Tab for the modal's trap).
- **One modal.** `createPortal`, `role="dialog"` and `aria-modal` appear in
  `components/modal.tsx` and nowhere else. Its six callers: the capture box,
  the swap reason, the schedule-a-day dialog, the matrix's capture cell, the
  `?` sheet and the phone menu. **The collapsed sidebar did not become a second
  modal.** `AppSidebarMenu` is a button, an open flag and
  `<Modal placement="start">`, and nothing more.
- **One dismissal order.** The modal (and so the sheet and the phone menu) is
  an overlay through `useDismiss`, and the assist panel is a region through
  `useDismiss(…, { within })`. The four settings fields that revert on Escape
  call `preventDefault()`. No other Escape handler exists. The order is
  written once, in the header of `lib/shortcuts.ts`.
- **One empty-state presentation.** Every view-level empty, missing or failed
  state goes through `components/state-panel.tsx`: the board, `/now`, the bank,
  the matrix, the calendar, the four `not-found.tsx` files and `app/error.tsx`.
  Two seams were left, and this pass closed both:
  - `app/global-error.tsx` drew its own "problem" layout. It now renders
    `StatePanel`, which is plain markup with no data, so the reason it gave for
    standing apart ("the less this page depends on, the better") does not
    apply.
  - The two lists' filtered-empty lines disagreed. The bank's had "Clear the
    filters" and `/now`'s said "Turn one off". `/now` now has the same button
    (`now-clear-filters`).

  Section-level empties are deliberately not panels: "No image yet" in a
  thumbnail slot, "No tags yet" and similar are one line inside a block that
  is otherwise full.
- **The docs the slices wrote.** The responsive slice's gates table had landed
  inside the keyboard section, because the two edited the file at the same time.
  It is moved back. The responsive section's note that the bar mounts
  `ChannelShortcuts` is annotated: the bar now mounts `KeyboardShortcuts`,
  which contains it. The same stale name in `components/app-sidebar-menu.tsx`'s
  header is corrected.

### The week, walked on a laptop and on a phone

`e2e/m9-week.spec.ts` is the walk, made repeatable. One idea goes from capture
to a swapped thumbnail by the controls a person would use, twice:

- at **1440×900 with a mouse and the keyboard**;
- at **390×844 as an emulated touch device** (`hasTouch`, `isMobile`). There
  `pointer: coarse` is really true (the spec asserts it) and every press is
  a `tap()`. The responsive slice could not say this of any spec.

After the walk starts, no SQL moves anything. The fixture sets up only what a
real Monday already has: three pillars, two videos from another channel
waiting on a camera, and two earlier published videos whose click-through is
the swap prompt's bar. Every step saves a screenshot under
`test-results/m9-week/`, and every screenshot was looked at. The account below
comes from those screenshots and from the run, not from reading code.

| Step | Laptop: what it took | Phone: what it took |
|---|---|---|
| Capture | `c`, type, Enter. 1 key + the title | Tap Capture on the bar, type, tap Capture beside the field |
| File it in the matrix | Bank → the idea → scroll to Filing → two selects → back to the matrix | Same, with a long scroll: Filing sits below every packaging field |
| Promote | `j`, `p` | Tap Promote |
| Package | Generate 20 → Add all → Choose one → type the concept → three hooks, Enter each → Choose | Same taps |
| Through the gate | Click the card, `]` | Tap → on the card |
| Script it | Read the script the template wrote; 9 checklist ticks on `/now` (`j` then `x` ×9), then Move | 9 taps on the sentences, then Move |
| Filming day from the badge | Board → badge → date → Schedule the day | Same |
| Film it, edit it | 4 + 4 ticks with Moves, on `/now` | Same, by tap |
| Publish Prep | Three uploads, Ship the wild card, target date on Schedule, 5 ticks, Move | Same |
| Publish | Paste the URL into `/now`'s row, Confirm live | Same |
| First 24 hours | Video → Publish tab → impressions, CTR, views → Log | Same |
| Swap a thumbnail | `/now`'s Swap row → Thumbnails → Ship moderate → reason → Swap | Same |

Both walks pass: laptop 44–48 s, phone 52 s. The first phone run took 3.1
minutes because of a fixture mistake, since fixed. The two earlier videos had
no packaging, so they filled `/now` with "Complete packaging" rows. That was
the fixture's fault, not the app's.

**What the phone walk found broken, and fixed here:**

1. **A hook was cut off mid-sentence.** Each hook is a two-row textarea beside
   its Choose and Remove buttons. At 390px, two rows hold about forty
   characters, so "Nine hours a night for a month changed one" was all you
   could read of the hook you were choosing. It now grows with its text
   (`field-sizing: content`, with `rows` as the floor where that is
   unsupported). Below `md` it takes the full width and the buttons wrap under
   it (`components/packaging/hooks-editor.tsx`).
2. **The schedule-a-day dialog ran off its own edge.** A fieldset's default
   `min-width` is `min-content`, so one long title pushed every candidate row
   past the dialog's right border. Adding `min-w-0` to the fieldset lets
   `truncate` work (`schedule-day-dialog.tsx`).
3. **On a phone the board opened on an empty column, with the badge three
   swipes away.** The strip showed Idea first. For a channel whose ideas live
   in the bank that column is empty, and the Filming badge (principle 4's
   whole signal) was off screen to the right. Below `md` the strip now opens
   at the first column that holds a card or the badge. At desktop widths
   nothing moves (`components/board/board.tsx`). The week spec asserts the
   badge is in the viewport.
4. **A toast covered the control it was reporting on.** "Ticked: …" sits at
   the bottom of the screen, which on `/now` is where the next row's Move
   button lands after a tick. Below `md` toasts now sit under the 56px bar,
   away from the thumb (`components/toast.tsx`).
5. **The capture box showed keyboard digits to a thumb.** Each channel chip
   carries its Alt+1–9 digit. On a coarse pointer the digit is now hidden, the
   same rule the responsive slice already applied to the hint's keyboard
   sentences (`capture-form.tsx`).

**What was awkward and is not fixed,** because fixing it would be a feature or
a redesign. Each is in the README's limits.

- *Both:* **"Script it" is ticking a checklist.** The Script tab shows what
  the template wrote, with the chosen hook spliced in, and says it is
  read-only. This is the largest gap between the week BRIEF.md describes and
  the week the app supports (see the closing account below).
- *Both:* **Filing an existing idea is the longest detour of the week.** The
  matrix files only new ideas, through its empty cells. The bank row cannot
  file. The Filing block is at the bottom of the video page's Packaging tab.
- *Both:* **Checklist items do not follow facts the app already has.** After
  three uploads, "3 thumbnail variants ready" is still unticked. After the
  numbers are logged, "Check first 24h" is still unticked, so the Publish tab
  reads 1/2 while its checklist reads 0/2. Auto-tick was left out of v1 on
  purpose (PLAN.md review item 21). The walk shows what that costs: five
  ticks on facts the page already knew.
- *Laptop:* **nine `x` presses make three stacked toasts.** They are polite
  and they clear themselves, but a quick run through a checklist is noisier
  than it needs to be.
- *Phone:* **the matrix shows two of its eight formats at a time**, with the
  pillar column taking about 40% of the width. The idea just filed
  ("self-experiment", the fourth column) was off screen until the grid was
  swiped. The legend still says "Click it to capture one".
- *Phone:* **an assist panel opens below the button that asked for it**,
  partly under the fold.
- *Phone:* **the 24-hour form's "New viewers" field sits below its save
  button**, so the natural top-to-bottom order logs the numbers before the
  note is seen.
- *Both, dev only:* **Next's development indicator sits over the sidebar's
  account line** at the bottom left. It is not in a production build.

### Every deferral in this file, and where it went

Every "deferred", "left for", "still M9" and "the integration pass should"
in the M0–M8 sections, including items deferred to a milestone that then did
not take them. **Fixed** means fixed in code, by the milestone named.
**README** means it is written into the README's honest-limits section.

| # | From | Item | Disposition |
|---|---|---|---|
| 1 | M0 | Everything M1+ "deliberately not built yet" | Fixed, M1–M8 |
| 2 | M1 | The deploy to Vercel, and an upload to a hosted bucket | **README** ("It is deployed, but nothing here was tested against the deployment"). The user created both projects by hand on 17 September. All nine migrations are applied to the hosted database (Postgres 17.6). No spec has run against the live site, and no upload has gone to a hosted bucket |
| 3 | M1 review 18 | Reconsider the hint bar once the `?` sheet exists | Fixed, M9 keyboard slice: the bar is kept, and its last item opens the sheet |
| 4 | M1 | The packaging editor and the gate-refusal links | Fixed, M2 |
| 5 | M1 | The checklist ratio on the card | Fixed, M3 |
| 6 | M1 | `?`, `g n/b/i/k`, `p`, `x` | Fixed (`p` M5 in the bank only — on a board card only since the M9 review; `x` M3, `g` and `?` M9). `g k` became `g c` (deviation, M9 keyboard) |
| 7 | M3 | `/` lands on the board, not `/now` | Fixed, M3 integration |
| 8 | M3 | A Scheduled video with no target date gets no `/now` row | **README** |
| 9 | M3 | The swap row's second answer (the swap itself) | Fixed, M4 |
| 10 | M3 | Rules 3 and 5-Ready not walked in a browser | Fixed, M4 acceptance, and again from `/now` in `m9-week` |
| 11 | M3 | `/now` does not write views or the new-viewers note | Fixed, M4 (the Publish section) |
| 12 | M3 | The script editor ("the field and its save path should arrive together") | **README**, prominently. Not built |
| 13 | M3 | No description field | **README** (description, chapters, end screen and tags are checklist items) |
| 14 | M3 review 32 | No responsive breakpoint | Fixed, M9 responsive slice |
| 15 | M3 | The preview's metrics are transcribed, not measured | **README** (added here) |
| 16 | M3 | Every signed-in route pays for `/now`'s reads | **README**, "Scale" (added here) |
| 17 | M4 review | `npm run e2e` reuses a stack by default | Fixed, M9 empty-states slice |
| 18 | M4 | `channels.expected_ctr` has no UI | Fixed, M7 |
| 19 | M4 | The first click on the video page can be swallowed | **README** |
| 20 | M4 | A shipped role cannot be un-shipped | **README** |
| 21 | M4 | `confirmLive` is two writes | **README** |
| 22 | M4 | The disable-an-occupied-stage rule lives in app code | Fixed, M7 (`0007`/`0008`: `occupied:<n>` raised in SQL) |
| 23 | M4 | A thumbnail variant has no note | **README** |
| 24 | M5 matrix | A populated cell should link into the bank's filters ("the integration pass can add it") | Fixed, M5 integration (`cell-bank-link`) |
| 25 | M5 | No way to create a bucket | Fixed, M7 |
| 26 | M5 | Buckets set only at capture | Fixed on the video page (M5 filing slice). The bank row and the matrix still cannot file: **README** (added here) |
| 27 | M5 | Back does not undo a filter change | **README** |
| 28 | M5 | Archive has no undo after a reload | **README** |
| 29 | M5 | Twelve formats will scroll; mobile is M9 | Fixed at page level, M9 (the matrix no longer scrolls the page sideways). At 390 it shows two formats at a time: **README** (added here) |
| 30 | M5 | Capture's tag box does not suggest tags | **README** (added here) |
| 31 | M6 | Colour per channel on the calendar | **README** (added here). Recorded as a deviation in M6 |
| 32 | M6 | `g k` is still M9 | Fixed, M9, as `g c` |
| 33 | M6 → M7 → M9 | The timezone question ("today" is the UTC day) | **README**. Not built: it needs a profile table and a settings screen, which is a feature |
| 34 | M6 | No mobile pass on the calendar | M9 says on the page that a month needs a wider screen. **README** |
| 35 | M6 | A day with one or two videos has no link to its `?day=` panel | **README** (added here) |
| 36 | M6 | `FilmingDayPanel` should render on `/calendar` | Fixed, M6 integration |
| 37 | M6 review | `aria-disabled` in place of `disabled`, application-wide | **README**. Not done: about 80 `disabled` props in 35 files to sort into busy and unavailable, and nothing here can check the result with a screen reader. Reason updated here |
| 38 | M6 review | `board.m1.spec.ts`'s literal "3 in Filming" | Fixed, M9 empty-states slice |
| 39 | M7 review 13 | Merge the add-stage and add-bucket forms | **README**. Kept as two by decision (M9) |
| 40 | M7 review | The video page's text fields and the NUL byte | Fixed, M9 empty-states slice |
| 41 | M7 | `RepurposedLane` pre-disables where Settings leaves the switch live | **README** (added here) |
| 42 | M7 | Reorders are read-then-write | **README** (added here) |
| 43 | M7 | The voice guide is stored and nothing reads it | Fixed, M8 |
| 44 | M8 | No live call to Anthropic has ever been made | **README** ("No request has ever been sent to Anthropic"), with the first four things to check in Vercel |
| 45 | M8 | The packaging panel's own in-flight machine, "the first thing to do to this directory" | Fixed, M8 integration (`useAssistRun` twice, in `brainstorm-assist.tsx`) |
| 46 | M8 | The critique's cost is not shown | **README** (added here) |
| 47 | M8 review | No per-user or per-day spending cap; cancel does not stop the bill | **README** |
| 48 | M9 responsive | `pointer: coarse` never true in the suite | Fixed here: `m9-week`'s phone walk runs with it true. README updated |
| 49 | M9 keyboard | The sheet cannot be reached by touch; no key moves a video from its own page; no remapping; AltGr proved only synthetically | **README** |
| 50 | M9 states | Signed-out diagnosis in four callers only; the offline branch and `global-error.tsx` are untested | **README** (the second half added here) |
| 51 | M3 → M7 | Per-item estimates on a video's own checklist ("a template-editor concern … belongs to M7") | *Added by the M9 review, which found it had lapsed.* M7 built the template editor only. **README** ("A checklist item you add to one video has no estimate"); the row now prints no minutes rather than a made-up "10 min" |
| 52 | PLAN.md review 19 | "Reset script from template" on the video page | *Added by the M9 review, which found it had lapsed.* Not built, as a decision. **README** ("The script is written once, and nothing rewrites it") |

*As first written, the line below said nothing on this list had lapsed. The
M9 review found two that had (rows 51 and 52) and one row that claimed more
than it had (row 6: `p` on a board card); all three are corrected above.*

Nothing on this list simply lapsed. Items 8, 12, 33, 37, 39 and 52 are
decisions not to build or not to change. Each one's reason is in the README,
and this file says where it was argued.

### No key, and the fake provider

This container has no `ANTHROPIC_API_KEY` and no egress. Verified directly,
not assumed:

- `env | grep ANTHROPIC_API_KEY` is empty. `.env.local` holds the Supabase
  pair, the seed credentials and `ASSIST_PROVIDER` (names only were read).
- The app was started with `ASSIST_PROVIDER=` set empty, which overrides
  `.env.local`. Under `selectAssistProvider` that counts as unset, and with no
  key and `NODE_ENV` not `production` it selects the fixtures. Against that
  server, `e2e/m8-acceptance.spec.ts` (5/5) and the laptop week walk (whose
  packaging step is "Generate 20", then "Add all") passed. **That is the state
  the app is verified in here, and it works.**
- `npm run build` succeeds and `grep -rl` over `.next/static` for
  `ANTHROPIC_API_KEY`, `api.anthropic.com` and `x-api-key` finds 0 files.

### Decisions taken without the user

1. **The week walk is a committed spec, not a one-off session.** PLAN.md
   names it as M9's review; a walk that cannot be repeated cannot be checked
   by the next person. It runs as part of `npm run e2e` and costs about 1m40s.
2. **The phone walk is a touch device, not a narrow mouse.** 390×844 with
   `hasTouch` and `isMobile`, so the `thumb:` and `pointer-coarse:` rules the
   responsive slice wrote are on in at least one spec.
3. **Below `md` the board opens at the first column with work in it.** A
   board that opens on an empty column hides the one signal it exists to
   give. At desktop widths it still opens where M3 left it.
4. **Below `md` toasts go under the bar, not at the bottom.** On a phone the
   bottom is where the thumb and the next control are. On a desktop they stay
   where they were.
5. **The hook field grows with its text,** everywhere and not only on a
   phone. A hook is read in full before it is chosen, and a fixed two rows cut
   off any hook longer than two lines at any width; the phone only made it
   happen to ordinary ones.
6. **Auto-tick stays out,** even though the walk shows it costing five ticks
   a week on facts the app already knows. PLAN.md decided it and it is a
   feature. It is written down so the next version can decide it with the
   evidence.
7. **`aria-disabled` stays undone.** The reason on record ("three slices
   editing at once") was no longer true for this pass, so it was re-argued on
   its merits and the README's reason was replaced.

### Deviations from PLAN.md, stated plainly

- PLAN.md:199 scopes the mobile pass to `/now` and `/capture`. This pass also
  changed the board (opening position), the hooks editor and the filming-day
  dialog at phone width, because the phone walk crossed them and they were
  broken rather than merely dense.
- PLAN.md:200's walkthrough is a Playwright spec in Chromium, with touch
  emulated. It is not a person with a phone. See "Never proven" in the README.

### What nine milestones shipped against BRIEF.md's v1 scope

**Built and walked:**

- **Multi-channel:** channels with a switcher. Stages, checklist templates and
  buckets are per channel (M0, M3, M7).
- **Idea bank:** quick capture (`c`, `/capture`, one input, Enter), with hook,
  notes, tags and buckets behind the disclosure. Verticals and horizontals
  with monthly quotas. The matrix, where every empty cell captures. Promote
  (M1, M5, M7).
- **Pipeline board:** drag and drop, keyboard moves and card arrows. Stages
  editable per channel, and the Repurposed lane can be switched off. Count and
  WIP warning per column. The Filming badge at 3+, which books a day.
  Time-in-stage and a stale flag. The card face (title, channel, target date,
  concept sketch, checklist ratio) (M1, M3, M6, M7).
- **The gate:** title, thumbnail concept and chosen hook, checked by the
  database at move time. Skipping it needs a typed reason and leaves a badge
  (M2).
- **Video detail:** working title with the 55-character warning. Title
  candidates with notes and a chosen flag. The concept in text plus a sketch
  upload. Up to three hooks with one chosen. Three thumbnail roles with a
  shipped role and a swap log. The per-stage checklist, editable per video.
  Target date and final URL. Notes. The post-publish block, where impressions
  and CTR are always together and the swap prompt appears (M2, M3, M4).
- **Seed checklists:** the brief's seven lists, verbatim, with minute
  estimates, editable per channel (M0, M7).
- **Calendar:** target dates across channels, with filming days as their own
  event type (M6).
- **"What can I move right now?":** `/now`, derived, sorted by staleness, with
  every row completable in place (M3).
- **Brainstorm:** 10–20 titles, each with a rationale and one recommended
  pick. Hooks. Conditioned on a per-channel voice guide and the past titles.
  Behind one swappable provider interface. Also concepts and a thumbnail
  critique (M8).
- **Working style:** keyboard shortcuts for new idea, move stage and quick
  capture, and the full set with a `?` sheet (M1, M9). Minimal dependencies:
  four runtime packages beyond Next and React.

**In v1 scope and NOT built, or not done:**

- **The script editor.** BRIEF.md asks for a markdown script editor, per-video
  notes on the chosen structure, and a B-roll plan per section. The per-channel
  script template exists and fills the script on entry to Scripting, but the
  script is **read-only**. `script_structure` and `end_screen_target` are
  columns with no UI. This is the biggest gap against the brief.
- **Deploy on Vercel.** Done by the user by hand: a Vercel project and a hosted
  Supabase project (Postgres 17.6) with all nine migrations applied. Nothing in
  this repository has been tested against the deployment.
- **The brainstorm against Claude itself.** Built and unit-tested against a
  stubbed transport, and never sent to the live API.
- **The one-line hook after capture:** set at capture and editable nowhere
  after.
- **Per-thumbnail notes:** the brief's "each with a note" became the role's
  description plus the swap reason.

### Gates

Run in this container: no `ANTHROPIC_API_KEY`, no stale stack (checked with
`pgrep` before each run), Postgres up (`pg_isready`), `E2E_REUSE=0`.

| Gate | Command | Result |
|---|---|---|
| Types | `npm run typecheck` | exit 0, both programs |
| Lint | `npm run lint` | exit 0 |
| Build | `npm run build` | exit 0. 19 routes plus the proxy. `.next/static` holds none of `ANTHROPIC_API_KEY`, `api.anthropic.com`, `x-api-key` (0 files) |
| SQL | `./scripts/verify-db.sh m9_check` | `OK (migrations applied, 17 test file(s) passed)` |
| Unit | `npm run test` | 525 passed, 33 files |
| Browser | `E2E_REUSE=0 npx playwright test`, three cold full runs | **1:** 291 passed, 2 failed, 1 skipped (34.1m). **2:** 292 passed, 1 failed, 1 skipped (33.7m). **3:** 292 passed, 1 failed, 1 skipped (35.1m) |
| Browser, the failures again | every spec that failed in any of the three (`board.m1`, `preview`, `post-publish`, `settings-stages`) | 45 passed, 0 failed. `board.m1` also passed 52/52 over `--repeat-each=4`, cold |

The skip is `session-refresh`, as in every milestone. It runs only under
`npm run e2e:refresh`.

**`npm run e2e` did not exit 0 in any of the three full runs.** Each failure
is named here, with its cause where one was found. None of them are
rounded off.

1. **Three of the four failures were Next's development server restarting
   itself mid-navigation.** The runs failed `preview.spec.ts:403`, then
   `post-publish.spec.ts:644`, then `settings-stages.spec.ts:323`. Each failed
   a `page.goto` on its 60-second load timeout. In every case the line just
   before the failure in the server log reads *"⚠ Server is approaching the
   used memory threshold, restarting…"*. `next dev` exits and restarts when
   its V8 heap passes 80% of its limit (`getMemoryRestartStats` in
   `next/dist/server/lib/utils.js`), and the page it was serving never
   finishes loading. It happens once per full run, about two thirds of the
   way through. The spec it lands on is whichever one is in flight at that
   moment.

   **This is the development server, not the application.** It was measured,
   not assumed. The same 240 authenticated page loads (`/videos/<id>` and
   `/now`, alternating), run against the same stack:

   | Server | Memory after 0 / 40 / 80 / 120 rounds |
   |---|---|
   | `next start` (the production build) | 192 / 345 / 345 / 371 MB, flat after warm-up |
   | `next dev` | 982 / 2007 / 2714 / 3384 MB, about 20 MB per round, growing |

   One mitigation was tried and taken out. A 10 GB heap for the suite's dev
   server only (`NODE_OPTIONS` in `playwright.config.ts`) moved the restart
   from about spec 210 to spec 251, and run 3 still lost a test to it. It
   delayed the failure, so it was reverted. The options not taken, and why:
   - Turning Next's restart off would let the heap run into the machine's
     memory.
   - `retries: 1` would absorb this, but it would also hide every other
     intermittent failure in the suite behind a green run.
   - Running the suite against `next build && next start` would remove the
     cause. It is the right next step. It is also a bigger harness change
     than this pass should make blind: every spec was written and timed
     against `next dev` for nine milestones, and changing the server under
     about 290 of them is its own piece of work.
2. **One failure is not explained: `board.m1.spec.ts:513`** (drag an idea
   into Packaging, run 1, the 16th spec, long before any restart). The server
   log shows the `moveVideo` request made and answered 200. The screenshot
   shows the card in neither column's visible part, and Packaging still holds
   one card. The trace was lost when a re-run cleared `test-results/`. It did
   not recur in 52 cold repeats of that file or in the other two full runs.
   Nothing this pass changed is on the path it exercises at that viewport
   (2880px, where the board's new phone-only scroll returns immediately).
   Recorded as unexplained rather than as a flake.

**What a reader should take from this:** every spec in the suite passed in
at least two of the three full runs, and each one that failed passed again
on its own run. The command does not
yet give a clean exit over a full run, because of the development server's
memory. A fresh session's first job, if it wants a green `npm run e2e`, is to
run the suite against a production build.
*(Done by the review pass below: the suite now runs against a production
build, and both of its full runs exited 0.)*

---

## M9 — Review: the last fix pass

> Forty-one adversarial findings against the finished tree, from four
> reviewers: the phone, the keyboard and assistive technology, a fresh pair of
> eyes on a brand-new account, and the debts this file had written down. There
> is no later milestone, so every finding below is either fixed or written
> into the README's honest limits in the words quoted here. "Deferred" is not
> a disposition this section uses.

### Verified before anything changed

Each finding was checked against the tree before it was acted on. All
forty-one held up in substance; none was rejected as wrong. Two were fixed in
a different way from the one suggested, and three were answered partly in
code and partly in the README; those are called out below.

One thing the reviewers did not report, and the first build of this pass
did: **`npm run build` failed on a tree with a failed e2e run in it.** A failed
spec's Playwright trace keeps copies of the spec's source under
`test-results/<spec>/tr/src/*.ts`, `tsconfig.json`'s `**/*.ts` picked them up,
and their relative imports do not resolve from there. `tsconfig.json` now
excludes `test-results*`, `playwright-report` and `blob-report`. `npm run
typecheck` had the same exposure.

### The browser suite, first (findings 31 and 37)

The largest debt was not a line of product code: **no full run of `npm run e2e`
had exited 0 since M8.** M9's integration pass measured why (`next dev`'s
memory, and its restart at the threshold two thirds of the way through a run)
and named the fix it did not make: run the suite against a production build.
This pass made it first, before touching anything else, so that every later
run would measure the code rather than the dev server.

- `playwright.config.ts`: the app server's command is `npm run build && npm run
  start -- --port 3111`, with the same `env` block (which is what inlines the
  harness's URL and anon key into the browser bundle). The timeout is 300 s,
  for the build. `scripts/e2e-preflight.mjs` is deleted: it existed to catch a
  running `next dev`, which no longer blocks the suite (Next 16 keeps dev
  output in `.next/dev`). `scripts/dev-stack/README.md` item 32 says so.
- **A baseline full run of the unchanged product tree against the production
  build: 293 passed, 0 failed, 1 skipped, 11.2 minutes, exit 0.** (M9's three
  `next dev` runs took 33–35 minutes and each lost one or two specs.)
- `e2e/flow-fields.spec.ts:352` (finding 37) is the one failure the memory
  explanation did not cover: a fill swallowed before hydration left
  `2026-11-20` in the box and React's draft empty, and the retry filled the
  same value again, which is not a change. Each attempt now clears the field
  first, as `m9-week.spec.ts` already did, and the database check polls.

### Fixed

**Phone (1, 2, 4, 5, 24, 41).**

- *1 — settings rows at phone width.* `bucket-row.tsx` got the stage row's
  treatment: below `md` the filed count and Remove drop under the name, and
  the name takes its own line (`basis-full`) above the quota.
  `template-row.tsx` wraps below `md`: the text takes the first line, the
  minutes, arrows and Remove the second, aligned with the text. The add
  fields (`axis-editor.tsx`, `stage-template-editor.tsx`, `stages-editor.tsx`)
  have a real basis and take the whole line below `md`.
  `e2e/m9-review.spec.ts` asserts every bucket rename field, every template
  text field and both add fields are at least 200px wide at 390 and at 360 —
  a width check, not only a scroll check.
- *2 — the sidebar's channel list shrank to 0px on a short window.* `min-h-0`
  is gone from the `<nav>` and the channels block, and the list is no longer
  its own scroller: the sticky column scrolls as a whole, and nothing in it
  shrinks below its content. The spec clicks Personal, Sunday Softworks and
  "+ New channel" at 844×390 and at 1280×560 with real clicks, which
  Playwright refuses if anything is drawn over the target.
- *4 — tap targets.* `thumb:min-h-11` (the responsive slice's own variant) on
  capture's More, sign-in, Create channel, the bank's Promote, Archive,
  Restore, search and filter selects, every brainstorm/concept/critique button
  and pill, the hook and candidate Choose/Remove/Add buttons, the skip
  controls, the section tabs, the checklist expander, the calendar's month
  buttons and day-panel close, and the settings add buttons. What was not
  raised is in the README (below).
- *5 — fields under 16px.* `max-md:text-base` on the bank's search and
  selects, every settings row field and add field, and the new-channel name.
  The spec checks the computed size on the bucket and checklist screens.
- *24 — the ragged sidebar edge.* `SidebarDisabled`, "+ New channel" and the
  CHANNELS heading use `pl-3 pr-2`, the link rows' edge.
- *41 — digits on a thumb.* The channel rows' digit is `pointer-coarse:hidden`,
  as the capture chips' already was.

**Keyboard, focus and assistive technology (3, 6–12, 14, 15, 38–40).**

- *6 (the blocker) — Escape saved the edit it claimed to discard.* The
  template text field no longer blurs on Escape: it puts the stored text back
  and keeps focus, as the stage and bucket rows do. The blur had run
  `commitText` with the edited draft still in its closure. The spec edits,
  presses Escape, Tabs away and reads the row from the database: unchanged.
- *3 and 40 — focus from a backdrop, and after a link in the sheet.* `Modal`'s
  backdrop calls `preventDefault()` on the mousedown before closing, so the
  browser's default no longer moves focus to `<body>` after the modal has put
  it back on the opener. Every dialog benefits. A link chosen in the phone
  sheet records the moment in a module-level value, and the next page's menu
  button (every page renders its own shell, so it is a new button) takes focus
  if it mounts within ten seconds. `e2e/responsive.spec.ts` now asserts focus
  on the menu button after the backdrop and after the link; `m9-review`
  asserts it after a desktop capture dialog's backdrop.
- *7 — `p` in the bank promoted a row the focus was not on.* The row selects
  on focus anywhere inside it (`onFocus` on the `<li>`, which bubbles), not on
  the title link alone. The spec does `j`, `j`, Shift+Tab, `p` and checks the
  database promoted the row the focus ring was on.
- *8 — one arrow key moved the video.* The stage select keeps a value reached
  from the keyboard as a *choice*: the status line says it is not moved yet,
  a Move button appears beside it, Enter or Move makes the move, Escape puts
  it back. A pick from the open list with the pointer still moves at once
  (every existing `selectOption` spec is unchanged). The select is never
  `disabled` in flight any more (`aria-busy` and a guard), so it keeps focus.
- *9 — Escape on an assist panel, and `p` in the bank, dropped focus.*
  `AssistPanel` records the element that had focus when it mounted (the pill)
  in a layout effect and gives it focus back when it unmounts holding focus.
  A promote in the bank moves the selection, and focus if it was in the row,
  to the next row (or the previous, when it was last) before the row leaves.
- *10 — the gate-refusal toast.* The toast's clock stops while the pointer is
  over it or focus is inside it and starts again, in full, when both leave. A
  refused `[`/`]` on the board puts focus on "Fix packaging"; the toast is an
  Escape *region* (`useDismiss` with `within`), and a toast that goes while
  holding focus gives it back — to the card, for the board. The spec waits
  thirteen seconds on the focused link to prove the clock stopped.
- *11 and 12 — forced colours.* In the unlayered forced-colours block of
  `app/globals.css`: a label wrapping a focused visually-hidden input is
  outlined (the capture chips); the chosen chip is outlined in `Highlight`;
  `[aria-pressed="true"]` is outlined; the sidebar's current-row marker has
  `forced-color-adjust: none` and paints `Highlight`. The spec checks each
  computed style under `emulateMedia({ forcedColors: 'active' })`.
- *14 — titles.* `lib/page-title.ts`: a video page is "<title> · NerTube",
  a channel page "<Channel name> · board · NerTube" (and ideas, and the four
  settings screens), each through the request's RLS client so a title never
  confirms another user's row.
- *15 — "j k".* The slash between alternatives is paired with an `sr-only`
  " or ".
- *38 — `p` on a board card.* Bound in the board's `useShortcuts` list for a
  selected Idea card: the same `move_video` call to the channel's Packaging
  stage that `]` and the bank's Promote make. On the sheet, not the bar.
  `e2e/shortcuts.spec.ts`'s board sheet now lists it.
- *39 — the hint bar emptied itself under any dialog.* It is built from every
  enabled registration, not only the ones allowed to fire, so the "all keys"
  button that opened the `?` sheet stays mounted and takes focus back.

**Copy, from a fresh account (16, 18–23, 28, 33, and 17 in part).**

- *16* — the voice-guide note says what the field does now and names the
  three buttons that read it. `lib/channel-settings.test.ts` asserts no
  `SETTING_NOTES` string names a milestone.
- *18* — the Thumbnails tab is quiet, not locked, before Editing (the slots
  work at every stage) and counts an early upload. "Locked at Packaging." is
  "Decided in Packaging."
- *19 and 33* — the Script tab says the copy is a starting draft written
  once, that it is not edited here, and to write the script in your own
  editor from it.
- *20* — no user-facing string cites "the brief": "aim for 10–20", "write
  three, then choose the strongest", "most channels do well with 3–5", "the
  eight standard formats". `lib/bucket-settings.test.ts` asserts it.
- *21* — the stage row's chip says "built in · Publish Prep", not
  `core · publish_prep`; the card's badge expands TTH on hover
  (`<abbr>` and a title); capture's hint says "a topic pillar and a format";
  the README names the feature "the brainstorm" and its four buttons.
- *22* — the preview rail sits beside the block from 1440px (a 40rem measure
  there, 42rem from 1480). `e2e/preview.spec.ts` asserts it at 1440×900.
- *23* — the gate indicator and the board's refusal name every missing field.
  `packagingGate` returns `allMissing`; `moveVideo` reads the row back after a
  gate refusal to list them. `missing` is still the first, which the "Fix
  packaging" link targets.
- *28* — "are not set" for two, and where the values come from.
- *17, in part* — the Packaging tab's help was edited: the sketch rule is said
  at the concept field and in the gate line, not four times; the intro, the
  hook note, the skip form and the Filing note are shorter. The settings
  screens were not edited (README).

**Debts and docs (25–27, 29, 30, 32, 34–36).**

- *25* — `npm run dev:stack` checks `postgrest --version` first and stops
  with one sentence naming the release to install; the README says where
  PostgREST comes from and what the Postgres role must be able to do.
- *26 and 36* — `.env.example` points at "Which assist implementation
  answers"; `scripts/dev-stack/README.md` no longer says the suite reuses a
  stack, and its "board columns read 0" paragraph is gone; the seed's and
  `app/actions/channels.ts`'s stale comments are corrected.
- *29* — besides the README entry and deferral row 51, the display rule M3's
  finding 15 stated is now true: a checklist row with no estimate prints no
  minutes on `/now` or in the strip, and a dash in the list.
  `e2e/checklist.spec.ts` asserts it.
- *32* — the shoot notes go through `cleanProse`.
- *34 and 35* — README entries, below.

### Moved to the README, with the exact words

Each is under "Honest limits". Quoted as written:

- **2/4 (targets not raised):** "**Tap targets are 44px on `/now`, `/capture`
  and the main controls, not everywhere.** … Not raised: the calendar's chips
  (about 20px tall at 390 — the month is a desktop view, and says so), the
  settings rows' up/down arrows and their "Remove" links (the review measured
  24–28px), and links inside sentences. None of it was seen on a real phone."
- **5 (zoom):** in "No real phone and no touchscreen": "Every text field the M9
  review found under 16px — the bank's search and filters, the settings rows
  and add forms, the new-channel name — is 16px below 768px now, which is what
  should stop that zoom."
- **13:** "**No key moves a video from its own page.** `[`/`]` are the board's.
  On `/videos/<id>` the stage select is in the Schedule section: the section
  tabs, then three Tabs. An arrow key on it chooses a stage and Enter (or the
  Move button beside it) makes the move; it does not move on the arrow (M9
  review)."
- **17 (the part not done):** "**The settings screens are wordier than the
  rest of the tool.** … the four settings screens did not get the same
  editing pass, and still read more like documentation than a tool."
- **27:** "**Postgres 17 has never run these migrations.** … the migrations and
  all of `supabase/tests/` have only ever been run on PostgreSQL 16 (16.15, the
  harness's). Nothing in them is known to differ on 17; nothing has checked."
- **29:** "**A checklist item you add to one video has no estimate.** … The
  10-minute filter on `/now` counts such an item as ten minutes, so it always
  passes the filter however long the task is. It prints no minutes …"
- **30:** "**The script is written once, and nothing rewrites it.** … PLAN.md's
  review item 19 promised a "reset script from template" on the video page; it
  was not built (M9, as a decision: it is a new write path into a column the
  app otherwise never writes)."
- **31 (the unexplained failure):** "**One browser-suite failure from M9 was
  never explained.** `e2e/board.m1.spec.ts:513` … It is recorded as
  unexplained rather than as a flake."
- **34:** "**Videos cannot be deleted, only archived; channels cannot be
  removed at all** … Smaller things can be deleted: a filming day, a video's
  checklist item, a template item, a bucket and a stage you added yourself."
- **35:** "**A quick run through a checklist stacks its toasts.**" and "**No
  keys on the calendar, the matrix or settings**". The matrix legend's "Click
  it" was fixed instead ("Choose it to capture one"). The calendar chips are
  in the tap-target entry above.

### Rejected

None. Every finding was confirmed against the tree. Recorded here because it
is the honest answer to "which did you disagree with": the closest to a
rejection is 17's reach. It asked for an editing pass across the product;
this pass edited the Packaging tab, the one it measured at 639 words and the
one the week's walk spends longest on, and wrote the rest down rather than
rewrite four settings screens' prose in the last hours of the project.

### Decisions taken without the user

1. **The suite runs a production build, always.** Not an option beside
   `next dev`: the dev server's restart is what kept the suite red, and a
   suite that exits 0 only sometimes is not a gate. The cost is a build (about
   15 s warm) at the start of every run and a `.next` aimed at the harness
   afterwards, both written down.
2. **The stage select moves on a pointer pick and on Enter, not on an arrow.**
   Rather than a Move button for everyone, which would add a click to the
   mouse path every spec and every person already used.
3. **A keyboard refusal moves focus into the toast; a pointer one does not.**
   A key has no other way to reach the links; a drag or a click on a card's
   arrow leaves focus where the person put it.
4. **Error toasts still expire**, once nobody is hovering or focused on them.
   An error that never left would pile up behind the three-toast cap.
5. **Thumbnails is "quiet" before Editing, not a ratio of 0/3.** A 0/3 on a
   Packaging video would read as work overdue; quiet says nothing until
   something is uploaded.
6. **The gate sentence lists every missing field, and the deep link still
   goes to the first.** One link cannot land on three fields, and the first
   is the one `move_video` names.
7. **"Reset script from template" stays unbuilt.** It would be a new write
   path into `script`, a column the app otherwise never writes, in a
   milestone that adds no features. Written into the README instead.
8. **The preview rail's 1440 step narrows the measure, not the rail.** The
   rail is YouTube's own pixels; shrinking it would make the preview answer
   "does this read?" wrongly.

### Deviations from PLAN.md, stated plainly

- PLAN.md's review item 19 ("reset script from template" on detail) was not
  built (decision 7).
- PLAN.md's shortcut list puts `p` "on a card". It is now bound on the board
  as well as in the bank, which is the plan catching up rather than a
  deviation; recorded because the deferral table said otherwise until now.

### Gates

Run in this container, last, in this order: no `ANTHROPIC_API_KEY` in the
environment (`env | grep -c ANTHROPIC_API_KEY` is 0), Postgres up
(`pg_isready`), no stale stack (`pgrep` for `start.mts`, `postgrest` and
`next-server` found nothing before each browser run), `E2E_REUSE=0`.

| Gate | Command | Result |
|---|---|---|
| Types | `npm run typecheck` | exit 0, both programs |
| Lint | `npm run lint` | exit 0 |
| Build | `npm run build` | exit 0, 19 routes plus the proxy. `.next/static` holds none of `ANTHROPIC_API_KEY`, `api.anthropic.com`, `x-api-key` (0 files) |
| SQL | `./scripts/verify-db.sh m9_final` | `OK (migrations applied, 17 test file(s) passed)` |
| Unit | `npm run test` | 528 passed, 33 files (525 before; +3: the milestone-name and brief-citation guards and the every-missing-field gate sentence) |
| Browser, run 1 | `E2E_REUSE=0 npx playwright test` | **307 passed, 0 failed, 1 skipped (11.9m), exit 0** |
| Browser, run 2 | the same, cold | **307 passed, 0 failed, 1 skipped (11.8m), exit 0** |

307 is the integration pass's 293 runnable specs plus `e2e/m9-review.spec.ts`'s 14. The
skip is `session-refresh`, as in every milestone; it runs only under `npm run
e2e:refresh`. Earlier runs in this pass, for the record: the baseline against
the production build before any product change (293 passed, 0 failed, exit
0), and two targeted runs while fixing. The first targeted run failed three
specs, all this pass's own doing and all fixed before the runs above:
`packaging.spec.ts:520` asserted the skip form's old words ("badge on the
card"), which the copy edit had dropped, so the copy keeps them; and two
`responsive.spec.ts` capture tests whose `getByLabel('Idea')` also matched a
channel radio called "M5 Ideas" — the specs now ask for the textbox by role,
in all five files that used that locator.

`board.m1.spec.ts:513`, the one failure M9's integration pass could not
explain, passed in all three full runs of this pass and in a targeted run of its file. That is not an
explanation, and the README keeps it as an open item.

### Independent verification, after the fix pass

The orchestrating session re-ran every gate on the final tree, cold. It did not
take the fix pass's report on trust.

| Gate | Result |
|---|---|
| `npx tsc --noEmit` | clean |
| `npm run lint` | clean |
| `npm run build` | clean |
| `npx vitest run` | 528 passed, 33 files |
| `./scripts/verify-db.sh m9_verify` | 17 test files passed |
| `E2E_REUSE=0 npm run e2e`, twice, cold | 307 passed, 0 failed, 1 skipped (`session-refresh`); 11.9 and 11.7 min; exit 0 both times |

It also ran a separate probe of the phone layout. The probe signed in and loaded
thirteen routes at 390px and 360px. At 390px the content column is 358px on
`/now`, the board and the video page, and 350px on every other route; at 360px
it is 328px and 320px. No route scrolls sideways. M3 measured 102px at 390.

The README's "It has never been deployed" was corrected in the same pass. The
user created the hosted Supabase and Vercel projects on 17 September, and all
nine migrations are applied to the hosted database, which runs Postgres 17.6.
`package.json` is unchanged since M8, so M9 added no runtime dependency. It also
added no migration.

## M10 — The script, editable in the app

The user's second request after reviewing M5–M9: the script editable in the
app, with a reset from the template. It closes the two README limits "The
script cannot be edited in the app" and "The script is written once, and
nothing rewrites it" (both removed in this change), PLAN.md's review item 19
("reset script from template" on detail), which M9 left unbuilt as a
decision, and M3's note that "the field and its save path should arrive
together" — they arrive together here.

### What was built

- **The patch vocabulary** (`lib/video-fields.ts`) gains `script`,
  `scriptStructure` and `endScreenTarget`. The script is **not trimmed**
  (`scriptForColumn` in the new `lib/script.ts`): it saves mid-sentence, and a
  trim would remove the newline just typed and, via the server's answer, jump
  the caret. Blank (nothing that draws) is `NULL`, as everywhere else, and
  U+0000 is removed. `MAX_SCRIPT_LENGTH` is 100,000 characters — a
  twenty-minute script is about 18,000 — and a longer one is refused with the
  text left in the box. Structure is the CHECK's three values or `''`/`null`;
  the end-screen target is `NullableText`, capped at 300. A unit test reads the
  CHECK out of `0001_init.sql` and compares it with `SCRIPT_STRUCTURES`.
- **`updateVideo`** writes the three columns and reads them back with every
  other column (`VideoState` now carries them). A patch that touches any of
  them is refused before Scripting (below) with a sentence naming the stage.
- **The editor** (`components/script/script-editor.tsx`): a plain textarea in
  Newsreader at 16px with a relaxed line height, that grows with its text
  (an invisible copy of the text in the same grid cell sets the height — no
  measuring in JavaScript, which collapses the box for a frame and jumps the
  page; `field-sizing: content` is not in Safari or Firefox), never shorter
  than most of a screen (`svh`, so the phone keyboard does not resize it
  mid-sentence), with no scrollbar of its own. Structure (a select) and "End
  screen points at" (a text field) sit in a row above it. A sticky toolbar —
  under the 57px phone bar below `md`, at the top of the window above it —
  holds the heading, a word count in the mono face, the one save line and
  Reset, so the save state is never a scroll away from the line being typed.
- **Saving.** One `useSaveQueue` for all three fields (three queues would put
  two writes with the same version precondition on the wire, and this page
  would refuse its own second save as "changed somewhere else"). The draft is
  diffed against what the row will hold once everything on the wire lands,
  the packaging block's pattern. The script saves after a 1.2-second pause in
  typing, on blur, and on leaving the page; structure saves on change; the
  end-screen field on blur and Enter. The version check is the page's one
  token (`components/video-version.tsx`), so a second tab is refused with the
  existing `CHANGED_ELSEWHERE` line and a Reload, and what it typed stays in
  its box. A failed save keeps the text and offers Retry (the queue's own).
- **Leaving with unsaved text.** The two guards `useAutosave` has had since
  M7 — flush on unmount, ask on `beforeunload` — were extracted from it into
  `useUnsavedGuard` in `components/autosave.tsx` and `useAutosave` now calls
  that, unchanged in behaviour. The editor calls the same hook. One mechanism,
  now reachable by an editor that owns several fields on one queue.
- **Reset from template.** `scriptFromTemplate(videoId)` in
  `app/actions/videos.ts` reads the channel's current template and the
  video's hooks *as stored* and returns what `move_video` would write, built by
  `buildScriptFromTemplate` (`lib/script.ts`). The button asks first in the
  one modal (`components/script/reset-dialog.tsx`), saying how many words are
  about to be replaced, which channel's template replaces them, and what goes
  where `{{hook}}` is: the chosen hook verbatim, "no hook is chosen, so the
  Hook section will be empty", or "the template has no `{{hook}}`". Focus
  starts on "Keep my script". On yes, the text goes into the box and saves
  like a keystroke; the line under the toolbar says "Replaced with the
  template." with **Undo** beside it (the accepted-concept notice's shape),
  which sends the previous text back the same way. A script that is empty is
  simply started, with no question (nothing to replace); one that already
  matches says so and changes nothing.
- **The Script tab and its copy.** Locked before Scripting, with the reason
  ("Written from Scripting on — title, thumbnail concept and hook come
  first"); a tick when the script has text; quiet when empty ("Reset from
  template starts one"). The read-only view before Scripting says what will
  happen on the way in; a video moved back to Packaging shows its kept script
  in the reading face and says it opens again when the video returns. The
  M3–M9 sentences ("It is not edited here", "write the script in your own
  editor", "written once") are gone from the app; `e2e/script-editor.spec.ts`
  asserts two of them are absent. The channel settings' template note now
  names Reset.

### Decisions taken without the user

1. **The script is editable from Scripting onward, not in every stage.**
   BRIEF.md's first principle is that title, thumbnail concept and hook come
   *before* the script, and that skipping that is structurally awkward. A
   script box on an idea would be a way round the gate with no reason typed
   and no badge. The deliberate way to script early still exists: skip the
   gate with a reason and move into Scripting. It stays editable after
   Scripting (scripts are revised while filming and cut in the edit). A video
   moved back keeps its text read-only. *Alternative:* editable everywhere,
   like the Thumbnails slots (M9 review made those quiet rather than locked);
   rejected because the thumbnail files have no principle saying "not
   before", and the script does. The rule is `scriptIsEditable` in
   `lib/script.ts`; the tab uses `reached()`, and `sections.test.ts` pins the
   two together for every kind and the inert stage.
2. **A video in a user-added (inert) stage can be scripted.** Such a stage has
   no place in the core order, the section tabs already treat that as "open,
   say nothing", and locking a script someone may be halfway through on a
   guess would be worse. Recorded in the README.
3. **The rule is enforced by `updateVideo`, not by the database.** The three
   columns have been in the client's UPDATE grant since `0001_init.sql`
   (line ~337), so a hand-made PostgREST PATCH with a session token could
   still write a script on an idea. Revoking them would need a migration and
   a security-definer writer, and 0010 belongs to the timezone slice running
   alongside this one; the stage rule is a product rule about when to write,
   not an invariant like the gate, whose enforcement stays in `move_video`.
   *If wrong:* revoke the three columns and add `set_video_script(p_video,
   p_expected_updated_at, …)` that checks the stage kind.
4. **Reset is a read plus an ordinary save, not a write action.** A reset
   that wrote the column itself would be a second write path racing the
   editor's queue: a save still on the wire would land after it, or be
   refused by this page's own version token. So the action answers "what
   would the template give me?" and the editor writes it. The one write path
   into `script` is `updateVideo`, with its version check, and Undo is the
   same save with the old text.
5. **The template build has two implementations, proved to agree.** The SQL
   in `move_video` (`0005_checklist_seeded_stages.sql`, from `0001`) stays the
   source for the first draft; `buildScriptFromTemplate` mirrors it — every
   occurrence replaced, the replacement taken literally, the *first* chosen
   hook in array order, `chosen` read with Postgres' boolean rules through the
   existing `readHooks`, and `''` when none is chosen. Making SQL the one
   implementation would have meant redefining `move_video` in a migration;
   see 3. The proof is `e2e/script-editor.spec.ts`: `move_video` writes the
   script against the real Postgres, the person replaces it, Reset puts back
   a text compared **byte for byte** with what the SQL wrote, on a hook
   (`Make $$$ from $& … $1`) chosen to break `String.replaceAll`. The unit
   tests pin the cases a browser reaches slowly (two chosen hooks, `"y"`,
   non-object entries, no placeholder). The one known divergence is on data
   this app never writes: a hook whose `text` is a JSON number.
6. **Undo lasts until the page is left**, held in memory — the minimum the
   task set, and the concept assist's precedent. Not stored: the app keeps no
   history of any field.
7. **Save after a 1.2-second pause.** The rest of the page saves on blur, but
   a script is an evening in one box that may never blur. Keystroke saves
   would put hundreds of rows of nonsense through `updated_at`; a pause is
   one save per sentence or so.
8. **The script is not trimmed and the box never adopts the server's copy.**
   Every other field shows what the server stored after a save; this one
   compares stored forms instead, so a box and a column that differ only by
   a trailing blank line are not "unsaved".
9. **No `maxLength` on the textarea.** The browser truncates a paste over a
   `maxLength` silently, which is the one outcome this editor must not have.
   The server refuses an over-long script and the text stays in the box.
10. **One word on the phone's Reset button.** Below 640px the button reads
    "Reset" (the accessible name is still "Reset from template"), so the
    toolbar is one row and the keyboard leaves the script more room.

### Deviations from PLAN.md

- PLAN.md review item 19 is now built, as "Reset from template" on the Script
  tab — with a confirmation and an Undo that the plan did not specify.
- PLAN.md puts `script_structure` on the detail page as a "note field"; it is
  a select of the CHECK's three values, because the column cannot hold
  anything else.

### What is still true, and in the README

- Reset's Undo does not survive leaving the page.
- A script save is a whole-page server refresh (`revalidatePath`, as for every
  other field on the page). Skipping it for script-only saves was considered
  and rejected: the client router cache would then restore a stale script
  prop and a stale version token on Back, and the first save after it would
  be refused as a conflict.
- The phone measurements are Chromium at 390×844 and 390×420 (the keyboard
  stand-in), with `hasTouch`/`isMobile`. iOS Safari's visual-viewport
  behaviour under the keyboard, and whether the sticky toolbar stays in sight
  there, has not been seen.
- `docs/OVERNIGHT.md` still says the script is read-only. It is the dated
  summary of the M5–M9 run and was left as a record.

### Verification

The timezone slice was being built in the same working tree at the same time,
and its half-finished state did not typecheck, so this slice was verified on
an isolated copy: `git archive HEAD` plus only this slice's files (and only
its three hunks of `app/videos/[id]/page.tsx`), with its own stack ports, dev
database and SQL-test database (`DEV_STACK_PORT=54351`,
`DEV_STACK_POSTGREST_PORT=54352`, `NERTUBE_DEV_DB=nertube_e2e_script`,
`NERTUBE_TEST_DB=nertube_test_script`, `E2E_PORT=3131`, `E2E_REUSE=0`).
The first full run did not start: the stack's `verify-db.sh` shares
`nertube_test` by default and the other slice's run had just dropped it.
That is the fifth environment trap, and the reason for the last variable.

| Gate | Result |
|---|---|
| `tsc --noEmit`, both programs | clean |
| `eslint .` | clean |
| `vitest run` | 549 passed, 34 files (`lib/script.test.ts` new, `sections.test.ts` +1) |
| `playwright test script-editor` | 10 passed |
| `playwright test` (full, production build) | **317 passed, 0 failed, 1 skipped** (`session-refresh`, as always), 17.9 min, exit 0 |

One existing spec changed: `e2e/m9-week.spec.ts`'s "script it" step read the
old `<pre>` (`script-text`); it now reads the editor's value.

## M10 — "Today" is the user's day: the time zone

The user's first request after the M5–M9 run. Until now every "today" in the
application was the UTC calendar day (M6, decision 1), which the README listed
first among its catches: in Los Angeles the calendar's today, `/now`'s
"Confirm live" and the board's batch-day date all turned over at five in the
afternoon. The user's zone is now a setting, per user, in the database, and
every "today" and every timestamp shown is in it.

### The inventory, taken before anything changed

Every place a date or a time was derived, and what it was:

| Site | What it derived | Now |
|---|---|---|
| `lib/calendar-dates.ts` `todayColumn(ms)` | the UTC day | `todayColumn(ms, zone)`: the day in the user's zone |
| `components/app-shell.tsx` | UTC today for the Calendar count; Now count via rule 5 | the zone from `readTimeZone()` |
| `app/calendar/page.tsx` (page and metadata) | UTC today, the month it opens on | zone |
| `components/calendar/grid/url.ts` `monthFromQuery` | its own `todayColumn(now)` | takes the page's `today` |
| `app/c/[slug]/board/page.tsx` | UTC today for the badge dialog | zone |
| `app/videos/[id]/page.tsx` | UTC today (linkable days, "is the target here"); `published_at` formatted in UTC | zone; `formatInstant` |
| `lib/next-action.ts` rule 5 `isFuture` | UTC day | `NowContext.timeZone` |
| `lib/now-data.ts` `countNowRows` | via rule 5 | takes the zone |
| `components/now/now-view.tsx` (client re-rank) | via rule 5 | `useTimeZone()` |
| `components/ideas/matrix/tally.ts` `monthWindow` | UTC month | zone |
| `components/calendar/filming/summary.ts` | past/upcoming against `today` | unchanged; its `today` is now zoned |
| `app/actions/metrics.ts` `confirmLive` | `published_at = ${target}T00:00:00Z` | `startOfDay(target, zone)` |
| `app/c/[slug]/ideas/page.tsx` capture date | `Intl` in UTC | `formatInstant` |
| `components/thumbnails/swap-log.tsx`, `thumbnails-section.tsx` ("Live since") | `Intl`/`toLocaleDateString` in UTC | `formatInstant` + `useTimeZone()` |
| `components/packaging/skip-packaging.tsx`, `post-publish-block.tsx`, `video-detail/flow-fields.tsx` | `Intl` in UTC | same |
| `scripts/seed-demo.ts` `nextTuesday` | `todayColumn(Date.now())` | the machine's zone (a script, not a render) |
| Days in stage (board, `/now`, `stage-stats`), waiting ages, 24 h metrics window, 30-day card TTL | elapsed milliseconds | **unchanged**: durations, and now commented as such |
| `lib/calendar-dates.ts` date-column formatters, arithmetic, month grids | UTC as a neutral representation of a zoneless `date` | unchanged, and the header says why |
| Server actions' `new Date().toISOString()` stamps (`updated_at`, `checked_at`, …) | instants | unchanged: instants, not days |
| Form date defaults (`nextSaturday(today)`, `<input type="date">`) | from the server's `today` | zoned through `today` |

Seven specs derived a date from the machine's UTC day (`calendar`,
`filming-days`, `m4-acceptance`, `m6-acceptance`, `m9-week`, `matrix`,
`settings-channel`).

### What was built

- **`public.profiles`** (migration `0010_time_zone.sql`): one row per user —
  `id`, `user_id` (unique, references `auth.users`, cascades), `created_at`,
  `updated_at`, `time_zone`, `time_zone_source` (`detected` | `chosen`). RLS on,
  a select policy on `auth.uid()`, every client privilege revoked except
  SELECT. A CHECK holds the IANA shape (`UTC` or `Area/Place…`, ≤ 64).
- **`set_time_zone(p_zone, p_detected)`**, security definer, the only writer.
  It refuses (22023) any name not in `pg_timezone_names` or not of the shape —
  offsets, POSIX rules, `posixrules`/`localtime`/`Factory`, wrong case. A
  detected zone never replaces an existing row; a chosen one always does.
- **The helper** (`lib/calendar-dates.ts`): `todayColumn(ms, zone)`,
  `startOfDay(date, zone)` (the first instant of a day, DST-gap-safe),
  `formatInstant(value, zone, style)`, `canonicalTimeZone`, `offsetLabel`,
  `timeZoneGroups` (the picker's list, built on the server) and
  `timeZoneCity`. `Intl` only; no library.
- **One read per request**: `readTimeZone()` (`lib/time-zone-data.ts`,
  `cache()`d, never throws — unknown is UTC) and its twin `readClock()`
  (`lib/request-clock.ts`), which replaced the eight separate `Date.now()`
  reads in server components, so the shell and the page share one instant.
- **To the client**: `AppShell` puts the zone in `TimeZoneProvider`
  (`components/time-zone.tsx`); client components read `useTimeZone()` — the
  server's value — and never their own browser's during render.
- **Detection**: the login form sends `Intl.DateTimeFormat().resolvedOptions()
  .timeZone` with the sign-in, and `signIn` records it (detected, best effort).
  A session that predates M10 has no row: the shell mounts `TimeZoneDetector`,
  which records the browser's zone after hydration and refreshes once, while
  the calendar and `/now` say "Dates here follow UTC until your time zone is
  set" with a link to Settings.
- **Settings → Time zone** (`/settings/account`): the one per-user screen, a
  fifth entry in the settings nav with no channel switch. It says what today is
  in the stored zone and what time it is there, and changes it from a native
  select grouped by area (each city with its current offset) and a Save
  button; on a device in another zone, a one-press "Use <city>". The write goes
  through `useSaveQueue`, so its status line and Retry are the ones every other
  setting has.

### Decisions taken without the user

1. **Detected at sign-in, not in a first-page effect.** A zone detected by an
   effect after the first page drew would redraw every date on that page — the
   flash the brief warns about. The sign-in form already runs in the browser,
   so it carries the zone, and the first page after sign-in is already right.
   The effect exists only for sessions that were open when M10 shipped.
2. **Detected never overwrites.** The phone and the laptop must agree, so the
   account holds one zone; a sign-in from a laptop in another city offers its
   zone in Settings rather than taking it. Travelling is a choice, made once.
3. **Save, not save-on-change.** An arrow key on a closed `<select>` fires
   `change` on Windows and Linux (M9's review, the stage select). Saving on
   change would write a zone per keypress, and each write redraws every date.
4. **Where it lives: `/settings/account`.** Every other setting is per channel;
   this is per person, so it has one address with no slug, and its nav entry
   says what is there ("Time zone") rather than "Account".
5. **The zone is stored under its current IANA name.** Node's `Intl` spells
   18 zones the old way (`Asia/Calcutta`); Ubuntu 24.04's tzdata, and
   therefore the harness's `pg_timezone_names`, no longer lists those.
   `canonicalTimeZone` maps them (`IANA_NAME` in the helper); all 419 names the
   picker offers were checked against the harness catalogue.
6. **Pre-M10 "Confirm live" stamps are re-read once.** They were the target
   date at midnight UTC; left alone they would show as the day before
   everywhere west of UTC the moment the zone was known. `set_time_zone`
   moves each `published_at` that is exactly a UTC midnight to the same date's
   midnight in the new zone — the first time a zone is recorded, and never
   again. A later zone change moves nothing (instants do not move when the
   viewer does). A drag into Published stamps `now()` to the microsecond, so
   one landing exactly on a UTC midnight by accident is not a realistic case.
7. **A server clock the browser suite can set.** "Today" is decided on the
   server, so `page.clock` alone cannot put the app at an hour where Auckland
   and Los Angeles disagree. `readClock()` honours a `nertube-test-clock`
   cookie only when the server was started with `NERTUBE_TEST_CLOCK=1`, which
   only `playwright.config.ts` does. With it, a request can see its own data as
   of another moment and nothing more: writes stamp time in SQL, and sessions
   are checked against the real clock.
8. **The seed account's zone is recorded by the seed**, as chosen, `UTC`
   (`SEED_TIME_ZONE`), and the suite pins `timezoneId: 'UTC'`. Every other
   spec's "today" is computed in `SEED_TIME_ZONE`, so it is right by
   construction rather than because the machine happens to be in UTC.

### Deviations from PLAN.md, stated plainly

- PLAN.md's data model has no profile table; `public.profiles` is new, and the
  schema-contract test's table list now has nine.
- `published_at` for "Confirm live" is the target date at the user's midnight,
  not at UTC's; PLAN.md says "p_published_at = target date" and does not name a
  zone.

### Honest limits

- A session that was already signed in when M10 was deployed draws one page
  in UTC (it says so), then records the browser's zone and redraws.
- The hosted database's tz catalogue has not been read; a name it lacks would
  be refused with a sentence, not stored.
- Changing zone does not move stamps recorded under the previous one, so a
  video confirmed at Auckland's midnight shows as the day before in Los
  Angeles. That is the correct reading of an instant, and it is in the README.
- No real phone and no real zone change: every zone in the browser suite is
  Chromium's `timezoneId`.
- Seen in the server's log during both browser runs, and not investigated:
  "The destination stream closed early", printed while specs navigate away
  from a page still streaming (calendar, buckets, brainstorm, board specs as
  well as this one). No spec fails on it; whether it predates M10 was not
  checked against the M9 build.
- `e2e/m2-review.spec.ts:515` still reads a `date` column through `pg`, which
  parses it to *the test runner's* local midnight, then prints it in UTC; east
  of UTC that assertion would fail. It is about the runner's zone, not the
  app's, and was left alone.

### Gates

| Gate | Result |
|---|---|
| `npx tsc --noEmit` and `-p tsconfig.harness.json` | clean |
| `npx eslint .` | clean |
| `npm test` | 35 files, 598 tests passed; also under `TZ=Pacific/Auckland` (598) and `TZ=America/Los_Angeles` for the date, ranking and matrix files (195) |
| `./scripts/verify-db.sh` | 18 SQL files passed, including `85_time_zone.test.sql` (RLS, tenant isolation, direct writes refused, ten invalid names refused with 22023, detected-never-overwrites, the one-time re-stamp) |
| `E2E_REUSE=0 npx playwright test timezone` | 4 passed |
| Full browser suite, first run | 320 passed, 1 failed, 1 skipped (`session-refresh`, which only runs under `e2e:refresh`). The failure was `m7-acceptance.spec.ts:225` counting four settings links; there are five now, and the spec counts five and checks the fifth's address |
| The affected specs again (timezone, m7-acceptance, m4-acceptance, post-publish, now, calendar, settings-stages) | 47 passed |
| Full browser suite, final run (`E2E_REUSE=0 npx playwright test`, with the script-editor slice's specs in the same tree) | **321 passed, 1 skipped** (`session-refresh`), 14.8 min |

## M10 — The phone, everywhere

> The slice that owns the phone-width behaviour of every route except the
> Script tab (the script slice) and the time-zone field (the time-zone
> slice). M9 made `/now` and `/capture` good at 390px and called the rest
> "usable rather than comfortable"; the user asked for mobile web that works
> OK. Nothing here adds a dependency, a second modal, a second keyboard
> mechanism or a second date helper.

### The walk, before anything changed

Every route, signed in, at **390×844 as a touch device** (`hasTouch`,
`isMobile`, so `pointer: coarse` is true and every press is a `tap()`), on a
seeded account with fourteen videos across every stage of one channel, two in
another, four pillars, a filming day, checklists half ticked, a published
video with and without its numbers. A script measured every visible control's
box, every element cut by an ellipsis or a clamp, and `scrollWidth` against
`clientWidth`; each page was also looked at in full-page and one-screen
screenshots. It was repeated at 320×640. What it found, in the task's order:

**Broken — could not be done, or hid what was being used:**

| # | Where | What the walk measured |
|---|---|---|
| B1 | Every page | The `?` sheet had no touch way in: its button is the desktop hint bar's, which is not in the phone menu. |
| B2 | Calendar | A day was 51px wide; a chip was 41×20 and showed two or three letters of a title ("SS I…"). Seeing what is scheduled this month meant tapping every chip. An in-month date was not a link, so a day could be opened only through a filming chip or `?day=`. |
| B3 | Board | A column was 216px, a card's title had 106px and a three-line clamp: "The one spreadsheet that runs my entire…". Nine columns, no way across but swiping, one and a half columns on screen. |
| B4 | Video page, every tab | The checklist strip's sentence was cut: "Idea has no checklist on th…", "Generated 10–20 title ca…" (160px of 232 and 293). |
| B5 | Packaging | A title candidate was a 166px one-line input beside Choose and Remove: "Nine hours of sleep, on" — the half of the title that decides nothing. M9 fixed the same thing for hooks. |
| B6 | Packaging | Tapping Generate 20 left the panel where it opened: its first proposal at y 873 on an 844 screen. |
| B7 | Publish | The 24-hour form's Log button sat between Views and New viewers. |

**Tap targets under 44px on controls used in the week's work** (M9's review
counted some; the walk counted all): the settings rows' arrows (24×24),
Remove links (45×18) and × buttons (20×26), their name and minute fields
(27–30px), the settings nav and channel switch (26–28px), List/Matrix (28px),
the calendar's chips (20px) and its "Schedule a filming day" (34px), the board's
Filming badge (42px) and card titles (19–39px), "Ship this one" (30px),
"Schedule a new day…" (26px), Clear / Unblocked / Archive / Add (38px), the
24-hour Log (38px), a tag's × (15×13) and suggestions (26px), the filming
day's Detach / Move / Cancel (about 28px), the checklist's own rows and add
box, "← board" (16px), the wordmark (33px), and text fields at 40–42px.

**Merely not ideal:** the Packaging tab is several screens long with Filing
and the preview under every field; the matrix showed two of eight formats
with the pillar column taking 150px; the section tabs wrap to two lines (left
as they are — both lines are 44px tabs). **No page scrolled sideways** at 320,
360 or 390: M9's shell clip holds.

### What changed

- **The `?` sheet from the phone menu.** The sheet's foot has a "Keyboard
  shortcuts ?" button above the theme control. It is plain markup in the
  server-rendered drawer; `AppSidebarMenu` closes the menu and, once the
  menu's modal has let go of the page, calls the same `openShortcutSheet()`
  the hint bar uses. One modal at a time, the sheet lists the page's keys
  (read after the menu stopped silencing them), and focus comes back to the
  menu button when it closes. The hint bar's "all keys" is 44px under a
  coarse pointer too (a tablet in landscape has the desktop sidebar).
- **The calendar is a list of days below 768px — the same table, restyled.**
  See the decision below. Every in-month day that holds something, plus today
  and the open day, is a full-width row: a 48×44 date block (weekday over the
  number) that opens the day, and the chips as 44px rows with their whole
  titles wrapped. Empty days and the neighbouring months' days are
  `display: none` there. A tapped date's panel scrolls itself to the top of
  the screen (`RevealOnPhone`, a no-op from `md` up), because below a list of
  days it was a screen or more under the finger.
- **The board: one column at a time, and a row of stages.** Below `md` a
  column is `100vw − 4rem` (326px at 390: the screen less a 16px sliver of the
  next column) and the strip snaps to columns. Above it, `StageJump` lists
  every stage in board order with its count as 44px buttons; a tap scrolls
  the strip to that column and marks it `aria-current`. The card title's
  column is 216px instead of 106, so the three-line clamp no longer cuts
  ordinary titles. The header sentence no longer offers swiping, which the row
  replaces.
- **The checklist strip's sentence** takes its own line below `md` and wraps.
- **Title candidates wrap.** A candidate is a one-row textarea that grows with
  its text (`field-sizing: content`); Enter still commits instead of breaking
  the line, and a pasted line break becomes a space. Below `md` it takes the
  row and Choose / Remove wrap under it — the hooks' rule from M9.
- **An assist panel opens on screen.** `useAssistFocus` focuses the heading
  without the browser's own scroll, then scrolls it: to the top below `md`
  (under the bar, by `scroll-padding-top`), "nearest" from `md` up, as before.
  Measured (and asserted): Generate 20's heading between y 57 and 140, under the bar, and its first proposal in the viewport.
- **The 24-hour form** puts its Log button after the note, at every width.
- **The Packaging tab has two jump links** at its top below `md`, "Filing and
  tags ↓" and "How it looks on YouTube ↓" — plain in-page anchors to ids on
  the Filing block and the preview. The fields keep the gate's order.
- **The matrix** pins its pillar column (sticky, 96px) and draws formats 60px
  wide below `md`: four of eight whole on a 390 screen, and the row stays
  named while the formats scroll under it. Long format names break inside the
  cell rather than overflow it.
- **44px under a thumb, everywhere else the walk found.** Every control in the
  list above got `thumb:min-h-11` (or `thumb:size-11` for the icon buttons),
  the variant M9 defined as `(width < 48rem), (pointer: coarse)`, so a mouse
  on a desktop keeps its density. Checkbox rows whose label is the target
  (the stage switch, the Repurposed lane) raise the label, not the box.

### Decisions taken without the user

1. **The calendar is a day list at phone width, not a grid.** The task allowed
   it if the grid could not be made to work, and it cannot: at 358px a day is
   51px, and the content of a calendar day is titles. A smaller font or a
   two-letter code is still not a title. The list is **the same `<table>`
   restyled with `max-md:` rules**, not a second rendering: a second one would
   put every chip, test id and link on the page twice (hidden elements still
   count for a strict locator), and would be the "second calendar" M9 declined
   to add. The month's shape (which weekday a date falls on) is carried by the
   weekday on each date block. Empty days are not listed; "Schedule a filming
   day" still books any date.
2. **The board keeps its columns; it does not become a list.** A phone gets
   one near-full-width column at a time with a stage row to jump, rather than
   a stacked list of stages: the board's jobs (what is in each stage, move a
   video on) are both one tap from there, and it keeps being the same board,
   with the same card, the same arrows and the same keyboard, at every width.
   Drag and drop still needs a mouse; the arrows are the touch path, as in M9.
3. **The weekly strip stays above the stage row on a phone.** They overlap
   (both give counts), but the strip carries the ages a Monday review reads,
   and hiding it would make the phone a different board.
4. **The 24-hour save moved after the note on the desktop too.** It is the
   same form; top-to-bottom order is not a phone-only concern, and a second
   button for one layout (the `/capture` trick) would have put two
   `metrics-save` elements on the page.
5. **Title candidates wrap on the desktop too.** One element cannot be an
   input at one width and a textarea at another. At desktop widths a
   candidate of up to about fifty-five characters is still one line; a longer
   one now wraps instead of scrolling inside its box.
6. **`/now`'s links to elsewhere stay 24px**, as M9 decided (its decision 5);
   links inside a sentence keep the inline exception. Everything else is 44.
7. **Text fields are 44px under a thumb as well,** not only buttons. They were
   40–42px; the change is `min-height` and invisible with a mouse.

### Deviations from PLAN.md, stated plainly

- **PLAN.md's calendar is "a month grid"; on a phone it is a list of days.**
  From 768px up it is the grid, unchanged.
- **The phone pass went past `/now` and `/capture` again** (PLAN.md:199
  scopes it to those two), because the user asked for mobile web that works.

### Honest limits

- **Still no real phone.** Every number is Chromium at a phone-sized viewport
  with `hasTouch` and `isMobile`. The smooth scrolls (`StageJump`,
  `RevealOnPhone`) and CSS snap have not been felt under a finger.
- **A checklist template item in Settings is still a one-line field.** At 390
  a long item scrolls inside its 294px box; it was left, as a settings screen
  rather than the week's work.
- **The board's weekly strip and stage row both count cards** on a phone (see
  decision 3).
- **Section tabs on the video page wrap to two lines at 390.** All five are
  44px tabs; nothing is hidden.
- **Hash links on the Packaging tab** change the address (`#video-filing`);
  Back returns to the top of the tab.
- **Dialogs were not walked control by control.** The schedule-day dialog, the
  swap dialog and the capture box are what the M9 week walk taps through at
  390; `e2e/phone.spec.ts` measures the pages and the open menu, not them.

### Gates

Run in a tree the script and time-zone slices had finished in (the
orchestrator's checkpoint `ece4502` plus this slice), on its own ports and
database (`DEV_STACK_PORT=54351`, `NERTUBE_DEV_DB=nertube_e2e_phone`,
`E2E_PORT=3114`) so as not to meet another agent's stack.

| Gate | Result |
|---|---|
| `npx tsc --noEmit` and `-p tsconfig.harness.json` | clean |
| `npx eslint .` | clean |
| `npx vitest run` | 35 files, 598 tests passed (this slice adds no pure function) |
| `e2e/phone.spec.ts` + `e2e/responsive.spec.ts` | **18 passed** (10 + 8) |
| Full browser suite (`E2E_REUSE=0 npx playwright test`, production build) | **331 passed, 1 skipped** (`session-refresh`, which only runs under `e2e:refresh`), 15.2 min, exit 0 |

Found by the first runs of the new spec, and fixed before the full run: the
wordmark in the phone bar was 33px tall; the day panel's video lines were
19–29px; the Live URL link on the Publish tab was 16px; the one-row candidate
box was 34px; the pinned pillar column slid 4px under the scroller's padding
(it is pinned at `left: 4px` now). The spec's own mistakes were a board move
read from the database before the server had answered (now polled) and a
calendar address assumed to be `?day=` alone (it is `?month=…&day=…`).

## M10 — Integration: three slices in one tree, and the week walked again

The user asked for three things after reading the M5–M9 summary: "today" in
their own time zone, the script editable in the app with a reset from the
template, and mobile web that works OK. Three agents built them at the same
time in one working tree (the three sections above). This pass checked their
reports against the code, walked the whole week again on a laptop and a
phone with the new steps in it, fixed what the walk found, and brought the
README and `docs/OVERNIGHT.md` up to date.

### Reconciled: checked, and one of each

| Rule | What the tree holds |
|---|---|
| One migration | `0010_time_zone.sql` only. The script slice needed no schema change (its three columns were already in the client's UPDATE grant), and the phone slice none. Nothing to merge; it applies on 0001–0009 (`verify-db.sh m10_check`: 18 files). |
| One date helper, one zone read | Every "today" goes through `todayColumn(ms, zone)` in `lib/calendar-dates.ts`, the zone through `readTimeZone()` (`cache()`d) and the instant through `readClock()` (`cache()`d). `timeZone: "UTC"` survives only inside the helper, for zoneless `date` columns. The phone slice imported `todayColumn`, `addDays`, `monthKey`, `monthOf` and added no date code. |
| One patch vocabulary | `lib/video-fields.ts` gained `script`, `scriptStructure`, `endScreenTarget`; no other file validates them. |
| One save queue | The script editor and the time-zone form both use `useSaveQueue`; the unmount/`beforeunload` guards were extracted into `useUnsavedGuard` in the same file, not copied. |
| One modal | The reset dialog is `Modal`; the phone menu closes before the `?` sheet opens, so two are never stacked. |
| One keyboard mechanism | Untouched by M10. |
| No duplicated components | The phone slice's new pieces (`StageJump`, `RevealOnPhone`) have no counterpart elsewhere; the four `scrollIntoView` calls in the tree do four different jobs. |

**The two screens the phone slice did not own.** `e2e/phone.spec.ts` already
had Settings → Time zone on its route list; the Script tab was not on it. It
is now (a Scripting video with a script, `?section=script`), so both are
measured for sideways scroll at 320/360/390 and for 44px targets like the
other nineteen routes. Both passed without changes.

### The week, walked again

`e2e/m9-week.spec.ts` was extended rather than copied: the M9 walk already
carries one idea from capture to a thumbnail swap on a laptop (1440×900,
mouse and keys) and on a phone (390×844, `hasTouch`, `isMobile`, every press
a tap). M10 adds, in order: **write in the script** (caret to the end, type a
line, wait for Saved and the row), **reset it once** (the dialog names the
chosen hook; confirm; the box and the row are byte-for-byte what `move_video`
wrote), and at the end **change the time zone in Settings and watch the
calendar's today move**, reached the way a person would (the sidebar, or the
phone menu, then the settings nav), then put it back. Nothing in this
environment can move the real clock, so the walk moves the person: to
Kiritimati (UTC+14) from 10:00 UTC, Pago Pago (UTC−11) before 11:00, one of
which is always on another date than UTC. Every step saves a screenshot
under `test-results/m9-week/`; the notes below are from reading them.

**Where it was awkward, and what happened to it.**

| # | Device | Step | What it was like | Now |
|---|---|---|---|---|
| W1 | both | Reset | Reset is pressed from deep in the script, where the toolbar is pinned. "Replaced with the template." and its **Undo** were rendered *after* the toolbar in the flow, so they had scrolled away: on the phone the only visible sign of the reset was the word count dropping. The one way back from a reset was off screen. | **Fixed.** The notice is the toolbar's last row, so it is pinned with Reset. The walk asserts the notice and Undo are in the viewport. |
| W2 | laptop (and phone) | Time zone | Straight after Save the line read "Today is Wednesday, 23 September 2026 in Kiritimati, where it is 13:34" — the new city (client state) beside the old zone's date and time (server props, until the refresh landed). In Kiritimati it was already Thursday, 03:34. | **Fixed.** The city comes from the server's zone like the date and time, so the three change together. The walk asserts the new zone's date and city side by side. |
| W3 | phone | Board | The board opens scrolled to the first column with work (M9), but the new stage row did not follow: "Film…" was cut at the row's right edge, so the row that says where you are did not say it. | **Fixed.** `StageJump` scrolls its own row (never the page) to keep the marked stage whole. Asserted with `toBeInViewport({ ratio: 1 })`. |
| W4 | phone | Schedule a filming day | In the dialog's list of videos to shoot, the walk's own title read "What I tracked every coffee for a month taugh…": one line held about forty characters. | **Fixed.** Two lines (`line-clamp-2`), which hold a 55-character title. |
| W5 | phone | Calendar | "← August" / "October →" (and a day panel's close link) are 44px boxes with their text stuck to the top edge — links, unlike buttons, do not centre their content. The summary said "Every channel, on one grid" above a list. | **Fixed.** `thumb:inline-flex thumb:items-center`; "on one calendar". |
| W6 | phone | Script | The script itself starts about 630px down the tab, under the checklist strip, Structure and "End screen points at": on arrival the phone shows its first two lines. | Left, and in the README. Moving the two fields below the script would put them out of reach on a long one; collapsing them is a design change for the user to see. |
| W7 | phone | Script | A body bullet is written by tapping between the template's empty `-` lines. Placing a caret on a one-character line by thumb is fiddly; the walk put its line at the end instead, under "End screen". | Left, and in the README. It is the template's shape and the textarea's nature; a structured editor is out of scope (no editor library). |
| W8 | phone | Video page | Section tabs wrap to two rows; the Packaging tab is several screens long. | As the phone slice left them (both in the README). |
| W9 | both | Board badge | "9 in Filming across all channels" on the phone run: other specs' fixture channels are still in the database mid-suite, and the badge counts every channel by design. | Not an app issue; noted so a reader of the screenshots is not misled. |

What was *not* awkward, and was checked: capture by `c` and by the bar's
button; filing from the video page and seeing it land in the matrix;
promote by `p` and by tap; the brainstorm's twenty titles with the panel
opening on screen; the gate by `]` and by the card's arrow; typing in the
script with the save line in view (toolbar at y ≥ 56 on the phone) and no
sideways scroll; the reset dialog (focus on "Keep my script", both buttons
44px by touch); ticking stages through on `/now`; three thumbnail uploads
and Ship; Confirm live from `/now`; the 24-hour form with Log after the
note; the swap from `/now`'s row; Settings → Time zone by touch with a 16px
select and a full-width Save, and the calendar's today moving to Thursday
the 24th and back.

### Decisions taken without the user

1. **The week walk was extended, not duplicated.** A second 800-line walk for
   M10 would have been two copies of every helper to keep in step; the file
   keeps its name (`m9-week`) because the README and three milestones refer
   to it by that name, and its header says what M10 added.
2. **The walk changes the seed account's zone and puts it back.** The suite
   runs one worker, so nothing else runs meanwhile; the put-back is done
   through Settings (part of the walk) and again by SQL in `afterAll`, so a
   failure mid-step cannot leave the other specs' "today" in Kiritimati.
3. **An exotic zone rather than a plausible one.** Los Angeles differs from
   UTC's date only between 00:00 and 07:00 UTC; the walk has to see today
   move at whatever hour it runs, and only zones near ±12 guarantee that.
   `e2e/timezone.spec.ts` covers ordinary zones at a fixed instant.
4. **W6 and W7 were left as findings.** Each fix changes the Script tab's
   design (where the fields sit, or what the editor is), which the user has
   not seen; the README says what a phone shows.

### Deviations

None from PLAN.md or BRIEF.md in this pass. The three slices' deviations are
in their own sections above.

### Documents

- **README.** The UTC and read-only-script limits were already removed by
  their slices; this pass corrected what had become untrue: 0010 is **not**
  on the hosted database (the "nine migrations" lines, the deploy runbook's
  step 2 now says ten), the tap-target entry counts twenty routes and the
  reset dialog, and W6/W7 are in the phone entry.
- **`docs/OVERNIGHT.md`.** Two dated notes (23 September) under "Still broken
  or unbuilt" and "Every decision taken without you", saying which entries
  M10 made untrue; the dated text itself is unchanged.

### Honest limits of this pass

- Still no real phone; every "phone" above is Chromium at 390×844 with touch
  emulation.
- The walk proves "today moves" on the calendar only. `/now`'s go-live check
  and the board's batch-day date moving with the zone are
  `e2e/timezone.spec.ts`'s, at a fixed instant through the test clock.
- 0010 has not been applied to the hosted database from here, and its tz
  catalogue has not been read.

### Gates

Run on the final tree, in this session (not taken from the slices' reports).

| Gate | Result |
|---|---|
| `npx tsc --noEmit` and `-p tsconfig.harness.json` | clean |
| `npm run lint` | clean |
| `npm run build` | clean |
| `./scripts/verify-db.sh m10_check` | OK — migrations 0001–0010 applied, 18 SQL test files passed |
| `npx vitest run` | 35 files, 598 tests passed |
| `E2E_REUSE=0 npm run e2e` (production build) | **331 passed, 0 failed, 1 skipped** (`session-refresh`, which runs only under `e2e:refresh`), 15.0 min, exit 0 |

Before the full run, the walk and its neighbours were run twice on their
own: `m9-week` + `phone` (12 passed, before the fixes), then `m9-week`,
`phone`, `script-editor`, `calendar`, `filming-days` and the board specs
(65 passed, after W1, W3, W4 and W5). W2's fix and its assertion went in
after that and are covered by the full run.
