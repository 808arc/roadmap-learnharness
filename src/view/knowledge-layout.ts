/** Layout of the learner's Knowledge Graph: propositions as nodes, reasoning chains as arrows.
 * Layered by the longest chain of premises behind a proposition, so premises sit before what they imply. */
import type { GraphDirection } from "./roadmap-layout.ts";

export interface KnowledgeNode {
  readonly id: string;
  readonly name: string;
  readonly statement: string;
}

/** An arrow from a premise to the conclusion it helps imply. */
export interface KnowledgeEdge {
  readonly from: string;
  readonly to: string;
}

export interface KnowledgeData {
  readonly nodes: readonly KnowledgeNode[];
  readonly edges: readonly KnowledgeEdge[];
}

export interface PlacedKnowledgeNode {
  readonly node: KnowledgeNode;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface KnowledgeLayout {
  readonly width: number;
  readonly height: number;
  /** Always empty: the knowledge graph has no module labels. Lets the canvas pan and zoom it like a roadmap. */
  readonly modules: readonly never[];
  readonly nodes: readonly PlacedKnowledgeNode[];
  readonly edges: readonly { readonly from: string; readonly to: string; readonly x1: number; readonly y1: number; readonly x2: number; readonly y2: number }[];
}

const W = 168;
const H = 38;
const GAP = 22;
const ROW_GAP = 46;
const PAD = 28;

export const EMPTY_KNOWLEDGE: KnowledgeData = { nodes: [], edges: [] };

/** Read the backend's `graph.knowledge` result defensively. Anything malformed reads as empty. */
export function readKnowledge(value: unknown): KnowledgeData {
  const raw = value as { nodes?: unknown; edges?: unknown } | null;
  if (!raw || !Array.isArray(raw.nodes) || !Array.isArray(raw.edges)) return EMPTY_KNOWLEDGE;
  const nodes: KnowledgeNode[] = [];
  const seen = new Set<string>();
  for (const entry of raw.nodes as Record<string, unknown>[]) {
    if (!entry || typeof entry.id !== "string" || typeof entry.name !== "string" || seen.has(entry.id)) continue;
    seen.add(entry.id);
    nodes.push({ id: entry.id, name: entry.name, statement: typeof entry.statement === "string" ? entry.statement : "" });
  }
  const edges: KnowledgeEdge[] = [];
  for (const entry of raw.edges as Record<string, unknown>[]) {
    if (entry && typeof entry.from === "string" && typeof entry.to === "string" && seen.has(entry.from) && seen.has(entry.to)) {
      edges.push({ from: entry.from, to: entry.to });
    }
  }
  return { nodes, edges };
}

/** Depth of each node: the longest premise chain behind it. Edges that close a cycle are ignored. */
function depths(data: KnowledgeData): Map<string, number> {
  const incoming = new Map<string, string[]>();
  for (const edge of data.edges) {
    if (edge.from !== edge.to) incoming.set(edge.to, [...(incoming.get(edge.to) ?? []), edge.from]);
  }
  const depth = new Map<string, number>();
  const active = new Set<string>();
  const visit = (id: string): number => {
    const known = depth.get(id);
    if (known !== undefined) return known;
    if (active.has(id)) return 0;
    active.add(id);
    let best = 0;
    for (const from of incoming.get(id) ?? []) best = Math.max(best, visit(from) + 1);
    active.delete(id);
    depth.set(id, best);
    return best;
  };
  for (const node of data.nodes) visit(node.id);
  return depth;
}

export function layoutKnowledge(data: KnowledgeData, direction: GraphDirection = "bottom-to-top"): KnowledgeLayout {
  const depth = depths(data);
  const layers = new Map<number, KnowledgeNode[]>();
  for (const node of data.nodes) {
    const layer = depth.get(node.id) ?? 0;
    layers.set(layer, [...(layers.get(layer) ?? []), node]);
  }
  const layerCount = layers.size === 0 ? 0 : Math.max(...layers.keys()) + 1;
  const widest = Math.max(0, ...[...layers.values()].map((list) => list.length));
  const up = direction === "bottom-to-top";
  const cell = up ? W + GAP : H + GAP;
  const spread = Math.max(0, widest * cell - GAP);
  const stack = Math.max(0, layerCount * (up ? H + ROW_GAP : W + ROW_GAP) - ROW_GAP);
  const width = PAD * 2 + (up ? spread : stack);
  const height = PAD * 2 + (up ? stack : spread);
  const placed = new Map<string, PlacedKnowledgeNode>();
  for (const [layer, list] of layers) {
    const used = list.length * cell - GAP;
    list.forEach((node, index) => {
      const along = (spread - used) / 2 + index * cell;
      const across = up ? (layerCount - 1 - layer) * (H + ROW_GAP) : layer * (W + ROW_GAP);
      placed.set(node.id, { node, x: PAD + (up ? along : across), y: PAD + (up ? across : along), w: W, h: H });
    });
  }
  const edges = data.edges.flatMap((edge) => {
    const a = placed.get(edge.from);
    const b = placed.get(edge.to);
    if (!a || !b || edge.from === edge.to) return [];
    return up
      ? [{ ...edge, x1: a.x + W / 2, y1: a.y, x2: b.x + W / 2, y2: b.y + H }]
      : [{ ...edge, x1: a.x + W, y1: a.y + H / 2, x2: b.x, y2: b.y + H / 2 }];
  });
  return { width, height, modules: [], nodes: [...placed.values()], edges };
}
