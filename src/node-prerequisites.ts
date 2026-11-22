// Node prerequisites: each node's own prerequisites (issue #44), or module order for older data.
// Pure: no I/O, no model client.

/** A path node reduced to what prerequisites need: its id and its own prerequisites (absent on older data). */
export type LinkedNode = { id: string; prerequisites?: readonly string[] };

export type NodePrerequisites = {
  nodeId: string;
  /** Node ids this node depends on, in module order. */
  prerequisiteIds: string[];
  /**
   * "node": the node's own prerequisites, as set by the Architect (an empty list is a root).
   * "module-order": the fallback (the previous node, if any).
   */
  source: "node" | "module-order";
};

/**
 * Prerequisites for each node in module order. A node with its own `prerequisites` depends on
 * exactly those. Otherwise it depends on the node before it in module order, and the first node
 * depends on nothing.
 */
export function nodePrerequisites(nodes: readonly LinkedNode[]): NodePrerequisites[] {
  return nodes.map((node, index) => {
    if (node.prerequisites !== undefined) {
      return { nodeId: node.id, prerequisiteIds: [...node.prerequisites], source: "node" as const };
    }
    const previous = index > 0 ? nodes[index - 1]!.id : undefined;
    return {
      nodeId: node.id,
      prerequisiteIds: previous === undefined ? [] : [previous],
      source: "module-order" as const,
    };
  });
}
