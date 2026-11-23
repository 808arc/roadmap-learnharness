/** Graph view look: left-to-right depth columns, pills, dashed optional nodes, flag checkpoints,
 * the highlighted current node, arrows from prerequisite to dependent, and no module frames. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import type { LearningPath, PathModule, PathNode } from "../src/domain.ts";
import type { NodePrerequisites } from "../src/node-prerequisites.ts";
import { createRoadmapCanvas } from "../src/view/roadmap-canvas.ts";
import type { CanvasState } from "../src/view/roadmap-canvas.ts";
import { layoutGraph } from "../src/view/roadmap-layout.ts";
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

/** Renders the graph view for `nodes` and returns the host plus a cleanup. */
function renderGraph(nodes: readonly PathNode[], after: Record<string, string[]>, selectedNodeId: string | null = null) {
  const { document } = parseHTML("<!doctype html><html><body><div id=\"host\"></div></body></html>");
  const host = document.getElementById("host") as HTMLElement;
  const controller = new AbortController();
  const canvas = createRoadmapCanvas(document as unknown as Document, host, controller.signal, {
    selectNode() {},
    toggleModule() {},
  });
  const state: CanvasState = {
    path: pathWith(nodes),
    selectedNodeId,
    expandedModuleId: null,
    view: "tree",
    showOptional: true,
    showLegend: false,
    prerequisites: prerequisites(after, nodes),
  };
  canvas.render(state);
  return {
    host,
    dispose() {
      canvas.dispose();
      controller.abort();
    },
  };
}

const button = (host: HTMLElement, id: string): HTMLElement => {
  const found = host.querySelector<HTMLElement>(`.rm-stage .rm-node[data-node-id="${id}"]`);
  assert.ok(found, `node ${id} is drawn`);
  return found;
};

test("graph layout places each node left to right by depth, stacked vertically within a column", () => {
  const nodes = [makeNode("a", "concept"), makeNode("b", "skill"), makeNode("c", "skill"), makeNode("d", "checkpoint")];
  const layout = layoutGraph(pathWith(nodes), {
    direction: "left-to-right",
    showOptional: true,
    prerequisites: prerequisites({ b: ["a"], c: ["a"], d: ["b", "c"] }, nodes),
  });
  const at = (id: string) => layout.nodes.find((placed) => placed.node.id === id)!;
  assert.ok(at("a").x < at("b").x && at("b").x < at("d").x, "depth 0 < 1 < 2 from left to right");
  assert.equal(at("b").x, at("c").x, "same depth shares a column");
  assert.notEqual(at("b").y, at("c").y, "same depth stacks vertically");
  assert.ok(Math.abs(at("c").y - at("b").y) >= at("b").h + 8, "generous spacing between stacked pills");
});

test("optional nodes get the dashed class and an opt. tag; their arrows are dashed", () => {
  const nodes = [makeNode("a", "concept"), makeNode("opt", "bridge", { optional: true }), makeNode("c", "concept")];
  const after = { opt: ["a"], c: ["opt"] };
  const view = renderGraph(nodes, after);
  try {
    const optional = button(view.host, "opt");
    assert.ok(optional.classList.contains("rm-opt"), "optional node is dashed");
    assert.ok(optional.textContent?.includes("opt."), "optional node carries the opt. tag");
    assert.ok(!button(view.host, "a").classList.contains("rm-opt"), "required node is not dashed");
    assert.equal(view.host.querySelectorAll(".rm-edges line.rm-dashed").length, 2, "both arrows touching the optional node are dashed");
  } finally {
    view.dispose();
  }
});

test("checkpoint nodes are flag-marked pills", () => {
  const nodes = [makeNode("a", "concept"), makeNode("check", "checkpoint")];
  const view = renderGraph(nodes, { check: ["a"] });
  try {
    const checkpoint = button(view.host, "check");
    assert.ok(checkpoint.classList.contains("rm-check"), "checkpoint has the checkpoint class");
    assert.ok(checkpoint.querySelector(".rm-node-icon.rm-flag"), "checkpoint carries the flag icon");
    assert.ok(!button(view.host, "a").querySelector(".rm-flag"), "other nodes have no flag");
  } finally {
    view.dispose();
  }
});

test("only the current (selected) node gets the highlight class", () => {
  const nodes = [makeNode("a", "concept"), makeNode("b", "skill"), makeNode("c", "skill")];
  const view = renderGraph(nodes, { b: ["a"], c: ["a"] }, "b");
  try {
    assert.ok(button(view.host, "b").classList.contains("rm-highlight"), "current node is highlighted");
    assert.equal(view.host.querySelectorAll(".rm-highlight").length, 1, "exactly one highlighted node");
    assert.ok(!button(view.host, "a").classList.contains("rm-highlight"));
  } finally {
    view.dispose();
  }
});

test("arrows run from each prerequisite's right edge to its dependent's left edge", () => {
  const nodes = [makeNode("a", "concept"), makeNode("b", "skill"), makeNode("c", "skill")];
  const after = { b: ["a"], c: ["b"] };
  const layout = layoutGraph(pathWith(nodes), { direction: "left-to-right", showOptional: true, prerequisites: prerequisites(after, nodes) });
  const at = (id: string) => layout.nodes.find((placed) => placed.node.id === id)!;
  assert.deepEqual(layout.edges.map((edge) => `${edge.from}->${edge.to}`).sort(), ["a->b", "b->c"]);
  for (const edge of layout.edges) {
    assert.equal(edge.x1, at(edge.from).x + at(edge.from).w, "arrow starts at the prerequisite's right edge");
    assert.equal(edge.x2, at(edge.to).x, "arrow ends at the dependent's left edge");
    assert.ok(edge.x1 < edge.x2, "arrow points right");
  }
  const view = renderGraph(nodes, after);
  try {
    const lines = [...view.host.querySelectorAll<SVGLineElement>(".rm-edges line")];
    assert.equal(lines.length, 2, "one line per arrow");
    assert.equal(view.host.querySelectorAll(".rm-edges .rm-arrow").length, 2, "one arrowhead per arrow");
  } finally {
    view.dispose();
  }
});

test("the graph layout draws no module frames or brackets", () => {
  const nodes = [makeNode("a", "concept"), makeNode("b", "skill", { alternativeGroup: "g" }), makeNode("c", "skill", { alternativeGroup: "g" })];
  const after = { b: ["a"], c: ["a"] };
  const layout = layoutGraph(pathWith(nodes), { direction: "left-to-right", showOptional: true, prerequisites: prerequisites(after, nodes) });
  assert.deepEqual(layout.modules, [], "no module frames in the layout");
  assert.deepEqual(layout.groups, [], "no alternative brackets in the layout");
});
