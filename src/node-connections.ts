// Node connections for the node panel's Connections section (issue #53).
// Pure: no DOM, no I/O. Derived from the path's own data on every render.
import type { LearningPath, PathNode } from "./domain.ts";

export interface NodeConnections {
  /** This node's prerequisites that exist in the roadmap, in the order the node lists them. */
  readonly buildsOn: readonly PathNode[];
  /** Nodes in the roadmap whose prerequisites include this node, in module order. */
  readonly neededBy: readonly PathNode[];
  /** The node whose accepted pivot inserted this node, when the data holds that link. */
  readonly createdFrom: PathNode | null;
}

export function nodeConnections(path: LearningPath, node: PathNode): NodeConnections {
  const nodes = path.modules.flatMap((module) => module.nodes);
  const byId = new Map(nodes.map((candidate) => [candidate.id, candidate] as const));

  const buildsOn: PathNode[] = [];
  for (const prerequisiteId of new Set(node.prerequisites ?? [])) {
    const prerequisite = byId.get(prerequisiteId);
    if (prerequisite && prerequisite.id !== node.id) buildsOn.push(prerequisite);
  }

  const neededBy = nodes.filter(
    (candidate) => candidate.id !== node.id && (candidate.prerequisites ?? []).includes(node.id),
  );

  // Only an accepted pivot inserts a node, and the pivot that proposed it records the new node's id.
  const source = nodes.find((candidate) =>
    candidate.pivotSuggestions.some((pivot) => pivot.insertedNodeId === node.id),
  );

  return { buildsOn, neededBy, createdFrom: source ?? null };
}
