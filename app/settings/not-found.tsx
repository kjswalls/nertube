import { MissingChannel } from "@/components/not-found-views";

/** `/settings/<section>/<slug>` for a slug this account lacks. */
export default function SettingsChannelNotFound() {
  return <MissingChannel destination="settings" />;
}
