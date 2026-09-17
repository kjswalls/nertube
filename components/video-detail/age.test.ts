import { describe, expect, it } from "vitest";

import { formatAge } from "./age";

const NOW = Date.parse("2026-09-17T12:00:00Z");
const ago = (ms: number): string => new Date(NOW - ms).toISOString();

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe("formatAge", () => {
  it("has nothing to say about nothing", () => {
    expect(formatAge(null, NOW)).toBeNull();
    expect(formatAge("not a timestamp", NOW)).toBeNull();
  });

  it("does not put a number on the first hour", () => {
    expect(formatAge(ago(0), NOW)).toBe("less than an hour");
    expect(formatAge(ago(59 * MINUTE), NOW)).toBe("less than an hour");
  });

  it("counts whole hours up to a day", () => {
    expect(formatAge(ago(HOUR), NOW)).toBe("1 hour");
    expect(formatAge(ago(2 * HOUR), NOW)).toBe("2 hours");
    expect(formatAge(ago(23 * HOUR + 59 * MINUTE), NOW)).toBe("23 hours");
  });

  it("counts whole days after that", () => {
    expect(formatAge(ago(DAY), NOW)).toBe("1 day");
    expect(formatAge(ago(DAY + 23 * HOUR), NOW)).toBe("1 day");
    expect(formatAge(ago(21 * DAY), NOW)).toBe("21 days");
  });

  it("reads a clock that is slightly ahead as brand new, not as negative", () => {
    expect(formatAge(new Date(NOW + 5_000).toISOString(), NOW)).toBe(
      "less than an hour",
    );
  });
});
