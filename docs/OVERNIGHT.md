# The unattended run: M5 to M9

This is the summary of the milestones built while you were away, from
18 to 23 September: M5 (idea bank
and matrix), M6 (calendar and filming days), M7 (settings), M8 (the
brainstorm) and M9 (polish). It covers:

- what shipped and what verified it;
- what went wrong on the way;
- what is still open;
- every decision taken without you.

The full record of each milestone is in `docs/MILESTONES.md`. The known limits
of the tool as it stands are in the README's **Honest limits** section.

## Where things stand

All nine milestones are built, on branch `claude/tender-davinci-rq7n9y`.

| Milestone | Commit | Subagent tokens |
|---|---|---|
| M5: idea bank, content-bucket matrix, promote | `5e7514c` | 2.66M |
| M6: calendar across channels, batch filming days | `369398a` | 1.88M |
| M7: settings (stages, checklist templates, buckets, channel) | `2af8bc8` | 2.57M, plus 1.07M for the fix pass that finished its review |
| M8: brainstorm (swappable provider, assist panel) | `4a7748c` | 3.50M |
| M9: responsive pass, full shortcut set, empty and error states, README | see the M9 row below | 3.56M |
| **Total** | | **15.24M** |

The numbers are the tokens the milestone's workflow agents reported. My own
tokens in this session (orchestrating, checking in, verifying) are not
included.

### M9, verified independently

The agents ran every gate themselves. I then re-ran each one on the final tree,
cold:

| Gate | Result |
|---|---|
| Typecheck (`npx tsc --noEmit`) | clean |
| Lint (`npm run lint`) | clean |
| Build (`npm run build`) | clean |
| Unit (`npx vitest run`) | 528 passed, 33 files |
| SQL suite (`./scripts/verify-db.sh m9_verify`) | 17 files passed |
| Browser (`E2E_REUSE=0 npm run e2e`), run 1 | _filled in below_ |
| Browser, run 2 | _filled in below_ |

M9 added no runtime dependency (`package.json` is unchanged since M8) and no
migration.

## Things to check yourself

1. **The Vercel deployment has to build from this branch.** Migrations
   0007–0009 are on the hosted database. They take back table grants that the
   code before M7 wrote through directly: stage and channel columns, a video's
   `archived_at` and `brainstorm_last`. The current code writes those through
   database functions instead. If Vercel builds an older commit, the database
   will refuse that build's archive, restore, saved brainstorm results and most
   settings edits.
2. **Confirm that email sign-ups are turned off in Supabase** (Authentication →
   Providers → Email). The site is public, and the publishable key is in the
   browser bundle, as it has to be. With sign-ups on, anyone who finds the URL
   can make an account. Row-level security keeps their data apart from yours,
   but they would still be using your project.
3. **Two stale branches**, `claude/tender-davinci-rq7n9y-m7` and `-m8`, hold
   nothing that is not already on the main branch (0 commits ahead). I have not
   deleted them; that is yours to do.
4. **The branch history is noisy.** There is a `wip(mN): checkpoint …` commit
   every hour or so, because the container can be reclaimed at any time and an
   unpushed hour is a lost hour. Squash them before merging if you want a clean
   history. The `feat(mN)` commits are the milestone boundaries.

## What went wrong overnight, and what was done

- **M7's review was cut short by the spend limit.** Two reviewers had reported
  12 findings when the account hit its limit. That killed the other two
  reviewers and the fix pass before any change was made. I recovered the 12
  findings from the workflow journal. Once the limit reset on Tuesday, two more
  reviewers ran and a separate fix pass (the 1.07M above) applied all 28
  findings. The M7 review section in MILESTONES tells the two halves apart.
- **The Fable → Opus switch.** M7's agents ran on Fable, both the build and
  its fix pass, while the main pool was near its weekly limit. M5 and M6 ran on
  the session's own model. After you bought credit, M8 and M9 ran on Opus. I saw
  no obvious quality difference. M7's review on Fable found 28 substantive
  issues, and M8's and M9's reviews on Opus found 32 and 41.
- **Running milestones in sibling sessions did not work.** I tried running
  milestones as separate cloud sessions, in parallel. The sessions stopped on
  permission prompts that nobody was there to answer. I archived them and went
  back to one milestone at a time in this session.
