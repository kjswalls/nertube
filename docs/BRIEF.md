# Build Brief: YouTube Production Pipeline Tool

A personal YouTube production pipeline tool. For the owner first, but structured
cleanly in case it is productized later under Sunday Softworks.

## Problem
Tools like Spotter Studio focus on AI ideation. Notion templates are generic.
This tool focuses on moving a video from idea to published: the production
middle that other tools neglect. AI capabilities come eventually (idea
generation, script review, analytics, outliers) but the pipeline is the core.

## Design principles (these determine the data model)

Sourced from Ali Abdaal's Part-Time YouTuber Academy and Film Booth.

1. **Packaging comes first, not last.** Title + Thumbnail concept + Hook ("TTH")
   are decided *before* the script is written and *before* filming. ~20% of the
   time spent, ~80% of the results. The app must make it structurally awkward to
   skip this gate.
2. **Thumbnail concept ≠ thumbnail asset.** The *concept* is locked at the TTH
   stage (so you film the right shots). The final *image files* are produced much
   later, near publish. Two different fields at two different stages.
3. **Parallel, not serial ("slow burns vs. heavy lifts").** A creator keeps 5–10
   videos alive at different stages simultaneously and nudges them forward in
   5–10 minute spare moments. The app is NOT a single-video wizard. Its most
   important job is answering: *"I have 10 minutes — what can I move right now?"*
4. **Batch filming.** Filming is the only step needing a big time block. When 3+
   videos are sitting in Filming, that's a signal to schedule a batch day.
5. **Bottleneck visibility.** Weekly review question: *where are videos piling
   up?* Column counts and time-in-stage are first-class.
6. **Friction reduction is the product.** Every stage should have defaults,
   templates, and as few clicks as possible. If the tool adds friction, it fails.
7. **Three thumbnails at launch, not one.** A **wild card** (risky), a
   **moderate**, and a **safe** fallback. All ready at launch so you can swap fast
   if the video underperforms in the first hours.
8. **Publishing is not the last stage.** Post-publish loop: check first-24h
   performance, swap thumbnail if needed, then repurpose into clips / newsletter /
   social.

## v1 scope

### Multi-channel
Support more than one channel (personal + Sunday Softworks) with a channel
switcher. Every video belongs to a channel. Stage definitions, checklist
templates, and content buckets are all per-channel.

### Idea bank
- Quick capture: title, one-line hook, notes, tags. A global shortcut, one
  input, save, done.
- **Content buckets:** each channel defines 3–5 *verticals* (topic pillars) and
  8–12 *horizontals* (formats: tutorial, listicle, review, self-experiment, vlog,
  reaction, case study, interview...). An idea can be tagged with one of each.
  Matrix view where each empty cell is a prompt for a new idea. Optional
  per-bucket monthly quotas ("2 book reviews, 2 productivity, 2 finance").
- Promote-to-video moves an idea onto the pipeline board.

### Pipeline board (kanban, drag and drop)
Default stages — **stages must be editable per channel**:

| # | Stage | Exit criteria |
|---|-------|---------------|
| 1 | **Idea** | Captured, not yet committed |
| 2 | **Packaging (TTH)** | Title locked, thumbnail *concept* locked, hook drafted |
| 3 | **Scripting** | Hook scripted word-for-word; body as bullets; end-screen target picked |
| 4 | **Filming** | Footage shot and backed up |
| 5 | **Editing** | Cut locked (incl. editor handoff/review if outsourced) |
| 6 | **Publish Prep** | Thumbnail *assets* (3 variants), description, chapters, end screen, tags |
| 7 | **Scheduled** | Upload scheduled in YouTube Studio, publish date set |
| 8 | **Published** | Live, URL recorded |
| 9 | **Repurposed** | Clips/newsletter/social derived (optional lane — can be toggled off) |

Board requirements:
- Column headers show count + a warning when a column exceeds a configurable WIP
  threshold (bottleneck signal).
- Badge on the Filming column when count >= 3 ("batch film day?").
- Show time-in-current-stage on each card; flag cards stale beyond N days.
- Card face shows: working title, channel, target publish date, thumbnail concept
  thumbnail if one exists, and a per-stage checklist completion ratio.

### Video detail page
- **Packaging block**
  - Working title + list of alternate title candidates (each with a note and a
    "chosen" flag). Character count with a warning over 55 characters.
  - Thumbnail *concept* — text description + optional sketch/reference upload.
  - Hook — rich text/markdown field holding up to 3 hook variants with one
    marked chosen.
