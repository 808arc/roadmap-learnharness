/** Observed and parallel topic reads: the clone and each topic read are logged (metadata only), list_roadmap_topics
 * returns each topic's title and description, and local reads run in parallel up to the cap.
 *
 * Synthetic data only. A fake git runner writes small synthetic files on checkout, a fake fetch stands in for
 * GitHub, and every log and folder is a temporary one. Nothing runs a real git and nothing touches the network.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { PluginAgentTool, PluginBackendContext } from "learnharness-plugin-api";
import { buildArchitectDefinition } from "../src/architect-agent.ts";
import { createPluginLog } from "../src/plugin-log.ts";
import type { PluginLog } from "../src/plugin-log.ts";
import { createTopicDiskCache } from "../src/topic-cache.ts";
import { createLocalRoadmapCopy } from "../src/upstream-clone.ts";
import type { GitRunner, LocalRoadmapCopy } from "../src/upstream-clone.ts";
import { LOCAL_TOPIC_READ_CONCURRENCY, UPSTREAM_API_BASE, UPSTREAM_REPOSITORY } from "../src/upstream-roadmaps.ts";
import type { LocalRoadmapSource, UpstreamFetch } from "../src/upstream-roadmaps.ts";
import { openLearningPathStore } from "../src/store.ts";
import type { ArchitectModelConfig } from "../src/store.ts";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const OTHER_COMMIT = "fedcba9876543210fedcba9876543210fedcba98";
const SECRET = "ZZ-LEARNER-SECRET-4418";
const ROOT = `${UPSTREAM_API_BASE}/repos/${UPSTREAM_REPOSITORY}/contents/roadmaps`;
const CLONE_URL = `https://github.com/${UPSTREAM_REPOSITORY}.git`;

const LOCAL_TOPIC = "# Local Topic\n\nSynthetic local description.\n\n- [@book@Local Book](https://books.example.test/local)\n";
const SECOND_TOPIC = "# Second Topic\n\nSecond local description.\n";
const GITHUB_TOPIC = "# GitHub Topic\n\nSynthetic GitHub description.\n";

const LOCAL_FILES: Record<string, string> = {
  "roadmaps/synthetic-roadmap/content/local-topic@Aa1.md": LOCAL_TOPIC,
  "roadmaps/synthetic-roadmap/content/second-topic@Bb2.md": SECOND_TOPIC,
  "roadmaps/synthetic-roadmap/content/README.md": "# not a topic\n",
};

const LISTING = JSON.stringify([
  { name: "local-topic@Aa1.md", type: "file" },
  { name: "second-topic@Bb2.md", type: "file" },
  { name: "github-only@Cc3.md", type: "file" },
]);

interface FakeGit {
  readonly run: GitRunner;
  readonly calls: { args: string[]; cwd: string }[];
}

/** A fake git. `head` is what `rev-parse HEAD` reports; `missing` makes git absent; `failFetch` refuses the fetch.
 * On checkout it writes the synthetic files, as a sparse checkout would. */
function fakeGit(options: { head?: string; missing?: boolean; failFetch?: boolean } = {}): FakeGit {
  const calls: { args: string[]; cwd: string }[] = [];
  const run: GitRunner = async (args, cwd) => {
    calls.push({ args: [...args], cwd });
    if (options.missing) throw Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" });
    const [verb] = args;
    if (verb === "init") fs.mkdirSync(path.join(cwd, ".git"), { recursive: true });
    if (verb === "fetch" && options.failFetch) throw new Error("synthetic refused fetch");
    if (verb === "checkout") {
      for (const [relative, body] of Object.entries(LOCAL_FILES)) {
        const target = path.join(cwd, relative);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, body);
      }
    }
    if (verb === "rev-parse") return `${options.head ?? COMMIT}\n`;
    return "";
  };
  return { run, calls };
}

