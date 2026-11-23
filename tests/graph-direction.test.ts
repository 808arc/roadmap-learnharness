/** Graph direction: bottom to top by default (depth as rows, first prerequisites at the bottom), left to right
 * as before, arrows on the matching sides, and the toggle on the canvas. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import type { LearningPath, PathModule, PathNode } from "../src/domain.ts";
import type { NodePrerequisites } from "../src/node-prerequisites.ts";
import { tables } from "../src/i18n.ts";
import { createRoadmapCanvas } from "../src/view/roadmap-canvas.ts";
import type { CanvasState } from "../src/view/roadmap-canvas.ts";
import { PILL_H, PILL_W, layoutGraph } from "../src/view/roadmap-layout.ts";
import type { GraphDirection } from "../src/view/roadmap-layout.ts";
import { makeNode, makePath } from "./fixtures.ts";

const { parseHTML } = createRequire(import.meta.url)("linkedom") as {
  parseHTML(html: string): { document: Document };
};

const nodes: PathNode[] = [makeNode("a", "concept"), makeNode("b", "skill"), makeNode("c", "skill"), makeNode("d", "skill")];
const after: Record<string, string[]> = { b: ["a"], c: ["a"], d: ["b", "c"] };
const path: LearningPath = { ...makePath(), modules: [{ id: "m", title: "M", nodes } as PathModule] };
const prerequisites: NodePrerequisites[] = nodes.map((node) => ({ nodeId: node.id, prerequisiteIds: after[node.id] ?? [], source: "node" as const }));
const layoutOf = (direction?: GraphDirection) => layoutGraph(path, { showOptional: true, prerequisites, ...(direction ? { direction } : {}) });
const at = (layout: ReturnType<typeof layoutOf>, id: string) => layout.nodes.find((placed) => placed.node.id === id)!;

test("the default direction is bottom to top: depth 0 has the largest y", () => {
  const layout = layoutOf();
  assert.deepEqual(layout, layoutOf("bottom-to-top"));
  assert.ok(at(layout, "a").y > at(layout, "b").y);
  assert.ok(at(layout, "b").y > at(layout, "d").y);
  assert.equal(at(layout, "b").y, at(layout, "c").y, "same depth, same row");
  assert.notEqual(at(layout, "b").x, at(layout, "c").x, "siblings spread along the row");
  for (const placed of layout.nodes) {
    assert.equal(placed.w, PILL_W);
    assert.equal(placed.h, PILL_H);
    assert.ok(placed.x + placed.w <= layout.width && placed.y + placed.h <= layout.height, "inside the layout");
  }
});

test("left to right keeps the old geometry: depth is the column, depth 0 is leftmost", () => {
  const layout = layoutOf("left-to-right");
  assert.ok(at(layout, "a").x < at(layout, "b").x && at(layout, "b").x < at(layout, "d").x);
  assert.equal(at(layout, "b").x, at(layout, "c").x);
  assert.notEqual(at(layout, "b").y, at(layout, "c").y);
  for (const edge of layout.edges) {
    assert.equal(edge.x1, at(layout, edge.from).x + PILL_W);
    assert.equal(edge.x2, at(layout, edge.to).x);
  }
});

test("bottom to top: arrows leave the prerequisite's top and enter the dependent's bottom", () => {
  const layout = layoutOf("bottom-to-top");
  assert.deepEqual(layout.edges.map((edge) => `${edge.from}->${edge.to}`).sort(), ["a->b", "a->c", "b->d", "c->d"]);
  for (const edge of layout.edges) {
    const from = at(layout, edge.from);
    const to = at(layout, edge.to);
    assert.equal(edge.y1, from.y, "starts at the prerequisite's top edge");
    assert.equal(edge.y2, to.y + to.h, "ends at the dependent's bottom edge");
    assert.equal(edge.x1, from.x + from.w / 2);
    assert.equal(edge.x2, to.x + to.w / 2);
    assert.ok(edge.y1 > edge.y2, "arrow points up");
  }
});

function renderCanvas(direction?: GraphDirection) {
  const { document } = parseHTML('<!doctype html><html><body><div id="host"></div></body></html>');
  const host = document.getElementById("host") as HTMLElement;
  const controller = new AbortController();
  const picked: GraphDirection[] = [];
  const canvas = createRoadmapCanvas(document as unknown as Document, host, controller.signal, {
    selectNode() {},
    toggleModule() {},
    setGraphDirection: (value) => picked.push(value),
  });
  const state: CanvasState = {
    path, selectedNodeId: null, expandedModuleId: null, view: "graph", showOptional: true, showLegend: false, prerequisites,
    ...(direction ? { graphDirection: direction } : {}),
  };
  canvas.render(state);
  return { host, picked, dispose: () => { canvas.dispose(); controller.abort(); } };
}

test("the toggle renders two buttons and marks the current direction pressed", () => {
  for (const [direction, pressed] of [[undefined, "bottom-to-top"], ["left-to-right", "left-to-right"]] as const) {
    const view = renderCanvas(direction);
    try {
      const buttons = [...view.host.querySelectorAll<HTMLButtonElement>(".rm-direction button")];
      assert.deepEqual(buttons.map((button) => button.dataset.direction), ["bottom-to-top", "left-to-right"]);
      assert.deepEqual(buttons.map((button) => button.textContent), ["↑ bottom to top", "→ left to right"]);
      for (const button of buttons) assert.equal(button.getAttribute("aria-pressed"), String(button.dataset.direction === pressed));
      buttons[1]!.click();
      assert.deepEqual(view.picked, ["left-to-right"]);
    } finally {
      view.dispose();
    }
  }
});

test("the direction strings exist in both languages", () => {
  for (const language of ["en", "ru"] as const) {
    for (const key of ["graph.dirUp", "graph.dirRight"] as const) assert.ok(tables[language][key], `${language} ${key}`);
  }
});
