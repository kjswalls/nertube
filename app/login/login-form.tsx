"use client";

import { useActionState } from "react";

import { signIn, type SignInState } from "@/app/actions/auth";

export function LoginForm({ next }: { next: string }) {
  const [state, formAction, pending] = useActionState<SignInState, FormData>(
    signIn,
    null,
  );

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <input type="hidden" name="next" value={next} />

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
        className="rounded-button bg-foreground px-3 py-2 text-[13px] font-medium text-background outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-60"
      >
        {pending ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
