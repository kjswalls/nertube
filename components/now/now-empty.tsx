import Link from "next/link";

import { CaptureLink } from "@/components/capture/capture-dialog";
import {
  PRIMARY_ACTION,
  QUIET_ACTION,
  StatePanel,
} from "@/components/state-panel";
import type { NowChannel, NowVideo } from "@/lib/next-action";

/**
 * `/now` with no rows at all — said according to *why* there are none.
 *
 * Until M9 this was one sentence for every case: "Nothing is waiting on you.
 * Capture an idea with c, or promote one from the board." That was true on a
 * brand-new account and misleading on the commonest early one: a person who
 * has captured six ideas and promoted none is told nothing is waiting, when
 * six things are — just not on this page, because `/now` skips kind `idea` by
 * design (PLAN.md rule list: promotion is a deliberate act). So there are
 * three cases, and each says which one it is and hands over the one move that
 * changes it:
 *
 * 1. **Nothing captured** — capture the first idea, here, in the same box `c`
 *    opens.
 * 2. **Ideas, but nothing in production** — go to the bank, where Promote is.
 *    The bank with the most ideas, because that is where the choosing is.
 * 3. **Videos in production with nothing to offer** — every one is finished,
 *    scheduled with no date, or through its checklist with no next stage. The
 *    board is where to see which.
 *
 * The filtered and set-aside cases are not here: those rows exist, and the
 * page's own sentence about the filters is the right answer to them.
 */
export function NowEmpty({
  channels,
  videos,
}: {
  channels: readonly NowChannel[];
  videos: readonly NowVideo[];
}) {
  const kindOf = new Map<string, string | null>();
  for (const channel of channels) {
    for (const stage of channel.stages) kindOf.set(stage.id, stage.kind);
  }

  const ideasByChannel = new Map<string, number>();
  let inProduction = 0;
  for (const video of videos) {
    // A video in a switched-off stage is on no board and no list; it is not
    // "in production" for the purposes of a sentence about where to look.
    if (!kindOf.has(video.stageId)) continue;
    if (kindOf.get(video.stageId) === "idea") {
      ideasByChannel.set(
        video.channelId,
        (ideasByChannel.get(video.channelId) ?? 0) + 1,
      );
    } else {
      inProduction += 1;
    }
  }

  const ideaCount = [...ideasByChannel.values()].reduce((a, b) => a + b, 0);
  const captureChannels = channels.map(({ id, name, slug }) => ({ id, name, slug }));

  if (inProduction > 0) {
    const first = channels[0];
    return (
      <StatePanel
        testId="now-empty"
        title="Nothing needs you right now"
        actions={
          first ? (
            <Link href={`/c/${first.slug}/board`} className={PRIMARY_ACTION}>
              Open the board
            </Link>
          ) : null
        }
      >
        <p>
          {inProduction === 1
            ? "One video is in production, and it has no small step to offer yet"
            : `${inProduction} videos are in production, and none has a small step to offer yet`}{" "}
          — they are published and logged, scheduled without a date, or
          through their checklist with nowhere further to go. The board shows
          where each one is.
        </p>
      </StatePanel>
    );
  }

  if (ideaCount > 0) {
    const [busiest] = [...ideasByChannel.entries()].sort((a, b) => b[1] - a[1]);
    const channel = channels.find((candidate) => candidate.id === busiest[0]);
    return (
      <StatePanel
        testId="now-empty"
        title="Nothing is in production yet"
        actions={
          <>
            {channel ? (
              <Link
                href={`/c/${channel.slug}/ideas`}
                data-testid="now-empty-bank"
                className={PRIMARY_ACTION}
              >
                Choose an idea to promote
              </Link>
            ) : null}
            <CaptureLink channels={captureChannels} className={QUIET_ACTION}>
              Capture another
            </CaptureLink>
          </>
        }
      >
        <p>
          {ideaCount === 1
            ? "You have one idea in the bank."
            : `You have ${ideaCount} ideas in the bank.`}{" "}
          Ideas wait there until you commit to one. Promote it to Packaging —
          title, thumbnail concept, hook — and from then on its next small
          step shows up here, ready to do in a spare ten minutes.
        </p>
      </StatePanel>
    );
  }

  return (
    <StatePanel
      testId="now-empty"
      title="Nothing to move yet"
      actions={
        <CaptureLink
          channels={captureChannels}
          testId="now-empty-capture"
          className={PRIMARY_ACTION}
        >
          Capture your first idea
        </CaptureLink>
      }
    >
      <p>
        This page answers one question: you have ten minutes — what can you
        move? It lists the next small step on every video you are making,
        across every channel, oldest first, each one finishable right here.
      </p>
      <p>
        It starts with an idea. A title is enough; the rest comes later, one
        column at a time.
      </p>
    </StatePanel>
  );
}
