import { describe, expect, it } from "vitest";

import { buildManualPrompt } from "./manual";
import { buildSystemPrompt, buildUserMessage } from "./prompts";
import { parseCritiqueReply, parseSuggestionsReply } from "./reply";
import {
  conceptsRequest,
  critiqueRequest,
  hooksRequest,
  titlesRequest,
  VOICE_GUIDE_ALPHA,
  VOICE_GUIDE_BETA,
} from "./test-fixtures";
import { ASSIST_KINDS, type AssistRequest } from "./types";

/**
 * The prompt a person pastes into claude.ai (M11).
 *
 * It is only worth having if it is as well-informed as the one the API key
 * pays for — so the first thing these hold it to is carrying the same voice
 * guide and the same published titles as `buildSystemPrompt`, from the same
 * source. The second is that it asks for the shape `reply.ts` reads, and says
 * plainly that an app will read it.
 */

const REQUESTS: Record<(typeof ASSIST_KINDS)[number], () => AssistRequest> = {
  titles: () => titlesRequest({ existing: ["A title I already wrote"] }),
  concepts: conceptsRequest,
  hooks: () => hooksRequest({ existing: ["An opening already written"] }),
  thumbnail_critique: () => critiqueRequest(),
};

describe("one brief, two prompts", () => {
  for (const kind of ASSIST_KINDS) {
    it(`carries the voice guide and the past titles for ${kind}, exactly as the API prompt does`, () => {
      const request = REQUESTS[kind]();
      const manual = buildManualPrompt(request);
      const api = buildSystemPrompt(request);

      expect(manual).toContain(VOICE_GUIDE_ALPHA.trim());
      expect(api).toContain(VOICE_GUIDE_ALPHA.trim());
      for (const title of request.channel.pastTitles) {
        expect(manual).toContain(`- ${title}`);
        expect(api).toContain(`- ${title}`);
      }
    });
  }

  it("shares the brief word for word: every section before the output is identical", () => {
    const request = titlesRequest();
    const api = buildSystemPrompt(request);
    const brief = api.slice(0, api.indexOf("## Output"));
    expect(buildManualPrompt(request).startsWith(brief.trimEnd())).toBe(true);
  });

  it("changes when the channel's guide changes, as the API prompt does", () => {
    const beta = buildManualPrompt(titlesRequest({ channel: { voiceGuide: VOICE_GUIDE_BETA } }));
    expect(beta).toContain(VOICE_GUIDE_BETA.trim());
    expect(beta).not.toContain(VOICE_GUIDE_ALPHA.trim());
  });

  it("says out loud when there is no guide, as the API prompt does", () => {
    expect(
      buildManualPrompt(titlesRequest({ channel: { voiceGuide: null } })),
    ).toContain("no voice guide written yet");
  });

  it("carries everything written on the video, and what not to repeat", () => {
    const request = titlesRequest({ existing: ["A title I already wrote"] });
    const manual = buildManualPrompt(request);
    for (const part of buildUserMessage(request).split("\n\n").slice(1)) {
      expect(manual).toContain(part);
    }
    expect(manual).toContain("A title I already wrote");
  });
});

describe("the shape it asks for", () => {
  it("asks for one proposal per line with its reason after ||, and a PICK line", () => {
    const prompt = buildManualPrompt(titlesRequest());
    expect(prompt).toContain("1. <the title> || <one sentence: why it works>");
    expect(prompt).toContain("PICK: <the number of the strongest>");
    expect(prompt).toContain("20 lines");
  });

  it("says plainly that an app will read the answer", () => {
    for (const kind of ASSIST_KINDS) {
      expect(buildManualPrompt(REQUESTS[kind]())).toContain(
        "I will copy your answer into an app that reads it line by line",
      );
    }
  });

  it("puts the answer's shape last, after the video", () => {
    const prompt = buildManualPrompt(titlesRequest());
    expect(prompt.indexOf("## The video")).toBeLessThan(prompt.indexOf("## How to answer"));
    expect(prompt.indexOf("## How to answer")).toBeGreaterThan(prompt.indexOf("Rules of the craft"));
  });

  it("asks for JSON nowhere", () => {
    for (const kind of ASSIST_KINDS) {
      const prompt = buildManualPrompt(REQUESTS[kind]());
      expect(prompt).not.toMatch(/JSON|schema|recommended_index|recommended_role/);
    }
  });

  it("asks for the hooks that are missing, one per line", () => {
    const prompt = buildManualPrompt(hooksRequest({ existing: ["One", "Two"] }));
    expect(prompt).toContain("Write 1 hook for");
    expect(prompt).toContain("One line, one proposal per line");
  });

  it("tells the concepts cap the code applies", () => {
    expect(buildManualPrompt(conceptsRequest())).toContain("Up to 6");
  });

  it("asks the person to attach the images, in order, and names them", () => {
    const prompt = buildManualPrompt(critiqueRequest(["wild_card", "safe"]));
    expect(prompt).toContain("I have attached 2 thumbnail images");
    expect(prompt).toContain("1. WILD CARD\n2. SAFE");
    expect(prompt).toContain("WILD CARD || reads: yes or no || adds: yes or no");
    expect(prompt).not.toContain("MODERATE ||");
    expect(prompt).toContain("SHIP: <wild card | safe | none>");
  });

  it("describes a shape its own parser reads", () => {
    // The example lines, filled in the way the prompt asks, read back.
    const titles = parseSuggestionsReply(
      "titles",
      "1. A title || why it works\n2. Another || why\nPICK: 2 || it beats the first",
    );
    expect(titles.payload.recommended_index).toBe(1);
    const critique = parseCritiqueReply(
      "WILD CARD || reads: yes || adds: no || act on this\nSHIP: wild card",
    );
    expect(critique.recommended_role).toBe("wild_card");
  });
});
