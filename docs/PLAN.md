# NerTube v1 — plan (rev. 2, post-review)

Source of truth: `/home/user/nertube/docs/BRIEF.md`. Solo dev, evenings, single user, two channels.

## Summary

### Judging (1–5 each; fidelity / simplicity / model concreteness / milestone realism / open-question arguments)

| Draft | Fid | Simp | Model | Milest | OQs | Total | Note |
|---|---|---|---|---|---|---|---|
| data-model | 5 | 3 | 5 | 4 | 4 | 21 | Best constraints. Over-built: triggers, view, extra tables, dnd-kit. |
| workflow-ux | 4.5 | 4.5 | 4 | 4.5 | 4 | **21.5** | Best `/now` (sections, tick-in-place, `waiting_on`, `est_minutes`), best skip mechanic. |
| risk-simplicity | 4 | 5 | 4 | 4.5 | 4.5 | 21 | Best dependency discipline and risk-first order. Hard gate with no override; no `waiting_on`. |

**Spine: workflow-ux** (it models the creator's week; "what can I move right now" is half the product). Grafted in: risk-simplicity's dependency ceiling, jsonb candidates/hooks, single write path, risk-first order; data-model's constraints (partial uniques, CHECKs, composite FKs, storage policy).

### What the app is
One `videos` table; an idea is a video in the Idea stage. A per-channel `stages` table whose rows carry a fixed `kind` that code branches on. A kanban with one hard gate (into any stage after Packaging requires title + thumbnail concept + one chosen hook, evaluated from the fields at move time, or an explicit skip with a typed reason and a badge). A `/now` page that derives the smallest next action per in-flight video, sorted by staleness, completable in place. Everything else is fields on the detail page.

## Stack

As specified: Next.js App Router + TypeScript, Supabase (Postgres, auth, storage), Tailwind, Vercel, Anthropic API server-side only. No disagreement with the brief.

Runtime deps beyond `create-next-app`: `@supabase/supabase-js`, `@supabase/ssr`, `@anthropic-ai/sdk`, `zod`. Dev-only: `vitest` (unit tests for `nextAction()`), `tsx` (seed script). Nothing else: no DnD lib (native HTML5 + keyboard), no markdown renderer (textarea; "rich text/markdown" is read as *markdown text*), no hotkeys/form/date/state lib, no ORM (`supabase gen types`).

Warnings the brief does not mention:
1. Vercel's 4.5 MB body limit — images upload browser → Storage directly; the server action only records the path.
2. Brainstorm can take 10–40 s — `export const maxDuration = 60` on the hosting segment.
3. Auth is email + password; signups disabled after the one user exists (dashboard + `[auth] enable_signup = false` in `supabase/config.toml`).
4. Next 16: session refresh lives in root `proxy.ts` (the renamed middleware); `cookies()` is async; the server client's `setAll` must be wrapped in try/catch (server components cannot write cookies); every server-side guard uses `supabase.auth.getUser()`, never `getSession()`.
5. Local dev on the Supabase CLI Docker stack so RLS, storage policies and the SQL functions are exercised before production.
6. `user_id default auth.uid()` is null under the service role — the seed script creates the user with `auth.admin.createUser` and passes its id explicitly.

Layout: `app/` (routes), `app/actions/*.ts` (all mutations as server actions), `proxy.ts` + `lib/supabase/{server,client,proxy}.ts`, `lib/defaults.ts` (`CORE_KIND_ORDER`, seed stages, checklists with `est_minutes`, buckets, script template), `lib/next-action.ts` (pure), `lib/brainstorm/{types,anthropic}.ts`, `supabase/migrations/0001_init.sql`, `scripts/seed-demo.ts`. The browser client is used only for storage uploads and reads; every DB write goes through a server action (README states this).

## Data model

Common to every table: `id uuid pk default gen_random_uuid()`, `user_id uuid not null default auth.uid() references auth.users`, `created_at timestamptz not null default now()`. Enumerations are `text` + `check`. Only constraint-backed indexes in `0001_init.sql` (uniques, composite-FK targets); add a secondary index only when a query is measurably slow — one user, hundreds of rows.

**Tenant binding.** FK checks bypass RLS, so a plain `user_id` policy would let a second tenant occupy another tenant's unique slots (e.g. insert a `checklist_items` row against someone else's video). Every parent therefore has `unique (id, user_id)` and every child FK is composite on the tenant column: `(video_id, user_id) references videos (id, user_id)`, `(channel_id, user_id) references channels (id, user_id)`, `(stage_id, user_id) references stages (id, user_id)`. Policies stay identical and join-free.

