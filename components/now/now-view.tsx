"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { confirmLive, dismissSwap, logMetrics } from "@/app/actions/metrics";
import { moveVideo } from "@/app/actions/moves";
import { toggleChecklistItem } from "@/app/actions/checklist";
import { updateVideo } from "@/app/actions/videos";
import { defaultIntent, type NowIntent } from "@/components/now/intent";
import { NowEmpty } from "@/components/now/now-empty";
import { NowRowItem } from "@/components/now/now-row";
import { useToast } from "@/components/toast";
import {
  SECTION_ORDER,
  SECTION_TITLE,
  matchesFilters,
  rankNow,
  type NowChannel,
  type NowFilters,
  type NowRow,
  type NowVideo,
} from "@/lib/next-action";
import { useShortcuts } from "@/lib/shortcuts";
import { diagnoseWriteFailure, failureSentence } from "@/lib/write-failure";

/**
 * `/now`'s list: the filters, the three sections, the keyboard, and the one
 * place that writes.
 *
 * ## Why the ranking runs here too
 *
 * The page hands this component the *videos*, not the rows, and it calls the
 * same `rankNow()` the server would. That is what makes "complete a row and it
 * re-ranks, without a reload" one line rather than a protocol: finishing a row
 * patches the one video it was about, and the pure function produces the new
 * list — the next checklist item takes the row's place, a move takes the video
 * off the list, and nothing else on the page moves for a reason nobody can see.
 *
 * The clock comes from the server as a number and is used unchanged. Ages are
 * therefore identical on both sides of hydration and stay still while the list
 * is being worked through; a reload gets a new clock and nothing else does.
 *
 * ## What the server still owns
 *
 * A patch is a *prediction* of what the row now holds, and it is thrown away
 * the moment a fresh server render arrives (the `over` tag below). Two of the
 * intents — a move and a confirm-live — also ask for that render, because
 * `move_video` snapshots the next stage's checklist templates into
 * `checklist_items` and the browser cannot know what they say. Everything else
 * is a column this page already has, so it re-ranks locally and costs nothing.
 */
