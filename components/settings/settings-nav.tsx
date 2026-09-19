import Link from "next/link";

/**
 * The four settings screens, as one row of links, for one channel.
 *
 * Settings is one area with four pages — stages, checklist templates,
 * buckets and the channel's own fields — because BRIEF.md makes every one of
 * them a *per-channel* thing and PLAN.md gives them one address. The routes
 * are `/settings/<section>/[slug]`: the section first because it is what the
 * sidebar's row and this strip choose between, the channel last so a page
 * for one channel is a place that can be pasted. This strip is how a person
 * gets from any of the four to the others without losing the channel, and
 * `ChannelSwitch` beneath it is how they change the channel without losing
 * the section. Together with `SettingsHeader` they are the whole navigation
 * of the area; no page draws its own.
 */
export const SETTINGS_SECTIONS = [
  { key: "stages", label: "Stages", title: "Stages", path: "/settings/stages" },
  {
    key: "checklists",
    label: "Checklists",
    title: "Checklist templates",
    path: "/settings/checklists",
  },
  { key: "buckets", label: "Buckets", title: "Buckets", path: "/settings/buckets" },
  { key: "channel", label: "Channel", title: "Channel", path: "/settings/channel" },
] as const;

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]["key"];

/** The one place a settings address is spelled. */
export function settingsPath(section: SettingsSection, slug: string): string {
  const meta = SETTINGS_SECTIONS.find((candidate) => candidate.key === section)!;
  return `${meta.path}/${encodeURIComponent(slug)}`;
}

export function SettingsNav({
  current,
  slug,
}: {
  current: SettingsSection;
  slug: string;
}) {
  return (
    <nav
      aria-label="Settings"
      data-testid="settings-nav"
      className="flex flex-wrap items-center gap-1 border-b border-border pb-2"
    >
      {SETTINGS_SECTIONS.map((section) => {
        const isCurrent = section.key === current;
        return (
          <Link
            key={section.key}
            href={settingsPath(section.key, slug)}
            aria-current={isCurrent ? "page" : undefined}
            data-testid="settings-nav-link"
            data-section={section.key}
            className={[
              "rounded-button px-2 py-1 text-[12px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent",
              isCurrent
                ? "bg-surface font-medium text-foreground shadow-[inset_0_0_0_1px_var(--hairline)]"
                : "text-muted hover:text-foreground",
            ].join(" ")}
          >
            {section.label}
          </Link>
        );
      })}
    </nav>
  );
}