**RLS.** Enabled on every table. Default: `for all using (user_id = auth.uid()) with check (user_id = auth.uid())`. Two exceptions: `stages` gets a separate `for delete using (user_id = auth.uid() and kind is null)` (core stages cannot be deleted from any client); `channels` has no delete policy in v1. Column privileges: `revoke update (stage_id, stage_entered_at, published_at, shipped_role) on videos from authenticated` — those columns are written only by the SQL functions below.

**channels** — `name text not null`, `slug text not null`, `voice_guide text`, `script_template text not null` (seeded, contains a `{{hook}}` placeholder), `wip_threshold int not null default 5`, `stale_days int not null default 7`, `expected_ctr numeric(5,2) null`. `unique (user_id, slug)`, `unique (id, user_id)`.

**stages** — `channel_id`, `name text not null`, `position int not null`, `kind text null check (kind in ('idea','packaging','scripting','filming','editing','publish_prep','scheduled','published','repurposed'))`, `is_enabled bool not null default true`. Constraints: partial `unique (channel_id, kind) where kind is not null`; `unique (id, channel_id)` (composite-FK target); `unique (id, user_id)`; `unique (channel_id, position) deferrable initially deferred` (swaps run as one `update … set position = case …` statement). User-added stages have `kind = null` and are inert. Core stages may be renamed and disabled, never deleted; disabling one holding non-archived videos is refused. **Order of behaviour is `CORE_KIND_ORDER` in code, never `position`**: `position` is display order only, and settings refuse to move a core stage across another core stage (inert stages slot anywhere). No per-column WIP limit: the brief's "configurable WIP threshold" is `channels.wip_threshold`, applied only to `WIP_KINDS = packaging … scheduled`.

**buckets** — `channel_id`, `axis text check (axis in ('vertical','horizontal'))`, `name text not null`, `position int not null`, `monthly_quota int null check (monthly_quota > 0)`. `unique (channel_id, axis, name)`, `unique (channel_id, axis, position) deferrable initially deferred`, `unique (id, channel_id, axis)` (composite-FK target).

**videos** (ideas included) —
- `channel_id`, `stage_id`, `stage_entered_at timestamptz not null default now()`, `updated_at timestamptz`
- `foreign key (stage_id, channel_id) references stages (id, channel_id)` (`on delete no action`) — a video can never sit in another channel's column
- packaging:
  - `title text not null default ''`
  - `title_candidates jsonb not null default '[]'` (`[{id,text,note,chosen,source:'manual'|'ai'}]`)
  - `thumbnail_concept text`
  - `thumbnail_concept_path text`
  - `hooks jsonb not null default '[]'` (`[{id,text,chosen}]`)
  - `packaging_skipped_at timestamptz`, `packaging_skip_reason text`
  - CHECKs: `jsonb_typeof(title_candidates) = 'array'`; `jsonb_typeof(hooks) = 'array' and jsonb_array_length(hooks) <= 3`; `(packaging_skipped_at is null) = (packaging_skip_reason is null)`; `packaging_skip_reason <> ''`. zod additionally enforces ≤ 1 chosen per list.
  - No `packaging_locked_at`: the gate is the field predicate `gate_ok = title <> '' and thumbnail_concept <> '' and exactly one hook chosen`, evaluated at move time.
- scripting: `script text`, `script_structure text null check (in ('listicle','three_part','story_arc'))`, `end_screen_target text`. B-roll per section lives in the `B-roll:` lines of the script template (one home, not two).
- idea bank:
  - `one_line_hook text`
  - `notes text`
  - `tags text[] not null default '{}'`
  - `vertical_id uuid`, `horizontal_id uuid`
  - `vertical_axis text generated always as ('vertical') stored`, `horizontal_axis … ('horizontal')`
  - `foreign key (vertical_id, channel_id, vertical_axis) references buckets (id, channel_id, axis) on delete set null`, likewise horizontal — a video can only reference its own channel's bucket of the right axis.
