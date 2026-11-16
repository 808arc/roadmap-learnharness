/** Roadmap graph layout (pure, DOM-free).
 *
 * The roadmap grows bottom-up like the Learny mockup: the first module sits at
 * the bottom and the path's end at the top. Each module is a main-line node;
 * its nodes hang off a bracket to the right, interchangeable alternatives to the
 * left. One module at a time is expanded into a box with "In order",
 * "Additional" and "Consolidation" columns.
 */
import type { LearningPath, PathModule, PathNode } from "../domain.ts";

export const MAIN_W = 170;
export const MAIN_H = 34;
export const SUB_W = 200;
export const SUB_H = 28;
export const ROW = 34;
export const BRACKET = 22;
export const STUB = 24;
export const MODULE_GAP = 58;
export const PAD = 40;
/** Room under the first module for the zoom control and the legend overlay. */
export const PAD_BOTTOM = 150;
export const BOX_PAD = 12;
export const BOX_COL_GAP = 16;
export const BOX_HEAD = 41;
export const BOX_LABEL = 24;
export const BOX_W = BOX_PAD * 2 + SUB_W * 2 + BOX_COL_GAP;

export type NodeRole = "order" | "extra" | "consolidation";

export interface PlacedNode {
  readonly node: PathNode;
  readonly moduleId: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly side: "right" | "left" | "box";
}

export interface PlacedModule {
  readonly module: PathModule;
  readonly index: number;
  readonly expanded: boolean;
  readonly final: boolean;
  /** Main node (collapsed) or box (expanded) rectangle. */
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  /** Column labels inside an expanded box. */
  readonly labels: readonly { readonly text: NodeRole; readonly x: number; readonly y: number }[];
  /** First unresolved error shown under an expanded box. */
  readonly errorLine: { readonly x: number; readonly y: number } | null;
}

export interface Edge {
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
  readonly dashed?: boolean;
  readonly arrow?: boolean;
}

export interface RoadmapLayout {
  readonly width: number;
  readonly height: number;
  readonly modules: readonly PlacedModule[];
  readonly nodes: readonly PlacedNode[];
  readonly edges: readonly Edge[];
}

export function nodeRole(node: PathNode): NodeRole {
  if (node.type === "checkpoint") return "consolidation";
  if (node.optional || node.alternativeGroup) return "extra";
  return "order";
}

export function isDone(node: PathNode): boolean {
  return node.progression === "consolidated" || node.progression === "skipped";
}

/** Progress over required work: optional nodes are not counted, and a group of
 * interchangeable alternatives counts once (done when any member is done). */
export function progressCounts(nodes: readonly PathNode[]): { done: number; total: number } {
  let done = 0;
  let total = 0;
  const groups = new Map<string, boolean>();
  for (const node of nodes) {
    if (node.alternativeGroup) {
      groups.set(node.alternativeGroup, (groups.get(node.alternativeGroup) ?? false) || node.progression === "consolidated");
      continue;
    }
    if (node.optional) continue;
    total += 1;
    if (isDone(node)) done += 1;
  }
  for (const groupDone of groups.values()) {
    total += 1;
    if (groupDone) done += 1;
  }
  return { done, total };
}

export function moduleCounts(module: PathModule): { done: number; total: number } {
  return progressCounts(module.nodes);
}

/** Default expanded module: the selected node's, else the first unfinished one. */
export function defaultExpandedModule(path: LearningPath, selectedNodeId: string | null): string | null {
  if (selectedNodeId) {
    const owner = path.modules.find((module) => module.nodes.some((node) => node.id === selectedNodeId));
    if (owner) return owner.id;
  }
  const unfinished = path.modules.find((module) => module.nodes.some((node) => !node.optional && !isDone(node)));
  return (unfinished ?? path.modules[path.modules.length - 1])?.id ?? null;
}

interface Block {
  readonly module: PathModule;
  readonly index: number;
  readonly expanded: boolean;
  readonly height: number;
  readonly right: readonly PathNode[];
  readonly left: readonly PathNode[];
  readonly order: readonly PathNode[];
  readonly extra: readonly PathNode[];
  readonly consolidation: readonly PathNode[];
  readonly hasError: boolean;
}

const stackHeight = (count: number): number => (count === 0 ? 0 : (count - 1) * ROW + SUB_H);

