"use client";

import { useId, useMemo, useState } from "react";

import type { VideoState } from "@/app/actions/videos";
import { SaveStatus, useSaveQueue } from "@/components/autosave";
import { useVideoVersion } from "@/components/video-version";
import { MAX_TAG_LENGTH, MAX_TAGS, TagListSchema } from "@/lib/video-fields";

import { saveFiling } from "./save-filing";

/** How many of the channel's existing tags are offered as one-click chips. */
const SUGGESTION_LIMIT = 12;

/**
 * `videos.tags`, with an editor rather than a comma-separated box.
 *
 * ## Why the vocabulary is on screen
 *
 * A tag box on its own produces `tutorial`, `tutorials`, `Tutorial` and
 * `tutorial ` inside a month, and then the bank's tag filter has four chips
 * that each find a quarter of what you meant. BRIEF.md asks for tags so an idea
 * can be *found again*, which is a property of the vocabulary and not of any one
 * video — so the tags this channel already uses are right here, as chips to
 * click and as the input's own autocomplete. Converging is the path of least
 * effort, which is the only kind of convergence that happens.
 *
 * The suggestions are the channel's, not the account's: two channels are two
 * audiences with two vocabularies, and `videos.tags` is scoped by channel
 * everywhere it is read.
 *
 * ## What it refuses, and where
 *
 * De-duplication, trimming, the twenty-tag ceiling and the forty-character one
 * are `TagListSchema` in `lib/video-fields.ts` — the same schema `updateVideo`
 * validates with and the same one capture's comma box pipes into. This
 * component calls it rather than re-implementing it, so a tag that is refused
 * here is refused there for the same reason and with the same words.
 *
 * Case-insensitive de-duplication is what makes `Tutorial` and `tutorial` one
 * tag; the spelling that was already there wins, because it is the one the
 * filter chips are already showing.
 */
