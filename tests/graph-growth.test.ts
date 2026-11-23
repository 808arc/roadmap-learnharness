/** Graph growth: a save adds nodes and arrows, which appear in order; nothing else animates. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import type { LearningPath, PathModule, PathNode } from "../src/domain.ts";
import { EMPTY_SNAPSHOT, GROW_STEP_MS, edgeKey, growthPlan, snapshotOf } from "../src/view/graph-growth.ts";
import { createRoadmapCanvas } from "../src/view/roadmap-canvas.ts";
import type { CanvasState } from "../src/view/roadmap-canvas.ts";
import { layoutGraph } from "../src/view/roadmap-layout.ts";
import type { NodePrerequisites } from "../src/node-prerequisites.ts";
import { makeNode, makePath } from "./fixtures.ts";

const { parseHTML } = createRequire(import.meta.url)("linkedom") as {
  parseHTML(html: string): { document: Document };
};

function pathWith(nodes: readonly PathNode[]): LearningPath {
  const modules: PathModule[] = [{ id: "module-graph", title: "Graph", nodes }];
  return { ...makePath(), modules };
}

function prerequisites(after: Record<string, string[]>, nodes: readonly PathNode[]): NodePrerequisites[] {
  return nodes.map((node) => ({ nodeId: node.id, prerequisiteIds: after[node.id] ?? [], source: "node" as const }));
}

function graphOf(nodes: readonly PathNode[], after: Record<string, string[]>) {
  return layoutGraph(pathWith(nodes), { direction: "left-to-right", showOptional: true, prerequisites: prerequisites(after, nodes) });
}

test("the first drawing of a graph animates nothing", () => {
  const nodes = [makeNode("a", "concept"), makeNode("b", "skill")];
  const plan = growthPlan(null, graphOf(nodes, { b: ["a"] }));
  assert.equal(plan.delays.size, 0);
  assert.equal(plan.addedNodes, 0);
});

test("a re-drawn graph with nothing new animates nothing", () => {
  const nodes = [makeNode("a", "concept"), makeNode("b", "skill")];
  const layout = graphOf(nodes, { b: ["a"] });
  const plan = growthPlan(snapshotOf(layout), layout);
  assert.equal(plan.delays.size, 0);
  assert.equal(plan.addedNodes, 0);
});

test("a save that adds a chain shows its nodes in order, each arrow just after its dependent node", () => {
  const before = [makeNode("a", "concept")];
  const nodes = [makeNode("a", "concept"), makeNode("c", "skill"), makeNode("b", "skill")];
  const plan = growthPlan(snapshotOf(graphOf(before, {})), graphOf(nodes, { b: ["a"], c: ["b"] }));

  assert.equal(plan.addedNodes, 2);
  assert.equal(plan.delays.has("a"), false, "the node already on screen is not delayed");
  assert.equal(plan.delays.get("b"), 0, "the first new node appears first");
  assert.equal(plan.delays.get("c"), GROW_STEP_MS, "the next column appears one step later");
  assert.equal(plan.delays.get(edgeKey("a", "b")), GROW_STEP_MS / 2, "the arrow into b shows after b");
  assert.equal(plan.delays.get(edgeKey("b", "c")), GROW_STEP_MS + GROW_STEP_MS / 2, "the arrow into c shows after c");
});

test("an arrow added between two nodes already shown appears at once", () => {
  const nodes = [makeNode("a", "concept"), makeNode("b", "skill")];
  const plan = growthPlan(snapshotOf(graphOf(nodes, {})), graphOf(nodes, { b: ["a"] }));
  assert.equal(plan.addedNodes, 0);
  assert.equal(plan.delays.get(edgeKey("a", "b")), 0);
});

test("growing from an empty snapshot animates every node", () => {
  const nodes = [makeNode("a", "concept"), makeNode("b", "skill")];
  const plan = growthPlan(EMPTY_SNAPSHOT, graphOf(nodes, { b: ["a"] }));
  assert.equal(plan.addedNodes, 2);
  assert.ok(plan.delays.has("a") && plan.delays.has("b"));
});

test("the canvas marks only new nodes and arrows, and a repeat draw marks none", () => {
  const first = [makeNode("a", "concept"), makeNode("b", "skill")];
  const second = [...first, makeNode("c", "skill")];
  const { document } = parseHTML("<!doctype html><html><body><div id=\"host\"></div></body></html>");
  const host = document.getElementById("host") as HTMLElement;
  const controller = new AbortController();
  const canvas = createRoadmapCanvas(document as unknown as Document, host, controller.signal, {
    selectNode() {},
    toggleModule() {},
  });
  const state = (nodes: readonly PathNode[], after: Record<string, string[]>): CanvasState => ({
    path: pathWith(nodes),
    selectedNodeId: null,
    expandedModuleId: null,
    view: "tree",
    showOptional: true,
    showLegend: false,
    prerequisites: prerequisites(after, nodes),
  });
  const growing = (): string[] =>
    [...host.querySelectorAll<HTMLElement>(".rm-stage .rm-node.rm-grow")].map((node) => node.dataset.nodeId ?? "");
  try {
    canvas.render(state(first, { b: ["a"] }));
    assert.deepEqual(growing(), [], "first drawing is not animated");

    canvas.render(state(second, { b: ["a"], c: ["b"] }));
    assert.deepEqual(growing(), ["c"], "only the saved node animates");
    assert.ok(host.querySelectorAll(".rm-edges .rm-grow").length >= 1, "its arrow animates too");
    assert.equal(host.querySelector(".rm-grow-status")?.textContent, "Added to the graph: 1");

    canvas.render(state(second, { b: ["a"], c: ["b"] }));
    assert.deepEqual(growing(), [], "a re-draw with no change does not replay the animation");

    canvas.clear();
    canvas.render(state(second, { b: ["a"], c: ["b"] }));
    assert.equal(growing().length, 3, "a roadmap drawn after the graph was emptied grows in from nothing");
  } finally {
    canvas.dispose();
    controller.abort();
  }
});
