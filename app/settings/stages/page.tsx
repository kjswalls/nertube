import { redirectToFirstChannel } from "../first-channel";

/** `/settings/stages` with no channel named: the first channel's stages. */
export default async function StageSettingsIndex() {
  await redirectToFirstChannel("stages");
}
