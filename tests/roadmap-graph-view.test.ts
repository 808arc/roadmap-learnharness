/** The one graph view: arrows follow prerequisites, nodes stack without a cap, cycles terminate,
 * optional nodes are dashed, module info is a label and a colour, and both languages carry the strings.
 * Layout geometry is tested here, the look in roadmap-graph-style.test.ts. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import type { LearningPath, PathModule, PathNode } from "../src/domain.ts";
import { DEFAULT_DISPLAY, parsePluginSettings, validatePluginSettings } from "../src/domain.ts";
import { locale, setLocale, t, tables } from "../src/i18n.ts";
import type { MessageKey } from "../src/i18n.ts";
import type { NodePrerequisites } from "../src/node-prerequisites.ts";
import { createRoadmapCanvas } from "../src/view/roadmap-canvas.ts";
import type { CanvasState } from "../src/view/roadmap-canvas.ts";
import { NODE_H, NODE_ROW, buildDependencyGraph, layoutGraph } from "../src/view/roadmap-layout.ts";
import { makeNode, makePath } from "./fixtures.ts";

const { parseHTML } = createRequire(import.meta.url)("linkedom") as {
  parseHTML(html: string): { document: Document };
};

/** One module holding the given nodes, on top of the standard fixture path. */
function pathWith(nodes: readonly PathNode[]): LearningPath {
  const modules: PathModule[] = [{ id: "module-graph", title: "Graph", nodes }];
  return { ...makePath(), modules };
}

/** Explicit prerequisites: `after` maps a node id to the ids it depends on. */
function prerequisites(after: Record<string, string[]>, nodes: readonly PathNode[]): NodePrerequisites[] {
  return nodes.map((node) => ({ nodeId: node.id, prerequisiteIds: after[node.id] ?? [], source: "node" as const }));
}

test("a prerequisite chain gets arrows from each prerequisite to its dependent, pointing up", () => {
  // Listed out of order on purpose: the arrows follow prerequisites, not the list.
  const nodes = [makeNode("c", "concept"), makeNode("a", "concept"), makeNode("b", "concept")];
  const path = pathWith(nodes);
  const layout = layoutGraph(path, { showOptional: true, prerequisites: prerequisites({ b: ["a"], c: ["b"] }, nodes) });
  const arrows = layout.edges.map((edge) => `${edge.from}->${edge.to}`).sort();
  assert.deepEqual(arrows, ["a->b", "b->c"]);
  const depth = (id: string): number => layout.nodes.find((placed) => placed.node.id === id)!.depth;
  assert.deepEqual([depth("a"), depth("b"), depth("c")], [0, 1, 2]);
  for (const edge of layout.edges) {
    assert.ok(edge.y1 > edge.y2, `${edge.from} -> ${edge.to} runs bottom to top`);
  }
});

test("a node with five children gets five arrows, and all five are placed in the next row", () => {
  const parent = makeNode("root", "concept");
  const children = ["one", "two", "three", "four", "five"].map((id) => makeNode(id, "skill"));
  const nodes = [parent, ...children];
  const after = Object.fromEntries(children.map((child) => [child.id, ["root"]]));
  const layout = layoutGraph(pathWith(nodes), { showOptional: true, prerequisites: prerequisites(after, nodes) });
  assert.equal(layout.edges.filter((edge) => edge.from === "root").length, 5);
  const placed = children.map((child) => layout.nodes.find((entry) => entry.node.id === child.id)!);
  assert.ok(placed.every((entry) => entry.depth === 1 && entry.y === placed[0]!.y));
  // Five positions in one row, none shared.
  assert.equal(new Set(placed.map((entry) => entry.x)).size, 5);
});

