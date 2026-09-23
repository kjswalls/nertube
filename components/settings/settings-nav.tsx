import Link from "next/link";

/**
 * The settings screens, as one row of links: four for one channel, and the
 * user's own time zone (M10), which belongs to the account rather than to any
 * channel and so has one address with no slug (`/settings/account`).
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
  { key: "account", label: "Time zone", title: "Time zone", path: "/settings/account" },
] as const;

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]["key"];

/** The per-user section: not about a channel, so its address has no slug. */
export const ACCOUNT_SECTION = "account" satisfies SettingsSection;

/**
 * The one place a settings address is spelled. With no slug, a channel
 * section's bare path, which redirects to the first channel's page.
 */
export function settingsPath(section: SettingsSection, slug?: string): string {
  const meta = SETTINGS_SECTIONS.find((candidate) => candidate.key === section)!;
  if (section === ACCOUNT_SECTION || slug === undefined) return meta.path;
  return `${meta.path}/${encodeURIComponent(slug)}`;
}

export function SettingsNav({
  current,
  slug,
}: {
  current: SettingsSection;
  /** The channel the channel sections open on; none on the account page. */
  slug?: string;
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
              "rounded-button px-2 py-1 text-[12px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent thumb:flex thumb:min-h-11 thumb:items-center thumb:px-3 thumb:text-[14px]",
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
