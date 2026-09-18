import { afterEach, describe, expect, it } from "vitest";

import {
  addDays,
  compareDateColumns,
  daysBetween,
  firstOfMonth,
  formatDateColumn,
  formatMonth,
  isDateColumn,
  lastOfMonth,
  monthGrid,
  monthKey,
  monthOf,
  parseDateColumn,
  parseMonthKey,
  relativeDayLabel,
  shiftMonth,
  toDateColumn,
  todayColumn,
  weekdayIndex,
} from "./calendar-dates";

/**
 * The calendar's arithmetic, tested where it breaks.
 *
 * Every assertion here is about one claim: a `date` column is a calendar day,
 * and turning one into a cell in a grid must not consult the machine's
 * timezone. The suite is therefore run twice — plain, and under
 * `TZ=America/Los_Angeles`, eight hours west of UTC, which is where a
 * local-time getter would produce a different day for a third of every day.
 * Both runs must be identical; see M6 in `docs/MILESTONES.md`.
 *
 * The four places this kind of code goes wrong, and the tests for each:
 *
 * 1. **Midnight** — one millisecond either side of a UTC day boundary.
 * 2. **Month and year ends** — the 31st, the 1st, February in a leap year.
 * 3. **Daylight saving** — March and October 2026, the months containing the
 *    UK and US clock changes, walked day by day.
 * 4. **The grid** — leading and trailing days that belong to a neighbouring
 *    month are real dates, in order, with nothing repeated or skipped.
 */

/* -------------------------------------------------------------------------- */
/* Parsing                                                                     */
/* -------------------------------------------------------------------------- */

describe("parseDateColumn", () => {
  it("reads a calendar day", () => {
    expect(parseDateColumn("2026-03-03")).toEqual({
      year: 2026,
      month: 3,
      day: 3,
    });
  });

  it("refuses a day that does not exist rather than rolling it forward", () => {
    // The round trip is the check: Date.UTC would happily call this 2 March.
    expect(parseDateColumn("2026-02-30")).toBeNull();
    expect(parseDateColumn("2026-02-29")).toBeNull(); // 2026 is not a leap year
    expect(parseDateColumn("2028-02-29")).toEqual({
      year: 2028,
      month: 2,
      day: 29,
    });
  });

  it("refuses anything that is not YYYY-MM-DD", () => {
    for (const value of [
      "2026-3-3",
      "2026-13-01",
      "2026-00-10",
      "2026-01-00",
      "03/03/2026",
      "2026-03-03T00:00:00Z",
      "",
      "   ",
      null,
      undefined,
    ]) {
      expect(parseDateColumn(value as string | null | undefined)).toBeNull();
    }
  });

  it("refuses two-digit years, which Date.UTC would move to the 1900s", () => {
    expect(parseDateColumn("0026-03-03")).toBeNull();
    expect(isDateColumn("2026-03-03")).toBe(true);
  });
});

describe("toDateColumn", () => {
  it("zero-pads", () => {
    expect(toDateColumn({ year: 2026, month: 3, day: 3 })).toBe("2026-03-03");
  });

  it("normalises overflow the way the arithmetic below depends on", () => {
    expect(toDateColumn({ year: 2026, month: 1, day: 32 })).toBe("2026-02-01");
    expect(toDateColumn({ year: 2026, month: 13, day: 1 })).toBe("2027-01-01");
    // Day zero of March is the last day of February — and 2026 is not a leap
    // year, which is the whole leap-year rule this file does not contain.
    expect(toDateColumn({ year: 2026, month: 3, day: 0 })).toBe("2026-02-28");
    expect(toDateColumn({ year: 2028, month: 3, day: 0 })).toBe("2028-02-29");
  });
});

/* -------------------------------------------------------------------------- */
/* Midnight                                                                    */
/* -------------------------------------------------------------------------- */