test("a prerequisite cycle terminates, and exactly the edge that closes it is ignored", () => {
  const nodes = [makeNode("a", "concept"), makeNode("b", "concept"), makeNode("c", "concept"), makeNode("d", "concept")];
  const path = pathWith(nodes);
  // a needs b, b needs c, c needs a (the cycle), and d needs c.
  const prereqs = prerequisites({ a: ["b"], b: ["c"], c: ["a"], d: ["c"] }, nodes);
  const graph = buildDependencyGraph(path, { showOptional: true, prerequisites: prereqs });
  // Walk starts at a, follows a -> b -> c, then c's prerequisite a is still open: that edge (a before c) is dropped.
  assert.deepEqual(graph.ignored, [{ from: "a", to: "c" }]);
  assert.equal(graph.depth.get("c"), 0);
  assert.equal(graph.depth.get("b"), 1);
  assert.equal(graph.depth.get("d"), 1);
  assert.equal(graph.depth.get("a"), 2);
  const layout = layoutGraph(path, { showOptional: true, prerequisites: prereqs });
  assert.equal(layout.nodes.length, 4, "every node is still placed");
  assert.ok(layout.edges.every((edge) => !(edge.from === "a" && edge.to === "c")));
});

test("optional nodes get dashed arrows, and hiding one reconnects its neighbours", () => {
  const nodes = [makeNode("a", "concept"), makeNode("opt", "bridge", { optional: true }), makeNode("c", "concept")];
  const path = pathWith(nodes);
  const prereqs = prerequisites({ opt: ["a"], c: ["opt"] }, nodes);
  const shown = layoutGraph(path, { showOptional: true, prerequisites: prereqs });
  assert.deepEqual(
    shown.edges.map((edge) => [edge.from, edge.to, edge.dashed]),
    [
      ["a", "opt", true],
      ["opt", "c", true],
    ],
  );
  const hidden = layoutGraph(path, { showOptional: false, prerequisites: prereqs });
  assert.deepEqual(hidden.edges.map((edge) => [edge.from, edge.to, edge.dashed]), [["a", "c", false]]);
});

test("a depth with many nodes keeps every node and wraps into several rows instead of one long band", () => {
  const nodes = Array.from({ length: 30 }, (_, index) => makeNode(`n${index}`, "skill"));
  const layout = layoutGraph(pathWith(nodes), { showOptional: true, prerequisites: prerequisites({}, nodes) });
  assert.equal(layout.nodes.length, 30, "no node is dropped");
  assert.ok(layout.nodes.every((placed) => placed.depth === 0), "wrapping keeps the depth");
  const wrapped = new Map<number, typeof layout.nodes[number][]>();
  for (const placed of layout.nodes) wrapped.set(placed.y, [...(wrapped.get(placed.y) ?? []), placed]);
  assert.ok(wrapped.size >= 4, `30 nodes at one depth use several rows (got ${wrapped.size})`);
  for (const row of wrapped.values()) {
    const sorted = [...row].sort((a, b) => a.x - b.x);
    for (let i = 1; i < sorted.length; i += 1) assert.ok(sorted[i]!.x >= sorted[i - 1]!.x + sorted[i - 1]!.w, "no two nodes of a row overlap");
  }
  assert.ok(layout.width < 10 * layout.nodes[0]!.w, `the band stays narrow (width ${layout.width})`);
  const across = layoutGraph(pathWith(nodes), { showOptional: true, prerequisites: prerequisites({}, nodes), direction: "left-to-right" });
  const rows = [...across.nodes].sort((a, b) => a.y - b.y);
  for (let i = 1; i < rows.length; i += 1) assert.ok(rows[i]!.y >= rows[i - 1]!.y + NODE_ROW, "left to right: rows keep their pitch");
  assert.ok(across.height >= 29 * NODE_ROW + NODE_H, "left to right: the canvas grows with the column");
});

