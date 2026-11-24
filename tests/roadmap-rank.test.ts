/** Ranking roadmaps by graph coverage: best match, a second only at half the count, none for no overlap. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { rankRoadmaps } from "../src/roadmap-rank.ts";

const keys = new Set(["a", "b", "c", "d"]);

test("the roadmap covering the most graph topics is chosen first", () => {
  const ranking = rankRoadmaps(keys, new Map([
    ["small", ["a", "x"]],
    ["best", ["a", "b", "c", "y"]],
  ]));
  assert.equal(ranking.chosen[0]?.roadmap, "best");
  assert.equal(ranking.chosen[0]?.matched, 3);
  assert.equal(ranking.chosen[0]?.total, 4);
});

test("a second roadmap is chosen only when it covers at least half as many graph topics", () => {
  const ranking = rankRoadmaps(keys, new Map([
    ["best", ["a", "b", "c", "d"]],
    ["half", ["a", "b"]],
    ["less", ["a"]],
  ]));
  assert.deepEqual(ranking.chosen.map((match) => match.roadmap), ["best", "half"]);
  assert.deepEqual(ranking.candidates.map((match) => match.roadmap), ["best", "half", "less"]);
});

test("a roadmap below half the best count is not chosen", () => {
  const ranking = rankRoadmaps(keys, new Map([
    ["best", ["a", "b", "c", "d"]],
    ["less", ["a"]],
  ]));
  assert.deepEqual(ranking.chosen.map((match) => match.roadmap), ["best"]);
});

test("roadmaps with no graph overlap are never chosen", () => {
  const ranking = rankRoadmaps(keys, new Map([["unrelated", ["p", "q"]]]));
  assert.deepEqual(ranking.chosen, []);
  assert.deepEqual(ranking.candidates, []);
});

test("ties go to the more focused roadmap, then by name", () => {
  const ranking = rankRoadmaps(new Set(["a"]), new Map([
    ["zeta", ["a", "b"]],
    ["alpha", ["a", "c", "d"]],
    ["beta", ["a", "e"]],
  ]));
  assert.deepEqual(ranking.candidates.map((match) => match.roadmap), ["beta", "zeta", "alpha"]);
});

test("roadmap names come from the git copy after its fetch has finished, with no GitHub request", async () => {
  const { listRoadmapNames } = await import("../src/upstream-roadmaps.ts");
  const order: string[] = [];
  let calls = 0;
  const fetch = async () => {
    calls += 1;
    throw new Error("no request expected");
  };
  let finish!: (ok: boolean) => void;
  const ready = new Promise<boolean>((resolve) => (finish = resolve));
  const local = {
    ready,
    listFiles: async () => null,
    readFile: async () => null,
    listRoadmaps: async () => {
      order.push("listed");
      return ["frontend", "backend"];
    },
  };
  const pending = listRoadmapNames("a".repeat(40), { local, fetch } as never);
  order.push("waiting");
  finish(true);
  assert.deepEqual(await pending, ["backend", "frontend"]);
  assert.deepEqual(order, ["waiting", "listed"]);
  assert.equal(calls, 0);
});

test("with no exact match, the closest roadmap by near matches is chosen", () => {
  const ranking = rankRoadmaps(new Set(["binary-search", "time-complexity", "heat-wall"]), new Map([
    ["unrelated", ["css-basics", "html-forms"]],
    ["algorithms", ["sorting-algorithms", "time-complexity-analysis", "search-trees"]],
    ["systems", ["distributed-systems", "scheduling"]],
  ]));
  assert.deepEqual(ranking.chosen.map((match) => match.roadmap), ["algorithms"]);
  assert.deepEqual(ranking.candidates.map((match) => match.roadmap), ["algorithms"]);
  assert.equal(ranking.chosen[0]?.matched, 0);
  assert.equal(ranking.chosen[0]?.near, 2);
});

test("with no exact match, a second near roadmap is chosen only at half the best score", () => {
  const ranking = rankRoadmaps(new Set(["react-hooks", "node-streams", "css-grid"]), new Map([
    ["frontend", ["react-state", "css-layout"]],
    ["backend", ["node-cluster"]],
    ["weak", ["grid-paper"]],
    ["zero", ["python-basics"]],
  ]));
  assert.deepEqual(ranking.chosen.map((match) => match.roadmap), ["frontend", "backend"]);
  assert.ok(!ranking.candidates.some((match) => match.roadmap === "zero"));
});

test("a learner whose topics match no roadmap exactly still gets the closest roadmap", () => {
  const ranking = rankRoadmaps(new Set(["react-hooks", "react-routing"]), new Map([
    ["frontend", ["react-state", "html-basics"]],
    ["devops", ["docker-compose"]],
  ]));
  assert.deepEqual(ranking.chosen.map((match) => match.roadmap), ["frontend"]);
});

test("while some roadmap matches exactly, a near-only roadmap is not chosen, even with the top score", () => {
  const ranking = rankRoadmaps(new Set(["alpha-one", "beta-two", "gamma-three"]), new Map([
    ["exact", ["alpha-one"]],
    ["near", ["alpha-five", "beta-six", "gamma-seven"]],
  ]));
  assert.equal(ranking.candidates[0]?.roadmap, "near", "near has the top score");
  assert.equal(ranking.candidates[0]?.matched, 0);
  assert.deepEqual(ranking.chosen.map((match) => match.roadmap), ["exact"]);
});
