import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import * as metricsPair from "./metrics-pair";
import { MetricsPair } from "./metrics-pair";

/**
 * The pair rule, tested the way a reviewer will attack it: by trying to render
 * one number without the other.
 *
 * BRIEF.md: *always display impressions and CTR together, never CTR alone*.
 * `lib/metrics.test.ts` proves the *write* cannot carry one without the other;
 * this file proves the *render* cannot either. The two halves are emitted
 * unconditionally from one function, so there is no prop, no flag and no
 * variant that produces a click-through box on its own — and the only way to
 * know that stays true is to ask the rendered markup.
 *
 * Static markup, not a DOM: this asserts what the component *emits*, which is
 * exactly the claim being made. No test-library dependency is added for it —
 * `react-dom/server` is already a runtime dependency of the app.
 */

const VALUES = {
  impressions: 12_400,
  ctr: 4.2,
  views: 520,
  newViewersNote: null,
};

function render(props: Partial<Parameters<typeof MetricsPair>[0]> = {}): string {
  return renderToStaticMarkup(
    <MetricsPair values={VALUES} busy={false} onSubmit={() => {}} {...props} />,
  );
}

const IMPRESSIONS = 'data-testid="metrics-impressions"';
const CTR = 'data-testid="metrics-ctr"';

describe("MetricsPair", () => {
  it("emits both halves of the pair, always", () => {
    const html = render();
    expect(html).toContain(IMPRESSIONS);
    expect(html).toContain(CTR);
  });

  it("has no prop that renders one without the other", () => {
    /*
      Every optional prop, in every combination that could plausibly be reached
      for by someone trying to fit the block into a narrow space. The pair
      survives all of them; `withViews` and `withNote` reach only the two fields
      that genuinely are optional.
    */
    for (const withViews of [true, false]) {
      for (const withNote of [true, false]) {
        for (const density of ["row", "page"] as const) {
          const html = render({ withViews, withNote, density });
          expect(html).toContain(IMPRESSIONS);
          expect(html).toContain(CTR);
          expect(html.includes('data-testid="metrics-views"')).toBe(withViews);
          expect(html.includes('data-testid="metrics-new-viewers"')).toBe(
            withNote,
          );
        }
      }
    }
  });

  it("keeps the two in one control, so they cannot be placed apart", () => {
    const html = render();
    const pair = html.slice(
      html.indexOf('data-testid="metrics-impressions-ctr"'),
    );
    // Both inputs are inside the element that opens at that marker, and that
    // element is inside the one fieldset the component renders.
    expect(pair).toContain(IMPRESSIONS);
    expect(pair).toContain(CTR);
    expect(html.match(/<fieldset/g) ?? []).toHaveLength(1);
  });

  it("exports nothing else that renders", () => {
    // A second exported component is how "just this once, only the CTR" gets
    // added later. There is one, and the rest are types (erased at runtime).
    const runtimeExports = Object.entries(metricsPair)
      .filter(([, value]) => typeof value === "function")
      .map(([name]) => name);
    expect(runtimeExports).toEqual(["MetricsPair"]);
  });

  it("reports what is stored with both numbers in one sentence", () => {
    expect(render()).toContain("12,400 impressions at 4.2% click-through");
  });
});
