import "server-only";

import type { createClient } from "@/lib/supabase/server";

import { MAX_PAST_TITLES } from "./prompts";
import { CONCEPTS_WANT, TITLES_WANT } from "./clamp";
import {
  AssistError,
  type AssistRequest,
  type ChannelContext,
  type ThumbnailVerdict,
  type VideoContext,
} from "./types";

/**
 * What an assist's prompt is built from, read with the caller's own
 * RLS-scoped client (M11).
 *
 * The one read both paths share: `assist()` and `critiqueThumbnails()` in
 * `app/actions/assist.ts` call it before asking the API, and Open in Claude's
 * actions (`app/actions/assist-manual.ts`) call it before writing the prompt
 * a person pastes into claude.ai. So both ask from exactly the same inputs:
 * the video's title, hook, notes, tags and written concept; the channel's
 * name and voice guide; its last fifty published titles; and what the video
 * already has, so the answer does not repeat it and the clamp can drop what
 * does. (It began as a copy of `askFor`'s reads, made while another M11 slice
 * was rewriting that file; the integration pass made it the only copy.)
 *
 * Server-only: it is the read that assembles the voice guide and the titles.
 */

/** The request's own client, as `requireUser()` hands it out. */
type Client = Awaited<ReturnType<typeof createClient>>;

export type TextKind = "titles" | "concepts" | "hooks";

/**
 * How many of each to ask for.
 *
 * PLAN.md: 10–20 title candidates. Concepts are four, which is
 * `CONCEPTS_WANT` in `lib/assist/clamp.ts` and the number the concept panel is
 * built around: the concept is a *single* field, so the job is to give
 * somebody three or four genuinely different pictures to choose between, not
 * twenty paragraphs to read.
 *
 * **Hooks are not in here**, and that is the fix for an M8 review finding.
 * Pinning them at `HOOKS_MAX` made `wantedFor`'s hooks branch in
 * `lib/assist/clamp.ts` unreachable — that branch only runs when `want` is
 * left undefined — so a video with two hooks written was offered three
 * proposals the column had no room for. Leaving `want` out is what makes "ask
 * for how many are missing" the rule that actually ships, on both paths.
 */
const WANT: Record<"titles" | "concepts", number> = {
  titles: TITLES_WANT,
  concepts: CONCEPTS_WANT,
};

interface VideoRow {
  id: string;
  title: string;
  one_line_hook: string | null;
  notes: string | null;
  tags: string[] | null;
  thumbnail_concept: string | null;
  title_candidates?: unknown;
  hooks?: unknown;
  channel_id: string;
  thumb_wild_card_path?: string | null;
  thumb_moderate_path?: string | null;
  thumb_safe_path?: string | null;
}

export interface LoadedText {
  readonly request: AssistRequest;
  /** Whether the channel had a voice guide — stored with the answer. */
  readonly voiceGuide: boolean;
}

/** The request for one of the three text assists, or the error to show. */
export async function loadTextRequest(
  supabase: Client,
  videoId: string,
  kind: TextKind,
): Promise<LoadedText> {
  const { data, error } = await supabase
    .from("videos")
    .select(
      "id, title, one_line_hook, notes, tags, thumbnail_concept, title_candidates, hooks, channel_id",
    )
    .eq("id", videoId)
    .maybeSingle();

  if (error) throw new AssistError("unreachable", { detail: error.message });
  // No row means no row *for this user*; RLS does not say which.
  if (!data) {
    throw new AssistError("rejected", {
      message: "That video is not one you can ask about.",
    });
  }
  const video = data as VideoRow;

  const [{ data: channel }, { data: published }] = await Promise.all([
    supabase
      .from("channels")
      .select("name, voice_guide")
      .eq("id", video.channel_id)
      .maybeSingle(),
    supabase
      .from("videos")
      .select("title, published_at")
      .eq("channel_id", video.channel_id)
      .not("published_at", "is", null)
      .order("published_at", { ascending: false })
      .limit(MAX_PAST_TITLES),
  ]);

  const channelContext = channelContextOf(
    channel as { name: string; voice_guide: string | null } | null,
    pastTitlesOf(published as { title: string | null }[] | null),
  );

  const existing =
    kind === "hooks"
      ? textsOf(video.hooks)
      : kind === "titles"
        ? textsOf(video.title_candidates)
        : conceptTexts(video.thumbnail_concept);

  const request: AssistRequest =
    kind === "hooks"
      ? { kind: "hooks", existing, video: videoContextOf(video), channel: channelContext }
      : {
          kind,
          want: WANT[kind],
          existing,
          video: videoContextOf(video),
          channel: channelContext,
        };

  return { request, voiceGuide: channelContext.voiceGuide !== null };
}

