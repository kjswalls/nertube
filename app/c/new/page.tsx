import { AppHeader } from "@/components/app-header";

import { NewChannelForm } from "./new-channel-form";

export const metadata = { title: "New channel · NerTube" };

/** Where `/` sends you when you have no channels yet. */
export default function NewChannelPage() {
  return (
    <div className="flex min-h-dvh flex-col">
      <AppHeader />

      <main className="mx-auto flex w-full max-w-md flex-col gap-6 px-4 py-12">
        <h1 className="text-xl font-semibold tracking-tight">New channel</h1>
        <NewChannelForm />
      </main>
    </div>
  );
}
