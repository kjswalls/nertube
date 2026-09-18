import Link from "next/link";

/**
 * The locked thumbnail **concept**, quoted at the top of the assets section.
 *
 * ## Why this is the first thing on the section
 *
 * BRIEF.md principle 2: *the concept is locked at the TTH stage (so you film
 * the right shots); the final image files are produced much later. Two
 * different fields at two different stages.* The risk that creates is not that
 * the two get mixed up in the database — they are different columns — but that
 * by the time someone is uploading images, weeks later, the sentence they
 * agreed to shoot against is three tabs away and nobody looks at it. The
 * variants then drift into "three pictures we happen to have" rather than
 * three executions of one idea, and the gate that was supposed to make the
 * shoot deliberate has bought nothing.
 *
 * So the concept is the brief the three frames below are working against, and
 * it is quoted where they are. It is deliberately **read-only here**: one
 * thread, two stages. Editing it is a packaging decision, so the link goes back
 * to the field on the Packaging section rather than putting a second editable
 * copy of one column on one page — which is a race, and the same mistake the
 * working title avoided in M2.
 */
export function ConceptBrief({
  concept,
  /** `/videos/<id>?section=packaging#packaging-thumbnail-concept`. */
  conceptHref,
}: {
  concept: string | null;
  conceptHref: string;
}) {
  const written = (concept ?? "").trim();

  return (
    <section
      aria-labelledby="thumbnail-concept-brief-heading"
      data-testid="thumbnail-concept-brief"
      data-filled={written === "" ? "false" : "true"}
      className="flex flex-col gap-2 rounded-card border border-border bg-surface px-4 py-3"
    >
      <h3
        id="thumbnail-concept-brief-heading"
        className="text-xs font-medium tracking-wide text-muted uppercase"
      >
        The concept these are working against
      </h3>

      {written === "" ? (
        <p className="text-sm text-muted">
          No thumbnail concept is written down yet. It is the gate&rsquo;s field
          and it belongs to Packaging — decide it there first, so the three
          variants below are three executions of one idea rather than three
          separate guesses.
        </p>
      ) : (
        <blockquote
          data-testid="thumbnail-concept-quote"
          className="border-l-2 border-border pl-3 font-display text-base leading-relaxed [overflow-wrap:anywhere]"
        >
          {written}
        </blockquote>
      )}

      <p className="text-xs text-muted">
        Locked at Packaging.{" "}
        <Link
          href={conceptHref}
          data-testid="thumbnail-concept-edit-link"
          className="underline underline-offset-2 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-accent"
        >
          Change it in Packaging
        </Link>
        {" — "}the concept is the idea, these are the files.
      </p>
    </section>
  );
}
