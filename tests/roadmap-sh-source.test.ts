/** The roadmap.sh source setting: default on, off removes the upstream tools and rules from the Architect. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ARCHITECT_DEFINITION_ID, buildArchitectDefinition } from "../src/architect-agent.ts";
import { createHost } from "./host.ts";
import { parsePluginSettings, validatePluginSettings } from "../src/domain.ts";
import { buildArchitectSystemPrompt } from "../src/framework.ts";
import { tables } from "../src/i18n.ts";
import { openLearningPathStore } from "../src/store.ts";
import type { ArchitectModelConfig } from "../src/store.ts";
import { mountSettingsPage } from "../src/settings.ts";
import type { PluginBackendContext } from "learnharness-plugin-api";
import { createViewFixture } from "./view-host.ts";

const model = { provider: "test", id: "m" } as unknown as ArchitectModelConfig;
const UPSTREAM = ["rank_roadmaps", "list_roadmap_topics", "read_roadmap_topic", "read_roadmap_topics"];

function definition(t: { after: (fn: () => void) => void }, settings?: unknown) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rmsh-store-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = openLearningPathStore(dir);
  if (settings !== undefined) store.saveSettings(settings);
  const ctx = { learning: { graph: () => ({ propositions: [], chains: [] }) } } as unknown as PluginBackendContext;
  const def = buildArchitectDefinition(ctx, model, {
    store,
    activeChatId: () => "chat",
    upstream: { fetch: (async () => { throw new Error("no network"); }) as never, commit: "c".repeat(40) },
  });
  return { names: (def.tools ?? []).map((tool) => tool.name), instructions: def.instructions };
}

test("by default the Architect keeps the roadmap.sh tools and rules", (t) => {
  const { names, instructions } = definition(t);
  for (const name of UPSTREAM) assert.ok(names.includes(name), name);
  assert.match(instructions, /list_roadmap_topics/);
});

test("off removes the roadmap.sh tools and rules, and keeps the graph, path and research tools", (t) => {
  const { names, instructions } = definition(t, { artifactDefaults: {}, roadmapShSource: false });
  for (const name of UPSTREAM) assert.ok(!names.includes(name), name);
  for (const name of ["read_learner_graph", "get_learning_path", "save_learning_path"]) assert.ok(names.includes(name), name);
  assert.doesNotMatch(instructions, /list_roadmap_topics|rank_roadmaps|read_roadmap_topic/);
});

test("on explicitly keeps the tools; the value survives parse and validate", (t) => {
  assert.ok(definition(t, { artifactDefaults: {}, roadmapShSource: true }).names.includes("rank_roadmaps"));
  for (const value of [true, false]) {
    const input = { artifactDefaults: {}, roadmapShSource: value };
    assert.equal(parsePluginSettings(input).roadmapShSource, value);
    const parsed = validatePluginSettings(input);
    assert.ok(parsed.ok);
    if (parsed.ok) assert.equal(parsed.value.roadmapShSource, value);
  }
  assert.equal(validatePluginSettings({ artifactDefaults: {}, roadmapShSource: "no" }).ok, false);
});

test("the settings row exists, is on by default, and has an English string", async () => {
  for (const key of ["s.roadmapSh", "s.roadmapShDesc"] as const) {
    assert.ok(tables.en[key], `en ${key}`);
  }
  const fixture = createViewFixture({});
  try {
    mountSettingsPage(fixture.context, fixture.root, fixture.context.signal);
    await fixture.flush();
    const rows = fixture.findLast("mountSettingsRows", (r) => r.props.rows.some((row: { key: string }) => row.key === "roadmap-sh-source"));
    const row = rows.props.rows.find((r: { key: string }) => r.key === "roadmap-sh-source");
    assert.equal(row.type, "toggle");
    assert.equal(row.value, true);
    await row.onChange(false);
    await fixture.flush();
    assert.equal(fixture.settings.roadmapShSource, false);
  } finally {
    fixture.restore();
  }
});

test("saving the setting re-registers the Architect, so the change applies without a restart", async (t) => {
  const h = createHost();
  t.after(() => h.close());
  await h.call("architect.create");
  const names = (): string[] => (h.definitions.get(ARCHITECT_DEFINITION_ID)?.tools ?? []).map((tool) => tool.name);
  assert.ok(names().includes("rank_roadmaps"));
  await h.call("settings.save", { artifactDefaults: {}, roadmapShSource: false });
  for (const name of UPSTREAM) assert.ok(!names().includes(name), name);
  assert.doesNotMatch(h.definitions.get(ARCHITECT_DEFINITION_ID)?.instructions ?? "", /list_roadmap_topics/);
  await h.call("settings.save", { artifactDefaults: {}, roadmapShSource: true });
  assert.ok(names().includes("rank_roadmaps"));
});

test("on, the prompt is exactly the prompt without the option, in every mode and tool set", () => {
  const toolSets = [[], ["web_search", "read_page"], ["list_research_notes", "read_research_note"], ["find_books", "web_search", "deep_research"]];
  for (const upstream of [true, false]) {
    for (const researchTools of toolSets) {
      assert.equal(
        buildArchitectSystemPrompt({ upstream, researchTools, roadmapSh: true }),
        buildArchitectSystemPrompt({ upstream, researchTools }),
      );
    }
  }
});
