"use client";

import { useCallback, useEffect, useState } from "react";

import { assist } from "@/app/actions/assist";

import { AssistPillButton } from "./chrome";
import { BrainstormPanel, type PanelKind } from "./brainstorm-panel";
import { useAssistPanel, useAssistTarget } from "./packaging-assist";
import { useAssistRun, type AssistRun } from "./run";
import type {
  StoredAssistEntryValue,
  StoredAssistKind,
  StoredBrainstormView,
} from "./stored";

/**
 * A kind this panel can show. `concepts` belongs to the thumbnail concept
 * field and its own control; asked for one of those, this shows the titles it
 * does have rather than an empty panel with no buttons.
 */
const panelKind = (kind: StoredAssistKind): PanelKind =>
  kind === "hooks" ? "hooks" : "titles";

/**
 * The assist control on the packaging block, made real — and the thing that
 * actually holds the conversation with the server.
 *
 * `components/preview/assist-pill.tsx` sat on this page from M2, deliberately
 * inert, with a doc comment saying why: *where the button is* is a decision
 * about the packaging block rather than about the API, and a listener for a
 * button that cannot be pressed is the illusion of a feature. This is the other
 * half of that comment — same place, same row, now with an action behind it.
 * That file is gone; `AssistPillButton` below is the one pill every assist in
 * the app renders, and the reasoning moved into it.
 *
 * ## Why the state is here and not in the panel
 *
 * Two reasons, and they are the same reason twice:
 *
 * - **Closing the panel unmounts it.** That is what keeps the block quiet when
 *   nobody is brainstorming. If the answers lived in the panel, closing and
 *   reopening would ask the model again — which is exactly what
 *   `videos.brainstorm_last` exists to prevent.
 * - **Asking belongs in an event handler.** The ask happens because somebody
 *   pressed a button, so it is done in the handler for that button rather than
 *   in an effect that watches for the panel appearing. A component that fetches
 *   in an effect on mount fetches twice in development and re-fetches on every
 *   remount; a model call is not something to do by accident.
 *
 * The panel below is therefore presentational: it renders what it is given and
 * calls back.
 *
 * ## Why there are two runs rather than one hand-written machine
 *
 * This component used to keep its own `Record<PanelKind, KindView>`, its own
 * request-id ref, its own transport-failure sentence and its own words for
 * cancelling — a second copy of `components/assist/run.ts`, which the concept
 * and critique controls already used. Two copies of a state machine that must
 * behave identically agree only for as long as somebody keeps them agreeing.
 * So the machine is `useAssistRun`, twice: one conversation per question,
 * because asking for hooks must not throw away twenty titles nobody has
 * accepted yet, and the two are genuinely separate calls behind the interface.
 */
