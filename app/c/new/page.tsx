import { AppShell } from "@/components/app-shell";

import { NewChannelForm } from "./new-channel-form";

export const metadata = { title: "New channel · NerTube" };

/** Where `/` sends you when you have no channels yet. */
export default function NewChannelPage() {
  return (
    <AppShell gutter="reading">
      <div className="mx-auto flex w-full max-w-md flex-col gap-6">
        <h1 className="font-display text-[24px] leading-tight font-semibold tracking-tight">
          New channel
        </h1>
        <NewChannelForm />
      </div>
    </AppShell>
  );
}
