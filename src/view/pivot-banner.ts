/** Advisory pivot card for the node panel.
 *
 * A pending `PivotSuggestion` is only a proposal: Accept inserts the proposed
 * repair node next to the current node, Discuss hands the rationale to the
 * Architect, Dismiss closes it. Nothing here mutates the path.
 */
import type { PluginFrontendContext } from "learnharness-plugin-api";
import type { LearningPath, PathNode, PivotSuggestion } from "../domain.ts";
import { t } from "../i18n.ts";
import type { MessageKey } from "../i18n.ts";
import { button, el } from "./dom.ts";
import { ICONS, setIcon } from "./icons.ts";

export type PivotDecision = "accept" | "dismiss";

export interface PivotBannerOptions {
  decide(pivotId: string, decision: PivotDecision): void | Promise<void>;
  discuss(pivot: PivotSuggestion, node: PathNode): void | Promise<void>;
}

export interface PivotBanner {
  render(path: LearningPath | null, node: PathNode | null): void;
  dispose(): void;
}

export function createPivotBanner(
  _ctx: PluginFrontendContext,
  container: HTMLElement,
  signal: AbortSignal,
  options: PivotBannerOptions,
): PivotBanner {
  const document = container.ownerDocument;
  const root = el(document, "div", "rm-pivots");
  root.setAttribute("aria-live", "polite");
  container.append(root);
  let controller = new AbortController();
  let disposed = false;

  const clear = (): void => {
    controller.abort();
    controller = new AbortController();
    root.replaceChildren();
  };

  return {
    render(path, node) {
      if (disposed || signal.aborted) return;
      clear();
      if (!path || !node) return;
      const scoped = AbortSignal.any([signal, controller.signal]);
      for (const pivot of node.pivotSuggestions.filter((entry) => entry.status === "pending")) {
        const card = el(document, "aside", "rm-pivot");
        card.dataset.pivotId = pivot.id;
        card.dataset.proposalType = pivot.proposalType;
        const kicker = el(document, "div", "rm-pivot-kicker");
        const icon = el(document, "span", "rm-btn-icon");
        setIcon(icon, ICONS.sparkle);
        kicker.append(icon, el(document, "span", undefined, t("pivot.kicker", { type: t(`type.${pivot.proposalType}` as MessageKey) })));
        card.append(kicker, el(document, "div", "rm-pivot-title", pivot.title));
        card.append(el(document, "p", "rm-pivot-text", t("pivot.reason", { text: pivot.rationale })));
        card.append(el(document, "p", "rm-muted rm-small", t("pivot.note")));
        const actions = el(document, "div", "rm-err-actions");
        actions.append(
          button(document, t("pivot.accept"), () => void options.decide(pivot.id, "accept"), scoped, { variant: "primary" }),
          button(document, t("pivot.discuss"), () => void options.discuss(pivot, node), scoped, { variant: "outline" }),
          button(document, t("pivot.dismiss"), () => void options.decide(pivot.id, "dismiss"), scoped, { variant: "ghost" }),
        );
        card.append(actions);
        root.append(card);
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clear();
      root.remove();
    },
  };
}

/** The prompt sent when the learner chooses "Discuss". */
export function pivotDiscussionPrompt(pivot: PivotSuggestion, node: PathNode): string {
  return [
    `I want to discuss a ${pivot.proposalType} pivot on the node "${node.title}".`,
    `The observed problem: ${pivot.rationale}`,
    `Proposed repair: ${pivot.title}.`,
    "Explain whether this repair fits the path's source spine and dependencies, and propose the smallest change. Do not rewrite the path without my explicit agreement.",
  ].join("\n");
}
