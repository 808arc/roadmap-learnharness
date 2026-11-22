/** Upstream roadmap source and the Architect's upstream mode (issue #19).
 *
 * Synthetic data only. Every GitHub request goes through a fake fetch that replays
 * recorded synthetic responses; nothing touches the network. No model is called.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { PluginAgentTool, PluginBackendContext } from "learnharness-plugin-api";
import { buildArchitectDefinition } from "../src/architect-agent.ts";
import type { ArchitectModelConfig } from "../src/store.ts";
import { openLearningPathStore } from "../src/store.ts";
import {
  UPSTREAM_API_BASE,
  UPSTREAM_REPOSITORY,
  UpstreamError,
  listRoadmapTopics,
  parseTopicMarkdown,
  readTopic,
} from "../src/upstream-roadmaps.ts";
import type { UpstreamFetch } from "../src/upstream-roadmaps.ts";
import { rawPath } from "./fixtures.ts";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const ROOT = `${UPSTREAM_API_BASE}/repos/${UPSTREAM_REPOSITORY}/contents/roadmaps`;

/** Recorded synthetic responses, keyed by the exact request URL. */
const LISTING = JSON.stringify([
  { name: "synthetic-topic@aB3_x.md", type: "file" },
  { name: "other-topic@Qz9-k.md", type: "file" },
  { name: "README.md", type: "file" },
  { name: "not-a-topic.txt", type: "file" },
]);
const TOPIC_MD = [
  "# Synthetic Topic",
  "",
  "A short synthetic description of the topic.",
  "",
  "Visit the following resources to learn more:",
  "",
  "- [@official@Example Docs](https://docs.example.test/start?lang=en&v=2)",
  "- [@book@Example Book](https://books.example.test/b/1)",
  "- [Plain link without a tag](https://plain.example.test/x)",
  "- [@book@Example Book](https://books.example.test/b/1)",
  "- [@article@Second Article](https://articles.example.test/a)",
  "",
].join("\n");

interface ToolResult {
  content: { type: string; text: string }[];
  details: unknown;
  isError?: boolean;
}

interface Recorded {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
}

/** A fake fetch that replays `routes` and records every call. A null route throws (unreachable). */
function fakeFetch(routes: Record<string, { status: number; body: string } | null>): { fetch: UpstreamFetch; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const fetch: UpstreamFetch = async (url, init) => {
    calls.push({ url, headers: { ...init.headers } });
    const route = routes[url];
    if (route === null) throw new TypeError("synthetic network failure");
    if (route === undefined) return { ok: false, status: 404, text: async () => "{}" };
    return { ok: route.status >= 200 && route.status < 300, status: route.status, text: async () => route.body };
  };
  return { fetch, calls };
}

const standardRoutes = () => ({
  [`${ROOT}/synthetic-roadmap/content?ref=${COMMIT}`]: { status: 200, body: LISTING },
  [`${ROOT}/synthetic-roadmap/content/synthetic-topic@aB3_x.md?ref=${COMMIT}`]: { status: 200, body: TOPIC_MD },
});

const isUpstreamError = (kind: string) => (error: unknown) => error instanceof UpstreamError && error.kind === kind;

test("listRoadmapTopics returns the topic slugs and files, and ignores other names", async () => {
  const { fetch, calls } = fakeFetch(standardRoutes());
  const topics = await listRoadmapTopics("synthetic-roadmap", COMMIT, { fetch });
  assert.deepEqual(topics, [
    { slug: "synthetic-topic", file: "synthetic-topic@aB3_x.md" },
    { slug: "other-topic", file: "other-topic@Qz9-k.md" },
  ]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, `${ROOT}/synthetic-roadmap/content?ref=${COMMIT}`);
});

test("readTopic returns title, description and resources exactly as the file writes them", async () => {
  const { fetch } = fakeFetch(standardRoutes());
  const topic = await readTopic("synthetic-roadmap", "synthetic-topic", COMMIT, { fetch });
  assert.equal(topic.title, "Synthetic Topic");
  assert.equal(topic.description, "A short synthetic description of the topic.");
  assert.equal(topic.source, "roadmap.sh");
  assert.equal(topic.commit, COMMIT);
  // Tag kept in the label, URL verbatim (query string included), untagged links skipped, duplicates dropped.
  assert.deepEqual(topic.resources, [
    { label: "@official@Example Docs", tag: "official", url: "https://docs.example.test/start?lang=en&v=2" },
    { label: "@book@Example Book", tag: "book", url: "https://books.example.test/b/1" },
    { label: "@article@Second Article", tag: "article", url: "https://articles.example.test/a" },
  ]);
});

