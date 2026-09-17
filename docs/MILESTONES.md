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
