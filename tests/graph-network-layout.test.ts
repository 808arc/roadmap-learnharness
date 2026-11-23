/** Network placement (left to right): nodes in one column never overlap, and a node sits between the nodes it connects to. */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { LearningPath, PathModule, PathNode } from "../src/domain.ts";
import { NODE_H, NODE_ROW, layoutGraph } from "../src/view/roadmap-layout.ts";
import { makeNode, makePath } from "./fixtures.ts";

function place(after: Record<string, string[]>) {
  const nodes: PathNode[] = Object.keys(after).map((id) => makeNode(id, "concept"));
  const path: LearningPath = { ...makePath(), modules: [{ id: "m", title: "M", nodes } as PathModule] };
  const prerequisites = nodes.map((n) => ({ nodeId: n.id, prerequisiteIds: after[n.id] ?? [], source: "node" as const }));
  const layout = layoutGraph(path, { showOptional: true, prerequisites, direction: "left-to-right" });
  return new Map(layout.nodes.map((placed) => [placed.node.id, placed.y] as const));
}

test("a node with two prerequisites sits between them, and nodes in a column never overlap", () => {
  const y = place({ a: [], b: [], c: [], merge: ["a", "c"] });
  const mid = (y.get("a")! + y.get("c")!) / 2;
  assert.ok(Math.abs(y.get("merge")! - mid) < NODE_ROW, "the merge node lies near the middle of its two prerequisites");

  const column = [y.get("a")!, y.get("b")!, y.get("c")!].sort((p, q) => p - q);
  for (let index = 1; index < column.length; index += 1) {
    assert.ok(column[index]! - column[index - 1]! >= NODE_H, "nodes in a column never overlap");
  }
});

test("a single branch fans out: the children spread apart instead of stacking in one row", () => {
  const y = place({ root: [], x: ["root"], y: ["root"], z: ["root"] });
  const offsets = ["x", "y", "z"].map((id) => y.get(id)!);
  assert.equal(new Set(offsets).size, 3, "three children get three different heights");
  assert.ok(Math.abs(y.get("root")! - (Math.min(...offsets) + Math.max(...offsets)) / 2) < NODE_ROW, "the root sits near the middle of its children");
});