- flow: `waiting_on text`, `filming_day_id uuid` (`(filming_day_id, user_id) references filming_days (id, user_id) on delete set null`), `target_publish_date date`, `archived_at timestamptz`
- thumbnails (three slots, not a list):
  - `thumb_wild_card_path text`
  - `thumb_moderate_path text`
  - `thumb_safe_path text`
  - `shipped_role text null check (in ('wild_card','moderate','safe'))`
  - `check (shipped_role is null or (shipped_role = 'wild_card' and thumb_wild_card_path is not null) or (shipped_role = 'moderate' and thumb_moderate_path is not null) or (shipped_role = 'safe' and thumb_safe_path is not null))` — the shipped role always has an asset.
- publish: `youtube_url text`, `published_at timestamptz`
- post-publish:
  - `first24_impressions int check (>= 0)`
  - `first24_ctr numeric(5,2) check (between 0 and 100)`
  - `first24_views int check (>= 0)`
  - `new_viewers_note text`
  - `metrics_logged_at timestamptz`
  - `swap_dismissed_at timestamptz`
  - `check ((first24_impressions is null) = (first24_ctr is null))` — CTR never exists without impressions
- `brainstorm_last jsonb` — the most recent brainstorm result, so closing the panel loses nothing
- `unique (id, user_id)`

**checklist_templates** — `stage_id` (composite to stages, cascade), `text text not null`, `position int not null`, `est_minutes int not null`. `unique (stage_id, position) deferrable initially deferred`. No `channel_id` (the stage implies it).

**checklist_items** — `video_id` (composite, cascade), `stage_id` (composite, no action), `text`, `position int not null`, `est_minutes int null` (null reads as 10), `checked_at timestamptz null`. Snapshot-copied from templates on first entry to a stage. `addChecklistItem` inserts at the top (`position = min - 1`), so a custom item is immediately the next action.

**thumbnail_swaps** (append-only) — `video_id` (composite, cascade), `from_role text null`, `to_role text not null`, `reason text not null check (reason <> '')`, `swapped_at timestamptz default now()`, `check (to_role in (…) and (from_role is null or from_role in (…)) and from_role is distinct from to_role)`.

**filming_days** — `on_date date not null`, `notes text`. User-level and cross-channel (one creator, one camera). `unique (user_id, on_date)`, `unique (id, user_id)`.

**Storage** — one private bucket `thumbnails`; stable object paths `{user_id}/{video_id}/{concept|wild_card|moderate|safe}.{ext}` uploaded with `upsert: true`, so re-upload replaces and nothing orphans. If the extension changes, the recording action removes the old object before updating the row. Policy on `storage.objects` for select/insert/update/delete: `bucket_id = 'thumbnails' and (storage.foldername(name))[1] = auth.uid()::text`. Server components batch `createSignedUrls(paths, 3600)`.

**Invariants live in two SQL functions, not triggers and not application code.** supabase-js has no transactions, so multi-row writes are plpgsql functions called via `supabase.rpc()` from server actions: `security definer`, `set search_path = public`, owned by `postgres`, first statement `select … where id = p_video and user_id = auth.uid()` (raise if none). With the column revoke above, they are the only write path for stage and shipped-role changes — enforced by the database, not by grep.
- `move_video(p_video uuid, p_stage uuid)`: refuses a stage in another channel or disabled; if target kind order > packaging and not `gate_ok` and not skipped → `raise exception 'gate:<missing field>'`; sets `stage_id`, `stage_entered_at = now()`; copies templates into `checklist_items` where none exist for `(video, stage)`; on first entry to kind `scripting` with `script is null`, sets `script = replace(channel.script_template, '{{hook}}', chosen hook)`; on first entry to kind `published`, sets `published_at = coalesce(p_published_at, now())`.
- `swap_thumbnail(p_video uuid, p_to_role text, p_reason text)`: inserts the `thumbnail_swaps` row (from = current `shipped_role`) and updates `shipped_role` atomically; the CHECK refuses a role without an asset.
Skip (`packaging_skipped_at` + reason) is a single-row update in `updateVideo` and needs no function.

## Routes / pages

