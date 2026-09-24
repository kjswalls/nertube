import { sameLabel, stripInvisible } from "@/lib/text";

import { assemble } from "./clamp";
import type { CritiquePayload, SuggestionsPayload } from "./schema";
import {
  AssistError,
  MANUAL_MODEL,
  MANUAL_PROVIDER,
  type AssistKind,
  type AssistProvider,
  type AssistRequest,
  type AssistResult,
  type ThumbnailVerdict,
} from "./types";

/**
 * Reading back what claude.ai said (M11, "Open in Claude").
 *
 * The person ran the prompt from `lib/assist/manual.ts` in their own
 * conversation and pasted the reply into the panel. This turns that text into
 * the same payload the API's structured output produces — and then hands it
 * to the same `assemble()` in `clamp.ts`, so a pasted answer gets the same
 * caps, the same column-length clamps, the same de-duplication against what
 * the video already has, and the same "nothing usable" refusal as one the key
 * paid for. {@link createPastedProvider} wraps it as one more implementation
 * of `AssistProvider`: the app still has one seam, and this is a provider
 * whose "model call" is a paste.
 *
 * ## Forgiving, in a specific order
 *
 * The prompt asks for `1. text || why` lines and a `PICK: n || why` line.
 * People and models drift from that, and a reply the app refuses over a
 * formatting detail is a reply the person has to retype. So, in order:
 *
 * 1. Code fences, blockquotes, bold and heading marks are stripped, and
 *    anything before or after the list — "Here are twenty titles:", "Want me
 *    to…?" — is ignored, because only lines that look like proposals are read.
 * 2. Lines carrying ` || ` are the proposals, numbered or not.
 * 3. With no ` || ` anywhere, numbered or bulleted lines are read instead,
 *    split on the separators people actually type — ` | `, an em or en dash,
 *    ` - ` — or with the reason on the line underneath ("Why: …").
 * 4. Markdown table rows (`| 1 | Title | Why |`) are read as cells.
 *
 * M11's adversarial review tightened five things: the prompt pasted back is
 * refused as the prompt (its example lines are shaped like an answer); a
 * `<placeholder>` is never a proposal; "Best:" or "Winner —" at the start of
 * a *listed* line is a title, not the pick, and the last pick line wins; a
 * numbered proposal may run over more than one line, and a reason may sit in
 * a bullet nested under its item; and prose that quotes the separator is not
 * a proposal.
 *
 * What it will not do is guess: a line that is not shaped like a proposal is
 * not one, and a reply with none of them is an {@link AssistError} whose
 * message says exactly what was expected. It never throws anything else, and
 * it never touches the text it was given — the panel keeps it in the box.
 *
 * Pure: strings in, payloads out. No key, no network, no `server-only` —
 * though only the server action imports it, so none of its wording reaches
 * the browser bundle.
 */

/** A reply longer than this is not an answer to these prompts. */
export const MAX_REPLY_LENGTH = 40_000;

/* -------------------------------------------------------------------------- */
/* What was expected, said out loud                                            */
/* -------------------------------------------------------------------------- */

const EXPECTED: Record<AssistKind, string> = {
  titles:
    "Could not find any titles in that. It expects one per line, like “1. The title || why it works”, and a “PICK: 3 || why” line at the end — which is what the prompt asks Claude for. Paste Claude’s whole reply, or fix the lines, and read it again.",
  concepts:
    "Could not find any concepts in that. It expects one per line, like “1. The shot to film || why it works”, and a “PICK: 2 || why” line at the end — which is what the prompt asks Claude for. Paste Claude’s whole reply, or fix the lines, and read it again.",
  hooks:
    "Could not find any hooks in that. It expects one per line, like “1. The opening lines || why they work”, and a “PICK: 1 || why” line at the end — which is what the prompt asks Claude for. Paste Claude’s whole reply, or fix the lines, and read it again.",
  thumbnail_critique:
    "Could not find a verdict in that. It expects one line per image, like “WILD CARD || reads: yes || adds: no || what to change”, and a “SHIP: moderate” line at the end — which is what the prompt asks Claude for. Paste Claude’s whole reply, or fix the lines, and read it again.",
};

