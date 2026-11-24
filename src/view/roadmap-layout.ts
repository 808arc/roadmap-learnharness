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
export const COL_GAP = 40;
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

/** Which way the graph view runs: depth as rows from the bottom up, or as columns from the left. */
export type GraphDirection = "bottom-to-top" | "left-to-right";

/** Vertical gap between two rows of nodes, and horizontal gap between nodes of one row, in bottom-to-top graphs. */
const ROW_GAP = 28;
const NODE_GAP = 24;
/** Left to right: free space kept between two nodes of one column. */
const COL_NODE_GAP = NODE_ROW - NODE_H;
/** Bottom to top: the fewest nodes a row holds before its depth wraps into another row (more for larger roadmaps). */
const MIN_ROW_CAP = 5;
/** Left to right: the fewest nodes a column holds before its depth wraps into another column. */
const MIN_COL_CAP = 8;
/** Width reserved for the lane of an arrow that passes through a layer without a node there. */
const LANE_W = 8;

// ---------------------------------------------------------------------------------------------------------------------
// Layered arrangement: order each layer by the barycenter of its neighbours, then place the nodes evenly.
// A layer is a row (bottom to top) or a column (left to right). An arrow that spans more than one layer gets an
// invisible dummy slot in every layer it passes, so ordering and placement leave a free lane for it.

/** One slot in a layer: a node, or the lane of a long arrow. `size` is its extent across the layer. */
interface Slot {
  readonly id: string;
  /** Alternatives share a unit and stay adjacent; a lane is its own unit. */
  readonly unit: string;
  readonly size: number;
  /** Free space kept around it; two neighbours keep the mean of their two gaps between them. */
  readonly gap: number;
  readonly node?: PathNode;
}

interface LayerLink {
  /** A slot in layer k. */
  readonly from: string;
  /** A slot in layer k + 1. */
  readonly to: string;
}

/** Sweeps of the ordering: each is one pass towards the dependents and one back towards the prerequisites. */
const ORDER_SWEEPS = 12;
/** Sweeps of the placement before the final passes that centre each slot between both sides. */
const PLACE_SWEEPS = 4;
const FINAL_PASSES = 4;
/** How strongly a slot is held towards the middle line, counted as that many extra neighbours. */
const HOME_PULL = 2;

interface Arranged {
  readonly order: Slot[][];
  /** Centre of each slot across its layer, from 0. */
  readonly centre: ReadonlyMap<string, number>;
  /** Extent across: from the lowest slot edge to the highest. */
  readonly span: number;
}

/** Layered arrangement of `layers` (slots in the given order as the starting point) joined by `links` between
 * consecutive layers. Deterministic: the same input always gives the same arrangement. */