| Route | Purpose |
|---|---|
| `/login` | email + password |
| `/` | no channel → `/c/new`; else → `/now` |
| `/now` | cross-channel next-action list; every row completable in place; filters |
| `/calendar` | month grid, all channels: target dates (colour per channel) + filming days; a filming day expands to its linked videos |
| `/c/[slug]/board` | kanban for one channel; header switcher |
| `/c/[slug]/ideas` | idea bank list (Idea-stage videos + hidden published), tag/bucket filter; `?view=matrix` verticals × horizontals with counts + quota progress; empty cell → capture prefilled |
| `/c/[slug]/settings` | stages, checklist templates, buckets + quotas, voice guide, script template, thresholds, expected CTR |
| `/videos/[id]` | detail: packaging block, current-stage checklist, script, thumbnails + swap log, dates/URL, notes, post-publish block |
| `/capture` | standalone quick-capture page (mobile bookmark); same form as the `c` modal |

No API route handlers. Server actions: `captureVideo, updateVideo, moveVideo, toggleChecklistItem, addChecklistItem, resetChecklist, recordUpload, shipThumbnail, swapThumbnail, dismissSwap, logMetrics, confirmLive, createFilmingDay, brainstorm, createChannel, updateStages, updateTemplates, updateBuckets`.

## Key UI behaviours

**Board.**
- Columns = enabled stages by `position`.
- Header: count; red when count > `channel.wip_threshold` for `WIP_KINDS` only (Idea, Published, Repurposed never warn).
- Idea column shows the 10 most recently updated ideas with "+K more in Ideas"; Published/Repurposed hide cards 30 days after `published_at` (still listed on `/ideas` and `/calendar`).
- Filming column badge when Filming count across **all** channels ≥ 3: "N in Filming — schedule batch day?" (text-only until M6; then creates a filming day and links those videos).
- Card: title, channel chip, target date, concept sketch thumb, `done/total` for the current stage, days in stage (amber when > `stale_days`), "TTH skipped" badge, `waiting_on` chip.
- Native HTML5 drag between columns; no intra-column ordering — cards sort by `target_publish_date asc nulls last`, then `stage_entered_at asc`.
- A refused drop snaps back with a toast naming the missing field, a "Fix packaging" link (detail scrolled to that field) and a "Skip gate…" link.

**Weekly-review strip** (board header, M3): per column count, oldest card's days in stage, median days in stage — all from `stage_entered_at`.

**TTH gate.** `gate_ok` is computed from the three fields at move time inside `move_video`; there is no lock button. The detail page shows a live "Packaging: ready / missing X" indicator. Skipping requires a typed reason, sets `packaging_skipped_at`, shows a permanent amber badge on the card, and puts "Complete packaging" at the top of `/now` for that video until `gate_ok` holds. One hard gate; Publish Prep → Scheduled with < 3 thumbnail paths is a soft warning only.

**"What can I move right now?" ranking** (`lib/next-action.ts`, pure, unit-tested). Input: non-archived videos in enabled stages, each with its kind, checklist items, channel expectation. Kind `idea` is skipped entirely (promotion is a deliberate act from the board or ideas list). Rules, first match wins; each emits `{label, section, input}` where `input ∈ tick | text | choice | metrics_pair | url | clear_waiting | swap | move`:
1. kind order > packaging and not `gate_ok` → "Complete packaging: <missing field>" (**Overdue**, `text`/`choice`)
2. kind `published`, `published_at + 24h` passed, `metrics_logged_at` null → "Log 24h impressions + CTR" (**Overdue**, `metrics_pair`)
3. kind `published`, metrics logged, `first24_ctr < expectation`, no swap after `metrics_logged_at`, `swap_dismissed_at` null → "Swap thumbnail? (X impr / Y% CTR)" (**Overdue**, `swap`; "keep it" sets `swap_dismissed_at`). `expectation = coalesce(channel.expected_ctr, median first24_ctr of the channel's last 10 published)`; none → rule skipped.
4. `waiting_on` set → **Waiting**, with age, `clear_waiting` ("Still waiting / Unblocked")
5. kind `scheduled`: `target_publish_date` in the future → **Waiting** "Goes live <date>"; on/after → "Confirm live + record URL" (**Ready**, `url`) → `confirmLive` = `move_video(published, p_published_at = target date)` + URL
6. first unchecked checklist item → its text + `est_minutes` (**Ready**, `tick`). Zero items is *not* "all checked".
7. kind `packaging`, checklist done, gate field missing → "Pick a working title" / "Write the thumbnail concept" / "Choose a hook" (**Ready**, `text`/`choice`) — after the checklist, so candidates are generated before a title is committed
8. checklist done (total > 0), a later enabled stage exists, gate passes → "Move to <next stage>" (**Ready**, `move`); terminal kinds emit nothing

