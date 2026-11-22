/** Learning Path — attach/link dialogs for child sessions.
 *
 * Both dialogs are explicit learner actions: they list plugin paths/nodes and
 * native chats read through the backend, and only write a link after a click.
 * They never create sessions (that is the launcher) and never delete chats.
 * Content and every widget belong to the supplied signal, so leaving the view
 * or closing the dialog disposes them.
 */
import { t } from "../i18n.ts";
import type { PluginFrontendContext, PluginWidgetHandle } from "learnharness-plugin-api";
import type { ChildSessionKind, LearningPath, PathNode } from "../domain.ts";
import type { SessionLauncher } from "../session-launcher.ts";
import type {
  AvailableSession,
  SessionLinkResult,
  SessionParentResult,
} from "../session-types.ts";
import { el } from "./dom.ts";

interface PathSummaryLike {
  readonly id: string;
  readonly title: string;
}

interface PathsListResult {
  readonly paths: readonly PathSummaryLike[];
}

interface PathResult {
  readonly path: LearningPath | null;
}

export interface AttachDialogOptions {
  readonly launcher: SessionLauncher;
  readonly chatId: string;
  readonly kind: ChildSessionKind;
  readonly signal: AbortSignal;
  readonly onLinked?: (result: SessionLinkResult) => void;
}

export interface LinkExistingDialogOptions {
  readonly launcher: SessionLauncher;
  readonly pathId: string;
  readonly nodeId: string;
  readonly nodeTitle: string;
  readonly signal: AbortSignal;
  readonly onLinked?: (result: SessionLinkResult) => void;
}


/** linkedom does not reflect `select.value`; read the selected option instead. */
function selectedValue(select: HTMLSelectElement): string {
  return (
    select.value ||
    [...select.options].find((option) => option.selected)?.value ||
    select.options[0]?.value ||
    ""
  );
}

function allNodes(path: LearningPath): PathNode[] {
  return path.modules.flatMap((module) => module.nodes);
}

