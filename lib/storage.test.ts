import { describe, expect, it } from "vitest";

import {
  cacheBusted,
  CONCEPT_SKETCH_ACCEPT,
  conceptSketchPath,
  describeSketchRejection,
  MAX_SKETCH_BYTES,
  parseConceptSketchPath,
  sketchExtensionFor,
} from "./storage";

/**
 * The path convention and the client-side check, pinned.
 *
 * These are the functions the browser and the server both run, so a change to
 * one of them that the other does not follow is an orphaned object or a row
 * pointing at nothing. The e2e suite proves the whole path works; this proves
 * the edges (a JPEG and a JPG are the same object, a path from another user is
 * not one of ours) without a browser.
 */

const USER = "11111111-1111-4111-8111-111111111111";
const VIDEO = "22222222-2222-4222-8222-222222222222";

describe("the concept-sketch path", () => {
  it("is {user}/{video}/concept.{ext}", () => {
    expect(conceptSketchPath(USER, VIDEO, "png")).toBe(
      `${USER}/${VIDEO}/concept.png`,
    );
  });

  it("round-trips through the parser", () => {
    expect(parseConceptSketchPath(conceptSketchPath(USER, VIDEO, "webp"))).toEqual({
      userId: USER,
      videoId: VIDEO,
      extension: "webp",
    });
  });

  it("refuses anything that is not one", () => {
    for (const path of [
      "",
      `${USER}/${VIDEO}/concept.exe`, // an extension nothing here produces
      `${USER}/${VIDEO}/wild_card.png`, // an M4 slot, not this one
      `${USER}/concept.png`, // no video segment
      `${USER}/${VIDEO}/../../concept.png`, // traversal
      `not-a-uuid/${VIDEO}/concept.png`,
      `${USER}/${VIDEO}/concept.png/extra`,
    ]) {
      expect(parseConceptSketchPath(path), path).toBeNull();
    }
  });

  it("folds jpeg onto one extension, so a re-upload lands on the same object", () => {
    expect(sketchExtensionFor("image/jpeg")).toBe("jpg");
    expect(sketchExtensionFor("image/png")).toBe("png");
    expect(sketchExtensionFor("application/pdf")).toBeNull();
    expect(sketchExtensionFor("")).toBeNull();
  });

  it("offers exactly the accepted types to the file picker", () => {
    for (const type of CONCEPT_SKETCH_ACCEPT.split(",")) {
      expect(sketchExtensionFor(type)).not.toBeNull();
    }
  });
});

describe("the client-side check", () => {
  const file = (over: Partial<{ type: string; size: number; name: string }> = {}) => ({
    type: "image/png",
    size: 1024,
    name: "sketch.png",
    ...over,
  });

  it("passes a plausible image", () => {
    expect(describeSketchRejection(file())).toBeNull();
  });

  it("names the problem when the file is not an image", () => {
    expect(describeSketchRejection(file({ type: "application/pdf" }))).toMatch(
      /has to be an image/,
    );
    // A file the browser could not type at all still has to say something
    // readable rather than "a  file is not one".
    expect(describeSketchRejection(file({ type: "" }))).toMatch(/that file is not one/);
  });

  it("names the limit when the file is too big", () => {
    expect(describeSketchRejection(file({ size: MAX_SKETCH_BYTES + 1 }))).toMatch(
      /the limit is 5 MB/,
    );
    expect(describeSketchRejection(file({ size: MAX_SKETCH_BYTES }))).toBeNull();
  });

  it("refuses an empty file", () => {
    expect(describeSketchRejection(file({ size: 0 }))).toMatch(/empty/);
  });
});

describe("cacheBusted", () => {
  it("versions a signed URL so a replaced object is not served from cache", () => {
    expect(cacheBusted("https://x/object/sign/a.png?token=t", "2026-01-01T00:00:00Z")).toBe(
      "https://x/object/sign/a.png?token=t&cacheNonce=2026-01-01T00%3A00%3A00Z",
    );
  });

  it("leaves the URL alone when there is no version to add", () => {
    expect(cacheBusted("https://x/a?token=t", null)).toBe("https://x/a?token=t");
  });

  it("is null in, null out", () => {
    expect(cacheBusted(null, "2026-01-01T00:00:00Z")).toBeNull();
    expect(cacheBusted(undefined, null)).toBeNull();
  });
});
