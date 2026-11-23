/** Graph arrangement: layered crossing reduction in both directions, long arrows routed through free lanes,
 * no arrow through a node it does not connect, and bounded size. */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { LearningPath, PathModule, PathNode } from "../src/domain.ts";
import type { NodePrerequisites } from "../src/node-prerequisites.ts";
import { COL_W, drawnWidth, layoutGraph } from "../src/view/roadmap-layout.ts";
import type { GraphDirection, RoadmapLayout } from "../src/view/roadmap-layout.ts";
import { makeNode, makePath } from "./fixtures.ts";
import { ownerShape, randomDag } from "./graph-arrangement-fixtures.ts";

const DIRECTIONS: readonly GraphDirection[] = ["bottom-to-top", "left-to-right"];

type Pt = { readonly x: number; readonly y: number };

function build(after: Record<string, string[]>): { path: LearningPath; prerequisites: NodePrerequisites[] } {
  const nodes: PathNode[] = Object.keys(after).map((id) => makeNode(id, "concept", { title: `Node ${id}` }));
  const path: LearningPath = { ...makePath(), modules: [{ id: "m", title: "M", nodes } as PathModule] };
  return { path, prerequisites: nodes.map((n) => ({ nodeId: n.id, prerequisiteIds: after[n.id] ?? [], source: "node" as const })) };
}

const lay = (after: Record<string, string[]>, direction: GraphDirection): RoadmapLayout => {
  const { path, prerequisites } = build(after);
  return layoutGraph(path, { showOptional: true, prerequisites, direction });
};

function polyline(edge: RoadmapLayout["edges"][number]): Pt[] {
  return [{ x: edge.x1, y: edge.y1 }, ...(edge.points ?? []), { x: edge.x2, y: edge.y2 }];
}

/** Does the segment a-b pass through the open inside of the box (slab clipping)? */
function crossesBox(a: Pt, b: Pt, box: { x1: number; y1: number; x2: number; y2: number }): boolean {
  let t0 = 0;
  let t1 = 1;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  for (const [p, q, lo, hi] of [[dx, a.x, box.x1, box.x2], [dy, a.y, box.y1, box.y2]] as const) {
    if (p === 0) {
      if (q <= lo || q >= hi) return false;
    } else {
      const ta = (lo - q) / p;
      const tb = (hi - q) / p;
      t0 = Math.max(t0, Math.min(ta, tb));
      t1 = Math.min(t1, Math.max(ta, tb));
      if (t0 >= t1) return false;
    }
  }
  return true;
}

/** Every "A->B through C" in the layout, using the drawn extent of each node (dot, title, tags). */
function throughNodes(layout: RoadmapLayout): string[] {
  const found: string[] = [];
  for (const edge of layout.edges) {
    const pts = polyline(edge);
    for (const n of layout.nodes) {
      if (n.node.id === edge.from || n.node.id === edge.to) continue;
      const box = { x1: n.x, y1: n.y, x2: n.x + drawnWidth(n), y2: n.y + n.h };
      for (let i = 1; i < pts.length; i += 1) {
        if (crossesBox(pts[i - 1]!, pts[i]!, box)) {
          found.push(`${edge.from}->${edge.to} through ${n.node.id}`);
          break;
        }
      }
    }
  }
  return found;
}

const orient = (a: Pt, b: Pt, c: Pt): number => Math.sign((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));

/** Proper crossings between segments of two different arrows that do not share a node. */
function crossings(layout: RoadmapLayout): number {
  let count = 0;
  const lines = layout.edges.map((edge) => ({ edge, pts: polyline(edge) }));
  for (let i = 0; i < lines.length; i += 1) {
    for (let j = i + 1; j < lines.length; j += 1) {
      const a = lines[i]!;
      const b = lines[j]!;
      if (a.edge.from === b.edge.from || a.edge.to === b.edge.to || a.edge.from === b.edge.to || a.edge.to === b.edge.from) continue;
      for (let s = 1; s < a.pts.length; s += 1) {
        for (let u = 1; u < b.pts.length; u += 1) {
          const p1 = a.pts[s - 1]!;
          const p2 = a.pts[s]!;
          const p3 = b.pts[u - 1]!;
          const p4 = b.pts[u]!;
          if (orient(p1, p2, p3) * orient(p1, p2, p4) < 0 && orient(p3, p4, p1) * orient(p3, p4, p2) < 0) count += 1;
        }
      }
    }
  }
  return count;
}

test("60 random DAGs, both directions: no arrow passes through a node it does not connect", () => {
  let count = 0;
  for (const size of [8, 15, 25, 40, 60]) {
    for (let seed = 1; seed <= 6; seed += 1) {
      const after = randomDag(size, seed * 101 + size);
      for (const direction of DIRECTIONS) {
        const layout = lay(after, direction);
        assert.equal(layout.nodes.length, size);
        assert.deepEqual(throughNodes(layout), [], `${direction}, ${size} nodes, seed ${seed}`);
        count += 1;
      }
    }
  }
  assert.equal(count, 60);
});

test("arrows start at the prerequisite and end at the dependent, on the side of the direction", () => {
  for (const direction of DIRECTIONS) {
    const layout = lay(ownerShape(), direction);
    const at = new Map(layout.nodes.map((n) => [n.node.id, n] as const));
    for (const edge of layout.edges) {
      const from = at.get(edge.from)!;
      const to = at.get(edge.to)!;
      if (direction === "bottom-to-top") {
        assert.ok(edge.y1 > edge.y2, "points up");
        assert.ok(edge.y1 >= from.y && edge.y1 <= from.y + from.h && edge.y2 >= to.y && edge.y2 <= to.y + to.h);
      } else {
        assert.ok(edge.x1 < edge.x2, "points right");
        assert.ok(edge.y1 >= from.y && edge.y1 <= from.y + from.h && edge.y2 >= to.y && edge.y2 <= to.y + to.h);
      }
    }
  }
});

// Crossings of the owner-shaped fixture before this change (old arrangement, measured with the same counter).
const CROSSINGS_BEFORE: Record<GraphDirection, number> = { "bottom-to-top": 31, "left-to-right": 21 };


test("the owner-shaped fixture has no more crossings than before, in both directions", () => {
  for (const direction of DIRECTIONS) {
    const layout = lay(ownerShape(), direction);
    assert.equal(layout.nodes.length, 40);
    assert.ok(crossings(layout) <= CROSSINGS_BEFORE[direction], `${direction}: ${crossings(layout)} > ${CROSSINGS_BEFORE[direction]}`);
  }
});

test("a 12-deep chain stays bounded: left to right at most 12 columns wide, bottom to top one row wide", () => {
  const after: Record<string, string[]> = {};
  for (let i = 0; i < 12; i += 1) after[`c${i}`] = i === 0 ? [] : [`c${i - 1}`];
  const across = lay(after, "left-to-right");
  assert.ok(across.width <= 12 * COL_W + 160, `width ${across.width}`);
  const up = lay(after, "bottom-to-top");
  assert.ok(up.width <= 400, `width ${up.width}`);
  assert.ok(up.height <= 12 * 80 + 400, `height ${up.height}`);
  for (const layout of [across, up]) assert.ok(layout.edges.every((edge) => edge.points === undefined), "a chain is straight");
});

test("left to right: a wide layer wraps so the height stays bounded", () => {
  const after: Record<string, string[]> = {};
  for (let i = 0; i < 40; i += 1) after[`r${i}`] = [];
  const layout = lay(after, "left-to-right");
  assert.ok(layout.height < 14 * 40 + 400, `height ${layout.height}`);
});
