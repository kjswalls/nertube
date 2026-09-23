import { ScriptEditor } from "@/components/script/script-editor";
import type { ScriptStructure } from "@/lib/script";
import { SCRIPT_STRUCTURE_LABEL } from "@/lib/script";

/**
 * The Script section: `videos.script`, its structure and its end-screen
 * target.
 *
 * ## Where it is written, and where it is not
 *
 * From Scripting onward it is an editor (`components/script/script-editor.tsx`):
 * the script as a growing markdown textarea that saves as it is typed, the
 * structure and the end-screen target beside it, and Reset from template.
 *
 * Before Scripting it is not, and the reason is BRIEF.md's first principle,
 * not an unfinished feature: title, thumbnail concept and hook are decided
 * before the script is written, and the app makes skipping that awkward. The
 * rule is `scriptIsEditable` in `lib/script.ts`, which `updateVideo` enforces
 * for the same three columns and the Script tab's lock is drawn from.
 *
 * `move_video` still writes the first draft: on a video's first entry to
 * Scripting it copies the channel's template in with the chosen hook where
 * `{{hook}}` is (only while the column is empty). The editor opens on that.
 *
 * ## A video that went back
 *
 * A video moved back to Packaging keeps its script. It is shown here as it
 * stands, in the reading face, and opens for editing again when the video
 * comes forward — nothing is thrown away by a move in either direction.
 *
 * ## Why no rendered markdown
 *
 * The column holds markdown *source* — `## Hook (verbatim)`, `B-roll:` lines —
 * and PLAN.md reads BRIEF.md's "markdown" as markdown text: no renderer, which
 * would also hide the scaffolding the template is made of.
 */
export function ScriptSection({
  videoId,
  script,
  structure,
  endScreenTarget,
  editable,
  stageName,
  scriptingName,
}: {
  videoId: string;
  /** `videos.script`, or null when nothing has been written. */
  script: string | null;
  structure: ScriptStructure | null;
  endScreenTarget: string | null;
  /** `scriptIsEditable(stage kind)` — the one rule, computed by the page. */
  editable: boolean;
  /** The current stage's name, for the sentence explaining why it is closed. */
  stageName: string;
  /** What this channel calls its scripting-kind stage. */
  scriptingName: string;
}) {
  if (editable) {
    return (
      <ScriptEditor
        videoId={videoId}
        initialScript={script}
        initialStructure={structure}
        initialEndScreenTarget={endScreenTarget}
        scriptingName={scriptingName}
      />
    );
  }

  const text = script ?? "";
  const hasText = text.trim() !== "";

  return (
    <section
      data-testid="script-section"
      data-editable="false"
      aria-labelledby="script-heading"
      className="flex flex-col gap-3 rounded-card border border-border p-4"
    >
      <div className="flex flex-col gap-1">
        <h2 id="script-heading" className="text-sm font-semibold">
          Script
        </h2>
        <p data-testid="script-note" className="text-xs text-muted">
          Written from {scriptingName} on — the title, thumbnail concept and hook
          are decided first.
        </p>
      </div>

      {hasText ? (
        <>
          <p data-testid="script-kept" className="text-xs text-muted">
            This video is back in {stageName}. Its script is kept exactly as it
            was, and opens for editing again when the video returns to{" "}
            {scriptingName}.
            {structure || endScreenTarget ? (
              <>
                {" "}
                {structure ? `Structure: ${SCRIPT_STRUCTURE_LABEL[structure]}.` : ""}
                {structure && endScreenTarget ? " " : ""}
                {endScreenTarget ? `End screen: ${endScreenTarget}.` : ""}
              </>
            ) : null}
          </p>
          <div
            data-testid="script-text"
            className="rounded-input border border-border bg-surface px-4 py-3 font-display text-base leading-relaxed whitespace-pre-wrap break-words"
          >
            {text}
          </div>
        </>
      ) : (
        <p data-testid="script-empty" className="text-xs text-muted">
          Nothing here yet. When this video moves from {stageName} into{" "}
          {scriptingName}, its script starts from the channel&rsquo;s template with
          the chosen hook written in, and opens here for editing.
        </p>
      )}
    </section>
  );
}