Sort: Overdue → Ready → Waiting, then `now - stage_entered_at` desc. Filters: channel chips; "≤ 10 min" (uses `est_minutes`, null = 10; kinds `filming`/`editing` are tagged "needs a block" and hidden). Each row renders the control matching `input` (tick box, single-line input saving on Enter, hook chips, impressions + CTR pair with optional views, URL field, buttons); completing re-ranks that video only. Target: every row done in ≤ 2 interactions without leaving the page.

**Quick capture.** `c` anywhere opens a modal with one focused title input and a channel chip; Enter saves and closes; `1..9` retargets the channel before Enter; a "more" disclosure (or Shift+Enter) reveals hook, notes, tags, vertical, horizontal. Channel = route channel if any, else last-used (localStorage). `/capture` is the same form full-page. Saves into the channel's Idea stage. Promote = `p` on a card, or drag, or "Promote" on the ideas list.

**Post-publish.** One component renders impressions and CTR as a pair; `logMetrics` rejects one without the other. Once metrics are logged the "Swap thumbnail?" prompt always renders, coloured red when below expectation; it opens the swap dialog (role with an asset, reason required) → `swap_thumbnail`.

**Shortcuts** (one `useShortcuts` hook that ignores events from inputs): `c` capture · `g n/b/i/k` go to now/board/ideas/calendar · `1..9` switch channel · `j/k` select card or row · `[`/`]` move selected card back/forward by kind order (same `move_video`, same gate) · `p` promote · `x` complete current `/now` row · `Enter` open · `?` cheat sheet.

## Brainstorm service module

`lib/brainstorm/types.ts` — schema is structural only (the structured-output API drops array/string/numeric bounds and the SDK would then reject a 9- or 21-title answer client-side); counts and lengths live in the prompt and are clamped in code:
```ts
export const BrainstormOutput = z.object({
  titles: z.array(z.object({ title: z.string(), rationale: z.string() })),
  recommended_index: z.number().int(),
  hooks: z.array(z.object({ text: z.string(), rationale: z.string() })),
});
export interface BrainstormInput { title: string; oneLineHook?: string; notes?: string; tags: string[];
  voiceGuide?: string; pastTitles: string[]; channelName: string }
export interface BrainstormProvider { generate(input: BrainstormInput): Promise<z.infer<typeof BrainstormOutput>> }
```
`lib/brainstorm/anthropic.ts` (the only file that reads `ANTHROPIC_API_KEY`, `import "server-only"`): `client.beta.messages.create({ model: process.env.ANTHROPIC_MODEL ?? "claude-opus-5", max_tokens: 16000, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default", output_config: { effort: "medium", format: zodOutputFormat(BrainstormOutput) }, system, messages })`; check `stop_reason === "refusal"` first, then `BrainstormOutput.safeParse(JSON.parse(text))`; slice to 20 titles / 3 hooks, clamp `recommended_index`, flag titles > 55 chars in the UI rather than rejecting. Adaptive thinking is on by default; `effort: "medium"` keeps 20 titles + rationales well inside the 60 s window. System prompt = fixed instruction ("titles sell the result, create curiosity, ≤ 55 chars preferred; 10–20 titles, exactly 3 hooks; hooks deliver on the title inside 15 s; never generic-YouTuber voice, no 'in this video'") + the channel's voice guide verbatim when present ("write only in this voice") + the channel's last 50 published titles as style evidence. User message = title, one-line hook, notes, tags. Server action `brainstorm(videoId)` on a segment with `maxDuration = 60`; the result is stored in `videos.brainstorm_last` and rendered in a panel with "Add all as candidates", per-title "Add as candidate" (`{source:'ai'}`) and "Use as hook" (≤ 3).

## Build order

Every milestone ends runnable with `supabase start && npm run dev`. Adversarial review after each: `supabase db reset`, run `scripts/seed-demo.ts`, walk the scenario, then try to break the named invariant.

