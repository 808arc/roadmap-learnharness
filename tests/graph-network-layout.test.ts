/** Network placement: nodes in one column never overlap, and a node sits between the nodes it connects to. */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { PathNode } from "../src/domain.ts";
import { spreadColumns } from "../src/view/roadmap-layout.ts";
import { makeNode } from "./fixtures.ts";

const pitch = 40;

test("a node with two prerequisites sits between them, and nodes in a column never overlap", () => {
  const a = makeNode("a", "concept");
  const b = makeNode("b", "concept");
  const c = makeNode("c", "concept");
  const merge = makeNode("merge", "skill");
  const cells = new Map<number, PathNode[]>([
    [0, [a, b, c]],
    [1, [merge]],
  ]);
  const edges = [
    { from: "a", to: "merge" },
    { from: "c", to: "merge" },
  ];
  const y = spreadColumns(cells, edges, pitch);
  const mid = (y.get("a")! + y.get("c")!) / 2;
  assert.ok(Math.abs(y.get("merge")! - mid) < pitch, "the merge node lies near the middle of its two prerequisites");

  const column = [y.get("a")!, y.get("b")!, y.get("c")!].sort((p, q) => p - q);
  for (let index = 1; index < column.length; index += 1) {
    assert.ok(column[index]! - column[index - 1]! >= pitch, "nodes in a column keep at least one pitch between them");
  }
});

test("a single branch fans out: the children spread apart instead of stacking in one row", () => {
  const root = makeNode("root", "concept");
  const kids = ["x", "y", "z"].map((id) => makeNode(id, "skill"));
  const cells = new Map<number, PathNode[]>([
    [0, [root]],
    [1, kids],
  ]);
  const edges = kids.map((kid) => ({ from: "root", to: kid.id }));
  const y = spreadColumns(cells, edges, pitch);
  const offsets = kids.map((kid) => y.get(kid.id)!);
  assert.equal(new Set(offsets).size, 3, "three children get three different heights");
  assert.ok(Math.abs(y.get("root")! - (offsets[0]! + offsets[2]!) / 2) < pitch, "the root sits near the middle of its children");
});
