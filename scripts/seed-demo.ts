/**
 * Dev-only demo seed: one user, two fully seeded channels, and the 8-video week
 * PLAN.md's fixture describes — every milestone's adversarial review starts from
 * it, so it also carries the rows M3's review names (a video published 25h ago
 * with no metrics, a Scheduled video for next Tuesday, a finished Packaging
 * video, and a bank of ideas).
 *
 * ## It cannot run in this repository's check environment
 *
 * This script talks to a real Supabase project over HTTPS — GoTrue for
 * `auth.admin.createUser`, PostgREST for the rows. `scripts/verify-db.sh` runs
 * the schema against a bare PostgreSQL server with neither of those services in
 * front of it, so there is nothing here for this script to point at and it is
 * never executed by the checks. It is typechecked and linted like every other
 * file, and that is all the assurance this file has: treat the first real run
 * against a fresh `supabase start` (or a throwaway hosted project) as its test.
 *
 * ## Running it
 *
 *   set -a; source .env.local; set +a; npx tsx scripts/seed-demo.ts
 *
 * or just `npx tsx scripts/seed-demo.ts` — it loads `.env.local` itself when
 * one is there. Either way it refuses to start unless every variable it needs
 * is set; there are no defaults and no fallback to a hard-coded project.
 *
 * ## Why every insert spells out user_id
 *
 * The service-role key bypasses RLS, which is the point (it has to create the
 * user before anyone can sign in). But it also means `auth.uid()` is NULL, so
 * the `user_id uuid not null default auth.uid()` on every table would fail the
 * NOT NULL check. Each row therefore carries `user_id` explicitly. See PLAN.md.
 *
 * ## Never point this at production
 *
 * It holds the service-role key and creates an account with a password you put
 * in a file. Local stack or a scratch project only.
 */

import { createClient } from "@supabase/supabase-js";

import type { Database } from "../lib/database.types";
import {
  CHANNEL_DEFAULTS,
  SCRIPT_TEMPLATE,
  SEED_BUCKETS,
  SEED_CHECKLISTS,
  SEED_STAGES,
  type SeedChecklistItem,
  type StageKind,
} from "../lib/defaults";
import { slugify } from "../lib/slug";
import { addDays, canonicalTimeZone, todayColumn, UTC, weekdayIndex } from "../lib/calendar-dates";

/** The two channels PLAN.md's fixture assumes: a main channel and a side one. */
const MAIN = "Main channel";
const DEMO_CHANNELS = [MAIN, "Side channel"] as const;

/** Where a channel's seeded stages live, keyed by kind. */
type StageIds = { channelId: string; byKind: Record<StageKind, string> };

const REQUIRED_ENV = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SEED_EMAIL",
  "SEED_PASSWORD",
] as const;

type RequiredEnv = Record<(typeof REQUIRED_ENV)[number], string>;

/**
 * Read the four variables, or refuse to run. Nothing is defaulted: a seed
 * script that guesses its target is a seed script that eventually writes to the
 * wrong database.
 */
function readEnv(): RequiredEnv {
  // Node reads .env.local for us when there is one; absent is fine, since the
  // variables may equally come from the shell.
  try {
    process.loadEnvFile(".env.local");
  } catch {
    // No .env.local — the check below is what actually decides.
  }

  const missing = REQUIRED_ENV.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    console.error(
      `scripts/seed-demo.ts needs ${missing.join(", ")}.\n` +
        "Copy .env.example to .env.local and fill it in, or export them in your shell.",
    );
    process.exit(1);
  }

  return Object.fromEntries(
    REQUIRED_ENV.map((name) => [name, process.env[name] as string]),
  ) as RequiredEnv;
}

async function main(): Promise<void> {
  const env = readEnv();

  const supabase = createClient<Database>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.SUPABASE_SERVICE_ROLE_KEY,
    // A script, not a browser: no session to persist and nothing to refresh.
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  const userId = await ensureUser(supabase, env.SEED_EMAIL, env.SEED_PASSWORD);
  console.log(`user ${env.SEED_EMAIL} -> ${userId}`);

  for (const name of DEMO_CHANNELS) {
    const slug = slugify(name);

    const { data: existing, error: lookupError } = await supabase
      .from("channels")
      .select("id")
      .eq("user_id", userId)
      .eq("slug", slug)
      .maybeSingle();
    if (lookupError) throw new Error(lookupError.message);

    if (existing) {
      console.log(`channel ${slug} already exists — left alone`);
      continue;
    }

    const stages = await createSeededChannel(supabase, userId, name, slug);
    const videos = await seedVideos(supabase, userId, stages, name === MAIN);
    console.log(`channel ${slug} created and seeded (${videos} videos)`);
  }

  console.log("done. Sign in at /login with SEED_EMAIL and SEED_PASSWORD.");
}

