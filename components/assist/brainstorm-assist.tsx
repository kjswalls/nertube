"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { assist } from "@/app/actions/assist";

import { BrainstormPanel, type KindView, type PanelKind } from "./brainstorm-panel";
import { useAssistPanel, useAssistTarget } from "./packaging-assist";
import type { StoredAssistKind, StoredBrainstormView } from "./stored";

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
 * `components/preview/assist-pill.tsx` has sat on this page since M2,
 * deliberately inert, with a doc comment saying why: *where the button is* is a
 * decision about the packaging block rather than about the API, and a listener
 * for a button that cannot be pressed is the illusion of a feature. This is the
 * other half of that comment — same place, same row, now with an action behind
 * it.
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

  const [view, setView] = useState<Record<PanelKind, KindView>>(() => ({
    titles: { ...EMPTY, entry: initial.titles },
    hooks: { ...EMPTY, entry: initial.hooks },
  }));

  /**
   * The clock, read in the handler that opens the panel rather than while
   * rendering it. "Asked for two hours ago" is a subtraction, and a subtraction
   * done during render is a different answer every time React re-renders.
   */
  const [now, setNow] = useState(0);

  /**
   * Which request each kind is still interested in.
   *
   * A server action cannot be recalled — the model is already thinking and the
   * row will still be written — so "cancel" honestly means *stop waiting for
   * this one*, and an answer that lands afterwards is ignored rather than
   * dropped into a panel the person has moved on from. Closing does the same.
   */
  const request = useRef<Record<PanelKind, number>>({ titles: 0, hooks: 0 });

  const patch = useCallback((kind: PanelKind, next: Partial<KindView>) => {
    setView((previous) => ({ ...previous, [kind]: { ...previous[kind], ...next } }));
  }, []);

  const ask = useCallback(
    async (kind: PanelKind) => {
      const id = request.current[kind] + 1;
      request.current[kind] = id;
      patch(kind, { pending: true, failure: null, startedAt: Date.now(), notice: null });

      let answer: Awaited<ReturnType<typeof assist>>;
      try {
        answer = await assist({ videoId, kind });
      } catch {
        // The action itself never throws; this is the transport under it — the
        // browser offline, the deployment restarting mid-request.
        if (request.current[kind] !== id) return;
        patch(kind, {
          pending: false,
          failure: {
            code: "unreachable",
            message:
              "The request never reached the server. Nothing was changed — check the connection and ask again.",
            retryable: true,
            retryAfterSeconds: null,
          },
        });
        return;
      }

      if (request.current[kind] !== id) return;

      if (!answer.ok) {
        patch(kind, {
          pending: false,
          failure: {
            code: answer.code,
            message: answer.message,
            retryable: answer.retryable,
            retryAfterSeconds: answer.retryAfterSeconds,
          },
        });
        return;
      }

      patch(kind, {
        pending: false,
        entry: answer.entry,
        fresh: true,
        meta: answer.meta,
        persisted: answer.persisted,
        failure: null,
      });
    },
    [patch, videoId],
  );

  const cancel = useCallback(
    (kind: PanelKind) => {
      request.current[kind] += 1;
      patch(kind, {
        pending: false,
        notice:
          "Stopped waiting. If the answer did arrive it is kept — it will be here, as “from earlier”, next time you open this.",
      });
    },
    [patch],
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
      const current = view[kind];
      if (current.entry === null && !current.pending && current.failure === null) {
        void ask(kind);
      }
    },
    [ask, panel, view],
  );

  /*
    Tell the pills how to open this.

    The hooks pill is a sibling, not a child: it can aim the panel through the
    context but it cannot ask, because the conversation with the server lives
    here. Registering `open` is what makes "Draft a third" mean the same thing
    as "Generate 20" — open, and ask if there is nothing to show. A ref through
    the context, written in an effect and cleared on unmount, so no render
    depends on it.
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

  return (
    <div className="flex w-full flex-col gap-2">
      <div className="flex justify-end">
        <button
          type="button"
          data-testid="assist-pill"
          data-assist="Generate 20"
          aria-expanded={panel.open}
          title="Asks for ten to twenty title candidates in this channel's voice, each with a reason."
          onClick={() => (panel.open ? panel.hide() : open("titles"))}
          className="inline-flex items-center gap-1.5 rounded-button border border-border px-2 py-1 text-xs outline-none hover:bg-surface focus-visible:ring-2 focus-visible:ring-accent"
        >
          <span>{panel.open ? "Hide brainstorm" : "Generate 20"}</span>
          {view.titles.entry && !panel.open ? (
            <span
              data-testid="assist-pill-stored"
              className="font-mono text-[11px] uppercase tracking-wide text-muted"
            >
              saved
            </span>
          ) : null}
        </button>
      </div>

      {panel.open ? (
        <BrainstormPanel
          kind={panelKind(panel.kind)}
          nonce={panel.nonce}
          now={now}
          view={view[panelKind(panel.kind)]}
          otherHasAnswer={
            view[panelKind(panel.kind) === "titles" ? "hooks" : "titles"].entry !== null
          }
          onAsk={() => void ask(panelKind(panel.kind))}
          onCancel={() => cancel(panelKind(panel.kind))}
          onKind={(kind) => {
            panel.setKind(kind);
            const current = view[kind];
            if (current.entry === null && !current.pending && current.failure === null) {
              void ask(kind);
            }
          }}
          onNotice={(notice) => patch(panelKind(panel.kind), { notice })}
          onClose={() => {
            const kind = panelKind(panel.kind);
            request.current[kind] += 1;
            // Closing ends the sitting: what it showed is kept, and the next
            // open says "from earlier" rather than "just now" about an answer
            // that may be an hour old by then.
            patch(kind, { fresh: false });
            panel.hide();
          }}
        />
      ) : null}
    </div>
  );
}

const EMPTY: KindView = {
  entry: null,
  fresh: false,
  meta: null,
  persisted: true,
  pending: false,
  startedAt: null,
  failure: null,
  notice: null,
};

/**
 * The same panel, asked for from the hooks list.
 *
 * It opens the panel that already exists rather than a second one: one answer,
 * one `brainstorm_last`, one place to accept a hook. The component that owns
 * the state is the one beside the candidate list; this only aims it.
 */
export function BrainstormHookPill() {
  const panel = useAssistPanel();
  if (!panel) return null;

  return (
    <button
      type="button"
      data-testid="assist-pill"
      data-assist="Draft a third"
      title="Opens the brainstorm on the spoken hooks it proposes."
      onClick={() => panel.request("hooks")}
      className="inline-flex items-center gap-1.5 rounded-button border border-border px-2 py-1 text-xs outline-none hover:bg-surface focus-visible:ring-2 focus-visible:ring-accent"
    >
      Draft a third
    </button>
  );
}
