import { redirectToFirstChannel } from "../first-channel";

/** `/settings/buckets` with no channel named: the first channel's buckets. */
export default async function BucketSettingsIndex() {
  await redirectToFirstChannel("buckets");
}
