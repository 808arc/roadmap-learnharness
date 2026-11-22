/** Fast topic reads (issue #19 follow-up): bounded parallel batch reads, a disk cache per pinned commit,
 * and background prefetch. Synthetic data only: every request goes through an injected fake fetch and the
 * cache lives in a temporary folder. Nothing touches the network.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { buildArchitectDefinition } from "../src/architect-agent.ts";
import { createTopicDiskCache } from "../src/topic-cache.ts";
import {
  TOPIC_READ_CONCURRENCY,
  UPSTREAM_API_BASE,
  UPSTREAM_REPOSITORY,
  UpstreamError,
  prefetchRoadmapTopics,
  readTopic,
} from "../src/upstream-roadmaps.ts";
import type { UpstreamFetch } from "../src/upstream-roadmaps.ts";
import type { PluginAgentTool, PluginBackendContext } from "learnharness-plugin-api";
import { openLearningPathStore } from "../src/store.ts";
import type { ArchitectModelConfig } from "../src/store.ts";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const OTHER_COMMIT = "fedcba9876543210fedcba9876543210fedcba98";
const ROOT = `${UPSTREAM_API_BASE}/repos/${UPSTREAM_REPOSITORY}/contents/roadmaps`;
const SECRET = "ZZ-LEARNER-SECRET-9190";
const ALLOWED_URL = new RegExp(
  `^${UPSTREAM_API_BASE.replace(/\./g, "\\.")}/repos/${UPSTREAM_REPOSITORY.replace(/\./g, "\\.")}/contents/roadmaps/[a-z0-9.-]+/content(/[A-Za-z0-9.@_-]+\\.md)?\\?ref=[0-9a-f]{40}$`,
);

interface Recorded {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
}

/** Topic slugs named `topic-01` .. `topic-NN`; the file for each is `<slug>@Id<NN>.md`. */
function slugsOf(count: number): string[] {
  return Array.from({ length: count }, (_value, index) => `topic-${String(index + 1).padStart(2, "0")}`);
}

function listingOf(slugs: readonly string[]): string {
  return JSON.stringify(slugs.map((slug) => ({ name: `${slug}@Id${slug.slice(-2)}.md`, type: "file" })));
}

function topicBody(slug: string): string {
  return `# Title of ${slug}\n\nSynthetic description of ${slug}.\n`;
}

/** Bodies keyed by exact URL for one commit: the listing plus one file per slug. */
function bodiesFor(slugs: readonly string[], commit: string): Record<string, string> {
  const bodies: Record<string, string> = { [`${ROOT}/synthetic-roadmap/content?ref=${commit}`]: listingOf(slugs) };
  for (const slug of slugs) bodies[`${ROOT}/synthetic-roadmap/content/${slug}@Id${slug.slice(-2)}.md?ref=${commit}`] = topicBody(slug);
  return bodies;
}

/** A fake fetch that answers after `delayFor(url)` ms and records the most requests in flight at once.
 * A URL missing from `bodies` is a 404; a URL in `failing` throws (unreachable). */
function timedFetch(bodies: Record<string, string>, options: { delayFor?: (url: string) => number; failing?: ReadonlySet<string> } = {}) {
  const calls: Recorded[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const fetch: UpstreamFetch = async (url, init) => {
    calls.push({ url, headers: { ...init.headers } });
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      await new Promise((resolve) => setTimeout(resolve, options.delayFor?.(url) ?? 2));
      if (options.failing?.has(url)) throw new TypeError("synthetic network failure");
      const body = bodies[url];
      if (body === undefined) return { ok: false, status: 404, text: async () => "{}" };
      return { ok: true, status: 200, text: async () => body };
    } finally {
      inFlight -= 1;
    }
  };
  return { fetch, calls, maxInFlight: () => maxInFlight };
}

const topicUrl = (slug: string, commit: string) => `${ROOT}/synthetic-roadmap/content/${slug}@Id${slug.slice(-2)}.md?ref=${commit}`;
const listingUrl = (commit: string) => `${ROOT}/synthetic-roadmap/content?ref=${commit}`;
const topicFile = (folder: string, slug: string, commit: string) => path.join(folder, commit, "synthetic-roadmap", `${slug}.json`);
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 60));