describe("todayColumn", () => {
  it("holds the day across it, and turns over one millisecond later", () => {
    const midnight = Date.UTC(2026, 2, 3, 0, 0, 0, 0);
    expect(todayColumn(midnight)).toBe("2026-03-03");
    expect(todayColumn(midnight - 1)).toBe("2026-03-02");
    expect(todayColumn(midnight + 86_400_000 - 1)).toBe("2026-03-03");
    expect(todayColumn(midnight + 86_400_000)).toBe("2026-03-04");
  });

  it("is the same answer at every hour of a day", () => {
    for (let hour = 0; hour < 24; hour += 1) {
      expect(todayColumn(Date.UTC(2026, 2, 3, hour, 30))).toBe("2026-03-03");
    }
  });

  it("turns the year over", () => {
    expect(todayColumn(Date.UTC(2026, 11, 31, 23, 59, 59, 999))).toBe(
      "2026-12-31",
    );
    expect(todayColumn(Date.UTC(2027, 0, 1, 0, 0, 0, 0))).toBe("2027-01-01");
  });
});

/* -------------------------------------------------------------------------- */
/* Arithmetic, including the two days the clocks change                        */
/* -------------------------------------------------------------------------- */

describe("addDays", () => {
  it("crosses month and year ends", () => {
    expect(addDays("2026-01-31", 1)).toBe("2026-02-01");
    expect(addDays("2026-02-28", 1)).toBe("2026-03-01");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
    expect(addDays("2026-03-31", -31)).toBe("2026-02-28");
  });

  it("steps one day per day through the month the clocks go forward", () => {
    // Europe/London springs forward on 29 March 2026; America/Los_Angeles on
    // 8 March 2026. Adding 86_400_000 ms to a local-time Date lands on the
    // same date twice on one of those days.
    let date = "2026-03-01";
    const seen = [date];
    for (let step = 0; step < 30; step += 1) {
      date = addDays(date, 1) as string;
      seen.push(date);
    }
    expect(seen).toHaveLength(31);
    expect(new Set(seen).size).toBe(31);
    expect(seen[7]).toBe("2026-03-08");
    expect(seen[28]).toBe("2026-03-29");
    expect(seen[30]).toBe("2026-03-31");
    expect(addDays("2026-03-31", 1)).toBe("2026-04-01");
  });

  it("steps one day per day through the month the clocks go back", () => {
    // 25 October 2026 (UK) and 1 November 2026 (US) — the 25-hour day, where
    // the same millisecond arithmetic repeats a date instead of skipping one.
    let date = "2026-10-01";
    const seen = [date];
    for (let step = 0; step < 30; step += 1) {
      date = addDays(date, 1) as string;
      seen.push(date);
    }
    expect(seen).toHaveLength(31);
    expect(new Set(seen).size).toBe(31);
    expect(seen[24]).toBe("2026-10-25");
    expect(seen[30]).toBe("2026-10-31");
  });

  it("returns null for a non-date rather than inventing one", () => {
    expect(addDays("not a date", 1)).toBeNull();
  });
});

describe("daysBetween", () => {
  it("counts whole calendar days, including over a clock change", () => {
    expect(daysBetween("2026-03-01", "2026-03-31")).toBe(30);
    expect(daysBetween("2026-10-01", "2026-10-31")).toBe(30);
    expect(daysBetween("2026-03-03", "2026-03-03")).toBe(0);
    expect(daysBetween("2026-03-04", "2026-03-03")).toBe(-1);
    expect(daysBetween("2025-12-31", "2026-01-01")).toBe(1);
  });
});

describe("weekdayIndex", () => {
  it("counts from Monday", () => {
    expect(weekdayIndex("2026-03-01")).toBe(6); // a Sunday
    expect(weekdayIndex("2026-03-02")).toBe(0); // the Monday after it
    expect(weekdayIndex("2026-03-07")).toBe(5); // Saturday, the film day
  });
});

describe("compareDateColumns", () => {
  it("sorts chronologically", () => {
    const sorted = ["2026-10-02", "2026-01-31", "2025-12-31"].sort(
      compareDateColumns,
    );
    expect(sorted).toEqual(["2025-12-31", "2026-01-31", "2026-10-02"]);
  });

  it("sorts a malformed value last instead of throwing", () => {
    const sorted = ["oops", "2026-01-31"].sort(compareDateColumns);
    expect(sorted).toEqual(["2026-01-31", "oops"]);
  });
});

/* -------------------------------------------------------------------------- */
/* Months and the grid                                                         */
/* -------------------------------------------------------------------------- */