export function BrainstormAssist({
  videoId,
  initial,
}: {
  videoId: string;
  /** `videos.brainstorm_last`, read on the server. Never a second call. */
  initial: StoredBrainstormView;
}) {
  const panel = useAssistPanel();
  const target = useAssistTarget();

  /*
    One run per question. `useAssistRun` seeds itself from the column, so an
    answer written yesterday is on screen the moment the panel opens and
    reopening costs nothing — which is the whole job of `brainstorm_last`.
  */
  const titles = useAssistRun<StoredAssistEntryValue>(initial.titles);
  const hooks = useAssistRun<StoredAssistEntryValue>(initial.hooks);
  const runs: Record<PanelKind, AssistRun<StoredAssistEntryValue>> = {
    titles,
    hooks,
  };

  /**
   * The clock, read in the handler that opens the panel rather than while
   * rendering it. "Asked for two hours ago" is a subtraction, and a subtraction
   * done during render is a different answer every time React re-renders.
   */
  const [now, setNow] = useState(0);

  /*
    The two `ask` functions are stable (`useCallback` inside the hook), so the
    handler below is too — which matters because it is what the sibling hook
    pill registers through the context.
  */
  const askTitles = titles.ask;
  const askHooks = hooks.ask;

  const ask = useCallback(
    (kind: PanelKind) => {
      /*
        No mapping. `assist()` returns exactly the shape `useAssistRun`
        consumes, failure branch included — one result contract for every
        assist in the app, so a new kind cannot invent a fifth way to say
        "it failed".
      */
      const attempt = () => assist({ videoId, kind });
      void (kind === "hooks" ? askHooks(attempt) : askTitles(attempt));
    },
    [askHooks, askTitles, videoId],
  );

  const titlesState = titles.state;
  const hooksState = hooks.state;

  /**
   * Whether asking now would cost a call for nothing: there is an answer on
   * screen, or something is already in flight, or the last attempt failed and
   * the person is looking at the sentence saying so. Read from the run state
   * rather than remembered separately, so it cannot drift from it.
   */
  const askedAlready = useCallback(
    (kind: PanelKind) => {
      const { data, pending, failure, outstanding } =
        kind === "hooks" ? hooksState : titlesState;
      /*
        `outstanding` is the one the review found missing, and it was the
        expensive one. Cancel and closing the panel both left `data` null while
        the request carried on, so reopening took this branch and bought a
        second answer to a question already answered — the opposite of what the
        cancel notice promises and of what `videos.brainstorm_last` is for.
        A request still on its way is a reason not to ask, not a reason to.
      */
      return data !== null || pending || failure !== null || outstanding;
    },
    [hooksState, titlesState],
  );

  /**
   * Open the panel on a kind, and ask if there is nothing to show.
   *
   * The pill says "Generate 20", so pressing it against an empty column *is*
   * the ask. Pressing it when the column already holds an answer must not cost
   * a call, and must not cost one again when the panel is closed and reopened.
   */
  const open = useCallback(
    (requested: StoredAssistKind) => {
      const kind = panelKind(requested);
      setNow(Date.now());
      panel?.show(kind);
      if (!askedAlready(kind)) ask(kind);
    },
    [ask, askedAlready, panel],
  );

  /*
    Tell the pills how to open this.

    The hooks pill is a sibling, not a child: it can aim the panel through the
    context but it cannot ask, because the conversation with the server lives
    here. Registering `open` is what makes "Draft a third" mean the same thing
    as "Generate 20" — open, and ask if there is nothing to show. A ref through
    the context, written in an effect and cleared on unmount, so no render
    depends on it. Exactly one component may register; a second would silently
    win, which is why only this one does.
  */
  useEffect(() => panel?.register(open), [open, panel]);

  // Outside the packaging block there is nothing to write into, so the control
  // says so rather than being a button that does nothing.
  if (!panel || !target) {
    return (
      <span className="text-xs text-muted">
        Brainstorm is only available beside the packaging fields.
      </span>
    );
  }

  const current = panelKind(panel.kind);
  const run = runs[current];

  return (
    <div className="flex w-full flex-col gap-2">
      <div className="flex justify-end">
        <AssistPillButton
          verb="Generate 20"
          label={panel.open ? "Hide brainstorm" : "Generate 20"}
          title="Asks for ten to twenty title candidates in this channel's voice, each with a reason."
          expanded={panel.open}
          badge={titlesState.data && !panel.open ? "saved" : undefined}
          onClick={() => (panel.open ? panel.hide() : open("titles"))}
        />
      </div>

      {panel.open ? (
        <BrainstormPanel
          kind={current}
          nonce={panel.nonce}
          now={now}
          view={run.state}
          otherHasAnswer={
            runs[current === "titles" ? "hooks" : "titles"].state.data !== null
          }
          onAsk={() => ask(current)}
          onCancel={() => run.cancel()}
          onKind={(kind) => {
            panel.setKind(kind);
            if (!askedAlready(kind)) ask(kind);
          }}
          onNotice={(notice) => run.note(notice)}
          onClose={() => {
            // Closing ends the sitting: whatever was in flight is no longer
            // wanted, what it showed is kept, and the next open says "from
            // earlier" rather than "just now" about an answer that may be an
            // hour old by then. `settle()` is that, without a notice — Cancel
            // is the gesture that earns one.
            run.settle();
            panel.hide();
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * What the hooks pill says, given how many hooks are already written.
 *
 * "Draft a third" is right at two and wrong everywhere else, and a freshly
 * captured idea — the commonest state this pill is seen in, and the one
 * BRIEF.md's packaging checklist addresses with *"Hook drafted in 3 versions,
 * strongest picked"* — has none, so the control was offering to draft a third
 * of nothing. The column stops at three (`MAX_HOOKS`), and at three the ask is
 * still worth offering: another to compare against, not a fourth to keep.
 */
export function hookPillLabel(written: number): string {
  if (written <= 0) return "Draft hooks";
  if (written === 1) return "Draft a second";
  if (written === 2) return "Draft a third";
  return "Another hook to compare";
}

/**
 * The same panel, asked for from the hooks list.
 *
 * It opens the panel that already exists rather than a second one: one answer,
 * one `brainstorm_last`, one place to accept a hook. The component that owns
 * the state is the one beside the candidate list; this only aims it.
 *
 * `verb` stays "Draft a third" whatever the label says, because the verb is
 * the control's *identity* — it is what `data-assist` carries and what every
 * spec locates this pill by — and a control whose identity changed as the
 * person worked would be a different control depending on how far along they
 * were. `label` is the seam the integration pass added for exactly this.
 */
export function BrainstormHookPill() {
  const panel = useAssistPanel();
  const target = useAssistTarget();
  if (!panel) return null;

  return (
    <AssistPillButton
      verb="Draft a third"
      label={hookPillLabel(target?.hooks.length ?? 0)}
      title="Opens the brainstorm on the spoken hooks it proposes."
      onClick={() => panel.request("hooks")}
    />
  );
}