function tempFolder(t: { after: (fn: () => void) => void }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "upstream-fast-reads-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const model = { provider: "synthetic", id: "synthetic-model" } as unknown as ArchitectModelConfig;
const context = (): PluginBackendContext =>
  ({
    signal: new AbortController().signal,
    learning: { graph: () => ({ propositions: [{ id: "p1", name: `Topic ${SECRET}`, statement: SECRET, aliases: [], createdAt: "2026-01-01T00:00:00Z", provenance: [] }], chains: [] }) },
  }) as unknown as PluginBackendContext;

/** The Architect's definition with the upstream fake and a disk cache folder; returns its tools by name. */
function architectTools(t: { after: (fn: () => void) => void }, fetch: UpstreamFetch, folder: string, commit = COMMIT) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "upstream-store-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const definition = buildArchitectDefinition(context(), model, {
    store: openLearningPathStore(dir),
    activeChatId: () => "chat-synthetic",
    upstream: { fetch, commit, topicCache: createTopicDiskCache(folder) },
  });
  const tool = (name: string) => {
    const found = definition.tools?.find((candidate: PluginAgentTool) => candidate.name === name);
    assert.ok(found?.execute, `tool ${name} exists`);
    return found as unknown as { execute(id: string, params: unknown, signal: undefined): Promise<{ content: { text: string }[]; isError?: boolean }> };
  };
  return tool;
}

test("the batch cap is 12 in flight, and a batch of 10 is fetched at once without exceeding it", async (t) => {
  assert.equal(TOPIC_READ_CONCURRENCY, 12);
  const slugs = slugsOf(10);
  const { fetch, maxInFlight, calls } = timedFetch(bodiesFor(slugs, COMMIT), { delayFor: () => 25 });
  const tool = architectTools(t, fetch, tempFolder(t));
  const result = await tool("read_roadmap_topics").execute("c1", { roadmapSlug: "synthetic-roadmap", topicSlugs: slugs }, undefined);
  assert.equal(result.isError, undefined);
  // All ten topic requests start before any finishes: the batch is 10 wide, below the cap of 12.
  assert.equal(maxInFlight(), 10, "the ten topics are in flight together");
  assert.equal(calls.length, 11, "one listing and ten topic files");
});

test("a prefetch of 30 topics never has more than the cap in flight, and reaches it exactly", async () => {
  const slugs = slugsOf(30);
  const { fetch, maxInFlight, calls } = timedFetch(bodiesFor(slugs, COMMIT), { delayFor: () => 15 });
  await prefetchRoadmapTopics("synthetic-roadmap", slugs, COMMIT, { fetch, listings: new Map() });
  assert.equal(maxInFlight(), TOPIC_READ_CONCURRENCY, "exactly the cap: the pool fills up");
  assert.equal(calls.length, 31, "one listing and thirty topic files");
});

test("batch results come back in the order requested, even when the requests finish out of order", async (t) => {
  const slugs = slugsOf(4);
  // The first slug answers last, the last answers first.
  const delayFor = (url: string) => (url.includes("topic-01") ? 40 : url.includes("topic-04") ? 1 : 10);
  const { fetch } = timedFetch(bodiesFor(slugs, COMMIT), { delayFor });
  const tool = architectTools(t, fetch, tempFolder(t));
  const requested = ["topic-03", "topic-01", "topic-04", "topic-02"];
  const result = await tool("read_roadmap_topics").execute("c1", { roadmapSlug: "synthetic-roadmap", topicSlugs: requested }, undefined);
  const batch = JSON.parse(result.content[0]?.text ?? "{}") as { results: { slug: string; ok: boolean; topic?: { title: string } }[] };
  assert.deepEqual(batch.results.map((entry) => entry.slug), requested);
  assert.ok(batch.results.every((entry) => entry.ok));
  assert.deepEqual(batch.results.map((entry) => entry.topic?.title), requested.map((slug) => `Title of ${slug}`));
});

