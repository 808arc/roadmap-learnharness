/** Roadmap graph layout (pure, DOM-free).
 *
 * Nodes sit in columns by dependency depth: a node is one column right of its
 * deepest prerequisite, and an arrow runs from each prerequisite to each node
 * that depends on it. The nodes of all modules share the columns (one network);
 * a module shows as a text label above its first column. Any number of nodes
 * can share a column: they stack in rows.
 *
 * Alternatives (same alternativeGroup) share a column and are bracketed. They
 * depend on the same prerequisites and never on each other.
 */
import type { LearningPath, PathModule, PathNode } from "../domain.ts";
import { nodePrerequisites, type NodePrerequisites } from "../node-prerequisites.ts";
import { inferenceDepth } from "./graph-depth.ts";

export const SUB_W = 200;
export const SUB_H = 28;
export const ROW = 34;
/** Horizontal room between two columns, where the arrows run. */
export const COL_GAP = 64;
export const COL_W = SUB_W + COL_GAP;
export const PAD = 40;
/** Room under the first module for the zoom control and the legend overlay. */
export const PAD_BOTTOM = 150;
export const FRAME_PAD = 12;
/** Height of a module's text label above its first column. */
export const LABEL_H = 18;
/** Clear space between a module label and the bottom of any node above it in the same column. */
export const LABEL_ROOM = 26;
/** Label rectangle used for the clearance rules: about 8px per character, 16px tall. */
export const LABEL_CHAR_W = 8;
export const LABEL_BOX_H = 16;
/** Distance from a node's left edge to its alternatives bracket. */
export const GROUP_BRACKET = 8;
/** Graph view: each node is a small pill, stacked with generous room between rows. */
export const PILL_W = 168;
export const PILL_H = 24;
export const PILL_ROW = 40;

/** Size of one node cell: row pitch, width and height. */
interface NodeSize {
  readonly row: number;
  readonly w: number;
  readonly h: number;
}
const TREE_SIZE: NodeSize = { row: ROW, w: SUB_W, h: SUB_H };
const PILL_SIZE: NodeSize = { row: PILL_ROW, w: PILL_W, h: PILL_H };

export type NodeRole = "order" | "extra" | "consolidation";

export interface DependencyEdge {
  /** The prerequisite; the arrow starts here. */
  readonly from: string;
  /** The dependent node; the arrow ends here. */
  readonly to: string;
}

export interface DependencyGraph {
  /** Ids of the shown nodes, in path order. */
  readonly nodeIds: readonly string[];
  /** Column of each shown node: the length of its longest prerequisite chain. */
  readonly depth: ReadonlyMap<string, number>;
  /** Arrows between shown nodes. Hidden optional nodes are passed through. */
  readonly edges: readonly DependencyEdge[];
  /** Tree parent of each shown node: its deepest prerequisite (earliest in path order on a tie), or null for a root. */
  readonly parent: ReadonlyMap<string, string | null>;
  /** Prerequisite edges dropped to break cycles. */
  readonly ignored: readonly DependencyEdge[];
}

