/** Roadmap canvas: the one graph view. Every node is a dot with a short title beside it; thin arrows run from each
 * prerequisite to its dependent, bottom to top by default; each module shows as a small coloured label at its first
 * node and a tint on its nodes' titles, never as a frame. Pan + zoom.
 *
 * Controlled component: `render` receives the authoritative path and UI state;
 * clicks are reported through callbacks. All listeners belong to the signal.
 */
import type { LearningPath, PathModule, PathNode } from "../domain.ts";
import { locale, t } from "../i18n.ts";
import type { MessageKey } from "../i18n.ts";
import type { NodePrerequisites } from "../node-prerequisites.ts";
import { ICONS, setIcon } from "./icons.ts";
import { EMPTY_SNAPSHOT, edgeKey, growthPlan, snapshotOf } from "./graph-growth.ts";
import type { GraphSnapshot, GrowthPlan } from "./graph-growth.ts";
import { REPLAY_SPEEDS, REPLAY_STEP_MS, layoutAt, replayOf } from "./graph-replay.ts";
import type { Replay, ReplaySpeed } from "./graph-replay.ts";
import type { GraphDirection } from "./roadmap-layout.ts";
import { isDone, layoutGraph, moduleCounts } from "./roadmap-layout.ts";
import type { PlacedModule, PlacedNode, RoadmapLayout } from "./roadmap-layout.ts";
import { el } from "./dom.ts";
export interface CanvasState {
  readonly path: LearningPath;
  readonly selectedNodeId: string | null;
  readonly expandedModuleId: string | null;
  readonly showOptional: boolean;
  /** The legend shows only when the side panel is closed, as in the mockups. */
  readonly showLegend: boolean;
  /** Which way the graph runs. Absent: bottom to top. */
  readonly graphDirection?: GraphDirection;
  /** Prerequisites per node. Absent: each node's own, else module order. */
  readonly prerequisites?: readonly NodePrerequisites[];
}

export interface CanvasCallbacks {
  selectNode(nodeId: string): void;
  toggleModule(moduleId: string): void;
  /** The user picked a graph direction. */
  setGraphDirection?(direction: GraphDirection): void;
}

export interface RoadmapCanvas {
  render(state: CanvasState): void;
  /** No roadmap to show: the next roadmap drawn grows in from nothing. */
  clear(): void;
  dispose(): void;
}

export function moduleState(module: PathModule): "done" | "progress" | "todo" {
  const { done, total } = moduleCounts(module);
  if (total > 0 && done === total) return "done";
  if (done > 0 || module.nodes.some((node) => node.progression === "in_progress")) return "progress";
  return "todo";
}

