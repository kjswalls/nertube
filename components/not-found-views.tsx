import Link from "next/link";

import { AppShell } from "@/components/app-shell";
import { settingsPath } from "@/components/settings/settings-nav";
import {
  PRIMARY_ACTION,
  QUIET_ACTION,
  StatePanel,
} from "@/components/state-panel";
import { requireUser } from "@/lib/supabase/require-user";

/**
 * What a missing thing looks like, in the application's own frame.
 *
 * Until M9 there was no `not-found.tsx` anywhere, so every `notFound()` — a
 * video id that was never issued, somebody else's video, a channel slug with a
 * typo, a settings page for a channel that is gone — drew Next's default: a
 * bare "404 | This page could not be found." on the page ground, no sidebar,
 * no way back but the browser's own. It was correct and it was a dead end.
 *
 * These render inside `AppShell`, so the sidebar is where it always is, and
 * each one names the most likely reason and the nearest real place to go.
 *
 * ## What they deliberately do not say
 *
 * Which of "does not exist" and "is not yours" it is. Every read goes through
 * the signed-in user's RLS, so the page genuinely cannot tell, and a 404 that
 * could would confirm to whoever guessed an id that it is real (the reason
 * `app/videos/[id]/page.tsx` gives for being a 404 and not a 403). The status
 * stays 404: `e2e/upload.spec.ts` and `e2e/settings-checklists.spec.ts` assert
 * it, and `e2e/empty-states.spec.ts` asserts the words.
 */

/** The user's channels, oldest first — the order the sidebar lists them in. */
async function readChannels(): Promise<{ name: string; slug: string }[]> {
  const { supabase } = await requireUser();
  const { data } = await supabase
    .from("channels")
    .select("name, slug")
    .order("created_at", { ascending: true });
  // A failed read here is a 404 page that offers fewer links, not a second
  // error on top of the first one.
  return data ?? [];
}

/** A URL that matches no route, or a `notFound()` with no closer file. */
export async function NothingHere() {
  const channels = await readChannels();
  const first = channels[0];

  return (
    <AppShell gutter="reading">
      <title>Not found · NerTube</title>
      <StatePanel
        testId="not-found"
        headingLevel={1}
        title="Nothing lives at this address"
        actions={
          <>
            {first ? (
              <Link href="/now" className={PRIMARY_ACTION}>
                Go to Now
              </Link>
            ) : (
              <Link href="/c/new" className={PRIMARY_ACTION}>
                Create your first channel
              </Link>
            )}
            {first ? (
              <Link href={`/c/${first.slug}/board`} className={QUIET_ACTION}>
                {first.name}&rsquo;s board
              </Link>
            ) : null}
          </>
        }
      >
        <p>
          The link may be mistyped, or it may point at something that has
          since been renamed. Everything you have is reachable from the
          sidebar.
        </p>
      </StatePanel>
    </AppShell>
  );
}

/** `/videos/<id>` for an id this account cannot read. */
export async function MissingVideo() {
  const channels = await readChannels();
  const first = channels[0];

  return (
    <AppShell gutter="reading">
      <title>Video not found · NerTube</title>
      <StatePanel
        testId="video-not-found"
        headingLevel={1}
        title="This video isn’t here"
        actions={
          <>
            <Link href="/now" className={PRIMARY_ACTION}>
              Go to Now
            </Link>
            {first ? (
              <Link href={`/c/${first.slug}/ideas`} className={QUIET_ACTION}>
                Search the idea bank
              </Link>
            ) : null}
          </>
        }
      >
        <p>
          Nothing in your account has this address. The link may be
          incomplete, or it may belong to a different account — NerTube shows
          the two the same way on purpose, so an address cannot be used to
          find out what exists.
        </p>
      </StatePanel>
    </AppShell>
  );
}

/**
 * `/c/<slug>/…` or `/settings/<section>/<slug>` for a slug this account does
 * not have. The fix is almost always "you meant one of these", so they are
 * listed, each one click from the same place in the right channel.
 */
export async function MissingChannel({
  destination,
}: {
  destination: "board" | "settings";
}) {
  const channels = await readChannels();
  const hrefOf = (slug: string) =>
    destination === "board" ? `/c/${slug}/board` : settingsPath("stages", slug);

  return (
    <AppShell gutter="reading">
      <title>Channel not found · NerTube</title>
      <StatePanel
        testId="channel-not-found"
        headingLevel={1}
        title="There is no channel at this address"
        actions={
          channels.length === 0 ? (
            <Link href="/c/new" className={PRIMARY_ACTION}>
              Create your first channel
            </Link>
          ) : (
            <>
              <Link href={hrefOf(channels[0].slug)} className={PRIMARY_ACTION}>
                Open {channels[0].name}
              </Link>
              <Link href="/c/new" className={QUIET_ACTION}>
                New channel
              </Link>
            </>
          )
        }
      >
        <p>
          A channel&rsquo;s address is its name as a slug, fixed when it was
          created. This one does not match any channel in your account.
        </p>
        {channels.length > 1 ? (
          <p>
            Your channels:{" "}
            {channels.map((channel, index) => (
              <span key={channel.slug}>
                <Link
                  href={hrefOf(channel.slug)}
                  data-testid="not-found-channel"
                  className="text-foreground underline decoration-dotted underline-offset-2 outline-none hover:decoration-solid focus-visible:ring-2 focus-visible:ring-accent"
                >
                  {channel.name}
                </Link>
                {index < channels.length - 1 ? ", " : "."}
              </span>
            ))}
          </p>
        ) : null}
      </StatePanel>
    </AppShell>
  );
}
