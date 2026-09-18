"use client";

import { useEffect, useRef, useState } from "react";

import { listBuckets } from "@/app/actions/buckets";
import { NO_BUCKETS, type BucketChoices } from "@/lib/buckets";

import { BucketSelect } from "./bucket-select";

/**
 * The two bucket pickers inside capture's disclosure.
 *
 * ## The fast path does not know this exists
 *
 * BRIEF.md principle 6 and PLAN.md's capture line are the same sentence twice:
 * one input, Enter, saved. So this component renders **only** while the
 * disclosure is open, asks for its options **only** when it first renders, and
 * is not on the path between `c` and Enter in any sense — not visually, not as a
 * tab stop, and not as a query. M1's reviewers policed that boundary; this is
 * built to stay on the far side of it.
 *
 * ## Options arrive after the field does
 *
 * The buckets are fetched when the disclosure opens (`app/actions/buckets.ts`
 * says why they are not handed down with the page). That leaves a short window
 * in which the labels are on screen and the menus are empty, and the honest
 * thing to do with it is say so: a disabled select and the word "Loading…"
 * rather than an empty menu that reads as "this channel has no pillars".
 *
 * ## Switching channel clears both
 *
 * A video's buckets belong to its channel — the composite foreign key says so —
 * so a vertical picked for *Personal* is not a thing *Sunday Softworks* has. If
 * `1..9` retargets the capture, both choices go back to "not filed" and the
 * menus reload. Carrying them over would either post an id the database refuses
 * or, worse, silently file the idea under whatever bucket happened to share the
 * position.
 */
export function CaptureBuckets({
  channelId,
  vertical,
  horizontal,
  onChange,
  hintId,
}: {
  channelId: string;
  /** The chosen bucket ids, or `""`. Owned by the form, like every other field. */
  vertical: string;
  horizontal: string;
  onChange: (axis: "vertical" | "horizontal", value: string) => void;
  /** The line under the pair, so the selects point at it. */
  hintId?: string;
}) {
  const [choices, setChoices] = useState<BucketChoices>(NO_BUCKETS);
  const [status, setStatus] = useState<"loading" | "ready" | "failed">("loading");
  const [error, setError] = useState<string | null>(null);

  /**
   * What has already been fetched, per channel.
   *
   * Retargeting between two channels while the disclosure is open should not
   * re-ask for a list that has not changed — and a cache in a ref rather than
   * state, because nothing renders from the map itself.
   */
  const cache = useRef(new Map<string, BucketChoices>());

  useEffect(() => {
    const cached = cache.current.get(channelId);
    if (cached) {
      setChoices(cached);
      setStatus("ready");
      setError(null);
      return;
    }

    let live = true;
    setStatus("loading");
    setError(null);

    void listBuckets(channelId)
      .then((result) => {
        if (!live) return;
        if (result.ok) {
          cache.current.set(channelId, result.choices);
          setChoices(result.choices);
          setStatus("ready");
          return;
        }
        setChoices(NO_BUCKETS);
        setStatus("failed");
        setError(result.error);
      })
      .catch(() => {
        if (!live) return;
        setChoices(NO_BUCKETS);
        setStatus("failed");
        setError(
          "Could not reach the server for this channel's buckets. The idea itself will still save.",
        );
      });

    // A retarget while a fetch is in flight must not have the older answer land
    // on top of the newer one.
    return () => {
      live = false;
    };
  }, [channelId]);

  const loading = status === "loading";

  return (
    <div className="flex flex-col gap-1.5" data-testid="capture-buckets">
      <div className="flex flex-wrap gap-3">
        <BucketSelect
          axis="vertical"
          name="verticalId"
          testId="capture-vertical"
          options={choices.verticals}
          value={vertical}
          onChange={(next) => onChange("vertical", next)}
          disabled={loading}
          describedBy={hintId}
        />
        <BucketSelect
          axis="horizontal"
          name="horizontalId"
          testId="capture-horizontal"
          options={choices.horizontals}
          value={horizontal}
          onChange={(next) => onChange("horizontal", next)}
          disabled={loading}
          describedBy={hintId}
        />
      </div>

      <p
        id={hintId}
        data-testid="capture-buckets-status"
        data-status={status}
        className={`text-xs ${status === "failed" ? "text-attention" : "text-muted"}`}
        role={status === "failed" ? "alert" : undefined}
      >
        {loading
          ? "Loading this channel's buckets…"
          : status === "failed"
            ? (error ?? "Could not load this channel's buckets.")
            : "One topic pillar and one format, at most. Both optional — the bank filters on them either way."}
      </p>
    </div>
  );
}