export function TagEditor({
  videoId,
  initial,
  vocabulary,
  onSaved,
}: {
  videoId: string;
  /** `videos.tags` as the server render read it. */
  initial: readonly string[];
  /** Every tag used by this channel's videos, in use-count order. */
  vocabulary: readonly string[];
  onSaved?: (video: VideoState) => void;
}) {
  const version = useVideoVersion();
  const inputId = useId();
  const listId = `${inputId}-vocabulary`;

  /** What the row last confirmed; where the screen goes back to on a refusal. */
  const [confirmed, setConfirmed] = useState<readonly string[]>(initial);
  /** What is on screen — ahead of the row while a save is in flight. */
  const [shown, setShown] = useState<readonly string[]>(initial);
  const [draft, setDraft] = useState("");
  /** A refusal this component made itself, before any round trip. */
  const [refusal, setRefusal] = useState<string | null>(null);

  const { state, pending, send, touch } = useSaveQueue<readonly string[]>({
    // A list patch *is* its value, so a queued save is replaced rather than
    // merged — the same rule `useAutosave` uses for a text field.
    merge: (_queued, next) => next,
    save: async (tags) =>
      saveFiling(videoId, version, { tags }, (video) => {
        setConfirmed(video.tags);
        setShown(video.tags);
        onSaved?.(video);
      }),
    onFailure: () => setShown(confirmed),
  });

  /** The channel's tags this video does not already carry. */
  const suggestions = useMemo(() => {
    const mine = new Set(shown.map((tag) => tag.toLocaleLowerCase()));
    return vocabulary
      .filter((tag) => !mine.has(tag.toLocaleLowerCase()))
      .slice(0, SUGGESTION_LIMIT);
  }, [shown, vocabulary]);

  /**
   * Put a list on screen and on the wire, or say why not.
   *
   * Every change — adding, removing, clicking a suggestion — goes through here
   * with the *whole* list, because that is what the column holds and what the
   * queue can merge safely.
   */
  function commit(next: readonly string[]): boolean {
    const parsed = TagListSchema.safeParse([...next]);
    if (!parsed.success) {
      setRefusal(parsed.error.issues[0].message);
      return false;
    }
    setRefusal(null);
    touch();
    setShown(parsed.data);
    send(parsed.data);
    return true;
  }

  function add(raw: string): void {
    const tag = raw.trim();
    if (tag === "") return;

    if (tag.length > MAX_TAG_LENGTH) {
      setRefusal(`Each tag has to be ${MAX_TAG_LENGTH} characters or fewer.`);
      return;
    }
    if (shown.some((existing) => existing.toLocaleLowerCase() === tag.toLocaleLowerCase())) {
      // Not an error worth a red line: the tag is already on the video, which
      // is what the person wanted. Clear the box and say so quietly.
      setRefusal(`“${tag}” is already on this video.`);
      setDraft("");
      return;
    }
    if (commit([...shown, tag])) setDraft("");
  }

  function remove(tag: string): void {
    commit(shown.filter((existing) => existing !== tag));
  }

  const full = shown.length >= MAX_TAGS;

  return (
    <div className="flex flex-col gap-2" data-testid="tag-editor">
      <div className="flex flex-col gap-1">
        <label htmlFor={inputId} className="text-xs font-medium text-muted">
          Tags
        </label>

        {shown.length > 0 ? (
          <ul data-testid="tag-list" className="flex flex-wrap gap-1.5 py-0.5">
            {shown.map((tag) => (
              <li
                key={tag}
                data-testid="tag-chip"
                data-tag={tag}
                className="inline-flex items-center gap-1 rounded-full border border-border bg-surface py-0.5 pr-1 pl-2.5 text-[13px]"
              >
                {tag}
                <button
                  type="button"
                  data-testid="tag-remove"
                  disabled={pending}
                  onClick={() => remove(tag)}
                  /* The tag is in the name because "Remove" on its own, read out
                     of a list of six, says nothing about which one. */
                  aria-label={`Remove the tag ${tag}`}
                  className="rounded-full px-1 leading-none text-muted outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-40"
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        ) : null}

        <div className="flex items-center gap-2">
          <input
            id={inputId}
            type="text"
            data-testid="tag-input"
            value={draft}
            list={listId}
            disabled={full}
            maxLength={MAX_TAG_LENGTH}
            autoComplete="off"
            placeholder={full ? `${MAX_TAGS} tags is the limit` : "Add a tag, then Enter"}
            onChange={(event) => {
              const value = event.target.value;
              // A comma is how people type a list, and the box used to be a
              // comma-separated one. Typing (or pasting) one finishes the tag
              // rather than becoming part of it.
              if (value.includes(",")) {
                const parts = value.split(",");
                const last = parts.pop() ?? "";
                for (const part of parts) add(part);
                setDraft(last.trim());
                return;
              }
              setDraft(value);
              if (refusal) setRefusal(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                // This editor lives inside no form, but Enter in a text box is
                // a submit everywhere else in the app; say what it does here.
                event.preventDefault();
                add(draft);
              } else if (event.key === "Backspace" && draft === "" && shown.length > 0) {
                // The convention every tag field has: backspace at an empty box
                // takes the last chip off.
                event.preventDefault();
                remove(shown[shown.length - 1]);
              }
            }}
            onBlur={() => {
              // A typed tag that was never Entered is still a tag the person
              // wrote. Losing it because they clicked elsewhere is the kind of
              // small betrayal that stops people using a field.
              if (draft.trim() !== "") add(draft);
            }}
            className="min-w-0 flex-1 rounded-input border border-border bg-background px-3 py-2 text-base outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50"
          />

          <button
            type="button"
            data-testid="tag-add"
            disabled={full || draft.trim() === ""}
            onClick={() => add(draft)}
            className="shrink-0 rounded-button border border-border px-3 py-2 text-sm outline-none hover:bg-foreground/5 focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-40"
          >
            Add
          </button>
        </div>

        {/* The whole vocabulary, as the browser's own autocomplete. The chips
            below are the short list; this is everything, for a channel that has
            more tags than chips worth drawing. */}
        <datalist id={listId} data-testid="tag-vocabulary">
          {vocabulary.map((tag) => (
            <option key={tag} value={tag} />
          ))}
        </datalist>
      </div>

      {suggestions.length > 0 && !full ? (
        <div className="flex flex-wrap items-baseline gap-1.5">
          <span className="text-xs text-muted">Used in this channel:</span>
          {suggestions.map((tag) => (
            <button
              key={tag}
              type="button"
              data-testid="tag-suggestion"
              data-tag={tag}
              disabled={pending}
              onClick={() => add(tag)}
              className="rounded-full border border-dashed border-border px-2.5 py-0.5 text-[13px] text-muted outline-none hover:border-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-40"
            >
              {tag}
            </button>
          ))}
        </div>
      ) : null}

      {/* Two lines, deliberately: what this component refused (a duplicate, a
          tag that is too long) is not what the *save* is doing, and collapsing
          them would mean a refusal erasing a "Saving…" or being erased by it. */}
      {refusal ? (
        <p role="alert" data-testid="tag-refusal" className="text-xs text-attention">
          {refusal}
        </p>
      ) : null}

      <SaveStatus
        state={state}
        testId="tag-status"
        idle={
          shown.length === 0
            ? "No tags yet. They are how the bank is searched later."
            : ""
        }
        onRetry={send}
      />
    </div>
  );
}
