/** Graph tree layout: the root(s) open the first level, children sit close to their parent, nothing overlaps, packed. */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { LearningPath, PathModule, PathNode } from "../src/domain.ts";
import { NODE_H, NODE_W, drawnWidth, layoutGraph } from "../src/view/roadmap-layout.ts";
import type { GraphDirection, PlacedNode, RoadmapLayout } from "../src/view/roadmap-layout.ts";
import { makeNode, makePath } from "./fixtures.ts";

const DIRECTIONS: readonly GraphDirection[] = ["bottom-to-top", "left-to-right"];

/** One root, three branches, three levels: r -> a/b/c -> two children each -> one grandchild per child. */
function tree(): Record<string, string[]> {
  const after: Record<string, string[]> = { r: [] };
  for (const b of ["a", "b", "c"]) {
    after[b] = ["r"];
    for (const k of ["1", "2"]) {
      after[b + k] = [b];
      after[b + k + "x"] = [b + k];
    }
  }
  return after;
}

function lay(after: Record<string, string[]>, direction: GraphDirection): RoadmapLayout {
  const nodes: PathNode[] = Object.keys(after).map((id) => makeNode(id, "concept", { title: `Node ${id}` }));
  const path: LearningPath = { ...makePath(), modules: [{ id: "m", title: "M", nodes } as PathModule] };
  const prerequisites = nodes.map((n) => ({ nodeId: n.id, prerequisiteIds: after[n.id] ?? [], source: "node" as const }));
  return layoutGraph(path, { showOptional: true, prerequisites, direction });
}

const byId = (layout: RoadmapLayout): Map<string, PlacedNode> => new Map(layout.nodes.map((n) => [n.node.id, n]));
/** Position along the level direction: bottom to top the level is y (first level lowest), left to right it is x. */
const along = (n: PlacedNode, direction: GraphDirection): number => (direction === "bottom-to-top" ? -n.y : n.x);

test("a single root sits on the first level, and its direct children on the next", () => {
  for (const direction of DIRECTIONS) {
    const nodes = byId(lay(tree(), direction));
    const root = along(nodes.get("r")!, direction);
    for (const id of nodes.keys()) if (id !== "r") assert.ok(along(nodes.get(id)!, direction) > root, `${direction}: ${id} is after the root`);
    const children = ["a", "b", "c"].map((id) => along(nodes.get(id)!, direction));
    assert.equal(new Set(children).size, 1, `${direction}: the children share one level`);
    for (const id of ["a1", "a2", "b1", "c2"]) assert.ok(along(nodes.get(id)!, direction) > children[0]!, `${direction}: ${id} is a level further`);
  }
});

test("several roots share the first level", () => {
  for (const direction of DIRECTIONS) {
    const nodes = byId(lay({ r1: [], r2: [], r3: [], c: ["r1", "r2", "r3"] }, direction));
    assert.equal(new Set(["r1", "r2", "r3"].map((id) => along(nodes.get(id)!, direction))).size, 1);
    assert.ok(along(nodes.get("c")!, direction) > along(nodes.get("r1")!, direction));
  }
});

test("a parent is at most two node widths from its children along the level direction", () => {
  for (const direction of DIRECTIONS) {
    const layout = lay(tree(), direction);
    const nodes = byId(layout);
    for (const edge of layout.edges) {
      const distance = Math.abs(along(nodes.get(edge.to)!, direction) - along(nodes.get(edge.from)!, direction));
      assert.ok(distance <= 2 * NODE_W, `${direction}: ${edge.from}->${edge.to} is ${distance} apart`);
    }
  }
});

test("nodes never overlap, drawn width included", () => {
  for (const direction of DIRECTIONS) {
    const placed = lay(tree(), direction).nodes;
    for (let i = 0; i < placed.length; i += 1) {
      for (let j = i + 1; j < placed.length; j += 1) {
        const a = placed[i]!;
        const b = placed[j]!;
        const apart = a.x + drawnWidth(a) <= b.x || b.x + drawnWidth(b) <= a.x || a.y + NODE_H <= b.y || b.y + NODE_H <= a.y;
        assert.ok(apart, `${direction}: ${a.node.id} overlaps ${b.node.id}`);
      }
    }
  }
});

test("the layout is compact: its area is at most twice the area of the nodes' bounding box", () => {
  for (const direction of DIRECTIONS) {
    const layout = lay(tree(), direction);
    const xs = layout.nodes.map((n) => n.x);
    const ys = layout.nodes.map((n) => n.y);
    const box = (Math.max(...xs) + NODE_W - Math.min(...xs)) * (Math.max(...ys) + NODE_H - Math.min(...ys));
    // The canvas adds fixed margins (40 each side) and room for the controls (150); those do not count against the tree.
    const net = (layout.width - 80) * (layout.height - 80 - 150);
    assert.ok(net <= 2 * box, `${direction}: area ${net} vs box ${box}`);
  }
});