describe("month helpers", () => {
  it("addresses a month", () => {
    expect(monthKey({ year: 2026, month: 3 })).toBe("2026-03");
    expect(parseMonthKey("2026-03")).toEqual({ year: 2026, month: 3 });
    expect(parseMonthKey("2026-03-17")).toEqual({ year: 2026, month: 3 });
    expect(parseMonthKey("2026-13")).toBeNull();
    expect(parseMonthKey("nope")).toBeNull();
    expect(monthOf("2026-03-17")).toEqual({ year: 2026, month: 3 });
  });

  it("shifts across year ends", () => {
    expect(shiftMonth({ year: 2026, month: 12 }, 1)).toEqual({
      year: 2027,
      month: 1,
    });
    expect(shiftMonth({ year: 2026, month: 1 }, -1)).toEqual({
      year: 2025,
      month: 12,
    });
    expect(shiftMonth({ year: 2026, month: 3 }, 12)).toEqual({
      year: 2027,
      month: 3,
    });
  });

  it("knows the ends of a month without a table of month lengths", () => {
    expect(firstOfMonth({ year: 2026, month: 3 })).toBe("2026-03-01");
    expect(lastOfMonth({ year: 2026, month: 2 })).toBe("2026-02-28");
    expect(lastOfMonth({ year: 2028, month: 2 })).toBe("2028-02-29");
    expect(lastOfMonth({ year: 2026, month: 12 })).toBe("2026-12-31");
  });
});