/** A fake GitHub: the listing and the topic files at the pinned commit; every request is recorded. */
function fakeGithub() {
  const calls: { url: string; headers: Readonly<Record<string, string>> }[] = [];
  const bodies: Record<string, string> = {
    [`${ROOT}/synthetic-roadmap/content?ref=${COMMIT}`]: LISTING,
    [`${ROOT}/synthetic-roadmap/content/local-topic@Aa1.md?ref=${COMMIT}`]: LOCAL_TOPIC,
    [`${ROOT}/synthetic-roadmap/content/second-topic@Bb2.md?ref=${COMMIT}`]: SECOND_TOPIC,
    [`${ROOT}/synthetic-roadmap/content/github-only@Cc3.md?ref=${COMMIT}`]: GITHUB_TOPIC,
  };
  const fetch: UpstreamFetch = async (url, init) => {
    calls.push({ url, headers: { ...init.headers } });
    const body = bodies[url];
    if (body === undefined) return { ok: false, status: 404, text: async () => "{}" };
    return { ok: true, status: 200, text: async () => body };
  };
  return { fetch, calls };
}

function tempFolder(t: { after: (fn: () => void) => void }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "observed-parallel-reads-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A clone made with the fake git, waited on. */
async function readyCopy(directory: string, git: GitRunner, log?: PluginLog): Promise<LocalRoadmapCopy> {
  const copy = createLocalRoadmapCopy({ directory, commit: COMMIT, git, log });
  assert.equal(await copy.ready, true, "the clone is verified");
  return copy;
}

const model = { provider: "synthetic", id: "synthetic-model" } as unknown as ArchitectModelConfig;
const context = (): PluginBackendContext =>
  ({
    signal: new AbortController().signal,
    learning: { graph: () => ({ propositions: [{ id: "p1", name: `Topic ${SECRET}`, statement: SECRET, aliases: [], createdAt: "2026-01-01T00:00:00Z", provenance: [] }], chains: [] }) },
  }) as unknown as PluginBackendContext;

type Result = { content: { text: string }[]; isError?: boolean };

/** The Architect's upstream tools for one definition, with their logs written to `log` when given. */
function toolsFor(
  t: { after: (fn: () => void) => void },
  upstream: { fetch: UpstreamFetch; local?: LocalRoadmapSource; topicCache?: ReturnType<typeof createTopicDiskCache> },
  log?: PluginLog,
) {
  const dir = tempFolder(t);
  const definition = buildArchitectDefinition(context(), model, {
    store: openLearningPathStore(dir),
    activeChatId: () => "chat-synthetic",
    log,
    upstream: { commit: COMMIT, ...upstream },
  });
  return (name: string) => {
    const found = definition.tools?.find((candidate: PluginAgentTool) => candidate.name === name);
    assert.ok(found?.execute, `tool ${name} exists`);
    return found as unknown as { execute(id: string, params: unknown, signal: undefined): Promise<Result> };
  };
}

interface LogRecord {
  readonly event: string;
  readonly step?: string;
  readonly [field: string]: unknown;
}

function logRecords(file: string): LogRecord[] {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as LogRecord);
}

