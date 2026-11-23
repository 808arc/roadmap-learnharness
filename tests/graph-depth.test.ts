/** Graph view depth: LearnHarness's inference depth. Chains rise one column per step; a cycle shares one column. */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { LearningPath, PathModule, PathNode } from "../src/domain.ts";
import { inferenceDepth } from "../src/view/graph-depth.ts";
import { layoutGraph } from "../src/view/roadmap-layout.ts";
import type { NodePrerequisites } from "../src/node-prerequisites.ts";
import { makeNode, makePath } from "./fixtures.ts";

function pathWith(nodes: readonly PathNode[]): LearningPath {
  const modules: PathModule[] = [{ id: "module-graph", title: "Graph", nodes }];
  return { ...makePath(), modules };
}

function prerequisites(after: Record<string, string[]>, nodes: readonly PathNode[]): NodePrerequisites[] {
  return nodes.map((node) => ({ nodeId: node.id, prerequisiteIds: after[node.id] ?? [], source: "node" as const }));
}

test("depth is the longest chain of arrows ending at a node", () => {
  const depth = inferenceDepth(["a", "b", "c", "d"], [
    { from: "a", to: "b" },
    { from: "b", to: "c" },
    { from: "a", to: "c" },
  ]);
  assert.equal(depth.get("a"), 0);
  assert.equal(depth.get("b"), 1);
  assert.equal(depth.get("c"), 2, "the longer chain wins");
  assert.equal(depth.get("d"), 0, "an unconnected node is a base");
});

test("a cycle collapses: every member shares one depth, and nodes after it sit one level further", () => {
  const depth = inferenceDepth(["a", "b", "c", "d"], [
    { from: "a", to: "b" },
    { from: "b", to: "a" },
    { from: "b", to: "c" },
    { from: "c", to: "d" },
  ]);
  assert.equal(depth.get("a"), depth.get("b"), "mutual dependence shares a depth");
  assert.equal(depth.get("c"), (depth.get("a") ?? 0) + 1);
  assert.equal(depth.get("d"), (depth.get("c") ?? 0) + 1);
});

test("edges to unknown ids and self-loops are ignored", () => {
  const depth = inferenceDepth(["a", "b"], [
    { from: "a", to: "a" },
    { from: "a", to: "ghost" },
    { from: "a", to: "b" },
  ]);
  assert.equal(depth.get("a"), 0);
  assert.equal(depth.get("b"), 1);
});

test("the graph view draws no arrows inside a cycle, and the cycle sits in one column", () => {
  const nodes = [makeNode("a", "concept"), makeNode("b", "skill"), makeNode("c", "skill")];
  const layout = layoutGraph(pathWith(nodes), {
    direction: "left-to-right",
    showOptional: true,
    prerequisites: prerequisites({ a: ["b"], b: ["a"], c: ["b"] }, nodes),
  });
  const column = (id: string): number => layout.nodes.find((placed) => placed.node.id === id)!.x;
  assert.equal(column("a"), column("b"), "cycle members share a column");
  assert.ok(column("c") > column("a"), "the dependent after the cycle sits to the right");
  const drawn = layout.edges.map((edge) => `${edge.from}>${edge.to}`);
  assert.deepEqual(drawn, ["b>c"], "only the arrow that leaves the cycle is drawn");
});
