"use client";

import { useId, useState } from "react";

import { setStageEnabled } from "@/app/actions/stages";
import { occupiedSentence } from "@/lib/stage-settings";

/**
 * The Repurposed lane switch.
 *
 * BRIEF.md's stage table: *"Repurposed | Clips/newsletter/social derived
 * (**optional lane — can be toggled off**)"*. It is the one piece of stage
 * configuration the post-publish loop cannot do without — a creator who does
 * not cut clips should not have a column asking them to every week — so it
 * lives here, at the end of the loop it belongs to, and the rest of the
 * settings screen stays in M7 where PLAN.md puts it.
 *
 * ## It is a channel-level switch, and it says so
 *
 * Everything else on this page is about *this video*. This is not: it changes
 * the board for every video in the channel. Controls that quietly change more
 * than the thing you are looking at are how people lose trust in a tool, so the
 * scope is in the label rather than in a tooltip.
 *
 * ## Why switching it off can be refused
 *
 * A disabled stage is filtered out of the board's columns, out of `/now`'s
 * ranking and out of the stage select. Switching off a lane that still holds
 * videos does not hide a column — it hides *those videos*, everywhere, with
 * nothing saying where they went. So `setStageEnabled` refuses, naming the
 * count, and this component shows the refusal in place rather than as a toast
 * that scrolls away. The count is also read on the server, so the switch is
 * already disabled with the reason underneath it before anyone clicks — and
 * the reason is `occupiedSentence`, the same sentence `/settings/stages`
 * prints when the same function refuses the same switch there. One rule, one
 * sentence; M7's settings screen is where the switch lives for every stage,
 * and this is the lane's own copy of it at the end of the loop it belongs to.
 */
export function RepurposedLane({
  stage,
  occupied,
  onChanged,
}: {
  /** The channel's Repurposed stage, or null if it somehow has none. */
  stage: { id: string; name: string; isEnabled: boolean } | null;
  /** Non-archived videos currently sitting in it, counted on the server. */
  occupied: number;
  onChanged: () => void;
}) {
  const inputId = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [enabled, setEnabled] = useState(stage?.isEnabled ?? false);

  // A server render is authoritative; only the delta this switch produced is
  // kept, tagged with the props it was computed over. Same shape as the flow
  // block's `applied`, and for the same reason.
  const propsVersion = `${stage?.id}|${stage?.isEnabled}`;
  const [lastVersion, setLastVersion] = useState(propsVersion);
  if (propsVersion !== lastVersion) {
    setLastVersion(propsVersion);
    setEnabled(stage?.isEnabled ?? false);
    setError(null);
  }

  if (!stage) {
    return (
      <p data-testid="repurposed-lane" className="text-xs text-muted">
        This channel has no Repurposed stage to switch on or off.
      </p>
    );
  }

  const blocked = enabled && occupied > 0;

  /**
   * Flip it now, put it back if the server says no.
   *
   * The optimistic step is not for speed, it is because this is a *controlled*
   * checkbox: without it the box springs back to its old position the instant
   * it is clicked and only moves once the round trip lands, which reads as "the
   * click did nothing". The rollback is the whole of the bargain — a refusal
   * (the lane still holds videos) puts the box back and says why, and a failed
   * request leaves the lane exactly as the server has it.
   */
  async function toggle(next: boolean): Promise<void> {
    if (!stage) return;
    const previous = enabled;
    setEnabled(next);
    setBusy(true);
    setError(null);
    try {
      const result = await setStageEnabled({ stageId: stage.id, enabled: next });
      if (!result.ok) {
        setEnabled(previous);
        setError(result.error);
        return;
      }
      setEnabled(result.enabled);
      onChanged();
    } catch {
      setEnabled(previous);
      setError("Could not reach the server, so the lane is unchanged.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      data-testid="repurposed-lane"
      data-enabled={enabled ? "true" : "false"}
      className="flex flex-col gap-2 border-t border-border pt-4"
    >
      <div className="flex flex-wrap items-center gap-2">
        <input
          id={inputId}
          type="checkbox"
          data-testid="repurposed-toggle"
          checked={enabled}
          disabled={busy || blocked}
          onChange={(event) => void toggle(event.target.checked)}
          className="size-4 accent-[var(--accent)] outline-none focus-visible:ring-2 focus-visible:ring-accent"
        />
        <label htmlFor={inputId} className="text-sm">
          The <span className="font-medium">{stage.name}</span> lane is switched
          on for this channel
        </label>
      </div>

      <p
        data-testid="repurposed-note"
        role={error ? "alert" : undefined}
        className={[
          "text-xs leading-5",
          error ? "text-attention" : "text-muted",
        ].join(" ")}
      >
        {error ??
          (blocked
            ? occupiedSentence(stage.name, occupied)
            : enabled
              ? "Clips, shorts and the newsletter get their own column at the end of the board. Switch it off if you do not repurpose."
              : "Switched off: the board ends at Published for this channel, and Published is a terminal stage.")}
      </p>
    </div>
  );
}