/** "K&R, ch. 5" style anchor for a module header: the first anchored chapter. */
export function moduleSource(module: PathModule): string | null {
  const anchor = module.nodes.find((node) => node.sourceAnchor.chapter)?.sourceAnchor ?? module.nodes[0]?.sourceAnchor;
  if (!anchor) return null;
  const short = anchor.reference.split(/[,:(—–-]/)[0]!.trim();
  if (!anchor.chapter) return short;
  return `${short} ${locale() === "ru" ? "гл." : "ch."} ${anchor.chapter}`;
}

/** How many module colours the canvas cycles through (rm-mod-0 .. rm-mod-5 in the stylesheet). */
const MODULE_HUES = 6;

function unresolved(node: PathNode): number {
  return node.errors.filter((entry) => !entry.resolved).length;
}

export function createRoadmapCanvas(
  document: Document,
  host: HTMLElement,
  signal: AbortSignal,
  callbacks: CanvasCallbacks,
): RoadmapCanvas {
  const root = el(document, "div", "rm-canvas");
  const viewport = el(document, "div", "rm-viewport");
  const stage = el(document, "div", "rm-stage");
  viewport.append(stage);
  const controls = el(document, "div", "rm-zoom");
  const zoomOut = el(document, "button", "rm-zoom-btn");
  const zoomLabel = el(document, "button", "rm-zoom-value", "100%");
  const zoomIn = el(document, "button", "rm-zoom-btn");
  setIcon(zoomOut, ICONS.minus);
  setIcon(zoomIn, ICONS.plus);
  zoomOut.type = zoomIn.type = zoomLabel.type = "button";
  zoomOut.setAttribute("aria-label", "−");
  zoomIn.setAttribute("aria-label", "+");
  zoomLabel.title = t("zoom.fit");
  controls.append(zoomOut, zoomLabel, zoomIn);
  const directionBar = el(document, "div", "rm-zoom rm-direction");
  const directionButtons = new Map<GraphDirection, HTMLButtonElement>();
  for (const [direction, key] of [
    ["bottom-to-top", "graph.dirUp"],
    ["left-to-right", "graph.dirRight"],
  ] as const) {
    const button = el(document, "button", "rm-zoom-value", t(key));
    button.type = "button";
    button.dataset.direction = direction;
    button.addEventListener("click", () => callbacks.setGraphDirection?.(direction), { signal });
    directionButtons.set(direction, button);
    directionBar.append(button);
  }
  const legend = el(document, "div", "rm-legend");
  // Announces how many nodes a save added; the graph itself is not a live region.
  const growStatus = el(document, "p", "rm-grow-status");
  growStatus.setAttribute("role", "status");
  growStatus.setAttribute("aria-live", "polite");
  // Step replay: off until the user presses play. Buttons carry data-replay for tests and styling.
  const replayBar = el(document, "div", "rm-replay");
  const replayButton = (action: string, label: string): HTMLButtonElement => {
    const button = el(document, "button", "rm-zoom-value", label);
    button.type = "button";
    button.dataset.replay = action;
    replayBar.append(button);
    return button;
  };
  const replayBack = replayButton("back", "");
  const replayPlay = replayButton("play", "");
  const replayForward = replayButton("forward", "");
  const replaySpeedButton = replayButton("speed", "");
  const replayExit = replayButton("exit", "");
  const replayCaption = el(document, "p", "rm-replay-caption");
  replayCaption.setAttribute("role", "status");
  replayBar.append(replayCaption);
  root.append(viewport, controls, directionBar, replayBar, legend, growStatus);
  host.append(root);

  let state: CanvasState | null = null;
  let layout: Pick<RoadmapLayout, "width" | "height" | "modules"> | null = null;
  let scale = 1;
  let tx = 0;
  let ty = 0;
  let placedViewKey: string | null = null;
  /** What was drawn last: a snapshot of the same roadmap, "empty" after clear(), or null at mount. */
  let drawn: { readonly pathId: string; readonly snapshot: GraphSnapshot } | "empty" | null = null;
  let disposed = false;
  /** The replay: step is 1-based; null means the whole graph is shown. */
  let replayStep: number | null = null;
  let replayPlaying = false;
  let replaySpeed: ReplaySpeed = "normal";
  let replayTimer: ReturnType<typeof setTimeout> | null = null;
  let replayData: Replay = { steps: [] };

  const applyTransform = (): void => {
    stage.style.transform = `translate(${Math.round(tx)}px, ${Math.round(ty)}px) scale(${scale})`;
    zoomLabel.textContent = `${Math.round(scale * 100)}%`;
  };

  const clampPan = (): void => {
    if (!layout) return;
    const vw = viewport.clientWidth;
    const vh = viewport.clientHeight;
    const w = layout.width * scale;
    const h = layout.height * scale;
    tx = w <= vw ? (vw - w) / 2 : Math.min(0, Math.max(vw - w, tx));
    ty = h <= vh ? (vh - h) / 2 : Math.min(0, Math.max(vh - h, ty));
  };

  /** Show the start of the map (bottom) when the expanded module is visible from
   * there, as in the mockup; otherwise center the expanded module. */
  const focus = (moduleId: string | null): void => {
    if (!layout) return;
    const vh = viewport.clientHeight;
    const bottomAligned = vh - layout.height * scale;
    const target = layout.modules.find((placed) => placed.module.id === moduleId);
    if (!target || target.y * scale + bottomAligned >= 12) ty = bottomAligned;
    else ty = vh / 2 - target.y * scale;
    tx = (viewport.clientWidth - layout.width * scale) / 2;
    clampPan();
    applyTransform();
  };

  const setScale = (next: number, cx = viewport.clientWidth / 2, cy = viewport.clientHeight / 2): void => {
    const clamped = Math.min(1.6, Math.max(0.4, Math.round(next * 100) / 100));
    tx = cx - ((cx - tx) / scale) * clamped;
    ty = cy - ((cy - ty) / scale) * clamped;
    scale = clamped;
    clampPan();
    applyTransform();
  };

  const fit = (): void => {
    if (!layout) return;
    const fitScale = Math.min(1, viewport.clientWidth / layout.width, viewport.clientHeight / layout.height);
    scale = Math.max(0.4, Math.round(fitScale * 100) / 100);
    clampPan();
    applyTransform();
  };

  zoomOut.addEventListener("click", () => setScale(scale - 0.1), { signal });
  zoomIn.addEventListener("click", () => setScale(scale + 0.1), { signal });
  zoomLabel.addEventListener("click", () => (scale === 1 ? fit() : setScale(1)), { signal });
  viewport.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      if (event.ctrlKey || event.metaKey) {
        const rect = viewport.getBoundingClientRect();
        setScale(scale * (event.deltaY > 0 ? 0.9 : 1.1), event.clientX - rect.left, event.clientY - rect.top);
        return;
      }
      tx -= event.shiftKey ? event.deltaY : event.deltaX;
      ty -= event.shiftKey ? 0 : event.deltaY;
      clampPan();
      applyTransform();
    },
    { signal, passive: false },
  );

  let drag: { x: number; y: number; tx: number; ty: number; id: number } | null = null;
  viewport.addEventListener(
    "pointerdown",
    (event) => {
      if (event.button !== 0 || (event.target as Element).closest("button")) return;
      drag = { x: event.clientX, y: event.clientY, tx, ty, id: event.pointerId };
      viewport.setPointerCapture(event.pointerId);
      viewport.classList.add("rm-dragging");
    },
    { signal },
  );
  viewport.addEventListener(
    "pointermove",
    (event) => {
      if (!drag || event.pointerId !== drag.id) return;
      tx = drag.tx + event.clientX - drag.x;
      ty = drag.ty + event.clientY - drag.y;
      clampPan();
      applyTransform();
    },
    { signal },
  );
  const endDrag = (event: PointerEvent): void => {
    if (!drag || event.pointerId !== drag.id) return;
    drag = null;
    viewport.classList.remove("rm-dragging");
  };
  viewport.addEventListener("pointerup", endDrag, { signal });
  viewport.addEventListener("pointercancel", endDrag, { signal });

  // Absent in some embedders and in DOM test environments; panning still clamps on input.
  const resize =
    typeof ResizeObserver === "function"
      ? new ResizeObserver(() => {
          if (disposed || !layout) return;
          clampPan();
          applyTransform();
        })
      : null;
  resize?.observe(viewport);

  /** One node: a dot (a flag for a checkpoint) with its title beside it. */
  const nodeButton = (placed: PlacedNode, selected: boolean, moduleTitle: string): HTMLButtonElement => {
    const { node } = placed;
    const button = el(document, "button", `rm-node rm-mod-${placed.moduleIndex % MODULE_HUES}`);
    button.type = "button";
    button.dataset.nodeId = node.id;
    if (selected) button.classList.add("rm-sel");
    if (node.optional) button.classList.add("rm-opt");
    if (node.alternativeGroup) button.classList.add("rm-alt");
    if (node.progression === "skipped") button.classList.add("rm-skip");
    if (node.progression === "consolidated") button.classList.add("rm-done");
    if (node.progression === "in_progress") button.classList.add("rm-prog");
    if (node.type === "checkpoint") button.classList.add("rm-check");
    button.style.left = `${placed.x}px`;
    button.style.top = `${placed.y}px`;
    button.style.width = `${placed.w}px`;
    button.style.height = `${placed.h}px`;
    const marker = el(document, "span", node.type === "checkpoint" ? "rm-dot rm-flag" : "rm-dot");
    if (node.type === "checkpoint") setIcon(marker, ICONS.flag);
    button.append(marker, el(document, "span", "rm-node-title", node.title));
    const tag = node.alternativeGroup ? t("mark.alternativeShort") : node.optional ? t("mark.optionalShort") : null;
    if (tag) {
      const hideUntilHover = !node.alternativeGroup && node.optional;
      button.append(el(document, "span", hideUntilHover ? "rm-node-tag rm-node-tag-opt" : "rm-node-tag", tag));
    }
    if (node.reviewMark) button.append(el(document, "span", "rm-node-review", t("mark.shortReviewShort")));
    const errors = unresolved(node);
    if (errors > 0) {
      const warn = el(document, "span", "rm-node-warn");
      warn.title = errors === 1 ? t("foot.error1") : t("foot.errors", { n: errors });
      setIcon(warn, ICONS.warn);
      button.append(warn);
    }
    button.title = `${node.title}\n${moduleTitle}`;
    button.addEventListener("click", () => {
      if (!disposed && !signal.aborted) callbacks.selectNode(node.id);
    }, { signal });
    return button;
  };

  const moduleHeaderText = (module: PathModule): string => {
    const { done, total } = moduleCounts(module);
    const status = moduleState(module);
    const parts = [
      status === "done" ? t("status.consolidated") : status === "progress" ? t("status.in_progress") : t("status.unstarted"),
      `${done} / ${total}`,
    ];
    const source = moduleSource(module);
    if (source) parts.push(source);
    return parts.join(" · ");
  };

  /** A module's small label above its first node. Clicking it focuses the module. */
  const renderModule = (placed: PlacedModule): HTMLElement => {
    const { module } = placed;
    const label = el(document, "button", `${placed.expanded ? "rm-module-label rm-module-label-focus" : "rm-module-label"} rm-mod-${placed.index % MODULE_HUES}`, module.title);
    label.type = "button";
    label.dataset.moduleId = module.id;
    label.style.left = `${placed.x}px`;
    label.style.top = `${placed.y}px`;
    label.title = [module.goal ?? module.title, moduleHeaderText(module)].join("\n");
    label.addEventListener("click", () => {
      if (!disposed && !signal.aborted) callbacks.toggleModule(module.id);
    }, { signal });
    return label;
  };

  const renderEdges = (current: RoadmapLayout, plan: GrowthPlan): SVGSVGElement => {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("class", "rm-edges");
    svg.setAttribute("width", String(current.width));
    svg.setAttribute("height", String(current.height));
    for (const edge of current.edges) {
      const bends = edge.points ?? [];
      const line = document.createElementNS(ns, bends.length > 0 ? "polyline" : "line");
      if (bends.length > 0) {
        const all = [{ x: edge.x1, y: edge.y1 }, ...bends, { x: edge.x2, y: edge.y2 }];
        line.setAttribute("points", all.map((pt) => `${pt.x},${pt.y}`).join(" "));
        line.setAttribute("fill", "none");
      } else {
        line.setAttribute("x1", String(edge.x1));
        line.setAttribute("y1", String(edge.y1));
        line.setAttribute("x2", String(edge.x2));
        line.setAttribute("y2", String(edge.y2));
      }
      const key = edgeKey(edge.from, edge.to);
      const delay = plan.delays.get(key);
      const grow = delay === undefined ? "" : " rm-grow";
      const style = delay === undefined ? null : `animation-delay: ${delay}ms`;
      if (edge.dashed) line.setAttribute("class", `rm-dashed${grow}`);
      else if (grow) line.setAttribute("class", "rm-grow");
      if (style) line.setAttribute("style", style);
      svg.append(line);
      // Arrowhead at the dependent end: two wings laid back from the tip along the line.
      const prev = bends.length > 0 ? bends[bends.length - 1]! : { x: edge.x1, y: edge.y1 };
      const length = Math.hypot(edge.x2 - prev.x, edge.y2 - prev.y) || 1;
      const ux = (edge.x2 - prev.x) / length;
      const uy = (edge.y2 - prev.y) / length;
      const baseX = edge.x2 - ux * 7;
      const baseY = edge.y2 - uy * 7;
      const wingX = -uy * 4;
      const wingY = ux * 4;
      const head = document.createElementNS(ns, "path");
      head.setAttribute(
        "d",
        `M${baseX + wingX} ${baseY + wingY} L${edge.x2} ${edge.y2} L${baseX - wingX} ${baseY - wingY}`,
      );
      head.setAttribute("class", `rm-arrow${grow}`);
      if (style) head.setAttribute("style", style);
      svg.append(head);
    }
    return svg;
  };

  /** The pannable graph: edges, module labels and nodes. */
  const renderGraph = (current: CanvasState): void => {
    const full = layoutGraph(current.path, {
      showOptional: current.showOptional,
      prerequisites: current.prerequisites,
      direction: current.graphDirection ?? "bottom-to-top",
      expandedModuleId: current.expandedModuleId,
    });
    layout = full;
    replayData = replayOf(full);
    if (replayStep !== null) replayStep = Math.min(replayStep, Math.max(1, replayData.steps.length));
    // During a replay only the revealed layers are drawn; the layer just revealed grows in.
    const replaying = replayStep !== null;
    const roadmap = replaying ? layoutAt(replayData, full, replayStep!) : full;
    stage.style.width = `${roadmap.width}px`;
    stage.style.height = `${roadmap.height}px`;
    // Only items new since the last drawing animate; a re-render of the same graph animates nothing.
    let before = drawn === "empty" ? EMPTY_SNAPSHOT : drawn !== null && drawn.pathId === current.path.id ? drawn.snapshot : null;
    if (replaying) before = snapshotOf(layoutAt(replayData, full, replayStep! - 1));
    const plan = growthPlan(before, roadmap);
    if (!replaying) drawn = { pathId: current.path.id, snapshot: snapshotOf(roadmap) };
    growStatus.textContent = !replaying && plan.addedNodes > 0 ? t("graph.grew", { n: plan.addedNodes }) : "";
    const moduleTitles = new Map(current.path.modules.map((module) => [module.id, module.title] as const));
    const children: Element[] = [renderEdges(roadmap, plan)];
    for (const placed of roadmap.modules) children.push(renderModule(placed));
    for (const placed of roadmap.nodes) {
      const button = nodeButton(placed, placed.node.id === current.selectedNodeId, moduleTitles.get(placed.moduleId) ?? "");
      const delay = plan.delays.get(placed.node.id);
      if (delay !== undefined) {
        button.classList.add("rm-grow");
        button.style.animationDelay = `${delay}ms`;
      }
      children.push(button);
    }
    stage.replaceChildren(...children);
    const viewChanged = placedViewKey !== current.path.id;
    placedViewKey = current.path.id;
    if (viewChanged) {
      scale = 1;
      // Wait one frame so the viewport has its real size on first mount.
      const schedule = typeof requestAnimationFrame === "function" ? requestAnimationFrame : (run: () => void) => setTimeout(run, 0);
      schedule(() => {
        if (!disposed) focus(current.expandedModuleId);
      });
    } else {
      clampPan();
      applyTransform();
    }
  };

  const replayCaptionText = (): string => {
    if (replayStep === null) return "";
    const entry = replayData.steps[replayStep - 1];
    if (!entry) return "";
    const items = entry.items
      .map((item) => (item.after.length > 0 ? t("replay.item", { title: item.node.node.title, from: item.after.join(", ") }) : item.node.node.title))
      .join("; ");
    return t(replayStep === 1 ? "replay.rootStep" : "replay.step", { i: replayStep, n: replayData.steps.length, items });
  };

  const renderReplayBar = (): void => {
    const total = replayData.steps.length;
    const active = replayStep !== null;
    replayBack.textContent = "◀";
    replayBack.title = t("replay.back"); replayBack.setAttribute("aria-label", replayBack.title);
    replayForward.textContent = "▶|";
    replayForward.title = t("replay.forward"); replayForward.setAttribute("aria-label", replayForward.title);
    replayPlay.textContent = replayPlaying ? "❚❚" : "▶";
    replayPlay.title = t(replayPlaying ? "replay.pause" : "replay.play");
    replayPlay.setAttribute("aria-label", replayPlay.title);
    replayPlay.setAttribute("aria-pressed", String(replayPlaying));
    replaySpeedButton.textContent = t("replay.speed", { speed: t(`replay.${replaySpeed}` as MessageKey) });
    replayExit.textContent = t("replay.exit");
    replayExit.hidden = !active;
    replayBack.disabled = !active || replayStep! <= 1;
    replayForward.disabled = total === 0 || (active && replayStep! >= total);
    replayPlay.disabled = total === 0;
    replayCaption.textContent = replayCaptionText();
    replayCaption.hidden = !active;
  };

  const stopTimer = (): void => {
    if (replayTimer !== null) clearTimeout(replayTimer);
    replayTimer = null;
  };

  const redraw = (): void => {
    if (state && !disposed && !signal.aborted) renderGraph(state);
    renderReplayBar();
  };

  const tick = (): void => {
    replayTimer = null;
    if (disposed || !replayPlaying || replayStep === null) return;
    if (replayStep >= replayData.steps.length) {
      replayPlaying = false;
      redraw();
      return;
    }
    replayStep += 1;
    redraw();
    if (replayStep >= replayData.steps.length) replayPlaying = false;
    else replayTimer = setTimeout(tick, REPLAY_STEP_MS[replaySpeed]);
    renderReplayBar();
  };

  const pauseReplay = (): void => {
    replayPlaying = false;
    stopTimer();
  };

  const stepReplay = (delta: number): void => {
    if (replayData.steps.length === 0) return;
    pauseReplay();
    replayStep = Math.min(replayData.steps.length, Math.max(1, (replayStep ?? 0) + delta));
    redraw();
  };

  replayForward.addEventListener("click", () => stepReplay(1), { signal });
  replayBack.addEventListener("click", () => {
    if (replayStep !== null) stepReplay(-1);
  }, { signal });
  replayPlay.addEventListener("click", () => {
    if (replayData.steps.length === 0) return;
    if (replayPlaying) {
      pauseReplay();
      renderReplayBar();
      return;
    }
    // Play from the root when the replay is off or already at its end.
    if (replayStep === null || replayStep >= replayData.steps.length) replayStep = 1;
    replayPlaying = replayData.steps.length > 1;
    stopTimer();
    if (replayPlaying) replayTimer = setTimeout(tick, REPLAY_STEP_MS[replaySpeed]);
    redraw();
  }, { signal });
  replaySpeedButton.addEventListener("click", () => {
    replaySpeed = REPLAY_SPEEDS[(REPLAY_SPEEDS.indexOf(replaySpeed) + 1) % REPLAY_SPEEDS.length]!;
    if (replayPlaying) {
      stopTimer();
      replayTimer = setTimeout(tick, REPLAY_STEP_MS[replaySpeed]);
    }
    renderReplayBar();
  }, { signal });
  replayExit.addEventListener("click", () => {
    pauseReplay();
    replayStep = null;
    redraw();
  }, { signal });
  signal.addEventListener("abort", stopTimer, { once: true });

  const renderLegend = (): void => {
    const item = (icon: string, key: MessageKey, extraClass = ""): HTMLElement => {
      const span = el(document, "span", `rm-legend-item ${extraClass}`);
      const iconHost = el(document, "span", "rm-legend-icon");
      setIcon(iconHost, icon);
      span.append(iconHost, el(document, "span", undefined, t(key)));
      return span;
    };
    const lineItem = (dashed: boolean, key: MessageKey): HTMLElement => {
      const span = el(document, "span", "rm-legend-item");
      span.append(el(document, "span", dashed ? "rm-legend-line rm-dashed-line" : "rm-legend-line"), el(document, "span", undefined, t(key)));
      return span;
    };
    const arrowItem = el(document, "span", "rm-legend-item");
    arrowItem.append(el(document, "span", "rm-legend-arrow", "→"), el(document, "span", undefined, t("legend.arrow")));
    const alt = el(document, "span", "rm-legend-item");
    alt.append(el(document, "span", "rm-legend-alt", t("mark.alternativeShort")), el(document, "span", undefined, t("mark.alternative")));
    const swatch = (state: "consolidated" | "in_progress" | "unstarted" | "skipped", key: MessageKey): HTMLElement => {
      const span = el(document, "span", "rm-legend-item");
      const cls = state === "consolidated" ? " rm-done" : state === "in_progress" ? " rm-prog" : state === "skipped" ? " rm-skip" : "";
      span.append(el(document, "span", `rm-legend-dot rm-node${cls}`), el(document, "span", undefined, t(key)));
      return span;
    };
    legend.replaceChildren(
      swatch("consolidated", "status.consolidated"),
      swatch("in_progress", "status.in_progress"),
      swatch("unstarted", "status.unstarted"),
      swatch("skipped", "status.skipped"),
      lineItem(true, "mark.optional"),
      alt,
      item(ICONS.flag, "legend.checkpoint"),
      item(ICONS.warn, "legend.error", "rm-legend-warn"),
      arrowItem,
      el(
        document,
        "span",
        "rm-legend-item rm-legend-note",
        state !== null && state.path.modules.some((module) => module.nodes.some((node) => node.prerequisites !== undefined))
          ? t("legend.prerequisitesNote")
          : t("legend.moduleOrder"),
      ),
    );
  };

  return {
    render(next) {
      if (disposed || signal.aborted) return;
      state = next;
      legend.hidden = !next.showLegend;
      const direction = next.graphDirection ?? "bottom-to-top";
      for (const [value, button] of directionButtons) {
        button.setAttribute("aria-pressed", String(value === direction));
        button.classList.toggle("rm-on", value === direction);
      }
      renderLegend();
      renderGraph(next);
      renderReplayBar();
    },
    clear() {
      if (disposed || signal.aborted) return;
      drawn = "empty";
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      stopTimer();
      resize?.disconnect();
      root.remove();
    },
  };
}

export { isDone };