function arrange(layers: readonly (readonly Slot[])[], links: readonly LayerLink[]): Arranged {
  const order = layers.map((layer) => [...layer]);
  const before = new Map<string, string[]>();
  const after = new Map<string, string[]>();
  for (const link of links) {
    before.set(link.to, [...(before.get(link.to) ?? []), link.from]);
    after.set(link.from, [...(after.get(link.from) ?? []), link.to]);
  }
  const pos = new Map<string, number>();
  const refresh = (): void => order.forEach((layer) => layer.forEach((slot, index) => pos.set(slot.id, index)));
  refresh();
  const unitCount = new Map<string, number>();
  for (const layer of order) for (const slot of layer) unitCount.set(slot.unit, (unitCount.get(slot.unit) ?? 0) + 1);

  // Links per layer pair, so crossings are counted without scanning every link.
  const layerOf = new Map<string, number>();
  order.forEach((layer, k) => layer.forEach((slot) => layerOf.set(slot.id, k)));
  const linksAt = order.map((_, k) => links.filter((link) => layerOf.get(link.from) === k));
  const crossingsAt = (k: number): number => {
    const pairs = linksAt[k]!.map((link) => [pos.get(link.from)!, pos.get(link.to)!] as const);
    let count = 0;
    for (let i = 0; i < pairs.length; i += 1) {
      for (let j = i + 1; j < pairs.length; j += 1) {
        const a = pairs[i]!;
        const b = pairs[j]!;
        if ((a[0] - b[0]) * (a[1] - b[1]) < 0) count += 1;
      }
    }
    return count;
  };
  const totalCrossings = (): number => order.reduce((sum, _layer, k) => sum + (k < order.length - 1 ? crossingsAt(k) : 0), 0);

  const reorder = (k: number, neighbours: ReadonlyMap<string, readonly string[]>): void => {
    const layer = order[k]!;
    const desired = new Map<string, number>();
    for (const slot of layer) {
      const near = neighbours.get(slot.id) ?? [];
      desired.set(slot.id, near.length > 0 ? near.reduce((sum, id) => sum + pos.get(id)!, 0) / near.length : pos.get(slot.id)!);
    }
    const unitSum = new Map<string, { sum: number; count: number; first: number }>();
    for (const slot of layer) {
      const entry = unitSum.get(slot.unit) ?? { sum: 0, count: 0, first: pos.get(slot.id)! };
      unitSum.set(slot.unit, { sum: entry.sum + desired.get(slot.id)!, count: entry.count + 1, first: entry.first });
    }
    layer.sort((a, b) => {
      const ua = unitSum.get(a.unit)!;
      const ub = unitSum.get(b.unit)!;
      return ua.sum / ua.count - ub.sum / ub.count || ua.first - ub.first || pos.get(a.id)! - pos.get(b.id)!;
    });
    layer.forEach((slot, index) => pos.set(slot.id, index));
  };

  /** Crossings of the arrows of two adjacent slots, with `left` standing left of `right`. */
  const pairCrossings = (left: Slot, right: Slot): number => {
    let count = 0;
    for (const neighbours of [before, after]) {
      for (const a of neighbours.get(left.id) ?? []) {
        for (const b of neighbours.get(right.id) ?? []) if (pos.get(a)! > pos.get(b)!) count += 1;
      }
    }
    return count;
  };
  const transpose = (): void => {
    for (let pass = 0; pass < 6; pass += 1) {
      let improved = false;
      for (const layer of order) {
        for (let i = 0; i + 1 < layer.length; i += 1) {
          const a = layer[i]!;
          const b = layer[i + 1]!;
          if (a.unit === b.unit || unitCount.get(a.unit) !== 1 || unitCount.get(b.unit) !== 1) continue;
          if (pairCrossings(b, a) < pairCrossings(a, b)) {
            layer[i] = b;
            layer[i + 1] = a;
            pos.set(a.id, i + 1);
            pos.set(b.id, i);
            improved = true;
          }
        }
      }
      if (!improved) break;
    }
  };

  let best = order.map((layer) => [...layer]);
  let bestCount = totalCrossings();
  for (let sweep = 0; sweep < ORDER_SWEEPS && bestCount > 0; sweep += 1) {
    if (sweep % 2 === 0) for (let k = 1; k < order.length; k += 1) reorder(k, before);
    else for (let k = order.length - 2; k >= 0; k -= 1) reorder(k, after);
    transpose();
    const count = totalCrossings();
    if (count < bestCount) {
      bestCount = count;
      best = order.map((layer) => [...layer]);
    }
  }
  best.forEach((layer, k) => {
    order[k] = layer;
  });
  refresh();

  // Placement: every layer is packed at the least-squares fit of "centred on the neighbours" that keeps the order
  // and the minimum distance between slots (pool adjacent violators).
  const centre = new Map<string, number>();
  const offsets = order.map((layer) => {
    const offset: number[] = [];
    layer.forEach((slot, index) => offset.push(index === 0 ? 0 : offset[index - 1]! + (layer[index - 1]!.size + slot.size + layer[index - 1]!.gap + slot.gap) / 2));
    return offset;
  });
  order.forEach((layer, k) => layer.forEach((slot, index) => centre.set(slot.id, offsets[k]![index]!)));
  // A slot is also drawn a little towards its place in a layer packed around the common middle line, so long
  // arrows cannot stretch a layer into a staircase that grows wider than the graph is deep.
  const widest = Math.max(0, ...offsets.map((offset) => (offset.length > 0 ? offset[offset.length - 1]! : 0)));
  const home = (k: number, index: number): number => offsets[k]![index]! - offsets[k]![offsets[k]!.length - 1]! / 2 + widest / 2;
  const place = (k: number, sides: readonly ReadonlyMap<string, readonly string[]>[]): void => {
    const layer = order[k]!;
    const targets = layer.map((slot, index) => {
      const near = sides.flatMap((side) => side.get(slot.id) ?? []);
      const wanted =
        near.length > 0
          ? (near.reduce((sum, id) => sum + centre.get(id)!, 0) + HOME_PULL * home(k, index)) / (near.length + HOME_PULL)
          : centre.get(slot.id)!;
      return wanted - offsets[k]![index]!;
    });
    const fitted = isotonic(targets);
    layer.forEach((slot, index) => centre.set(slot.id, fitted[index]! + offsets[k]![index]!));
  };
  for (let sweep = 0; sweep < PLACE_SWEEPS; sweep += 1) {
    for (let k = 1; k < order.length; k += 1) place(k, [before]);
    for (let k = order.length - 2; k >= 0; k -= 1) place(k, [after]);
  }
  for (let pass = 0; pass < FINAL_PASSES; pass += 1) {
    for (let k = 0; k < order.length; k += 1) place(k, [before, after]);
  }
  straightenLanes(order, centre, before, after);
  let low = Infinity;
  let high = -Infinity;
  for (const layer of order) {
    for (const slot of layer) {
      low = Math.min(low, centre.get(slot.id)! - slot.size / 2);
      high = Math.max(high, centre.get(slot.id)! + slot.size / 2);
    }
  }
  if (!Number.isFinite(low)) return { order, centre, span: 0 };
  for (const [id, value] of centre) centre.set(id, value - low);
  return { order, centre, span: high - low };
}

