/** Graph replay (pure, DOM-free): the order in which a saved graph is revealed, from the root outward.
 *
 * Step 1 is the roadmap's root alone; each later step adds one dependency layer (nodes of one depth) and the
 * arrows that now have both ends on screen. The order only reads the layout; nothing is saved.
 * Item order inside a layer is the growth order (column first, then row), as in graph-growth.ts.
 */
import { GROW_STEP_MS, edgeKey } from "./graph-growth.ts";
import type { PlacedNode, RoadmapLayout } from "./roadmap-layout.ts";

export type ReplaySpeed = "slow" | "normal" | "fast";
export const REPLAY_SPEEDS: readonly ReplaySpeed[] = ["slow", "normal", "fast"];

/** Pause between two steps while playing, in milliseconds. A step is a layer, so it waits longer than one node. */
export const REPLAY_STEP_MS: Readonly<Record<ReplaySpeed, number>> = {
  slow: GROW_STEP_MS * 10,
  normal: GROW_STEP_MS * 5,
  fast: GROW_STEP_MS * 2,
};

export interface ReplayItem {
  readonly node: PlacedNode;
  /** Titles of the prerequisites this node came from; empty for a root node. */
  readonly after: readonly string[];
}

export interface ReplayStep {
  readonly depth: number;
  readonly items: readonly ReplayItem[];
}

export interface Replay {
  readonly steps: readonly ReplayStep[];
}

/** `rootId` (the roadmap's one root, domain.ts rootNodeId) is revealed alone as step 1 when it is shown; other
 * nodes without prerequisites follow it in the next step. */
export function replayOf(layout: RoadmapLayout, rootId: string | null = null): Replay {
  const titles = new Map(layout.nodes.map((placed) => [placed.node.id, placed.node.title] as const));
  const prerequisites = new Map<string, string[]>();
  for (const edge of layout.edges) {
    const list = prerequisites.get(edge.to) ?? [];
    list.push(titles.get(edge.from) ?? edge.from);
    prerequisites.set(edge.to, list);
  }
  const item = (node: PlacedNode): ReplayItem => ({ node, after: prerequisites.get(node.node.id) ?? [] });
  const root = layout.nodes.find((placed) => placed.node.id === rootId);
  const byDepth = new Map<number, PlacedNode[]>();
  for (const placed of layout.nodes) {
    if (placed === root) continue;
    byDepth.set(placed.depth, [...(byDepth.get(placed.depth) ?? []), placed]);
  }
  const steps: ReplayStep[] = root ? [{ depth: root.depth, items: [item(root)] }] : [];
  for (const depth of [...byDepth.keys()].sort((a, b) => a - b)) {
    steps.push({ depth, items: byDepth.get(depth)!.sort((a, b) => a.x - b.x || a.y - b.y).map(item) });
  }
  return { steps };
}

/** Node ids and arrow keys on screen once `step` (1-based) has been revealed. */
export function revealedAt(replay: Replay, layout: RoadmapLayout, step: number): { nodes: Set<string>; edges: Set<string> } {
  const nodes = new Set<string>();
  for (const entry of replay.steps.slice(0, Math.max(0, step))) for (const item of entry.items) nodes.add(item.node.node.id);
  const edges = new Set<string>();
  for (const edge of layout.edges) if (nodes.has(edge.from) && nodes.has(edge.to)) edges.add(edgeKey(edge.from, edge.to));
  return { nodes, edges };
}

/** The layout reduced to what step `step` has revealed. */
export function layoutAt(replay: Replay, layout: RoadmapLayout, step: number): RoadmapLayout {
  const shown = revealedAt(replay, layout, step);
  return {
    ...layout,
    nodes: layout.nodes.filter((placed) => shown.nodes.has(placed.node.id)),
    edges: layout.edges.filter((edge) => shown.edges.has(edgeKey(edge.from, edge.to))),
    modules: layout.modules.filter((placed) => placed.module.nodes.some((node) => shown.nodes.has(node.id))),
  };
}
