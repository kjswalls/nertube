import { AppShell } from "@/components/app-shell";
import { requireUser } from "@/lib/supabase/require-user";

import { NewChannelForm } from "./new-channel-form";

export const metadata = { title: "New channel · NerTube" };

/**
 * Where `/` sends you when you have no channels yet — which makes it, on a
 * brand-new account, the first screen of the product.
 *
 * M9: it used to be a heading ("New channel") and a form, the same for the
 * first channel as for the fifth. The first time, the person has not yet been
 * told what a channel *is* here or why it comes before everything else — and
 * every other page they can reach from the sidebar sends them back to this one
 * — so the first-run version says it, in two sentences, above the same form.
 * The count is read rather than assumed: a person with channels who comes here
 * from the sidebar's "New channel" wants the form, not the welcome.
 */
export default async function NewChannelPage() {
  const { supabase } = await requireUser();
  const { count } = await supabase
    .from("channels")
    .select("id", { count: "exact", head: true });
  // A failed count reads as "not the first": the plain form is the safer page.
  const first = count === 0;

  return (
    <AppShell gutter="reading">
      <div className="mx-auto flex w-full max-w-md flex-col gap-6">
        <div className="flex flex-col gap-2">
          <h1
            data-testid="new-channel-heading"
            className="font-display text-[24px] leading-tight font-semibold tracking-tight"
          >
            {first ? "Start with a channel" : "New channel"}
          </h1>
          {first ? (
            <p
              data-testid="new-channel-intro"
              className="text-[14px] leading-relaxed text-muted"
            >
              Everything in NerTube belongs to a channel: its board, its idea
              bank, and the stages and checklists a video moves through. Name
              the one you publish to most — a second can be added any time.
            </p>
          ) : null}
        </div>
        <NewChannelForm />
      </div>
    </AppShell>
  );
}