const NOTHING_PASTED =
  "There is nothing in the box yet. Paste Claude’s whole reply, then press Read.";

const TOO_LONG = `That is longer than any answer to this prompt (${MAX_REPLY_LENGTH.toLocaleString("en-GB")} characters at most). Paste only Claude’s reply to it.`;

/* -------------------------------------------------------------------------- */
/* Lines                                                                       */
/* -------------------------------------------------------------------------- */

interface Line {
  /** The text with markdown decoration and any list marker removed. */
  readonly body: string;
  /** The number the line was given, when it was numbered. */
  readonly number: number | null;
  /** Numbered or bulleted. */
  readonly listed: boolean;
  /** A markdown heading, which is never a proposal. */
  readonly heading: boolean;
  /** Blank after cleaning. */
  readonly blank: boolean;
  /** `| a | b |` — a markdown table row. */
  readonly tableRow: boolean;
  /** Leading whitespace before any quote mark or list marker. */
  readonly indent: number;
  /** A bullet (not a number) — the shape of a nested "Why:" under an item. */
  readonly bullet: boolean;
  /** The line quotes the separator in inline code: prose about the format. */
  readonly quotesSeparator: boolean;
  readonly raw: string;
}

const FENCE = /^\s*(```|~~~)/;
const LIST_MARKER = /^(?:\(?(\d{1,3})[.):\]]|(\d{1,3})\s*[-–—]|[-*•+·])\s+/;
const HEADING = /^#{1,6}\s+/;

/** Bold, italics-by-underscore and inline code marks, anywhere in a line. */
function unDecorate(value: string): string {
  return value
    .replace(/\*\*|__/g, "")
    .replace(/`+/g, "")
    .replace(/^\*(.+)\*$/, "$1")
    .trim();
}

/** Quotation marks wrapped around a whole proposal. */
function unQuote(value: string): string {
  const trimmed = value.trim();
  const pairs: [string, string][] = [
    ['"', '"'],
    ["“", "”"],
    ["‘", "’"],
    ["'", "'"],
    ["«", "»"],
  ];
  for (const [open, close] of pairs) {
    if (
      trimmed.length >= 2 &&
      trimmed.startsWith(open) &&
      trimmed.endsWith(close) &&
      !trimmed.slice(1, -1).includes(close)
    ) {
      return trimmed.slice(1, -1).trim();
    }
  }
  return trimmed;
}

function linesOf(text: string): Line[] {
  const out: Line[] = [];
  for (const rawLine of stripInvisible(text).replace(/\r\n?/g, "\n").split("\n")) {
    if (FENCE.test(rawLine)) continue;
    let line = rawLine.trim().replace(/^(?:>\s?)+/, "").trim();
    const heading = HEADING.test(line);
    if (heading) line = line.replace(HEADING, "");
    const tableRow = /^\|.*\|$/.test(line);
    line = unDecorate(line);

    let number: number | null = null;
    let listed = false;
    const marker = !tableRow ? LIST_MARKER.exec(line) : null;
    if (marker) {
      listed = true;
      const digits = marker[1] ?? marker[2];
      number = digits === undefined ? null : Number(digits);
      line = line.slice(marker[0].length);
    }
    const body = unDecorate(line);
    out.push({
      body,
      number,
      listed,
      heading,
      blank: body === "",
      tableRow,
      indent: /^\s*/.exec(rawLine.replace(/\t/g, "    "))![0].length,
      bullet: listed && number === null,
      quotesSeparator: /`[^`]*(?:\|\||‖)[^`]*`/.test(rawLine),
      raw: rawLine,
    });
  }
  return out;
}

/** `||` first; then what people type when they do not use it. */
const PRIMARY = /\s*(?:\|\||‖)\s*/;
const FALLBACKS: readonly RegExp[] = [/\s+\|\s+/, /\s+[—–]\s+/, /\s+--\s+/, /\s+-\s+/];

function splitOn(body: string, separator: RegExp): [string, string] | null {
  const match = separator.exec(body);
  if (!match || match.index === 0) return null;
  return [body.slice(0, match.index), body.slice(match.index + match[0].length)];
}

const REASON_LABEL = /^(?:why( it works| this works)?|reason|rationale|because)\s*[:—–-]\s*/i;

