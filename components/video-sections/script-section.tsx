/**
 * The Script section: `videos.script`, as it stands.
 *
 * ## Where the text comes from, and why there is no editor here
 *
 * `move_video` fills this column on a video's **first** entry to a Scripting
 * stage, from `channels.script_template` with the chosen hook spliced into the
 * `{{hook}}` placeholder. That already works — it is M0's plpgsql, exercised by
 * the SQL suite — so by the time this section has anything to show, the
 * structure of the script is there and the hook is verbatim at the top of it.
 *
 * What is *not* here is a way to write into it. `script` is not in
 * `lib/video-fields.ts`'s patch vocabulary and `updateVideo` has no branch for
 * it, so there is no write path to bind a textarea to. Shipping a textarea over
 * a column that cannot be saved would be the worst version of this section: it
 * would accept a whole evening's work and lose it on the next render, silently.
 * So it shows the column and says plainly that it is read-only, and the field
 * plus its save path arrive together rather than the field arriving first.
 *
 * ## Why a `<pre>` and not prose
 *
 * The column holds markdown *source* — `## Hook (verbatim)`, `B-roll:` lines,
 * a `Structure:` line. Rendering it as formatted prose would need a markdown
 * renderer, which PLAN.md's dependency ceiling does not allow and which would
 * also hide exactly the scaffolding the template is made of. It is shown as
 * what it is, wrapped, in the tool's own face — this is not the user's prose
 * being read, it is a document being worked on.
 */
export function ScriptSection({
  script,
  reachedScripting,
  stageName,
}: {
  /** `videos.script`, or null when the video has never entered Scripting. */
  script: string | null;
  /** Has the video reached a Scripting stage? */
  reachedScripting: boolean;
  /** The current stage's name, for the sentence explaining an empty script. */
  stageName: string;
}) {
  const text = script?.trim() ?? "";

  return (
    <section
      data-testid="script-section"
      aria-labelledby="script-heading"
      className="flex flex-col gap-3 rounded-card border border-border p-4"
    >
      <div className="flex flex-col gap-1">
        <h2 id="script-heading" className="text-sm font-semibold">
          Script
        </h2>
        <p className="text-xs text-muted">
          Written from the channel&rsquo;s template on the way into Scripting,
          with the chosen hook already spliced in.{" "}
          <strong className="font-medium">Read-only for now</strong> — the
          editor and its save path arrive together, so that nothing typed here
          can be lost.
        </p>
      </div>

      {text === "" ? (
        <p data-testid="script-empty" className="text-xs text-muted">
          {reachedScripting
            ? "This video is past Scripting and its script column is empty — it was cleared, or it entered the stage before the template existed."
            : `Nothing here yet. The script is filled in when this video moves from ${stageName} into Scripting.`}
        </p>
      ) : (
        <pre
          data-testid="script-text"
          className="max-h-[32rem] overflow-auto whitespace-pre-wrap break-words rounded-input border border-border bg-surface p-3 font-sans text-sm leading-relaxed"
        >
          {text}
        </pre>
      )}
    </section>
  );
}
