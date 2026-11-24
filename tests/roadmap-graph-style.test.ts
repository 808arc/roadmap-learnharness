/** The one graph view's look: dots with titles (no boxes), dashed optional nodes, flag checkpoints, the selected
 * node's ring, arrows from prerequisite to dependent, and module info as a label and a colour (no frames). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { LearningPath, PathModule, PathNode } from "../src/domain.ts";
import type { NodePrerequisites } from "../src/node-prerequisites.ts";
import { createRoadmapCanvas } from "../src/view/roadmap-canvas.ts";
import type { CanvasState } from "../src/view/roadmap-canvas.ts";
import { DOT_D, DOT_X, drawnWidth, layoutGraph } from "../src/view/roadmap-layout.ts";
import { makeNode, makePath } from "./fixtures.ts";
import { setAutoReplay } from "../src/view/graph-replay.ts";

setAutoReplay(false); // these tests look at the plain graph, not the replay

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
  assert.ok(Math.abs(at("c").y - at("b").y) >= at("b").h + 8, "generous spacing between stacked nodes");
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

test("the opt. tag is hidden until hover, focus or selection; the dashed class stays on", () => {
  const nodes = [makeNode("a", "concept"), makeNode("opt", "bridge", { optional: true })];
  const view = renderGraph(nodes, { opt: ["a"] });
  try {
    const optional = button(view.host, "opt");
    assert.ok(optional.classList.contains("rm-opt"), "the dashed outline does not depend on hover");
    assert.ok(optional.querySelector(".rm-node-tag.rm-node-tag-opt"), "the opt. tag carries the hide-until-hover class");
  } finally {
    view.dispose();
  }
  const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  assert.match(css, /^\.rm-node-tag-opt \{\s*display: none;/m, "the opt. tag is hidden by default");
  for (const state of [":hover", ":focus-visible", ".rm-sel"]) {
    assert.ok(css.includes(`.rm-node${state} .rm-node-tag-opt`), `the opt. tag shows on ${state}`);
  }
});

test("checkpoint nodes are flag-marked", () => {
  const nodes = [makeNode("a", "concept"), makeNode("check", "checkpoint")];
  const view = renderGraph(nodes, { check: ["a"] });
  try {
    const checkpoint = button(view.host, "check");
    assert.ok(checkpoint.classList.contains("rm-check"), "checkpoint has the checkpoint class");
    assert.ok(checkpoint.querySelector(".rm-dot.rm-flag svg"), "checkpoint carries the flag icon in place of the dot");
    assert.ok(!button(view.host, "a").querySelector(".rm-flag"), "other nodes have no flag");
  } finally {
    view.dispose();
  }
});

test("only the selected node gets the selection class", () => {
  const nodes = [makeNode("a", "concept"), makeNode("b", "skill"), makeNode("c", "skill")];
  const view = renderGraph(nodes, { b: ["a"], c: ["a"] }, "b");
  try {
    assert.ok(button(view.host, "b").classList.contains("rm-sel"), "selected node is ringed");
    assert.equal(view.host.querySelectorAll(".rm-sel").length, 1, "exactly one selected node");
    assert.ok(!button(view.host, "a").classList.contains("rm-sel"));
  } finally {
    view.dispose();
  }
});

test("left to right: arrows run from the end of each prerequisite's title to its dependent's dot", () => {
  const nodes = [makeNode("a", "concept"), makeNode("b", "skill"), makeNode("c", "skill")];
  const after = { b: ["a"], c: ["b"] };
  const layout = layoutGraph(pathWith(nodes), { direction: "left-to-right", showOptional: true, prerequisites: prerequisites(after, nodes) });
  const at = (id: string) => layout.nodes.find((placed) => placed.node.id === id)!;
  assert.deepEqual(layout.edges.map((edge) => `${edge.from}->${edge.to}`).sort(), ["a->b", "b->c"]);
  for (const edge of layout.edges) {
    assert.equal(edge.x1, at(edge.from).x + drawnWidth(at(edge.from)) + 2, "arrow starts at the end of the prerequisite's title");
    assert.equal(edge.x2, at(edge.to).x + DOT_X - DOT_D / 2, "arrow ends at the dependent's dot");
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

test("the graph draws dots and titles: no pill boxes, no module frames, no alternative brackets", () => {
  const nodes = [makeNode("a", "concept"), makeNode("b", "skill", { alternativeGroup: "g" }), makeNode("c", "skill", { alternativeGroup: "g" })];
  const view = renderGraph(nodes, { b: ["a"], c: ["a"] });
  try {
    assert.equal(view.host.querySelectorAll(".rm-pill, .rm-alt-group, .rm-module, .rm-frame").length, 0, "no boxes or frames");
    assert.equal(view.host.querySelectorAll(".rm-stage .rm-node .rm-dot").length, 3, "one dot per node");
    const alt = button(view.host, "b");
    assert.ok(alt.classList.contains("rm-alt"));
    assert.ok(alt.textContent?.includes("alt."), "alternatives keep their alt. tag");
    assert.ok(!button(view.host, "a").textContent?.includes("alt."));
  } finally {
    view.dispose();
  }
});

test("progress shows on the dot: done, in progress, skipped", () => {
  const nodes = [
    makeNode("a", "concept", { progression: "consolidated" }),
    makeNode("b", "skill", { progression: "in_progress" }),
    makeNode("c", "skill", { progression: "skipped" }),
    makeNode("d", "skill"),
  ];
  const view = renderGraph(nodes, { b: ["a"], c: ["b"], d: ["c"] });
  try {
    assert.ok(button(view.host, "a").classList.contains("rm-done"));
    assert.ok(button(view.host, "b").classList.contains("rm-prog"));
    assert.ok(button(view.host, "c").classList.contains("rm-skip"));
    for (const state of ["rm-done", "rm-prog", "rm-skip"]) assert.ok(!button(view.host, "d").classList.contains(state));
  } finally {
    view.dispose();
  }
});

test("each module shows as one small label at its first node and a colour class on its nodes", () => {
  const path = makePath();
  const { document } = parseHTML("<!doctype html><html><body><div id=\"host\"></div></body></html>");
  const host = document.getElementById("host") as HTMLElement;
  const controller = new AbortController();
  const toggled: string[] = [];
  const canvas = createRoadmapCanvas(document as unknown as Document, host, controller.signal, {
    selectNode() {},
    toggleModule: (id) => toggled.push(id),
  });
  try {
    canvas.render({ path, selectedNodeId: null, expandedModuleId: path.modules[1]!.id, showOptional: true, showLegend: false });
    const labels = [...host.querySelectorAll<HTMLElement>(".rm-stage .rm-module-label")];
    assert.deepEqual(labels.map((label) => label.textContent), path.modules.map((module) => module.title), "one label per module, in order");
    assert.ok(labels[1]!.classList.contains("rm-module-label-focus"), "the focused module's label is marked");
    assert.notEqual(labels[0]!.className.match(/rm-mod-\d/)?.[0], labels[1]!.className.match(/rm-mod-\d/)?.[0], "modules get different colours");
    for (const [index, module] of path.modules.entries()) {
      for (const node of module.nodes) {
        assert.ok(button(host, node.id).classList.contains(`rm-mod-${index}`), `${node.id} carries its module's colour`);
        assert.ok(button(host, node.id).title.includes(module.title), "the tooltip names the module");
      }
    }
    labels[0]!.click();
    assert.deepEqual(toggled, [path.modules[0]!.id], "clicking a label focuses its module");
  } finally {
    canvas.dispose();
    controller.abort();
  }
});
