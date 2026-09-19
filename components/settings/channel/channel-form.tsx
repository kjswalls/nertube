"use client";

import Link from "next/link";
import { useId, type KeyboardEvent } from "react";

import {
  updateChannelSettings,
  type ChannelSettings,
  type UpdateChannelSettingsInput,
} from "@/app/actions/channels";
import { SaveStatus, useAutosave, type SaveOutcome } from "@/components/autosave";
import {
  HOOK_PLACEHOLDER,
  MAX_SCRIPT_TEMPLATE_LENGTH,
  MAX_STALE_DAYS,
  MAX_VOICE_GUIDE_LENGTH,
  MAX_WIP_THRESHOLD,
  SETTING_NOTES,
  hasHookPlaceholder,
  numberText,
  parseExpectedCtr,
  parseStaleDays,
  parseWipThreshold,
} from "@/lib/channel-settings";

/**
 * The channel's own settings: two texts and three numbers, each saved on
 * blur through `useAutosave`, each with the line of prose that says what it
 * changes elsewhere.
 *
 * ## Why every field is its own save
 *
 * There is no Save button. The five columns are independent — a threshold
 * has nothing to do with a voice guide — and PLAN.md's rule for the video
 * page (*autosave on blur*) is the right rule here too: a person adjusting
 * one number should not have to find a button at the bottom of a page of
 * prose. Each field is one `useAutosave`, so each has the one status line,
 * the one Retry and the one guarantee that a refusal never reverts what is
 * on screen.
 *
 * ## The two texts keep their shape
 *
 * The voice guide and the script template are paragraphs — the first is a
 * document, the second is a skeleton with headings and blank lines — and the
 * only normalisation on the way in is line endings and trailing whitespace.
 * What comes back is what was typed, newlines included, and the spec proves
 * it round-trips.
 */