test("the graph renders every child of a node, with one module label and no frame", () => {
  const parent = makeNode("root", "concept");
  const children = ["one", "two", "three", "four", "five"].map((id) => makeNode(id, "skill"));
  const nodes = [parent, ...children];
  const after = Object.fromEntries(children.map((child) => [child.id, ["root"]]));
  const { document } = parseHTML("<!doctype html><html><body><div id=\"host\"></div></body></html>");
  const host = document.getElementById("host") as HTMLElement;
  const controller = new AbortController();
  const canvas = createRoadmapCanvas(document as unknown as Document, host, controller.signal, {
    selectNode() {},
    toggleModule() {},
  });
  const state: CanvasState = {
    path: pathWith(nodes),
    selectedNodeId: null,
    expandedModuleId: null,
    showOptional: true,
    showLegend: false,
    prerequisites: prerequisites(after, nodes),
  };
  try {
    canvas.render(state);
    const ids = [...host.querySelectorAll<HTMLElement>(".rm-stage .rm-node")].map((node) => node.dataset.nodeId);
    for (const id of ["root", "one", "two", "three", "four", "five"]) assert.ok(ids.includes(id), `graph shows ${id}`);
    assert.equal(host.querySelectorAll(".rm-box").length, 0, "no module frame");
    assert.equal(host.querySelectorAll(".rm-module-label").length, 1, "the module is labelled once");
    assert.equal(host.querySelectorAll(".rm-edges line").length, 5, "one arrow per child");
    assert.equal(host.querySelector(".rm-text-toggle"), null, "no text-only toggle");
    assert.equal(host.querySelector(".rm-text-tree"), null, "no text list");
  } finally {
    canvas.dispose();
    controller.abort();
  }
});

test("the interface strings exist in both languages, and the removed Tree strings are gone", () => {
  const keys: MessageKey[] = ["legend.arrow", "legend.moduleOrder", "legend.prerequisitesNote", "graph.dirUp", "graph.dirRight", "mark.optionalShort", "mark.alternativeShort"];
  try {
    for (const key of keys) {
      setLocale("en");
      const english = t(key);
      setLocale("ru");
      const russian = t(key);
      assert.ok(english.length > 0 && english !== key, `${key} has English`);
      assert.ok(russian.length > 0 && russian !== key, `${key} has Russian`);
    }
    setLocale("ru");
    assert.equal(locale(), "ru");
    for (const removed of ["view.tree", "view.graph", "tree.textOnly", "tree.expand", "tree.collapse", "s.defaultView", "s.defaultViewHelp", "graph.knowledgeEmpty"]) {
      assert.ok(!(removed in tables.en) && !(removed in tables.ru), `${removed} is removed`);
    }
  } finally {
    setLocale("en");
  }
});

test("the graph layout labels each module and places each node by dependency depth", () => {
  const nodes = [makeNode("a", "concept"), makeNode("b", "skill"), makeNode("c", "skill")];
  const layout = layoutGraph(pathWith(nodes), {
    direction: "left-to-right",
    showOptional: true,
    prerequisites: prerequisites({ b: ["a"], c: ["a"] }, nodes),
  });
  assert.deepEqual(layout.modules.map((label) => label.module.id), ["module-graph"], "one label for the one module");
  const depth = (id: string): number => layout.nodes.find((placed) => placed.node.id === id)!.depth;
  assert.deepEqual([depth("a"), depth("b"), depth("c")], [0, 1, 1]);
  assert.deepEqual(layout.edges.map((edge) => `${edge.from}->${edge.to}`).sort(), ["a->b", "a->c"]);
  assert.ok(layout.nodes.every((placed) => placed.moduleId === "module-graph"), "nodes keep their module id");
});

test("display settings no longer carry a default view; an old saved one is ignored", () => {
  assert.equal("defaultView" in DEFAULT_DISPLAY, false);
  const old = parsePluginSettings({ artifactDefaults: {}, display: { defaultView: "tree" } }).display!;
  assert.equal("defaultView" in old, false, "a saved view is dropped on read");
  assert.equal(validatePluginSettings({ artifactDefaults: {}, display: { defaultView: "list" } }).ok, true, "an old saved value still validates");
});
