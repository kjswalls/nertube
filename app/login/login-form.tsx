"use client";

import { useActionState, useEffect, useRef } from "react";

import { signIn, type SignInState } from "@/app/actions/auth";

/** The browser's own zone, or "" when it will not say. */
function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? "";
  } catch {
    return "";
  }
}

export function LoginForm({ next }: { next: string }) {
  const [state, formAction, pending] = useActionState<SignInState, FormData>(
    signIn,
    null,
  );

  /*
    The browser's zone rides along with the sign-in (M10), so "today" is the
    user's day from the first page after it, with no page drawn in UTC first.
    `signIn` records it only if the account has none yet — a zone chosen in
    Settings, or recorded from another device, is never replaced.

    Written into the hidden field after hydration and again on submit (React
    resets a form's uncontrolled fields after an action), never during render:
    the server cannot know it, so rendering it would not hydrate.
  */
  const zoneRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (zoneRef.current) zoneRef.current.value = browserTimeZone();
  });

  return (
    <form
      action={formAction}
      onSubmit={() => {
        if (zoneRef.current) zoneRef.current.value = browserTimeZone();
      }}
      className="flex flex-col gap-4"
    >
      <input type="hidden" name="next" value={next} />
      <input ref={zoneRef} type="hidden" name="timeZone" defaultValue="" />

      <div className="flex flex-col gap-1.5">
        <label htmlFor="email" className="text-[13px] font-medium">
          Email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          required
          autoFocus
          autoComplete="username"
          className="rounded-input border border-border bg-surface px-3 py-2 text-base outline-none focus-visible:ring-2 focus-visible:ring-accent"
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="password" className="text-[13px] font-medium">
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          required
          autoComplete="current-password"
          className="rounded-input border border-border bg-surface px-3 py-2 text-base outline-none focus-visible:ring-2 focus-visible:ring-accent"
        />
      </div>

      {/* Always rendered so a screen reader announces the message in place. */}
      <p role="alert" aria-live="polite" className="min-h-5 text-[13px] text-over-limit">
        {state?.error}
      </p>

      <button
        type="submit"
        disabled={pending}
        className="rounded-button bg-foreground px-3 py-2 text-[13px] font-medium text-background outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-60 thumb:min-h-11"
      >
        {pending ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