/**
 * Create the demo account, or return the id of the one already there.
 *
 * `auth.admin.createUser` with `email_confirm: true` skips the confirmation
 * mail, which nothing would deliver locally anyway.
 */
async function ensureUser(
  supabase: ReturnType<typeof createClient<Database>>,
  email: string,
  password: string,
): Promise<string> {
  const { data, error } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });

  if (!error && data.user) {
    return data.user.id;
  }

  // Re-running the script is normal, so an account that already exists is not
  // an error: find it and carry on.
  const { data: list, error: listError } = await supabase.auth.admin.listUsers({
    perPage: 200,
  });
  if (listError) {
    throw new Error(
      `could not create ${email} (${error?.message ?? "no user returned"}) ` +
        `and could not list users either (${listError.message})`,
    );
  }

  const found = list.users.find((user) => user.email === email);
  if (!found) {
    throw new Error(
      `could not create ${email}: ${error?.message ?? "no user returned"}`,
    );
  }

  return found.id;
}

/**
 * The same seed `createChannel` applies, from the same `lib/defaults.ts`: the
 * channel, its nine stages, a checklist template per stage and the buckets.
 *
 * Unlike the server action this does not roll back on failure — it throws, and
 * a demo database is meant to be thrown away and re-seeded.
 */
async function createSeededChannel(
  supabase: ReturnType<typeof createClient<Database>>,
  userId: string,
  name: string,
  slug: string,
): Promise<StageIds> {
  const { data: channel, error: channelError } = await supabase
    .from("channels")
    .insert({
      user_id: userId,
      name,
      slug,
      script_template: SCRIPT_TEMPLATE,
      wip_threshold: CHANNEL_DEFAULTS.wip_threshold,
      stale_days: CHANNEL_DEFAULTS.stale_days,
      expected_ctr: CHANNEL_DEFAULTS.expected_ctr,
      voice_guide: CHANNEL_DEFAULTS.voice_guide,
    })
    .select("id")
    .single();
  if (channelError) throw new Error(`channel ${slug}: ${channelError.message}`);

  const { data: stages, error: stagesError } = await supabase
    .from("stages")
    .insert(
      SEED_STAGES.map((stage) => ({
        user_id: userId,
        channel_id: channel.id,
        name: stage.name,
        kind: stage.kind,
        position: stage.position,
      })),
    )
    .select("id, kind");
  if (stagesError) throw new Error(`stages for ${slug}: ${stagesError.message}`);

  const templates = SEED_STAGES.flatMap((seed) => {
    const stage = stages.find((row) => row.kind === seed.kind);
    if (!stage) return [];
    const items: readonly SeedChecklistItem[] = SEED_CHECKLISTS[seed.kind];
    return items.map((item, index) => ({
      user_id: userId,
      stage_id: stage.id,
      text: item.text,
      position: index + 1,
      est_minutes: item.est_minutes,
    }));
  });

  if (templates.length > 0) {
    const { error } = await supabase
      .from("checklist_templates")
      .insert(templates);
    if (error) throw new Error(`templates for ${slug}: ${error.message}`);
  }

  const { error: bucketsError } = await supabase.from("buckets").insert(
    SEED_BUCKETS.map((bucket) => ({
      user_id: userId,
      channel_id: channel.id,
      axis: bucket.axis,
      name: bucket.name,
      position: bucket.position,
    })),
  );
  if (bucketsError) throw new Error(`buckets for ${slug}: ${bucketsError.message}`);

  const byKind = {} as Record<StageKind, string>;
  for (const seed of SEED_STAGES) {
    const stage = stages.find((row) => row.kind === seed.kind);
    if (!stage) throw new Error(`stages for ${slug}: ${seed.kind} is missing`);
    byKind[seed.kind] = stage.id;
  }

  return { channelId: channel.id, byKind };
}

/* -------------------------------------------------------------------------- */
/* The 8-video week                                                            */
/* -------------------------------------------------------------------------- */