- **M0 — Scaffold, auth, RLS, full schema.** `create-next-app` (TS, Tailwind, App Router), `supabase init`, `0001_init.sql` (all tables, composite FKs, CHECKs, policies, column revokes, `move_video`, `swap_thumbnail`, storage bucket + policy), `supabase gen types`, `@supabase/ssr` server/browser clients + `proxy.ts`, `/login`, `createChannel` with seeding, `/c/[slug]/board` renders 9 empty columns.
  - *Runnable:* log in, create two channels, switch.
  - *Review:* anon-key `curl` returns zero rows; logged-out request redirects; a second user (created then deleted) sees nothing and cannot insert a `checklist_items` row against the first user's video (composite FK refuses); `delete from stages where kind = 'idea'` from the client deletes zero rows.
- **M1 — Capture, board, DnD, deploy, upload.** `c` modal + `/capture` (one input, disclosure), cards, native DnD → `moveVideo` → `move_video` (gate + `stage_entered_at`; checklist copy is a no-op until templates render in M3), `[`/`]`, counts, WIP warning on `WIP_KINDS`, days-in-stage, stale flag, Idea-column cap. Minimal `/videos/[id]` stub: title + concept-sketch upload (browser → Storage, `recordUpload`) + signed-URL thumb on the card. Deploy to Vercel against a hosted project (`supabase db push`).
  - *Runnable:* capture 8 ideas across 2 channels, drag, refresh, persists; dragging an idea past Packaging is refused; upload a sketch from the deployed app to the hosted bucket.
  - *Review:* `update videos set stage_id` from the browser client fails (revoke); cross-channel `stage_id` via SQL fails (composite FK); upload under another user's folder fails; re-upload leaves one object.
- **M2 — Detail page: packaging + gate.** Title with char count and > 55 warning, candidates editor (add, note, choose → copies to `title`), concept text, hooks (≤ 3, choose), live gate indicator, Skip (reason required, badge), target date, URL, notes, `waiting_on`, archive, stage select. Autosave on blur through `updateVideo`. Filming badge (text-only).
  - *Runnable:* fill the three fields, move to Scripting; skip with a reason, see the badge; clear the title afterwards and see "Complete packaging".
  - *Review:* zod rejects 4 hooks and 2 chosen candidates; CHECK rejects 4 hooks by direct SQL; skip with empty reason fails; `move_video` error names the missing field.
- **M3 — Checklists, `/now`, weekly strip.** Snapshot-on-entry (already in `move_video`), checklist UI (tick, add-at-top, delete, "reset from template"), ratio on cards, script auto-filled from template on entry to Scripting, `/now` with sections, inline controls per `input` kind, staleness sort, ≤ 10-min filter, channel chips, `x`/`j`/`k`, board header strip.
  - *Runnable:* the Monday scenario — ten minutes on `/now`, complete rows without opening cards.
  - *Review:* `vitest` fixture for `nextAction()`: 8-video week, plus Repurposed disabled + video published 25h ago (must be Overdue), a bank of 30 ideas (zero rows), a Scheduled video for next Tuesday (Waiting), a Packaging video with everything filled (Move row succeeds); a template edit does not touch in-flight items.
- **M4 — Thumbnails, post-publish.** Three role slots, shipped radio (`shipThumbnail` refuses a role without an asset), swap dialog + log, 24h metrics pair, always-on "Swap thumbnail?" vs expectation, `dismissSwap`, `confirmLive`, Repurposed lane toggle.
  - *Runnable:* the Thursday scenario.
  - *Review:* CTR without impressions fails at the CHECK; `shipped_role` without an asset fails at the CHECK; a swap either writes both rows or neither (kill the connection mid-call).
- **M5 — Idea bank, buckets, matrix, promote.** `/c/[slug]/ideas` list + filters, matrix with counts and `n/quota` (videos with `target_publish_date` in the current month per bucket), empty cell → prefilled capture, `p` promote.
  - *Runnable:* matrix renders, promote lands in Packaging.
  - *Review:* a bucket from channel A or of the wrong axis on a video in channel B fails at the composite FK by direct SQL.
