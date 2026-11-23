/** Roadmap canvas: the module tree (nodes with module labels, pan + zoom), the flat graph (nodes and
 * arrows, pan + zoom).
 *
 * Controlled component: `render` receives the authoritative path and UI state;
 * clicks are reported through callbacks. All listeners belong to the signal.
 */
import type { LearningPath, PathModule, PathNode } from "../domain.ts";
import { locale, t } from "../i18n.ts";
import type { MessageKey } from "../i18n.ts";
import type { NodePrerequisites } from "../node-prerequisites.ts";
import { ICONS, setIcon, statusIcon } from "./icons.ts";
import { EMPTY_SNAPSHOT, edgeKey, growthPlan, snapshotOf } from "./graph-growth.ts";
import type { GraphSnapshot, GrowthPlan } from "./graph-growth.ts";
import type { GraphDirection } from "./roadmap-layout.ts";
import { buildDependencyGraph, isDone, layoutGraph, layoutRoadmap, moduleCounts } from "./roadmap-layout.ts";
import type { PlacedModule, PlacedNode, RoadmapLayout } from "./roadmap-layout.ts";
import { el } from "./dom.ts";

/** "tree": nodes with a label per module; "graph": nodes and arrows only. */
export type ViewMode = "tree" | "graph";

export interface CanvasState {
  readonly path: LearningPath;
  readonly selectedNodeId: string | null;
  readonly expandedModuleId: string | null;
  readonly view: ViewMode;
  readonly showOptional: boolean;
  /** The legend shows only when the side panel is closed, as in the mockups. */
  readonly showLegend: boolean;
  /** Which way the graph view runs. Absent: bottom to top. */
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
  root.append(viewport, controls, directionBar, legend, growStatus);
  host.append(root);

  let state: CanvasState | null = null;
  let layout: RoadmapLayout | null = null;
  let scale = 1;
  let tx = 0;
  let ty = 0;
  let placedViewKey: string | null = null;
  /** What was drawn last: a snapshot of the same roadmap and view, "empty" after clear(), or null at mount. */
  let drawn: { readonly pathId: string; readonly view: ViewMode; readonly snapshot: GraphSnapshot } | "empty" | null = null;
  let disposed = false;

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

  /** One node: a box in the tree view, a small pill in the graph view (`pill`). */
  const nodeButton = (placed: PlacedNode, selected: boolean, pill: boolean): HTMLButtonElement => {
    const { node } = placed;
    const button = el(document, "button", "rm-node");
    button.type = "button";
    button.dataset.nodeId = node.id;
    if (selected) button.classList.add("rm-sel", "rm-highlight");
    if (pill) button.classList.add("rm-pill");
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
    const icon = el(document, "span", "rm-node-icon");
    if (node.type === "checkpoint") {
      icon.classList.add("rm-flag");
      if (node.progression === "consolidated") icon.classList.add("rm-flag-done");
      setIcon(icon, ICONS.flag);
    } else {
      setIcon(icon, statusIcon(node.progression));
    }
    button.append(icon, el(document, "span", "rm-node-title", node.title));
    const tag = node.alternativeGroup ? t("mark.alternativeShort") : node.optional ? t("mark.optionalShort") : null;
    if (tag) button.append(el(document, "span", "rm-node-tag", tag));
    if (node.reviewMark) button.append(el(document, "span", "rm-node-review", t("mark.shortReviewShort")));
    const errors = unresolved(node);
    if (errors > 0) {
      const warn = el(document, "span", "rm-node-warn");
      warn.title = errors === 1 ? t("foot.error1") : t("foot.errors", { n: errors });
      setIcon(warn, ICONS.warn);
      button.append(warn);
    }
    button.title = node.title;
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

  /** A module's plain text label above its first column. It toggles the focus highlight. */
  const renderModule = (placed: PlacedModule): HTMLElement => {
    const { module } = placed;
    const label = el(document, "button", placed.expanded ? "rm-module-label rm-module-label-focus" : "rm-module-label", module.title);
    label.type = "button";
    label.dataset.moduleId = module.id;
    label.style.left = `${(placed.labelAt ?? placed).x}px`;
    label.style.top = `${(placed.labelAt ?? placed).y}px`;
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

  /** The pannable canvas: module labels in the tree view, bare nodes and arrows in the graph view. */
  const renderGraph = (current: CanvasState): void => {
    const withModules = current.view === "tree";
    const options = { showOptional: current.showOptional, prerequisites: current.prerequisites };
    layout = withModules ? layoutRoadmap(current.path, { ...options, expandedModuleId: current.expandedModuleId }) : layoutGraph(current.path, { ...options, direction: current.graphDirection ?? "bottom-to-top" });
    stage.style.width = `${layout.width}px`;
    stage.style.height = `${layout.height}px`;
    // Only items new since the last drawing animate; a re-render of the same graph animates nothing.
    const before =
      drawn === "empty" ? EMPTY_SNAPSHOT : drawn !== null && drawn.pathId === current.path.id && drawn.view === current.view ? drawn.snapshot : null;
    const plan = growthPlan(before, layout);
    drawn = { pathId: current.path.id, view: current.view, snapshot: snapshotOf(layout) };
    growStatus.textContent = plan.addedNodes > 0 ? t("graph.grew", { n: plan.addedNodes }) : "";
    const children: Element[] = [renderEdges(layout, plan)];
    for (const placed of layout.modules) children.push(renderModule(placed));
    for (const group of layout.groups) {
      const bracket = el(document, "div", "rm-alt-group");
      bracket.style.left = `${group.x}px`;
      bracket.style.top = `${group.y1}px`;
      bracket.style.height = `${group.y2 - group.y1}px`;
      bracket.title = t("mark.alternative");
      children.push(bracket);
    }
    for (const placed of layout.nodes) {
      const button = nodeButton(placed, placed.node.id === current.selectedNodeId, !withModules);
      const delay = plan.delays.get(placed.node.id);
      if (delay !== undefined) {
        button.classList.add("rm-grow");
        button.style.animationDelay = `${delay}ms`;
      }
      children.push(button);
    }
    stage.replaceChildren(...children);
    const viewKey = `${current.path.id}\u0000${current.view}`;
    const viewChanged = placedViewKey !== viewKey;
    placedViewKey = viewKey;
    if (viewChanged) {
      scale = 1;
      // Wait one frame so the viewport has its real size on first mount.
      const schedule = typeof requestAnimationFrame === "function" ? requestAnimationFrame : (run: () => void) => setTimeout(run, 0);
      schedule(() => {
        if (!disposed) focus(withModules ? current.expandedModuleId : null);
      });
    } else {
      clampPan();
      applyTransform();
    }
  };

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
      const chip = el(document, "span", `rm-legend-swatch rm-node${state === "consolidated" ? " rm-done" : state === "in_progress" ? " rm-prog" : state === "skipped" ? " rm-skip" : ""}`);
      setIcon(chip, statusIcon(state));
      span.append(chip, el(document, "span", undefined, t(key)));
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
      root.dataset.view = next.view;
      legend.hidden = !next.showLegend;
      directionBar.hidden = next.view !== "graph";
      const direction = next.graphDirection ?? "bottom-to-top";
      for (const [value, button] of directionButtons) {
        button.setAttribute("aria-pressed", String(value === direction));
        button.classList.toggle("rm-on", value === direction);
      }
      renderLegend();
      renderGraph(next);
    },
    clear() {
      if (disposed || signal.aborted) return;
      drawn = "empty";
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      resize?.disconnect();
      root.remove();
    },
  };
}

export { isDone };
