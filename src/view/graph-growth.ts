/** Graph growth (pure, DOM-free): which nodes and arrows are new since the graph was last drawn,
 * and when each one appears.
 *
 * A save adds nodes and prerequisite arrows to the roadmap. The new ones appear one after another
 * in layout order (column first, then row), and each arrow appears just after its dependent node.
 * Items already on screen get no delay and no animation.
 */
import type { RoadmapLayout } from "./roadmap-layout.ts";

/** Gap between two nodes appearing one after another, in milliseconds. */
export const GROW_STEP_MS = 140;

/** What the graph showed last time: node ids and arrow keys. */
export interface GraphSnapshot {
  readonly nodes: ReadonlySet<string>;
  readonly edges: ReadonlySet<string>;
}

export interface GrowthPlan {
  /** Appearance delay in ms for each new item. Keys: a node id, or an `edgeKey` for an arrow. */
  readonly delays: ReadonlyMap<string, number>;
  /** Number of new nodes (arrows are not counted). */
  readonly addedNodes: number;
}

export const EMPTY_SNAPSHOT: GraphSnapshot = { nodes: new Set(), edges: new Set() };

export function edgeKey(from: string, to: string): string {
  return `${from}\u0000${to}`;
}

export function snapshotOf(layout: RoadmapLayout): GraphSnapshot {
  return {
    nodes: new Set(layout.nodes.map((placed) => placed.node.id)),
    edges: new Set(layout.edges.map((edge) => edgeKey(edge.from, edge.to))),
  };
}

/** The items of `layout` that are not in `previous`, with the delay each one waits before it appears.
 * `previous` null means there is nothing to animate (first drawing of this roadmap). */
export function growthPlan(previous: GraphSnapshot | null, layout: RoadmapLayout, stepMs: number = GROW_STEP_MS): GrowthPlan {
  if (previous === null) return { delays: new Map(), addedNodes: 0 };
  const newNodes = layout.nodes
    .filter((placed) => !previous.nodes.has(placed.node.id))
    .sort((a, b) => a.x - b.x || a.y - b.y);
  const delays = new Map<string, number>();
  newNodes.forEach((placed, index) => delays.set(placed.node.id, index * stepMs));
  for (const edge of layout.edges) {
    const key = edgeKey(edge.from, edge.to);
    if (previous.edges.has(key)) continue;
    const dependent = delays.get(edge.to);
    // An arrow into a node that is appearing shows just after that node; an arrow between old nodes shows at once.
    if (dependent !== undefined) delays.set(key, dependent + stepMs / 2);
    else delays.set(key, 0);
  }
  return { delays, addedNodes: newNodes.length };
}