- **M6 — Calendar, filming days.** `/calendar`, filming-day events expanding to linked videos, badge → `createFilmingDay` linking Filming videos.
  - *Runnable:* the Wednesday/Saturday scenario.
  - *Review:* a filming day whose video left Filming still renders sanely; two filming days on one date is refused.
- **M7 — Settings.** Stages (rename, up/down only within the core-order constraint, enable/disable refused when occupied by non-archived videos, add inert stage), template editor with `est_minutes`, buckets + quotas, voice guide, script template, thresholds, expected CTR.
  - *Runnable:* toggle Repurposed off, rename Packaging, board follows.
  - *Review:* renaming must not break the gate or badges (they key on `kind`); reorder across a core stage is not offered and is refused by `updateStages`; a position swap never violates the deferred unique.
- **M8 — Brainstorm.** Module above, panel on the packaging block, "Add all", add-as-candidate / use-as-hook, `brainstorm_last`.
  - *Runnable:* 10–20 titles with rationale and a highlighted pick; changing the voice guide visibly changes output.
  - *Review:* key never reaches the client bundle (`server-only`, grep the build output); a 21-title answer is clamped, not discarded; a refusal surfaces as a message, not a crash.
- **M9 — Polish.** Full shortcut set + `?` sheet, mobile pass on `/now` and `/capture`, empty states, README (browser client = uploads and reads only).
  - *Review:* whole-week walkthrough on a phone and a laptop.

## Open questions answered

**1. Stages: per-channel table from day one.** *Decision:* yes, a dumb one. *Argument:* the brief says "stages must be editable per channel" (rename, toggle Repurposed) — that is per-channel stage state by definition, so a table is the requirement, not a choice; a `videos.stage` string that later becomes an FK touches every query and the board. The over-engineering risk is attaching behaviour to configuration: behaviour (gate, badge, URL field, post-publish block, ordering) binds to the fixed `kind` and `CORE_KIND_ORDER` in code, the partial unique keeps one canonical stage per kind, and user-added stages are inert. *If wrong:* the table holds nine rows per channel and never varies; nothing to migrate away from.

**2. Checklists: per-channel templates, snapshot-copied per video on stage entry, editable per video.** *Decision:* copy on entry. *Argument:* per-video edits become plain row edits (no override table, no "which wins", no orphaned references when a template item is deleted), ticked state survives template edits, "reset from template" is delete + re-copy, and `/now` stays one scan of `checklist_items`. Template edits apply to videos entering the stage afterwards, which is the predictable weekly-review semantic; propagating into in-flight videos would silently add or un-tick work. *If wrong:* add `template_item_id uuid null` to `checklist_items` and a diff-and-apply action; no schema rewrite.

**3. `/now`: derived query, not stored.** *Decision:* derived, in a pure TS function over three queries. *Argument:* the answer depends on the clock (24h due, go-live date, staleness), so it cannot be fully stored anyway, and a stored column is a cache with at least five invalidation paths (tick, move, packaging edit, metrics, swap) for a list of 8–20 rows. The only stored inputs are genuine user decisions: `waiting_on`, `est_minutes`, `swap_dismissed_at`. A custom next action is "add a checklist item", which inserts at the top and is therefore the next action immediately. *If wrong:* add `videos.next_action_override text null` and `coalesce` it first in `nextAction()`; one column, one line.

## Seed data (on channel creation)

- **Stages** (positions 1–9, kinds as named): Idea, Packaging (TTH), Scripting, Filming, Editing, Publish Prep, Scheduled, Published, Repurposed (all `is_enabled = true`).
- **Checklist templates**: the seven lists in the brief, verbatim, one row per bullet, positioned in order, every row with `est_minutes` (candidates 15, YouTube search 15, title/concept judgement items 5, hooks 15, hook scripting 20, body items 10–15, B-roll plan 15, filming items 5–60, editing items 30–60, thumbnails 60, description/chapters 10–20, upload defaults 5, 24h check 5, swap 10, clips 60, shorts 15, newsletter 45).
- **Buckets**: horizontals from the brief's format list — tutorial, listicle, review, self-experiment, vlog, reaction, case study, interview; verticals empty (settings prompts for 3–5).
- **Script template** (markdown text): `## Hook (verbatim)` containing `{{hook}}` → `## Body (bullets)` with a `Structure:` line → `## End screen → [named video]`, plus a `B-roll:` line under each section.
- **Channel defaults**: `wip_threshold 5`, `stale_days 7`, `expected_ctr null`, `voice_guide null`.
- Dev-only `scripts/seed-demo.ts` (`tsx`): creates the user via `auth.admin.createUser`, two channels and the 8-video week, passing `user_id` on every row; every milestone's review starts from the same fixture.