/** Lines up the lanes of each long arrow, so the arrow runs straight through the layers it passes instead of
 * zigzagging from one layer's free space to the next. Every lane only moves within the room its two neighbours in
 * its layer leave it (order and minimum distances kept), so nothing new overlaps and no crossing is added. The
 * lanes of one arrow share one position where that room allows, else each run of them that can does; longer arrows
 * first. */
function straightenLanes(
  order: readonly (readonly Slot[])[],
  centre: Map<string, number>,
  before: ReadonlyMap<string, readonly string[]>,
  after: ReadonlyMap<string, readonly string[]>,
): void {
  const where = new Map<string, { readonly layer: readonly Slot[]; readonly index: number }>();
  for (const layer of order) layer.forEach((slot, index) => where.set(slot.id, { layer, index }));
  const isLane = (id: string): boolean => where.has(id) && !where.get(id)!.layer[where.get(id)!.index]!.node;
  const chains: string[][] = [];
  for (const layer of order) {
    for (const slot of layer) {
      if (slot.node || (before.get(slot.id) ?? []).some(isLane)) continue;
      const chain = [slot.id];
      for (let next = after.get(slot.id)?.[0]; next !== undefined && isLane(next); next = after.get(next)?.[0]) chain.push(next);
      chains.push(chain);
    }
  }
  chains.sort((a, b) => b.length - a.length);
  /** The room a slot has between its neighbours in its layer. */
  const room = (id: string): [number, number] => {
    const { layer, index } = where.get(id)!;
    const slot = layer[index]!;
    const apart = (other: Slot): number => (other.size + slot.size + other.gap + slot.gap) / 2;
    const previous = layer[index - 1];
    const next = layer[index + 1];
    return [previous ? centre.get(previous.id)! + apart(previous) : -Infinity, next ? centre.get(next.id)! - apart(next) : Infinity];
  };
  for (const chain of chains) {
    let start = 0;
    while (start < chain.length) {
      let [lo, hi] = room(chain[start]!);
      let end = start + 1;
      for (; end < chain.length; end += 1) {
        const [a, b] = room(chain[end]!);
        if (Math.max(lo, a) > Math.min(hi, b)) break;
        lo = Math.max(lo, a);
        hi = Math.min(hi, b);
      }
      const run = chain.slice(start, end);
      const mean = run.reduce((sum, id) => sum + centre.get(id)!, 0) / run.length;
      const at = Math.min(hi, Math.max(lo, mean));
      for (const id of run) centre.set(id, at);
      start = end;
    }
  }
}

