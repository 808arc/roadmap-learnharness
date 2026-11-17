/** Chat card for `roadmap_propose`: "Build a roadmap?" with the dossier in brief. */
import type { PluginFrontendContext, PluginToolRenderProps } from "learnharness-plugin-api";
import { locale, t } from "../i18n.ts";

interface Summary {
  readonly noteId: string;
  readonly goal: string;
  readonly background: string;
  readonly gaps: number;
  readonly misconceptions: number;
  readonly strengths: number;
}

const DECISION_KEY = "roadmap.proposal.";

function readSummary(tool: PluginToolRenderProps): Summary | null {
  const details = (tool.result?.details ?? tool.output) as Partial<Summary> | undefined;
  return details && typeof details.noteId === "string" && typeof details.goal === "string" ? (details as Summary) : null;
}

function decision(noteId: string): string | null {
  try {
    return globalThis.localStorage?.getItem(DECISION_KEY + noteId) ?? null;
  } catch {
    return null;
  }
}

function remember(noteId: string, value: "built" | "declined"): void {
  try {
    globalThis.localStorage?.setItem(DECISION_KEY + noteId, value);
  } catch {
    // A per-window convenience; the backend keeps what matters.
  }
}

const chatIdFrom = (pathname: string): string | null => /\/chat\/([A-Za-z0-9_-]+)/.exec(pathname)?.[1] ?? null;

export function mountProposalCard(ctx: PluginFrontendContext, container: HTMLElement, tool: PluginToolRenderProps): () => void {
  const document = container.ownerDocument;
  const card = document.createElement("section");
  card.className = "rm-proposal";
  const make = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] => {
    const node = document.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  container.append(card);

  const summary = tool.state === "output-available" && !tool.result?.isError ? readSummary(tool) : null;
  if (!summary) {
    card.dataset.state = tool.state === "output-error" || tool.result?.isError ? "error" : "pending";
    card.append(make("p", "rm-proposal-muted", tool.state === "output-error" || tool.result?.isError ? t("pc.failed") : t("pc.preparing")));
    return () => card.remove();
  }

  card.append(make("h3", "rm-proposal-title", t("pc.title")));
  const facts = make("dl", "rm-proposal-facts");
  const fact = (label: string, value: string): void => {
    facts.append(make("dt", "", label), make("dd", "", value));
  };
  fact(t("pc.goal"), summary.goal);
  fact(t("pc.level"), summary.background);
  card.append(facts);
  card.append(make("p", "rm-proposal-counts", t("pc.counts", { gaps: summary.gaps, misconceptions: summary.misconceptions, strengths: summary.strengths })));

  const actions = make("div", "rm-proposal-actions");
  const build = make("button", "rm-proposal-build", t("pc.build"));
  build.type = "button";
  const later = make("button", "rm-proposal-later", t("pc.later"));
  later.type = "button";
  const status = make("p", "rm-proposal-muted");
  actions.append(build, later);
  card.append(actions, status);

  const settle = (value: string | null): void => {
    actions.hidden = value !== null;
    status.textContent = value === "built" ? t("pc.built") : value === "declined" ? t("pc.declined") : "";
    status.hidden = value === null;
  };
  settle(decision(summary.noteId));

  build.addEventListener("click", async () => {
    build.disabled = true;
    try {
      await ctx.call("diagnostic.requestBuild", { noteId: summary.noteId, locale: locale() });
      remember(summary.noteId, "built");
      settle("built");
      ctx.app.openView("paths");
    } catch (error) {
      build.disabled = false;
      status.hidden = false;
      status.textContent = error instanceof Error ? error.message : String(error);
    }
  }, { signal: tool.signal });
  later.addEventListener("click", async () => {
    const chatId = chatIdFrom(ctx.app.pathname());
    if (chatId) await ctx.call("diagnostic.decline", { chatId }).catch(() => undefined);
    remember(summary.noteId, "declined");
    settle("declined");
  }, { signal: tool.signal });

  return () => card.remove();
}

export function registerProposalCard(ctx: PluginFrontendContext): () => void {
  return ctx.registerToolRenderer({
    toolName: "roadmap_propose",
    backgroundPresentation: "plain",
    mount: (container, tool) => mountProposalCard(ctx, container, tool),
  });
}
