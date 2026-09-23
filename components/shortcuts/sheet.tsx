"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useId, type RefObject } from "react";

import { Modal } from "@/components/modal";
import { useShortcuts, type SheetGroup } from "@/lib/shortcuts";

import { Keys } from "./keys";

/**
 * The `?` sheet: the keys that work on the page underneath, and nothing else.
 *
 * ## Where its rows come from
 *
 * Almost all of them are the registry's own bindings (`readShortcutSheet()` in
 * `lib/shortcuts.ts`), read at the moment `?` was pressed — so the sheet cannot
 * list a key that is not bound on this route, and a key added to a page next
 * month appears here without anyone remembering to write it down. That is the
 * same promise the hint bar has made since M1, now with the room to say it
 * properly.
 *
 * Two groups are written out here instead, because they are not registry
 * bindings and so cannot be read off it:
 *
 * - **Inside the capture box.** Enter, Shift+Enter and Alt+1–9 are the title
 *   field's own handlers (`components/capture/capture-form.tsx`): they have to
 *   work *inside* a text field, which is exactly where the registry refuses to
 *   listen. They are listed under `c`, and only when `c` is live, because only
 *   then is the box one key away. `e2e/shortcuts.spec.ts` presses every one of them, which is
 *   what keeps this list honest.
 * - **Escape.** Its order is a rule, not a binding; it is stated once, here and
 *   in the registry's header, in the same words.
 *
 * ## Honest about what is not here
 *
 * The three work views each add keys of their own. Listing a board's `[`/`]`
 * on the calendar would advertise a key that does nothing, and omitting the
 * fact that they exist would leave the sheet's first reader thinking this is
 * all there is. So the views whose keys are *not* live here are named at the
 * bottom as links — the sheet says where to go, and the sheet there says what
 * the keys are.
 */
export function ShortcutSheet({
  groups,
  boardSlug,
  channelCount,
  returnFocusRef,
  onClose,
}: {
  /** The registry's snapshot, taken before the sheet opened. */
  groups: readonly SheetGroup[];
  /** The channel the Board and Ideas links go to, if there is one. */
  boardSlug: string | undefined;
  channelCount: number;
  returnFocusRef: RefObject<HTMLElement | null>;
  onClose: () => void;
}) {
  // `?` again closes it: the key that opened a sheet is the first key anyone
  // tries to put it away with. Exclusive, so it outranks nothing on the page —
  // the modal has already silenced the page.
  useShortcuts(
    [
      {
        key: "?",
        description: "Close the keyboard shortcuts",
        run: (event) => {
          event.preventDefault();
          onClose();
        },
      },
    ],
    { exclusive: true },
  );

  const titles = new Set(groups.map((group) => group.title));
  const pathname = usePathname();

  /*
    The views with keys of their own that are not live here. Never the page
    you are on: an empty `/now` binds no row keys (there is nothing to select),
    and a sheet on it saying "Now has keys of its own — press ? there" would be
    sending you to where you already are.
  */
  const elsewhere = [
    { href: "/now", name: "Now", group: "On Now" },
    ...(boardSlug === undefined
      ? []
      : [
          { href: `/c/${boardSlug}/board`, name: "the board", group: "On the board" },
          { href: `/c/${boardSlug}/ideas`, name: "the idea bank", group: "In the idea bank" },
        ]),
  ].filter((place) => !titles.has(place.group) && place.href !== pathname);

  /*
    The order is what the person is doing, most local first: the page's own
    keys, then capture (the one thing you do from anywhere), then moving
    between places, then putting things away. The page's group comes first
    because it is the reason this page is different from the last one.
  */
  const pageGroups = groups.filter((group) => !APPLICATION_GROUPS.has(group.title));
  const capture = groups.find((group) => group.title === "Capture");
  const getAround = groups.find((group) => group.title === "Get around");

  const ordered: { group: SheetGroup; note?: string }[] = [
    ...pageGroups.map((group) => ({ group })),
  ];
  if (capture) {
    ordered.push({
      group: {
        title: capture.title,
        entries: [
          ...capture.entries,
          { keys: "Enter", text: "", label: "Save the idea" },
          { keys: "Shift+Enter", text: "", label: "Add a hook, notes, tags and buckets" },
          ...(channelCount > 1
            ? [{ keys: "Alt+1–9", text: "", label: "File it under another channel" }]
            : []),
          { keys: "Escape", text: "", label: "Close without saving" },
        ],
      },
      note: "The last four work inside the box, as you type.",
    });
  }
  if (getAround) ordered.push({ group: getAround });
  ordered.push({
    group: {
      title: "Closing things",
      entries: [{ keys: "Escape", text: "", label: "Close one thing, newest first" }],
    },
    note: "A dialog or the menu first, then the suggestion panel you are in, then the selection.",
  });

  return (
    <Modal
      title="Keyboard shortcuts"
      testId="shortcut-sheet"
      width="wide"
      returnFocusRef={returnFocusRef}
      onClose={onClose}
    >
      <div className="flex flex-col gap-5">
        <p className="text-[13px] leading-5 text-muted">
          The keys that work on this page. Outside the capture box, none of
          them fire while you are typing in a field.
        </p>

        {/* Two columns where there is room for them; a section never splits. */}
        <div className="gap-x-10 md:columns-2">
          {ordered.map(({ group, note }) => (
            <Group key={group.title} group={group} note={note} />
          ))}
        </div>

        {elsewhere.length > 0 ? (
          <p
            data-testid="shortcut-sheet-elsewhere"
            className="border-t border-border pt-4 text-[13px] leading-5 text-muted"
          >
            Not on this page:{" "}
            {elsewhere.map((place, index) => (
              <span key={place.href}>
                {index > 0 ? (index === elsewhere.length - 1 ? " and " : ", ") : null}
                <Link
                  href={place.href}
                  onClick={onClose}
                  className="rounded-button text-foreground underline decoration-border underline-offset-2 outline-none hover:decoration-accent focus-visible:ring-2 focus-visible:ring-accent"
                >
                  {place.name}
                </Link>
              </span>
            ))}{" "}
            {elsewhere.length === 1
              ? "has keys of its own"
              : "each have keys of their own"}{" "}
            — press <Keys keys="?" /> there.
          </p>
        ) : null}
      </div>
    </Modal>
  );
}

/** The groups every signed-in route has; anything else is the page's own. */
const APPLICATION_GROUPS = new Set(["Capture", "Get around"]);

function Group({ group, note }: { group: SheetGroup; note?: string }) {
  const headingId = useId();
  return (
    <section
      aria-labelledby={headingId}
      data-testid="shortcut-group"
      className="mb-5 break-inside-avoid last:mb-0"
    >
      <h3
        id={headingId}
        className="mb-1 text-[11px] font-medium tracking-[0.06em] text-muted uppercase"
      >
        {group.title}
      </h3>
      <ul className="flex flex-col">
        {group.entries.map((entry) => (
          <li
            key={entry.keys}
            data-testid="shortcut-row"
            data-keys={entry.keys}
            className="flex min-h-9 items-center justify-between gap-4 border-b border-border/60 py-1.5 text-[13px] leading-5 last:border-b-0"
          >
            <span className="min-w-0">{labelOf(entry)}</span>
            <Keys keys={entry.keys} />
          </li>
        ))}
      </ul>
      {note ? (
        <p className="mt-1 text-[12px] leading-5 text-muted">{note}</p>
      ) : null}
    </section>
  );
}

function labelOf(entry: { label?: string; text: string }): string {
  if (entry.label) return entry.label;
  return entry.text.charAt(0).toUpperCase() + entry.text.slice(1);
}