/**
 * PLAN.md's fixture: "two channels and the 8-video week". Every milestone's
 * review starts from it, and M3's review names specific rows — a video
 * published 25h ago with no metrics logged (must read as Overdue), a Scheduled
 * video for next Tuesday (Waiting), a Packaging video with everything filled (a
 * Move row that succeeds), and a bank of ideas that contributes nothing to
 * `/now` at all.
 *
 * The main channel gets the eight in-flight videos and twenty ideas; the side
 * channel gets ten ideas, so the cross-channel filters have something to bite
 * on. Rows are written with the service role, which is why `stage_id`,
 * `stage_entered_at` and `published_at` can be set directly here — from a
 * client those columns belong to `move_video` alone.
 */
async function seedVideos(
  supabase: ReturnType<typeof createClient<Database>>,
  userId: string,
  stages: StageIds,
  isMain: boolean,
): Promise<number> {
  const { channelId, byKind } = stages;
  const rows: VideoSeed[] = isMain ? weekVideos() : [];

  const ideas = isMain ? MAIN_IDEAS : SIDE_IDEAS;
  rows.push(
    ...ideas.map((title, index) => ({
      kind: "idea" as StageKind,
      title,
      // Spread the bank over the past month so /ideas has a real sort order.
      stage_entered_at: daysAgo(index + 1),
    })),
  );

  const { data: inserted, error } = await supabase
    .from("videos")
    .insert(
      rows.map((row) => {
        const { kind, ...rest } = row;
        return {
          ...rest,
          user_id: userId,
          channel_id: channelId,
          stage_id: byKind[kind],
        };
      }),
    )
    .select("id, stage_id");
  if (error) throw new Error(`videos: ${error.message}`);

  await snapshotChecklists(supabase, userId, channelId, inserted);
  return inserted.length;
}

/** One seeded video: its stage kind, plus whatever columns it needs set. */
type VideoSeed = { kind: StageKind } & Omit<
  Database["public"]["Tables"]["videos"]["Insert"],
  "user_id" | "channel_id" | "stage_id"
>;

function weekVideos(): VideoSeed[] {
  const chosenHook = (text: string) => [{ id: "h1", text, chosen: true }];

  return [
    {
      kind: "packaging",
      title: "I tried the 5am club for 30 days",
      thumbnail_concept: "Split frame: day 1 wreck vs day 30, alarm clock big",
      hooks: chosenHook("Day 30 was not what I expected."),
      title_candidates: [
        {
          id: "t1",
          text: "I tried the 5am club for 30 days",
          note: "",
          chosen: true,
          source: "manual",
        },
        {
          id: "t2",
          text: "30 days of 5am: what actually changed",
          note: "runner-up",
          chosen: false,
          source: "manual",
        },
      ],
      stage_entered_at: daysAgo(2),
    },
    {
      kind: "packaging",
      // Deliberately unfinished: this is the row /now nags about.
      title: "Cheap mic shootout",
      stage_entered_at: daysAgo(9),
    },
    {
      kind: "scripting",
      title: "The note-taking setup I actually kept",
      thumbnail_concept: "Desk from above, one notebook circled",
      hooks: chosenHook("Every app I tried failed for the same reason."),
      script_structure: "three_part",
      stage_entered_at: daysAgo(3),
    },
    {
      kind: "filming",
      title: "Why my first 50 videos flopped",
      thumbnail_concept: "Analytics flatline, face to camera",
      hooks: chosenHook("Fifty videos, nine subscribers."),
      stage_entered_at: daysAgo(4),
      // Paired by a CHECK since 0004_waiting_since.sql: a block always says
      // when it started, so /now can show its age rather than guess one.
      waiting_on: "a quiet evening to film",
      waiting_since: daysAgo(4),
    },
    {
      kind: "editing",
      title: "A week of batching, honestly reviewed",
      thumbnail_concept: "Four shirts on hangers, one day on the calendar",
      hooks: chosenHook("I filmed a month of videos in one Saturday."),
      stage_entered_at: daysAgo(6),
    },
    {
      kind: "publish_prep",
      title: "The only three YouTube metrics I look at",
      thumbnail_concept: "Three dials, two greyed out",
      hooks: chosenHook("Most of the dashboard is noise."),
      stage_entered_at: daysAgo(1),
    },
    {
      kind: "scheduled",
      title: "How I plan a week of filming in 20 minutes",
      thumbnail_concept: "Calendar with one block filled in",
      hooks: chosenHook("Twenty minutes on Sunday buys back the week."),
      target_publish_date: nextTuesday(),
      stage_entered_at: daysAgo(2),
    },
    {
      kind: "published",
      title: "I deleted my second channel",
      thumbnail_concept: "Two logos, one crossed out",
      hooks: chosenHook("Two channels was one too many."),
      // 25 hours ago with no metrics logged: /now must call this Overdue.
      published_at: hoursAgo(25),
      stage_entered_at: hoursAgo(25),
      youtube_url: "https://www.youtube.com/watch?v=seed0000001",
    },
  ];
}

