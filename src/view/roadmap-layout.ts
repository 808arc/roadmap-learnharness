/** Roadmap graph layout (pure, DOM-free).
 *
 * One view: every shown node is a dot with its title beside it, placed by dependency depth (LearnHarness's
 * inference depth) as a network, with an arrow from each prerequisite to its dependent. Depth runs bottom to
 * top by default, or left to right. The nodes of all modules share the network; each module shows as a small
 * label next to its first node and a colour on its nodes' titles (`moduleIndex`), never as a frame.
 * Alternatives (same alternativeGroup) share a depth and never depend on each other.
 */
import type { LearningPath, PathModule, PathNode } from "../domain.ts";
import { nodePrerequisites, type NodePrerequisites } from "../node-prerequisites.ts";
import { inferenceDepth } from "./graph-depth.ts";

/** Room under the network for the zoom control, the direction toggle and the legend overlay. */
export const PAD_BOTTOM = 150;
export const PAD = 40;
/** One node's cell: the dot at its left edge, the title after it. */
export const NODE_W = 168;
export const NODE_H = 24;
/** Left to right: row pitch. */
export const NODE_ROW = 40;
/** Horizontal room between two columns when running left to right, where the arrows run. */
export const COL_GAP = 64;
export const COL_W = NODE_W + COL_GAP;
/** The dot: its diameter, and the offset of its centre from the cell's left edge (the cell has 4px padding). */
export const DOT_D = 12;
export const DOT_X = 10;
/** Height of a module's label, which sits just above its first node. */
export const LABEL_H = 14;

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
  /** Prerequisite edges dropped to break cycles. */
  readonly ignored: readonly DependencyEdge[];
}

