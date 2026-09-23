# NerTube

A personal YouTube production pipeline. Other tools concentrate on the idea; this
one owns the middle — moving a video from a captured idea to a published URL
and through its first day live. It keeps several videos alive at once across
per-channel stages (Idea → Packaging (TTH) → Scripting → Filming → Editing →
Publish Prep → Scheduled → Published → Repurposed), makes it structurally
awkward to script a video before its title, thumbnail concept and hook are
decided, and answers the question a creator actually has in a spare ten
minutes: *what can I move right now?*

It is built for one person with two channels, and structured so it could become
a product later. `docs/BRIEF.md` is the requirement, `docs/PLAN.md` the plan it
was built from, and `docs/MILESTONES.md` the record of every milestone: what was
built, every deviation from the plan and why, every review finding, and every
decision taken without the user.

**Contents:** [What it does](#what-it-does) ·
[The principles, and why the data model looks like this](#the-principles-and-why-the-data-model-looks-like-this) ·
[Running it locally](#running-it-locally) ·
[Environment variables](#environment-variables) ·
[Where writes happen](#where-writes-happen) ·
[Deploying](#deploying) ·
[Honest limits](#honest-limits)

## What it does

- **Now** (`/now`) — the next small step on every video in production, across
  every channel, oldest first. Every row is finishable where it stands: tick the
  checklist item, type the working title, pick the hook, log impressions and CTR,
  record the URL, answer the swap question. A "10 minutes or less" filter hides
  the steps that need a real block of time.
- **Board** (`/c/<channel>/board`) — a kanban per channel with drag and drop
  and keyboard moves, WIP warnings, days-in-stage, a stale flag, a weekly-review
  strip (count, oldest, median per column) and a Filming badge that books a
  batch filming day when three or more videos are waiting on a camera.
- **Idea bank and matrix** (`/c/<channel>/ideas`) — every idea with search,
  tag and bucket filters and Promote; `?view=matrix` crosses topic pillars with
  formats, shows monthly quotas, and turns every empty cell into a capture.
- **Capture** — `c` anywhere, one field, Enter, done; `/capture` is the same
  form as a page for a phone's home screen.
- **The video page** (`/videos/<id>`) — packaging (working title with a 55-
  character warning, title candidates with notes, the written thumbnail concept
  and a sketch, up to three hooks, the gate indicator and a deliberate skip),
  the checklist for the current stage, the script as the template filled it,
  three thumbnail variants (wild card / moderate / safe) with a shipped role and
  a swap log, and the post-publish block (impressions and CTR always together,
  views, new viewers, "swap thumbnail?").
- **Calendar** (`/calendar`) — target publish dates for every channel on one
  month, and filming days as their own kind of event.
- **Settings** (`/settings/…`) — per channel: stages (rename, reorder within the
  core order, switch off, add your own), checklist templates with minute
  estimates, buckets and quotas, the voice guide, the script template, the WIP
  and stale thresholds, and the CTR the swap prompt measures against.
- **The assists** — title and hook suggestions, thumbnail concepts, and a
  critique of the three variants at feed size, conditioned on the channel's
  voice guide and past titles. Proposals, never edits: nothing lands in a field
  until it is accepted.
- **Keys** — `?` on any page with the sidebar lists what works there. `g` then a letter goes
  places, `j`/`k`/`Enter`/`Escape` work every list, `[`/`]` move a card, `x`
  does a `/now` row, `p` promotes an idea.

## The principles, and why the data model looks like this

The brief names eight principles and says they determine the data model. They
do; this is where each one lives.

| Principle | What it became |
|---|---|
| **Packaging comes first.** Title, thumbnail concept and hook before a word is scripted. | One hard gate, enforced by the database. `move_video()` refuses any move past Packaging unless the three fields are filled *at that moment* (`title <> ''`, a thumbnail concept, exactly one chosen hook). There is no "locked" flag to go stale: the gate is the fields. Skipping is allowed only with a typed reason, which leaves a permanent badge and puts "Complete packaging" at the top of `/now`. |
| **Thumbnail concept ≠ thumbnail asset.** | Two different things in two different places: `thumbnail_concept` (text the gate reads) plus an optional sketch, decided at Packaging; and three image slots decided near publish. They are never conflated — the gate never looks at an image. |
| **Parallel, not serial.** Five to ten videos alive, nudged forward in spare minutes. | `/now` is a pure function (`lib/next-action.ts`, unit-tested rule by rule) over the videos, their checklists and the clock. It is *derived*, not stored: the answer depends on the time of day (24-hour checks, go-live dates, staleness), so a stored "next action" would be a cache with five ways to go stale. |
| **Batch filming.** | `filming_days`, one per date, user-level and cross-channel (one creator, one camera). The board's Filming badge counts across every channel and books the day. |
| **Bottleneck visibility.** | `stage_entered_at` on every video, set only by `move_video()`: days in stage on the card, the stale flag, the WIP warning on in-flight columns, and the weekly strip's median. |
| **Friction reduction is the product.** | Every channel is created with its nine stages, seven checklist templates (the brief's, verbatim, with minute estimates), eight formats and a script template (`lib/defaults.ts`). Checklists are *copied* onto a video the first time it enters a stage, so a template edit never silently un-ticks work in flight, and a custom item goes to the top and is immediately the next action. |
| **Three thumbnails at launch.** | Three slots, not a list (`thumb_wild_card_path`, `thumb_moderate_path`, `thumb_safe_path`), so there is exactly one "safe" and it is a column. `shipped_role` has a CHECK that the role has an image, and changes only through `swap_thumbnail()`, which writes the append-only `thumbnail_swaps` log (with a required reason) in the same transaction. |
| **Publishing is not the last stage.** | The post-publish block and `/now`'s rules 2 and 3. Impressions and CTR are one component and one CHECK (`(first24_impressions is null) = (first24_ctr is null)`): a CTR without its denominator cannot be stored. |

Four structural decisions follow from those and from the brief's other lines:

- **One `videos` table; an idea is a video in the Idea stage.** Promote is a
  stage move like any other, so there is no copy step and nothing to keep in
  sync between an "ideas" table and a "videos" table.
- **Stages are a per-channel table whose rows carry a fixed `kind`.** The brief
  says stages must be editable per channel, so they are rows. But behaviour —
  the gate, the Filming badge, the URL field, the post-publish block, "the next
  stage" — keys on `kind` and on `CORE_KIND_ORDER` in code, never on the name or
  the position. Rename Packaging to "TTH" and the gate still fires; add a stage
  of your own and it is inert. Core stages cannot be deleted, and cannot be
  reordered past each other.
- **`user_id` on every table, with tenant-bound composite foreign keys.** A
  single user today, but every parent has `unique (id, user_id)` and every child
  references `(parent_id, user_id)`, so one account cannot attach rows to
  another's even through a foreign-key check (which bypasses RLS). A bucket can
  only be attached to a video of its own channel, on its own axis, by the same
  mechanism. RLS is on for every table.
- **Invariants live in SQL functions, not in application code.** supabase-js
  has no transactions, so every multi-row write is a `security definer`
  function that checks ownership first: `create_channel`, `capture_video`,
  `move_video`, `swap_thumbnail`, and the settings functions. The columns they
  own (`stage_id`, `stage_entered_at`, `published_at`, `shipped_role`, stage
  `kind`/`position`/`is_enabled`) have their UPDATE privilege revoked from the
  client, so the functions are the only way to change them — enforced by the
  database, not by convention.

## Running it locally

You need **Node 22** and one of two ways to run Supabase.

### With Docker: the Supabase CLI (the authority)

```bash
npm install
npx supabase start            # uses supabase/config.toml and supabase/migrations
npx supabase db reset         # applies every migration from 0001 to 0009
cp .env.example .env.local    # paste the API URL and anon key `supabase start` printed
npm run dev                   # http://localhost:3000
```

Then create your user: Studio at http://127.0.0.1:54323 → Authentication →
Users → *Add user*, with *Auto Confirm User* ticked. There is no sign-up
screen, and `supabase/config.toml` has signups turned off on purpose (one user,
created once). Sign in, and the app walks you from an empty account to your
first channel.

**This path has not been run in the environment NerTube was built in**, which
has no Docker daemon. `supabase/config.toml` was generated by the pinned CLI
(`supabase init`, v2.117.0) in M9 with only three changes (project id,
signups off, the seed step off); everything else is the CLI's own default.

### Without Docker: the local test harness

This is how every milestone was built and tested. **If you do not have Docker,
do not reach for `supabase start` — it cannot run.** Use this instead:

```bash
npm install
npm run dev:stack             # needs PostgreSQL 16 on 127.0.0.1:5432 and `postgrest` 12.2 on PATH
npm run dev                   # in a second terminal
```

`npm run dev:stack` runs the whole SQL test suite against a throwaway database
and refuses to serve anything unless it passes, then rebuilds `nertube_dev`
from the migrations alone, seeds one user and two channels **through the real
`create_channel` and `capture_video` functions as that user**, and serves one
origin at http://127.0.0.1:54321 carrying `/rest/v1` (the real PostgREST
binary, logging in as `authenticator`, so every RLS policy and column grant is
enforced by Postgres), `/auth/v1` and `/storage/v1`. It prints the URL, the anon
key and the seeded credentials to paste into `.env.local`. Ctrl-C (or a plain
`kill`) takes PostgREST down with it; `npm run dev:stack:stop` clears up after
a `kill -9`.

**It is a test harness that approximates Supabase. It is never deployed and the
application does not import a line of it.** Postgres and PostgREST in it are
real; GoTrue and Storage are re-implemented to the shape
`@supabase/supabase-js` parses. What that costs — no email, magic links, OTP,
OAuth, MFA or `auth.admin.*`; no rate limiting; only the `public` schema over
REST; no Realtime; in Storage no image transforms, resumable uploads, public
buckets or Range requests — is listed in full in
[`scripts/dev-stack/README.md`](scripts/dev-stack/README.md#what-this-harness-does-not-reproduce).
**A passing local run is not a passing hosted run.**

It drops and recreates its databases on every start, so it refuses to talk to
anything but a loopback `PGHOST`.

### Tests

| Command | What it proves |
|---|---|
| `npm run typecheck` | Both TypeScript programs: the app, and `tsconfig.harness.json` (the harness, the Playwright specs, the unit tests). |
| `npm run lint` | ESLint. |
| `npm test` | Vitest: the ranking rules, the date helper, the assist provider against a stubbed transport, the schemas. |
| `npm run db:verify [dbname]` | The Docker-free database check: drops and recreates a database on local Postgres, applies `supabase/tests/shim.sql` (the Supabase pieces a plain Postgres lacks: the `auth` and `storage` schemas, `auth.uid()`, the roles and default grants), every migration in order, then every `supabase/tests/*.test.sql`. Exits non-zero on the first failure. |
| `npm run e2e` | Playwright, against the real app and the harness. `e2e/m9-week.spec.ts` is the whole week — capture to thumbnail swap — once with a mouse and keyboard at 1440×900 and once by touch at 390×844, with a screenshot of every step under `test-results/m9-week/`. It starts **both** servers itself and refuses to run if a stack is already up — a stack left over from an earlier session is a database built from earlier migrations, and a run against it fails in ways that look exactly like regressions. `npm run dev:stack:stop` clears one; `E2E_REUSE=1` reuses both on purpose. A `next dev` already running in the directory also blocks it (Next allows one per directory), and the suite says so in one sentence. |
| `npm run e2e:refresh` | The session-refresh spec on its own ports and database with a five-second access token, the only way to watch `proxy.ts` rotate a session. |

The suite sets `ASSIST_PROVIDER=fake`, so it never spends money or depends on a
third party.

**A full run loses about one spec to `next dev` itself.** The development
server's memory grows by about 20 MB per page pair (the production build's
does not; `docs/MILESTONES.md`, "M9 — Integration", has the measurement).
Around two thirds of the way through a full run, Next restarts itself at its
heap threshold, and the spec that is mid-navigation at that moment fails a
60-second `page.goto`. The server log says *"Server is approaching the used
memory threshold, restarting…"* just above it. Re-run that spec. The lasting
fix is to run the suite against `next build && next start`, which has not been
done. Playwright is pointed at the Chromium in `/opt/pw-browsers`
through `executablePath`; do not run `playwright install` in that environment.

Other scripts: `npm run seed:demo` (see [Deploying](#deploying)),
`npm run db:types` (regenerates `lib/database.types.ts`; the Supabase CLI
shells out to Docker for this, so the committed file was written by hand and
checked column by column against a built database), and
`npm run dev:stack:smoke` (drives a running harness with supabase-js).

## Environment variables

`.env.example` lists every name with an empty value; `.env.local` is gitignored
and is the only place real values belong. No value is written down anywhere in
this repository.

| Variable | Read by | Where it goes | What it is |
|---|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | the app | `.env.local`, Vercel | The project URL. Public by design. |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | the app | `.env.local`, Vercel | The anon/publishable key. Public by design: RLS is what protects the data. |
| `ANTHROPIC_API_KEY` | `lib/assist/anthropic.ts` only | Vercel (server-side), optionally `.env.local` | **Secret.** Never with a `NEXT_PUBLIC_` prefix — that prefix inlines a value into the browser bundle. |
| `ANTHROPIC_MODEL` | `lib/assist/anthropic.ts` | Vercel, optional | Overrides the pinned model id (`claude-opus-5`). |
| `ASSIST_PROVIDER` | `app/actions/assist.ts` | **Unset in production** | `fake` forces the built-in fixtures. See the table below. |
| `ASSIST_FAKE_SCENARIO` | `lib/assist/fake.ts` only | dev and tests only | Makes the fixtures fail in a named way, to walk the error paths. |
| `SUPABASE_SERVICE_ROLE_KEY` | `scripts/` only, never the app | a local shell, never Vercel | **Secret.** Used by `scripts/seed-demo.ts`. |
| `SEED_EMAIL`, `SEED_PASSWORD` | `scripts/` only | a local shell | The account `seed-demo.ts` creates, and the harness's login. |
| `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `NERTUBE_DB_URL` | `scripts/` only | a local shell | The local Postgres the harness and `db:verify` use (loopback only). |
| `E2E_REUSE`, `E2E_PORT`, `DEV_STACK_*` | Playwright and the harness | a local shell | Test plumbing; `scripts/dev-stack/README.md` has the full table. |

With no Supabase variables at all, the proxy answers every page with a readable
503 setup page instead of an unexplained 500.

### Which assist implementation answers

The suggestions are one feature behind one interface, `AssistProvider` in
`lib/assist/types.ts`. `lib/assist/anthropic.ts` calls Claude;
`lib/assist/fake.ts` returns deterministic fixtures with no network. The rule is
one pure function, `selectAssistProvider` in `lib/assist/select.ts`, with a unit
test per row:

| `ASSIST_PROVIDER` | key present | `NODE_ENV` | answers |
|---|---|---|---|
| `fake` | either | any | the fixtures |
| anything else non-empty | either | any | Claude |
| unset | yes | any | Claude |
| unset | no | `production` | Claude — and the panel says "no API key configured" |
| unset | no | anything else | the fixtures |

A production deployment with no key deliberately does **not** fall back: the
fixtures return plausible titles with plausible reasons, and a deployment where
the key was never pasted would let you believe a model wrote them. Wherever the
fixtures do answer, every panel says so on every answer, and which
implementation answered is stored with the result, so a panel reopened tomorrow
makes the same admission. `npm run build` followed by a grep of `.next/static`
for `ANTHROPIC_API_KEY`, `api.anthropic.com` and `x-api-key` finds nothing.

## Where writes happen

**The browser Supabase client does uploads and reads only.** Thumbnail images
and concept sketches go straight from the browser to Supabase Storage — which
keeps them clear of Vercel's 4.5 MB request body limit — and signed URLs are
read back for display.

**Every database write goes through a server action or a `security definer`
function.** No component writes to a table with the browser client. That is
what makes the invariants enforceable rather than conventional:

- `move_video()` and `swap_thumbnail()` are the only writers of `stage_id`,
  `stage_entered_at`, `published_at` and `shipped_role`, whose UPDATE privilege
  is revoked from the `authenticated` role.
- INSERT on `videos` and on `channels` is revoked outright, so `capture_video()`
  (always into the Idea stage — never past the gate) and `create_channel()`
  (the channel with its stages, templates and buckets, all or nothing) are the
  only ways either comes into existence.
- `stages.kind`, `position` and `is_enabled` are written only by the settings
  functions, which is what lets "a core stage cannot be deleted" and "a stage
  holding videos cannot be switched off" hold against a forged request.
- `thumbnail_swaps` has no client UPDATE or DELETE (it is an append-only log),
  and TRUNCATE — which RLS does not govern — is revoked on every table.

Storage has one private bucket, `thumbnails`, with stable object paths
(`{user_id}/{video_id}/{concept|wild_card|moderate|safe}.{ext}`, uploaded with
`upsert`), an owner-only policy, a 5 MB limit and an image-types allow-list
(`0006_append_only_and_bucket_limits.sql`).

### Authentication

Email and password, one user, no sign-up screen. `proxy.ts` (Next 16's renamed
middleware) refreshes the session on every request, including `/login`, and
sends anyone signed out to `/login?next=<path>`; `?next=` is reduced to a path on
this site by `lib/safe-path.ts`. Every guard uses `supabase.auth.getUser()`,
never `getSession()`. `cookies()` is async in Next 16 and is always awaited.

## Deploying

This has **never been done** from the environment NerTube was built in: it has
no Supabase or Vercel credentials and no egress to either. The steps below are
the runbook for someone who has the accounts; see
[Honest limits](#honest-limits) for what that means.

1. **Create a Supabase project.** From *Project Settings → API* take the
   project URL, the anon key and the service-role key. The service-role key
   stays in your shell; it never goes to Vercel.
2. **Push the schema.** `npx supabase login`, `npx supabase link --project-ref
   <ref>`, `npx supabase db push`. That applies `0001` to `0009`: every table,
   policy, revoke and function, and the private `thumbnails` bucket with its
   policy and limits. `npx supabase migration list` should show all nine
   remotely.
3. **Create the one user** in the dashboard (Authentication → Users → *Add
   user*, auto-confirm), then turn sign-ups off (Authentication → Sign In /
   Providers → *Allow new users to sign up*). `supabase/config.toml` covers the
   local stack only; the hosted switch is a dashboard setting.
   (`npm run seed:demo` can create the user *and* a two-channel demo fixture
   through `auth.admin.createUser`; it has never been run, because the harness
   has no admin API. Skip it if you do not want demo rows in real data.)
4. **Optionally regenerate the types** against the project:
   `NERTUBE_DB_URL=<connection string> npm run db:types`, then
   `npm run typecheck`.
5. **Deploy to Vercel** with `NEXT_PUBLIC_SUPABASE_URL`,
   `NEXT_PUBLIC_SUPABASE_ANON_KEY` and `ANTHROPIC_API_KEY` set for production
   (and preview, if you want previews to work). Leave `ASSIST_PROVIDER` unset.
   The build fetches the four fonts from Google Fonts, so the build machine
   needs that egress.
6. **Walk it.** Sign in; create a channel; capture an idea from a phone at
   `/capture`; drag it; refresh. Upload a concept sketch and confirm one object
   at the stable path. Curl the REST endpoint with the anon key and confirm zero
   rows. Then the assist, in this order: that a brainstorm returns at all; that
   the outgoing request carries `effort: "medium"`, both `anthropic-beta` flags
   and `fallbacks: "default"`; that a refusal arrives as the panel's sentence
   rather than a crash; and that two opposite voice guides produce genuinely
   different titles.

## Honest limits

This section is meant to be complete rather than flattering. Where a limit was
recorded in `docs/MILESTONES.md`, the milestone is named so the reasoning can be
found.

### Out of scope for v1, by design

- **No YouTube API.** Nothing is uploaded or scheduled through YouTube. The
  Scheduled stage means *you* scheduled it in YouTube Studio; "Confirm live"
  means you paste the URL.
- **No analytics dashboard, outlier research or SEO tooling.** The only
  numbers the app holds are the ones you type in the first 24 hours.
- **No teams.** One user per deployment. `user_id` is on every table, bound
  into every foreign key and every RLS policy, so a second tenant is a schema
  that is ready — but there is no sharing, no roles, no invitations and no
  sign-up flow.

### Never proven from here

- **It has never been deployed.** No hosted Supabase project, no Vercel
  deployment, no upload to a hosted bucket (M1's one unfinished acceptance
  item). Every result in this repository is against the local harness, which
  approximates GoTrue and Storage.
- **No request has ever been sent to Anthropic.** There is no key in the build
  environment and egress is blocked. The real provider is verified by reading
  the installed SDK's types and asserting on the request it builds against a
  stub (M8). Whether the model id is live, the beta headers current, the
  latency inside the 60-second budget, what a critique of three images costs,
  and whether a voice guide really changes the model's output are all unknown
  until a key exists in Vercel.
- **`supabase start` has never run** (no Docker), and `supabase/config.toml` was
  added in M9. `scripts/seed-demo.ts` has never run (the harness has no admin
  API). `lib/database.types.ts` is hand-written.
- **No real phone and no touchscreen.** Every phone measurement is Chromium at a
  phone-sized viewport. `e2e/m9-week.spec.ts` walks the whole week at 390×844
  as an emulated touch device (`hasTouch`, `isMobile`, so `pointer: coarse` is
  true and every press is a tap), and the rest of the suite uses a mouse. The
  on-screen keyboard is simulated by a short viewport; iOS Safari's own
  behaviour (the visual viewport, zoom on focus) has not been seen on a device
  (M9).
- **The error page's "You're offline" sentence and `app/global-error.tsx`**
  are exercised by no spec; `app/error.tsx` is proved with an induced read
  failure, not a dropped connection (M9).
- **The YouTube preview's geometry is transcribed, not measured** against a
  live YouTube page (no egress to youtube.com). Every number carries a comment
  saying what it represents, so checking them is a reading exercise (M3).
- **No real non-US keyboard.** The AltGr case for `[`/`]` is proved with a
  synthetic event (M9).

### In the brief, and not built

- **The script cannot be edited in the app.** The Script section shows what
  `move_video()` wrote on first entry to Scripting — the channel's template with
  the chosen hook spliced in — and says it is read-only. `script` has no save
  path, and a textarea over a column that cannot be saved would lose an
  evening's work silently (M3, M8). The brief's per-video "chosen structure"
  and "end-screen target" fields exist as columns (`script_structure`,
  `end_screen_target`) with no UI at all; the structure is a line in the
  template instead.
- **The one-line hook is set at capture and never again.** It shows in the bank
  but the video page has no field for it.
- **Description, chapters, end screen and tags for YouTube are checklist items,
  not fields.** Publish Prep's checklist reminds you to do them; the app holds
  none of them.
- **A thumbnail variant has no note of its own.** The brief's "each with a
  note" became the role's fixed description plus the swap reason (M4).
- **The calendar does not colour target dates per channel.** PLAN.md's route
  table asks for it; the design system reserves colour for state, so each
  chip carries its channel as a text tag instead (M6).

### Things it does, with a catch

- **"Today" is the UTC day, everywhere** — on the calendar, the board's dates,
  `/now`'s go-live check. Far enough west, the calendar's today turns over hours
  before yours. There is no timezone setting; it was deferred from M6 to M7 to
  M9 and is still open, because the fix is a per-user profile that does not
  exist.
- **Ages on `/now` are frozen for the life of the page.** Leave it open
  overnight and it still says "3 days"; a reload is the refresh (M3).
- **Two tabs do not merge.** Every save carries the version it was made
  against; a stale tab is refused with "this video changed somewhere else" and a
  Reload, rather than overwriting. Nothing is lost silently, but the second
  person retypes (M2).
- **Nothing can be deleted, only archived.** Channels cannot be removed at all
  (PLAN.md gives them no delete policy). An archived idea is listed under the
  bank's "Show archived"; **an archived video past the Idea stage is on no list
  anywhere** — its page still works by its address, and that is the only way
  back to it. Archive has no undo after a reload other than Restore.
- **A shipped thumbnail cannot be un-shipped**, only swapped for another
  variant (M4).
- **"Confirm live" is two writes, not one transaction.** If the move fails after
  the URL is saved, the page says so in those words; a second press finishes it
  (M4).
- **The board and the calendar are desktop views.** On a phone the board's
  strip scrolls sideways and the card arrows work; nothing drags. The calendar
  shows a date and a chip per day at 390px and says so (M9).
- **An existing idea is filed on its own page, not in the matrix.** The
  matrix's empty cells capture a *new* idea straight into that cell; an idea
  captured without its pillar and format is filed from the Packaging tab of its
  video page (the Filing block, below the packaging fields). The bank row and
  the matrix's "not on the grid" line say it is unfiled and cannot fix it in
  place (M5). The week walk in M9 found this the longest detour of the week.
- **Checklist items do not tick themselves.** Publish Prep's "3 thumbnail
  variants ready" stays unticked when the three are uploaded, and Published's
  "Check first 24h" stays unticked when the numbers are logged — so the Publish
  tab can read 1/2 while its checklist reads 0/2. Auto-ticking was left out of
  v1 on purpose (PLAN.md review item 21): a checklist is the person's own
  record, and a tick the app wrote would be one they did not make.
- **Capture's tag box does not suggest tags**; it is the comma-separated box,
  deliberately, on the fastest path in the product. The video page's tag
  editor does suggest (M5).
- **A calendar day holding one or two videos has no link to its day panel**;
  its chips link to the videos. The panel is reachable for every day by
  `?day=` (M6).
- **Reordering is read-then-write.** Stages, template items and buckets are
  reordered by reading the rows and writing them back; a row removed in another
  tab in between can be re-inserted. One user, one session (M7).
- **The Repurposed switch on a video page is pre-disabled when the lane holds
  videos**, where the stage editor in Settings leaves its switch live and lets
  the database refuse. Same rule, same sentence, two behaviours (M7).
- **On a phone, some views are usable rather than comfortable.** `/now` and
  `/capture` were designed for 390px (M9). Elsewhere: the matrix shows two of
  its eight format columns at a time and scrolls sideways inside itself; the
  video page's Packaging tab is long, with Filing and the YouTube preview below
  every packaging field; an assist panel opens below the button that asked for
  it, partly under the fold; the 24-hour form's "New viewers" field sits below
  its save button. None of these scrolls the page sideways or hides a control.
- **The first click on a freshly loaded video page can be swallowed** while it
  hydrates — it is the heaviest page, with five sections and three assist
  panels mounted. The remedy on record is to make the sections lighter, not to
  unmount the hidden ones, which would trade a lost click for a lost draft (M4,
  M8).
- **The critique is the most expensive call in the app** (three images plus
  a prompt) and nothing on screen shows what a call costs (M8).
- **The assist has no spending ceiling.** It refuses the same question twice at
  once, per server instance, but there is no per-hour or per-day cap, and
  closing a panel stops the waiting, not the call, which runs to completion and
  is billed (M8 review). Fine for one person paying their own bill; the first
  thing to add if there is ever a second user.
- **A signed-out save is recognised in some places, not all.** When a session
  ends mid-edit (signed out in another tab, a revoked refresh token), the video
  page's fields, capture, checklist ticks and `/now`'s rows say "You have been
  signed out", keep what was typed, and offer a sign-in in a new tab. Every
  other control — the board's moves, the bank's Promote and Archive, the
  settings editors, the filming-day dialogs, the thumbnail and assist
  controls — still says "Could not reach the server", and trying again will
  not work until you sign in (M9).
- **The error page has no sidebar.** When a page cannot read its data it is
  replaced by one panel with Try again and Go to Now; the shell is itself a
  database read, so it is not drawn there (M9).
- **Fonts are fetched from Google at build time.** A build machine without
  egress to `fonts.googleapis.com` fails the build rather than falling back.
- **Scale.** Every signed-in route pays for `/now`'s reads, because the
  sidebar's Now count is the same number as the page (M3). PostgREST caps a
  read at 1000 rows; every list pages past it, then counts and filters in
  memory. That is right for PLAN.md's sizing (one user,
  hundreds of videos) and would want server-side aggregation at tens of
  thousands.

### Unfinished, carried out of the milestones

- **Controls that are busy are `disabled`, not `aria-disabled`.** A disabled
  control leaves the tab order, so focus can jump while a save is in flight.
  M6's review deferred the application-wide change to M9; M9 did not make it.
  The application has about eighty `disabled` props in thirty-five files;
  each would need sorting into "busy for a moment" (which should become
  `aria-disabled` with a no-op handler) and "genuinely unavailable" (which
  should stay `disabled`), and nothing in this environment (no screen reader,
  no real keyboard user) could check the result. The harm is real but recoverable: focus drops to the page while
  a save is in flight, and Tab starts again from the top.
- **The add-a-stage and add-a-bucket forms are still two components.** M7's
  review offered to merge them in M9; they differ by a quota box and share a
  dozen lines, and M9 left them as two.
- **The `?` sheet cannot be opened by touch.** Its button is in the desktop
  sidebar; a phone with a hardware keyboard gets the keys without a visible way
  to learn them other than pressing `?` (M9).
- **No key moves a video from its own page.** `[`/`]` are the board's; on
  `/videos/<id>` the stage select is one Tab away (M9). Nothing is remappable.
- **Back does not undo a filter change in the bank.** The filters are in the
  address bar with `replaceState`, so a filtered bank can be linked, but six
  keystrokes are not six history entries (M5).
- **A Scheduled video with no target date produces no `/now` row.** There is no
  honest thing to say about it; it is still on the board with its days climbing
  (M3).
