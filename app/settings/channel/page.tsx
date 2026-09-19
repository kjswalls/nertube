import { redirectToFirstChannel } from "../first-channel";

/** `/settings/channel` with no channel named: the first channel's own settings. */
export default async function ChannelSettingsIndex() {
  await redirectToFirstChannel("channel");
}
