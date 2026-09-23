"use client";

import { useId, useRef } from "react";

import { AXIS_LABEL } from "@/lib/buckets";
import { useShortcuts } from "@/lib/shortcuts";

import type { IdeaBucket, IdeaFilters } from "./types";

/**
 * The bank's four filters, plus the archived scope.
 *
 * Three of them are `<select>`s and one is a text box, and that is a deliberate
 * break from `/now`'s row of chips. `/now` filters by channel — two or three
 * values, all of them worth seeing at once. A bank filters by tag (dozens, and
 * the set grows with every capture), by vertical (3–5) and by horizontal (8–12,
 * seeded). Twenty-five chips above a list of thirty rows is a filter bar that
 * costs more screen than the thing it filters, so the two axes and the tags
 * collapse into named selects and the shape of the bar never changes.
 *
 * The one chip that survives is "Show archived", because it is a boolean and a
 * pressed-state control says that better than a two-option select.
 *
 * Each control carries its own count — `tutorial (4)` — so the list narrows
 * predictably: an option that would empty the list says so before it is picked.
 *
 * The two axis labels come from `AXIS_LABEL` in `lib/buckets.ts`, which exists
 * so that one word is used per axis: the capture disclosure and the video
 * page's pickers already read it, the matrix says "topic pillars down, formats
 * across", and this bar used to say "Vertical" and "Horizontal" — two
 * vocabularies for the same two axes on adjacent screens. The words `vertical`
 * and `horizontal` survive in the URL parameters and in the code, where they
 * are names rather than prose.
 */
export function IdeaFilterBar({
  filters,
  onChange,
  tags,
  verticals,
  horizontals,
  archivedCount,
  /** How many ideas each option would leave, given the *other* filters. */
  counts,
}: {
  filters: IdeaFilters;
  onChange: (next: IdeaFilters) => void;
  tags: readonly string[];
  verticals: readonly IdeaBucket[];
  horizontals: readonly IdeaBucket[];
  archivedCount: number;
  counts: {
    readonly tags: ReadonlyMap<string, number>;
    readonly verticals: ReadonlyMap<string, number>;
    readonly horizontals: ReadonlyMap<string, number>;
  };
}) {
  const ids = useId();
  const searchId = `${ids}-search`;
  const searchRef = useRef<HTMLInputElement>(null);

  /*
    `/` — the one search box in the application, reached without the mouse.
    Bound here, by the component that draws the box, so the key exists exactly
    where the box does. The registry never fires from inside a field, so a `/`
    typed into the search itself is a slash.
  */
  useShortcuts(
    [
      {
        key: "/",
        description: "Search the idea bank",
        hint: { keys: "/", text: "search", label: "Search titles and hooks", bar: false },
        run: (event) => {
          event.preventDefault();
          searchRef.current?.focus();
          searchRef.current?.select();
        },
      },
    ],
    { group: "In the idea bank" },
  );
  const tagId = `${ids}-tag`;
  const verticalId = `${ids}-vertical`;
  const horizontalId = `${ids}-horizontal`;

  // 16px and 44px under a thumb: anything smaller than 16px makes iOS Safari
  // zoom the page when the field is tapped (M9 review).
  const selectClass =
    "rounded-input border border-border bg-surface px-2 py-1 text-[12px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-accent max-md:text-base thumb:min-h-11";
  const labelClass = "flex items-center gap-1.5 text-[11px] text-muted";

  return (
    <div
      data-testid="idea-filters"
      className="flex flex-wrap items-center gap-x-3 gap-y-2"
    >
      <label className={labelClass} htmlFor={searchId}>
        <span className="sr-only">Search titles and hooks</span>
        <input
          ref={searchRef}
          id={searchId}
          type="search"
          aria-keyshortcuts="/"
          data-testid="idea-search"
          value={filters.search}
          placeholder="Search title and hook"
          // The registry in `lib/shortcuts.ts` never fires while focus is in an
          // input, so `p` typed here is a letter and not a promotion.
          onChange={(event) =>
            onChange({ ...filters, search: event.target.value })
          }
          className="w-56 rounded-input border border-border bg-surface px-2 py-1 text-[12px] text-foreground outline-none placeholder:text-muted focus-visible:ring-2 focus-visible:ring-accent max-md:text-base thumb:min-h-11"
        />
      </label>

      <label className={labelClass} htmlFor={tagId}>
        Tag
        <select
          id={tagId}
          data-testid="idea-tag-filter"
          value={filters.tag ?? ""}
          onChange={(event) =>
            onChange({ ...filters, tag: event.target.value || null })
          }
          className={selectClass}
        >
          <option value="">Any</option>
          {tags.map((tag) => (
            <option key={tag} value={tag}>
              {tag} ({counts.tags.get(tag) ?? 0})
            </option>
          ))}
        </select>
      </label>

      <div className="flex items-center gap-1.5">
        <label className={labelClass} htmlFor={verticalId}>
          {AXIS_LABEL.vertical}
          <select
            id={verticalId}
            data-testid="idea-vertical-filter"
            value={filters.verticalId ?? ""}
            onChange={(event) =>
              onChange({ ...filters, verticalId: event.target.value || null })
            }
            className={selectClass}
          >
            <option value="">Any</option>
            {verticals.map((bucket) => (
              <option key={bucket.id} value={bucket.id}>
                {bucket.name} ({counts.verticals.get(bucket.id) ?? 0})
              </option>
            ))}
          </select>
        </label>
        {verticals.length === 0 ? (
          /*
            The seed leaves verticals empty on purpose — they are the channel's
            own topic pillars. Saying so beats an empty menu.

            Outside the <label>, because a label's text content IS the control's
            accessible name: inside, this select would announce as "Topic pillar
            none yet".
          */
          <span
            data-testid="no-verticals"
            title="A new channel has no topic pillars: they are your own 3–5, named under Settings › Buckets."
            className="font-mono text-[10px] text-muted"
          >
            none yet
          </span>
        ) : null}
      </div>

      <label className={labelClass} htmlFor={horizontalId}>
        {AXIS_LABEL.horizontal}
        <select
          id={horizontalId}
          data-testid="idea-horizontal-filter"
          value={filters.horizontalId ?? ""}
          onChange={(event) =>
            onChange({ ...filters, horizontalId: event.target.value || null })
          }
          className={selectClass}
        >
          <option value="">Any</option>
          {horizontals.map((bucket) => (
            <option key={bucket.id} value={bucket.id}>
              {bucket.name} ({counts.horizontals.get(bucket.id) ?? 0})
            </option>
          ))}
        </select>
      </label>

      {archivedCount > 0 ? (
        <button
          type="button"
          data-testid="idea-archived-toggle"
          aria-pressed={filters.includeArchived}
          onClick={() =>
            onChange({ ...filters, includeArchived: !filters.includeArchived })
          }
          title="Archived ideas are dismissed, not deleted. This is where they come back from."
          className={[
            "rounded-full border px-2.5 py-1 text-[12px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent",
            filters.includeArchived
              ? "border-accent text-foreground"
              : "border-border text-muted hover:text-foreground",
          ].join(" ")}
        >
          Show archived ({archivedCount})
        </button>
      ) : null}
    </div>
  );
}
