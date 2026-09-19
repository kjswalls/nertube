import { redirectToFirstChannel } from "../first-channel";

/** `/settings/checklists` with no channel named: the first channel's templates. */
export default async function ChecklistSettingsIndex() {
  await redirectToFirstChannel("checklists");
}
