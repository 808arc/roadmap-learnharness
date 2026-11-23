/** Research channels: switches, tool gating, the local-network guard, key and note storage. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HYBRID_RESEARCH, effectiveResearch, parsePluginSettings } from "../src/domain.ts";
import { buildArchitectSystemPrompt } from "../src/framework.ts";
import { assertPublicUrl, htmlToText } from "../src/research/net.ts";
import { createKeyStore } from "../src/research/key-store.ts";
import { createResearchNotes } from "../src/research/notes.ts";
import { buildResearchTools } from "../src/research/tools.ts";

const temp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "roadmap-research-"));
const names = (settings: typeof HYBRID_RESEARCH, extra: Record<string, unknown> = {}): string[] =>
  buildResearchTools({} as never, { settings, notes: createResearchNotes(temp()), ...extra }).map((tool) => tool.name);

test("presets: hybrid = session + open catalogs; offline turns everything off; custom keeps each switch", () => {
  assert.deepEqual(effectiveResearch(undefined), HYBRID_RESEARCH);
  const offline = effectiveResearch({ ...HYBRID_RESEARCH, preset: "offline", claudeCli: true });
  assert.equal(offline.session || offline.openSources || offline.ownKey || offline.claudeCli || offline.hostWeb, false);
  const custom = effectiveResearch({ ...HYBRID_RESEARCH, preset: "custom", openSources: false, claudeCli: true });
  assert.equal(custom.openSources, false);
  assert.equal(custom.claudeCli, true);
  const parsed = parsePluginSettings({ artifactDefaults: {}, research: { preset: "custom", ownKey: true, keyEngine: "brave" } });
  assert.equal(parsed.research?.ownKey, true);
  assert.equal(parsed.research?.keyEngine, "brave");
  assert.throws(() => parsePluginSettings({ artifactDefaults: {}, research: { keyEngine: "google" } }));
});

test("only enabled channels give the Architect tools; with everything off it has none but notes", () => {
  const off = effectiveResearch({ ...HYBRID_RESEARCH, preset: "offline" });
  assert.deepEqual(names(off), ["list_research_notes", "read_research_note"]);
  assert.match(buildArchitectSystemPrompt({ researchTools: [] }), /Offline: no research tools/);

  const hybrid = names(effectiveResearch(undefined));
  assert.ok(hybrid.includes("find_books") && hybrid.includes("read_page"));
  assert.ok(!hybrid.includes("web_search") && !hybrid.includes("deep_research"));

  const custom = { ...HYBRID_RESEARCH, preset: "custom" as const, openSources: false, ownKey: true, claudeCli: true };
  assert.deepEqual(names(custom), ["list_research_notes", "read_research_note"], "a key channel without a key and CLI without a binary add nothing");
  const withKey = names(custom, { ownKey: { engine: "tavily", key: "tvly-test-key" }, deepResearch: async () => "report" });
  assert.ok(withKey.includes("web_search") && withKey.includes("read_page") && withKey.includes("deep_research"));

  const prompt = buildArchitectSystemPrompt({ researchTools: hybrid });
  assert.match(prompt, /Roadmap author method/);
  assert.match(prompt, /Books: name field's most recommended/);
  assert.match(prompt, /book_contents on every path book/);
  assert.doesNotMatch(prompt, /web_search from many angles/);
});

test("pages on the local network are refused, including literal private and loopback addresses", async () => {
  for (const url of ["http://localhost:3917/api/chats", "http://127.0.0.1/", "http://192.168.1.1/", "http://10.0.0.5/", "http://[::1]/", "http://169.254.169.254/latest", "file:///etc/passwd", "http://user:pw@example.com/"]) {
    await assert.rejects(assertPublicUrl(url), url);
  }
  const page = htmlToText("<html><title>T</title><nav>menu</nav><main><h2>Chapter 1</h2><p>Vectors &amp; spaces</p><script>x()</script></main></html>");
  assert.equal(page.title, "T");
  assert.match(page.text, /## Chapter 1/);
  assert.match(page.text, /Vectors & spaces/);
  assert.doesNotMatch(page.text, /menu|x\(\)/);
});

test("the own key lives apart from settings, is never echoed, and research notes round-trip", () => {
  const directory = temp();
  const keys = createKeyStore(directory);
  assert.equal(keys.has("tavily"), false);
  keys.save("tavily", "  tvly-abcdefgh12345  ");
  assert.equal(keys.read("tavily"), "tvly-abcdefgh12345");
  assert.ok(fs.existsSync(path.join(directory, "secrets", ".gitignore")));
  assert.equal(fs.existsSync(path.join(directory, "settings.json")), false);
  assert.throws(() => keys.save("brave", "short"));
  keys.clear("tavily");
  assert.equal(keys.has("tavily"), false);

  const notes = createResearchNotes(directory);
  const note = notes.add({ title: "Linear algebra field map", origin: "session", body: "# Report\n" + "x".repeat(500), chatId: "chat-1" });
  assert.equal(notes.list()[0]!.id, note.id);
  assert.equal(notes.read(note.id)!.body.startsWith("# Report"), true);
  assert.equal(notes.read("../settings"), null);
  assert.equal(notes.remove(note.id), true);
  assert.deepEqual(notes.list(), []);
});

test("only a registered research chat gets roadmap_submit_research, and the report becomes a note", async () => {
  const { createResearchChats, registerResearchSessions } = await import("../src/research/session-research.ts");
  const directory = temp();
  const notes = createResearchNotes(directory);
  const chats = createResearchChats(directory);
  let factory: ((context: { chatId: string; agent: string }) => { name: string; execute: (id: string, p: unknown) => Promise<{ isError?: boolean }> }[]) | null = null;
  const instructions: { agents: string[]; text: string }[] = [];
  let enabled = true;
  const seen: string[] = [];
  const dispose = registerResearchSessions(
    {
      registerInstructions: (value: { agents: string[]; text: string }) => { instructions.push(value); return () => {}; },
      registerTools: (value: { create: typeof factory }) => { factory = value.create; return () => {}; },
    } as never,
    { chats, notes, enabled: () => enabled, onNote: (noteId) => seen.push(noteId) },
  );
  assert.deepEqual(instructions[0]!.agents, ["teacher"]);
  assert.deepEqual(factory!({ chatId: "ordinary", agent: "teacher" }), []);
  chats.add("chat-r", "Linear algebra for ML");
  const [tool] = factory!({ chatId: "chat-r", agent: "teacher" });
  assert.equal(tool!.name, "roadmap_submit_research");
  assert.equal((await tool!.execute("1", { title: "x", report: "too short" })).isError, true);
  await tool!.execute("2", { title: "LA field map", report: "# Report\n" + "Strang, MML, 3Blue1Brown. ".repeat(20) });
  assert.equal(notes.list().length, 1);
  assert.equal(notes.list()[0]!.chatId, "chat-r");
  assert.deepEqual(chats.get("chat-r")!.noteIds, [seen[0]]);
  enabled = false;
  assert.deepEqual(factory!({ chatId: "chat-r", agent: "teacher" }), [], "switched off in settings: no tool");
  dispose();
});