interface Lane {
  /** The layer the arrow passes through. */
  readonly layer: number;
  /** Where it crosses that layer: x (bottom to top) or y (left to right) of its centre line. */
  readonly at: number;
}

interface Geometry {
  readonly direction: GraphDirection;
  /** Top (bottom to top) or left (left to right) of a layer. */
  readonly start: (layer: number) => number;
  /** Lanes of arrows that span more than one layer, in order from the prerequisite's layer to the dependent's. */
  readonly lanes: ReadonlyMap<string, readonly Lane[]>;
}

export const laneKey = (from: string, to: string): string => `${from}\u0000${to}`;

/** Arrows from each prerequisite to its dependent (both ends must be placed). Bottom to top: from the top of the
 * prerequisite's dot to the bottom of the dependent's dot. Left to right: from the end of the prerequisite's title
 * to the left of the dependent's dot. */
function placeEdges(graph: DependencyGraph, nodes: readonly PlacedNode[], geometry: Geometry): Edge[] {
  const placedNodes = new Map(nodes.map((placed) => [placed.node.id, placed]));
  const vertical = geometry.direction === "bottom-to-top";
  const edges: Edge[] = [];
  for (const edge of graph.edges) {
    const from = placedNodes.get(edge.from);
    const to = placedNodes.get(edge.to);
    if (!from || !to) continue;
    const ends = vertical
      ? { x1: from.x + DOT_X, y1: from.y + (from.h - DOT_D) / 2, x2: to.x + DOT_X, y2: to.y + (to.h + DOT_D) / 2 }
      : { x1: from.x + drawnWidth(from) + 2, y1: from.y + from.h / 2, x2: to.x + DOT_X - DOT_D / 2, y2: to.y + to.h / 2 };
    const routed: Edge = { from: edge.from, to: edge.to, ...ends, dashed: Boolean(from.node.optional || to.node.optional) };
    const points = routeEdge(routed, from, to, nodes, geometry);
    edges.push(points.length > 0 ? { ...routed, points } : routed);
  }
  return edges;
}

const ROUTE_MARGIN = 3;
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

/** Drops duplicate points and points that lie on the straight line between their neighbours. */
function simplify(path: readonly Pt[]): Pt[] {
  const kept: Pt[] = [];
  for (const pt of path) {
    const last = kept[kept.length - 1];
    if (last && last.x === pt.x && last.y === pt.y) continue;
    kept.push(pt);
  }
  const out: Pt[] = [];
  kept.forEach((pt, index) => {
    const prev = out[out.length - 1];
    const next = kept[index + 1];
    if (prev && next && Math.abs((pt.x - prev.x) * (next.y - pt.y) - (pt.y - prev.y) * (next.x - pt.x)) < 1e-6) {
      const forward = (pt.x - prev.x) * (next.x - pt.x) + (pt.y - prev.y) * (next.y - pt.y) > 0;
      if (forward) return;
    }
    out.push(pt);
  });
  return out;
}

