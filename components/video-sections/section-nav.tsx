"use client";

import { usePackagingDraft } from "@/components/preview/live-packaging";

import {
  sectionHref,
  sectionReadiness,
  VIDEO_SECTIONS,
  type SectionFacts,
  type SectionReadiness,
  type VideoSectionId,
} from "./sections";

/**
 * The row of tabs across the top of a video.
 *
 * ## They are links, not `role="tab"`
 *
 * Each one is a real `<a href>` to a real URL, because that is what the section
 * routing *is*: `?section=script` is a place you can paste to somebody. A
 * `role="tab"` on a `<span>` would have to re-implement the things an anchor
 * gives away — middle-click, "copy link address", the status bar preview, the
 * focus ring the rest of this app already has — and would then need a roving
 * tabindex and arrow-key handling to be a correct tab widget. Links with
 * `aria-current="page"` say the same thing with none of that.
 *
 * A plain left-click is intercepted so the switch costs no round trip and loses
 * no typing (see `video-sections.tsx`); every other kind of click — middle,
 * Ctrl, Cmd, Shift — is left alone, so opening a section in a new tab works the
 * way it does everywhere else.
 *
 * ## The mark on each tab
 *
 * A ratio, a tick, a lock, or nothing at all. `docs/BRIEF.md`'s rule is that
 * colour has to mean something, so an untouched section is drawn in exactly the
 * same grey as the rest of the chrome; only a ratio short of its total carries
 * the attention hue. The mark is never colour alone: the ratio is digits, the
 * tick and the lock are shapes, and each has a `title` and screen-reader text
 * saying what it means.
 *
 * ## Why the packaging ratio is live
 *
 * The other four read a saved row. Packaging is being typed into on the screen
 * next to this nav, and a tab that still said "1/3" while all three fields were
 * visibly filled would be the page disagreeing with itself. It re-reads the
 * draft the packaging block publishes, through the same
 * `sectionReadiness` the server used, so the two cannot drift.
 */
export function SectionNav({
  pathname,
  active,
  facts,
  onSelect,
}: {
  /** `/videos/<id>`, from the server — `usePathname` would be a second source. */
  pathname: string;
  active: VideoSectionId;
  facts: SectionFacts;
  onSelect: (id: VideoSectionId) => void;
}) {
  const draft = usePackagingDraft();

  const live: SectionFacts =
    draft === null
      ? facts
      : {
          ...facts,
          titleFilled: draft.title.trim() !== "",
          conceptFilled: (draft.thumbnailConcept ?? "").trim() !== "",
          chosenHooks: draft.chosenHooks,
          packagingSkipped: draft.skipped,
        };

  const readiness = sectionReadiness(live);

  return (
    <nav aria-label="Video sections" className="border-b border-border">
      <ul className="flex flex-wrap items-end gap-1">
        {VIDEO_SECTIONS.map((section) => {
          const state = readiness[section.id];
          const current = section.id === active;

          return (
            <li key={section.id}>
              <a
                href={sectionHref(pathname, section.id)}
                aria-current={current ? "page" : undefined}
                data-testid={`section-tab-${section.id}`}
                data-active={current ? "true" : "false"}
                title={state.why}
                onClick={(event) => {
                  // Anything but a plain left click is the browser's: new tab,
                  // new window, download, context menu.
                  if (
                    event.button !== 0 ||
                    event.metaKey ||
                    event.ctrlKey ||
                    event.shiftKey ||
                    event.altKey
                  ) {
                    return;
                  }
                  event.preventDefault();
                  onSelect(section.id);
                }}
                className={[
                  "relative inline-flex items-center gap-2 rounded-t-input px-3 py-2 text-sm outline-none thumb:min-h-11",
                  "focus-visible:ring-2 focus-visible:ring-accent",
                  current
                    ? "bg-surface font-medium text-foreground"
                    : "text-muted hover:text-foreground",
                ].join(" ")}
              >
                <span>{section.label}</span>
                <Mark state={state} />

                {/* The current-section marker is a shape, not a thicker
                    border: 1px everywhere is the rule, and this is the same
                    3px bar the sidebar marks the current page with. */}
                {current ? (
                  <span
                    aria-hidden="true"
                    className="absolute inset-x-0 -bottom-px h-[3px] rounded-t-[2px] bg-accent"
                  />
                ) : null}
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/** The ratio, tick, lock or nothing that follows a tab's label. */
function Mark({ state }: { state: SectionReadiness }) {
  if (state.kind === "ratio") {
    return (
      <span
        data-testid="section-mark"
        data-mark="ratio"
        className="font-mono text-xs text-attention"
      >
        <span className="sr-only">, </span>
        {state.done}/{state.total}
        <span className="sr-only"> done</span>
      </span>
    );
  }

  if (state.kind === "done") {
    return (
      <span data-testid="section-mark" data-mark="done" className="text-ready">
        <span className="sr-only">, complete</span>
        <svg
          aria-hidden="true"
          viewBox="0 0 12 12"
          width="12"
          height="12"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M2.5 6.4 4.8 8.7 9.5 3.6" />
        </svg>
      </span>
    );
  }

  if (state.kind === "locked") {
    return (
      <span data-testid="section-mark" data-mark="locked" className="text-muted">
        <span className="sr-only">, locked</span>
        <svg
          aria-hidden="true"
          viewBox="0 0 12 12"
          width="12"
          height="12"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <rect x="2.6" y="5.2" width="6.8" height="5" rx="1.2" />
          <path d="M4.3 5.2V3.9a1.7 1.7 0 0 1 3.4 0v1.3" />
        </svg>
      </span>
    );
  }

  return null;
}