/** Waits until `done` is true, polling briefly; a background prefetch finishes after its tool call returns. */
async function waitUntil(done: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 400 && !done(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const topicEnds = (file: string) => logRecords(file).filter((record) => record.step === "topic read" && record.event === "step.end");

// ---- The clone is logged with its outcome and a reason code -----------------------------------------------------

test("the clone logs created, reused and fallback, each with a reason code and no path", async (t) => {
  const dir = tempFolder(t);
  const file = path.join(dir, "architect.jsonl");
  const log = createPluginLog(file);

  const created = path.join(dir, "fresh", "developer-roadmap");
  assert.equal(await createLocalRoadmapCopy({ directory: created, commit: COMMIT, git: fakeGit().run, log }).ready, true);

  const reusedDir = path.join(dir, "reused", "developer-roadmap");
  fs.mkdirSync(path.join(reusedDir, ".git"), { recursive: true });
  assert.equal(await createLocalRoadmapCopy({ directory: reusedDir, commit: COMMIT, git: fakeGit().run, log }).ready, true);

  const staleDir = path.join(dir, "stale", "developer-roadmap");
  fs.mkdirSync(path.join(staleDir, ".git"), { recursive: true });
  assert.equal(await createLocalRoadmapCopy({ directory: staleDir, commit: COMMIT, git: fakeGit({ head: OTHER_COMMIT }).run, log }).ready, false);

  const refusedDir = path.join(dir, "refused", "developer-roadmap");
  assert.equal(await createLocalRoadmapCopy({ directory: refusedDir, commit: COMMIT, git: fakeGit({ failFetch: true }).run, log }).ready, false);

  const absentDir = path.join(dir, "absent", "developer-roadmap");
  assert.equal(await createLocalRoadmapCopy({ directory: absentDir, commit: COMMIT, git: fakeGit({ missing: true }).run, log }).ready, false);

  const ends = logRecords(file).filter((record) => record.step === "upstream clone" && record.event === "step.end");
  assert.equal(ends.length, 5, "one clone step per copy");
  assert.deepEqual(
    ends.map((end) => [end.outcome, end.reason, end.ok]),
    [
      ["created", "fresh_clone", true],
      ["reused", "head_matches", true],
      ["fallback", "head_mismatch", false],
      ["fallback", "fetch_failed", false],
      ["fallback", "no_git", false],
    ],
  );
  for (const end of ends) {
    assert.equal(end.commit, COMMIT);
    assert.equal(typeof end.durationMs, "number");
  }
  const starts = logRecords(file).filter((record) => record.step === "upstream clone" && record.event === "step.start");
  assert.equal(starts.length, 5);
  const text = fs.readFileSync(file, "utf8");
  assert.equal(text.includes(dir), false, "no folder path is logged");
  assert.equal(text.includes(CLONE_URL), false, "no clone URL is logged");
});

test("a stale clone folder at another commit is replaced, and logged as created with replaced_stale_clone", async (t) => {
  const dir = tempFolder(t);
  const file = path.join(dir, "architect.jsonl");
  const staleDir = path.join(dir, "developer-roadmap");
  fs.mkdirSync(path.join(staleDir, ".git"), { recursive: true });
  // The first HEAD check finds the stale commit; after the fresh checkout the HEAD is the pinned one.
  const base = fakeGit();
  const heads = [OTHER_COMMIT];
  const run: GitRunner = (args, cwd) => {
    const stale = args[0] === "rev-parse" ? heads.shift() : undefined;
    return stale ? Promise.resolve(`${stale}\n`) : base.run(args, cwd);
  };
  await readyCopy(staleDir, run, createPluginLog(file));
  const [end] = logRecords(file).filter((record) => record.step === "upstream clone" && record.event === "step.end");
  assert.equal(end?.outcome, "created");
  assert.equal(end?.reason, "replaced_stale_clone");
});

// ---- Each topic read is logged with its source and duration, never its text --------------------------------------

test("topic reads log source, outcome and duration; a read from memory after the list logs nothing new", async (t) => {
  const dir = tempFolder(t);
  const file = path.join(dir, "architect.jsonl");
  const log = createPluginLog(file);
  const copy = await readyCopy(tempFolder(t), fakeGit().run, log);
  const github = fakeGithub();
  const tool = toolsFor(t, { fetch: github.fetch, local: copy }, log);

  await tool("list_roadmap_topics").execute("c1", { roadmapSlug: "synthetic-roadmap" }, undefined);
  const afterList = topicEnds(file);
  assert.equal(afterList.length, 2, "the two listed topics are each one traced read");
  for (const end of afterList) {
    assert.equal(end.roadmap, "synthetic-roadmap");
    assert.equal(end.source, "local");
    assert.equal(end.outcome, "accepted");
    assert.equal(end.ok, true);
    assert.equal(end.count, 2, "count is the number of topics in the call");
    assert.equal(typeof end.durationMs, "number");
  }

  await tool("read_roadmap_topic").execute("c2", { roadmapSlug: "synthetic-roadmap", topicSlug: "local-topic" }, undefined);
  await tool("read_roadmap_topics").execute("c3", { roadmapSlug: "synthetic-roadmap", topicSlugs: ["local-topic", "second-topic"] }, undefined);
  assert.equal(topicEnds(file).length, 2, "the in-memory result is served without a new traced read");
  assert.equal(github.calls.length, 0, "no GitHub request was made");

  const text = fs.readFileSync(file, "utf8");
  for (const forbidden of ["Synthetic local description", "Second local description", "Local Topic", "books.example.test", SECRET]) {
    assert.equal(text.includes(forbidden), false, `the log does not contain ${forbidden}`);
  }
  for (const record of logRecords(file)) {
    for (const key of Object.keys(record)) {
      assert.ok(["ts", "event", "step", "roadmap", "count", "bytes", "source", "outcome", "ok", "durationMs", "commit", "reason"].includes(key), `field ${key} is metadata`);
    }
  }
});

test("a topic read logs github when the copy lacks the file, and not_found for a topic absent everywhere", async (t) => {
  const dir = tempFolder(t);
  const file = path.join(dir, "architect.jsonl");
  const log = createPluginLog(file);
  const folder = tempFolder(t);
  const copy = await readyCopy(folder, fakeGit().run, log);
  fs.rmSync(path.join(folder, "roadmaps/synthetic-roadmap/content/second-topic@Bb2.md"));
  const github = fakeGithub();
  const tool = toolsFor(t, { fetch: github.fetch, local: copy }, log);

  await tool("read_roadmap_topic").execute("c1", { roadmapSlug: "synthetic-roadmap", topicSlug: "second-topic" }, undefined);
  await tool("read_roadmap_topic").execute("c2", { roadmapSlug: "synthetic-roadmap", topicSlug: "absent-topic" }, undefined);
  const ends = topicEnds(file);
  assert.deepEqual(
    ends.map((end) => [end.source, end.outcome, end.count]),
    [
      ["github", "accepted", 1],
      ["github", "not_found", 1],
    ],
  );
});

test("a topic read from the disk cache logs source cache", async (t) => {
  const dir = tempFolder(t);
  const file = path.join(dir, "architect.jsonl");
  const log = createPluginLog(file);
  const folder = tempFolder(t);
  const cache = createTopicDiskCache(path.join(folder, "cache"));
  const copy = await readyCopy(path.join(folder, "clone"), fakeGit().run, log);
  await toolsFor(t, { fetch: fakeGithub().fetch, local: copy, topicCache: cache }, log)("read_roadmap_topic")
    .execute("c1", { roadmapSlug: "synthetic-roadmap", topicSlug: "local-topic" }, undefined);
  // A new definition has no memory, but the disk cache holds the topic: no copy and no GitHub are needed.
  const github = fakeGithub();
  await toolsFor(t, { fetch: github.fetch, topicCache: cache }, log)("read_roadmap_topic")
    .execute("c2", { roadmapSlug: "synthetic-roadmap", topicSlug: "local-topic" }, undefined);
  assert.deepEqual(topicEnds(file).map((end) => end.source), ["local", "cache"]);
  assert.equal(github.calls.length, 0);
});

// ---- list_roadmap_topics returns the full content in one result -------------------------------------------------

test("list_roadmap_topics returns each topic's full content in one result, with no per-topic turn", async (t) => {
  const copy = await readyCopy(path.join(tempFolder(t), "clone"), fakeGit().run);
  const github = fakeGithub();
  const tool = toolsFor(t, { fetch: github.fetch, local: copy });

  const listed = await tool("list_roadmap_topics").execute("c1", { roadmapSlug: "synthetic-roadmap" }, undefined);
  assert.equal(listed.isError, undefined);
  const parsed = JSON.parse(listed.content[0]?.text ?? "{}") as { topics: { slug: string; content: { title: string; description: string } | null }[] };
  assert.deepEqual(parsed.topics, [
    { slug: "local-topic", content: { title: "Local Topic", description: "Synthetic local description.", resources: [{ label: "@book@Local Book", tag: "book", url: "https://books.example.test/local" }] } },
    { slug: "second-topic", content: { title: "Second Topic", description: "Second local description.", resources: [] } },
  ]);
  assert.equal(github.calls.length, 0, "the structure came from the local copy");
});

test("the list still works without a local copy: slugs come back with null content, and GitHub answers the topics", async (t) => {
  const folder = tempFolder(t);
  const file = path.join(folder, "architect.jsonl");
  const log = createPluginLog(file);
  const copy = createLocalRoadmapCopy({ directory: path.join(folder, "clone"), commit: COMMIT, git: fakeGit({ missing: true }).run, log });
  assert.equal(await copy.ready, false);
  const github = fakeGithub();
  const tool = toolsFor(t, { fetch: github.fetch, local: copy }, log);

  const listed = await tool("list_roadmap_topics").execute("c1", { roadmapSlug: "synthetic-roadmap" }, undefined);
  assert.equal(listed.isError, undefined);
  const parsed = JSON.parse(listed.content[0]?.text ?? "{}") as { topics: { slug: string; content: unknown }[] };
  assert.deepEqual(parsed.topics.map((topic) => [topic.slug, topic.content]), [
    ["local-topic", null],
    ["second-topic", null],
    ["github-only", null],
  ]);
  // The background fetch of the three listed topics from GitHub finishes after the call returns.
  await waitUntil(() => topicEnds(file).length === 3);
  assert.deepEqual(topicEnds(file).map((end) => [end.source, end.outcome]), [
    ["github", "accepted"],
    ["github", "accepted"],
    ["github", "accepted"],
  ]);

  const batch = await tool("read_roadmap_topics").execute("c2", { roadmapSlug: "synthetic-roadmap", topicSlugs: ["github-only"] }, undefined);
  const result = JSON.parse(batch.content[0]?.text ?? "{}") as { results: { ok: boolean; topic?: { description: string } }[] };
  assert.equal(result.results[0]?.ok, true);
  assert.equal(result.results[0]?.topic?.description, "Synthetic GitHub description.");
  assert.equal(topicEnds(file).length, 3, "the batch read was served from memory");
});

// ---- Parallel local reads: up to the cap, never above it --------------------------------------------------------

test("local reads for a listing run concurrently, reach the cap of 32 and never exceed it", async (t) => {
  assert.equal(LOCAL_TOPIC_READ_CONCURRENCY, 32);
  const slugs = Array.from({ length: 40 }, (_v, i) => `topic-${String(i + 1).padStart(2, "0")}`);
  let inFlight = 0;
  let maxInFlight = 0;
  let reads = 0;
  const local: LocalRoadmapSource = {
    listFiles: async () => slugs.map((slug) => `${slug}@Id1.md`),
    readFile: async (_roadmap, file) => {
      reads += 1;
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 10));
      inFlight -= 1;
      return `# ${file}\n\nSynthetic description of ${file}.\n`;
    },
  };
  const github = fakeGithub();
  const tool = toolsFor(t, { fetch: github.fetch, local });

  const listed = await tool("list_roadmap_topics").execute("c1", { roadmapSlug: "synthetic-roadmap" }, undefined);
  const parsed = JSON.parse(listed.content[0]?.text ?? "{}") as { topics: { slug: string; content: { title: string } | null }[] };
  assert.equal(parsed.topics.length, 40);
  assert.ok(parsed.topics.every((topic) => topic.content !== null), "every listed topic carries its content");
  assert.equal(reads, 40);
  assert.equal(maxInFlight, LOCAL_TOPIC_READ_CONCURRENCY, "the reads reach the cap");
  assert.equal(github.calls.length, 0);
});

