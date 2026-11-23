/** Tree view: each module label has clear room, away from nodes and arrows. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { LABEL_BOX_H, LABEL_CHAR_W, LABEL_H, LABEL_ROOM, layoutRoadmap } from "../src/view/roadmap-layout.ts";
import { makeNode, makePath } from "./fixtures.ts";

const mk = (id: string, title: string, prereq: string[], type: "concept" | "checkpoint" = "concept") => {
  return { ...makeNode(id, type, { title, prerequisites: prereq }), title };
};
function fixture() {
  const one = ["Processes", "Threads", "Memory", "Files", "Scheduling"].map((t, i) => mk(`a${i}`, t, i === 0 ? [] : [`a${i - 1}`]));
  const many = [mk("b0", "Sockets", ["a2"]), mk("b1", "RPC", ["b0"]), mk("b2", "Queues", ["b0"]), mk("b3", "Retries", ["b1"]), mk("b4", "Consensus", ["b2", "b3"])];
  const cost = [mk("c0", "Big-O", ["a1"]), mk("c1", "Amortized", ["c0"]), mk("c2", "Design", ["b4", "c1"], "checkpoint")];
  return {
    ...makePath(),
    modules: [
      { id: "m1", title: "One machine", nodes: one },
      { id: "m2", title: "Many machines", nodes: many },
      { id: "m3", title: "Cost of an algorithm", nodes: cost },
    ],
  };
}
const layout = layoutRoadmap(fixture() as never, { expandedModuleId: "m1", showOptional: true });
const boxOf = (m: (typeof layout.modules)[number]) => ({ x: m.labelAt!.x, y: m.labelAt!.y, w: m.module.title.length * LABEL_CHAR_W, h: LABEL_BOX_H });
const hit = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

test("one label per module, with an explicit position", () => {
  assert.equal(layout.modules.length, 3);
  for (const m of layout.modules) assert.ok(m.labelAt);
});

test("no label rectangle touches any node rectangle", () => {
  for (const m of layout.modules) for (const n of layout.nodes) assert.ok(!hit(boxOf(m), n), `${m.module.title} hits ${n.node.title}`);
});

test("no label rectangle crosses an arrow", () => {
  for (const m of layout.modules) {
    const b = boxOf(m);
    for (const e of layout.edges) {
      for (let i = 0; i <= 50; i += 1) {
        const x = e.x1 + ((e.x2 - e.x1) * i) / 50;
        const y = e.y1 + ((e.y2 - e.y1) * i) / 50;
        assert.ok(!(x > b.x && x < b.x + b.w && y > b.y && y < b.y + b.h), `${m.module.title} crosses arrow ${e.from}->${e.to}`);
      }
    }
  }
});

test("a label is at least LABEL_ROOM below the node above it in its column", () => {
  for (const m of layout.modules) {
    const above = layout.nodes.filter((n) => n.x === m.labelAt!.x && n.y + n.h <= m.labelAt!.y + LABEL_H - 1);
    for (const n of above) assert.ok(m.labelAt!.y - (n.y + n.h) >= LABEL_ROOM - 1e-6, `${m.module.title} too close to ${n.node.title}`);
  }
});