/**
 * "Why: …", "Reason — …", "— …", "*Why it works:* …": the label a reason line
 * tends to carry, in claude.ai's usual italics too (M11 review, finding 12).
 */
function unLabelReason(value: string): string {
  return unQuote(
    value
      .trim()
      .replace(/^[*_]+\s*((?:why|reason|rationale|because)[^*_]*?)\s*[*_]+\s*/i, "$1 ")
      .replace(/^[-—–:]\s*/, "")
      .replace(REASON_LABEL, "")
      .trim(),
  );
}

/** A line whose body is a labelled reason: "Why: …", "*Why it works:* …". */
function isReasonLine(line: Line): boolean {
  return REASON_LABEL.test(line.body.replace(/^[*_]+/, ""));
}

/**
 * The prompt's own placeholder — `<the title>`, `<one sentence: why it
 * works>` — which is what a reply looks like when the prompt itself was
 * pasted back (M11 review, finding 4). Never a proposal.
 */
function isPlaceholder(value: string): boolean {
  return /^<[^<>]*>$/.test(value.trim());
}

/**
 * Wrapping quotes that only half survived a join: a hook quoted across two
 * lines keeps its opening mark on the first and its closing mark on the last.
 */
function unQuoteUnbalanced(value: string): string {
  const trimmed = value.trim();
  const count = (mark: string) => trimmed.split(mark).length - 1;
  for (const [open, close] of [['"', '"'], ["“", "”"]] as const) {
    if (open === close) {
      if (count(open) === 1) return trimmed.replace(open, "").trim();
    } else if (count(open) + count(close) === 1) {
      return trimmed.replace(open, "").replace(close, "").trim();
    }
  }
  return trimmed;
}

/* -------------------------------------------------------------------------- */
/* The three list kinds                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The pick: `PICK:`, `Recommended:`, `Recommendation:`, `My pick:`, `Top
 * pick:` — the words the prompt uses and the ones a model drifts to. Not
 * "Best:", "Winner —" or "Choice:", which are how ordinary titles begin, and
 * never a *listed* line: a numbered "1. Best: The $5 Tent vs the $500 Tent"
 * is a proposal (M11 review, findings 7 and 21).
 */
const PICK_LINE =
  /^(?:(?:my|top|the)\s+)?(?:pick|recommended|recommendation|strongest(?:\s+pick)?)\s*[:=—–-]\s*(.*)$/i;

interface Proposal {
  readonly text: string;
  readonly rationale: string;
  readonly number: number | null;
}

interface Pick {
  readonly number: number | null;
  readonly text: string;
  readonly reason: string;
}

function readPick(line: Line): Pick | null {
  if (line.tableRow || line.listed) return null;
  const match = PICK_LINE.exec(line.body);
  if (!match) return null;
  const rest = match[1].trim();
  const split = splitOn(rest, PRIMARY) ?? FALLBACKS.map((sep) => splitOn(rest, sep)).find(Boolean) ?? null;
  const head = unQuote(unDecorate(split ? split[0] : rest)).replace(/^#/, "");
  const reason = split ? unLabelReason(split[1]) : "";
  const numbered = /^(?:no\.?\s*|number\s*)?(\d{1,3})\b/i.exec(head);
  return {
    number: numbered ? Number(numbered[1]) : null,
    text: numbered ? "" : head,
    reason,
  };
}

const SEPARATOR_IN = /\|\||‖/;

/**
 * Pass 2: every line that carries the separator the prompt asked for.
 *
 * - A numbered line with no separator yet takes the plain lines under it, up
 *   to the one that carries it: a hook quoted across two lines, or a reason
 *   that wrapped onto the next line, is one proposal (review, finding 10).
 * - When any *numbered* line carries the separator, only numbered lines are
 *   read, so a bulleted aside or a preamble that mentions the format is not a
 *   proposal; prose that quotes the separator in inline code, or ends in a
 *   colon, never is (finding 11).
 * - The prompt's own `<placeholder>` lines are not proposals (finding 4).
 */
function withSeparator(lines: readonly Line[]): Proposal[] {
  const candidates: { body: string; number: number | null }[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.heading || line.tableRow || line.blank || line.quotesSeparator) continue;
    if (readPick(line)) continue;
    let body = line.body;
    if (line.number !== null && !SEPARATOR_IN.test(body)) {
      const joined = [body];
      let next = index + 1;
      for (; next < lines.length; next += 1) {
        const following = lines[next];
        if (following.blank || following.listed || following.heading || following.tableRow) break;
        if (readPick(following)) break;
        joined.push(following.body);
        if (SEPARATOR_IN.test(following.body)) break;
      }
      if (next < lines.length && SEPARATOR_IN.test(joined[joined.length - 1]) && joined.length > 1) {
        body = joined.join(" ");
        index = next;
      }
    }
    if (!SEPARATOR_IN.test(body) || /:\s*$/.test(body)) continue;
    candidates.push({ body, number: line.number });
  }

  const numbered = candidates.some((candidate) => candidate.number !== null);
  const out: Proposal[] = [];
  for (const candidate of candidates) {
    if (numbered && candidate.number === null) continue;
    const split = splitOn(candidate.body, PRIMARY);
    if (!split) continue;
    const text = unQuote(unQuoteUnbalanced(split[0]));
    if (text === "" || isPlaceholder(text)) continue;
    const rationale = unLabelReason(split[1]);
    out.push({
      text,
      rationale: isPlaceholder(rationale) ? "" : rationale,
      number: candidate.number,
    });
  }
  return out;
}

