import { afterEach, describe, expect, it } from "vitest";

import {
  addDays,
  canonicalTimeZone,
  formatInstant,
  isTimeZone,
  monthInstants,
  offsetLabel,
  startOfDay,
  timeZoneCity,
  timeZoneGroups,
  todayColumn,
  UTC,
} from "./calendar-dates";

/**
 * "Today" in the user's zone (M10).
 *
 * The claim under test: the calendar day turns over at the user's local
 * midnight — not UTC's, not the machine's — on ordinary days, at month and
 * year ends, and on both sides of both DST changes, in a zone west of UTC
 * (America/Los_Angeles), one on it half the year (Europe/London), a half-hour
 * zone (Asia/Kolkata) and one far east of it (Pacific/Auckland).
 *
 * Every expectation is written as a UTC instant and the local wall-clock time
 * it is, so each can be checked against a tz table by hand.
 */

const at = (iso: string): number => Date.parse(iso);

const LA = "America/Los_Angeles";
const LONDON = "Europe/London";
const KOLKATA = "Asia/Kolkata";
const AUCKLAND = "Pacific/Auckland";

const originalTz = process.env.TZ;
afterEach(() => {
  process.env.TZ = originalTz;
});

/* -------------------------------------------------------------------------- */
/* Midnight, one millisecond either side                                      */
/* -------------------------------------------------------------------------- */

describe("todayColumn turns over at local midnight", () => {
  const cases: [zone: string, midnightUtc: string, before: string, after: string][] = [
    // An ordinary day.
    [LA, "2026-03-03T08:00:00.000Z", "2026-03-02", "2026-03-03"], // PST, UTC-8
    [LONDON, "2026-03-03T00:00:00.000Z", "2026-03-02", "2026-03-03"], // GMT
    [KOLKATA, "2026-03-02T18:30:00.000Z", "2026-03-02", "2026-03-03"], // UTC+5:30
    [AUCKLAND, "2026-03-02T11:00:00.000Z", "2026-03-02", "2026-03-03"], // NZDT, UTC+13

    // Month ends.
    [LA, "2026-10-01T07:00:00.000Z", "2026-09-30", "2026-10-01"], // PDT, UTC-7
    [LONDON, "2026-06-30T23:00:00.000Z", "2026-06-30", "2026-07-01"], // BST
    [KOLKATA, "2026-02-28T18:30:00.000Z", "2026-02-28", "2026-03-01"],
    [AUCKLAND, "2026-08-31T12:00:00.000Z", "2026-08-31", "2026-09-01"], // NZST, UTC+12

    // Year ends.
    [LA, "2027-01-01T08:00:00.000Z", "2026-12-31", "2027-01-01"],
    [LONDON, "2027-01-01T00:00:00.000Z", "2026-12-31", "2027-01-01"],
    [KOLKATA, "2026-12-31T18:30:00.000Z", "2026-12-31", "2027-01-01"],
    [AUCKLAND, "2026-12-31T11:00:00.000Z", "2026-12-31", "2027-01-01"],

    // The DST days themselves — the midnight that *starts* the changeover day
    // and the one that ends it, which are 23 or 25 hours apart.
    // Los Angeles: forward 8 Mar 2026 02:00 PST, back 1 Nov 2026 02:00 PDT.
    [LA, "2026-03-08T08:00:00.000Z", "2026-03-07", "2026-03-08"],
    [LA, "2026-03-09T07:00:00.000Z", "2026-03-08", "2026-03-09"],
    [LA, "2026-11-01T07:00:00.000Z", "2026-10-31", "2026-11-01"],
    [LA, "2026-11-02T08:00:00.000Z", "2026-11-01", "2026-11-02"],
    // London: forward 29 Mar 2026 01:00 GMT, back 25 Oct 2026 02:00 BST.
    [LONDON, "2026-03-29T00:00:00.000Z", "2026-03-28", "2026-03-29"],
    [LONDON, "2026-03-29T23:00:00.000Z", "2026-03-29", "2026-03-30"],
    [LONDON, "2026-10-24T23:00:00.000Z", "2026-10-24", "2026-10-25"],
    [LONDON, "2026-10-26T00:00:00.000Z", "2026-10-25", "2026-10-26"],
    // Auckland: back 5 Apr 2026 03:00 NZDT, forward 27 Sep 2026 02:00 NZST.
    [AUCKLAND, "2026-04-04T11:00:00.000Z", "2026-04-04", "2026-04-05"],
    [AUCKLAND, "2026-04-05T12:00:00.000Z", "2026-04-05", "2026-04-06"],
    [AUCKLAND, "2026-09-26T12:00:00.000Z", "2026-09-26", "2026-09-27"],
    [AUCKLAND, "2026-09-27T11:00:00.000Z", "2026-09-27", "2026-09-28"],
  ];

  it.each(cases)("%s: midnight at %s", (zone, midnightUtc, before, after) => {
    const midnight = at(midnightUtc);
    expect(todayColumn(midnight - 1, zone)).toBe(before);
    expect(todayColumn(midnight, zone)).toBe(after);
    expect(todayColumn(midnight + 1, zone)).toBe(after);
    expect(startOfDay(after, zone)).toBe(midnight);
  });

  it("the changeover days are 23 and 25 hours long, and nothing else moves", () => {
    const length = (day: string, zone: string) =>
      (startOfDay(addDays(day, 1)!, zone)! - startOfDay(day, zone)!) / 3_600_000;
    expect(length("2026-03-08", LA)).toBe(23);
    expect(length("2026-11-01", LA)).toBe(25);
    expect(length("2026-03-29", LONDON)).toBe(23);
    expect(length("2026-10-25", LONDON)).toBe(25);
    expect(length("2026-04-05", AUCKLAND)).toBe(25);
    expect(length("2026-09-27", AUCKLAND)).toBe(23);
    expect(length("2026-03-29", KOLKATA)).toBe(24);
    expect(length("2026-03-07", LA)).toBe(24);
  });

  it("the hours inside a changeover belong to that day", () => {
    // 01:59 PST and 03:00 PDT on 8 March are one minute apart, same day.
    expect(todayColumn(at("2026-03-08T09:59:00.000Z"), LA)).toBe("2026-03-08");
    expect(todayColumn(at("2026-03-08T10:00:00.000Z"), LA)).toBe("2026-03-08");
    // 01:30 on 1 November happens twice in Los Angeles; both are the 1st.
    expect(todayColumn(at("2026-11-01T08:30:00.000Z"), LA)).toBe("2026-11-01");
    expect(todayColumn(at("2026-11-01T09:30:00.000Z"), LA)).toBe("2026-11-01");
    // 23:30 on the 4th of April in Auckland, the evening before clocks go back.
    expect(todayColumn(at("2026-04-04T10:30:00.000Z"), AUCKLAND)).toBe("2026-04-04");
  });
});