export interface PlacedNode {
  readonly node: PathNode;
  readonly moduleId: string;
  /** Index of the node's module in the roadmap: picks its colour. */
  readonly moduleIndex: number;
  readonly depth: number;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** A module's small label, placed just above the module's first node. `index` picks the module's colour. */
export interface PlacedModule {
  readonly module: PathModule;
  readonly index: number;
  /** The module the learner focused; its label is drawn highlighted and the view centres on it. */
  readonly expanded: boolean;
  /** Top-left of the label. */
  readonly x: number;
  readonly y: number;
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
  /** Bends between the start and the end (both excluded) when the straight line would cross another node. */
  readonly points?: readonly { readonly x: number; readonly y: number }[];
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

/** Alternatives are one unit for depth: the same column, and no arrows between them. */
export function unitKey(node: PathNode): string {
  return node.alternativeGroup ? `group:${node.alternativeGroup}` : `node:${node.id}`;
}

const pairKey = (from: string, to: string): string => `${from}\u0000${to}`;

/** Dependency depth for every shown node and the arrows between them.
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
  return { nodeIds: shown.map((node) => node.id), depth, edges, ignored };
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
const spreadHeight = (offsets: ReadonlyMap<string, number>): number =>
  offsets.size === 0 ? 0 : Math.max(...offsets.values()) + NODE_H;

/** Which way the graph view runs: depth as rows from the bottom up, or as columns from the left. */
export type GraphDirection = "bottom-to-top" | "left-to-right";

/** Vertical gap between two rows of nodes, and horizontal gap between nodes of one row, in bottom-to-top graphs. */
const ROW_GAP = 56;
const NODE_GAP = 24;
/** Bottom to top: the fewest nodes a row holds before its depth wraps into another row (more for larger roadmaps). */
const MIN_ROW_CAP = 5;

/** Arrows from each prerequisite to its dependent (both ends must be placed). Bottom to top: from the top of the
 * prerequisite's dot to the bottom of the dependent's dot. Left to right: from the end of the prerequisite's title
 * to the left of the dependent's dot. */
function placeEdges(graph: DependencyGraph, nodes: readonly PlacedNode[], direction: GraphDirection = "left-to-right"): Edge[] {
  const placedNodes = new Map(nodes.map((placed) => [placed.node.id, placed]));
  const edges: Edge[] = [];
  for (const edge of graph.edges) {
    const from = placedNodes.get(edge.from);
    const to = placedNodes.get(edge.to);
    if (!from || !to) continue;
    const ends =
      direction === "bottom-to-top"
        ? {
            x1: from.x + DOT_X,
            y1: from.y + (from.h - DOT_D) / 2,
            x2: to.x + DOT_X,
            y2: to.y + (to.h + DOT_D) / 2,
          }
        : { x1: from.x + drawnWidth(from) + 2, y1: from.y + from.h / 2, x2: to.x + DOT_X - DOT_D / 2, y2: to.y + to.h / 2 };
    const routed: Edge = {
      from: edge.from,
      to: edge.to,
      ...ends,
      dashed: Boolean(from.node.optional || to.node.optional),
    };
    // Left to right, the bends sit in the gaps between columns, whatever the title length.
    const half = (COL_W - NODE_W) / 2;
    const gutters = direction === "left-to-right" ? { a: from.x + from.w + half, b: to.x - half } : undefined;
    const points = routeAround(routed, nodes, direction, gutters);
    edges.push(points ? { ...routed, points } : routed);
  }
  return edges;
}

const ROUTE_MARGIN = 6;
/** Where a node's title starts (cell padding, dot, gap), and a generous width per title character. */
const TITLE_X = 23;
const CHAR_W = 7.5;

/** The part of a node's cell that is drawn: the dot, the title and its tags (estimated), never wider than the cell.
 * Arrows may pass through the empty rest of the cell; they never cross what is drawn. */
export function drawnWidth(placed: PlacedNode): number {
  const { node } = placed;
  const tag = node.alternativeGroup || node.optional ? 32 : 0;
  const marks = (node.reviewMark ? 48 : 0) + (node.errors.some((entry) => !entry.resolved) ? 20 : 0);
  return Math.min(placed.w, TITLE_X + node.title.length * CHAR_W + tag + marks);
}
interface Box { readonly x1: number; readonly y1: number; readonly x2: number; readonly y2: number }
type Pt = { readonly x: number; readonly y: number };

/** Does the segment a-b touch the box (slab clipping)? */
function segmentHits(a: Pt, b: Pt, box: Box): boolean {
  let t0 = 0;
  let t1 = 1;
  const d = { x: b.x - a.x, y: b.y - a.y };
  for (const [p, q, lo, hi] of [[d.x, a.x, box.x1, box.x2], [d.y, a.y, box.y1, box.y2]] as const) {
    if (p === 0) {
      if (q < lo || q > hi) return false;
    } else {
      const ta = (lo - q) / p;
      const tb = (hi - q) / p;
      t0 = Math.max(t0, Math.min(ta, tb));
      t1 = Math.min(t1, Math.max(ta, tb));
      if (t0 > t1) return false;
    }
  }
  return true;
}

/** The bends that take an arrow around the nodes it does not connect, or undefined when the straight line is clear
 * (or no clean route exists, in which case the straight line stays). The route leaves the prerequisite into the gutter
 * between layers, runs to a free lane between pills, and enters the dependent from the gutter on its side. */
function routeAround(
  edge: Edge,
  nodes: readonly PlacedNode[],
  direction: GraphDirection,
  gutters?: { readonly a: number; readonly b: number },
): Pt[] | undefined {
  const boxes = nodes
    .filter((n) => n.node.id !== edge.from && n.node.id !== edge.to)
    .map((n): Box => ({ x1: n.x - ROUTE_MARGIN, y1: n.y - ROUTE_MARGIN, x2: n.x + drawnWidth(n) + ROUTE_MARGIN, y2: n.y + n.h + ROUTE_MARGIN }));
  const start = { x: edge.x1, y: edge.y1 };
  const end = { x: edge.x2, y: edge.y2 };
  const clear = (path: readonly Pt[]): boolean => path.every((pt, i) => i === 0 || !boxes.some((box) => segmentHits(path[i - 1]!, pt, box)));
  if (clear([start, end])) return undefined;
  // p runs along depth, q across it; bottom to top: p = y, q = x. Left to right: p = x, q = y.
  const vertical = direction === "bottom-to-top";
  const P = (pt: Pt): number => (vertical ? pt.y : pt.x);
  const Q = (pt: Pt): number => (vertical ? pt.x : pt.y);
  const at = (p: number, q: number): Pt => (vertical ? { x: q, y: p } : { x: p, y: q });
  const gutter = vertical ? ROW_GAP / 2 : (COL_W - NODE_W) / 2;
  const sign = Math.sign(P(end) - P(start)) || 1;
  const pA = gutters?.a ?? P(start) + sign * gutter;
  const pB = gutters?.b ?? P(end) - sign * gutter;
  const lo = Math.min(pA, pB);
  const hi = Math.max(pA, pB);
  const spans = boxes
    .filter((box) => (vertical ? box.y2 > lo && box.y1 < hi : box.x2 > lo && box.x1 < hi))
    .map((box): [number, number] => (vertical ? [box.x1, box.x2] : [box.y1, box.y2]))
    .sort((a, b) => a[0] - b[0]);
  const lanes: number[] = [];
  let edgeOfBlocked = -Infinity;
  for (const [a, b] of spans) {
    if (edgeOfBlocked === -Infinity) lanes.push(a - 1);
    else if (a > edgeOfBlocked) lanes.push((edgeOfBlocked + a) / 2);
    edgeOfBlocked = Math.max(edgeOfBlocked, b);
  }
  if (edgeOfBlocked !== -Infinity) lanes.push(edgeOfBlocked + 1);
  // The straight line can clip a neighbour in its own row (or the target's) even when nothing lies between the
  // gutters: then running along the gutters to either end's own line is the route.
  lanes.push(Q(start), Q(end));
  const mid = (Q(start) + Q(end)) / 2;
  lanes.sort((a, b) => Math.abs(a - mid) - Math.abs(b - mid) || a - b);
  for (const lane of lanes) {
    const path = [start, at(pA, Q(start)), at(pA, lane), at(pB, lane), at(pB, Q(end)), end];
    if (clear(path)) return path.slice(1, -1).filter((pt, i, all) => i === 0 || pt.x !== all[i - 1]!.x || pt.y !== all[i - 1]!.y);
  }
  return undefined;
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

/** The graph: every shown node is a dot in the row (or column) of its dependency depth, placed as a network
 * (spreadColumns) with an arrow from each prerequisite to its dependent. Each module gets a small label at its
 * first node (the shallowest, then the lowest and leftmost). */
export function layoutGraph(
  path: LearningPath,
  options: {
    readonly showOptional: boolean;
    readonly prerequisites?: readonly NodePrerequisites[];
    readonly direction?: GraphDirection;
    readonly expandedModuleId?: string | null;
  },
): RoadmapLayout {
  const direction = options.direction ?? "bottom-to-top";
  const all = path.modules.flatMap((module) => module.nodes);
  const graph = cycleSafeGraph(buildDependencyGraph(path, options), all);
  const flatIndex = new Map(all.map((node, index) => [node.id, index]));
  const moduleOf = new Map(path.modules.flatMap((module, index) => module.nodes.map((node) => [node.id, { id: module.id, index }] as const)));
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
  const vertical = direction === "bottom-to-top";
  // Bottom to top, a depth wider than `rowCap` nodes wraps into several rows of that depth, so a shallow, wide
  // roadmap uses the height instead of one long band. Units (alternatives) are dealt whole, round robin, so each row
  // spans the depth's order and alternatives stay together. Left to right keeps one column per depth.
  const rowCap = Math.max(MIN_ROW_CAP, Math.ceil(Math.sqrt(graph.nodeIds.length)));
  const rows = new Map<number, PathNode[]>();
  const depthOfRow: number[] = [];
  for (const depth of [...cells.keys()].sort((a, b) => a - b)) {
    const list = cells.get(depth)!;
    const units: PathNode[][] = [];
    for (const node of list) {
      const last = units[units.length - 1];
      if (last && unitKey(last[0]!) === unitKey(node)) last.push(node);
      else units.push([node]);
    }
    const count = vertical ? Math.min(units.length, Math.ceil(list.length / rowCap)) : 1;
    const first = depthOfRow.length;
    for (let row = 0; row < count; row += 1) {
      rows.set(first + row, []);
      depthOfRow.push(depth);
    }
    units.forEach((unit, index) => rows.get(first + (index % count))!.push(...unit));
  }
  const rowCount = depthOfRow.length;
  const offsets = spreadColumns(rows, graph.edges, vertical ? NODE_W + NODE_GAP : NODE_ROW);
  const rowStep = NODE_H + ROW_GAP;
  const nodes: PlacedNode[] = [];
  for (const [row, list] of rows) {
    const depth = depthOfRow[row]!;
    for (const node of list) {
      const offset = offsets.get(node.id) ?? 0;
      const owner = moduleOf.get(node.id)!;
      nodes.push({
        node,
        moduleId: owner.id,
        moduleIndex: owner.index,
        depth,
        x: vertical ? PAD + offset : PAD + depth * COL_W,
        // Bottom to top: the first row of depth 0 is the bottom row. Left to right: the spread is the row; leave room for the labels above.
        y: vertical ? PAD + (rowCount - 1 - row) * rowStep : PAD + LABEL_H + offset,
        w: NODE_W,
        h: NODE_H,
      });
    }
  }
  const width = vertical
    ? PAD + (offsets.size > 0 ? Math.max(...offsets.values()) : 0) + NODE_W + PAD
    : PAD + (Math.max(columns, 1) - 1) * COL_W + NODE_W + PAD;
  const height = vertical
    ? PAD + (rowCount > 0 ? (rowCount - 1) * rowStep + NODE_H : NODE_H) + PAD + PAD_BOTTOM
    : PAD + LABEL_H + spreadHeight(offsets) + PAD + PAD_BOTTOM;

  const modules: PlacedModule[] = [];
  path.modules.forEach((module, index) => {
    const own = nodes.filter((placed) => placed.moduleId === module.id);
    if (own.length === 0) return;
    // The module's first node: the shallowest one, then the leftmost (bottom to top) or the topmost (left to right).
    const first = own.reduce((best, placed) =>
      placed.depth < best.depth ||
      (placed.depth === best.depth && (vertical ? placed.y > best.y || (placed.y === best.y && placed.x < best.x) : placed.y < best.y))
        ? placed
        : best,
    );
    modules.push({
      module,
      index,
      expanded: module.id === options.expandedModuleId,
      // Right of the arrow that leaves the dot, so the label never sits on a line from its own node.
      x: first.x + DOT_X + DOT_D / 2 + 4,
      y: first.y - LABEL_H - 1,
    });
  });
  return { width, height, modules, nodes, edges: placeEdges(graph, nodes, direction) };
}