export function NowView({
  channels,
  videos,
  now,
}: {
  channels: readonly NowChannel[];
  videos: readonly NowVideo[];
  now: number;
}) {
  const router = useRouter();
  const toast = useToast();

  /* ---------------------------------------------------------------------- */
  /* State                                                                   */
  /* ---------------------------------------------------------------------- */

  /**
   * Local patches, tagged with the props they were computed over.
   *
   * The same shape `FlowFields` settled on in M2, for the same reason: a
   * `useState` seeded from props does not re-seed, so a `router.refresh()` that
   * brings newer rows would be silently overruled by a stale copy. Tagging the
   * patch with the array it was computed against means the moment the server
   * sends a new one, every patch expires at once.
   */
  const [patched, setPatched] = useState<{
    over: readonly NowVideo[];
    map: ReadonlyMap<string, NowVideo>;
  } | null>(null);

  /** "Still waiting" — an acknowledgement, not a write. Lives for this render pass. */
  const [acknowledged, setAcknowledged] = useState<ReadonlySet<string>>(new Set());

  const [filters, setFilters] = useState<NowFilters>({
    channelIds: [],
    quickOnly: false,
  });

  const [busyVideoId, setBusyVideoId] = useState<string | null>(null);

  /**
   * What the user last pointed at: the row's video **and** where it was in the
   * list.
   *
   * Both, because the list changes underneath the selection constantly — that
   * is the whole point of the page. Ticking the selected row usually replaces
   * it with the next item on the same video, which keeps the same id; moving it
   * takes the video off the list entirely, and then the row that slid up into
   * its place is the one that should be selected. The id answers the first
   * case, the index answers the second, and keeping both means `x` twice in a
   * row works.
   */
  const [selection, setSelection] = useState<{ videoId: string; index: number } | null>(
    null,
  );

  /**
   * `data-ready="true"` once this component has hydrated.
   *
   * The list renders on the server, so every row is on screen before any of
   * this file is running: until hydration a tick does nothing and `j` does
   * nothing. The board marks the same window the same way and for the same
   * reason — the end-to-end suite waits for the attribute rather than for a
   * timeout, which is the difference between a green run and a flaky one.
   *
   * Written straight to the node rather than held in state: it is a fact about
   * the DOM, and putting it in state would buy a second render of every row to
   * say something no row reads.
   */
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    listRef.current?.setAttribute("data-ready", "true");
  }, []);

  const rowRefs = useRef(new Map<string, HTMLLIElement>());
  const registerRef = useCallback((videoId: string, element: HTMLLIElement | null) => {
    if (element) rowRefs.current.set(videoId, element);
    else rowRefs.current.delete(videoId);
  }, []);

  /* ---------------------------------------------------------------------- */
  /* Derivation                                                              */
  /* ---------------------------------------------------------------------- */

  const context = useMemo(
    () => ({ channels: new Map(channels.map((channel) => [channel.id, channel])) }),
    [channels],
  );

  const current = useMemo(() => {
    const overrides = patched && patched.over === videos ? patched.map : null;
    if (!overrides) return videos;
    return videos.map((video) => overrides.get(video.id) ?? video);
  }, [videos, patched]);

  const allRows = useMemo(
    () => rankNow(current, context, now),
    [current, context, now],
  );

  const rows = useMemo(
    () =>
      allRows.filter(
        (row) => !acknowledged.has(row.videoId) && matchesFilters(row, filters),
      ),
    [allRows, acknowledged, filters],
  );

  /*
    Two counts, not one difference.

    A row can leave the list for two unrelated reasons — a filter is narrowing
    it away, or the user pressed "Still waiting" and set it aside — and
    subtracting `rows.length` from `allRows.length` conflates them. That read
    "1 hidden" in the filter chip row with no chip and no quick filter on, and,
    when the acknowledged row was the last one, printed "Nothing matches those
    filters. Turn one off to see the rest." to somebody with no filter to turn
    off.
  */
  const hiddenByFilters = useMemo(
    () =>
      allRows.filter(
        (row) => !acknowledged.has(row.videoId) && !matchesFilters(row, filters),
      ).length,
    [allRows, acknowledged, filters],
  );

  const setAsideCount = useMemo(
    () => allRows.filter((row) => acknowledged.has(row.videoId)).length,
    [allRows, acknowledged],
  );

  const sections = useMemo(
    () =>
      SECTION_ORDER.map((section) => ({
        section,
        rows: rows.filter((row) => row.section === section),
      })).filter((group) => group.rows.length > 0),
    [rows],
  );

  /* ---------------------------------------------------------------------- */
  /* Selection                                                               */
  /* ---------------------------------------------------------------------- */

  /*
    Which row is selected *now*, derived rather than stored.

    An effect that corrected a stale selection after the fact would be a second
    render for every tick, and React says so out loud (`set-state-in-effect`).
    This is the same rule as a pure function: the stored value is what the user
    asked for, and this is what it means against the list as it currently
    stands.
  */
  const selectedVideoId = useMemo(() => {
    if (selection === null || rows.length === 0) return null;
    const found = rows.some((row) => row.videoId === selection.videoId);
    if (found) return selection.videoId;
    return rows[Math.min(selection.index, rows.length - 1)].videoId;
  }, [rows, selection]);

  const select = useCallback(
    (videoId: string) => {
      const index = rows.findIndex((row) => row.videoId === videoId);
      if (index === -1) return;
      setSelection((previous) =>
        previous && previous.videoId === videoId && previous.index === index
          ? previous
          : { videoId, index },
      );
    },
    [rows],
  );

  const step = useCallback(
    (delta: number) => {
      if (rows.length === 0) return;
      const index = rows.findIndex((row) => row.videoId === selectedVideoId);
      const next =
        index === -1
          ? delta > 0
            ? 0
            : rows.length - 1
          : Math.min(rows.length - 1, Math.max(0, index + delta));

      const row = rows[next];
      setSelection({ videoId: row.videoId, index: next });
      const element = rowRefs.current.get(row.videoId);
      element?.scrollIntoView({ block: "nearest", behavior: "auto" });
      /*
        Focus follows the selection (M9), as it does on the board and in the
        bank. Without it, focus stayed wherever the last click left it — on a
        channel chip, say — and `Enter`, which rightly stands aside on a
        focused button, toggled the chip instead of opening the row.
      */
      element?.focus({ preventScroll: true });
    },
    [rows, selectedVideoId],
  );

  /* ---------------------------------------------------------------------- */
  /* Writing                                                                 */
  /* ---------------------------------------------------------------------- */

  /** Replace one video, locally, and let the pure function re-rank. */
  const patch = useCallback(
    (videoId: string, change: (video: NowVideo) => NowVideo) => {
      setPatched((previous) => {
        const base =
          previous && previous.over === videos ? previous.map : new Map<string, NowVideo>();
        const source = base.get(videoId) ?? videos.find((video) => video.id === videoId);
        if (!source) return previous;

        const next = new Map(base);
        next.set(videoId, change(source));
        return { over: videos, map: next };
      });
    },
    [videos],
  );

  const perform = useCallback(
    async (row: NowRow, intent: NowIntent) => {
      if (busyVideoId !== null) return;

      // "Still waiting" writes nothing at all — see `intent.ts`.
      if (intent.kind === "still-waiting") {
        setAcknowledged((previous) => new Set(previous).add(row.videoId));
        return;
      }

      setBusyVideoId(row.videoId);
      try {
        switch (intent.kind) {
          case "tick": {
            if (row.payload.input !== "tick") return;
            const itemId = row.payload.itemId;
            const result = await toggleChecklistItem({
              videoId: row.videoId,
              itemId,
              checked: true,
            });
            if (!result.ok) {
              toast.push({ message: result.error, tone: "error" });
              return;
            }
            const saved = result.item;
            patch(row.videoId, (video) => ({
              ...video,
              checklist: video.checklist.map((item) =>
                item.id === itemId ? (saved ?? { ...item, checkedAt: new Date(now).toISOString() }) : item,
              ),
            }));
            toast.push({ message: `Ticked: ${row.label}` });
            return;
          }

          case "text": {
            if (row.payload.input !== "text") return;
            const field = row.payload.field;
            const result = await updateVideo({
              videoId: row.videoId,
              ...(field === "title"
                ? { title: intent.value }
                : { thumbnailConcept: intent.value }),
            });
            if (!result.ok) {
              toast.push({ message: result.error, tone: "error" });
              return;
            }
            patch(row.videoId, (video) => ({
              ...video,
              title: result.video.title,
              thumbnailConcept: result.video.thumbnailConcept,
            }));
            toast.push({
              message: field === "title" ? "Title saved." : "Thumbnail concept saved.",
            });
            return;
          }

          case "choose-hook": {
            if (row.payload.input !== "choice") return;
            // Exactly one chosen, which is what the gate counts. Rewriting the
            // whole array is how the "at most one chosen" rule in
            // `HookListSchema` stays satisfiable in one write.
            const hooks = row.payload.hooks.map((hook) => ({
              id: hook.id,
              text: hook.text,
              chosen: hook.id === intent.hookId,
            }));
            const result = await updateVideo({ videoId: row.videoId, hooks });
            if (!result.ok) {
              toast.push({ message: result.error, tone: "error" });
              return;
            }
            patch(row.videoId, (video) => ({ ...video, hooks: result.video.hooks }));
            toast.push({ message: "Hook chosen." });
            return;
          }

          case "metrics": {
            /*
              The one metrics write path, shared with the video page's Publish
              section (`app/actions/metrics.ts`). `newViewersNote` is not sent:
              this row has no room for a sentence, and sending the key would
              clear a note the page wrote.
            */
            const result = await logMetrics({
              videoId: row.videoId,
              impressions: intent.impressions,
              ctr: intent.ctr,
              views: intent.views,
            });
            if (!result.ok) {
              toast.push({ message: result.error, tone: "error" });
              return;
            }
            const state = result.state;
            patch(row.videoId, (video) => ({
              ...video,
              first24Impressions: state.impressions,
              first24Ctr: state.ctr,
              metricsLoggedAt: state.metricsLoggedAt,
            }));
            toast.push({ message: "First 24 hours logged." });
            return;
          }

          case "keep-thumbnail": {
            const result = await dismissSwap({ videoId: row.videoId });
            if (!result.ok) {
              toast.push({ message: result.error, tone: "error" });
              return;
            }
            patch(row.videoId, (video) => ({
              ...video,
              swapDismissedAt: result.state.swapDismissedAt,
            }));
            toast.push({ message: "Keeping the thumbnail." });
            return;
          }

          case "unblocked": {
            const result = await updateVideo({ videoId: row.videoId, waitingOn: null });
            if (!result.ok) {
              toast.push({ message: result.error, tone: "error" });
              return;
            }
            patch(row.videoId, (video) => ({
              ...video,
              waitingOn: result.video.waitingOn,
              waitingSince: result.video.waitingSince,
            }));
            toast.push({ message: "Unblocked." });
            return;
          }

          case "confirm-live": {
            if (row.payload.input !== "url") return;

            /*
              One action, shared with the video page's Publish section.

              It used to be two calls from here — `updateVideo` for the link,
              then `moveVideo` for the stage — with this component holding the
              rule that `published_at` is the *target date* rather than the
              moment somebody ticked the row. That rule (PLAN.md ranking rule 5)
              now lives in `confirmLive`, along with resolving which stage
              Published is, so the row and the page cannot come to different
              answers about when a video went live. The URL still lands first;
              see the action.
            */
            const result = await confirmLive({
              videoId: row.videoId,
              url: intent.url,
            });
            if (!result.ok) {
              toast.push({ message: result.error, tone: "error" });
              return;
            }

            patch(row.videoId, (video) => ({
              ...video,
              youtubeUrl: result.youtubeUrl,
              stageId: result.stageId,
              stageEnteredAt: result.stageEnteredAt,
              publishedAt: result.publishedAt,
              checklist: [],
            }));
            toast.push({ message: `Live. Moved to ${result.stageName}.` });
            // The new stage's checklist was snapshot-copied by `move_video`
            // and only the server knows what it says.
            router.refresh();
            return;
          }

          case "move": {
            if (row.payload.input !== "move") return;
            const { toStageId, toStageName } = row.payload;
            const moved = await moveVideo({
              videoId: row.videoId,
              stageId: toStageId,
              slug: row.channelSlug,
            });
            if (!moved.ok) {
              toast.push({ message: moved.message, tone: "error" });
              return;
            }
            patch(row.videoId, (video) => ({
              ...video,
              stageId: moved.stageId,
              stageEnteredAt: moved.stageEnteredAt,
              checklist: [],
            }));
            toast.push({ message: `Moved to ${toStageName}.` });
            // PLAN.md's soft warning, in `moveVideo`'s own words so the row,
            // the board and the stage select cannot disagree about it.
            if (moved.notice) toast.push({ message: moved.notice });
            router.refresh();
            return;
          }
        }
      } catch {
        /*
          One catch for all nine branches.

          Every branch handles `!result.ok`, which is the server answering no.
          This is the server not answering at all — a dropped connection, a
          restarted dev server, an aborted POST — and without it the rejection
          escaped `perform`, nothing was rendered, and the row sat there
          looking exactly as it did before the click. The video page says so in
          this case (`components/autosave.tsx` catches the same rejection and
          prints "Could not reach the server, so this is not saved."); this is
          the list saying it too. Nothing here is optimistic, so there is
          nothing to roll back — the row is already showing the truth.
        */
        // Offline, signed out, or unreachable: `lib/write-failure.ts` (M9).
        toast.push({
          message: failureSentence(
            await diagnoseWriteFailure(),
            "Could not reach the server — nothing was saved. Try again.",
          ),
          tone: "error",
        });
      } finally {
        setBusyVideoId(null);
      }
    },
    [busyVideoId, now, patch, router, toast],
  );

  /* ---------------------------------------------------------------------- */
  /* Keyboard                                                                */
  /* ---------------------------------------------------------------------- */

  const selectedRow = rows.find((row) => row.videoId === selectedVideoId) ?? null;

  useShortcuts(
    useMemo(
      () => [
        {
          key: "j",
          description: "Select the next row",
          hint: {
            keys: "j / k",
            text: "select a row",
            label: "Select the next or previous row",
          },
          run: (event) => {
            event.preventDefault();
            step(1);
          },
        },
        {
          key: "k",
          description: "Select the previous row",
          run: (event) => {
            event.preventDefault();
            step(-1);
          },
        },
        {
          key: "x",
          description: "Complete the selected row",
          hint: {
            keys: "x",
            text: "complete the row",
            label: "Do the selected row's next action",
          },
          run: (event) => {
            if (!selectedRow) return;
            event.preventDefault();

            const intent = defaultIntent(selectedRow);
            if (intent) {
              void perform(selectedRow, intent);
              return;
            }
            // Nothing to press: put the caret where the answer goes. See
            // `defaultIntent` for why `x` refuses to guess.
            const element = rowRefs.current
              .get(selectedRow.videoId)
              ?.querySelector<HTMLElement>("[data-now-primary]");
            element?.focus();
          },
        },
        {
          key: "Enter",
          description: "Open the selected video",
          hint: {
            keys: "Enter",
            text: "open the video",
            label: "Open the selected row's video",
          },
          run: (event) => {
            if (!selectedRow) return;
            event.preventDefault();
            router.push(`/videos/${selectedRow.videoId}`);
          },
        },
        {
          // M9: the board has cleared its selection on Escape since M1, and
          // `/now` did not — one key, two meanings, on the two views used most.
          key: "Escape",
          description: "Clear the row selection",
          hint: { keys: "Escape", text: "clear the selection", bar: false },
          run: (event) => {
            // Only when there is something to clear: see the board's note on
            // an Escape that swallows the key with nothing to do.
            if (!selectedRow) return;
            event.preventDefault();
            setSelection(null);
          },
        },
      ],
      [perform, router, selectedRow, step],
    ),
    { enabled: allRows.length > 0, group: "On Now" },
  );

  /* ---------------------------------------------------------------------- */
  /* Render                                                                  */
  /* ---------------------------------------------------------------------- */

  return (
    <div
      ref={listRef}
      data-testid="now"
      data-ready="false"
      className="flex flex-1 flex-col gap-4"
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h1 className="font-display text-[22px] leading-tight font-semibold tracking-tight">
          Now
        </h1>
        <p data-testid="now-summary" className="text-[12px] text-muted">
          {rows.length === 0
            ? "Nothing is waiting on you."
            : `${rows.length} ${rows.length === 1 ? "thing" : "things"} you could move right now.`}
        </p>
      </div>

      {/* ---- filters ---- */}
      {/* Nothing to narrow on an empty list: the chips would be controls that
          can only ever find nothing (M9). */}
      <div
        hidden={allRows.length === 0}
        className="flex flex-wrap items-center gap-x-2 gap-y-2"
      >
        {channels.length > 1
          ? channels.map((channel) => {
              const on = filters.channelIds.includes(channel.id);
              return (
                <button
                  key={channel.id}
                  type="button"
                  data-testid="channel-chip"
                  data-channel-id={channel.id}
                  aria-pressed={on}
                  onClick={() =>
                    setFilters((previous) => ({
                      ...previous,
                      channelIds: on
                        ? previous.channelIds.filter((id) => id !== channel.id)
                        : [...previous.channelIds, channel.id],
                    }))
                  }
                  className={[
                    "rounded-full border px-2.5 py-1 text-[12px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent thumb:min-h-11 thumb:px-3.5 thumb:text-[13px]",
                    on
                      ? "border-accent text-foreground"
                      : "border-border text-muted hover:text-foreground",
                  ].join(" ")}
                >
                  {channel.name}
                </button>
              );
            })
          : null}

        <button
          type="button"
          data-testid="quick-filter"
          aria-pressed={filters.quickOnly}
          onClick={() =>
            setFilters((previous) => ({ ...previous, quickOnly: !previous.quickOnly }))
          }
          title="Rows estimated at ten minutes or less. Filming and editing checklist items need a real block, and Waiting rows are not work, so both are hidden."
          className={[
            "rounded-full border px-2.5 py-1 text-[12px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent thumb:min-h-11 thumb:px-3.5 thumb:text-[13px]",
            filters.quickOnly
              ? "border-accent text-foreground"
              : "border-border text-muted hover:text-foreground",
          ].join(" ")}
        >
          10 minutes or less
        </button>

        {hiddenByFilters > 0 ? (
          <span data-testid="filtered-out" className="font-mono text-[11px] text-muted">
            {hiddenByFilters} hidden
          </span>
        ) : null}

        {setAsideCount > 0 ? (
          <span data-testid="set-aside" className="text-[11px] text-muted">
            <span className="font-mono">{setAsideCount}</span> set aside until
            you reload
          </span>
        ) : null}
      </div>

      {/* ---- the list ---- */}
      {sections.length === 0 && allRows.length === 0 ? (
        // No rows at all: said by *why* — see `now-empty.tsx` (M9).
        <NowEmpty channels={channels} videos={current} />
      ) : sections.length === 0 ? (
        <p data-testid="now-empty" className="text-[13px] text-muted">
          {hiddenByFilters > 0
            ? "Nothing matches those filters. Turn one off to see the rest."
            : `Everything left is set aside for now. Reload to bring ${setAsideCount === 1 ? "it" : "them"} back.`}
        </p>
      ) : (
        <div className="flex max-w-3xl flex-col gap-5">
          {sections.map((group) => (
            <section
              key={group.section}
              data-testid="now-section"
              data-section={group.section}
              aria-label={SECTION_TITLE[group.section]}
              className="flex flex-col gap-2"
            >
              <h2 className="flex items-baseline gap-2 text-[11px] font-medium tracking-[0.06em] uppercase">
                <span
                  className={
                    group.section === "overdue"
                      ? "text-over-limit"
                      : group.section === "waiting"
                        ? "text-attention"
                        : "text-muted"
                  }
                >
                  {SECTION_TITLE[group.section]}
                </span>
                <span className="font-mono text-[11px] text-muted">
                  {group.rows.length}
                </span>
              </h2>

              <ul className="flex flex-col gap-2">
                {group.rows.map((row) => (
                  <NowRowItem
                    key={row.videoId}
                    row={row}
                    now={now}
                    selected={row.videoId === selectedVideoId}
                    busy={busyVideoId === row.videoId}
                    onSelect={() => select(row.videoId)}
                    onIntent={(intent) => void perform(row, intent)}
                    registerRef={registerRef}
                  />
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