describe("monthGrid", () => {
  /** Every cell in the grid, flattened, in order. */
  const flat = (year: number, month: number) =>
    monthGrid({ year, month }).flatMap((week) => week.map((cell) => cell.date));

  it("lays a month out as whole Monday-first weeks", () => {
    const weeks = monthGrid({ year: 2026, month: 3 });
    // 1 March 2026 is a Sunday, so the week it falls in starts on 23 February.
    expect(weeks).toHaveLength(6);
    for (const week of weeks) expect(week).toHaveLength(7);
    expect(weeks[0][0]).toEqual({ date: "2026-02-23", inMonth: false });
    expect(weeks[0][6]).toEqual({ date: "2026-03-01", inMonth: true });
    expect(weeks[5][6]).toEqual({ date: "2026-04-05", inMonth: false });
    expect(weekdayIndex(weeks[0][0].date)).toBe(0);
  });

  it("uses only the weeks the month needs", () => {
    // February 2021 began on a Monday and has 28 days: four rows exactly, and
    // no blank week below it.
    const weeks = monthGrid({ year: 2021, month: 2 });
    expect(weeks).toHaveLength(4);
    expect(weeks[0][0]).toEqual({ date: "2021-02-01", inMonth: true });
    expect(weeks[3][6]).toEqual({ date: "2021-02-28", inMonth: true });
  });

  it("is consecutive and never repeats or skips a day, across a clock change", () => {
    for (const [year, month, length] of [
      [2026, 3, 31], // clocks forward
      [2026, 10, 31], // clocks back
      [2028, 2, 29], // leap February
      [2026, 12, 31], // over the year end
    ] as const) {
      const dates = flat(year, month);
      expect(new Set(dates).size).toBe(dates.length);
      for (let index = 1; index < dates.length; index += 1) {
        expect(daysBetween(dates[index - 1], dates[index])).toBe(1);
      }
      const inMonth = monthGrid({ year, month })
        .flat()
        .filter((cell) => cell.inMonth);
      expect(inMonth).toHaveLength(length);
      expect(inMonth[0].date).toBe(firstOfMonth({ year, month }));
      expect(inMonth[length - 1].date).toBe(lastOfMonth({ year, month }));
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Words                                                                       */
/* -------------------------------------------------------------------------- */

describe("formatting", () => {
  it("formats in en-GB and UTC, whatever the machine thinks", () => {
    expect(formatDateColumn("2026-03-03", "short")).toBe("3 Mar");
    expect(formatDateColumn("2026-03-03", "medium")).toBe("3 Mar 2026");
    expect(formatDateColumn("2026-03-03", "full")).toBe(
      "Tuesday, 3 March 2026",
    );
    expect(formatDateColumn("2026-03-03", "weekday")).toBe("Tue 3 Mar");
    expect(formatMonth({ year: 2026, month: 3 })).toBe("March 2026");
  });

  it("formats the first and last days of a month as themselves", () => {
    // The pair a UTC-vs-local bug shows up on first: midnight on the 1st is
    // the previous month in any zone west of UTC.
    expect(formatDateColumn("2026-03-01", "medium")).toBe("1 Mar 2026");
    expect(formatDateColumn("2026-03-31", "medium")).toBe("31 Mar 2026");
    expect(formatDateColumn("2026-01-01", "medium")).toBe("1 Jan 2026");
    expect(formatDateColumn("2026-12-31", "medium")).toBe("31 Dec 2026");
  });

  it("renders nothing for a non-date", () => {
    expect(formatDateColumn(null)).toBeNull();
    expect(formatDateColumn("2026-02-30")).toBeNull();
  });

  it("says where a day sits relative to today, in whole days", () => {
    const today = "2026-03-03";
    expect(relativeDayLabel("2026-03-03", today)).toBe("Today");
    expect(relativeDayLabel("2026-03-04", today)).toBe("Tomorrow");
    expect(relativeDayLabel("2026-03-02", today)).toBe("Yesterday");
    expect(relativeDayLabel("2026-03-10", today)).toBe("in 7 days");
    expect(relativeDayLabel("2026-02-24", today)).toBe("7 days ago");
    // Across the month end, where a naive subtraction of day numbers breaks.
    expect(relativeDayLabel("2026-03-01", "2026-02-28")).toBe("Tomorrow");
  });
});

/* -------------------------------------------------------------------------- */
/* The sweep                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The same claims again, but exhaustively rather than on the dates a person
 * thought to type, and under seven zones rather than one.
 *
 * The cases above are the interesting days: this block is the argument that
 * there are no *other* interesting days. Written while building
 * `app/calendar/**`, which depends on every one of these holding on days nobody
 * will look at until the month they happen.
 */

const ORIGINAL_TZ = process.env.TZ;

afterEach(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

/**
 * Runs `body` with the process in each of seven zones: behind UTC, far behind,
 * on it, ahead by a three-quarter hour, ahead with southern-hemisphere DST, and
 * the one with a 12:45 offset.
 *
 * Node applies `process.env.TZ` to `Date` from the next call onwards. If a
 * runtime ever ignored it these assertions would simply be proving less, never
 * failing falsely.
 */
function inEveryZone(body: () => void): void {
  for (const zone of [
    "UTC",
    "America/Los_Angeles",
    "Pacific/Honolulu",
    "Europe/London",
    "Asia/Kathmandu",
    "Australia/Sydney",
    "Pacific/Chatham",
  ]) {
    process.env.TZ = zone;
    body();
  }
}

/** Every invariant a month grid has, on whatever month is handed in. */
function assertWellFormed(key: string): void {
  const month = parseMonthKey(key);
  if (month === null) throw new Error(`${key} is not a month`);

  const weeks = monthGrid(month);
  const first = firstOfMonth(month);
  const last = lastOfMonth(month);

  expect(weeks.length).toBeGreaterThanOrEqual(4);
  expect(weeks.length).toBeLessThanOrEqual(6);
  for (const week of weeks) {
    expect(week).toHaveLength(7);
    expect(weekdayIndex(week[0].date)).toBe(0); // Monday
    expect(weekdayIndex(week[6].date)).toBe(6); // Sunday
  }

  const cells = weeks.flat();

  // Consecutive, with nothing repeated and nothing skipped. This is the
  // assertion a grid built by adding 86_400_000 milliseconds fails on, in the
  // zone and the week where the clocks change.
  for (let index = 1; index < cells.length; index += 1) {
    expect(daysBetween(cells[index - 1].date, cells[index].date)).toBe(1);
  }
  expect(new Set(cells.map((cell) => cell.date)).size).toBe(cells.length);

  const inside = cells.filter((cell) => cell.inMonth);
  expect(inside[0].date).toBe(first);
  expect(inside[inside.length - 1].date).toBe(last);
  expect(inside).toHaveLength((daysBetween(first, last) ?? -1) + 1);

  // The borrowed days really do belong to the neighbours, and there are never
  // seven of them — a whole borrowed week would mean an off-by-one in the lead.
  const before = cells.filter((cell) => cell.date < first);
  const after = cells.filter((cell) => cell.date > last);
  expect(before.length).toBeLessThan(7);
  expect(after.length).toBeLessThan(7);
  for (const cell of before) {
    expect(monthKey(monthOf(cell.date)!)).toBe(monthKey(shiftMonth(month, -1)));
  }
  for (const cell of after) {
    expect(monthKey(monthOf(cell.date)!)).toBe(monthKey(shiftMonth(month, 1)));
  }
}

describe("the sweep", () => {
  it("round-trips every day of a decade through parse and format", () => {
    let date = "2020-01-01";
    let count = 0;
    while (date <= "2030-12-31") {
      const day = parseDateColumn(date);
      expect(day, date).not.toBeNull();
      expect(toDateColumn(day!)).toBe(date);
      expect(isDateColumn(date)).toBe(true);
      const next = addDays(date, 1)!;
      expect(compareDateColumns(date, next)).toBe(-1);
      expect(daysBetween(date, next)).toBe(1);
      date = next;
      count += 1;
    }
    // Eleven years, three of them leap (2020, 2024, 2028).
    expect(count).toBe(4018);
  });

  it("knows the century leap rules", () => {
    expect(isDateColumn("2024-02-29")).toBe(true);
    expect(isDateColumn("2023-02-29")).toBe(false);
    expect(isDateColumn("2000-02-29")).toBe(true); // divisible by 400
    expect(isDateColumn("1900-02-29")).toBe(false); // divisible by 100, not 400
    expect(isDateColumn("2100-02-29")).toBe(false);
    expect(lastOfMonth({ year: 2100, month: 2 })).toBe("2100-02-28");
    expect(lastOfMonth({ year: 2000, month: 2 })).toBe("2000-02-29");
  });

  it("holds every grid invariant for every month of six years", () => {
    for (let year = 2023; year <= 2028; year += 1) {
      for (let index = 1; index <= 12; index += 1) {
        assertWellFormed(`${year}-${String(index).padStart(2, "0")}`);
      }
    }
  });

  it("draws the same grid in every zone, cell for cell", () => {
    const shapes: string[] = [];
    inEveryZone(() => {
      // March and October 2026 contain the US, UK and Australian clock changes;
      // February 2024 is a leap month; November 2026 starts on a Sunday, which
      // is the six-row case.
      for (const key of ["2026-03", "2026-10", "2024-02", "2026-11"]) {
        assertWellFormed(key);
      }
      shapes.push(
        JSON.stringify(
          ["2026-03", "2026-10", "2024-02", "2026-11"].map((key) =>
            monthGrid(parseMonthKey(key)!).flat(),
          ),
        ),
      );
    });
    expect(new Set(shapes).size).toBe(1);
  });

  it("answers the same day, month and words in every zone", () => {
    // 23:30 UTC on the 30th is already the 1st in Sydney and still the 30th in
    // Los Angeles. A calendar day is neither of those local opinions.
    const late = Date.UTC(2026, 8, 30, 23, 30);
    const early = Date.UTC(2026, 8, 1, 0, 30);
    inEveryZone(() => {
      expect(todayColumn(late)).toBe("2026-09-30");
      expect(todayColumn(early)).toBe("2026-09-01");
      expect(monthKey(monthOf(todayColumn(late))!)).toBe("2026-09");
      expect(formatMonth({ year: 2026, month: 9 })).toBe("September 2026");
      // en-GB abbreviates September to "Sept", not "Sep" — the point of the
      // assertion is that the *day* does not shift, and the word is the
      // formatter's business.
      expect(formatDateColumn("2026-09-01", "medium")).toBe("1 Sept 2026");
      expect(relativeDayLabel("2026-10-01", "2026-09-30")).toBe("Tomorrow");
    });
  });

  it("steps months in both directions without drifting", () => {
    let month = { year: 2024, month: 1 };
    for (let index = 0; index < 36; index += 1) month = shiftMonth(month, 1);
    expect(monthKey(month)).toBe("2027-01");
    for (let index = 0; index < 36; index += 1) month = shiftMonth(month, -1);
    expect(monthKey(month)).toBe("2024-01");

    expect(monthKey(shiftMonth({ year: 2026, month: 9 }, 100))).toBe("2035-01");
    expect(monthKey(shiftMonth({ year: 2026, month: 9 }, -100))).toBe("2018-05");
  });
});
