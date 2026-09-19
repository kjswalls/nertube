import Link from "next/link";

import { settingsPath, type SettingsSection } from "./settings-nav";

/**
 * Which channel's settings are on screen, and the way to another's.
 *
 * Every setting in this area is per channel (BRIEF.md: *"Stage definitions,
 * checklist templates, and content buckets are all per-channel"*), and the
 * settings routes live outside `/c/[slug]`, so the channel is the last
 * segment of the address and these are real links to it — the same section,
 * the other channel. A settings page for one channel is a place, it can be
 * pasted to somebody, and `aria-current="page"` says which one is showing
 * without inventing a tab widget.
 *
 * Rendered only when there is a choice to make: one channel is not a switch,
 * and the heading beside it already names the channel.
 */
export function ChannelSwitch({
  channels,
  currentSlug,
  section,
}: {
  channels: readonly { id: string; name: string; slug: string }[];
  currentSlug: string;
  /** The settings section these links stay on. */
  section: SettingsSection;
}) {
  if (channels.length < 2) return null;

  return (
    <nav
      aria-label="Channel"
      data-testid="settings-channel-switch"
      className="flex flex-wrap items-center gap-1"
    >
      {channels.map((channel) => {
        const current = channel.slug === currentSlug;
        return (
          <Link
            key={channel.id}
            href={settingsPath(section, channel.slug)}
            aria-current={current ? "page" : undefined}
            data-testid="settings-channel-link"
            className={[
              "rounded-button border px-2 py-1 text-[12px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent",
              current
                ? "border-border bg-surface font-medium text-foreground"
                : "border-transparent text-muted hover:text-foreground",
            ].join(" ")}
          >
            {channel.name}
          </Link>
        );
      })}
    </nav>
  );
}