/** One uploaded variant, for the manual critique: its role and object path. */
export interface UploadedVariant {
  readonly role: ThumbnailVerdict["role"];
  readonly path: string;
}

export interface LoadedCritique {
  /** A critique request whose variants carry no bytes: the person attaches them. */
  readonly request: Extract<AssistRequest, { kind: "thumbnail_critique" }>;
  readonly uploaded: readonly UploadedVariant[];
}

const ROLES: readonly ThumbnailVerdict["role"][] = ["wild_card", "moderate", "safe"];

/**
 * The critique's inputs without the bytes.
 *
 * The API path downloads the images and sends them; the manual path cannot
 * attach anything to a claude.ai conversation, so it needs only which slots
 * hold an image (for the prompt, and for the links the panel offers) and the
 * same title, concept and voice guide. No past titles, as in
 * `critiqueThumbnails`: a verdict on legibility is not written in a voice.
 */
export async function loadCritiqueRequest(
  supabase: Client,
  videoId: string,
): Promise<LoadedCritique> {
  const { data, error } = await supabase
    .from("videos")
    .select(
      "id, title, one_line_hook, notes, tags, thumbnail_concept, channel_id, thumb_wild_card_path, thumb_moderate_path, thumb_safe_path",
    )
    .eq("id", videoId)
    .maybeSingle();

  if (error) throw new AssistError("unreachable", { detail: error.message });
  if (!data) {
    throw new AssistError("rejected", {
      message: "That video is not one you can ask about.",
    });
  }
  const video = data as VideoRow;

  const { data: channel } = await supabase
    .from("channels")
    .select("name, voice_guide")
    .eq("id", video.channel_id)
    .maybeSingle();

  const pathOf: Record<ThumbnailVerdict["role"], string | null | undefined> = {
    wild_card: video.thumb_wild_card_path,
    moderate: video.thumb_moderate_path,
    safe: video.thumb_safe_path,
  };
  const uploaded = ROLES.flatMap((role) => {
    const path = pathOf[role];
    return typeof path === "string" && path !== "" ? [{ role, path }] : [];
  });

  if (uploaded.length === 0) {
    throw new AssistError("rejected", {
      message:
        "There is nothing to critique yet — upload at least one of the three variants first.",
    });
  }

  return {
    request: {
      kind: "thumbnail_critique",
      variants: uploaded.map(({ role }) => ({
        role,
        mediaType: "image/png" as const,
        base64: "",
      })),
      video: videoContextOf(video),
      channel: channelContextOf(
        channel as { name: string; voice_guide: string | null } | null,
        [],
      ),
    },
    uploaded,
  };
}

/* -------------------------------------------------------------------------- */
/* The same small readers `app/actions/assist.ts` uses                          */
/* -------------------------------------------------------------------------- */

function channelContextOf(
  channel: { name: string; voice_guide: string | null } | null,
  pastTitles: string[],
): ChannelContext {
  const voiceGuide = channel?.voice_guide?.trim() ?? "";
  return {
    name: channel?.name ?? "this channel",
    voiceGuide: voiceGuide === "" ? null : voiceGuide,
    pastTitles,
  };
}

function videoContextOf(video: VideoRow): VideoContext {
  return {
    title: video.title,
    oneLineHook: video.one_line_hook,
    notes: video.notes,
    tags: video.tags ?? [],
    thumbnailConcept: video.thumbnail_concept,
  };
}

function conceptTexts(concept: string | null): string[] {
  const written = (concept ?? "").trim();
  return written === "" ? [] : [written];
}

function pastTitlesOf(rows: { title: string | null }[] | null): string[] {
  return (rows ?? [])
    .map((row) => row.title)
    .filter((title): title is string => typeof title === "string" && title !== "");
}

function textsOf(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) =>
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as { text?: unknown }).text === "string"
        ? (entry as { text: string }).text.trim()
        : "",
    )
    .filter((text) => text !== "");
}
