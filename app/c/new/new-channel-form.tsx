"use client";

import { useActionState } from "react";

import {
  createChannelAction,
  type CreateChannelState,
} from "@/app/actions/channels";

export function NewChannelForm() {
  const [state, formAction, pending] = useActionState<
    CreateChannelState,
    FormData
  >(createChannelAction, null);

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <label htmlFor="name" className="text-sm font-medium">
          Channel name
        </label>
        <input
          id="name"
          name="name"
          type="text"
          required
          maxLength={80}
          autoFocus
          autoComplete="off"
          placeholder="Main channel"
          aria-describedby="name-hint"
          className="rounded-md border border-border bg-surface px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-foreground/40"
        />
        <p id="name-hint" className="text-xs text-muted">
          Its board lives at <code>/c/&lt;name-as-a-slug&gt;/board</code>. The
          nine stages, their checklists, the format buckets and the script
          template are created with it.
        </p>
      </div>

      {/* Always rendered so a screen reader announces the message in place. */}
      <p
        role="alert"
        aria-live="polite"
        className="min-h-5 text-sm text-red-600 dark:text-red-400"
      >
        {state?.error}
      </p>

      <button
        type="submit"
        disabled={pending}
        className="self-start rounded-md bg-foreground px-3 py-2 text-sm font-medium text-background outline-none focus-visible:ring-2 focus-visible:ring-foreground/40 disabled:opacity-60"
      >
        {pending ? "Creating…" : "Create channel"}
      </button>
    </form>
  );
}