/* -------------------------------------------------------------------------- */
/* Every day of a year, in every zone                                          */
/* -------------------------------------------------------------------------- */

describe("startOfDay and todayColumn agree on every day of 2026", () => {
  // Plus two zones with odd rules: Chatham's 45-minute offset and 45-minute
  // DST, and Santiago, where the clocks go forward *at* midnight so 00:00
  // does not exist on the changeover day.
  const zones = [UTC, LA, LONDON, KOLKATA, AUCKLAND, "Pacific/Chatham", "America/Santiago"];

  it.each(zones)("%s", (zone) => {
    let day = "2026-01-01";
    while (day < "2027-01-01") {
      const start = startOfDay(day, zone)!;
      const next = startOfDay(addDays(day, 1)!, zone)!;
      // The first instant of the day is on it, and the one before is not.
      expect(todayColumn(start, zone)).toBe(day);
      expect(todayColumn(start - 1, zone)).toBe(addDays(day, -1));
      // The last instant of the day is still on it.
      expect(todayColumn(next - 1, zone)).toBe(day);
      // A day is 23 to 25 hours long, whatever the zone does.
      const hours = (next - start) / 3_600_000;
      expect(hours).toBeGreaterThanOrEqual(23);
      expect(hours).toBeLessThanOrEqual(25);
      day = addDays(day, 1)!;
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Two zones that disagree, and the machine's own zone not mattering           */
/* -------------------------------------------------------------------------- */

describe("the zone is the argument, never the machine", () => {
  // 20:00 UTC on 23 September 2026: 08:00 on the 24th in Auckland (NZST,
  // before its 27 September change), 13:00 on the 23rd in Los Angeles.
  // `e2e/timezone.spec.ts` stands at the same hour, 20:00 UTC, on a Saturday.
  const instant = at("2026-09-23T20:00:00.000Z");

  it("Auckland and Los Angeles disagree about the date", () => {
    expect(todayColumn(instant, AUCKLAND)).toBe("2026-09-24");
    expect(todayColumn(instant, LA)).toBe("2026-09-23");
    expect(todayColumn(instant, UTC)).toBe("2026-09-23");
  });

  it("gives the same answers whatever process.env.TZ says", () => {
    const answers = new Set<string>();
    for (const machine of ["UTC", LA, AUCKLAND, KOLKATA, "Pacific/Kiritimati"]) {
      process.env.TZ = machine;
      answers.add(
        JSON.stringify([
          todayColumn(instant, AUCKLAND),
          todayColumn(instant, LA),
          startOfDay("2026-03-08", LA),
          formatInstant(instant, AUCKLAND, "dateTime"),
          formatInstant(instant, LA),
        ]),
      );
    }
    expect(answers.size).toBe(1);
  });

  it("throws on a zone that is not one, rather than answering in UTC", () => {
    expect(() => todayColumn(instant, "Mars/Olympus_Mons")).toThrow(RangeError);
  });
});

/* -------------------------------------------------------------------------- */
/* Names                                                                       */
/* -------------------------------------------------------------------------- */

describe("canonicalTimeZone", () => {
  it("accepts IANA names and keeps them", () => {
    for (const zone of [LA, LONDON, KOLKATA, AUCKLAND, "America/Argentina/Cordoba", "Etc/GMT+5"]) {
      expect(canonicalTimeZone(zone)).toBe(zone);
      expect(isTimeZone(zone)).toBe(true);
    }
  });

  it("stores the current IANA name where Intl prefers an old one", () => {
    // Node's ICU canonicalises these to the old names, which a current tzdata
    // (and therefore Postgres's catalogue) no longer lists.
    expect(canonicalTimeZone("Asia/Calcutta")).toBe("Asia/Kolkata");
    expect(canonicalTimeZone("Europe/Kiev")).toBe("Europe/Kyiv");
    expect(canonicalTimeZone("America/Buenos_Aires")).toBe("America/Argentina/Buenos_Aires");
    expect(isTimeZone("Asia/Calcutta")).toBe(false);
  });

  it("fixes the case and folds every name for UTC into one", () => {
    expect(canonicalTimeZone("america/los_angeles")).toBe(LA);
    expect(canonicalTimeZone(" Europe/London ")).toBe(LONDON);
    for (const utc of ["UTC", "utc", "Etc/UTC", "GMT", "Etc/GMT"]) {
      expect(canonicalTimeZone(utc)).toBe(UTC);
    }
  });

  it("refuses what is not a zone", () => {
    for (const bad of [
      "Mars/Olympus_Mons",
      "Europe/Londn",
      "+05:30",
      "-08:00",
      "Etc/Unknown",
      "",
      "   ",
      "UTC; drop table",
      "../../etc/passwd",
      "A".repeat(80),
    ]) {
      expect(canonicalTimeZone(bad)).toBeNull();
    }
    expect(canonicalTimeZone(null)).toBeNull();
    expect(canonicalTimeZone(42)).toBeNull();
    expect(canonicalTimeZone(undefined)).toBeNull();
  });
});

describe("offsetLabel and timeZoneCity", () => {
  it("names the offset in force on the date asked about", () => {
    expect(offsetLabel(LA, at("2026-01-15T12:00:00Z"))).toBe("GMT-8");
    expect(offsetLabel(LA, at("2026-07-15T12:00:00Z"))).toBe("GMT-7");
    expect(offsetLabel(KOLKATA, at("2026-07-15T12:00:00Z"))).toBe("GMT+5:30");
    expect(offsetLabel(AUCKLAND, at("2026-01-15T12:00:00Z"))).toBe("GMT+13");
    expect(offsetLabel(LONDON, at("2026-01-15T12:00:00Z"))).toBe("GMT");
    expect(offsetLabel("Pacific/Chatham", at("2026-07-15T12:00:00Z"))).toBe("GMT+12:45");
  });

  it("says a zone the way a person would", () => {
    expect(timeZoneCity(LA)).toBe("Los Angeles");
    expect(timeZoneCity("America/Argentina/Buenos_Aires")).toBe("Buenos Aires");
    expect(timeZoneCity(UTC)).toBe("UTC");
  });
});

describe("timeZoneGroups", () => {
  const groups = timeZoneGroups(at("2026-09-23T20:00:00Z"));
  const all = groups.flatMap((group) => group.zones);

  it("puts UTC first and every value is a stored spelling, once", () => {
    expect(groups[0].zones[0]).toEqual({ value: UTC, label: "UTC (GMT)" });
    const values = all.map((zone) => zone.value);
    expect(new Set(values).size).toBe(values.length);
    for (const value of values) expect(isTimeZone(value)).toBe(true);
    expect(values.length).toBeGreaterThan(300);
  });

  it("groups by area and labels by city with the offset", () => {
    const america = groups.find((group) => group.label === "America")!;
    expect(america.zones).toContainEqual({ value: LA, label: "Los Angeles (GMT-7)" });
    const pacific = groups.find((group) => group.label === "Pacific")!;
    expect(pacific.zones).toContainEqual({ value: AUCKLAND, label: "Auckland (GMT+12)" });
    const asia = groups.find((group) => group.label === "Asia")!;
    expect(asia.zones).toContainEqual({ value: KOLKATA, label: "Kolkata (GMT+5:30)" });
    expect(america.zones).toContainEqual({
      value: "America/Argentina/Cordoba",
      label: "Cordoba (Argentina) (GMT-3)",
    });
  });
});

/* -------------------------------------------------------------------------- */
/* Instants                                                                    */
/* -------------------------------------------------------------------------- */

describe("formatInstant", () => {
  it("shows an instant on the day it was where the user is", () => {
    // 01:00 UTC on the 4th is the evening of the 3rd in Los Angeles and the
    // afternoon of the 4th in Auckland.
    const stamp = "2026-03-04T01:00:00.000Z";
    expect(formatInstant(stamp, UTC)).toBe("4 Mar 2026");
    expect(formatInstant(stamp, LA)).toBe("3 Mar 2026");
    expect(formatInstant(stamp, AUCKLAND)).toBe("4 Mar 2026");
    expect(formatInstant(stamp, LA, "dateTime")).toBe("3 Mar 2026, 17:00");
    expect(formatInstant(stamp, KOLKATA, "dateTime")).toBe("4 Mar 2026, 06:30");
    expect(formatInstant(stamp, AUCKLAND, "time")).toBe("14:00");
  });

  it("round-trips a target date through startOfDay onto the same day", () => {
    for (const zone of [UTC, LA, LONDON, KOLKATA, AUCKLAND]) {
      expect(formatInstant(startOfDay("2026-03-08", zone)!, zone)).toBe("8 Mar 2026");
    }
  });

  it("renders nothing for what is not a timestamp", () => {
    expect(formatInstant(null, UTC)).toBeNull();
    expect(formatInstant(undefined, UTC)).toBeNull();
    expect(formatInstant("yesterday", UTC)).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* The month, as instants (M11)                                                */
/* -------------------------------------------------------------------------- */

describe("monthInstants", () => {
  /*
    The same six instants `supabase/tests/87_assist_spend.test.sql` pins on the
    database side: the SQL sums between these bounds, and this is what computes
    them, so the two tests together are the month-to-date spend in the
    farthest-east and farthest-west zones there are.
  */
  const KIRITIMATI = "Pacific/Kiritimati"; // UTC+14, no DST
  const PAGO_PAGO = "Pacific/Pago_Pago"; // UTC-11, no DST

  it("turns over at local midnight on the 1st, at both ends of the clock", () => {
    // 10:00 UTC on 30 September is 00:00 on 1 October in Kiritimati.
    expect(monthInstants(at("2026-09-30T09:59:00Z"), KIRITIMATI)).toEqual({
      month: { year: 2026, month: 9 },
      from: at("2026-08-31T10:00:00Z"),
      to: at("2026-09-30T10:00:00Z"),
    });
    expect(monthInstants(at("2026-09-30T10:00:00Z"), KIRITIMATI)).toEqual({
      month: { year: 2026, month: 10 },
      from: at("2026-09-30T10:00:00Z"),
      to: at("2026-10-31T10:00:00Z"),
    });
    // 11:00 UTC on 1 October is 00:00 on 1 October in Pago Pago.
    expect(monthInstants(at("2026-10-01T10:59:00Z"), PAGO_PAGO)).toEqual({
      month: { year: 2026, month: 9 },
      from: at("2026-09-01T11:00:00Z"),
      to: at("2026-10-01T11:00:00Z"),
    });
    expect(monthInstants(at("2026-10-01T11:00:00Z"), PAGO_PAGO)).toEqual({
      month: { year: 2026, month: 10 },
      from: at("2026-10-01T11:00:00Z"),
      to: at("2026-11-01T11:00:00Z"),
    });
  });

  it("is the UTC month when the zone is UTC, across a year end", () => {
    expect(monthInstants(at("2026-12-31T23:59:59Z"), UTC)).toEqual({
      month: { year: 2026, month: 12 },
      from: at("2026-12-01T00:00:00Z"),
      to: at("2027-01-01T00:00:00Z"),
    });
  });

  it("follows a clock change inside the month rather than a fixed offset", () => {
    // Los Angeles is UTC-7 on 1 October and UTC-8 on 1 November.
    expect(monthInstants(at("2026-10-15T12:00:00Z"), LA)).toMatchObject({
      from: at("2026-10-01T07:00:00Z"),
      to: at("2026-11-01T07:00:00Z"),
    });
    expect(monthInstants(at("2026-11-15T12:00:00Z"), LA)).toMatchObject({
      from: at("2026-11-01T07:00:00Z"),
      to: at("2026-12-01T08:00:00Z"),
    });
  });
});