/**
 * Is this listed line the reason for the numbered item above it, rather than
 * a proposal of its own? A bullet indented under a numbered item, or one that
 * starts with a reason label ("- Why: …") — the common markdown shape of a
 * list with its reasons nested underneath (M11 review, finding 20).
 */
function reasonBulletsOf(lines: readonly Line[]): boolean[] {
  const flags = lines.map(() => false);
  let parent: Line | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.heading) {
      parent = null;
      continue;
    }
    if (!line.listed) continue;
    if (line.number !== null) {
      parent = line;
      continue;
    }
    if (parent !== null && (line.indent > parent.indent || isReasonLine(line))) {
      flags[index] = true;
    }
  }
  return flags;
}

/** Pass 3: a numbered or bulleted list, with whatever separator it used. */
function fromList(lines: readonly Line[]): Proposal[] {
  const out: Proposal[] = [];
  const reasonBullet = reasonBulletsOf(lines);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.listed || line.heading || line.blank || reasonBullet[index]) continue;
    // A line carrying the separator was pass 2's to read; if pass 2 found
    // nothing in it (the prompt's own example, a placeholder), neither does this.
    if (SEPARATOR_IN.test(line.body)) continue;

    // The reason on the line(s) underneath — plain lines, or bullets nested
    // under this item — up to the next item or a blank.
    const reason: string[] = [];
    for (let next = index + 1; next < lines.length; next += 1) {
      const following = lines[next];
      if (following.blank || following.heading) break;
      if (following.listed && !reasonBullet[next]) break;
      if (readPick(following)) break;
      reason.push(unLabelReason(following.body));
    }

    const split = FALLBACKS.map((sep) => splitOn(line.body, sep)).find(Boolean) ?? null;
    if (split) {
      const text = unQuote(split[0]);
      if (text !== "" && !isPlaceholder(text)) {
        const own = unLabelReason(split[1]);
        out.push({
          text,
          rationale: [own, ...reason].filter((part) => part !== "").join(" "),
          number: line.number,
        });
      }
      continue;
    }

    const text = unQuote(line.body.replace(/:$/, ""));
    if (text !== "" && !isPlaceholder(text)) {
      out.push({ text, rationale: unLabelReason(reason.join(" ")), number: line.number });
    }
  }
  return out;
}

/** A markdown table's cells, with the separator row and header skipped. */
function cellsOf(line: Line): string[] {
  return line.body
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((cell) => unQuote(unDecorate(cell)));
}

function isRuleRow(line: Line): boolean {
  return /^\|?[\s|:-]+\|?$/.test(line.body) && line.body.includes("-");
}