test("parseTopicMarkdown copes with a file that has no title or description", () => {
  const parsed = parseTopicMarkdown("- [@book@Only Book](https://books.example.test/only)\n");
  assert.equal(parsed.title, "");
  assert.equal(parsed.description, "");
  assert.deepEqual(parsed.resources, [{ label: "@book@Only Book", tag: "book", url: "https://books.example.test/only" }]);
});

test("slugs that are not plain slugs are rejected before any request", async () => {
  const bad = ["", "../etc", "a/b", "A-Upper", "has space", "x@y", "dots.here", "a--b", "-lead", "trail-", "%2e%2e", "a".repeat(81), "frontend?x=1"];
  for (const slug of bad) {
    const { fetch, calls } = fakeFetch(standardRoutes());
    await assert.rejects(listRoadmapTopics(slug, COMMIT, { fetch }), isUpstreamError("invalid"), `roadmap ${slug}`);
    await assert.rejects(readTopic("synthetic-roadmap", slug, COMMIT, { fetch }), isUpstreamError("invalid"), `topic ${slug}`);
    await assert.rejects(readTopic(slug, "synthetic-topic", COMMIT, { fetch }), isUpstreamError("invalid"), `roadmap ${slug}`);
    assert.equal(calls.length, 0, `no request for ${JSON.stringify(slug)}`);
  }
});

test("a commit that is not a full SHA is rejected before any request", async () => {
  for (const commit of ["main", "0123456", COMMIT.toUpperCase(), `${COMMIT}&x=1`, "../../abc"]) {
    const { fetch, calls } = fakeFetch(standardRoutes());
    await assert.rejects(readTopic("synthetic-roadmap", "synthetic-topic", commit, { fetch }), isUpstreamError("invalid"));
    assert.equal(calls.length, 0);
  }
});

test("every request stays under roadmaps/ at the pinned commit", async () => {
  const { fetch, calls } = fakeFetch(standardRoutes());
  await readTopic("synthetic-roadmap", "synthetic-topic", COMMIT, { fetch });
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.ok(call.url.startsWith(`${UPSTREAM_API_BASE}/repos/${UPSTREAM_REPOSITORY}/contents/roadmaps/`), call.url);
    assert.ok(call.url.endsWith(`ref=${COMMIT}`), call.url);
  }
});

test("an unreachable GitHub is reported as an error, and no other source is asked", async () => {
  const { fetch, calls } = fakeFetch({ [`${ROOT}/synthetic-roadmap/content?ref=${COMMIT}`]: null });
  await assert.rejects(listRoadmapTopics("synthetic-roadmap", COMMIT, { fetch }), isUpstreamError("unreachable"));
  assert.equal(calls.length, 1);
  assert.ok(calls.every((call) => call.url.startsWith(`${UPSTREAM_API_BASE}/`)), "only the GitHub API is asked");
});

test("a 500 is unreachable, an unknown roadmap is not found, and a missing topic is not found", async () => {
  const server = fakeFetch({ [`${ROOT}/synthetic-roadmap/content?ref=${COMMIT}`]: { status: 500, body: "" } });
  await assert.rejects(listRoadmapTopics("synthetic-roadmap", COMMIT, { fetch: server.fetch }), isUpstreamError("unreachable"));

  const missing = fakeFetch({});
  await assert.rejects(listRoadmapTopics("no-such-roadmap", COMMIT, { fetch: missing.fetch }), isUpstreamError("not_found"));

  const { fetch } = fakeFetch(standardRoutes());
  await assert.rejects(readTopic("synthetic-roadmap", "absent-topic", COMMIT, { fetch }), isUpstreamError("not_found"));
});

/** A learner whose graph holds distinctive synthetic text, to prove none of it leaves the plugin. */
const SECRET = "ZZ-LEARNER-SECRET-7731";
function learnerContext(): PluginBackendContext {
  const graph = {
    propositions: [
      {
        id: "p1",
        name: `Topic ${SECRET}`,
        statement: `Statement ${SECRET} about the learner.`,
        aliases: [`alias ${SECRET}`],
        createdAt: "2026-01-01T00:00:00Z",
        provenance: [{ chatId: `chat-${SECRET}`, messageId: "m1" }],
      },
    ],
    chains: [],
  };
  return {
    signal: new AbortController().signal,
    learning: { graph: () => graph },
  } as unknown as PluginBackendContext;
}

const model = { provider: "synthetic", id: "synthetic-model" } as unknown as ArchitectModelConfig;