function kindLabel(kind: ChildSessionKind): string {
  return kind === "teaching" ? t("d.teaching") : t("d.practice");
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Attach the session the action was invoked from to a learner-chosen node. */
export function openAttachSessionDialog(
  ctx: PluginFrontendContext,
  options: AttachDialogOptions,
): PluginWidgetHandle<{ title: string; content: unknown }> | null {
  let dialog: PluginWidgetHandle<never> | null = null;

  const close = (): void => {
    const current = dialog;
    dialog = null;
    current?.dispose();
  };

  dialog = ctx.ui.openDialog(
    {
      title: t("d.attachTitle"),
      content: async (container: HTMLElement, contentSignal: AbortSignal) => {
        const document = container.ownerDocument;
        const handles: PluginWidgetHandle<unknown>[] = [];
        const root = el(document, "div", "lp-session-dialog");
        const loading = el(document, "p", "lp-muted", t("d.loadingPaths"));
        root.append(loading);
        container.append(root);

        const status = el(document, "p", "lp-dialog-status");
        status.setAttribute("role", "status");
        const error = el(document, "p", "lp-dialog-error");
        error.setAttribute("role", "alert");
        error.hidden = true;

        const cleanup = (): void => {
          for (const handle of handles.reverse()) handle.dispose();
          handles.length = 0;
          root.remove();
        };

        try {
          const [listed, parent] = await Promise.all([
            ctx.call<PathsListResult>("paths.list"),
            ctx.call<SessionParentResult>("sessions.forChat", { chatId: options.chatId }),
          ]);
          if (contentSignal.aborted || options.signal.aborted) return cleanup;
          loading.remove();

          if (parent.link) {
            root.append(
              el(
                document,
                "p",
                "lp-muted",
                t("d.alreadyLinked", { node: parent.link.nodeTitle, path: parent.link.pathTitle }),
              ),
            );
            return cleanup;
          }

          if ((listed.paths ?? []).length === 0) {
            root.append(
              el(
                document,
                "p",
                "lp-muted",
                t("d.noPaths"),
              ),
            );
            return cleanup;
          }

          const pathLabel = el(document, "label", "lp-field");
          pathLabel.append(el(document, "span", "lp-field-label", t("d.path")));
          const pathSelect = el(document, "select", "lp-select");
          pathSelect.setAttribute("aria-label", t("d.path"));
          for (const summary of listed.paths) {
            const option = el(document, "option", undefined, summary.title);
            option.value = summary.id;
            pathSelect.append(option);
          }
          pathLabel.append(pathSelect);

          const nodeLabel = el(document, "label", "lp-field");
          nodeLabel.append(el(document, "span", "lp-field-label", t("d.node")));
          const nodeSelect = el(document, "select", "lp-select");
          nodeSelect.setAttribute("aria-label", t("d.node"));
          nodeLabel.append(nodeSelect);

          root.append(pathLabel, nodeLabel, status, error);

          const buttonHost = el(document, "span", "lp-button-host");
          root.append(buttonHost);
          let currentPath: LearningPath | null = null;

          const attachButton = ctx.ui.mountButton(
            buttonHost,
            {
              label: t("d.attach"),
              variant: "default",
              size: "sm",
              disabled: true,
              onClick: async () => {
                const nodeId = selectedValue(nodeSelect);
                if (!currentPath || !nodeId || contentSignal.aborted) return;
                error.hidden = true;
                attachButton.update({ disabled: true, label: t("d.attaching") });
                try {
                  const result = await options.launcher.attach({
                    pathId: currentPath.id,
                    nodeId,
                    chatId: options.chatId,
                    kind: options.kind,
                  });
                  if (contentSignal.aborted) return;
                  status.textContent = t("d.attached", { label: result.link.label });
                  status.dataset.state = "success";
                  options.onLinked?.(result);
                  close();
                } catch (problem) {
                  if (contentSignal.aborted) return;
                  error.textContent = t("d.attachFailed", { message: describeError(problem) });
                  error.hidden = false;
                  attachButton.update({ disabled: false, label: t("d.attach") });
                }
              },
            },
            { signal: contentSignal },
          );
          handles.push(attachButton);

          const loadPath = async (): Promise<void> => {
            const pathId = selectedValue(pathSelect);
            nodeSelect.replaceChildren();
            attachButton.update({ disabled: true });
            try {
              const result = await ctx.call<PathResult>("paths.get", { id: pathId });
              if (contentSignal.aborted) return;
              currentPath = result.path;
              if (!currentPath) throw new Error(t("d.pathGone"));
              for (const node of allNodes(currentPath)) {
                const option = el(
                  document,
                  "option",
                  undefined,
                  `${node.title} (${node.type})`,
                );
                option.value = node.id;
                nodeSelect.append(option);
              }
              attachButton.update({ disabled: nodeSelect.options.length === 0 });
            } catch (problem) {
              if (contentSignal.aborted) return;
              currentPath = null;
              error.textContent = t("d.pathLoadFailed", { message: describeError(problem) });
              error.hidden = false;
            }
          };

          pathSelect.addEventListener("change", () => {
            if (!contentSignal.aborted) void loadPath();
          });
          await loadPath();
          return cleanup;
        } catch (problem) {
          if (contentSignal.aborted) return;
          loading.remove();
          error.textContent = t("d.prepareFailed", { message: describeError(problem) });
          error.hidden = false;
          root.append(error);
          return cleanup;
        }
      },
    },
    { signal: options.signal },
  ) as PluginWidgetHandle<never>;

  return dialog as unknown as PluginWidgetHandle<{ title: string; content: unknown }> | null;
}

/** List native sessions and attach one of them to a known node. */
export function openLinkExistingSessionDialog(
  ctx: PluginFrontendContext,
  options: LinkExistingDialogOptions,
): PluginWidgetHandle<{ title: string; content: unknown }> | null {
  let dialog: PluginWidgetHandle<never> | null = null;

  const close = (): void => {
    const current = dialog;
    dialog = null;
    current?.dispose();
  };

  dialog = ctx.ui.openDialog(
    {
      title: t("d.linkTitle"),
      content: async (container: HTMLElement, contentSignal: AbortSignal) => {
        const document = container.ownerDocument;
        const handles: PluginWidgetHandle<unknown>[] = [];
        const root = el(document, "div", "lp-session-dialog");
        const loading = el(document, "p", "lp-muted", t("d.loadingSessions"));
        root.append(loading);
        container.append(root);

        const status = el(document, "p", "lp-dialog-status");
        status.setAttribute("role", "status");
        const error = el(document, "p", "lp-dialog-error");
        error.setAttribute("role", "alert");
        error.hidden = true;

        const cleanup = (): void => {
          for (const handle of handles.reverse()) handle.dispose();
          handles.length = 0;
          root.remove();
        };

        try {
          const sessions = await options.launcher.available();
          if (contentSignal.aborted || options.signal.aborted) return cleanup;
          loading.remove();
          root.append(
            el(
              document,
              "p",
              "lp-muted",
              t("d.chooseSession", { node: options.nodeTitle }),
            ),
          );

          const free = (sessions as readonly AvailableSession[]).filter(
            (session) => session.linked === null,
          );
          if (free.length === 0) {
            root.append(
              el(
                document,
                "p",
                "lp-muted",
                t("d.noSessions"),
              ),
            );
            return cleanup;
          }

          const list = el(document, "ul", "lp-session-picker");
          root.append(list, status, error);
          for (const session of free) {
            const item = el(document, "li", "lp-session-picker-row");
            const label = el(
              document,
              "span",
              "lp-session-picker-label",
              `${kindLabel(session.kind)} — ${session.title}`,
            );
            const host = el(document, "span", "lp-button-host");
            item.append(label, host);
            const link = ctx.ui.mountButton(
              host,
              {
                label: t("d.link"),
                variant: "outline",
                size: "xs",
                onClick: async () => {
                  if (contentSignal.aborted) return;
                  error.hidden = true;
                  link.update({ disabled: true, label: t("d.linking") });
                  try {
                    const result = await options.launcher.attach({
                      pathId: options.pathId,
                      nodeId: options.nodeId,
                      chatId: session.chatId,
                      kind: session.kind,
                      label: session.title,
                    });
                    if (contentSignal.aborted) return;
                    status.textContent = t("d.linked", { title: session.title });
                    status.dataset.state = "success";
                    options.onLinked?.(result);
                    close();
                  } catch (problem) {
                    if (contentSignal.aborted) return;
                    error.textContent = t("d.linkFailed", { message: describeError(problem) });
                    error.hidden = false;
                    link.update({ disabled: false, label: t("d.link") });
                  }
                },
              },
              { signal: contentSignal },
            );
            handles.push(link);
            list.append(item);
          }
          return cleanup;
        } catch (problem) {
          if (contentSignal.aborted) return;
          loading.remove();
          error.textContent = t("d.listFailed", { message: describeError(problem) });
          error.hidden = false;
          root.append(error);
          return cleanup;
        }
      },
    },
    { signal: options.signal },
  ) as PluginWidgetHandle<never>;

  return dialog as unknown as PluginWidgetHandle<{ title: string; content: unknown }> | null;
}
