/** Graph arrows route around nodes they do not connect; clear arrows stay straight lines. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import type { LearningPath, PathModule, PathNode } from "../src/domain.ts";
import type { NodePrerequisites } from "../src/node-prerequisites.ts";
import { createRoadmapCanvas } from "../src/view/roadmap-canvas.ts";
import type { CanvasState } from "../src/view/roadmap-canvas.ts";
import { drawnWidth, layoutGraph } from "../src/view/roadmap-layout.ts";
import type { GraphDirection } from "../src/view/roadmap-layout.ts";
import { makeNode, makePath } from "./fixtures.ts";
import { setAutoReplay } from "../src/view/graph-replay.ts";

setAutoReplay(false); // these tests look at the plain graph, not the replay

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

/** Does the segment a-b touch what is drawn of node n (its dot, title and tags, not the empty rest of its cell)? */
function hits(a: { x: number; y: number }, b: { x: number; y: number }, n: Parameters<typeof drawnWidth>[0]): boolean {
  const right = n.x + drawnWidth(n);
  for (let i = 0; i <= 400; i += 1) {
    const x = a.x + ((b.x - a.x) * i) / 400;
    const y = a.y + ((b.y - a.y) * i) / 400;
    if (x > n.x && x < right && y > n.y && y < n.y + n.h) return true;
  }
  return false;
}

test("bottom to top: the long a -> d arrow runs through free space, and no segment touches an unrelated node", () => {
  const layout = lay(crossing, "bottom-to-top");
  const long = layout.edges.find((e) => e.from === "a" && e.to === "d")!;
  assert.ok(long.points && long.points.length > 0, "the long arrow bends through its own lane");
  for (const edge of layout.edges) {
    const pts = [{ x: edge.x1, y: edge.y1 }, ...(edge.points ?? []), { x: edge.x2, y: edge.y2 }];
    for (const n of layout.nodes) {
      if (n.node.id === edge.from || n.node.id === edge.to) continue;
      for (let i = 1; i < pts.length; i += 1) assert.equal(hits(pts[i - 1]!, pts[i]!, n), false, `${edge.from}->${edge.to} crosses ${n.node.id}`);
    }
  }
});

test("a wide, tangled roadmap: wrapped rows, and no arrow crosses a node it does not connect, in either direction", () => {
  // 30 nodes; each node needs up to two earlier nodes picked by a fixed rule, so arrows skip several rows.
  const after: Record<string, string[]> = {};
  for (let i = 0; i < 30; i += 1) after[`t${i}`] = i < 8 ? [] : [`t${(i * 7) % i}`, `t${(i * 3 + 1) % i}`].filter((id, k, all) => all.indexOf(id) === k);
  for (const direction of ["bottom-to-top", "left-to-right"] as const) {
    const layout = lay(after, direction);
    for (const edge of layout.edges) {
      const pts = [{ x: edge.x1, y: edge.y1 }, ...(edge.points ?? []), { x: edge.x2, y: edge.y2 }];
      for (const n of layout.nodes) {
        if (n.node.id === edge.from || n.node.id === edge.to) continue;
        for (let i = 1; i < pts.length; i += 1) assert.equal(hits(pts[i - 1]!, pts[i]!, n), false, `${direction}: ${edge.from}->${edge.to} crosses ${n.node.id}`);
      }
    }
  }
  const up = lay(after, "bottom-to-top");
  assert.ok(up.width < 4 * up.height, `bottom to top uses the height, not one wide band (${up.width}x${up.height})`);
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
  const state: CanvasState = { path, selectedNodeId: null, expandedModuleId: null, showOptional: true, showLegend: false, prerequisites };
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
