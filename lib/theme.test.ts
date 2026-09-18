import { describe, expect, it } from "vitest";

import {
  isThemeChoice,
  nextThemeChoice,
  THEME_BOOT_SCRIPT,
  THEME_CHOICES,
  THEME_STORAGE_KEY,
  type ThemeChoice,
} from "./theme";

/**
 * The parts of the theme that are decidable without a browser.
 *
 * The behaviour that *needs* one — "the first paint is already the right
 * palette" — is in `e2e/shell.spec.ts`, measured in the frame before the first
 * paint. What is pinned here is the contract that behaviour rests on, and the
 * boot script's text, because that string is the one piece of this application
 * that is shipped unparsed and untypechecked.
 */

describe("the cycle", () => {
  it("is system → light → dark → system, and closes", () => {
    let choice: ThemeChoice = "system";
    const seen: ThemeChoice[] = [choice];
    for (let i = 0; i < THEME_CHOICES.length; i += 1) {
      choice = nextThemeChoice(choice);
      seen.push(choice);
    }
    expect(seen).toEqual(["system", "light", "dark", "system"]);
  });

  it("visits every choice exactly once before repeating", () => {
    const visited = new Set<ThemeChoice>();
    let choice: ThemeChoice = "system";
    for (let i = 0; i < THEME_CHOICES.length; i += 1) {
      visited.add(choice);
      choice = nextThemeChoice(choice);
    }
    expect([...visited].sort()).toEqual([...THEME_CHOICES].sort());
  });
});

describe("isThemeChoice", () => {
  it("accepts the three and nothing else", () => {
    for (const choice of THEME_CHOICES) expect(isThemeChoice(choice)).toBe(true);
    for (const junk of [
      null,
      undefined,
      "",
      "Dark",
      "auto",
      "system ",
      0,
      {},
      ["dark"],
    ]) {
      expect(isThemeChoice(junk), `${JSON.stringify(junk)}`).toBe(false);
    }
  });
});

describe("the boot script", () => {
  /**
   * It is a string, so nothing else in this repository can catch a typo in it.
   * These run it — in Node, against a fake document and a fake localStorage —
   * which is the only way to find out whether it does what its comment claims.
   */
  function run(stored: string | null | { throws: true }): {
    attributes: Record<string, string>;
    threw: boolean;
  } {
    const attributes: Record<string, string> = {};
    const documentElement = {
      setAttribute(name: string, value: string) {
        attributes[name] = value;
      },
      removeAttribute(name: string) {
        delete attributes[name];
      },
    };
    const localStorage = {
      getItem(key: string) {
        if (key !== THEME_STORAGE_KEY) {
          throw new Error(`the script read the wrong key: ${key}`);
        }
        if (stored !== null && typeof stored === "object") {
          // What a browser does with "block all cookies" set: it throws.
          throw new Error("access denied");
        }
        return stored;
      },
    };

    let threw = false;
    try {
      new Function(
        "document",
        "localStorage",
        THEME_BOOT_SCRIPT,
      )({ documentElement }, localStorage);
    } catch {
      threw = true;
    }
    return { attributes, threw };
  }

  it("leaves the attribute off when nothing is stored, so the media query decides", () => {
    const { attributes } = run(null);
    expect(attributes["data-theme"]).toBeUndefined();
    expect(attributes["data-theme-choice"]).toBe("system");
  });

  it("writes the attribute for an explicit choice", () => {
    expect(run("dark").attributes).toEqual({
      "data-theme": "dark",
      "data-theme-choice": "dark",
    });
    expect(run("light").attributes).toEqual({
      "data-theme": "light",
      "data-theme-choice": "light",
    });
  });

  it("treats a stored value it does not recognise as 'system'", () => {
    // A value from an older build, a hand-edited devtools entry, another tab's
    // bug. Anything but the two palettes means "no decision", never a crash
    // and never `data-theme="chartreuse"`.
    for (const junk of ["", "auto", "Dark", "{}"]) {
      const { attributes } = run(junk);
      expect(attributes["data-theme"], junk).toBeUndefined();
      expect(attributes["data-theme-choice"], junk).toBe("system");
    }
  });

  it("swallows a storage that throws rather than taking the page down with it", () => {
    const { attributes, threw } = run({ throws: true });
    expect(threw).toBe(false);
    // Nothing was written, which leaves the media query in charge — the same
    // place a first-time visitor is.
    expect(attributes).toEqual({});
  });

  it("is small enough to be worth inlining on every page", () => {
    expect(THEME_BOOT_SCRIPT.length).toBeLessThan(400);
  });
});