- **The container restarted once, during M6.** The workflow was resumed from
  its journal, and completed agents were replayed from cache rather than re-run.
- **Postgres stopped twice between runs.** It was restarted
  (`service postgresql start`), and every later run checks `pg_isready` first.
- **The stale-stack trap.** `playwright.config.ts` reuses a server that is
  already running. Twice that meant tests ran against a database from before a
  migration. Every verification run now uses `E2E_REUSE=0`.
- **The browser suite outgrew the development server.** At about 300 tests,
  `next dev` restarted itself once per full run, when its memory passed 80% of
  its heap. Whatever test was loading a page at that moment failed. This was
  measured rather than guessed, over 120 rounds of page loads:
  - `next dev` grew about 20 MB per round, from 982 MB to 3.4 GB;
  - `next start` (the production build) stayed flat at about 370 MB.

  So the leak is in the development server, not the app. The suite now always
  runs against a production build. It is faster (about 12 minutes rather than
  34) and exits 0.
- **One test failure was never explained.** `e2e/board.m1.spec.ts:513` (drag an
  idea into Packaging) failed once during M9's integration pass. It has not
  recurred in 52 repeats or in any full run since. It is recorded as
  unexplained rather than called a flake.

## Things that are true now and were not before

- **M5's matrix is usable.** A new channel is created with no topic pillars, so
  in M5 the matrix could only show its "no pillars" panel, and adding a pillar
  took SQL. M7's bucket editor fixed that: the panel now links straight to the
  editor where pillars are added.
- **The README said the app had never been deployed.** The agents wrote that
  because nothing in the repository recorded the deployment. It was wrong: you
  created the Supabase and Vercel projects on 17 September, and the hosted
  database has all nine migrations on Postgres 17.6. I corrected it, and the
  line saying Postgres 17 had never run the migrations. What stays true is that
  no test has run against the deployment, and the SQL suite has only run on
  Postgres 16.

## M8: what has not been tested live

- **No request has ever been sent to Anthropic.** There is no key here, and
  egress is blocked. The real provider is checked against the SDK's types and a
  stubbed transport. The fake is what the browser tests use.
- **Spend is not capped.** The same question cannot run twice at once on one
  server instance, and that is all. There is no hourly or daily ceiling.
- **Cancel stops the waiting, not the spending.** Closing a panel drops the
  answer; the call still runs to completion and is billed.

The README lists the first four things to check once a key is in Vercel.

## Still broken or unbuilt, with no milestone left

Everything below is in the README's **Honest limits**, with its reasons. The
ones most likely to matter to you:

- **The script is read-only.** It is filled from the channel's template once,
  on first entry to Scripting, and there is no editor. "Reset script from
  template" was not built. This is the biggest gap against the brief.
- **"Today" is the UTC day everywhere.** There is no timezone setting. It was
  deferred from M6 to M7 to M9 and never landed, because it needs a per-user
  profile that does not exist.
- **Busy controls use `disabled`, not `aria-disabled`.** Focus drops to the page
  while a save is in flight. That means about eighty props in thirty-five
  files, and nothing here can check the result with a real screen reader.
- **On a phone, some tap targets are still under 44px:** the settings rows'
  arrows and Remove links, and the calendar's chips. No real phone has been
  used at any point.
- **The settings screens are wordy.** They did not get the copy-editing pass
  the video page's Packaging tab got.
- **A checklist item added to one video has no estimate**, so `/now`'s
  "10 minutes or less" filter always lets it through.

## Every decision taken without you

These are the ones worth reading first, because each changes how the tool
behaves and you might choose differently:

- **"Today" is UTC**, with no timezone setting (M6, carried to M9).
- **No script editor, and no reset-from-template** (M3, M8, M9).
- **Videos are archived, never deleted;** channels cannot be removed (M5).
- **The Idea stage cannot be switched off**, because capture has to land
  somewhere (M7 review).
- **Checklist items never tick themselves**, even when the thing they name is
  done. A tick is your record, not the app's (M9).
- **The brainstorm's Cancel stops waiting, not the model** (M8).
- **Channels are told apart by a two-letter tag and a stripe, not a colour**,
  because colour is reserved for state. This deviates from PLAN.md (M6).