/** The bends of one arrow (start and end excluded). The arrow runs straight when that is clear; otherwise it leaves
 * the prerequisite's cell along the depth axis, crosses each layer it passes in that arrow's own lane (free space
 * between nodes), and enters the dependent's cell along the depth axis. Between two layers it runs diagonally in
 * the open gap, where no node stands. */
function routeEdge(edge: Edge, from: PlacedNode, to: PlacedNode, nodes: readonly PlacedNode[], geometry: Geometry): Pt[] {
  const vertical = geometry.direction === "bottom-to-top";
  const start = { x: edge.x1, y: edge.y1 };
  const end = { x: edge.x2, y: edge.y2 };
  const boxes = nodes
    .filter((n) => n.node.id !== edge.from && n.node.id !== edge.to)
    .map((n): Box => ({ x1: n.x - ROUTE_MARGIN, y1: n.y - ROUTE_MARGIN, x2: n.x + drawnWidth(n) + ROUTE_MARGIN, y2: n.y + n.h + ROUTE_MARGIN }));
  const clear = (path: readonly Pt[]): boolean => path.every((pt, i) => i === 0 || !boxes.some((box) => segmentHits(path[i - 1]!, pt, box)));
  const lanes = geometry.lanes.get(laneKey(edge.from, edge.to)) ?? [];
  // Through a lane: bottom to top the arrow rises through the row, left to right it runs along the column.
  const through = lanes.flatMap((lane): Pt[] => {
    const a = geometry.start(lane.layer);
    return vertical
      ? [{ x: lane.at, y: a + NODE_H }, { x: lane.at, y: a }]
      : [{ x: a, y: lane.at }, { x: a + NODE_W, y: lane.at }];
  });
  const direct = [start, ...through, end];
  if (clear(direct)) return simplify(direct).slice(1, -1);
  const out: Pt = vertical ? { x: start.x, y: from.y } : { x: Math.max(start.x, from.x + from.w), y: start.y };
  const into: Pt = vertical ? { x: end.x, y: to.y + to.h } : { x: to.x, y: end.y };
  return simplify([start, out, ...through, into, end]).slice(1, -1);
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


/** The graph: every shown node is a dot in the layer (row or column) of its dependency depth, arranged by the
 * layered method (arrange) with an arrow from each prerequisite to its dependent. Each module gets a small label at
 * its first node (the shallowest, then the lowest and leftmost). A depth with more nodes than fit one layer wraps
 * into several layers, in both directions, so the graph keeps a bounded shape. */
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
  const slotSize = vertical ? NODE_W : NODE_H;
  const laneSize = vertical ? LANE_W : 4;
  const gap = vertical ? NODE_GAP : COL_NODE_GAP;
  const laneGap = vertical ? 8 : 6;
  const depths = [...cells.keys()].sort((a, b) => a - b);

  /** Arranges layers of nodes, with a lane slot in every layer an arrow passes through. */
  const solve = (layerNodes: readonly (readonly PathNode[])[]) => {
    const layerOf = new Map<string, number>();
    layerNodes.forEach((list, k) => list.forEach((node) => layerOf.set(node.id, k)));
    const layers: Slot[][] = layerNodes.map((list) => list.map((node) => ({ id: node.id, unit: unitKey(node), size: slotSize, gap, node })));
    const links: LayerLink[] = [];
    const laneSlots = new Map<string, { readonly layer: number; readonly id: string }[]>();
    graph.edges.forEach((edge, index) => {
      const a = layerOf.get(edge.from);
      const b = layerOf.get(edge.to);
      if (a === undefined || b === undefined || b <= a) return;
      let previous = edge.from;
      const chain: { layer: number; id: string }[] = [];
      for (let k = a + 1; k < b; k += 1) {
        const id = `lane:${index}:${k}`;
        layers[k]!.push({ id, unit: id, size: laneSize, gap: laneGap });
        links.push({ from: previous, to: id });
        chain.push({ layer: k, id });
        previous = id;
      }
      links.push({ from: previous, to: edge.to });
      laneSlots.set(laneKey(edge.from, edge.to), chain);
    });
    return { arranged: arrange(layers, links), laneSlots };
  };

  // Order with one layer per depth first; then wrap a depth that is wider than `cap` into several layers (consecutive
  // runs of that order, alternatives kept whole) and arrange again from that order.
  const cap = vertical
    ? Math.max(MIN_ROW_CAP, Math.ceil(0.8 * Math.sqrt(graph.nodeIds.length)))
    : Math.max(MIN_COL_CAP, Math.ceil(1.5 * Math.sqrt(graph.nodeIds.length)));
  let solved = solve(depths.map((depth) => cells.get(depth)!));
  let depthOfLayer = depths;
  if (depths.some((depth) => cells.get(depth)!.length > cap)) {
    const wrapped: PathNode[][] = [];
    depthOfLayer = [];
    depths.forEach((depth, k) => {
      const list = solved.arranged.order[k]!.flatMap((slot) => (slot.node ? [slot.node] : []));
      const units: PathNode[][] = [];
      for (const node of list) {
        const last = units[units.length - 1];
        if (last && unitKey(last[0]!) === unitKey(node)) last.push(node);
        else units.push([node]);
      }
      const count = Math.min(units.length, Math.ceil(list.length / cap));
      const target = Math.ceil(list.length / count);
      const chunks: PathNode[][] = [[]];
      for (const unit of units) {
        const current = chunks[chunks.length - 1]!;
        if (current.length > 0 && current.length + unit.length > target && chunks.length < count) chunks.push([...unit]);
        else current.push(...unit);
      }
      for (const chunk of chunks) {
        wrapped.push(chunk);
        depthOfLayer.push(depth);
      }
    });
    solved = solve(wrapped);
  }
  const { arranged, laneSlots } = solved;
  const layerCount = arranged.order.length;
  const rowStep = NODE_H + ROW_GAP;
  /** Top (bottom to top: layer 0 is the bottom row) or left (left to right) of a layer. */
  const layerStart = (layer: number): number => (vertical ? PAD + (layerCount - 1 - layer) * rowStep : PAD + layer * COL_W);
  const across = (id: string): number => (vertical ? PAD : PAD + LABEL_H) + arranged.centre.get(id)!;

  const nodes: PlacedNode[] = [];
  arranged.order.forEach((layer, k) => {
    for (const slot of layer) {
      const node = slot.node;
      if (!node) continue;
      const owner = moduleOf.get(node.id)!;
      nodes.push({
        node,
        moduleId: owner.id,
        moduleIndex: owner.index,
        depth: depthOfLayer[k]!,
        x: vertical ? across(node.id) - NODE_W / 2 : layerStart(k),
        y: vertical ? layerStart(k) : across(node.id) - NODE_H / 2,
        w: NODE_W,
        h: NODE_H,
      });
    }
  });
  const lanes = new Map<string, Lane[]>();
  for (const [key, chain] of laneSlots) lanes.set(key, chain.map((slot) => ({ layer: slot.layer, at: across(slot.id) })));
  const width = vertical
    ? PAD + Math.max(arranged.span, NODE_W) + PAD
    : PAD + (Math.max(layerCount, 1) - 1) * COL_W + NODE_W + PAD;
  const height = vertical
    ? PAD + (layerCount > 0 ? (layerCount - 1) * rowStep + NODE_H : NODE_H) + PAD + PAD_BOTTOM
    : PAD + LABEL_H + arranged.span + PAD + PAD_BOTTOM;

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
  const geometry: Geometry = { direction, start: layerStart, lanes };
  return { width, height, modules, nodes, edges: placeEdges(graph, nodes, geometry) };
}
