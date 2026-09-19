import type { ReactNode } from "react";

import { ChannelSwitch } from "./channel-switch";
import { SETTINGS_SECTIONS, SettingsNav, type SettingsSection } from "./settings-nav";

/**
 * The top of every settings page: which area this is, which of its four
 * screens is showing, which channel it is about, and one paragraph saying
 * what the screen changes elsewhere.
 *
 * Four pages were built as four slices, and each arrived with its own copy of
 * this — a switch here, a nav there, a heading in every file with the channel
 * name beside it in a slightly different place. One component, so the four
 * read as one tool: the same strip in the same place, the channel named the
 * same way, and `data-testid="settings-channel-name"` meaning the same thing
 * on every screen.
 *
 * The channel is unmistakable on purpose. It is in the address, in the switch
 * (when there is more than one), in the heading, and — because every page
 * passes `currentSlug` to the shell — in the sidebar's channel list, marked
 * `aria-current`. Editing the wrong channel's stages is the one mistake this
 * area can make that another screen cannot undo.
 */
export function SettingsHeader({
  section,
  channel,
  channels,
  children,
}: {
  section: SettingsSection;
  channel: { readonly id: string; readonly name: string; readonly slug: string };
  channels: readonly { id: string; name: string; slug: string }[];
  /** The sentence or two under the heading: what this screen changes, and where. */
  children?: ReactNode;
}) {
  const meta = SETTINGS_SECTIONS.find((candidate) => candidate.key === section)!;

  return (
    <header className="flex flex-col gap-3">
      <p className="text-[11px] font-medium tracking-[0.06em] text-muted uppercase">
        Settings
      </p>

      <SettingsNav current={section} slug={channel.slug} />

      <ChannelSwitch channels={channels} currentSlug={channel.slug} section={section} />

      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h1 className="font-display text-[22px] leading-tight font-semibold tracking-tight">
          {meta.title}
        </h1>
        <p data-testid="settings-channel-name" className="text-[12px] text-muted">
          {channel.name}
        </p>
      </div>

      {children ? (
        <div className="max-w-2xl text-[13px] leading-5 text-muted">{children}</div>
      ) : null}
    </header>
  );
}
