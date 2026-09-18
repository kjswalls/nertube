"use client";

import { useRouter } from "next/navigation";
import {
  useActionState,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";

import { captureVideoAction, type CaptureState } from "@/app/actions/videos";
import { CaptureBuckets } from "@/components/ideas/assign/capture-buckets";

import { readLastChannel, writeLastChannel } from "./last-channel";

/** The channels a capture may be aimed at, in the sidebar's order. */
export interface CaptureChannel {
  id: string;
  name: string;
  slug: string;
}

/**
 * The capture form: one input, Enter, done.
 *
 * The same component is the body of the `c` modal and the whole of `/capture`,
 * because PLAN.md says they are the same form and because two copies would
 * drift. `variant` changes what happens *after* a save — the modal closes, the
 * page clears itself and waits for the next idea — and nothing else.
 *
 * The fast path is one field. Hook, notes, tags and the two content buckets
 * live behind a disclosure that is closed until asked for, so nothing between
 * `c` and Enter can be mistaken for something that wants filling in. The
 * buckets are the newest thing behind it and the one most able to break that
 * promise: they are two menus whose options have to be *fetched*, so they are
 * mounted only while the disclosure is open and ask for nothing until they are
 * — see `components/ideas/assign/capture-buckets.tsx`.
 */
export function CaptureForm({
  channels,
  initialChannelId,
  preferLastUsed,
  variant,
  prefill,
  onSaved,
  autoFocus = true,
}: {
  channels: readonly CaptureChannel[];
  /** The route's channel, or the first one. Always a real id. */
  initialChannelId: string;
  /**
   * True when the route does not name a channel, so the last-used one wins.
   * Read from localStorage after mount — the server cannot know it, and
   * rendering it on the server would be a hydration mismatch.
   */
  preferLastUsed: boolean;
  variant: "modal" | "page";
  /**
   * Both content buckets, already chosen — the matrix's empty cell filling in
   * the one thing it knows about an idea that does not exist yet.
   *
   * They are the *initial value* of this form's own two bucket fields: they ride
   * as hidden inputs while the disclosure is closed, so the no-JavaScript post
   * carries them too, and as the selected options in the pickers once it is
   * open. Either way they are stated on screen — a form that silently files an
   * idea somewhere is worse than one that does not file it at all — and either
   * way there is exactly one control per name. Both axes or neither: a cell is
   * an intersection, and half of one is not a thing the matrix can offer.
   *
   * The pair belongs to `initialChannelId`'s channel, and the composite foreign
   * key in `0001_init.sql` binds a video's bucket to its own channel and axis —
   * so a caller that passes these must not also offer a channel switch. The
   * matrix passes one channel for exactly that reason.
   */
  prefill?: {
    verticalId: string;
    verticalName: string;
    horizontalId: string;
    horizontalName: string;
  };
  /** Modal variant: called once a capture has been written. */
  onSaved?: (saved: { id: string; title: string; channelName: string }) => void;
  autoFocus?: boolean;
}) {
  const router = useRouter();
  /**
   * The action is still attached to the <form>, and that is the whole of the
   * no-JavaScript path: the browser posts, the server runs `captureVideoAction`
   * and re-renders this component with its result in `state`. Nothing else in
   * this file is required for a capture to be written and confirmed.
   */
  const [state, formAction] = useActionState<CaptureState, FormData>(
    captureVideoAction,
    null,
  );
  /**
   * The result of a submit this component made itself.
   *
   * With JavaScript running, `onSubmit` cancels the form's own submission and
   * calls the action here instead. That is not a style preference: an action
   * driven by `useActionState` that *rejects* — the server is unreachable, the
   * POST is aborted — is rethrown into the nearest error boundary, and the
   * whole route is replaced by an error screen with the typed idea inside it.
   * A capture box is the last thing in the application that may lose what was
   * typed, so the rejection is caught here and rendered as a message above a
   * form that still holds the title.
   */
  const [clientResult, setClientResult] = useState<CaptureState>(null);
  const [submitting, setSubmitting] = useState(false);
  /** Whichever answer is the newer one; only one of the two ever arrives. */
  const outcome = clientResult ?? state;

  const [channelId, setChannelId] = useState(initialChannelId);
  const [title, setTitle] = useState("");
  const [more, setMore] = useState(false);
  /**
   * The two content buckets, as ids or `""`.
   *
   * Held here rather than inside the pickers because the form owns every other
   * field's value and because they have to survive the disclosure being closed
   * and reopened — and because changing channel has to clear them, which is a
   * fact about the *form*, not about either menu. A prefilled pair (the
   * matrix's empty cell) is simply their initial value: one source for the
   * choice, whether it was made in the grid or in the menu.
   */
  const [verticalId, setVerticalId] = useState(prefill?.verticalId ?? "");
  const [horizontalId, setHorizontalId] = useState(prefill?.horizontalId ?? "");
  /**
   * The empty-title refusal, decided here: it must never cost a round trip,
   * and `required` alone cannot see that "   " is empty.
   */
  const [clientError, setClientError] = useState<string | null>(null);
  /**
   * Whether the page variant's "Captured …" line has been typed over.
   *
   * The line itself is derived from the action's result during render rather
   * than copied into state by an effect, because effects do not run when
   * JavaScript never arrives and `/capture` is the one route that has to work
   * when it does not: without this the no-JS capture is written and the page
   * comes back looking exactly as it did before, which invites a re-type.
   */
  const [confirmationHidden, setConfirmationHidden] = useState(false);

  const titleRef = useRef<HTMLInputElement>(null);
  const hookRef = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLFormElement>(null);

  const ids = useId();
  const titleId = `${ids}-title`;
  const hookId = `${ids}-hook`;
  const notesId = `${ids}-notes`;
  const tagsId = `${ids}-tags`;
  const moreId = `${ids}-more`;
  const bucketsHintId = `${ids}-buckets-hint`;
  const hintId = `${ids}-hint`;

  /**
   * Put the cursor in the title field.
   *
   * The `autoFocus` attribute alone is not enough inside the modal: React
   * restores the focus that was there *before* a commit as part of that commit,
   * so opening the dialog from a focused control (the sidebar's Capture button,
   * say) ends with focus back on that control and the dialog's first tab stop
   * picking it up. An effect runs after that restoration, so this wins. The
   * attribute stays for the server-rendered `/capture`, where the browser
   * focuses the field before any JavaScript has run at all.
   */
  useEffect(() => {
    if (autoFocus) titleRef.current?.focus();
  }, [autoFocus]);

  // The last-used channel, once there is a browser to ask. Only when the route
  // did not already name one: an explicit channel always beats a remembered one.
  useEffect(() => {
    if (!preferLastUsed) return;
    const remembered = readLastChannel();
    if (remembered && channels.some((channel) => channel.id === remembered)) {
      // Reading localStorage is the one thing that cannot happen during render:
      // the server does not have it, so rendering from it is a hydration
      // mismatch. An effect is the supported place, and this one runs once.
      // eslint-disable-next-line react-hooks/set-state-in-effect -- see above
      setChannelId(remembered);
    }
    // Once, on mount: re-running this would fight a `1..9` retarget.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A capture landed. Clear the form either way; who gets told depends on the
  // variant.
  useEffect(() => {
    if (!outcome || !outcome.ok) return;

    writeLastChannel(outcome.channelId);
    // `useActionState` hands the result back as state rather than to a
    // callback, so clearing the form for the next idea is necessarily a
    // response to that state arriving. Keeping the action attached to the
    // <form> is what makes /capture work with no JavaScript at all, which is
    // worth one effect.
    /* eslint-disable react-hooks/set-state-in-effect -- see above */
    setTitle("");
    setMore(false);
    setClientError(null);
    setConfirmationHidden(false);
    // Back to the pair the form started with: none, or the cell's if this form
    // is the matrix's, which is still the cell the person is filling.
    setVerticalId(prefill?.verticalId ?? "");
    setHorizontalId(prefill?.horizontalId ?? "");
    formRef.current?.reset();
    // `reset()` also resets the radios to their *rendered* `defaultChecked`,
    // and the channel is React state, so put it back.
    setChannelId(outcome.channelId);

    // The action revalidated the board; this is what re-renders it in place, so
    // the new card shows up without anyone reaching for the reload button.
    router.refresh();

    if (variant === "modal") {
      onSaved?.({
        id: outcome.id,
        title: outcome.title,
        channelName: outcome.channelName,
      });
    } else {
      titleRef.current?.focus();
    }
    /* eslint-enable react-hooks/set-state-in-effect */
    // `outcome` is a fresh object per submission, which is what makes this fire
    // once per capture.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outcome]);

  /**
   * Aim the capture at a channel, forgetting any buckets chosen for the last
   * one.
   *
   * A bucket belongs to a channel — `videos` binds each slot to its own
   * channel's bucket of the right axis through a three-column foreign key — so
   * a vertical picked for one channel is not a value the next channel has.
   * Carrying it over would post an id the database refuses; the honest thing is
   * to start that channel's filing from nothing.
   */
  function aimAt(nextChannelId: string): void {
    if (nextChannelId === channelId) return;
    setChannelId(nextChannelId);
    setVerticalId("");
    setHorizontalId("");
  }

  /** Aim the capture at the nth channel (1-based), if there is one. */
  function retarget(position: number): boolean {
    const channel = channels[position - 1];
    if (!channel) return false;
    aimAt(channel.id);
    return true;
  }

  /**
   * Keys the title input handles itself.
   *
   * **Shift+Enter opens the disclosure.** A single-line input submits its form
   * on Enter *whether or not* Shift is held, so this has to run first.
   *
   * **A bare digit is text, always.** PLAN.md asks for "`1..9` retargets the
   * channel before Enter", and the literal reading — a digit is a channel while
   * the field is still empty — quietly eats the first character of every title
   * that starts with a number ("10 things…", "2 years of…") *and* files the
   * idea in a channel the person was not looking at, with no warning and no
   * undo. On the most-used path in the product that trade is not close, so
   * retargeting is: Alt+digit (read off `event.code`, because Alt+1 is `¡` on a
   * Mac keyboard), the numbered channel chips, which are clickable and are tab
   * stops, and the sidebar's own `1`..`9` outside any field.
   */
  function onTitleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter" && event.shiftKey) {
      event.preventDefault();
      setMore(true);
      // The disclosure renders in the same commit; focus it after that.
      requestAnimationFrame(() => hookRef.current?.focus());
      return;
    }

    if (event.ctrlKey || event.metaKey) return;

    if (event.altKey) {
      const fromCode = /^Digit([1-9])$/.exec(event.code);
      if (fromCode && retarget(Number(fromCode[1]))) event.preventDefault();
      return;
    }
  }

  // The client-side refusal wins while it stands: it is the newer answer.
  const error = clientError ?? (outcome && !outcome.ok ? outcome.error : null);

  /**
   * The page variant's confirmation, derived — not stored. Present on the
   * server-rendered answer to a no-JS submit, gone again as soon as the next
   * idea is typed.
   */
  const confirmation =
    outcome?.ok && !confirmationHidden
      ? `Captured “${outcome.title}” in ${outcome.channelName}.`
      : "";
  const current = channels.find((channel) => channel.id === channelId);

  const field =
    "w-full rounded-input border border-border bg-background px-3 py-2 text-base outline-none focus-visible:ring-2 focus-visible:ring-accent";

  return (
    <form
      ref={formRef}
      action={formAction}
      onSubmit={(event) => {
        // Refused here, before the action is ever called: an empty or
        // whitespace-only title is not a network problem. (The server action
        // validates the same rule with zod — this form is not the only caller,
        // and a client check is a convenience, never a guarantee.)
        if (title.trim() === "") {
          event.preventDefault();
          setClientError(
            "Give the idea a title — anything you will recognise later.",
          );
          titleRef.current?.focus();
          return;
        }
        setClientError(null);

        // From here on this handler owns the submission — see `clientResult`.
        // With no JavaScript none of this runs and the form posts to
        // `formAction` exactly as it did before.
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        /*
          The two buckets, taken from this form's own state rather than from
          whatever the DOM happened to post.

          `FormData` skips a **disabled** control, and both pickers are disabled
          while `listBuckets` is in flight and while an axis has no options at
          all — which is exactly the window a matrix capture opens in, because
          `CaptureBuckets` mounts (and only then fetches) when the disclosure
          does. Before this, opening the disclosure unmounted the hidden inputs
          below and handed the two names to controls that were not going to
          post, so an Enter during that window wrote the idea **unfiled** while
          the "Filing it under X · Y" line was still on screen. Silently: the
          capture succeeded, and the cell stayed drawn as a hole.

          Setting them here makes the posted pair and the sentence one thing —
          `verticalId`/`horizontalId` are the same state the line is derived
          from. `""` is what the empty option holds and what the action reads as
          "not sent"; `data.set` replaces the select's entry rather than adding
          a second one, so there is still exactly one value per name.
        */
        data.set("verticalId", verticalId);
        data.set("horizontalId", horizontalId);
        setSubmitting(true);
        void captureVideoAction(null, data)
          .then((result) => setClientResult(result))
          .catch(() =>
            setClientResult({
              ok: false,
              error:
                "Could not reach the server, so nothing was saved. What you typed is still here — try again.",
            }),
          )
          .finally(() => setSubmitting(false));
      }}
      /* `required` still tells assistive technology the field is required;
         `noValidate` keeps the browser's own bubble out of the way, because it
         fires before this handler and cannot see the whitespace case. */
      noValidate
      className="flex flex-col gap-3"
      // A capture is never a browser-autofilled form.
      autoComplete="off"
    >
      <div className="flex flex-col gap-1.5">
        <label htmlFor={titleId} className="text-sm font-medium">
          Idea
        </label>
        <input
          ref={titleRef}
          id={titleId}
          name="title"
          type="text"
          required
          maxLength={300}
          /* The modal exists to put the cursor here, and /capture is a
             capture-only route: both are the documented exception to "never
             move focus for the user". */
          autoFocus={autoFocus}
          value={title}
          onChange={(event) => {
            setTitle(event.target.value);
            if (clientError) setClientError(null);
            if (!confirmationHidden) setConfirmationHidden(true);
          }}
          onKeyDown={onTitleKeyDown}
          aria-invalid={error ? true : undefined}
          aria-describedby={hintId}
          placeholder="What is the video?"
          className={field}
        />
        <p id={hintId} className="text-xs text-muted">
          Enter saves it as an idea
          {current ? ` in ${current.name}` : ""}. Shift+Enter adds a hook, notes,
          tags and the two buckets.
          {channels.length > 1
            ? " Alt+1–9, or the chips below, pick the channel."
            : ""}
        </p>

        {/*
          The cell's own sentence, while it is still true.

          The matrix hands this form a pair and says so in words, because a form
          that silently files an idea somewhere is worse than one that does not
          file it at all. Now that the disclosure can *change* that pair, the
          sentence is conditional on it: the moment either menu is touched it
          goes, and the menus — which are on screen, because that is where the
          change was made — are the statement instead. A stale "filing it under
          money · review" over a picker reading `focus` is the one thing this
          line must never become.
        */}
        {prefill &&
        verticalId === prefill.verticalId &&
        horizontalId === prefill.horizontalId ? (
          <p data-testid="capture-prefill" className="text-xs text-muted">
            Filing it under{" "}
            <span className="text-foreground">{prefill.verticalName}</span> ·{" "}
            <span className="text-foreground">{prefill.horizontalName}</span>.
          </p>
        ) : null}
      </div>

      {/*
        The buckets, when the disclosure is closed: hidden inputs, so the
        browser posts them whether or not this component's own submit handler
        ever runs — and so a matrix cell's pair survives a no-JavaScript post.

        **Exactly one control per name.** When the disclosure is open the
        pickers below carry these names instead; rendering both would put two
        `verticalId` entries in the FormData, and `formData.get` answers with
        the first, which would be whichever one the JSX happened to render
        earlier. The value is the same state either way, so opening the
        disclosure shows the cell's pair already selected rather than replacing
        it.

        With JavaScript running none of this decides anything: the submit
        handler above overwrites both names from state, precisely because a
        picker that is momentarily `disabled` posts nothing and this pair must
        not depend on a control's enabled-ness. This is the no-JavaScript path,
        where the disclosure cannot be open without a click that also runs the
        handler.
      */}
      {!more && (verticalId !== "" || horizontalId !== "") ? (
        <>
          <input type="hidden" name="verticalId" value={verticalId} />
          <input type="hidden" name="horizontalId" value={horizontalId} />
        </>
      ) : null}

      <fieldset className="flex flex-col gap-1.5">
        <legend className="text-sm font-medium">Channel</legend>
        <div className="flex flex-wrap gap-2">
          {channels.map((channel, index) => {
            const checked = channel.id === channelId;
            return (
              <label
                key={channel.id}
                className={[
                  "inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-full border px-4 py-2 text-sm",
                  "focus-within:ring-2 focus-within:ring-accent",
                  checked
                    ? "border-foreground bg-foreground font-medium text-background"
                    : "border-border text-muted hover:text-foreground",
                ].join(" ")}
              >
                <input
                  type="radio"
                  name="channelId"
                  value={channel.id}
                  checked={checked}
                  onChange={() => aimAt(channel.id)}
                  className="sr-only"
                />
                {index < 9 ? (
                  <span
                    aria-hidden="true"
                    className={[
                      "rounded-button px-1 text-xs tabular-nums",
                      checked ? "bg-background/20" : "bg-surface",
                    ].join(" ")}
                  >
                    {index + 1}
                  </span>
                ) : null}
                {channel.name}
              </label>
            );
          })}
        </div>
      </fieldset>

      <div className="flex flex-col gap-3">
        <button
          type="button"
          onClick={() => {
            const next = !more;
            setMore(next);
            if (next) requestAnimationFrame(() => hookRef.current?.focus());
          }}
          aria-expanded={more}
          aria-controls={moreId}
          className="self-start rounded-button px-1 py-1 text-sm text-muted underline-offset-4 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-accent"
        >
          {more ? "Less" : "More"}
        </button>

        {/* Unmounted, not hidden: an empty <textarea> that is merely invisible
            still posts, and still collects a tab stop. */}
        {more ? (
          <div id={moreId} className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <label htmlFor={hookId} className="text-sm font-medium">
                One-line hook
              </label>
              <input
                ref={hookRef}
                id={hookId}
                name="oneLineHook"
                type="text"
                className={field}
                placeholder="The promise in one line"
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <label htmlFor={notesId} className="text-sm font-medium">
                Notes
              </label>
              <textarea id={notesId} name="notes" rows={3} className={field} />
            </div>

            <div className="flex flex-col gap-1.5">
              <label htmlFor={tagsId} className="text-sm font-medium">
                Tags
              </label>
              <input
                id={tagsId}
                name="tags"
                type="text"
                className={field}
                placeholder="comma, separated"
              />
            </div>

            {/* The two content buckets. One of each axis, this channel's only,
                and nothing is asked of the server until this disclosure is
                open. */}
            <CaptureBuckets
              channelId={channelId}
              vertical={verticalId}
              horizontal={horizontalId}
              hintId={bucketsHintId}
              onChange={(axis, value) => {
                if (axis === "vertical") setVerticalId(value);
                else setHorizontalId(value);
              }}
            />
          </div>
        ) : null}
      </div>

      {/* Always rendered so a screen reader announces the message in place. */}
      <p
        role="alert"
        aria-live="assertive"
        className="min-h-5 text-sm text-over-limit"
      >
        {error}
      </p>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={submitting}
          className="min-h-11 rounded-button bg-foreground px-4 py-2 text-sm font-medium text-background outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-60"
        >
          {submitting ? "Saving…" : "Capture"}
        </button>

        {variant === "page" ? (
          <p role="status" aria-live="polite" className="text-sm text-muted">
            {confirmation}
          </p>
        ) : null}
      </div>
    </form>
  );
}
