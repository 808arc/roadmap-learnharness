import assert from "node:assert/strict";
import { test } from "node:test";
import type { LearningPath, PathNode, PivotSuggestion } from "../src/domain.ts";
import { nodeConnections } from "../src/node-connections.ts";
import { createNodeInspector } from "../src/view/node-inspector.ts";
import { makeNode, makePath } from "./fixtures.ts";
import { buttonByText } from "./roadmap-dom.ts";
import { createViewFixture } from "./view-host.ts";

const AT = "2026-03-01T10:00:00Z";

/** A synthetic roadmap: a is a root; b builds on a; c builds on a and b; d (second module) builds on c. */
function syntheticRoadmap(extra: { a?: PathNode["pivotSuggestions"] } = {}): LearningPath {
  const a = makeNode("n-a", "concept", { title: "Alpha", prerequisites: [], pivotSuggestions: extra.a ?? [] });
  const b = makeNode("n-b", "concept", { title: "Beta", prerequisites: ["n-a"] });
  const c = makeNode("n-c", "concept", { title: "Gamma", prerequisites: ["n-a", "n-b"] });
  const d = makeNode("n-d", "concept", { title: "Delta", prerequisites: ["n-c"] });
  const base = makePath();
  return {
    ...base,
    modules: [
      { id: "m-1", title: "First", nodes: [a, b] },
      { id: "m-2", title: "Second", nodes: [c, d] },
    ],
  };
}

function nodeById(path: LearningPath, id: string): PathNode {
  const found = path.modules.flatMap((module) => module.nodes).find((node) => node.id === id);
  assert.ok(found, `node ${id} exists`);
  return found;
}

function acceptedPivot(insertedNodeId: string): PivotSuggestion {
  return {
    id: "pv-1",
    status: "accepted",
    proposalType: "bridge",
    title: "Bridge to Epsilon",
    rationale: "A missing step.",
    createdAt: AT,
    resolvedAt: AT,
    insertedNodeId,
  };
}

test("builds on and needed by are derived from the roadmap's prerequisites", () => {
  const path = syntheticRoadmap();

  const b = nodeConnections(path, nodeById(path, "n-b"));
  assert.deepEqual(b.buildsOn.map((node) => node.id), ["n-a"]);
  assert.deepEqual(b.neededBy.map((node) => node.id), ["n-c"]);

  const c = nodeConnections(path, nodeById(path, "n-c"));
  assert.deepEqual(c.buildsOn.map((node) => node.id), ["n-a", "n-b"]);
  assert.deepEqual(c.neededBy.map((node) => node.id), ["n-d"]);

  const a = nodeConnections(path, nodeById(path, "n-a"));
  assert.deepEqual(a.buildsOn, []);
  assert.deepEqual(a.neededBy.map((node) => node.id), ["n-b", "n-c"]);

  const d = nodeConnections(path, nodeById(path, "n-d"));
  assert.deepEqual(d.buildsOn.map((node) => node.id), ["n-c"]);
  assert.deepEqual(d.neededBy, []);
  assert.equal(d.createdFrom, null);
});

test("a pivot-created node names the node whose accepted pivot inserted it", () => {
  const path = syntheticRoadmap({ a: [acceptedPivot("n-inserted")] });
  const inserted = makeNode("n-inserted", "bridge", { title: "Bridge to Epsilon" });
  const withInserted: LearningPath = {
    ...path,
    modules: path.modules.map((module, index) => (index === 0 ? { ...module, nodes: [...module.nodes, inserted] } : module)),
  };

  assert.equal(nodeConnections(withInserted, inserted).createdFrom?.id, "n-a");
  assert.equal(nodeConnections(withInserted, nodeById(withInserted, "n-a")).createdFrom, null);
});

function mountInspector(path: LearningPath, selected: PathNode[]) {
  const fixture = createViewFixture();
  const inspector = createNodeInspector(fixture.context, fixture.root, fixture.context.signal, {
    openSession() {},
    linkExistingSession() {},
    startSession() {},
    unlinkSession() {},
    selectNode(nodeId) {
      selected.push(nodeById(path, nodeId));
    },
    updateNode() {},
    updateError() {},
    decidePivot() {},
    discussPivot() {},
  });
  return { fixture, inspector };
}

test("the node panel shows the pivot source for a pivot-created node", () => {
  const path = syntheticRoadmap({ a: [acceptedPivot("n-inserted")] });
  const inserted = makeNode("n-inserted", "bridge", { title: "Bridge to Epsilon" });
  const full: LearningPath = {
    ...path,
    modules: path.modules.map((module, index) => (index === 0 ? { ...module, nodes: [...module.nodes, inserted] } : module)),
  };
  const selected: PathNode[] = [];
  const { fixture, inspector } = mountInspector(full, selected);
  try {
    inspector.render(full, inserted);
    const text = fixture.root.textContent ?? "";
    assert.match(text, /Connections/);
    assert.match(text, /Created from/);
    assert.equal(text.includes("Builds on"), false);
    assert.equal(text.includes("Needed by"), false);
    buttonByText(fixture.root, "Alpha").click();
    assert.deepEqual(selected.map((node) => node.id), ["n-a"]);
  } finally {
    inspector.dispose();
    fixture.restore();
  }
});

test("a node with no connections shows no Connections section", () => {
  const path = makePath();
  const lonely = makeNode("n-lonely", "concept", { title: "Lonely", prerequisites: [] });
  const full: LearningPath = {
    ...path,
    modules: path.modules.map((module, index) => (index === 0 ? { ...module, nodes: [...module.nodes, lonely] } : module)),
  };
  const { fixture, inspector } = mountInspector(full, []);
  try {
    inspector.render(full, lonely);
    const text = fixture.root.textContent ?? "";
    assert.equal(text.includes("Connections"), false);
    assert.equal(text.includes("Builds on"), false);
    assert.equal(text.includes("Needed by"), false);
    assert.equal(text.includes("Created from"), false);
  } finally {
    inspector.dispose();
    fixture.restore();
  }
});

test("only the non-empty subsection is shown, and clicking a linked node selects it", () => {
  const path = syntheticRoadmap();
  const selected: PathNode[] = [];
  const { fixture, inspector } = mountInspector(path, selected);
  try {
    // d builds on c and nothing needs d, so only "Builds on" shows.
    inspector.render(path, nodeById(path, "n-d"));
    const text = fixture.root.textContent ?? "";
    assert.match(text, /Connections/);
    assert.match(text, /Builds on/);
    assert.equal(text.includes("Needed by"), false);
    assert.equal(text.includes("Created from"), false);

    buttonByText(fixture.root, "Gamma").click();
    assert.deepEqual(selected.map((node) => node.id), ["n-c"]);
  } finally {
    inspector.dispose();
    fixture.restore();
  }
});

test("the interleaved label differs from Builds on, so a node with both shows Builds on once", () => {
  const path = syntheticRoadmap();
  const c = nodeById(path, "n-c");
  const interleaved: PathNode = { ...c, interleavesNodeIds: ["n-a", "n-b"] };
  const full: LearningPath = {
    ...path,
    modules: path.modules.map((module) => ({ ...module, nodes: module.nodes.map((node) => (node.id === c.id ? interleaved : node)) })),
  };
  const { fixture, inspector } = mountInspector(full, []);
  try {
    inspector.render(full, interleaved);
    const text = fixture.root.textContent ?? "";
    assert.equal(text.split("Builds on").length - 1, 1);
    assert.match(text, /Interleaves with/);
  } finally {
    inspector.dispose();
    fixture.restore();
  }
});