const MAIN_IDEAS = [
  "Desk tour, but only what earns its place",
  "The cheapest camera that still looks professional",
  "Batch filming: what I get wrong every time",
  "Reading my first video's comments",
  "A month of no shorts",
  "Editing on a laptop from 2016",
  "How long a video actually takes me",
  "Titles I rejected and why",
  "The thumbnail that doubled my CTR",
  "Why I stopped chasing the algorithm",
  "My whole workflow in one page",
  "Answering the questions I get most",
  "A week in the life of a part-time creator",
  "The gear I regret buying",
  "Scripting vs winging it: a fair test",
  "What 100 subscribers actually feels like",
  "Lighting with one lamp",
  "Audio fixes that cost nothing",
  "How I pick what to make next",
  "The video I have been avoiding",
];

const SIDE_IDEAS = [
  "Side channel: the format experiment",
  "Side channel: reading old notes",
  "Side channel: one tool, one week",
  "Side channel: the shortest useful video",
  "Side channel: replying to a comment properly",
  "Side channel: what did not work",
  "Side channel: a quiet vlog",
  "Side channel: the backlog",
  "Side channel: a tiny tutorial",
  "Side channel: end-of-month review",
];

/**
 * The snapshot `move_video` would have taken on entry to each stage. The seed
 * cannot call that function: it runs as the service role, where `auth.uid()` is
 * NULL and the function's ownership check finds nothing.
 */
async function snapshotChecklists(
  supabase: ReturnType<typeof createClient<Database>>,
  userId: string,
  channelId: string,
  videos: { id: string; stage_id: string }[],
): Promise<void> {
  const { data: templates, error } = await supabase
    .from("checklist_templates")
    .select("stage_id, text, position, est_minutes")
    .in("stage_id", [...new Set(videos.map((v) => v.stage_id))]);
  if (error) throw new Error(`checklist templates: ${error.message}`);

  const items = videos.flatMap((video) =>
    templates
      .filter((template) => template.stage_id === video.stage_id)
      .map((template) => ({
        user_id: userId,
        video_id: video.id,
        channel_id: channelId,
        stage_id: video.stage_id,
        text: template.text,
        position: template.position,
        est_minutes: template.est_minutes,
      })),
  );

  if (items.length === 0) return;
  const { error: itemsError } = await supabase
    .from("checklist_items")
    .insert(items);
  if (itemsError) throw new Error(`checklist items: ${itemsError.message}`);
}

function hoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 3600_000).toISOString();
}

function daysAgo(days: number): string {
  return hoursAgo(days * 24);
}

/**
 * The next Tuesday strictly after today, as a `date` string.
 *
 * Through `lib/calendar-dates.ts`, like every other `date` column in this
 * codebase. The version this replaces mixed zones: it read `getDay()` and
 * `setDate()` in the machine's local zone and then serialised with
 * `toISOString().slice(0, 10)` in UTC, so for part of every day the function
 * named "the next Tuesday" wrote a Monday or a Wednesday into
 * `videos.target_publish_date` — the column the calendar, the sidebar badge and
 * the matrix quota all key off. `TZ=Pacific/Kiritimati` reproduced it.
 *
 * `weekdayIndex` counts from Monday, so Tuesday is 1, and `|| 7` keeps the
 * "strictly after" in "the next Tuesday" when today is one.
 */
function nextTuesday(): string {
  // "Today" where the person running the seed is (M10): a script is not a
  // render, so the machine's own zone is the honest answer here, canonicalised
  // the way the app stores one and UTC when it is not a zone the app accepts.
  const zone =
    canonicalTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone) ?? UTC;
  const today = todayColumn(Date.now(), zone);
  const weekday = weekdayIndex(today);
  if (weekday === null) return today;
  const ahead = (1 - weekday + 7) % 7 || 7;
  return addDays(today, ahead) ?? today;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
