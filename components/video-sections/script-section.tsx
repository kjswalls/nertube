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
 * So it shows the column and says plainly that it is not edited here.
 *
 * M9 was the last milestone and built no editor (the README's limits say so,
 * prominently), so the sentence no longer promises one "for now": it says
 * where the script is actually written, and that the copy here is written
 * once — a hook chosen or a template changed afterwards never reaches it,
 * because `move_video` fills the column only while it is null, and PLAN.md's
 * "reset script from template" was not built (M9 review).
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
  scriptingName,
}: {
  /** `videos.script`, or null when the video has never entered Scripting. */
  script: string | null;
  /** Has the video reached a Scripting stage? */
  reachedScripting: boolean;
  /** The current stage's name, for the sentence explaining an empty script. */
  stageName: string;
  /**
   * What this channel calls its scripting-kind stage. The sentence below
   * names both the column the video is in and the one it is going to, and
   * naming the first by its label and the second by the seed's word was one
   * sentence with two vocabularies (M7's review).
   */
  scriptingName: string;
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
        <p data-testid="script-note" className="text-xs text-muted">
          Your starting draft: the channel&rsquo;s template with the chosen hook
          spliced in, written once, when this video first moved into {scriptingName}.{" "}
          <strong className="font-medium">It is not edited here</strong> — write the
          script in your own editor, starting from this copy. A hook or template
          changed after that first move does not reach it.
        </p>
      </div>

      {text === "" ? (
        <p data-testid="script-empty" className="text-xs text-muted">
          {reachedScripting
            ? `This video is past ${scriptingName} and its script column is empty — it was cleared, or it entered the stage before the template existed.`
            : `Nothing here yet. The script is filled in when this video moves from ${stageName} into ${scriptingName}.`}
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
