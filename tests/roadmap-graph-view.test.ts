/** Dependency graph view: arrows follow prerequisites, nodes stack without a cap,
 * the tree nests and collapses, cycles terminate, optional nodes are dashed, and
 * both languages carry the new strings. Layout geometry is tested, not the look. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import type { LearningPath, PathModule, PathNode } from "../src/domain.ts";
import { locale, setLocale, t } from "../src/i18n.ts";
import type { MessageKey } from "../src/i18n.ts";
import type { NodePrerequisites } from "../src/node-prerequisites.ts";
import { createRoadmapCanvas } from "../src/view/roadmap-canvas.ts";
import type { CanvasState } from "../src/view/roadmap-canvas.ts";
import { DEFAULT_DISPLAY, VIEW_MODES, parsePluginSettings, validatePluginSettings } from "../src/domain.ts";
import { ROW, SUB_H, buildDependencyGraph, layoutGraph, layoutRoadmap } from "../src/view/roadmap-layout.ts";
import { makeNode, makePath } from "./fixtures.ts";
import { readKnowledgeGraph } from "../src/backend.ts";
import { layoutKnowledge, readKnowledge } from "../src/view/knowledge-layout.ts";

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

test("a prerequisite chain gets arrows from each prerequisite to its dependent, pointing right", () => {
  // Listed out of order on purpose: the arrows follow prerequisites, not the list.
  const nodes = [makeNode("c", "concept"), makeNode("a", "concept"), makeNode("b", "concept")];
  const path = pathWith(nodes);
  const layout = layoutRoadmap(path, {
    expandedModuleId: null,
    showOptional: true,
    prerequisites: prerequisites({ b: ["a"], c: ["b"] }, nodes),
  });
  const arrows = layout.edges.map((edge) => `${edge.from}->${edge.to}`).sort();
  assert.deepEqual(arrows, ["a->b", "b->c"]);
  const depth = (id: string): number => layout.nodes.find((placed) => placed.node.id === id)!.depth;
  assert.deepEqual([depth("a"), depth("b"), depth("c")], [0, 1, 2]);
  for (const edge of layout.edges) {
    assert.ok(edge.x1 < edge.x2, `${edge.from} -> ${edge.to} runs left to right`);
  }
});

test("a node with five children gets five arrows, and all five are placed in the next column", () => {
  const parent = makeNode("root", "concept");
  const children = ["one", "two", "three", "four", "five"].map((id) => makeNode(id, "skill"));
  const nodes = [parent, ...children];
  const after = Object.fromEntries(children.map((child) => [child.id, ["root"]]));
  const layout = layoutRoadmap(pathWith(nodes), { expandedModuleId: null, showOptional: true, prerequisites: prerequisites(after, nodes) });
  assert.equal(layout.edges.filter((edge) => edge.from === "root").length, 5);
  const placed = children.map((child) => layout.nodes.find((entry) => entry.node.id === child.id)!);
  assert.equal(placed.length, 5);
  assert.ok(placed.every((entry) => entry.depth === 1 && entry.x === placed[0]!.x));
  // Five rows in one column, no row shared.
  assert.equal(new Set(placed.map((entry) => entry.y)).size, 5);
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
  const layout = layoutRoadmap(path, { expandedModuleId: null, showOptional: true, prerequisites: prereqs });
  assert.equal(layout.nodes.length, 4, "every node is still placed");
  assert.ok(layout.edges.every((edge) => !(edge.from === "a" && edge.to === "c")));
});

test("optional nodes get dashed arrows, and hiding one reconnects its neighbours", () => {
  const nodes = [makeNode("a", "concept"), makeNode("opt", "bridge", { optional: true }), makeNode("c", "concept")];
  const path = pathWith(nodes);
  const prereqs = prerequisites({ opt: ["a"], c: ["opt"] }, nodes);
  const shown = layoutRoadmap(path, { expandedModuleId: null, showOptional: true, prerequisites: prereqs });
  assert.deepEqual(
    shown.edges.map((edge) => [edge.from, edge.to, edge.dashed]),
    [
      ["a", "opt", true],
      ["opt", "c", true],
    ],
  );
  const hidden = layoutRoadmap(path, { expandedModuleId: null, showOptional: false, prerequisites: prereqs });
  assert.deepEqual(hidden.edges.map((edge) => [edge.from, edge.to, edge.dashed]), [["a", "c", false]]);
});

test("a column with many nodes keeps every node, stacked in rows without overlap", () => {
  const nodes = Array.from({ length: 30 }, (_, index) => makeNode(`n${index}`, "skill"));
  const path = pathWith(nodes);
  const layout = layoutRoadmap(path, {
    expandedModuleId: null,
    showOptional: true,
    prerequisites: prerequisites({}, nodes),
  });
  assert.equal(layout.nodes.length, 30, "no node is dropped");
  assert.equal(new Set(layout.nodes.map((placed) => placed.y)).size, 30, "one row per node");
  const sorted = [...layout.nodes].sort((a, b) => a.y - b.y);
  for (let i = 1; i < sorted.length; i += 1) assert.ok(sorted[i]!.y >= sorted[i - 1]!.y + ROW, "rows keep their pitch");
  assert.ok(layout.height >= 29 * ROW + SUB_H, "the canvas grows with the column");
});

test("the tree renders all five children of a node", () => {
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
  const state = (view: CanvasState["view"]): CanvasState => ({
    path: pathWith(nodes),
    selectedNodeId: null,
    expandedModuleId: null,
    view,
    showOptional: true,
    showLegend: false,
    prerequisites: prerequisites(after, nodes),
  });
  try {
    canvas.render(state("tree"));
    const treeIds = [...host.querySelectorAll<HTMLElement>(".rm-stage .rm-node")].map((node) => node.dataset.nodeId);
    for (const id of ["root", "one", "two", "three", "four", "five"]) assert.ok(treeIds.includes(id), `tree shows ${id}`);
    assert.equal(host.querySelectorAll(".rm-box").length, 0, "tree draws no module frame");
    assert.equal(host.querySelectorAll(".rm-module-label").length, 1, "tree labels the module");
  } finally {
    canvas.dispose();
    controller.abort();
  }
});

test("the new interface strings exist in both languages", () => {
  const keys: MessageKey[] = ["legend.arrow", "legend.moduleOrder", "tree.expand", "tree.collapse", "tree.alsoAfter", "view.tree", "view.graph", "s.defaultViewHelp"];
  try {
    for (const key of keys) {
      setLocale("en");
      const english = t(key, { titles: "X" });
      setLocale("ru");
      const russian = t(key, { titles: "X" });
      assert.ok(english.length > 0 && english !== key, `${key} has English`);
      assert.ok(russian.length > 0 && russian !== key, `${key} has Russian`);
    }
    setLocale("ru");
    assert.equal(t("tree.expand"), "Развернуть");
    assert.equal(t("view.graph"), "Граф");
    assert.equal(t("view.tree"), "Дерево");
    assert.equal(locale(), "ru");
  } finally {
    setLocale("en");
  }
});

test("the two views render: the roadmap tree by default and the learner's Knowledge Graph", () => {
  const parent = makeNode("root", "concept");
  const children = ["one", "two"].map((id) => makeNode(id, "skill"));
  const nodes = [parent, ...children];
  const after = Object.fromEntries(children.map((child) => [child.id, ["root"]]));
  const { document } = parseHTML("<!doctype html><html><body><div id=\"host\"></div></body></html>");
  const host = document.getElementById("host") as HTMLElement;
  const controller = new AbortController();
  const canvas = createRoadmapCanvas(document as unknown as Document, host, controller.signal, {
    selectNode() {},
    toggleModule() {},
  });
  const state = (view: CanvasState["view"]): CanvasState => ({
    path: pathWith(nodes),
    selectedNodeId: null,
    expandedModuleId: null,
    view,
    showOptional: true,
    showLegend: false,
    prerequisites: prerequisites(after, nodes),
    knowledge: {
      nodes: [
        { id: "p1", name: "Premise", statement: "A premise." },
        { id: "p2", name: "Other premise", statement: "Another." },
        { id: "c1", name: "Conclusion", statement: "A conclusion." },
      ],
      edges: [
        { from: "p1", to: "c1" },
        { from: "p2", to: "c1" },
      ],
    },
  });
  const visible = (selector: string): boolean => !host.querySelector<HTMLElement>(selector)!.hidden;
  try {
    assert.equal(DEFAULT_DISPLAY.defaultView, "tree", "the default view is the tree");
    assert.deepEqual([...VIEW_MODES], ["tree", "graph"]);

    canvas.render(state("tree"));
    assert.equal(host.querySelectorAll(".rm-box").length, 0, "tree draws no module frame");
    assert.ok(host.querySelector(".rm-module-label[data-module-id=\"module-graph\"]"), "tree labels the module");
    assert.ok(visible(".rm-viewport"), "tree shows the canvas");

    canvas.render(state("graph"));
    assert.equal(host.querySelectorAll(".rm-module-label").length, 0, "graph draws no module labels");
    assert.equal(host.querySelectorAll(".rm-stage .rm-node").length, 3, "graph shows every proposition");
    assert.ok(host.querySelector('.rm-stage [data-proposition-id="c1"]'), "nodes are propositions, not roadmap nodes");
    assert.equal(host.querySelector('.rm-stage [data-node-id]'), null, "no roadmap node is drawn");
    assert.equal(host.querySelectorAll(".rm-edges line").length, 2, "graph draws the arrows");
    assert.ok(visible(".rm-viewport"), "graph shows the canvas");
    assert.equal(host.querySelector(".rm-tree"), null, "no text list is rendered");
  } finally {
    canvas.dispose();
    controller.abort();
  }
});

test("the graph layout has no module frames and places each node by dependency depth", () => {
  const nodes = [makeNode("a", "concept"), makeNode("b", "skill"), makeNode("c", "skill")];
  const layout = layoutGraph(pathWith(nodes), {
    direction: "left-to-right",
    showOptional: true,
    prerequisites: prerequisites({ b: ["a"], c: ["a"] }, nodes),
  });
  assert.deepEqual(layout.modules, [], "no module frames");
  const depth = (id: string): number => layout.nodes.find((placed) => placed.node.id === id)!.depth;
  assert.deepEqual([depth("a"), depth("b"), depth("c")], [0, 1, 1]);
  assert.deepEqual(layout.edges.map((edge) => `${edge.from}->${edge.to}`).sort(), ["a->b", "a->c"]);
  assert.ok(layout.nodes.every((placed) => placed.moduleId === "module-graph"), "nodes keep their module id");
});

test("the graph and tree default views validate; a saved list falls back to tree; an unknown view is rejected", () => {
  for (const view of ["graph", "tree"]) {
    assert.equal(parsePluginSettings({ artifactDefaults: {}, display: { defaultView: view } }).display?.defaultView, view);
  }
  assert.equal(parsePluginSettings({ artifactDefaults: {}, display: { defaultView: "list" } }).display?.defaultView, "tree", "a saved list is tree");
  assert.equal(validatePluginSettings({ artifactDefaults: {}, display: { defaultView: "list" } }).ok, true, "a saved list still validates");
  assert.equal((parsePluginSettings({ artifactDefaults: {} }).display ?? DEFAULT_DISPLAY).defaultView, "tree", "no saved value: tree");
  assert.equal(validatePluginSettings({ artifactDefaults: {}, display: { defaultView: "kanban" } }).ok, false);
});

test("the tree has a text-only rendering with the same modules and nodes", () => {
  const nodes = [makeNode("a", "concept"), makeNode("b", "skill")];
  const { document } = parseHTML("<!doctype html><html><body><div id=\"host\"></div></body></html>");
  const host = document.getElementById("host") as HTMLElement;
  const controller = new AbortController();
  const picked: string[] = [];
  const toggled: boolean[] = [];
  const canvas = createRoadmapCanvas(document as unknown as Document, host, controller.signal, {
    selectNode: (id) => picked.push(id),
    toggleModule() {},
    setTextOnly: (next) => toggled.push(next),
  });
  const state = (view: CanvasState["view"], textOnly: boolean): CanvasState => ({
    path: pathWith(nodes), selectedNodeId: null, expandedModuleId: null, view, showOptional: true, showLegend: false, textOnly,
  });
  try {
    canvas.render(state("tree", true));
    assert.equal(host.querySelector<HTMLElement>(".rm-text-tree")!.hidden, false);
    assert.equal(host.querySelector<HTMLElement>(".rm-viewport")!.hidden, true);
    assert.equal(host.querySelectorAll(".rm-text-module").length, 1);
    assert.equal(host.querySelectorAll(".rm-text-node").length, 2);
    assert.equal(host.querySelectorAll(".rm-stage .rm-node").length, 0, "no diagram nodes");
    host.querySelector<HTMLButtonElement>('.rm-text-open[data-node-id="b"]')!.click();
    assert.deepEqual(picked, ["b"]);
    host.querySelector<HTMLButtonElement>(".rm-text-toggle")!.click();
    assert.deepEqual(toggled, [false], "the toggle reports the opposite of the current mode");
    canvas.render(state("tree", false));
    assert.equal(host.querySelector<HTMLElement>(".rm-text-tree")!.hidden, true);
    assert.equal(host.querySelectorAll(".rm-stage .rm-node").length, 2);
    canvas.render(state("graph", true));
    assert.equal(host.querySelector<HTMLElement>(".rm-text-tree")!.hidden, true, "text-only belongs to the tree");
    assert.equal(host.querySelector<HTMLElement>(".rm-text-toggle")!.hidden, true);
  } finally {
    canvas.dispose();
    controller.abort();
  }
});

test("an empty Knowledge Graph says so; the layout puts premises before conclusions and survives cycles", () => {
  const { document } = parseHTML("<!doctype html><html><body><div id=\"host\"></div></body></html>");
  const host = document.getElementById("host") as HTMLElement;
  const controller = new AbortController();
  const canvas = createRoadmapCanvas(document as unknown as Document, host, controller.signal, { selectNode() {}, toggleModule() {} });
  try {
    canvas.render({ path: makePath(), selectedNodeId: null, expandedModuleId: null, view: "graph", showOptional: true, showLegend: false });
    assert.equal(host.querySelector(".rm-kg-empty")?.textContent, t("graph.knowledgeEmpty"));
  } finally {
    canvas.dispose();
    controller.abort();
  }
  const data = {
    nodes: ["a", "b", "c"].map((id) => ({ id, name: id, statement: id })),
    edges: [{ from: "a", to: "b" }, { from: "b", to: "c" }, { from: "c", to: "a" }],
  };
  assert.equal(layoutKnowledge(data).nodes.length, 3, "a cycle keeps every node");
  const chain = layoutKnowledge({ ...data, edges: data.edges.slice(0, 2) });
  const y = (id: string): number => chain.nodes.find((entry) => entry.node.id === id)!.y;
  assert.ok(y("a") > y("b") && y("b") > y("c"), "bottom to top: premises sit lower");
  assert.deepEqual(readKnowledge({ nodes: [{ id: "x", name: "X" }, { id: 3 }], edges: [{ from: "x", to: "nope" }] }), {
    nodes: [{ id: "x", name: "X", statement: "" }],
    edges: [],
  });
});

test("graph.knowledge turns stored propositions and chains into nodes and premise-to-conclusion arrows", () => {
  const node = (id: string) => ({ id, name: id.toUpperCase(), statement: `${id} holds`, aliases: [], createdAt: "t", provenance: [] });
  const chain = (id: string, premises: string[], conclusion: string) => ({ id, premises, conclusion, provenance: [], createdAt: "t" });
  const graph = {
    propositions: [node("a"), node("b"), node("c")],
    chains: [chain("x1", ["a", "b"], "c"), chain("x2", ["a"], "c"), chain("x3", ["a"], "gone")],
  };
  const result = readKnowledgeGraph({ graph: () => graph } as never);
  assert.deepEqual(result.nodes.map((entry) => entry.id), ["a", "b", "c"]);
  assert.deepEqual(result.edges, [{ from: "a", to: "c" }, { from: "b", to: "c" }]);
});