- **`g c` opens the calendar**, not PLAN.md's `g k` (M9).
- **On a video page, the stage select moves on Enter or a pointer pick, not on
  an arrow key** (M9 review).
- **Below 768px the calendar says "wider screen"** rather than becoming an
  agenda view (M9).
- **The bank's filters are single-value, not multi-select** (M5).
- **The browser suite always runs a production build** (M9 review).
- **Mine, not the agents':**
  - M7 ran on Fable, and M8 and M9 on Opus.
  - Milestones ran one at a time, after the sibling sessions failed.
  - I corrected the README's deploy claims.
  - I committed and pushed a checkpoint at every check-in.

The full list, generated from every "Decisions taken without the user" section
in `docs/MILESTONES.md`, is below: 166 decisions. Each heading links to its
section, where every decision also names the alternative that was not taken.

**M5 — The content-bucket matrix** — `docs/MILESTONES.md:3625`

- A cell counts every non-archived video, not only Idea-stage rows.
- An axis header's total is the whole bucket (independent of the other axis), with an explicit off-grid line under the grid.
- An empty cell opens capture in place, over a link that still works without JavaScript.
- A prefilled capture shows one channel and no channel chips.
- The populated cell drills down into a panel on the matrix (`?cell=`).
- "This month" is the UTC calendar month, compared as `YYYY-MM-DD` strings.
- Archived videos are excluded from every count.

**M5 — Filing an idea: the two buckets, and the tags** — `docs/MILESTONES.md:3913`

- Filing lives on the Packaging tab, under the gate.
- A native `<select>` per axis.
- The empty option reads "— not filed —".
- Tags de-duplicate case-insensitively, first spelling wins.
- The tag input commits on blur as well as Enter.
- Suggestions are this channel's tags, most-used first, capped at twelve, with the whole vocabulary in a `<datalist>`.
- Capture's pickers fetch their options when the disclosure opens.
- A refused bucket is reported as a conflict with a Reload.
- The bucket menus grey out while a save is in flight.
- The filing block is a Server Component;
- The matrix's "filing it under X · Y" line disappears the moment either menu is changed.

**M5 — The idea bank list: filters, promote, and the Ideas entry that finally goes somewhere** — `docs/MILESTONES.md:4030`

- "Archive and delete" was built as archive only, with Show archived and Restore.
- The filters are single-value, not multi-select.
- Selects, not chips, for tag / vertical / horizontal.
- Archived ideas are read by the page, not excluded in SQL.
- The bank shows the Idea stage even when that stage is disabled.

**M5 — Integration: one route, two views, and one answer to "which bucket is it in?"** — `docs/MILESTONES.md:4288`

- The filters go in the URL; the view switch does not carry them.
- `replaceState`, not `pushState`.
- An unknown bucket id in the URL is dropped, not honoured.
- The sidebar's count is the unfiltered bank.
- The cell keeps counting every stage, and says the bank's number beside it.
- Two extra reads on every signed-in route

**M5 — adversarial review, applied** — `docs/MILESTONES.md:4559`

- `p` is literal about Packaging; `]` is about the next enabled stage.
- The view switch now carries the bank's filters in both directions.
- The bank renders the view switch; the matrix branch of the route renders it.
- A hung write is given up on after 12 seconds, not cancelled.
- The cell drill-down lists ten.
- `aria-disabled` everywhere a control is present but will not act

**M6 — The calendar: a month grid, both channels, and the day that is full** — `docs/MILESTONES.md:4764`

- A channel is told apart by a two-letter tag and a stripe *style*, not by a colour.
- The only coloured thing on the grid is `late`.
- "Late" means the date has passed and the video is neither scheduled nor published.
- Three chips per day, and a full cell draws two plus the overflow link.
- The overflow opens a panel under the grid at `?day=`, not a dialog.
- The days borrowed from the neighbouring months carry no events.
- The sidebar's Calendar badge counts videos targeted at this month and does not fold filming days in.
- An unparseable `?month=` renders this month.
- A video with no target date is not on the calendar, and neither is an archived one.
- The whole page is server-rendered, with no client component at all.

