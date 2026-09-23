import { describe, expect, it } from "vitest";

import {
  readStoredBrainstorm,
  withEntry,
  type StoredAssistEntryValue,
} from "./stored";

/**
 * `videos.brainstorm_last`'s envelope: what it accepts, and — the part the M8
 * review turned into a blocker — what it must refuse.
 */

function entry(
  texts: readonly string[],
  over: Partial<StoredAssistEntryValue> = {},
): StoredAssistEntryValue {
  return {
    at: "2026-01-01T00:00:00.000Z",
    provider: "fake",
    model: "fixtures",
    voiceGuide: false,
    suggestions: texts.map((text) => ({ text, rationale: "because" })),
    recommended: texts.length > 0 ? 0 : null,
    recommendedReason: texts.length > 0 ? "It names a cost." : null,
    ...over,
  };
}

describe("withEntry", () => {
  it("keeps the other kinds untouched", () => {
    const current = readStoredBrainstorm({ v: 1, titles: entry(["A title"]) });
    const next = withEntry(current, "hooks", entry(["A hook"]));

    expect(next.titles?.suggestions[0].text).toBe("A title");
    expect(next.hooks?.suggestions[0].text).toBe("A hook");
    expect(next.v).toBe(1);
  });

  it("refuses to replace a kept answer with an empty one", () => {
    /*
      The backstop for the blocker. An entry with no suggestions reads back as
      *absent* (`usable` in stored.ts), so writing one does not store an empty
      answer — it destroys the answer that was there, while the call that wrote
      it reports success. `lib/assist/clamp.ts` refuses to produce one at all
      now; this makes the envelope refuse to carry one even if something else
      ever does.
    */
    const current = readStoredBrainstorm({ v: 1, titles: entry(["A title"]) });
    const next = withEntry(current, "titles", entry([]));

    expect(next.titles?.suggestions).toHaveLength(1);
    expect(next.titles?.suggestions[0].text).toBe("A title");
  });

  it("leaves a kind absent when an empty answer is all there has ever been", () => {
    const next = withEntry(readStoredBrainstorm(null), "titles", entry([]));
    expect(next.titles).toBeUndefined();
  });
});

describe("readStoredBrainstorm", () => {
  it("reads a row written before recommendedReason existed", () => {
    // Every key optional, read leniently: a row from an older build has to
    // render, not throw. The pick survives; it simply has no comparison.
    const view = readStoredBrainstorm({
      v: 1,
      titles: {
        at: "2026-01-01T00:00:00.000Z",
        provider: "anthropic",
        model: "claude-opus-5",
        voiceGuide: true,
        suggestions: [{ text: "A title", rationale: "because" }],
        recommended: 0,
      },
    });

    expect(view.titles?.recommended).toBe(0);
    expect(view.titles?.recommendedReason).toBeNull();
  });

  it("drops a comparison whose pick no longer points anywhere", () => {
    const view = readStoredBrainstorm({
      v: 1,
      titles: entry(["A title"], { recommended: 7, recommendedReason: "Orphaned." }),
    });

    expect(view.titles?.recommended).toBeNull();
    expect(view.titles?.recommendedReason).toBeNull();
  });

  it("reads an unparseable column as nothing rather than throwing", () => {
    expect(readStoredBrainstorm("not an envelope").titles).toBeNull();
    expect(readStoredBrainstorm(undefined).hooks).toBeNull();
  });
});
