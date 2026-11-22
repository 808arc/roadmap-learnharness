/** Learning Path — compact inline cards for native learning_path_* tool results.
 *
 * Rendering only: a renderer never creates pending input, runs a tool or changes
 * learner data. The card stays to one line plus an optional detail, so a child
 * session's transcript is not dominated by long briefs. Missing/errored output
 * falls back to readable text rather than model HTML.
 */
import { t } from "../i18n.ts";
import type { MessageKey } from "../i18n.ts";
const PROGRESS_KEYS = ["unstarted", "in_progress", "consolidated", "skipped"] as const;
import type { PluginFrontendContext, PluginToolRenderer, PluginToolRenderProps } from "learnharness-plugin-api";
import { LEARNING_PATH_TOOL_NAMES } from "../tool-names.ts";
import type { ErrorCategory, PivotProposalType } from "../domain.ts";

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function summary(tool: PluginToolRenderProps): { headline: string; detail?: string } {
  const output = record(tool.output);
  const nodeTitle = text(output.nodeTitle) ?? t("tr.thisNode");
  switch (tool.toolName) {
    case "roadmap_get_brief": {
      const watchpoints = Array.isArray(output.watchpoints) ? output.watchpoints.length : 0;
      const artifact = record(output.artifact);
      const artifactLabel = text(artifact.label);
      return {
        headline: t("tr.brief", { node: nodeTitle }),
        detail: `${t("tr.watchpoints", { n: watchpoints })}${artifactLabel ? ` · ${artifactLabel}` : ""}`,
      };
    }
    case "roadmap_update_progress": {
      const progression = text(output.progression) ?? "updated";
      const artifactNote = text(output.artifactNote);
      return {
        headline: t("tr.progress", { node: nodeTitle, state: (PROGRESS_KEYS as readonly string[]).includes(progression) ? t(`status.${progression}` as MessageKey) : progression.replace("_", " ") }),
        ...(artifactNote ? { detail: t("tr.artifactNote", { text: artifactNote }) } : {}),
      };
    }
    case "roadmap_log_error": {
      const category = text(output.category) as ErrorCategory | null;
      const label = category ? t(`err.${category}` as MessageKey) : t("legend.error");
      const message = text(output.summary);
      return {
        headline: t("tr.logged", { label, node: nodeTitle }),
        ...(message ? { detail: message } : {}),
      };
    }
    case "roadmap_suggest_pivot": {
      const proposal = text(output.proposalType) as PivotProposalType | null;
      const label = proposal ? t(`type.${proposal}` as MessageKey) : t("pivot.title");
      const title = text(output.title) ?? "detour";
      return {
        headline: t("tr.pivot", { label, title }),
        detail: t("tr.pivotDetail"),
      };
    }
    default:
      return { headline: tool.toolName };
  }
}

function fallbackText(tool: PluginToolRenderProps): string | null {
  if (tool.state === "output-error") return text(tool.errorText) ?? t("tr.failed");
  if (tool.state === "input-streaming") return t("tr.preparing");
  if (tool.state === "input-available") return t("tr.running");
  const content = tool.result?.content;
  if (Array.isArray(content)) {
    const parts = content
      .map((part) => (record(part).type === "text" ? text(record(part).text) : null))
      .filter((part): part is string => part !== null);
    if (parts.length > 0) return parts.join(" ");
  }
  return null;
}

function rendererFor(toolName: string): PluginToolRenderer {
  return {
    toolName,
    mount(container, tool) {
      const document = container.ownerDocument;
      const card = document.createElement("div");
      card.className = "lp-tool-card";
      card.dataset.tool = toolName;
      card.dataset.state = tool.state;

      const line = document.createElement("div");
      line.className = "lp-tool-line";
      const dot = document.createElement("span");
      dot.className = "lp-tool-dot";
      dot.setAttribute("aria-hidden", "true");
      const headline = document.createElement("strong");
      const detail = document.createElement("span");
      detail.className = "lp-tool-detail";

      if (tool.state === "output-available") {
        const view = summary(tool);
        headline.textContent = view.headline;
        if (view.detail) detail.textContent = view.detail;
      } else {
        headline.textContent = {
          "roadmap_get_brief": t("tr.getBrief"),
          "roadmap_update_progress": t("tr.updateProgress"),
          "roadmap_log_error": t("tr.logError"),
          "roadmap_suggest_pivot": t("tr.suggestPivot"),
        }[toolName] ?? toolName;
        const pending = fallbackText(tool);
        if (pending) detail.textContent = pending;
      }

      if (tool.state === "output-error") {
        card.dataset.error = "true";
        const error = document.createElement("span");
        error.className = "lp-tool-error";
        error.textContent = fallbackText(tool) ?? t("tr.failed");
        detail.textContent = "";
        line.append(dot, headline);
        card.append(line, error);
      } else {
        line.append(dot, headline);
        if (detail.textContent) line.append(detail);
        card.append(line);
      }

      container.append(card);
      return () => card.remove();
    },
  };
}

/** Register all four renderers; the returned disposer unregisters and unmounts. */
export function registerLearningPathToolRenderers(ctx: PluginFrontendContext): () => void {
  const disposers = LEARNING_PATH_TOOL_NAMES.map((toolName) =>
    ctx.registerToolRenderer(rendererFor(toolName)),
  );
  return () => {
    for (const dispose of disposers.reverse()) dispose();
  };
}

/** Exported for tests: render one tool without a full activation. */
export function mountLearningPathToolCard(
  ctx: PluginFrontendContext,
  container: HTMLElement,
  tool: PluginToolRenderProps,
): ReturnType<PluginToolRenderer["mount"]> {
  return rendererFor(tool.toolName).mount(container, tool);
}