## Review log

**Applied**
- 1/12/13/24 — `/now` scoped by kind: ideas excluded, zero items ≠ done, terminal kinds emit no move, Scheduled handled by go-live date; fixture cases added to M3.
- 2 — `move_video` and `swap_thumbnail` as plpgsql functions via `rpc`; column revoke makes them the only write path. Deviation: `security definer` with an explicit `auth.uid()` ownership check instead of `security invoker`, because an invoker function would itself be blocked by the column revoke.
- 3/26 — gate and next-stage compare `CORE_KIND_ORDER`, never `position`; core stages cannot cross each other; deferred uniques on position with single-statement swaps.
- 4 — `unique (id, user_id)` on parents, composite tenant FKs on every child.
- 5/34 — buckets bound by channel and axis via generated columns + composite FK; app-level check and M5 review item dropped (34 is subsumed by 5).
- 6 — delete policy on stages limited to `kind is null`; no channel delete in v1; `no action` on `videos.stage_id`; README notes browser-client scope.
- 7 — stable storage paths with `upsert: true`; old object removed on extension change; object-count check in M1 review.
- 8 — `proxy.ts`, `await cookies()`, `setAll` try/catch, `getUser()`, seed via `auth.admin.createUser`, `enable_signup = false`.
- 9 — role CHECKs on swaps, `first24_views >= 0`, jsonb array/length CHECKs, `unique (user_id, on_date)`; `shipped_role` guarantee done with a CHECK against the three path columns (see 28).
- 10 — `broll_plan` dropped (B-roll lives in the script sections); `end_screen_target` added; disable check ignores archived videos.
- 11/23 — lock button, `packaging_locked_at` and `l` removed; gate is the field predicate at move time; a later-cleared field surfaces as Overdue "Complete packaging"; `/now` move rows always succeed.
- 14 — capture is one input + channel chip, Enter saves, disclosure for the rest, last-used channel remembered.
- 15 — swap prompt always renders after metrics; expectation falls back to the channel median; `/now` rule 3 + `swap_dismissed_at`.
- 16 — WIP warning only on in-flight kinds; Idea column capped with "+K more"; Published/Repurposed cards hide after 30 days.
- 17 — `input` discriminator with inline controls per row.
- 18 (reduced) — weekly strip moved to M3 using `stage_entered_at` (count, oldest, median), since 27 removes `stage_events`.
- 19 — script filled from template with the chosen hook inside `move_video`; "reset script from template" on detail.
- 20 — `est_minutes` seeded on every row; null reads as 10.
- 21 — packaging checklist items precede gate-field prompts; auto-tick left out of v1.
- 22 — (b) `brainstorm_last` + "Add all"; (c) badge moved to M2 and text-only until M6; (a) shipped/swap roles validated by CHECK — the derived template row is not applied (adds a template-row type for one item; the Scheduled soft warning already covers it).
- 25 — upload component, storage policy and hosted-bucket upload test moved into M1 via a detail-page stub.
- 27 — `stage_events` and historical averages dropped; time-in-current-stage covers principle 5.
- 28 — `thumbnail_assets` folded into three path columns on `videos`; `thumbnail_swaps` stays a table (append-only log with reasons; jsonb is for small editable lists).
- 29 — `/film/[id]` dropped; calendar filming days expand to linked videos.
- 30 — OQ1 re-argued from "stages must be editable per channel"; `stages.wip_limit` dropped; custom checklist items insert at the top.
- 31 — Filming badge in M2; `vitest` and `tsx` declared as dev dependencies.
- 32 — structural-only zod schema with prompt-side counts and client-side clamping; `effort: "medium"`; `fallbacks: "default"` on by default.
- 33 — secondary indexes removed; `checklist_templates.channel_id` removed.

**Rejected**
- 2 (part) — `skip_packaging` as a SQL function: it is a single-row update with a CHECK, so a function adds nothing.
- 22(a) derived checklist row — see above; partial rejection recorded under Applied.