- **Script editor** (markdown). Per-channel script template with structure
  defaults: hook (scripted verbatim) → body (bullets) → end screen handoff. Note
  fields for: chosen structure (listicle / 3-part / story arc) and B-roll plan
  per section.
- **Thumbnail assets** — image uploads with a required `role` of
  `wild_card | moderate | safe`, plus which one shipped, and a log of swaps
  (date, from, to, reason).
- **Per-stage checklist** — editable default templates per channel.
- **Target publish date** and **final YouTube URL** once published.
- **Free-form notes** (B-roll list, sponsor read, gear notes).
- **Post-publish block** (simple, manual entry): first-24h impressions, CTR,
  views, and a "new viewers" note; plus a "swap thumbnail?" prompt. Always
  display impressions and CTR together, never CTR alone.

### Seed checklist templates (defaults, user-editable)

**Packaging (TTH)**
- [ ] Generated 10–20 title candidates, not 3
- [ ] Chosen title sells the *result*, not the content
- [ ] Title creates curiosity (a viewer can't just nod and scroll)
- [ ] Title under 55 characters
- [ ] Searched YouTube for this topic — checked what's already working
- [ ] Thumbnail concept complements the title (adds something) rather than repeating it
- [ ] Thumbnail concept still readable at phone-tile size
- [ ] Hook drafted in 3 versions, strongest picked

**Scripting**
- [ ] Hook scripted word-for-word (rest can be bullets)
- [ ] Hook delivers on the title's promise within ~15 seconds
- [ ] No "welcome back to the channel" preamble before the hook
- [ ] Structure picked (listicle / 3-part / story arc)
- [ ] Scanned for repetition — cut restated points
- [ ] Each point goes one level deeper than the obvious
- [ ] Something new lands every 10–15 seconds
- [ ] End screen points at a specific named video (never "thanks for watching")
- [ ] B-roll planned per section; first 30s aims for a shot change every 1–1.5s

**Filming**
- [ ] Outline visible while filming (don't rely on memory)
- [ ] Thumbnail shots captured (matches the locked concept)
- [ ] Shirt change if batching (so thumbnails look like different days)
- [ ] Footage backed up to cloud

**Editing**
- [ ] First 30 seconds got disproportionate attention
- [ ] Dead stretches cut
- [ ] Re-voiceover / rephrase anything that doesn't land in the edit
- [ ] Editor feedback round complete (if outsourced)

**Publish Prep**
- [ ] 3 thumbnail variants ready (wild card / moderate / safe)
- [ ] Description written; affiliate + standard links present
- [ ] Chapters set
- [ ] End screen linked to the planned next video
- [ ] Upload defaults applied

**Published**
- [ ] Check first 24h: impressions AND CTR together, plus new-viewer share
- [ ] Swap thumbnail if underperforming vs expectation — act fast, don't wait days

**Repurposed**
- [ ] 2–3 short clips cut
- [ ] Posted to Shorts / Reels / TikTok
- [ ] Newsletter or written version (if applicable)

### Calendar view
Target publish dates across channels. Also surface scheduled batch-filming days
as a distinct event type.

### "What can I move right now?" view
A dedicated view (or dashboard panel) listing the smallest available next action
across all in-flight videos, sorted by staleness. As important as the board.

### Claude brainstorm button
On ideas/videos: generate title variants and hooks from the video's notes plus
the list of past video titles. Behind a small, swappable service module.
- Must accept an optional **voice guide** document per channel and condition
  output on it. Never produce generic-YouTuber voice.
- Title generation returns 10–20 options with a short rationale each and a
  recommended pick, not a flat list.

## Explicitly out of scope for v1
- Uploading or scheduling through the YouTube API
- Analytics dashboards, outlier research, SEO tooling
- Team accounts and permissions (single user; keep a `user_id` on tables for later)

## Stack
Next.js (App Router) + TypeScript, Supabase (Postgres, auth, storage for
thumbnails), Tailwind, deploy on Vercel. Anthropic API for the brainstorm
feature, with the key in server-side env vars only.

## Working style
- Plan first (data model, routes, milestones), then build milestone by milestone,
  runnable locally after each one, with adversarial reviews after each stage.
- Keyboard shortcuts for common actions (new idea, move stage, quick capture).
- Minimal dependencies, readable code, no over-abstraction.

## Open questions to argue in the plan
- Stages: per-channel config table from day one, or hardcoded in v1 with a
  migration path?
- Checklist template edits: per channel, or per channel *and* overridable per video?
- "What can I move right now?": derived query or stored `next_action` per video?
