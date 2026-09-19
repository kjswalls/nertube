import { redirectToFirstChannel } from "./first-channel";

/**
 * `/settings` — the area's front door, which the sidebar's Settings row and a
 * typed address both reach. It opens on the first channel's stages, the
 * first of the four screens, the way `/` opens on `/now`.
 */
export default async function SettingsIndex() {
  await redirectToFirstChannel("stages");
}
