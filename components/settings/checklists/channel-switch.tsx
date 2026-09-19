import Link from "next/link";

/**
 * Which channel's templates are on screen.
 *
 * Templates are per channel (BRIEF.md: *"Stage definitions, checklist
 * templates, and content buckets are all per-channel"*), and the settings
 * routes live outside `/c/[slug]`, so the channel is the last segment of the
 * address and these are real links to it — a settings page for one channel is
 * a place, it can be pasted to somebody, and `aria-current="page"` says which
 * one is showing without inventing a tab widget.
 *
 * Rendered only when there is a choice to make: one channel is not a switch.
 */
export function ChannelSwitch({
  channels,
  currentSlug,
  basePath,
}: {
  channels: readonly { id: string; name: string; slug: string }[];
  currentSlug: string;
  /** The settings route these links point back at. */
  basePath: string;
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
            href={`${basePath}/${encodeURIComponent(channel.slug)}`}
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
