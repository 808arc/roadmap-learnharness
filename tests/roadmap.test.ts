/** Tests for the Roadmap additions: layout, progress counting, node marks,
 * legacy import, session metrics and translations. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseLearningPath, parsePluginSettings, validatePluginSettings } from "../src/domain.ts";
import type { LearningPath, PathModule, PathNode } from "../src/domain.ts";
import { resolveLocale, setLocale, t } from "../src/i18n.ts";
import type { MessageKey } from "../src/i18n.ts";
import { IMPORT_MARKER, importLegacyData, legacyDataDirectory } from "../src/legacy-import.ts";
import { DEFAULT_BREAK_MS, sessionMetrics } from "../src/session-metrics.ts";
import {
  DOT_X,
  LABEL_H,
  PAD_BOTTOM,
  defaultExpandedModule,
  layoutGraph,
  moduleCounts,
  nodeRole,
  progressCounts,
} from "../src/view/roadmap-layout.ts";
import { makeNode, makePath, rawPath } from "./fixtures.ts";

const alternatives = (): PathNode[] => [
  makeNode("gcc", "skill", { alternativeGroup: "compiler", progression: "consolidated" }),
  makeNode("clang", "skill", { alternativeGroup: "compiler", progression: "skipped" }),
];

test("progress counts required work: optional nodes are excluded, an alternative group counts once", () => {
  const nodes = [
    makeNode("a", "concept", { progression: "consolidated" }),
    makeNode("b", "concept", { progression: "skipped" }),
    makeNode("c", "concept", { progression: "in_progress" }),
    makeNode("opt", "bridge", { optional: true, progression: "unstarted" }),
    ...alternatives(),
  ];
  assert.deepEqual(progressCounts(nodes), { done: 3, total: 4 });
  // A group where nobody is consolidated stays open even if a member is skipped.
  const open = progressCounts([makeNode("x", "skill", { alternativeGroup: "g", progression: "skipped" })]);
  assert.deepEqual(open, { done: 0, total: 1 });
});

test("node roles split an expanded module into order, additional and consolidation", () => {
  assert.equal(nodeRole(makeNode("a", "concept")), "order");
  assert.equal(nodeRole(makeNode("b", "concept", { optional: true })), "extra");
  assert.equal(nodeRole(makeNode("c", "skill", { alternativeGroup: "g" })), "extra");
  assert.equal(nodeRole(makeNode("d", "checkpoint")), "consolidation");
});

test("the graph draws no module frames: one small label per module, and every node sits in its dependency row", () => {
  const path = makePath();
  const layout = layoutGraph(path, { expandedModuleId: "module-synthesis", showOptional: true });

  assert.equal(layout.modules.length, path.modules.length, "one label per module");
  const [first, second] = layout.modules;
  assert.equal(first!.module.id, "module-structure");
  assert.equal(second!.expanded, true);
  assert.equal(first!.expanded, false);
  assert.deepEqual(layout.modules.map((label) => label.index), [0, 1], "each module has its own colour index");
  const allNodes = path.modules.flatMap((module) => module.nodes);
  assert.equal(layout.nodes.length, allNodes.length, "every node is placed");
  assert.ok(layout.height >= PAD_BOTTOM, "space under the nodes for zoom and legend");

  // Module order is the fallback prerequisite chain: holistic, concept, skill, contrast, checkpoint, bridge.
  const depth = (id: string): number => layout.nodes.find((placed) => placed.node.id === id)!.depth;
  assert.deepEqual(
    ["n-holistic", "n-concept", "n-skill", "n-contrast", "n-checkpoint", "n-bridge"].map(depth),
    [0, 1, 2, 3, 4, 5],
  );
  const holistic = layout.nodes.find((placed) => placed.node.id === "n-holistic")!;
  const bridge = layout.nodes.find((placed) => placed.node.id === "n-bridge")!;
  assert.ok(bridge.y < holistic.y, "bottom to top: deeper nodes sit higher");

  // Each label sits just above its module's first (shallowest) node.
  for (const label of layout.modules) {
    const own = layout.nodes.filter((placed) => placed.moduleId === label.module.id);
    const shallowest = Math.min(...own.map((placed) => placed.depth));
    const anchor = own.find((placed) => placed.depth === shallowest)!;
    assert.ok(label.x > anchor.x, "right of the arrow that leaves the node's dot");
    assert.ok(label.y >= 0 && label.y + LABEL_H <= anchor.y, "label is above the first node");
  }
  assert.ok(layout.nodes.every((placed) => placed.moduleIndex === path.modules.findIndex((module) => module.id === placed.moduleId)));
});

test("nodes of all modules share the rows and no two nodes in a row overlap", () => {
  const modules = ["a", "b", "c"].map((id) => ({
    ...makePath().modules[0]!,
    id: `m-${id}`,
    title: `Module ${id}`,
    nodes: [0, 1, 2].map((i) => makeNode(`${id}${i}`, "concept", { prerequisites: i === 0 ? [] : [`${id}${i - 1}`] })),
  }));
  const path: LearningPath = { ...makePath(), modules };
  const layout = layoutGraph(path, { showOptional: true });
  assert.equal(layout.nodes.length, 9);
  assert.equal(layout.modules.length, 3);
  assert.deepEqual([...new Set(layout.nodes.map((placed) => placed.depth))].sort(), [0, 1, 2], "three modules, three shared rows");
  for (const placed of layout.nodes) {
    for (const other of layout.nodes) {
      if (placed === other || placed.y !== other.y) continue;
      assert.ok(placed.x + placed.w <= other.x || other.x + other.w <= placed.x, `${placed.node.id} and ${other.node.id} overlap`);
    }
  }
  assert.equal(layout.edges.length, 6);
});

test("every prerequisite gets one arrow to each dependent node, pointing up from the dot below", () => {
  const layout = layoutGraph(makePath(), { showOptional: true });
  assert.equal(layout.edges.length, 5, "a chain of six nodes has five arrows");
  for (const edge of layout.edges) {
    assert.ok(edge.y1 > edge.y2, `arrow ${edge.from} -> ${edge.to} points up`);
    const from = layout.nodes.find((placed) => placed.node.id === edge.from)!;
    const to = layout.nodes.find((placed) => placed.node.id === edge.to)!;
    assert.equal(edge.x1, from.x + DOT_X, "leaves the prerequisite's dot");
    assert.equal(edge.x2, to.x + DOT_X, "enters the dependent's dot");
  }
});

test("optional nodes can be hidden; shown optional nodes have dashed arrows, and hiding one reconnects its neighbours", () => {
  const path = makePath();
  const nodes = path.modules[0]!.nodes.map((node) => (node.id === "n-skill" ? { ...node, optional: true } : node));
  (path.modules as PathModule[])[0] = { ...path.modules[0]!, nodes };
  const shown = layoutGraph(path, { showOptional: true });
  assert.ok(shown.nodes.some((placed) => placed.node.id === "n-skill"));
  assert.equal(shown.edges.filter((edge) => edge.dashed).length, 2, "the two arrows into and out of the optional node");
  const hidden = layoutGraph(path, { showOptional: false });
  assert.ok(!hidden.nodes.some((placed) => placed.node.id === "n-skill"));
  assert.ok(hidden.edges.some((edge) => edge.from === "n-concept" && edge.to === "n-contrast" && !edge.dashed));
  assert.equal(hidden.edges.filter((edge) => edge.dashed).length, 0);
});

test("the expanded module defaults to the selected node's, else the first unfinished one", () => {
  const path = makePath();
  assert.equal(defaultExpandedModule(path, "n-bridge"), "module-synthesis");
  assert.equal(defaultExpandedModule(path, null), "module-structure");
  const done: LearningPath = {
    ...path,
    modules: path.modules.map((module) => ({
      ...module,
      nodes: module.nodes.map((node) => ({ ...node, progression: "consolidated" as const })),
    })),
  };
  assert.equal(defaultExpandedModule(done, null), "module-synthesis", "a finished roadmap opens at its end");
  assert.deepEqual(moduleCounts(done.modules[0]!), { done: 3, total: 3 });
});

test("node marks, outcomes and resources validate, and bad links are refused", () => {
  const value = rawPath();
  value.modules[0].nodes[0] = {
    ...value.modules[0].nodes[0],
    optional: true,
    alternativeGroup: "",
    outcomes: ["Explain the map", "Explain the map", "Draw it from memory"],
    resources: [
      { title: "Course", kind: "course", url: "https://example.org/course", free: true },
      { title: "Book chapter", kind: "book" },
    ],
  };
  const parsed = parseLearningPath(value).modules[0]!.nodes[0]!;
  assert.equal(parsed.optional, true);
  assert.equal(parsed.alternativeGroup, undefined, "an empty group is no group");
  assert.deepEqual(parsed.outcomes, ["Explain the map", "Draw it from memory"], "duplicate outcomes collapse");
  assert.deepEqual(parsed.resources, [
    { title: "Course", kind: "course", url: "https://example.org/course", free: true },
    { title: "Book chapter", kind: "book" },
  ]);

  value.modules[0].nodes[0].resources = [{ title: "Script", kind: "article", url: "javascript:alert(1)" }];
  assert.throws(() => parseLearningPath(value), /must be an http\(s\) address/);
  value.modules[0].nodes[0].resources = [{ title: "Podcast", kind: "podcast" }];
  assert.throws(() => parseLearningPath(value), /kind: must be one of/);
});

test("display settings default sensibly and reject unknown values", () => {
  assert.deepEqual(parsePluginSettings({ artifactDefaults: {} }), { artifactDefaults: {} });
  const parsed = parsePluginSettings({ artifactDefaults: {}, display: { language: "ru" }, contentLanguage: "en" });
  assert.deepEqual(parsed.display, { language: "ru", showOptional: true, graphDirection: "bottom-to-top", patternHints: true });
  assert.equal(parsed.contentLanguage, "en");
  assert.throws(() => parsePluginSettings({ artifactDefaults: {}, display: { language: "klingon" } }));
});

function temporary(t: { after(fn: () => void): void }): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "roadmap-import-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("legacy Learning Paths data is copied once and never modified", (t) => {
  const plugins = temporary(t);
  const legacy = path.join(plugins, "learning-path", "data");
  const own = path.join(plugins, "roadmap-learnharness", "data");
  assert.equal(legacyDataDirectory(own), legacy);

  assert.equal(importLegacyData(own).reason, "no-legacy-data");
  fs.mkdirSync(path.join(legacy, "sources"), { recursive: true });
  fs.mkdirSync(path.join(legacy, "agents", "conv-1"), { recursive: true });
  const paths = JSON.stringify({ schemaVersion: 1, revision: 3, paths: [] });
  fs.writeFileSync(path.join(legacy, "learning-paths.json"), paths);
  fs.writeFileSync(path.join(legacy, "settings.json"), '{"schemaVersion":1,"revision":1,"settings":{"artifactDefaults":{}}}');
  fs.writeFileSync(path.join(legacy, "sources", "book.md"), "# Book");
  fs.writeFileSync(path.join(legacy, "agents", "conv-1", "messages.jsonl"), "{}\n");

  const result = importLegacyData(own, () => new Date("2026-11-16T12:00:00.000Z"));
  assert.equal(result.reason, "imported");
  assert.deepEqual([...result.copied].sort(), ["agents/", "learning-paths.json", "settings.json", "sources/"]);
  assert.equal(fs.readFileSync(path.join(own, "learning-paths.json"), "utf8"), paths);
  assert.equal(fs.readFileSync(path.join(own, "sources", "book.md"), "utf8"), "# Book");
  assert.ok(fs.existsSync(path.join(own, "agents", "conv-1", "messages.jsonl")));
  assert.ok(fs.existsSync(path.join(own, IMPORT_MARKER)));
  assert.equal(fs.readFileSync(path.join(legacy, "learning-paths.json"), "utf8"), paths, "the legacy file is untouched");

  // Deleting everything on purpose must not bring the old data back.
  fs.rmSync(path.join(own, "learning-paths.json"));
  assert.equal(importLegacyData(own).reason, "already-imported");
  assert.equal(fs.existsSync(path.join(own, "learning-paths.json")), false);
});

test("legacy import does nothing when Roadmap already has data", (t) => {
  const plugins = temporary(t);
  const legacy = path.join(plugins, "learning-path", "data");
  const own = path.join(plugins, "roadmap-learnharness", "data");
  fs.mkdirSync(legacy, { recursive: true });
  fs.mkdirSync(own, { recursive: true });
  fs.writeFileSync(path.join(legacy, "learning-paths.json"), "legacy");
  fs.writeFileSync(path.join(own, "learning-paths.json"), "mine");
  assert.equal(importLegacyData(own).reason, "already-has-data");
  assert.equal(fs.readFileSync(path.join(own, "learning-paths.json"), "utf8"), "mine");
});

test("session metrics sum focused time between learner actions and skip breaks", () => {
  const minute = 60_000;
  const at = (minutes: number) => Date.UTC(2026, 10, 12, 18, 0) + minutes * minute;
  const answered = (minutes: number, extra: Record<string, unknown>) => ({
    role: "toolResult",
    timestamp: at(minutes) + 999,
    details: { answeredAt: new Date(at(minutes)).toISOString(), ...extra },
  });
  const metrics = sessionMetrics([
    { role: "user", timestamp: at(0) },
    { role: "assistant", timestamp: at(1) },
    answered(4, { correct: true }),
    answered(9, { correct: false }),
    answered(12, { dontKnow: true }),
    { role: "custom", customType: "practice-thinking", timestamp: at(14) },
    answered(16, { correct: true, dismissed: true }),
    { role: "user", timestamp: at(60) },
    { role: "user", timestamp: at(62) },
  ]);
  assert.equal(metrics.startedAt, at(0));
  assert.equal(metrics.focusedMs, (14 + 2) * minute, "the 46-minute break is not study time");
  assert.equal(metrics.answered, 3);
  assert.equal(metrics.correct, 1);
  assert.equal(DEFAULT_BREAK_MS, 15 * minute);
  assert.deepEqual(sessionMetrics([]), { startedAt: null, focusedMs: 0, answered: 0, correct: 0 });
});

test("every interface string exists in both languages and the locale follows the setting", () => {
  assert.equal(resolveLocale("ru", "en-US"), "ru");
  assert.equal(resolveLocale("auto", "ru-RU"), "ru");
  assert.equal(resolveLocale("auto", "de-DE"), "en");
  const source = fs.readFileSync(new URL("../src/i18n.ts", import.meta.url), "utf8");
  const ruBlock = source.slice(source.indexOf("const ru:"), source.indexOf("const tables"));
  const enBlock = source.slice(source.indexOf("const en = {"), source.indexOf("export type MessageKey"));
  const keys = (block: string) => [...block.matchAll(/^\s+"([\w.]+)":/gm)].map((match) => match[1]);
  assert.deepEqual(keys(ruBlock).sort(), keys(enBlock).sort());
  setLocale("ru");
  assert.equal(t("foot.summary" as MessageKey, { done: 7, total: 14, progress: 2 }), "пройдено 7 из 14 · в работе 2");
  setLocale("en");
  assert.equal(t("foot.summary" as MessageKey, { done: 7, total: 14, progress: 2 }), "consolidated 7 of 14 · in progress 2");
});

test("graphDirection defaults to bottom-to-top, keeps a saved left-to-right and falls back on an invalid value", () => {
  assert.equal(parsePluginSettings({ artifactDefaults: {}, display: { language: "en" } }).display?.graphDirection, "bottom-to-top");
  const saved = validatePluginSettings({ artifactDefaults: {}, display: { graphDirection: "left-to-right" } });
  assert.ok(saved.ok);
  assert.equal(saved.value.display?.graphDirection, "left-to-right");
  for (const bad of ["diagonal", 3, null]) {
    const result = validatePluginSettings({ artifactDefaults: {}, display: { graphDirection: bad } });
    assert.ok(result.ok);
    assert.equal(result.value.display?.graphDirection, "bottom-to-top");
  }
});