export function ChannelForm({
  channelId,
  channelSlug,
  initial,
}: {
  channelId: string;
  channelSlug: string;
  initial: ChannelSettings;
}) {
  return (
    <div className="flex flex-col gap-8">
      <VoiceGuideField channelId={channelId} initial={initial.voiceGuide ?? ""} />
      <ScriptTemplateField channelId={channelId} initial={initial.scriptTemplate} />
      <Thresholds channelId={channelId} channelSlug={channelSlug} initial={initial} />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Shared                                                                      */
/* -------------------------------------------------------------------------- */

/** One field's save: a patch of one column, answered with what was stored. */
function saver<Key extends keyof ChannelSettings>(
  channelId: string,
  key: Key,
  parse: (raw: string) => { ok: true; value: ChannelSettings[Key] } | { ok: false; error: string },
  print: (stored: ChannelSettings[Key]) => string,
): (raw: string) => Promise<SaveOutcome<string>> {
  return async (raw) => {
    const parsed = parse(raw);
    if (!parsed.ok) return { ok: false, error: parsed.error };
    const patch = { channelId, [key]: parsed.value } as UpdateChannelSettingsInput;
    const result = await updateChannelSettings(patch);
    if (!result.ok) return { ok: false, error: result.error };
    return { ok: true, value: print(result.settings[key]) };
  };
}

const TEXTAREA_CLASS =
  "w-full rounded-input border border-border bg-background px-3 py-2 text-base leading-relaxed outline-none focus-visible:ring-2 focus-visible:ring-accent resize-y";

const NUMBER_CLASS =
  "w-24 rounded-input border border-border bg-background px-3 py-2 text-right font-mono text-base outline-none focus-visible:ring-2 focus-visible:ring-accent";

function commitOnEnter(commit: () => void) {
  return (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      commit();
    }
  };
}

function FieldHeading({
  htmlFor,
  title,
  note,
  noteId,
}: {
  htmlFor: string;
  title: string;
  note: string;
  noteId: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={htmlFor} className="font-display text-[17px] leading-tight font-semibold tracking-tight">
        {title}
      </label>
      <p id={noteId} className="max-w-2xl text-[12px] leading-5 text-muted">
        {note}
      </p>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Voice guide                                                                 */
/* -------------------------------------------------------------------------- */

function VoiceGuideField({ channelId, initial }: { channelId: string; initial: string }) {
  const id = useId();
  const noteId = useId();
  const field = useAutosave({
    initial,
    save: saver(
      channelId,
      "voiceGuide",
      (raw) => ({ ok: true, value: raw === "" ? null : raw }),
      (stored) => stored ?? "",
    ),
  });

  return (
    <section data-testid="voice-guide-section" className="flex flex-col gap-2">
      <FieldHeading htmlFor={id} title="Voice guide" note={SETTING_NOTES.voiceGuide} noteId={noteId} />
      <textarea
        id={id}
        data-testid="voice-guide"
        rows={12}
        value={field.value}
        maxLength={MAX_VOICE_GUIDE_LENGTH}
        aria-describedby={noteId}
        onChange={(event) => field.setValue(event.target.value)}
        onBlur={field.commit}
        placeholder={
          "How this channel talks. Who it is for, what it never says, the words it reaches for.\n\nA page is plenty; a paragraph is a start."
        }
        // The user's own prose, in the reading face.
        className={`${TEXTAREA_CLASS} min-h-48 font-display`}
      />
      <SaveStatus
        state={field.state}
        testId="voice-guide-status"
        idle={field.value === "" ? "Empty. Without one the brainstorm will have only the channel's past titles to go on." : "Saved on blur. Kept exactly as written, paragraphs and all."}
      />
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Script template                                                             */
/* -------------------------------------------------------------------------- */

function ScriptTemplateField({ channelId, initial }: { channelId: string; initial: string }) {
  const id = useId();
  const noteId = useId();
  const field = useAutosave({
    initial,
    save: saver(
      channelId,
      "scriptTemplate",
      (raw) => ({ ok: true, value: raw }),
      (stored) => stored,
    ),
  });

  const hookMissing = !hasHookPlaceholder(field.value);

  return (
    <section data-testid="script-template-section" className="flex flex-col gap-2">
      <FieldHeading
        htmlFor={id}
        title="Script template"
        note={SETTING_NOTES.scriptTemplate}
        noteId={noteId}
      />
      <textarea
        id={id}
        data-testid="script-template"
        rows={16}
        value={field.value}
        maxLength={MAX_SCRIPT_TEMPLATE_LENGTH}
        aria-describedby={noteId}
        spellCheck={false}
        onChange={(event) => field.setValue(event.target.value)}
        onBlur={field.commit}
        // Markdown source, being worked on: the measured face, like the notes box.
        className={`${TEXTAREA_CLASS} min-h-64 font-mono text-sm`}
      />
      {hookMissing ? (
        <p
          role="status"
          data-testid="script-template-no-hook"
          className="text-[12px] leading-5 text-attention"
        >
          There is no <code className="font-mono">{HOOK_PLACEHOLDER}</code> in this template, so a
          video&rsquo;s chosen hook will not be written into its script on the way into Scripting.
          That is allowed &mdash; it is your shape &mdash; but it is probably not what you meant.
        </p>
      ) : null}
      <SaveStatus
        state={field.state}
        testId="script-template-status"
        idle="Saved on blur. Plain text; markdown is kept as written, never rendered."
      />
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Thresholds                                                                  */
/* -------------------------------------------------------------------------- */

function Thresholds({
  channelId,
  channelSlug,
  initial,
}: {
  channelId: string;
  channelSlug: string;
  initial: ChannelSettings;
}) {
  const wip = useAutosave({
    initial: numberText(initial.wipThreshold),
    save: saver(channelId, "wipThreshold", parseWipThreshold, numberText),
  });
  const stale = useAutosave({
    initial: numberText(initial.staleDays),
    save: saver(channelId, "staleDays", parseStaleDays, numberText),
  });
  const ctr = useAutosave({
    initial: numberText(initial.expectedCtr),
    save: saver(channelId, "expectedCtr", parseExpectedCtr, numberText),
  });

  const wipId = useId();
  const staleId = useId();
  const ctrId = useId();
  const wipNote = useId();
  const staleNote = useId();
  const ctrNote = useId();

  const boardLink = (
    <Link
      href={`/c/${channelSlug}/board`}
      className="underline decoration-border underline-offset-2 hover:decoration-current"
    >
      board
    </Link>
  );

  return (
    <section data-testid="thresholds-section" className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h2 className="font-display text-[17px] leading-tight font-semibold tracking-tight">
          Thresholds
        </h2>
        <p className="max-w-2xl text-[12px] leading-5 text-muted">
          Three numbers the {boardLink}, /now and the video page read. Each one says
          below it what it changes.
        </p>
      </div>

      <NumberField
        id={wipId}
        noteId={wipNote}
        testId="wip-threshold"
        label="WIP threshold"
        unit="videos in a column"
        note={SETTING_NOTES.wipThreshold}
        min={1}
        max={MAX_WIP_THRESHOLD}
        step={1}
        field={wip}
      />

      <NumberField
        id={staleId}
        noteId={staleNote}
        testId="stale-days"
        label="Stale after"
        unit="days in one stage"
        note={SETTING_NOTES.staleDays}
        min={1}
        max={MAX_STALE_DAYS}
        step={1}
        field={stale}
      />

      <NumberField
        id={ctrId}
        noteId={ctrNote}
        testId="expected-ctr"
        label="Expected CTR"
        unit="% in the first 24 hours"
        note={SETTING_NOTES.expectedCtr}
        min={0.01}
        max={100}
        step={0.01}
        placeholder="median"
        field={ctr}
      />
    </section>
  );
}

function NumberField({
  id,
  noteId,
  testId,
  label,
  unit,
  note,
  min,
  max,
  step,
  placeholder,
  field,
}: {
  id: string;
  noteId: string;
  testId: string;
  label: string;
  unit: string;
  note: string;
  min: number;
  max: number;
  step: number;
  placeholder?: string;
  field: ReturnType<typeof useAutosave>;
}) {
  return (
    <div data-testid={`${testId}-field`} className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-[13px] font-medium">
        {label}
      </label>
      <div className="flex items-center gap-2">
        <input
          id={id}
          data-testid={testId}
          type="number"
          inputMode="decimal"
          min={min}
          max={max}
          step={step}
          value={field.value}
          placeholder={placeholder}
          aria-describedby={noteId}
          aria-invalid={field.state.kind === "error" ? true : undefined}
          onChange={(event) => field.setValue(event.target.value)}
          onBlur={field.commit}
          onKeyDown={commitOnEnter(field.commit)}
          className={NUMBER_CLASS}
        />
        <span className="text-[12px] text-muted">{unit}</span>
      </div>
      <p id={noteId} className="max-w-2xl text-[12px] leading-5 text-muted">
        {note}
      </p>
      <SaveStatus state={field.state} testId={`${testId}-status`} />
    </div>
  );
}