test("a second read of a topic is a cache hit: no request is made", async (t) => {
  const folder = tempFolder(t);
  const slugs = slugsOf(2);
  const first = timedFetch(bodiesFor(slugs, COMMIT));
  const written = await readTopic("synthetic-roadmap", "topic-01", COMMIT, { fetch: first.fetch, topicCache: createTopicDiskCache(folder) });
  assert.equal(first.calls.length, 2, "listing and the topic file");
  assert.ok(fs.existsSync(topicFile(folder, "topic-01", COMMIT)), "the successful read is stored under the commit");

  const silent = timedFetch({});
  const again = await readTopic("synthetic-roadmap", "topic-01", COMMIT, { fetch: silent.fetch, topicCache: createTopicDiskCache(folder) });
  assert.deepEqual(again, written);
  assert.equal(silent.calls.length, 0, "the cache hit makes no request");
});

test("a corrupt or mismatched cache entry is a miss, and the topic is read again", async (t) => {
  const folder = tempFolder(t);
  fs.mkdirSync(path.dirname(topicFile(folder, "topic-01", COMMIT)), { recursive: true });
  fs.writeFileSync(topicFile(folder, "topic-01", COMMIT), "{not json");
  const { fetch, calls } = timedFetch(bodiesFor(slugsOf(1), COMMIT));
  const topic = await readTopic("synthetic-roadmap", "topic-01", COMMIT, { fetch, topicCache: createTopicDiskCache(folder) });
  assert.equal(topic.title, "Title of topic-01");
  assert.equal(calls.length, 2);
});

test("a failed read is never cached: the next read asks GitHub again and then stores the topic", async (t) => {
  const folder = tempFolder(t);
  const bodies = bodiesFor(slugsOf(1), COMMIT);
  const failing = new Set([topicUrl("topic-01", COMMIT)]);
  const broken = timedFetch(bodies, { failing });
  await assert.rejects(
    readTopic("synthetic-roadmap", "topic-01", COMMIT, { fetch: broken.fetch, topicCache: createTopicDiskCache(folder) }),
    (error: unknown) => error instanceof UpstreamError && error.kind === "unreachable",
  );
  assert.equal(fs.existsSync(topicFile(folder, "topic-01", COMMIT)), false, "no entry for a failed read");

  const healthy = timedFetch(bodies);
  const topic = await readTopic("synthetic-roadmap", "topic-01", COMMIT, { fetch: healthy.fetch, topicCache: createTopicDiskCache(folder) });
  assert.equal(topic.title, "Title of topic-01");
  assert.ok(fs.existsSync(topicFile(folder, "topic-01", COMMIT)), "the successful retry is stored");
});

test("a topic missing at the commit is not cached either", async (t) => {
  const folder = tempFolder(t);
  const { fetch } = timedFetch(bodiesFor(slugsOf(1), COMMIT));
  await assert.rejects(readTopic("synthetic-roadmap", "absent-topic", COMMIT, { fetch, topicCache: createTopicDiskCache(folder) }));
  assert.equal(fs.existsSync(path.join(folder, COMMIT)), false, "nothing written for an error");
});

test("a commit change misses the cache: the same topic is read from GitHub at the new commit", async (t) => {
  const folder = tempFolder(t);
  const original = timedFetch(bodiesFor(slugsOf(1), COMMIT));
  await readTopic("synthetic-roadmap", "topic-01", COMMIT, { fetch: original.fetch, topicCache: createTopicDiskCache(folder) });
  const moved = timedFetch(bodiesFor(slugsOf(1), OTHER_COMMIT));
  await readTopic("synthetic-roadmap", "topic-01", OTHER_COMMIT, { fetch: moved.fetch, topicCache: createTopicDiskCache(folder) });
  assert.equal(moved.calls.length, 2, "the new commit is asked for both the listing and the topic file");
  assert.ok(fs.existsSync(topicFile(folder, "topic-01", OTHER_COMMIT)), "stored under the new commit");
  assert.ok(fs.existsSync(topicFile(folder, "topic-01", COMMIT)), "the old commit's entry is kept, not overwritten");
});

