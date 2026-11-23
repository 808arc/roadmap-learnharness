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