/** Pass 4: table rows, `| n | text | why |` or `| text | why |`. */
function fromTable(lines: readonly Line[]): Proposal[] {
  const out: Proposal[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.tableRow || isRuleRow(line)) continue;
    // A header is the row immediately above the rule row.
    if (index + 1 < lines.length && isRuleRow(lines[index + 1])) continue;
    const cells = cellsOf(line);
    const numberCell = cells.findIndex((cell) => /^#?\d{1,3}\.?$/.test(cell));
    const words = cells.filter((_cell, at) => at !== numberCell && _cell !== "");
    if (words.length === 0) continue;
    out.push({
      text: words[0],
      rationale: unLabelReason(words.slice(1).join(" ")),
      number: numberCell === -1 ? null : Number(cells[numberCell].replace(/\D/g, "")),
    });
  }
  return out;
}

/**
 * Where the pick points, as a zero-based index into `proposals`, or -1.
 *
 * A number means the number the proposal was *given* when it has one — so a
 * list that skips from 3 to 5 still resolves "PICK: 5" to the fifth line
 * written — and its position otherwise. Text means the proposal that reads
 * the same.
 */
function pickIndex(pick: Pick, proposals: readonly Proposal[]): number {
  if (pick.number !== null) {
    const byNumber = proposals.findIndex((proposal) => proposal.number === pick.number);
    if (byNumber !== -1) return byNumber;
    const byPosition = pick.number - 1;
    return byPosition >= 0 && byPosition < proposals.length ? byPosition : -1;
  }
  if (pick.text === "") return -1;
  return proposals.findIndex((proposal) => sameLabel(proposal.text, pick.text));
}

/**
 * A pasted reply → the payload `assemble()` takes, plus whether it named a
 * pick at all (a reply that did not is not a reply whose pick was dropped).
 */
export function parseSuggestionsReply(
  kind: "titles" | "concepts" | "hooks",
  text: string,
): { payload: SuggestionsPayload; picked: boolean } {
  guard(kind, text);
  const lines = linesOf(text);

  let proposals = withSeparator(lines);
  if (proposals.length === 0) proposals = fromList(lines);
  if (proposals.length === 0) proposals = fromTable(lines);
  if (proposals.length === 0) {
    throw new AssistError("wrong_shape", {
      message: EXPECTED[kind],
      detail: "A pasted reply had no line shaped like a proposal.",
    });
  }

  // The last pick-shaped line: a reply that mentions its pick early ("my pick
  // is below") and then gives it is read by the one it ends on.
  const pick =
    lines
      .map(readPick)
      .filter((found): found is Pick => found !== null && !isPlaceholder(found.text))
      .at(-1) ?? null;
  const index = pick === null ? -1 : pickIndex(pick, proposals);

  return {
    payload: {
      suggestions: proposals.map(({ text: proposal, rationale }) => ({
        text: proposal,
        rationale,
      })),
      recommended_index: index,
      ...(pick !== null && pick.reason !== "" ? { recommended_reason: pick.reason } : {}),
    },
    picked: pick !== null,
  };
}

/* -------------------------------------------------------------------------- */
/* The critique                                                                */
/* -------------------------------------------------------------------------- */

const ROLE_AT_START = /^(wild[\s_-]*card|moderate|safe)\b\s*(?:image|variant|thumbnail)?\s*(?:\(\d\))?\s*[:—–-]?\s*/i;

function roleOf(value: string): ThumbnailVerdict["role"] | null {
  const word = value.trim().toLowerCase().replace(/[\s_-]+/g, "");
  if (word === "wildcard") return "wild_card";
  if (word === "moderate") return "moderate";
  if (word === "safe") return "safe";
  return null;
}

const YES = /^(?:yes|y|true|✓|✔|✅)$/i;
const NO = /^(?:no|n|false|✗|✘|❌)$/i;

function yesNo(value: string): boolean | null {
  const word = value.trim().replace(/[.!,;]$/, "");
  if (YES.test(word)) return true;
  if (NO.test(word)) return false;
  return null;
}

const READS_FIELD = /^(?:reads?(?:\s+at\s+tile\s+size)?|readable|legible|tile)\s*[:=—–-]?\s*(\S+)\s*$/i;
const ADDS_FIELD = /^(?:adds?(?:\s+to\s+(?:the\s+)?title)?|complements?(?:\s+(?:the\s+)?title)?)\s*[:=—–-]?\s*(\S+)\s*$/i;