export interface PlacedNode {
  readonly node: PathNode;
  readonly moduleId: string;
  readonly depth: number;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface PlacedModule {
  readonly module: PathModule;
  readonly index: number;
  /** The module the learner focused; drawn highlighted, and centred by focus. */
  readonly expanded: boolean;
  readonly final: boolean;
  /** Tree: top-left of the module's text label (above its first column). w and h are 0: no frame is drawn. */
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  /** Tree: where the label is drawn (top-left); same as x and y. */
  readonly labelAt?: { readonly x: number; readonly y: number };
  /** Always null: the tree draws no frame to hold an error line. */
  readonly errorLine: { readonly x: number; readonly y: number } | null;
}

export interface Edge {
  readonly from: string;
  readonly to: string;
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
  /** Dashed when either end is optional. */
  readonly dashed: boolean;
}

/** A bracket around interchangeable alternatives that sit together in one module. */
export interface AlternativeGroup {
  readonly alternativeGroup: string;
  readonly moduleId: string;
  readonly x: number;
  readonly y1: number;
  readonly y2: number;
}

export interface RoadmapLayout {
  readonly width: number;
  readonly height: number;
  readonly modules: readonly PlacedModule[];
  readonly nodes: readonly PlacedNode[];
  readonly edges: readonly Edge[];
  readonly groups: readonly AlternativeGroup[];
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

/** Alternatives are one unit for depth: the same column, and no arrows between them. */
export function unitKey(node: PathNode): string {
  return node.alternativeGroup ? `group:${node.alternativeGroup}` : `node:${node.id}`;
}

const pairKey = (from: string, to: string): string => `${from}\u0000${to}`;

/** Dependency depth for every shown node, the arrows between them and the tree parents.
 *
 * Prerequisites come from `prerequisites` (default: nodePrerequisites, which uses each node's own
 * prerequisites, then module order).
 * A hidden optional node is passed through: its prerequisites stand in for it.
 *
 * Cycles: units are walked depth-first in path order, following prerequisites. When the
 * walk reaches a unit that is still open on the walk, the prerequisite edge it was
 * reached by is the one that closes the cycle, and it is ignored (recorded in `ignored`).
 * The result depends only on the path order, so the same roadmap always gets the same layout. */
export function buildDependencyGraph(
  path: LearningPath,
  options: { readonly showOptional: boolean; readonly prerequisites?: readonly NodePrerequisites[] },
): DependencyGraph {
  const all = path.modules.flatMap((module) => module.nodes);
  const flatIndex = new Map(all.map((node, index) => [node.id, index]));
  const prerequisiteOf = new Map(
    (options.prerequisites ?? nodePrerequisites(all)).map((entry) => [entry.nodeId, entry.prerequisiteIds]),
  );
  const shown = all.filter((node) => options.showOptional || !node.optional);
  const shownIds = new Set(shown.map((node) => node.id));
  const unitOf = new Map(shown.map((node) => [node.id, unitKey(node)]));

  /** Shown prerequisites of a node, passing through hidden ones; path order. */
  const shownPrerequisites = (id: string): string[] => {
    const found = new Set<string>();
    const seen = new Set<string>([id]);
    const queue = [...(prerequisiteOf.get(id) ?? [])];
    while (queue.length > 0) {
      const next = queue.shift()!;
      if (seen.has(next)) continue;
      seen.add(next);
      if (shownIds.has(next)) found.add(next);
      else queue.push(...(prerequisiteOf.get(next) ?? []));
    }
    return [...found].sort((a, b) => flatIndex.get(a)! - flatIndex.get(b)!);
  };

  const nodePrereqs = new Map<string, string[]>();
  const unitPrereqs = new Map<string, string[]>();
  for (const node of shown) {
    const own = shownPrerequisites(node.id);
    nodePrereqs.set(node.id, own);
    const unit = unitOf.get(node.id)!;
    const list = unitPrereqs.get(unit) ?? [];
    unitPrereqs.set(unit, list);
    for (const prerequisite of own) {
      const prerequisiteUnit = unitOf.get(prerequisite)!;
      if (prerequisiteUnit !== unit && !list.includes(prerequisiteUnit)) list.push(prerequisiteUnit);
    }
  }

  // Iterative depth-first walk over units; a back edge is ignored (see above).
  const state = new Map<string, "open" | "done">();
  const depthOfUnit = new Map<string, number>();
  const ignoredUnits = new Set<string>();
  for (const start of unitPrereqs.keys()) {
    if (state.has(start)) continue;
    state.set(start, "open");
    const frames: { unit: string; next: number }[] = [{ unit: start, next: 0 }];
    while (frames.length > 0) {
      const frame = frames[frames.length - 1]!;
      const prerequisites = unitPrereqs.get(frame.unit) ?? [];
      if (frame.next < prerequisites.length) {
        const prerequisite = prerequisites[frame.next]!;
        frame.next += 1;
        const seenState = state.get(prerequisite);
        if (seenState === "open") {
          // The prerequisite is still open on this walk, so it depends on frame.unit: this edge closes the cycle.
          ignoredUnits.add(pairKey(prerequisite, frame.unit));
        } else if (seenState === undefined) {
          state.set(prerequisite, "open");
          frames.push({ unit: prerequisite, next: 0 });
        }
        continue;
      }
      let depth = 0;
      for (const prerequisite of prerequisites) {
        if (ignoredUnits.has(pairKey(prerequisite, frame.unit))) continue;
        depth = Math.max(depth, (depthOfUnit.get(prerequisite) ?? 0) + 1);
      }
      depthOfUnit.set(frame.unit, depth);
      state.set(frame.unit, "done");
      frames.pop();
    }
  }

  const edges: DependencyEdge[] = [];
  const ignored: DependencyEdge[] = [];
  for (const node of shown) {
    const unit = unitOf.get(node.id)!;
    for (const prerequisite of nodePrereqs.get(node.id) ?? []) {
      const prerequisiteUnit = unitOf.get(prerequisite)!;
      if (prerequisiteUnit === unit) continue;
      const edge = { from: prerequisite, to: node.id };
      if (ignoredUnits.has(pairKey(prerequisiteUnit, unit))) ignored.push(edge);
      else edges.push(edge);
    }
  }

  const depth = new Map(shown.map((node) => [node.id, depthOfUnit.get(unitOf.get(node.id)!) ?? 0]));
  // The deepest kept prerequisite sits exactly one level up, so the tree indents one level per depth.
  const incomingByUnit = new Map<string, DependencyEdge[]>();
  for (const edge of edges) {
    const unit = unitOf.get(edge.to)!;
    incomingByUnit.set(unit, [...(incomingByUnit.get(unit) ?? []), edge]);
  }
  const parent = new Map<string, string | null>();
  for (const node of shown) {
    let best: string | null = null;
    for (const edge of incomingByUnit.get(unitOf.get(node.id)!) ?? []) {
      if (best === null) best = edge.from;
      else if (depth.get(edge.from)! > depth.get(best)!) best = edge.from;
      else if (depth.get(edge.from) === depth.get(best) && flatIndex.get(edge.from)! < flatIndex.get(best)!) best = edge.from;
    }
    parent.set(node.id, best);
  }

  return { nodeIds: shown.map((node) => node.id), depth, edges, parent, ignored };
}

/** Least-squares nondecreasing fit of `values` (pool adjacent violators). */
function isotonic(values: readonly number[]): number[] {
  const blocks: { sum: number; count: number }[] = [];
  for (const value of values) {
    blocks.push({ sum: value, count: 1 });
    while (blocks.length > 1) {
      const last = blocks[blocks.length - 1]!;
      const previous = blocks[blocks.length - 2]!;
      if (previous.sum / previous.count <= last.sum / last.count) break;
      previous.sum += last.sum;
      previous.count += last.count;
      blocks.pop();
    }
  }
  return blocks.flatMap((block) => Array.from({ length: block.count }, () => block.sum / block.count));
}

/** Sweeps over the columns: each sweep left to right (towards prerequisites), then right to left (towards dependents). */
const SPREAD_SWEEPS = 4;

/** Network placement of one set of depth columns (layered-graph method).
 *
 * Each column is reordered and every node gets a vertical offset near its neighbours on the arrows that touch it,
 * so a node sits centred on its prerequisites or dependents, branches fan out and merges converge. Nodes in a
 * column keep their order and stay at least `pitch` apart: each column is packed with the least-squares fit that
 * keeps both (pool adjacent violators). Alternatives of one unit move as one key, so they stay adjacent.
 * Arrows whose ends are not both in `cells` are ignored. Reorders the lists in `cells`; returns offsets from 0.
 * Deterministic: the same columns and arrows always give the same placement. */
export function spreadColumns(
  cells: ReadonlyMap<number, PathNode[]>,
  edges: readonly DependencyEdge[],
  pitch: number,
): Map<string, number> {
  const depths = [...cells.keys()].sort((a, b) => a - b);
  const y = new Map<string, number>();
  for (const depth of depths) cells.get(depth)!.forEach((node, row) => y.set(node.id, row * pitch));
  const prerequisites = new Map<string, string[]>();
  const dependents = new Map<string, string[]>();
  for (const edge of edges) {
    if (!y.has(edge.from) || !y.has(edge.to)) continue;
    prerequisites.set(edge.to, [...(prerequisites.get(edge.to) ?? []), edge.from]);
    dependents.set(edge.from, [...(dependents.get(edge.from) ?? []), edge.to]);
  }

  const place = (list: PathNode[], neighbours: ReadonlyMap<string, readonly string[]>): void => {
    const desired = new Map<string, number>();
    for (const node of list) {
      const near = neighbours.get(node.id) ?? [];
      desired.set(node.id, near.length > 0 ? near.reduce((sum, id) => sum + y.get(id)!, 0) / near.length : y.get(node.id)!);
    }
    const index = new Map(list.map((node, row) => [node.id, row] as const));
    const unitSum = new Map<string, { sum: number; count: number; first: number }>();
    for (const node of list) {
      const key = unitKey(node);
      const entry = unitSum.get(key) ?? { sum: 0, count: 0, first: index.get(node.id)! };
      unitSum.set(key, { sum: entry.sum + desired.get(node.id)!, count: entry.count + 1, first: entry.first });
    }
    const unitOf = (node: PathNode) => unitSum.get(unitKey(node))!;
    list.sort((a, b) => {
      const ua = unitOf(a);
      const ub = unitOf(b);
      return ua.sum / ua.count - ub.sum / ub.count || ua.first - ub.first || index.get(a.id)! - index.get(b.id)!;
    });
    const fitted = isotonic(list.map((node, row) => desired.get(node.id)! - row * pitch));
    list.forEach((node, row) => y.set(node.id, fitted[row]! + row * pitch));
  };

  for (let sweep = 0; sweep < SPREAD_SWEEPS; sweep += 1) {
    for (const depth of depths) place(cells.get(depth)!, prerequisites);
    for (const depth of [...depths].reverse()) place(cells.get(depth)!, dependents);
  }
  const top = y.size > 0 ? Math.min(...y.values()) : 0;
  return new Map([...y].map(([id, offset]) => [id, offset - top] as const));
}

/** Height of a spread: from offset 0 to the bottom of the lowest node. */
const spreadHeight = (offsets: ReadonlyMap<string, number>, size: NodeSize): number =>
  offsets.size === 0 ? 0 : Math.max(...offsets.values()) + size.h;

export function layoutRoadmap(
  path: LearningPath,
  options: { readonly expandedModuleId: string | null; readonly showOptional: boolean; readonly prerequisites?: readonly NodePrerequisites[] },
): RoadmapLayout {
  const graph = buildDependencyGraph(path, options);
  const all = path.modules.flatMap((module) => module.nodes);
  const flatIndex = new Map(all.map((node, index) => [node.id, index]));
  const firstOfUnit = new Map<string, number>();
  for (const node of all) {
    const key = unitKey(node);
    if (!firstOfUnit.has(key)) firstOfUnit.set(key, flatIndex.get(node.id)!);
  }
  const columns = graph.nodeIds.length === 0 ? 0 : Math.max(...graph.depth.values()) + 1;
  const moduleOf = new Map(path.modules.flatMap((module) => module.nodes.map((node) => [node.id, module.id] as const)));

  // One network: the nodes of all modules share the columns and one spread.
  const cells = new Map<number, PathNode[]>();
  for (const node of all) {
    const depth = graph.depth.get(node.id);
    if (depth === undefined) continue;
    cells.set(depth, [...(cells.get(depth) ?? []), node]);
  }
  for (const list of cells.values()) {
    list.sort((a, b) => firstOfUnit.get(unitKey(a))! - firstOfUnit.get(unitKey(b))! || flatIndex.get(a.id)! - flatIndex.get(b.id)!);
  }
  const offsets = spreadColumns(cells, graph.edges, ROW);
  const right = PAD + FRAME_PAD + (Math.max(columns, 1) - 1) * COL_W + SUB_W;
  const width = right + FRAME_PAD + PAD;
  const placed = placeCells(cells, PAD + LABEL_H, moduleOf, offsets);

  // Each module's label sits above its first column: the leftmost column it has nodes in, at its topmost node there.
  // Where a node sits above that node, push the label's node and the ones below it down so the label has room.
  const labelNodeOf = new Map<string, PlacedNode>();
  for (const module of path.modules) {
    const own = placed.nodes.filter((entry) => entry.moduleId === module.id);
    if (own.length === 0) continue;
    const left = Math.min(...own.map((entry) => entry.x));
    labelNodeOf.set(module.id, own.filter((entry) => entry.x === left).reduce((best, entry) => (entry.y < best.y ? entry : best)));
  }
  const labelNodes = new Set(labelNodeOf.values());
  const shiftOf = new Map<PlacedNode, number>();
  const byColumn = new Map<number, PlacedNode[]>();
  for (const node of placed.nodes) byColumn.set(node.x, [...(byColumn.get(node.x) ?? []), node]);
  let extra = 0;
  const columnShifts = new Map<number, { y: number; shift: number }[]>();
  for (const [x, column] of byColumn) {
    column.sort((a, b) => a.y - b.y);
    let shift = 0;
    const steps: { y: number; shift: number }[] = [];
    column.forEach((node, row) => {
      if (row > 0 && labelNodes.has(node)) {
        const above = column[row - 1]!;
        const gap = node.y + shift - (above.y + (shiftOf.get(above) ?? 0)) - above.h;
        shift += Math.max(0, LABEL_ROOM + LABEL_H - gap);
      }
      shiftOf.set(node, shift);
      steps.push({ y: node.y, shift });
    });
    columnShifts.set(x, steps);
    extra = Math.max(extra, shift);
  }
  const nodes: PlacedNode[] = placed.nodes.map((node) => ({ ...node, y: node.y + (shiftOf.get(node) ?? 0) }));
  const shiftAt = (x: number, y: number): number => columnShifts.get(x + GROUP_BRACKET)?.find((step) => step.y === y)?.shift ?? 0;
  const groups = placed.groups.map((group) => ({
    ...group,
    y1: group.y1 + shiftAt(group.x, group.y1),
    y2: group.y2 + shiftAt(group.x, group.y2 - SUB_H),
  }));
  const height = PAD + LABEL_H + spreadHeight(offsets, TREE_SIZE) + extra + PAD + PAD_BOTTOM;

  const modules: PlacedModule[] = path.modules.map((module, index) => {
    const anchor = nodes[placed.nodes.indexOf(labelNodeOf.get(module.id)!)];
    const x = anchor ? anchor.x : PAD + FRAME_PAD;
    const y = (anchor ? anchor.y : PAD + LABEL_H) - LABEL_H;
    return {
      module,
      index,
      expanded: module.id === options.expandedModuleId,
      final: index === path.modules.length - 1 && path.modules.length > 1,
      x,
      y,
      w: 0,
      h: 0,
      labelAt: { x, y },
      errorLine: null,
    };
  });

  const edges = placeEdges(graph, nodes);
  return { width, height, modules, nodes, edges, groups };
}

/** Which way the graph view runs: depth as rows from the bottom up, or as columns from the left. */
export type GraphDirection = "bottom-to-top" | "left-to-right";

/** Vertical gap between two rows of pills, and horizontal gap between pills of one row, in bottom-to-top graphs. */
const ROW_GAP = 56;
const PILL_GAP = 24;

/** Arrows from each prerequisite's right edge to its dependent's left edge (both ends must be placed). */
function placeEdges(graph: DependencyGraph, nodes: readonly PlacedNode[], direction: GraphDirection = "left-to-right"): Edge[] {
  const placedNodes = new Map(nodes.map((placed) => [placed.node.id, placed]));
  const edges: Edge[] = [];
  for (const edge of graph.edges) {
    const from = placedNodes.get(edge.from);
    const to = placedNodes.get(edge.to);
    if (!from || !to) continue;
    // Left to right: right edge to left edge. Bottom to top: top edge of the prerequisite to the bottom edge of the dependent.
    const ends =
      direction === "bottom-to-top"
        ? { x1: from.x + from.w / 2, y1: from.y, x2: to.x + to.w / 2, y2: to.y + to.h }
        : { x1: from.x + from.w, y1: from.y + from.h / 2, x2: to.x, y2: to.y + to.h / 2 };
    edges.push({
      from: edge.from,
      to: edge.to,
      ...ends,
      dashed: Boolean(from.node.optional || to.node.optional),
    });
  }
  return edges;
}

/** Place each column's nodes at `top` plus their spread offset (spreadColumns). Alternatives of one unit stay
 * adjacent (ordered by the spread); each run of two or more members of one alternative group gets a bracket. */
function placeCells(
  cells: ReadonlyMap<number, readonly PathNode[]>,
  top: number,
  moduleOf: ReadonlyMap<string, string>,
  offsets: ReadonlyMap<string, number>,
  size: NodeSize = TREE_SIZE,
): { nodes: PlacedNode[]; groups: AlternativeGroup[] } {
  const nodes: PlacedNode[] = [];
  const groups: AlternativeGroup[] = [];
  for (const [depth, list] of cells) {
    const x = PAD + FRAME_PAD + depth * COL_W;
    const yOf = (row: number): number => top + (offsets.get(list[row]!.id) ?? row * size.row);
    list.forEach((node, row) => {
      nodes.push({ node, moduleId: moduleOf.get(node.id)!, depth, x, y: yOf(row), w: size.w, h: size.h });
    });
    // Bracket each run of two or more adjacent members of one alternative group.
    let runStart = 0;
    for (let row = 1; row <= list.length; row += 1) {
      if (row < list.length && unitKey(list[row]!) === unitKey(list[runStart]!)) continue;
      const first = list[runStart]!;
      if (first.alternativeGroup && row - runStart >= 2) {
        groups.push({
          alternativeGroup: first.alternativeGroup,
          moduleId: moduleOf.get(first.id)!,
          x: x - GROUP_BRACKET,
          y1: yOf(runStart),
          y2: yOf(row - 1) + size.h,
        });
      }
      runStart = row;
    }
  }
  return { nodes, groups };
}

/** The graph view's depth rule (LearnHarness's inference depth, graph-depth.ts) over alternative units.
 * Arrows that a cycle closes get no column step, so they are not drawn: cycle members share a column. */
function cycleSafeGraph(graph: DependencyGraph, all: readonly PathNode[]): DependencyGraph {
  const unitById = new Map(all.map((node) => [node.id, unitKey(node)] as const));
  const unitDepth = inferenceDepth(
    [...new Set(graph.nodeIds.map((id) => unitById.get(id)!))],
    [...graph.edges, ...graph.ignored].map((edge) => ({ from: unitById.get(edge.from)!, to: unitById.get(edge.to)! })),
  );
  const depth = new Map(graph.nodeIds.map((id) => [id, unitDepth.get(unitById.get(id)!) ?? 0] as const));
  const edges = graph.edges.filter((edge) => depth.get(edge.from)! < depth.get(edge.to)!);
  return { ...graph, depth, edges };
}

/** The flat graph (no module frames, no brackets): every shown node is a pill in the column of its
 * dependency depth, placed as a network (spreadColumns) with arrows from each prerequisite to its dependent.
 * `modules` and `groups` are empty; each node keeps its module id for selection. */
export function layoutGraph(
  path: LearningPath,
  options: { readonly showOptional: boolean; readonly prerequisites?: readonly NodePrerequisites[]; readonly direction?: GraphDirection },
): RoadmapLayout {
  const direction = options.direction ?? "bottom-to-top";
  const graph = cycleSafeGraph(buildDependencyGraph(path, options), path.modules.flatMap((module) => module.nodes));
  const all = path.modules.flatMap((module) => module.nodes);
  const flatIndex = new Map(all.map((node, index) => [node.id, index]));
  const moduleOf = new Map(path.modules.flatMap((module) => module.nodes.map((node) => [node.id, module.id] as const)));
  const firstOfUnit = new Map<string, number>();
  for (const node of all) {
    const key = unitKey(node);
    if (!firstOfUnit.has(key)) firstOfUnit.set(key, flatIndex.get(node.id)!);
  }
  const columns = graph.nodeIds.length === 0 ? 0 : Math.max(...graph.depth.values()) + 1;
  const cells = new Map<number, PathNode[]>();
  for (const node of all) {
    const depth = graph.depth.get(node.id);
    if (depth === undefined) continue;
    cells.set(depth, [...(cells.get(depth) ?? []), node]);
  }
  for (const list of cells.values()) {
    list.sort((a, b) => firstOfUnit.get(unitKey(a))! - firstOfUnit.get(unitKey(b))! || flatIndex.get(a.id)! - flatIndex.get(b.id)!);
  }
  if (direction === "bottom-to-top") {
    // The same layered placement, turned: depth is the row (depth 0 at the bottom), the spread is the position in the row.
    const offsets = spreadColumns(cells, graph.edges, PILL_W + PILL_GAP);
    const rowStep = PILL_H + ROW_GAP;
    const nodes: PlacedNode[] = [];
    for (const [depth, list] of cells) {
      for (const node of list) {
        nodes.push({
          node,
          moduleId: moduleOf.get(node.id)!,
          depth,
          x: PAD + FRAME_PAD + (offsets.get(node.id) ?? 0),
          y: PAD + (columns - 1 - depth) * rowStep,
          w: PILL_W,
          h: PILL_H,
        });
      }
    }
    const span = offsets.size > 0 ? Math.max(...offsets.values()) : 0;
    const width = PAD + FRAME_PAD + span + PILL_W + FRAME_PAD + PAD;
    const height = PAD + (columns > 0 ? (columns - 1) * rowStep + PILL_H : PILL_H) + PAD + PAD_BOTTOM;
    return { width, height, modules: [], nodes, edges: placeEdges(graph, nodes, direction), groups: [] };
  }
  const offsets = spreadColumns(cells, graph.edges, PILL_ROW);
  const right = columns > 0 ? PAD + FRAME_PAD + (columns - 1) * COL_W + PILL_W : PAD + FRAME_PAD + PILL_W;
  const width = right + FRAME_PAD + PAD;
  const height = PAD + spreadHeight(offsets, PILL_SIZE) + PAD + PAD_BOTTOM;
  const placed = placeCells(cells, PAD, moduleOf, offsets, PILL_SIZE);
  const edges = placeEdges(graph, placed.nodes);
  // Pills carry the alternative tag themselves; no brackets are drawn in the graph view.
  return { width, height, modules: [], nodes: placed.nodes, edges, groups: [] };
}