export function layoutRoadmap(
  path: LearningPath,
  options: { readonly expandedModuleId: string | null; readonly showOptional: boolean },
): RoadmapLayout {
  const visible = (node: PathNode): boolean => options.showOptional || !node.optional;
  const blocks: Block[] = path.modules.map((module, index) => {
    const nodes = module.nodes.filter(visible);
    const expanded = module.id === options.expandedModuleId;
    const order = nodes.filter((node) => nodeRole(node) === "order");
    const extra = nodes.filter((node) => nodeRole(node) === "extra");
    const consolidation = nodes.filter((node) => nodeRole(node) === "consolidation");
    const hasError = module.nodes.some((node) => node.errors.some((entry) => !entry.resolved));
    if (expanded) {
      const leftRows = order.length;
      const rightRows =
        (extra.length > 0 ? extra.length : 0) +
        consolidation.length +
        (extra.length > 0 && consolidation.length > 0 ? 1 : 0);
      const rows = Math.max(leftRows, rightRows, 1);
      const height = BOX_HEAD + 10 + BOX_LABEL + stackHeight(rows) + BOX_PAD + (hasError ? 26 : 0);
      return { module, index, expanded, height, right: [], left: [], order, extra, consolidation, hasError };
    }
    const left = nodes.filter((node) => node.alternativeGroup);
    const right = nodes.filter((node) => !node.alternativeGroup);
    const height = Math.max(MAIN_H, stackHeight(right.length), stackHeight(left.length));
    return { module, index, expanded, height, right, left, order, extra, consolidation, hasError };
  });

  const anyLeft = blocks.some((block) => block.left.length > 0);
  const mainX = PAD + (anyLeft ? SUB_W + BRACKET + STUB : 0);
  const rightX = mainX + MAIN_W + BRACKET + STUB;
  const width = Math.max(mainX + BOX_W, rightX + SUB_W) + PAD;
  const height = PAD + PAD_BOTTOM + blocks.reduce((sum, block) => sum + block.height, 0) + MODULE_GAP * Math.max(0, blocks.length - 1);

  const modules: PlacedModule[] = [];
  const nodes: PlacedNode[] = [];
  const edges: Edge[] = [];
  const centerX = mainX + MAIN_W / 2;
  let bottom = height - PAD_BOTTOM;
  /** Top edge of the previous (lower) block's main-line shape: main node or box. */
  let previousLineTop: number | null = null;

  for (const block of blocks) {
    const top = bottom - block.height;
    const final = block.index === blocks.length - 1 && blocks.length > 1;
    if (block.expanded) {
      const labels: { text: NodeRole; x: number; y: number }[] = [];
      const leftX = mainX + BOX_PAD;
      const colX = leftX + SUB_W + BOX_COL_GAP;
      const firstRow = top + BOX_HEAD + 10 + BOX_LABEL;
      if (block.order.length > 0) labels.push({ text: "order", x: leftX, y: top + BOX_HEAD + 10 });
      block.order.forEach((node, row) => nodes.push({ node, moduleId: block.module.id, x: leftX, y: firstRow + row * ROW, w: SUB_W, side: "box" }));
      let rightRow = 0;
      if (block.extra.length > 0) {
        labels.push({ text: "extra", x: colX, y: top + BOX_HEAD + 10 });
        for (const node of block.extra) {
          nodes.push({ node, moduleId: block.module.id, x: colX, y: firstRow + rightRow * ROW, w: SUB_W, side: "box" });
          rightRow += 1;
        }
      }
      if (block.consolidation.length > 0) {
        const labelY = block.extra.length > 0 ? firstRow + rightRow * ROW + 8 : top + BOX_HEAD + 10;
        labels.push({ text: "consolidation", x: colX, y: labelY });
        if (block.extra.length > 0) rightRow += 1;
        for (const node of block.consolidation) {
          nodes.push({ node, moduleId: block.module.id, x: colX, y: firstRow + rightRow * ROW, w: SUB_W, side: "box" });
          rightRow += 1;
        }
      }
      const errorLine = block.hasError ? { x: leftX, y: top + block.height - BOX_PAD - 20 } : null;
      modules.push({ module: block.module, index: block.index, expanded: true, final, x: mainX, y: top, w: BOX_W, h: block.height, labels, errorLine });
    } else {
      const mainY = top + (block.height - MAIN_H) / 2;
      const cy = mainY + MAIN_H / 2;
      modules.push({ module: block.module, index: block.index, expanded: false, final, x: mainX, y: mainY, w: MAIN_W, h: MAIN_H, labels: [], errorLine: null });
      const place = (list: readonly PathNode[], side: "right" | "left"): void => {
        if (list.length === 0) return;
        const stackTop = cy - stackHeight(list.length) / 2;
        const anchorX = side === "right" ? mainX + MAIN_W : mainX;
        const busX = side === "right" ? anchorX + BRACKET : anchorX - BRACKET;
        const nodeX = side === "right" ? rightX : mainX - BRACKET - STUB - SUB_W;
        const tipX = side === "right" ? rightX : nodeX + SUB_W;
        edges.push({ x1: anchorX, y1: cy, x2: busX, y2: cy });
        const centers = list.map((_, row) => stackTop + row * ROW + SUB_H / 2);
        if (list.length > 1) edges.push({ x1: busX, y1: centers[0]!, x2: busX, y2: centers[centers.length - 1]! });
        list.forEach((node, row) => {
          nodes.push({ node, moduleId: block.module.id, x: nodeX, y: stackTop + row * ROW, w: SUB_W, side });
          edges.push({ x1: busX, y1: centers[row]!, x2: tipX, y2: centers[row]!, dashed: Boolean(node.optional) });
        });
      };
      place(block.right, "right");
      place(block.left, "left");
    }
    // Main line: from the lower module's shape up to this module's shape, arrow at the upper end.
    const placedShape = modules[modules.length - 1]!;
    if (previousLineTop !== null) {
      edges.push({ x1: centerX, y1: previousLineTop, x2: centerX, y2: placedShape.y + placedShape.h, arrow: true });
    }
    previousLineTop = placedShape.y;
    bottom = top - MODULE_GAP;
  }

  return { width, height, modules, nodes, edges };
}
