import Link from "next/link";

/**
 * The settings area's one refusal line.
 *
 * A settings screen refuses things — a stage still holding videos, a name the
 * channel already has, a quota of zero, an order the database would not take
 * — and three slices each drew the refusal their own way, in two different
 * colours. This is the one way. It is `role="alert"`, because a refusal is the
 * case where something the person asked for did not happen; it is set in
 * `attention`, the same token `SaveStatus` uses for a failed save, so a
 * refused write and a failed one read as the same kind of news; and when the
 * refusal has somewhere to go — the board column that is still occupied, the
 * idea bank — the link is part of the sentence.
 *
 * It is not a modal (`components/modal.tsx` is for confirmations) and not a
 * toast (a refusal belongs beside the control that was refused, where the
 * person is looking). Save failures on a field keep going through
 * `SaveStatus`, which carries the Retry; this is for the refusals that have no
 * payload to retry.
 */
export function Refusal({
  testId,
  message,
  href,
  label,
}: {
  testId: string;
  message: string;
  /** Where the thing that caused the refusal is, if it is somewhere. */
  href?: string;
  label?: string;
}) {
  return (
    <p role="alert" data-testid={testId} className="text-[12px] leading-5 text-attention">
      {message}
      {href && label ? (
        <>
          {" "}
          <Link
            href={href}
            data-testid={`${testId}-link`}
            className="underline decoration-attention/50 underline-offset-2 hover:decoration-attention"
          >
            {label}
          </Link>
        </>
      ) : null}
    </p>
  );
}
