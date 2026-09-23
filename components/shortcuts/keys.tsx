import { Fragment } from "react";

/**
 * A key combination as the tool draws it: each key its own cap, in the mono
 * face every measured thing in this app uses.
 *
 * The notation is the one `ShortcutHint.keys` is written in, so a binding says
 * how it is drawn once and every surface reads it the same way:
 *
 * - `"j / k"` — either key: two caps with a slash between;
 * - `"g n"` — one key then the other: two caps with "then" between;
 * - `"Shift+Enter"` — held together: two caps with a plus between;
 * - anything else — one cap (`"1–9"` is one cap on purpose: it is a range, not
 *   nine keys).
 */
export function Keys({ keys }: { keys: string }) {
  const either = keys.split(" / ");
  return (
    <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap">
      {either.map((option, index) => (
        <Fragment key={option}>
          {index > 0 ? (
            <span aria-hidden="true" className="text-[11px] text-muted">
              /
            </span>
          ) : null}
          <Option option={option} />
        </Fragment>
      ))}
    </span>
  );
}

function Option({ option }: { option: string }) {
  if (option.length > 1 && option.includes("+")) {
    return <Joined parts={option.split("+")} between="+" />;
  }
  if (option.includes(" ")) {
    return <Joined parts={option.split(" ")} between="then" />;
  }
  return <Cap>{option}</Cap>;
}

function Joined({ parts, between }: { parts: string[]; between: string }) {
  return (
    <>
      {parts.map((part, index) => (
        <Fragment key={`${part}-${index}`}>
          {index > 0 ? (
            <span className="text-[11px] text-muted">{between}</span>
          ) : null}
          <Cap>{part}</Cap>
        </Fragment>
      ))}
    </>
  );
}

export function Cap({ children }: { children: string }) {
  return (
    <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded-button border border-border bg-background px-1.5 font-mono text-[11px] leading-none text-foreground">
      {children}
    </kbd>
  );
}
