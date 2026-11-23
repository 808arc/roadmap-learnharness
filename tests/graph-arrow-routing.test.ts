/** Graph arrows route around nodes they do not connect; clear arrows stay straight lines. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import type { LearningPath, PathModule, PathNode } from "../src/domain.ts";
import type { NodePrerequisites } from "../src/node-prerequisites.ts";
import { createRoadmapCanvas } from "../src/view/roadmap-canvas.ts";
import type { CanvasState } from "../src/view/roadmap-canvas.ts";
import { layoutGraph } from "../src/view/roadmap-layout.ts";
import type { GraphDirection } from "../src/view/roadmap-layout.ts";
import { makeNode, makePath } from "./fixtures.ts";

const { parseHTML } = createRequire(import.meta.url)("linkedom") as { parseHTML(html: string): { document: Document } };

function build(after: Record<string, string[]>): { path: LearningPath; prerequisites: NodePrerequisites[] } {
  const nodes: PathNode[] = Object.keys(after).map((id) => makeNode(id, "concept"));
  const path: LearningPath = { ...makePath(), modules: [{ id: "m", title: "M", nodes } as PathModule] };
  return { path, prerequisites: nodes.map((n) => ({ nodeId: n.id, prerequisiteIds: after[n.id] ?? [], source: "node" as const })) };
}
// The long arrow a -> d passes the middle rows, which hold several pills.
const crossing: Record<string, string[]> = { a: [], b: ["a"], b2: ["a"], b3: ["a"], c: ["b", "b2", "b3"], c2: ["b2"], d: ["c", "a", "c2"] };
const clearer: Record<string, string[]> = { a: [], b: ["a"], c: ["b"] };

const lay = (after: Record<string, string[]>, direction: GraphDirection) => {
  const { path, prerequisites } = build(after);
  return layoutGraph(path, { showOptional: true, prerequisites, direction });
};

function hits(a: { x: number; y: number }, b: { x: number; y: number }, n: { x: number; y: number; w: number; h: number }): boolean {
  for (let i = 0; i <= 400; i += 1) {
    const x = a.x + ((b.x - a.x) * i) / 400;
    const y = a.y + ((b.y - a.y) * i) / 400;
    if (x > n.x && x < n.x + n.w && y > n.y && y < n.y + n.h) return true;
  }
  return false;
}

test("bottom to top: the straight a -> d arrow would cross a pill, so it has points and no segment touches an unrelated node", () => {
  const layout = lay(crossing, "bottom-to-top");
  const long = layout.edges.find((e) => e.from === "a" && e.to === "d")!;
  const straightCrosses = layout.nodes.some((n) => n.node.id !== "a" && n.node.id !== "d" && hits({ x: long.x1, y: long.y1 }, { x: long.x2, y: long.y2 }, n));
  assert.ok(straightCrosses, "fixture: the straight line crosses a node");
  assert.ok(long.points && long.points.length > 0);
  for (const edge of layout.edges) {
    const pts = [{ x: edge.x1, y: edge.y1 }, ...(edge.points ?? []), { x: edge.x2, y: edge.y2 }];
    for (const n of layout.nodes) {
      if (n.node.id === edge.from || n.node.id === edge.to) continue;
      for (let i = 1; i < pts.length; i += 1) assert.equal(hits(pts[i - 1]!, pts[i]!, n), false, `${edge.from}->${edge.to} crosses ${n.node.id}`);
    }
  }
});

test("a clear arrow has no points", () => {
  for (const direction of ["bottom-to-top", "left-to-right"] as const) {
    for (const edge of lay(clearer, direction).edges) assert.equal(edge.points, undefined);
  }
});

function draw(after: Record<string, string[]>) {
  const { path, prerequisites } = build(after);
  const { document } = parseHTML('<!doctype html><html><body><div id="host"></div></body></html>');
  const host = document.getElementById("host") as HTMLElement;
  const controller = new AbortController();
  const canvas = createRoadmapCanvas(document as unknown as Document, host, controller.signal, {
    selectNode() {},
    toggleModule() {},
    setGraphDirection() {},
  });
  const state: CanvasState = { path, selectedNodeId: null, expandedModuleId: null, view: "graph", showOptional: true, showLegend: false, prerequisites };
  canvas.render(state);
  return { host, dispose: () => { canvas.dispose(); controller.abort(); } };
}

test("canvas: clear edges keep line and arrowhead elements; a routed edge draws a polyline with its arrowhead", () => {
  const clear = draw(clearer);
  try {
    assert.equal(clear.host.querySelectorAll(".rm-edges line").length, 2);
    assert.equal(clear.host.querySelectorAll(".rm-edges polyline").length, 0);
    assert.equal(clear.host.querySelectorAll(".rm-edges path.rm-arrow").length, 2);
  } finally {
    clear.dispose();
  }
  const routed = draw(crossing);
  try {
    const poly = routed.host.querySelectorAll(".rm-edges polyline").length;
    assert.ok(poly > 0);
    assert.equal(routed.host.querySelectorAll(".rm-edges line").length + poly, routed.host.querySelectorAll(".rm-edges path.rm-arrow").length);
  } finally {
    routed.dispose();
  }
});
