import { describe, expect, it } from "vitest";

import { NewViewersNoteSchema } from "./metrics";
import { HookSchema, SkipReasonSchema, TitleCandidateSchema } from "./packaging";
import {
  NotesSchema,
  TagListSchema,
  ThumbnailConceptSchema,
  WaitingOnSchema,
  WorkingTitleSchema,
} from "./video-fields";

/**
 * The NUL byte on the video page's own text fields — the M7 review's deferred
 * item, closed in M9.
 *
 * Postgres refuses U+0000 in every `text` column (and inside `jsonb`) with
 * "invalid byte sequence for encoding \"UTF8\": 0x00", and that sentence used
 * to be what a person saw after pasting from a source that carries one. The
 * settings screens already went through `lib/text.ts`; these are the video
 * page's schemas, which did not. Each one now drops the byte and keeps every
 * other character exactly as typed — including the zero-width ones, which are
 * content in prose (`cleanProse`, not `cleanLabel`).
 */
const NUL = "\u0000";

describe("the video page's text fields drop the NUL byte and nothing else", () => {
  it("working title", () => {
    expect(WorkingTitleSchema.parse(`Desk${NUL} tour`)).toBe("Desk tour");
  });

  it("the nullable prose fields", () => {
    expect(NotesSchema.parse(`B-roll${NUL}: desk`)).toBe("B-roll: desk");
    expect(ThumbnailConceptSchema.parse(`Me${NUL}, pointing`)).toBe("Me, pointing");
    expect(WaitingOnSchema.parse(`${NUL}editor`)).toBe("editor");
    // A field that was only a NUL is an emptied field, which is NULL.
    expect(NotesSchema.parse(NUL)).toBeNull();
  });

  it("keeps a zero-width joiner, which is content in prose", () => {
    const family = "\u{1F468}‍\u{1F469}";
    expect(NotesSchema.parse(`${family}${NUL}`)).toBe(family);
  });

  it("tags", () => {
    expect(TagListSchema.parse([`money${NUL}`])).toEqual(["money"]);
  });

  it("title candidates, their notes, and hooks (jsonb refuses it too)", () => {
    const candidate = TitleCandidateSchema.parse({
      id: "c1",
      text: `Ten${NUL} minutes`,
      note: `sells${NUL} the result`,
    });
    expect(candidate.text).toBe("Ten minutes");
    expect(candidate.note).toBe("sells the result");
    expect(HookSchema.parse({ id: "h1", text: `Stop${NUL}.` }).text).toBe("Stop.");
  });

  it("the skip reason and the new-viewers note", () => {
    expect(SkipReasonSchema.parse(`Filming${NUL} a live event today`)).toBe(
      "Filming a live event today",
    );
    expect(NewViewersNoteSchema.parse(`mostly${NUL} new`)).toBe("mostly new");
  });
});
