import { MissingChannel } from "@/components/not-found-views";

/** `/c/<slug>/board` and `/c/<slug>/ideas` for a slug this account lacks. */
export default function ChannelNotFound() {
  return <MissingChannel destination="board" />;
}