**M6 — Batch filming days: the badge that finally does something** — `docs/MILESTONES.md:4901`

- "Today" is UTC.
- The schedule dialog opens on the next Saturday.
- A past filming day keeps its videos and reports where they got to.
- Exactly one state on a filming day takes colour
- A duplicate date is an answer, not an error.
- Moving a day onto an occupied date is refused rather than merged.
- Linking does not go through `updateVideo`.

**M6 — Integration: one grid, one filming day, one date** — `docs/MILESTONES.md:5303`

- A filming day keeps its archived videos, on the calendar as well as in the dialog, labelled "archived".
- The chip's count is `day.videos.length` — the same array the panel renders.
- `/calendar`'s "waiting for a filming day" counts videos in Filming not yet on a day;
- The calendar's schedule button is quiet;
- Only a filming row's `needs a block` chip links to the calendar.
- `FilmingDay` and `FilmingVideo` carry server-formatted label strings.
- The two slice sections above are kept verbatim rather than merged into this one.

**M7 — The stages editor: a label, an order, a switch, and one column with no behaviour** — `docs/MILESTONES.md:5842`

- The route is `/settings/stages/[slug]`, not PLAN.md's `/c/[slug]/settings`.
- The last enabled stage cannot be switched off.
- An occupied stage's switch stays clickable and the database refuses.
- Inert stages can be removed, but only when nothing refers to them.
- An added stage lands at the end and is moved with the arrows.
- Names are unique within a channel, case-insensitively, in the action.
- Focus after a move follows the stage:

**M7 — Checklist templates: the editor behind the snapshot boundary** — `docs/MILESTONES.md:5980`

- The route is `/settings/checklists/[slug]`
- A new template row goes at the end
- An estimate is 1–480 whole minutes.
- Removal has no confirmation dialog.
- The arrows wait for the wire; the text does not.
- Disabled stages are shown, marked, and editable.

**M7 — Buckets, quotas, and the channel's own settings** — `docs/MILESTONES.md:6234`

- Routes are `/settings/buckets/[slug]` and `/settings/channel/[slug]`.
- Removing a bucket unfiles rather than refuses.
- Duplicate names are refused case-insensitively, in the action.
- A quota's ceiling is 99 (`MAX_QUOTA`).
- Empty quota box = null;
- A script template without `{{hook}}` saves, with a warning.
- Expected CTR of zero is refused.
- Text fields normalise only line endings and trailing whitespace;
- Positions keep gaps after a removal;

**M7 — Integration: one settings area, one arrow, one refusal** — `docs/MILESTONES.md:6464`