test("prefetch runs when a roadmap is listed, so a later batch read makes no request", async (t) => {
  const folder = tempFolder(t);
  const slugs = slugsOf(3);
  const { fetch, calls } = timedFetch(bodiesFor(slugs, COMMIT));
  const tool = architectTools(t, fetch, folder);
  const listed = await tool("list_roadmap_topics").execute("c1", { roadmapSlug: "synthetic-roadmap" }, undefined);
  assert.equal(listed.isError, undefined);
  // The listing returns before the prefetch finishes: wait for the last listed topic to be stored.
  for (let attempt = 0; attempt < 200 && !fs.existsSync(topicFile(folder, "topic-03", COMMIT)); attempt += 1) await settle();
  for (const slug of slugs) assert.ok(fs.existsSync(topicFile(folder, slug, COMMIT)), `${slug} was prefetched`);

  const before = calls.length;
  const batch = await tool("read_roadmap_topics").execute("c2", { roadmapSlug: "synthetic-roadmap", topicSlugs: slugs }, undefined);
  assert.equal(batch.isError, undefined);
  assert.equal(calls.length, before, "every topic was a cache hit");
});

test("a prefetch failure does not fail a read: the failed topic is its own error and the others read normally", async (t) => {
  const folder = tempFolder(t);
  const slugs = slugsOf(3);
  const failing = new Set([topicUrl("topic-02", COMMIT)]);
  const { fetch } = timedFetch(bodiesFor(slugs, COMMIT), { failing });
  const tool = architectTools(t, fetch, folder);
  const listed = await tool("list_roadmap_topics").execute("c1", { roadmapSlug: "synthetic-roadmap" }, undefined);
  assert.equal(listed.isError, undefined, "the listing still succeeds");
  await settle();

  const batch = await tool("read_roadmap_topics").execute("c2", { roadmapSlug: "synthetic-roadmap", topicSlugs: slugs }, undefined);
  assert.equal(batch.isError, undefined);
  const parsed = JSON.parse(batch.content[0]?.text ?? "{}") as { results: { slug: string; ok: boolean; kind?: string }[] };
  assert.deepEqual(parsed.results.map((entry) => [entry.slug, entry.ok]), [["topic-01", true], ["topic-02", false], ["topic-03", true]]);
  assert.equal(parsed.results[1]?.kind, "unreachable");
});

test("prefetch never rejects, even for an invalid roadmap or when every request fails", async () => {
  const { fetch, calls } = timedFetch({}, { failing: new Set([listingUrl(COMMIT)]) });
  await assert.doesNotReject(prefetchRoadmapTopics("../escape", ["topic-01"], COMMIT, { fetch }));
  await assert.doesNotReject(prefetchRoadmapTopics("synthetic-roadmap", ["topic-01", "topic-02"], COMMIT, { fetch }));
  assert.ok(calls.length > 0 && calls.every((call) => call.url.includes("/roadmaps/synthetic-roadmap/")), "only the valid roadmap is ever asked");
});

test("privacy: no learner text reaches any request, through a batch read, a prefetch or a cache write", async (t) => {
  const folder = tempFolder(t);
  const slugs = slugsOf(5);
  const { fetch, calls } = timedFetch(bodiesFor(slugs, COMMIT));
  const tool = architectTools(t, fetch, folder);
  await tool("read_learner_graph").execute("c0", {}, undefined);
  await tool("list_roadmap_topics").execute("c1", { roadmapSlug: "synthetic-roadmap" }, undefined);
  await tool("read_roadmap_topics").execute("c2", { roadmapSlug: "synthetic-roadmap", topicSlugs: slugs }, undefined);
  await settle();
  assert.ok(calls.length > 0);
  for (const call of calls) {
    assert.match(call.url, ALLOWED_URL, "only the pinned repo, under roadmaps/, at the pinned commit");
    assert.equal(call.url.includes(SECRET), false, "no learner text in a URL");
    assert.equal(JSON.stringify(call.headers).includes(SECRET), false, "no learner text in headers");
  }
  assert.equal(fs.readdirSync(path.join(folder, COMMIT, "synthetic-roadmap")).every((name) => !name.includes(SECRET)), true);
});
