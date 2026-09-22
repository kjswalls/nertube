import { describe, expect, it } from "vitest";

import { buildSystemPrompt, buildUserMessage, MAX_PAST_TITLES } from "./prompts";
import {
  channelContext,
  conceptsRequest,
  critiqueRequest,
  hooksRequest,
  titlesRequest,
  VOICE_GUIDE_ALPHA,
  VOICE_GUIDE_BETA,
} from "./test-fixtures";

/**
 * BRIEF.md's one hard requirement for this feature beyond "make titles" is
 * that the per-channel voice guide conditions the output and that the result
 * is never generic-YouTuber voice. A prompt is not testable for taste, but it
 * is testable for whether the guide is *in* it, whether it is in it as the
 * governing instruction, and whether changing it changes what the model is
 * asked. That is what these assert.
 */

describe("the voice guide", () => {
  it("reaches the prompt verbatim", () => {
    const prompt = buildSystemPrompt(titlesRequest());

    expect(prompt).toContain(VOICE_GUIDE_ALPHA.trim());
  });

  it("arrives before the craft rules, and outranks them in as many words", () => {
    const prompt = buildSystemPrompt(titlesRequest());

    expect(prompt.indexOf("VOICE GUIDE")).toBeLessThan(
      prompt.indexOf("Rules of the craft"),
    );
    expect(prompt).toContain("the voice wins");
  });

  it("is fenced and labelled as material rather than as instructions", () => {
    const prompt = buildSystemPrompt(titlesRequest());

    expect(prompt).toContain("<<<VOICE GUIDE");
    expect(prompt).toContain("VOICE GUIDE>>>");
    expect(prompt).toContain("not instructions for you");
  });

  it("visibly changes the prompt when the channel's guide changes", () => {
    const alpha = buildSystemPrompt(titlesRequest());
    const beta = buildSystemPrompt(
      titlesRequest({ channel: { voiceGuide: VOICE_GUIDE_BETA } }),
    );

    expect(alpha).not.toEqual(beta);
    expect(beta).toContain(VOICE_GUIDE_BETA.trim());
    expect(beta).not.toContain(VOICE_GUIDE_ALPHA.trim());
  });

  it("says out loud when there is none, and refuses the default voice", () => {
    const prompt = buildSystemPrompt(
      titlesRequest({ channel: { voiceGuide: null } }),
    );

    expect(prompt).toContain("no voice guide written yet");
    expect(prompt).toContain("generic YouTube voice");
    expect(prompt).not.toContain("<<<VOICE GUIDE");
  });

  it("treats a guide of only invisible characters as no guide at all", () => {
    const prompt = buildSystemPrompt(
      titlesRequest({ channel: { voiceGuide: " ​⁠ " } }),
    );

    expect(prompt).toContain("no voice guide written yet");
  });
});

describe("the channel's evidence", () => {
  it("lists the published titles as evidence, not as a template", () => {
    const prompt = buildSystemPrompt(titlesRequest());

    expect(prompt).toContain("I deleted my second monitor for a month");
    expect(prompt).toContain("Do not reuse these titles");
  });

  it("stops at fifty, as PLAN.md says", () => {
    const many = Array.from({ length: 80 }, (_u, i) => `Past title ${i}`);
    const prompt = buildSystemPrompt(
      titlesRequest({ channel: { pastTitles: many } }),
    );

    expect(prompt).toContain("Past title 49");
    expect(prompt).not.toContain("Past title 50");
    expect(MAX_PAST_TITLES).toBe(50);
  });

  it("leaves the section out entirely for a channel that has published nothing", () => {
    const prompt = buildSystemPrompt(
      titlesRequest({ channel: { pastTitles: [] } }),
    );

    expect(prompt).not.toContain("What this channel has published");
  });
});

describe("the craft rules", () => {
  it("asks for twenty titles and names the rules BRIEF.md's checklist names", () => {
    const prompt = buildSystemPrompt(titlesRequest());

    expect(prompt).toContain("Write 20 title candidates");
    expect(prompt).toContain("sells the *result*");
    expect(prompt).toContain("55 characters");
  });

  it("asks only for the hooks that are missing, in the singular when it is one", () => {
    const prompt = buildSystemPrompt(
      hooksRequest({ existing: ["An opening already written", "And another"] }),
    );

    expect(prompt).toContain("Write 1 hook for");
    expect(prompt).toContain("do not repeat their angle");
    expect(prompt).toContain("welcome back");
  });

  it("tells a concept from a thumbnail file, which BRIEF.md keeps apart", () => {
    const prompt = buildSystemPrompt(conceptsRequest());

    expect(prompt).toContain("It is not an image file");
    expect(prompt).toContain("360 pixels");
  });

  it("puts the critique at tile size, where the pill says it judges", () => {
    const prompt = buildSystemPrompt(critiqueRequest());

    expect(prompt).toContain("360 pixels");
    expect(prompt).toContain("Judge the 3 thumbnail images");
  });

  it("puts the count in the prompt, which is the only place it belongs", () => {
    expect(buildSystemPrompt(titlesRequest())).toContain("Return 20 of them");
  });
});

describe("the user message", () => {
  it("carries what the person wrote, labelled", () => {
    const message = buildUserMessage(titlesRequest());

    expect(message).toContain("Working title:");
    expect(message).toContain("Editing my videos on a ten year old laptop");
    expect(message).toContain("One-line hook:");
    expect(message).toContain("Tags: editing, gear");
  });

  it("leaves out what is empty rather than sending empty labels", () => {
    const message = buildUserMessage(
      titlesRequest({ video: { notes: null, oneLineHook: null, tags: [] } }),
    );

    expect(message).not.toContain("Notes:");
    expect(message).not.toContain("One-line hook:");
    expect(message).not.toContain("Tags:");
  });

  it("still asks a question when the video is a bare idea", () => {
    const message = buildUserMessage(
      titlesRequest({
        video: { title: "", oneLineHook: null, notes: null, tags: [] },
      }),
    );

    expect(message).toContain("Nothing else has been written down yet");
  });

  it("names the candidates already on the video so they are not repeated", () => {
    const message = buildUserMessage(
      titlesRequest({ existing: ["A title I already wrote"] }),
    );

    expect(message).toContain("do not repeat these");
    expect(message).toContain("A title I already wrote");
  });

  it("names the images in the order the blocks are sent", () => {
    const message = buildUserMessage(critiqueRequest(["moderate", "safe"]));

    expect(message).toContain("in this order: moderate, safe");
  });

  it("does not leak the channel's voice guide into the user turn", () => {
    // It belongs in the system prompt: one place, so tuning it is one edit.
    expect(buildUserMessage(titlesRequest())).not.toContain(
      VOICE_GUIDE_ALPHA.trim(),
    );
    expect(channelContext().voiceGuide).not.toBeNull();
  });
});