- Refusals are set in `attention`, not `over-limit`.
- The sidebar's Settings row opens `/settings/stages/[slug]`, not `/settings`.
- The channel switch keeps the section.
- `useMoveFocus` reaches the template editor too, rather than leaving
- Two testid renames in two slice specs (`settings-stages-channel` →
- `e2e/m2-review.spec.ts` gets the hydration wait rather than a different

**M7 — Review: what the adversarial pass found, and what was done about it** — `docs/MILESTONES.md:6746`

- The Idea stage cannot be switched off.
- Archive and restore are a SQL function, and `archived_at` is no longer a client column.
- Invisible characters are stripped from labels and only detected in prose.
- A refused template operation is rolled back;
- The browser asks before a reload or a close with unsaved text, and the app sends the save first.
- Bucket removal reports non-archived and archived counts apart.
- The matrix's empty-state link is worded from what is missing.
- Concept sentences keep the word "Packaging";

**M8 — The brainstorm panel: proposals, and the line between them and your writing** — `docs/MILESTONES.md:6857`

- The panel is inline, not a modal.
- Opening an empty panel asks immediately; opening one with a stored answer does not.
- "Cancel" means stop waiting, not stop the model.
- A refusal offers "Try anyway" rather than "Try again".
- Rationales are truncated at the note column's ceiling
- The two remaining assist pills (thumbnail concept, thumbnail critique) are still inert and now say M9 rather than M8.

**M8 — The service module: one seam, two implementations, no key in this room** — `docs/MILESTONES.md:7043`

- `maxRetries: 0` on the SDK client.
- `cancelled` is not retryable and `refused` is not either.
- A fully de-duplicated answer is a success with an empty list, not an `empty` error.
- The rationale is cut to `MAX_CANDIDATE_NOTE_LENGTH` rather than dropped.
- Hooks are asked for by how many are missing
- The fake takes a scenario from a marker in the video's own text
- `concepts` and `thumbnail_critique` exist in the provider surface

**M8 — Every other assist: concepts, the third hook, the critique, and the two places a pill would have been noise** — `docs/MILESTONES.md:7244`

- Concepts got their own control rather than a third tab on the brainstorm panel.
- Accepting a concept replaces immediately, with an undo, rather than asking first.
- The critique is not stored
- The critique's accept is "ship this one".
- `brainstorm_last` gained a `concepts` key without a version bump.
- The capture toast gained a link
- The four pills all render `AssistPillButton`

**M8 — Integration: one seam, one machine, and what a key would still have to prove** — `docs/MILESTONES.md:7612`

- The fixtures announce themselves, in the attention colour, on every answer.
- The fallback splits on `NODE_ENV` rather than picking one default.
- The panel's copy does not name `ANTHROPIC_API_KEY`
- `AssistState.entry` was renamed to `data`.
- The thumbnail critique makes the fixture admission too
- `e2e/m8-acceptance.spec.ts` exists at all
- The pill keeps its verb as its identity.

**M8 — Review: what the adversarial pass found, and what was done about it** — `docs/MILESTONES.md:7997`

- `videos.brainstorm_last` left the client's UPDATE grant
- `recommended_reason` is optional in the schema and asked for in the prompt.
- The failure sentences name no vendor at all
- A cancelled request's answer is adopted; a cancelled request's failure is not.
- The in-flight guard is per question, not per user.

**M9 — The responsive pass: one bar, one sheet, and the 102px column** — `docs/MILESTONES.md:8179`

- The breakpoint is 768px (`md`), and the menu opens from the left.
- Capture stays on the bar, not behind the menu.
- The sheet renders the links a second time; nothing else is duplicated.
- The keyboard hint bar is not in the sheet.
- Targets: 44px for a row's own controls, 24px for the chips that link elsewhere
- `/capture` has two submit buttons in its markup, one per layout, never both displayed.
- The calendar says "wider screen" instead of becoming an agenda.

**M9 — The keyboard: one set, one sheet, one Escape** — `docs/MILESTONES.md:8432`

- `g c` is the calendar, not PLAN.md's `g k`.
- The second key of a sequence is always consumed.
- The hint bar stays
- Escape clears the selection on `/now` and in the bank too
- An assist panel is a region, not an overlay.
- Checkboxes, radios and buttons are not "typing".
- AltGr is a way to produce a key, not a modifier on one.
- `/` exists only in the idea bank

**M9 — Empty states, error states, and the README** — `docs/MILESTONES.md:8643`

- An empty view keeps its structure.
- Capture from an empty view happens in place
- `/now`'s empty action depends on why it is empty
- The error page has no sidebar.
- A signed-out save offers sign-in in a new tab
- A 404 never says whether the thing exists for someone else
- `supabase/config.toml` is the CLI's generated file
- No timezone setting.
- The two add forms stay two.

**M9 — Integration: one tool, one week, and every debt accounted for** — `docs/MILESTONES.md:8976`

- The week walk is a committed spec, not a one-off session.
- The phone walk is a touch device, not a narrow mouse.
- Below `md` the board opens at the first column with work in it.
- Below `md` toasts go under the bar, not at the bottom.
- The hook field grows with its text
- Auto-tick stays out
- `aria-disabled` stays undone.

**M9 — Review: the last fix pass** — `docs/MILESTONES.md:9380`

- The suite runs a production build, always.
- The stage select moves on a pointer pick and on Enter, not on an arrow.
- A keyboard refusal moves focus into the toast; a pointer one does not.
- Error toasts still expire
- Thumbnails is "quiet" before Editing, not a ratio of 0/3.
- The gate sentence lists every missing field, and the deep link still goes to the first.
- "Reset script from template" stays unbuilt.
- The preview rail's 1440 step narrows the measure, not the rail.

_166 decisions in all._