interface Verdict {
  role: ThumbnailVerdict["role"];
  reads: boolean | null;
  adds: boolean | null;
  note: string[];
}

function readVerdictParts(role: ThumbnailVerdict["role"], parts: string[]): Verdict {
  const verdict: Verdict = { role, reads: null, adds: null, note: [] };
  for (const part of parts) {
    const cleaned = unDecorate(part).trim();
    if (cleaned === "") continue;
    const reads = READS_FIELD.exec(cleaned);
    if (reads && yesNo(reads[1]) !== null && verdict.reads === null) {
      verdict.reads = yesNo(reads[1]);
      continue;
    }
    const adds = ADDS_FIELD.exec(cleaned);
    if (adds && yesNo(adds[1]) !== null && verdict.adds === null) {
      verdict.adds = yesNo(adds[1]);
      continue;
    }
    // A bare yes or no, in the order the prompt lists them.
    const bare = yesNo(cleaned);
    if (bare !== null && verdict.reads === null) {
      verdict.reads = bare;
      continue;
    }
    if (bare !== null && verdict.adds === null) {
      verdict.adds = bare;
      continue;
    }
    verdict.note.push(
      cleaned.replace(/^(?:note|fix|action|advice|why)\s*[:—–-]\s*/i, ""),
    );
  }
  // Written inline without separators: "Reads: yes. Adds: no. Brighten it."
  if (verdict.reads === null || verdict.adds === null) {
    const joined = verdict.note.join(" ");
    // "yes or no" is the prompt's own wording, never an answer (finding 4).
    const inlineReads = /\breads?(?:\s+at\s+tile\s+size)?\s*[:=]?\s*(yes|no)\b(?!\s+or\b)[.,;]?/i.exec(joined);
    const inlineAdds = /\b(?:adds?|complements?)(?:\s+to\s+(?:the\s+)?title)?\s*[:=]?\s*(yes|no)\b(?!\s+or\b)[.,;]?/i.exec(joined);
    let rest = joined;
    if (verdict.reads === null && inlineReads) {
      verdict.reads = yesNo(inlineReads[1]);
      rest = rest.replace(inlineReads[0], "");
    }
    if (verdict.adds === null && inlineAdds) {
      verdict.adds = yesNo(inlineAdds[1]);
      rest = rest.replace(inlineAdds[0], "");
    }
    verdict.note = [rest.replace(/\s+/g, " ").trim()];
  }
  return verdict;
}

const SHIP_LINE =
  /^(?:i\s+would\s+ship|would\s+ship|ship(?:\s+this\s+one)?|pick|recommended|recommendation)\s*[:=—–-]\s*(.*)$/i;

/**
 * A pasted critique → the payload `assemble()` takes.
 *
 * A line is a verdict when it starts with a role's name and says both whether
 * the image reads and whether it adds; a line that names a role but leaves
 * either question unanswered is not a verdict about it, because a guessed
 * "reads at tile size" is the one answer this panel must never invent.
 */
