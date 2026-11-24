/** Graph replay: the graph is revealed layer by layer from the root; manual, never automatic. */
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import type { LearningPath, PathModule, PathNode } from "../src/domain.ts";
import { setLocale, tables } from "../src/i18n.ts";
import { REPLAY_STEP_MS, replayOf } from "../src/view/graph-replay.ts";
import { createRoadmapCanvas } from "../src/view/roadmap-canvas.ts";
import type { CanvasState } from "../src/view/roadmap-canvas.ts";
import { layoutGraph } from "../src/view/roadmap-layout.ts";
import type { NodePrerequisites } from "../src/node-prerequisites.ts";
import { makeNode, makePath } from "./fixtures.ts";

const { parseHTML } = createRequire(import.meta.url)("linkedom") as {
  parseHTML(html: string): { document: Document };
};

// root a -> b, c -> d (needs b and c) -> e
const nodes: PathNode[] = ["a", "b", "c", "d", "e"].map((id) => makeNode(id, "concept"));
const after: Record<string, string[]> = { b: ["a"], c: ["a"], d: ["b", "c"], e: ["d"] };
const prerequisites: NodePrerequisites[] = nodes.map((node) => ({
  nodeId: node.id,
  prerequisiteIds: after[node.id] ?? [],
  source: "node" as const,
}));
const modules: PathModule[] = [{ id: "module-graph", title: "Graph", nodes }];
const path: LearningPath = { ...makePath(), modules };

function mount() {
  const { document } = parseHTML("<!doctype html><html><body><div id='host'></div></body></html>");
  const host = document.getElementById("host") as HTMLElement;
  const controller = new AbortController();
  const canvas = createRoadmapCanvas(document, host, controller.signal, { selectNode() {}, toggleModule() {} });
  const state: CanvasState = { path, selectedNodeId: null, expandedModuleId: null, showOptional: true, showLegend: false, prerequisites };
  canvas.render(state);
  const press = (action: string) => (host.querySelector(`[data-replay="${action}"]`) as HTMLButtonElement).click();
  const shown = () => [...host.querySelectorAll("button.rm-node")].map((n) => (n as HTMLElement).dataset.nodeId!).sort();
  const caption = () => host.querySelector(".rm-replay-caption")!.textContent!;
  return { host, canvas, controller, state, press, shown, caption };
}

test("the reveal order starts at the root, one layer per step", () => {
  const layout = layoutGraph(path, { direction: "left-to-right", showOptional: true, prerequisites });
  const { steps } = replayOf(layout);
  assert.deepEqual(steps.map((s) => s.items.map((i) => i.node.node.id).sort()), [["a"], ["b", "c"], ["d"], ["e"]]);
  assert.deepEqual(steps[0]!.items[0]!.after, []);
});

test("the replay is off by default: every node is drawn", () => {
  const f = mount();
  assert.deepEqual(f.shown(), ["a", "b", "c", "d", "e"]);
  f.controller.abort();
});

test("step forward and back move the revealed set by exactly one layer", () => {
  const f = mount();
  f.press("forward");
  assert.deepEqual(f.shown(), ["a"]);
  f.press("forward");
  assert.deepEqual(f.shown(), ["a", "b", "c"]);
  f.press("forward");
  assert.deepEqual(f.shown(), ["a", "b", "c", "d"]);
  f.press("back");
  assert.deepEqual(f.shown(), ["a", "b", "c"]);
  f.press("back");
  f.press("back");
  assert.deepEqual(f.shown(), ["a"], "back stops at the root");
  f.controller.abort();
});

test("arrows of unrevealed nodes are not drawn", () => {
  const f = mount();
  const arrows = () => f.host.querySelectorAll(".rm-edges .rm-arrow").length;
  const full = arrows();
  f.press("forward");
  assert.equal(arrows(), 0);
  f.press("forward");
  assert.equal(arrows(), 2);
  assert.ok(full > 2);
  f.controller.abort();
});

test("play advances on a timer; pause stops at the same step; exit shows everything", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const f = mount();
    f.press("play");
    assert.deepEqual(f.shown(), ["a"]);
    mock.timers.tick(REPLAY_STEP_MS.normal);
    assert.deepEqual(f.shown(), ["a", "b", "c"]);
    f.press("play"); // pause
    mock.timers.tick(REPLAY_STEP_MS.normal * 5);
    assert.deepEqual(f.shown(), ["a", "b", "c"], "paused: no further step");
    f.press("play");
    for (let i = 0; i < 3; i++) mock.timers.tick(REPLAY_STEP_MS.normal);
    assert.deepEqual(f.shown(), ["a", "b", "c", "d", "e"], "plays to the end");
    f.press("exit");
    assert.deepEqual(f.shown(), ["a", "b", "c", "d", "e"]);
    assert.equal(f.host.querySelector(".rm-replay-caption")!.hasAttribute("hidden"), true);
    f.controller.abort();
  } finally {
    mock.timers.reset();
  }
});

test("speed cycles slow, normal, fast and changes the pace", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const f = mount();
    f.press("speed"); // normal -> fast
    f.press("play");
    mock.timers.tick(REPLAY_STEP_MS.fast);
    assert.deepEqual(f.shown(), ["a", "b", "c"]);
    f.controller.abort();
  } finally {
    mock.timers.reset();
  }
});

test("the caption names the node and the prerequisite it came from", () => {
  setLocale("en");
  const f = mount();
  f.press("forward");
  assert.match(f.caption(), /Step 1 of 4: root Node a/);
  f.press("forward");
  assert.match(f.caption(), /Node b \(after Node a\)/);
  f.press("forward");
  assert.match(f.caption(), /Node d \(after Node b, Node c\)/);
  setLocale("ru");
  f.press("forward");
  assert.match(f.caption(), /Node e \(после Node d\)/);
  setLocale("en");
  f.controller.abort();
});

test("EN and RU have every replay key", () => {
  for (const key of ["play", "pause", "back", "forward", "exit", "speed", "slow", "normal", "fast", "rootStep", "step", "item"]) {
    for (const locale of ["en", "ru"] as const) {
      assert.ok((tables[locale] as Record<string, string>)[`replay.${key}`], `${locale} replay.${key}`);
    }
  }
});