// ---- Privacy: learner text never reaches git, a path, a URL or the log ------------------------------------------

test("privacy: learner text is in no git argument, clone folder, request URL or log line", async (t) => {
  const root = tempFolder(t);
  const folder = path.join(root, "clone");
  const file = path.join(root, "architect.jsonl");
  const log = createPluginLog(file);
  const git = fakeGit();
  const copy = await readyCopy(folder, git.run, log);
  fs.rmSync(path.join(folder, "roadmaps/synthetic-roadmap/content/second-topic@Bb2.md"));
  const github = fakeGithub();
  const tool = toolsFor(t, { fetch: github.fetch, local: copy }, log);

  await tool("list_roadmap_topics").execute("c1", { roadmapSlug: "synthetic-roadmap" }, undefined);
  await tool("read_roadmap_topics").execute("c2", { roadmapSlug: "synthetic-roadmap", topicSlugs: ["local-topic", "second-topic"] }, undefined);

  for (const call of git.calls) {
    assert.equal(call.args.some((arg) => arg.includes(SECRET)), false, "no learner text in a git argument");
    assert.equal(call.cwd.includes(SECRET), false, "no learner text in the clone folder");
  }
  for (const call of github.calls) assert.equal(call.url.includes(SECRET), false, "no learner text in a request URL");
  assert.equal(fs.readFileSync(file, "utf8").includes(SECRET), false, "no learner text in the log");
});
