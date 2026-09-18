/**
 * The assist control, present and inert.
 *
 * M8 is the brainstorm module: twenty titles with rationales, thumbnail concept
 * suggestions, a third hook. This is where each of those will be asked for, and
 * the reason it exists three milestones early is that *where the button is* is a
 * design decision about the packaging block, not about the API — it changes how
 * the fields are laid out and how the block reads. Deciding it now, with the
 * button visibly disabled, is honest; discovering in M8 that there is nowhere to
 * put it is not.
 *
 * ## It is disabled, and it also says so
 *
 * `disabled` is the affordance: the control is there, it is plainly not
 * available, and pressing it does nothing because there is nothing behind it.
 * The `title` explains when it arrives — but a disabled button is not
 * focusable, so a keyboard or screen-reader user never reaches that tooltip. So
 * the milestone is *also* drawn on the pill, in small type. The information is
 * visible, not hovering.
 *
 * This is a plain Server Component: there is no handler, no state, and nothing
 * to hydrate. When M8 wires it up it becomes a client component with an action;
 * until then shipping a listener for a button that cannot be pressed would be
 * shipping the illusion of one.
 */
export function AssistPill({
  verb,
  what,
  milestone = "M8",
}: {
  /** The verb on the pill: "Generate 20", "Suggest concepts", "Draft a third". */
  verb: string;
  /** What it will do, in a sentence, for the tooltip. */
  what: string;
  milestone?: string;
}) {
  return (
    <button
      type="button"
      disabled
      data-testid="assist-pill"
      data-assist={verb}
      title={`${what} Arrives in ${milestone}.`}
      className="inline-flex cursor-not-allowed items-center gap-1.5 rounded-button border border-border px-2 py-1 text-xs text-muted opacity-80"
    >
      <span>{verb}</span>
      <span className="font-mono text-[11px] uppercase tracking-wide">{milestone}</span>
    </button>
  );
}
