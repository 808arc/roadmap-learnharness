/** Error ledger for the node panel ("Errors" tab).
 *
 * Errors are grouped by cognitive root cause, never by grade. Each entry can be
 * resolved/reopened and carry a learner note. Open errors inherited from
 * interleaved and upstream nodes are listed separately, because those gaps
 * travel into this node's sessions.
 *
 * Controlled: `render` receives authoritative state after each refetch, and every
 * write is reported to the caller, which forwards it to the backend.
 */
import type { PluginFrontendContext } from "learnharness-plugin-api";
import { ERROR_CATEGORIES } from "../domain.ts";
import type { ErrorCategory, ErrorEntry, LearningPath, PathNode } from "../domain.ts";
import { collectErrorWatchpoints } from "../framework.ts";
import type { ErrorWatchpoint } from "../framework.ts";
import { t } from "../i18n.ts";
import type { MessageKey } from "../i18n.ts";
import { button, el, shortDate } from "./dom.ts";
import { ICONS, setIcon } from "./icons.ts";

export interface ErrorLedgerChange {
  readonly resolved?: boolean;
  /** `null` clears the note. */
  readonly notes?: string | null;
}

export interface ErrorLedgerOptions {
  update(errorId: string, change: ErrorLedgerChange): void | Promise<void>;
  selectNode?(nodeId: string): void;
}

export interface ErrorLedger {
  render(path: LearningPath | null, node: PathNode | null): void;
  dispose(): void;
}

export function categoryLabel(category: ErrorCategory): string {
  return t(`err.${category}` as MessageKey);
}

function entriesByCategory(node: PathNode): readonly (readonly [ErrorCategory, readonly ErrorEntry[]])[] {
  return ERROR_CATEGORIES.flatMap((category) => {
    const entries = node.errors.filter((entry) => entry.category === category);
    return entries.length === 0 ? [] : [[category, entries] as const];
  });
}

export function createErrorLedger(
  _ctx: PluginFrontendContext,
  container: HTMLElement,
  signal: AbortSignal,
  options: ErrorLedgerOptions,
): ErrorLedger {
  const document = container.ownerDocument;
  const root = el(document, "div", "rm-ledger");
  root.setAttribute("aria-label", t("tab.errors"));
  container.append(root);
  let controller = new AbortController();
  let disposed = false;
  const localeTag = (): string => "en-US";

  const clear = (): void => {
    controller.abort();
    controller = new AbortController();
    root.replaceChildren();
  };
  const scoped = (): AbortSignal => AbortSignal.any([signal, controller.signal]);

  const renderEntry = (parent: HTMLElement, entry: ErrorEntry): void => {
    const item = el(document, "article", `rm-err ${entry.resolved ? "rm-err-resolved" : "rm-err-open"}`);
    item.dataset.errorId = entry.id;
    const head = el(document, "div", "rm-err-head");
    const icon = el(document, "span", "rm-err-icon");
    setIcon(icon, entry.resolved ? ICONS.check : ICONS.warn);
    head.append(icon, el(document, "span", "rm-err-summary", entry.summary));
    item.append(head);
    item.append(
      el(
        document,
        "div",
        "rm-err-meta",
        entry.resolved
          ? t("ledger.resolvedOn", { date: shortDate(entry.resolvedAt ?? entry.createdAt, localeTag()) })
          : t("ledger.logged", { date: shortDate(entry.createdAt, localeTag()) }),
      ),
    );
    if (entry.notes !== undefined) item.append(el(document, "blockquote", "rm-err-note", entry.notes));

    const editor = el(document, "div", "rm-err-editor");
    editor.hidden = true;
    const input = el(document, "textarea", "rm-input");
    input.rows = 2;
    input.maxLength = 2000;
    input.value = entry.notes ?? "";
    input.placeholder = t("ledger.notePlaceholder");
    input.setAttribute("aria-label", t("ledger.note"));

    const actions = el(document, "div", "rm-err-actions");
    actions.append(
      button(document, entry.resolved ? t("ledger.reopen") : t("ledger.resolve"), () => {
        void options.update(entry.id, { resolved: !entry.resolved });
      }, scoped(), { variant: entry.resolved ? "ghost" : "outline" }),
      button(document, t("ledger.note"), () => {
        editor.hidden = !editor.hidden;
        if (!editor.hidden) input.focus();
      }, scoped(), { variant: "ghost" }),
    );
    item.append(actions);

    const editorActions = el(document, "div", "rm-err-actions");
    editorActions.append(
      button(document, t("ledger.saveNote"), () => {
        const value = input.value.trim();
        void options.update(entry.id, { notes: value.length === 0 ? null : value });
      }, scoped(), { variant: "outline" }),
    );
    if (entry.notes !== undefined) {
      editorActions.append(
        button(document, t("ledger.clearNote"), () => {
          void options.update(entry.id, { notes: null });
        }, scoped(), { variant: "ghost" }),
      );
    }
    editor.append(input, editorActions);
    item.append(editor);
    parent.append(item);
  };

  const renderInherited = (watchpoints: readonly ErrorWatchpoint[]): void => {
    const section = el(document, "section", "rm-sec");
    section.append(el(document, "div", "rm-sec-title", t("ledger.inherited")));
    if (watchpoints.length === 0) {
      section.append(el(document, "p", "rm-muted", t("ledger.noInherited")));
      root.append(section);
      return;
    }
    for (const watchpoint of watchpoints) {
      const row = el(document, "div", "rm-err rm-err-inherited");
      row.dataset.sourceNodeId = watchpoint.nodeId;
      const head = el(document, "div", "rm-err-head");
      const icon = el(document, "span", "rm-err-icon");
      setIcon(icon, ICONS.warn);
      head.append(icon, el(document, "span", "rm-err-summary", watchpoint.entry.summary));
      row.append(head);
      const meta = el(document, "div", "rm-err-meta");
      meta.append(el(document, "span", undefined, `${categoryLabel(watchpoint.entry.category)} · `));
      const from = t("ledger.from", { title: watchpoint.nodeTitle });
      meta.append(
        options.selectNode
          ? button(document, from, () => options.selectNode?.(watchpoint.nodeId), scoped(), { variant: "link" })
          : el(document, "span", undefined, from),
      );
      row.append(meta);
      section.append(row);
    }
    root.append(section);
  };

  return {
    render(path, node) {
      if (disposed || signal.aborted) return;
      clear();
      if (!path || !node) {
        root.append(el(document, "p", "rm-muted", t("ledger.select")));
        return;
      }
      const groups = entriesByCategory(node);
      if (groups.length === 0) {
        root.append(el(document, "p", "rm-muted", t("ledger.empty")));
      } else {
        for (const [category, entries] of groups) {
          const group = el(document, "section", "rm-sec");
          group.dataset.category = category;
          const title = el(document, "div", "rm-sec-title");
          title.append(el(document, "span", undefined, categoryLabel(category)), el(document, "span", undefined, String(entries.length)));
          group.append(title);
          for (const entry of entries) renderEntry(group, entry);
          root.append(group);
        }
      }
      renderInherited(collectErrorWatchpoints(path, node.id).filter((watchpoint) => watchpoint.nodeId !== node.id));
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clear();
      root.remove();
    },
  };
}