export function parseCritiqueReply(text: string): CritiquePayload {
  guard("thumbnail_critique", text);
  const lines = linesOf(text);
  const verdicts: Verdict[] = [];
  let ship = "";

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.blank || isRuleRow(line)) continue;

    if (line.tableRow) {
      const cells = cellsOf(line);
      const role = cells.length > 0 ? roleOf(cells[0]) : null;
      if (role) verdicts.push(readVerdictParts(role, cells.slice(1)));
      continue;
    }

    const shipMatch = SHIP_LINE.exec(line.body);
    if (shipMatch) {
      const named = unQuote(unDecorate(shipMatch[1]));
      const word = /^\W*(?:none|nothing|neither|no\b)/i.test(named)
        ? null
        : /wild[\s_-]*card|moderate|safe/i.exec(named);
      ship = word ? (roleOf(word[0]) ?? "") : "";
      continue;
    }

    const roleMatch = ROLE_AT_START.exec(line.body);
    if (!roleMatch) continue;
    const role = roleOf(roleMatch[1]);
    if (!role) continue;
    let rest = line.body
      .slice(roleMatch[0].length)
      .replace(/^\s*(?:\|\||‖|\|)\s*/, "");
    // A verdict whose parts run onto the lines underneath it.
    for (let next = index + 1; next < lines.length; next += 1) {
      const following = lines[next];
      if (following.blank || following.heading || following.tableRow) break;
      if (ROLE_AT_START.test(following.body) || SHIP_LINE.test(following.body)) break;
      // Each line underneath is its own part, as if it had been ` || `.
      rest += ` || ${following.body}`;
      index = next;
    }
    const parts = rest.split(/\s*(?:\|\||‖)\s*/);
    const split =
      parts.length > 1
        ? parts
        : (FALLBACKS.slice(0, 1).map((sep) => rest.split(sep)).find((found) => found.length > 1) ??
          [rest]);
    verdicts.push(readVerdictParts(role, split));
  }

  const usable = verdicts.filter(
    (verdict) => verdict.reads !== null && verdict.adds !== null,
  );
  if (usable.length === 0) {
    throw new AssistError("wrong_shape", {
      message: EXPECTED.thumbnail_critique,
      detail: `A pasted critique had ${verdicts.length} role lines and none said both reads and adds.`,
    });
  }

  return {
    verdicts: usable.map((verdict) => ({
      role: verdict.role,
      reads_at_tile_size: verdict.reads === true,
      complements_title: verdict.adds === true,
      note: verdict.note.join(" ").replace(/\s+/g, " ").trim(),
    })),
    recommended_role: ship,
  };
}

/* -------------------------------------------------------------------------- */
/* Guards, and the provider                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Lines only the prompt carries. Open in Claude has just put the prompt on the
 * clipboard, so the likeliest wrong paste is the prompt itself — and its own
 * example lines are shaped exactly like an answer (M11 review, finding 4).
 */
const PROMPT_MARKERS: readonly RegExp[] = [
  /I will copy your answer into an app/i,
  /<<<VOICE GUIDE/,
  /How to answer — please follow this exactly/i,
  /\|\|\s*reads:\s*yes or no\s*\|\|/i,
];

export const PROMPT_PASTED =
  "That is the prompt, not Claude’s reply. Copy Claude’s answer from claude.ai and paste that instead — nothing was changed.";

function guard(kind: AssistKind, text: string): void {
  if (PROMPT_MARKERS.some((marker) => marker.test(text))) {
    throw new AssistError("wrong_shape", {
      message: PROMPT_PASTED,
      detail: `A pasted ${kind} reply was the prompt itself.`,
    });
  }
  if (text.length > MAX_REPLY_LENGTH) {
    throw new AssistError("rejected", {
      message: TOO_LONG,
      detail: `A pasted ${kind} reply was ${text.length} characters.`,
    });
  }
  if (stripInvisible(text).trim() === "") {
    throw new AssistError("empty", { message: NOTHING_PASTED });
  }
}

/**
 * The pasted reply, as an `AssistProvider`.
 *
 * `run(request)` reads `reply` for `request.kind` and assembles it exactly as
 * the real provider assembles a model's answer. Two adjustments, both about
 * the pick, and both there to stop the panel saying something untrue:
 *
 * - A reply with no PICK line has no pick. `assemble()` would mark the first
 *   proposal and say the pick "pointed at something that was dropped"; here
 *   nothing is marked and nothing is said.
 * - A PICK that points at nothing (a number past the list) is the same repair
 *   as an out-of-range index from the API, and is reported as one.
 *
 * `elapsedMs` is 0 and `servedByFallback` false: nothing was timed and no
 * fallback model is knowable from a paste.
 */
export function createPastedProvider(reply: string): AssistProvider {
  return {
    name: MANUAL_PROVIDER,
    async run(request: AssistRequest): Promise<AssistResult> {
      const context = {
        provider: MANUAL_PROVIDER,
        model: MANUAL_MODEL,
        elapsedMs: 0,
        servedByFallback: false,
      };

      if (request.kind === "thumbnail_critique") {
        return assemble(request, parseCritiqueReply(reply), context);
      }

      const { payload, picked } = parseSuggestionsReply(request.kind, reply);
      const result = assemble(request, payload, context);
      if (picked || result.kind === "thumbnail_critique") return result;
      return {
        ...result,
        recommended: null,
        recommendedReason: null,
        meta: { ...result.meta, recommendationAdjusted: false },
      };
    },
  };
}
