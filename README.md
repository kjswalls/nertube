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
  the checklist for the current stage, the script editor (below), three
  thumbnail variants (wild card / moderate / safe) with a shipped role and
  a swap log, and the post-publish block (impressions and CTR always together,
  views, new viewers, "swap thumbnail?").
- **The script** (the video page's Script tab) — from Scripting onward, the
  script is a plain markdown textarea in the reading face that grows with the
  text and saves itself a moment after you stop typing (and on leaving the
  box, and before the page goes). Beside it: the chosen structure (listicle,
  3-part, story arc) and the named video the end screen points at. It starts
  as the channel's template with the chosen hook written in, which
  `move_video()` copies in on the first move into Scripting. **Reset from
  template** rebuilds it from the channel's current template and the hook
  chosen now — it says what it will replace and asks first, and Undo puts the
  old text back until you leave the page. Before Scripting the tab is locked
  and shows no editor: the title, thumbnail concept and hook come first.
- **Calendar** (`/calendar`) — target publish dates for every channel on one
  month, and filming days as their own kind of event. On a phone the month is
  a list of the days that hold something, with whole titles; tapping a date
  opens that day.
- **Settings** (`/settings/…`) — per channel: stages (rename, reorder within the
  core order, switch off, add your own), checklist templates with minute
  estimates, buckets and quotas, the voice guide, the script template, the WIP
  and stale thresholds, and the CTR the swap prompt measures against. For you:
  your **time zone** (`/settings/account`), below.
- **Your time zone** — "today" is your day. The calendar's today, the day
  `/now` offers "Confirm live" on, the board's batch-day date and the matrix's
  month all turn over at your local midnight, and published, swapped and
  captured dates are shown in your zone. It is saved to your account (so the
  phone and the laptop agree) and recorded from your browser the first time you
  sign in; Settings shows it with today's date there, and changes it from a list
  grouped by region. A second device in another zone offers its own zone rather
  than taking it. "Days in stage", waiting ages and the 24-hour metrics window
  are elapsed time, not calendar days, and do not depend on it.
- **The brainstorm** — one feature with four buttons on the video page:
  *Generate 20* (titles), *Draft hooks*, *Suggest concepts* and *Critique at
  tile size* (the three variants at feed size), conditioned on the channel's
  voice guide and past titles. Proposals, never edits: nothing lands in a field
  until it is accepted. (The code calls each button an "assist".)
- **Keys** — `?` on any page with the sidebar lists what works there (on a
  phone, "Keyboard shortcuts" in the menu opens the same list). `g` then a letter goes
  places, `j`/`k`/`Enter`/`Escape` work every list, `[`/`]` move a card, `x`
  does a `/now` row, `p` promotes an idea (in the bank and on the board).

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

Two things npm cannot install for you:

- **PostgreSQL 16** on `127.0.0.1:5432`, with a role that can create and drop
  databases and roles (the harness resets its databases on every start and
  creates `authenticator`, `anon` and `authenticated`). A local superuser with
  trust authentication is what it was built against; `PGUSER` and
  `PGPASSWORD` pick another.
- **PostgREST 12.2** as a `postgrest` binary on `PATH`: the release build for
  your platform from
  [github.com/PostgREST/postgrest/releases/tag/v12.2.12](https://github.com/PostgREST/postgrest/releases/tag/v12.2.12).
  It is not an npm package and not in stock apt. `npm run dev:stack` checks for
  it first and stops with one sentence if it is missing.

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
| `npm run e2e` | Playwright, against the real app — a production build (`next build && next start`) — and the harness. `e2e/m9-week.spec.ts` is the whole week — capture to thumbnail swap, with the script written and reset in the app and the time zone changed in Settings (M10) — once with a mouse and keyboard at 1440×900 and once by touch at 390×844, with a screenshot of every step under `test-results/m9-week/`. It starts **both** servers itself and refuses to run if a stack is already up — a stack left over from an earlier session is a database built from earlier migrations, and a run against it fails in ways that look exactly like regressions. `npm run dev:stack:stop` clears one; `E2E_REUSE=1` reuses both on purpose. |
| `npm run e2e:refresh` | The session-refresh spec on its own ports and database with a five-second access token, the only way to watch `proxy.ts` rotate a session. |

The suite sets `ASSIST_PROVIDER=fake`, so it never spends money or depends on a
third party.

**The suite runs against a production build.** Until the M9 review it ran
against `next dev`, whose memory grows by about 20 MB per page pair; around two
thirds of the way through a full run Next restarted itself at its heap
threshold and the spec loading at that moment failed, so no full run in M9's
integration pass exited 0. The production server's memory is flat
(`docs/MILESTONES.md`, "M9 — Integration", has the measurement). A full run
takes about twelve minutes. The build lands in `.next` with the harness's URL
and anon key inlined into the browser bundle, so after a run, `npm run build`
again before `npm start` serves anything else. `npm run dev` is unaffected: it
writes to `.next/dev`. Playwright is pointed at the Chromium in
`/opt/pw-browsers` through `executablePath`; do not run `playwright install` in
that environment.

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
| `NERTUBE_TEST_CLOCK` | `lib/request-clock.ts` | **Unset everywhere but the browser suite** | `1` lets a request's `nertube-test-clock` cookie set the server's "now", so `e2e/timezone.spec.ts` can stand at an hour when two zones disagree about the date. Only `playwright.config.ts` sets it. |

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
- `profiles` (one row per user: the time zone) is readable by its owner and
  written only by `set_time_zone()`, which refuses a name the database's tz
  catalogue does not know and never lets a detected zone replace a chosen one.

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
   <ref>`, `npx supabase db push`. That applies `0001` to `0010`: every table,
   policy, revoke and function, the private `thumbnails` bucket with its
   policy and limits, and (0010) the per-user `profiles` row that holds the
   time zone. `npx supabase migration list` should show all ten remotely.
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

- **It is deployed, but nothing here was tested against the deployment.** There
  is a hosted Supabase project and a Vercel project, both created by hand on
  17 September. Migrations 0001–0009 were applied to the hosted database, one
  at a time, through Supabase's management API (the MCP connector), and each
  was read back afterwards. **`0010_time_zone.sql` (M10) has not been applied
  there.** Until it is, a deployed M10 build runs as M9 did as far as dates
  go: every page reads no zone, draws in UTC and says so, and saving a zone in
  Settings is refused with a sentence. But no test in this repository has run
  against either one:
  - no spec has signed in to the live site;
  - no upload has gone to a hosted bucket (M1's one unfinished acceptance
    item);
  - the SQL suite in `supabase/tests/` has never run against the hosted
    database.

  Every result in this repository is against the local harness, which only
  approximates GoTrue and Storage.
- **The deployment has to track this branch.** Migrations 0007–0009 take back
  table grants that earlier code wrote through directly: stage and channel
  columns, `archived_at` and `brainstorm_last` on videos. Those writes now go
  through database functions. If Vercel builds an older commit, the current
  database will refuse that build's archive, restore, saved brainstorm
  results and most settings edits.
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
- **The SQL tests have never run on Postgres 17.** The hosted database is
  17.6, and 0001–0009 applied to it cleanly; 0010 has not been tried there. `supabase/config.toml`
  pins `major_version = 17` to match. `supabase/tests/` has only ever run on
  PostgreSQL 16 (16.15, the harness's version). Nothing in the tests is known to
  behave differently on 17, but nothing has checked.
- **No real phone and no touchscreen.** Every phone measurement is Chromium at a
  phone-sized viewport. `e2e/m9-week.spec.ts` walks the whole week at 390×844
  as an emulated touch device (`hasTouch`, `isMobile`, so `pointer: coarse` is
  true and every press is a tap), `e2e/phone.spec.ts` measures every route that
  way (M10), and the rest of the suite uses a mouse. The
  on-screen keyboard is simulated by a short viewport; iOS Safari's own
  behaviour (the visual viewport, zoom on focus) has not been seen on a device
  (M9). Every text field the M9 review found under 16px — the bank's search
  and filters, the settings rows and add forms, the new-channel name — is 16px
  below 768px now, which is what should stop that zoom. The Script tab's
  editor was measured the same way (M10): at 390×420, standing in for the
  keyboard, the line being typed and the sticky save line both stay on
  screen. iOS Safari pans the visual viewport under its keyboard instead of
  shrinking the page, and whether a sticky toolbar stays in sight there is
  unseen.
- **The error page's "You're offline" sentence and `app/global-error.tsx`**
  are exercised by no spec; `app/error.tsx` is proved with an induced read
  failure, not a dropped connection (M9).
- **The YouTube preview's geometry is transcribed, not measured** against a
  live YouTube page (no egress to youtube.com). Every number carries a comment
  saying what it represents, so checking them is a reading exercise (M3).
- **No real non-US keyboard.** The AltGr case for `[`/`]` is proved with a
  synthetic event (M9).

### In the brief, and not built

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

- **A session signed in before the time zone existed draws one page in UTC.**
  Sign-in records the browser's zone, so a new sign-in never sees it; a session
  that was already open when M10 was deployed has no zone yet, so its first page
  is in UTC and says so ("Dates here follow UTC until your time zone is set"),
  records the browser's zone, and redraws once (M10).
- **Pre-M10 "Confirm live" dates are re-read once.** Before M10 a confirmed
  video's `published_at` was its target date at midnight UTC. The first time
  your zone is recorded, every such stamp (exactly a UTC midnight) is moved to
  the same date's midnight in your zone, so it still shows on its target date.
  Changing the zone later moves nothing: those are instants now, and a video
  published at your midnight in Auckland shows as the previous day if you
  switch to Los Angeles (M10).
- **The zone list is Node's.** The picker lists the 419 zones the server's
  `Intl` knows, under their current IANA names (Node spells 18 of them the old
  way, `Asia/Calcutta`, and the app stores `Asia/Kolkata`). A name the
  database's tz catalogue does not know is refused with a sentence rather than
  stored. All 419 are in the harness's PostgreSQL 16 catalogue; the hosted
  17.6 catalogue has not been read (M10).
- **The script is written from Scripting on, not before.** An idea or a
  Packaging video has no script box, and `updateVideo` refuses the column
  there too (the rule is the app's: the column is in the client's UPDATE
  grant, so a hand-made request with a session token could still write it)
  — BRIEF.md's first principle, and the gate skip is the one
  deliberate way to script early. A video moved back to Packaging keeps its
  script, read-only, until it comes forward (M10). A video in a stage you
  added yourself (which has no place in the order) can be scripted.
- **Reset's Undo lasts as long as the page.** The text it replaced is held in
  the page, not stored; leave or reload and Reset cannot be undone. A reset
  is also only as current as the save behind it: in two tabs, the second
  tab's reset is refused like any other stale save (M10).
- **A script save is a whole-page refresh.** The script saves after a
  1.2-second pause in typing, through the same action as every other field,
  and that action refreshes the video page on the server, so a long evening
  of writing is a few hundred page renders. Nothing visible happens; on a
  slow phone connection it is more data than the words themselves (M10).
- **Ages on `/now` are frozen for the life of the page.** Leave it open
  overnight and it still says "3 days"; a reload is the refresh (M3).
- **Two tabs do not merge.** Every save carries the version it was made
  against; a stale tab is refused with "this video changed somewhere else" and a
  Reload, rather than overwriting. Nothing is lost silently, but the second
  person retypes (M2).
- **Videos cannot be deleted, only archived; channels cannot be removed at
  all** (PLAN.md gives them no delete policy). Smaller things can be deleted:
  a filming day, a video's checklist item, a template item, a bucket and a
  stage you added yourself. An archived idea is listed under the
  bank's "Show archived"; **an archived video past the Idea stage is on no list
  anywhere** — its page still works by its address, and that is the only way
  back to it. Archive has no undo after a reload other than Restore.
- **A shipped thumbnail cannot be un-shipped**, only swapped for another
  variant (M4).
- **"Confirm live" is two writes, not one transaction.** If the move fails after
  the URL is saved, the page says so in those words; a second press finishes it
  (M4).
- **On a phone the board is one column at a time, and nothing drags.** Below
  768px a column is nearly the screen's width and a row of stage buttons
  (each with its count) jumps between them; the card arrows move a video on.
  Drag and drop needs a mouse. The weekly strip above the row repeats the
  counts, with the ages (M10).
- **On a phone the calendar is a list, not a grid.** Below 768px the month is
  the days that hold something (plus today), one row each, with whole titles.
  An empty day is not listed, so opening one takes "Schedule a filming day" or
  the `?day=` address; the grid, and the weekday columns, are the desktop's
  (M10).
- **An existing idea is filed on its own page, not in the matrix.** The
  matrix's empty cells capture a *new* idea straight into that cell; an idea
  captured without its pillar and format is filed from the Packaging tab of its
  video page (the Filing block, below the packaging fields; on a phone a link
  at the top of the tab jumps to it). The bank row and
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
- **On a desktop, a calendar day holding one or two videos has no link to its
  day panel**; its chips link to the videos. The panel is reachable for every
  day by `?day=` (M6). On a phone every listed day's date opens it (M10).
- **Reordering is read-then-write.** Stages, template items and buckets are
  reordered by reading the rows and writing them back; a row removed in another
  tab in between can be re-inserted. One user, one session (M7).
- **The Repurposed switch on a video page is pre-disabled when the lane holds
  videos**, where the stage editor in Settings leaves its switch live and lets
  the database refuse. Same rule, same sentence, two behaviours (M7).
- **On a phone, a few things are still a scroll away.** Every route was walked
  at 390×844 by touch in M10. What remains: the matrix shows four of its eight
  formats at a time (the pillar column stays put while they scroll sideways
  inside the grid); the video page's Packaging tab is long, with two links at
  its top to Filing and the YouTube preview; its five section tabs wrap to two
  lines; a checklist template item in Settings is a one-line field, so a long
  one scrolls inside its box. On the Script tab the script itself starts about
  630px down, under the checklist strip, Structure and "End screen points
  at", so the first thing a phone shows of a script is its first two lines;
  and a new bullet in the Body is written by tapping between the template's
  empty `-` lines, which is fiddly by thumb (the M10 week walk). Nothing
  scrolls the page sideways at 320, 360 or 390.
- **Tap targets are 44px under a thumb, with two exceptions.** On a
  phone-width screen or a coarse pointer, every control on the page of every
  route and in the open menu — the buttons, links, tabs, fields and checkbox
  labels `e2e/phone.spec.ts` measures on twenty routes, the Script tab and
  Settings → Time zone among them — is at least 44px tall (M10). Of the
  dialogs, the week walk measures the script reset's two buttons; the others
  (schedule a filming day, swap a thumbnail, the keyboard sheet's contents)
  were not measured, apart from the sheet's Close.
  The exceptions are M9's: `/now`'s
  links from a row to somewhere else (the video, the channel) are 24px, WCAG
  2.5.8's floor for a target that is not the row's own control, and a link
  inside a sentence is the size of its text. With a mouse on a desktop the
  density is M3's. None of it was seen on a real phone.
- **A checklist item you add to one video has no estimate.** Items added on a
  video's own checklist are stored with no minutes, and nothing in the app sets
  them afterwards (M3 left per-item estimates to M7, which built the template
  editor only). The 10-minute filter on `/now` counts such an item as ten
  minutes, so it always passes the filter however long the task is. It prints
  no minutes (a dash on the video page's list), because the mono face is for a
  measured number.
- **A quick run through a checklist stacks its toasts.** Nine `x` presses on
  `/now` make nine "Ticked: …" messages; three show at once and each clears
  itself after six seconds (M9 week walk).
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
- **The settings screens are wordier than the rest of the tool.** The M9
  review counted 282–470 words of help on each settings screen, and 639 on a
  video's Packaging tab, which stated one rule (the sketch is not the concept)
  four times. The Packaging tab had its repeats and its longest help cut (the
  rule is now said at the concept field and in the gate line); the four
  settings screens did not get the same editing pass,
  and still read more like documentation than a tool.
- **The add-a-stage and add-a-bucket forms are still two components.** M7's
  review offered to merge them in M9; they differ by a quota box and share a
  dozen lines, and M9 left them as two.
- **No key moves a video from its own page.** `[`/`]` are the board's. On
  `/videos/<id>` the stage select is in the Schedule section: the section tabs,
  then three Tabs. An arrow key on it chooses a stage and Enter (or the Move
  button beside it) makes the move; it does not move on the arrow (M9 review).
  Nothing is remappable.
- **No keys on the calendar, the matrix or settings** beyond the
  application's own (`g`, `1`–`9`, `c`, `?`), and `/capture` has none but the
  form's (M9).
- **One browser-suite failure from M9 was never explained.**
  `e2e/board.m1.spec.ts:513` (drag an idea into Packaging) failed once in M9's
  integration pass: the server answered the move with 200 and the card landed
  in neither column. Its trace was lost; it did not recur in 52 repeats of
  that file then, nor in any full run since. It is recorded as unexplained
  rather than as a flake (`docs/MILESTONES.md`, "M9 — Integration").
- **Back does not undo a filter change in the bank.** The filters are in the
  address bar with `replaceState`, so a filtered bank can be linked, but six
  keystrokes are not six history entries (M5).
- **A Scheduled video with no target date produces no `/now` row.** There is no
  honest thing to say about it; it is still on the board with its days climbing
  (M3).