function workspace(t: { after: (fn: () => void) => void }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "upstream-architect-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function upstreamDefinition(t: { after: (fn: () => void) => void }, fetch: UpstreamFetch) {
  const store = openLearningPathStore(workspace(t));
  const definition = buildArchitectDefinition(learnerContext(), model, {
    store,
    activeChatId: () => "chat-synthetic",
    upstream: { fetch, commit: COMMIT },
  });
  const tool = (name: string): { execute(id: string, params: unknown, signal: undefined): Promise<ToolResult> } => {
    const found = definition.tools?.find((candidate: PluginAgentTool) => candidate.name === name);
    assert.ok(found?.execute, `tool ${name} exists`);
    return found as unknown as { execute(id: string, params: unknown, signal: undefined): Promise<ToolResult> };
  };
  return { definition, store, tool };
}

test("upstream mode offers only the graph brief, the two upstream reads and the path tools", (t) => {
  const { definition } = upstreamDefinition(t, fakeFetch({}).fetch);
  assert.deepEqual(
    definition.tools?.map((tool) => tool.name).sort(),
    [
      "get_learning_path",
      "list_roadmap_topics",
      "read_learner_graph",
      "read_roadmap_topic",
      "save_learning_path",
      "save_learning_path_json",
    ],
  );
  for (const banned of [
    "web_search",
    "find_books",
    "book_contents",
    "read_page",
    "deep_research",
    "list_research_notes",
    "read_research_note",
    "list_uploaded_sources",
    "read_uploaded_source_chunk",
  ]) {
    assert.equal(definition.tools?.some((tool) => tool.name === banned), false, banned);
  }
});

test("the graph brief is read through ctx.learning.graph() and upstream calls carry no learner content", async (t) => {
  const { fetch, calls } = fakeFetch(standardRoutes());
  const { tool } = upstreamDefinition(t, fetch);
  const graph = await tool("read_learner_graph").execute("c1", {}, undefined);
  assert.equal(graph.isError, undefined);
  assert.match(graph.content[0]?.text ?? "", new RegExp(SECRET), "the model sees its own graph");

  await tool("list_roadmap_topics").execute("c2", { roadmapSlug: "synthetic-roadmap" }, undefined);
  await tool("read_roadmap_topic").execute("c3", { roadmapSlug: "synthetic-roadmap", topicSlug: "synthetic-topic" }, undefined);
  // The model could try to pass learner text as a slug: it is refused before any request.
  const refused = await tool("read_roadmap_topic").execute(
    "c4",
    { roadmapSlug: "synthetic-roadmap", topicSlug: `topic ${SECRET}` },
    undefined,
  );
  assert.equal(refused.isError, true);

  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.equal(call.url.includes(SECRET), false, "no learner text in a URL");
    assert.equal(JSON.stringify(call.headers).includes(SECRET), false, "no learner text in headers");
    assert.deepEqual(Object.keys(call.headers).sort(), ["Accept", "User-Agent", "X-GitHub-Api-Version"]);
  }
});

test("a save with a link that was not read from a topic file is refused, and a copied link is saved", async (t) => {
  const { fetch } = fakeFetch(standardRoutes());
  const { tool, store } = upstreamDefinition(t, fetch);
  const draft = rawPath();
  draft.sourceSpine = {
    mode: "canonical",
    references: [{ title: "roadmap.sh developer roadmap (nilbuild/developer-roadmap)", kind: "course" }],
  };
  draft.modules[0].nodes[0].resources = [{ title: "Invented", kind: "docs", url: "https://invented.example.test/nope" }];

  const refused = await tool("save_learning_path").execute("c1", draft, undefined);
  assert.equal(refused.isError, true);
  assert.match(refused.content[0]?.text ?? "", /invented\.example\.test/);
  assert.equal(store.paths().length, 0, "nothing written");

  await tool("read_roadmap_topic").execute("c2", { roadmapSlug: "synthetic-roadmap", topicSlug: "synthetic-topic" }, undefined);
  draft.modules[0].nodes[0].resources = [{ title: "Example Book", kind: "book", url: "https://books.example.test/b/1" }];
  const saved = await tool("save_learning_path").execute("c3", draft, undefined);
  assert.equal(saved.isError, undefined, saved.content[0]?.text);
  assert.equal(store.paths().length, 1);
});

test("an upstream failure is returned to the Architect as an error, with no other source tried", async (t) => {
  const { fetch, calls } = fakeFetch({ [`${ROOT}/synthetic-roadmap/content?ref=${COMMIT}`]: null });
  const { tool } = upstreamDefinition(t, fetch);
  const result = await tool("list_roadmap_topics").execute("c1", { roadmapSlug: "synthetic-roadmap" }, undefined);
  assert.equal(result.isError, true);
  assert.match(result.content[0]?.text ?? "", /could not be reached/);
  assert.equal(calls.length, 1);
});
