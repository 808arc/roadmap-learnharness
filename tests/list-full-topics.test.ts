/** list_roadmap_topics returns every topic in full in one call: slug, title, description and tagged resources read
 * from the local copy in parallel (cap 32). A topic the copy cannot answer keeps its slot with null content and is
 * fetched in the background. Over MAX_LIST_BYTES the list carries titles and descriptions only.
 *
 * Synthetic data only. A fake git runner writes synthetic topic files into a temporary clone, a fake fetch stands in
 * for GitHub, and every log and folder is temporary. Nothing runs a real git and nothing touches the network.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { PluginAgentTool, PluginBackendContext } from "learnharness-plugin-api";
import { LIST_TRUNCATED_NOTE, MAX_LIST_BYTES, buildArchitectDefinition } from "../src/architect-agent.ts";
import { createPluginLog } from "../src/plugin-log.ts";
import type { PluginLog } from "../src/plugin-log.ts";
import { createLocalRoadmapCopy } from "../src/upstream-clone.ts";
import type { GitRunner, LocalRoadmapCopy } from "../src/upstream-clone.ts";
import { LOCAL_TOPIC_READ_CONCURRENCY, UPSTREAM_API_BASE, UPSTREAM_REPOSITORY } from "../src/upstream-roadmaps.ts";
import type { LocalRoadmapSource, UpstreamFetch } from "../src/upstream-roadmaps.ts";
import { openLearningPathStore } from "../src/store.ts";
import type { ArchitectModelConfig } from "../src/store.ts";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const SECRET = "ZZ-LEARNER-SECRET-7731";
const ROADMAP = "synthetic-roadmap";
const ROOT = `${UPSTREAM_API_BASE}/repos/${UPSTREAM_REPOSITORY}/contents/roadmaps`;
const CONTENT_FOLDER = `roadmaps/${ROADMAP}/content`;
const TOPIC_COUNT = 188;

interface Synthetic {
  readonly slug: string;
  readonly file: string;
  readonly body: string;
  readonly title: string;
  readonly description: string;
  readonly resources: readonly { label: string; tag: string; url: string }[];
}

interface Shape {
  /** Characters of filler after the description sentence. */
  readonly descriptionPadding?: number;
  /** Tagged resources per topic (two by default). */
  readonly resourceCount?: number;
  /** Characters of filler in each resource url. */
  readonly urlPadding?: number;
}

/** One synthetic topic file. The title and link text carry quotes and an ampersand; a URL keeps its query string. */
function syntheticTopic(index: number, shape: Shape = {}): Synthetic {
  const slug = `topic-${String(index).padStart(3, "0")}`;
  const file = `${slug}@Id${index}.md`;
  const title = `Title & "quoted" ${index}`;
  const description = `Synthetic description ${index}.${"x".repeat(shape.descriptionPadding ?? 40)}`;
  const resourceCount = shape.resourceCount ?? 2;
  const padding = "p".repeat(shape.urlPadding ?? 0);
  const resources = Array.from({ length: resourceCount }, (_, position) => ({
    label: `@book@Book ${index}-${position}`,
    tag: "book",
    url: `https://books.example.test/${slug}/${position}?ref=a&b=%20${padding}`,
  }));
  const body = [
    `# ${title}`,
    "",
    description,
    "",
    ...resources.map((resource) => `- [${resource.label}](${resource.url})`),
    "",
  ].join("\n");
  return { slug, file, body, title, description, resources };
}

function syntheticTopics(count: number, shape?: Shape): Synthetic[] {
  return Array.from({ length: count }, (_, index) => syntheticTopic(index, shape));
}

/** A fake git: `init` and `checkout` make the clone, the checkout writes the given files, rev-parse reports the commit. */
function fakeGit(files: ReadonlyMap<string, string>) {
  const calls: { args: string[]; cwd: string }[] = [];
  const run: GitRunner = async (args, cwd) => {
    calls.push({ args: [...args], cwd });
    const [verb] = args;
    if (verb === "init") fs.mkdirSync(path.join(cwd, ".git"), { recursive: true });
    if (verb === "checkout") {
      for (const [relative, body] of files) {
        const target = path.join(cwd, relative);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, body);
      }
    }
    if (verb === "rev-parse") return `${COMMIT}\n`;
    return "";
  };
  return { run, calls };
}

/** A fake GitHub: serves `bodies` at the pinned commit and records every request. */
function fakeGithub(bodies: Record<string, string>) {
  const calls: { url: string }[] = [];
  const fetch: UpstreamFetch = async (url) => {
    calls.push({ url });
    const body = bodies[url];
    if (body === undefined) return { ok: false, status: 404, text: async () => "{}" };
    return { ok: true, status: 200, text: async () => body };
  };
  return { fetch, calls };
}

const listingUrl = `${ROOT}/${ROADMAP}/content?ref=${COMMIT}`;
const topicUrl = (file: string) => `${ROOT}/${ROADMAP}/content/${file}?ref=${COMMIT}`;

function tempFolder(t: { after: (fn: () => void) => void }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "list-full-topics-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A clone of `files` made with the fake git, verified before the test reads it. */
async function readyCopy(directory: string, files: ReadonlyMap<string, string>, log?: PluginLog): Promise<LocalRoadmapCopy> {
  const copy = createLocalRoadmapCopy({ directory, commit: COMMIT, git: fakeGit(files).run, log });
  assert.equal(await copy.ready, true, "the clone is verified");
  return copy;
}

function contentFiles(topics: readonly Synthetic[]): Map<string, string> {
  return new Map(topics.map((topic) => [`${CONTENT_FOLDER}/${topic.file}`, topic.body]));
}

const model = { provider: "synthetic", id: "synthetic-model" } as unknown as ArchitectModelConfig;
const context = (): PluginBackendContext =>
  ({
    signal: new AbortController().signal,
    learning: { graph: () => ({ propositions: [{ id: "p1", name: `Topic ${SECRET}`, statement: SECRET, aliases: [], createdAt: "2026-01-01T00:00:00Z", provenance: [] }], chains: [] }) },
  }) as unknown as PluginBackendContext;

type Result = { content: { text: string }[]; isError?: boolean };

/** The Architect's upstream tools for one definition; the log is written to `log` when given. */
function toolsFor(dir: string, upstream: { fetch: UpstreamFetch; local?: LocalRoadmapSource }, log?: PluginLog) {
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

interface ListedTopic {
  readonly slug: string;
  readonly content: { title: string; description: string; resources: { label: string; tag: string | null; url: string }[] } | null;
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

/** Waits until `done` is true, polling briefly; the background prefetch finishes after the tool call returns. */
async function waitUntil(done: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 400 && !done(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

// ---- The full list comes back in one call ---------------------------------------------------------------------------

test("the constants: 400 KB size limit and a local read cap of 32", () => {
  assert.equal(MAX_LIST_BYTES, 400 * 1024);
  assert.equal(LOCAL_TOPIC_READ_CONCURRENCY, 32);
});

test("list_roadmap_topics returns the full content of 188 topics in one call, with no GitHub request", async (t) => {
  const topics = syntheticTopics(TOPIC_COUNT);
  const copy = await readyCopy(path.join(tempFolder(t), "clone"), contentFiles(topics));
  const github = fakeGithub({});
  const tool = toolsFor(tempFolder(t), { fetch: github.fetch, local: copy });

  const listed = await tool("list_roadmap_topics").execute("c1", { roadmapSlug: ROADMAP }, undefined);
  assert.equal(listed.isError, undefined);
  const parsed = JSON.parse(listed.content[0]?.text ?? "{}") as { roadmap: string; count: number; truncated?: boolean; topics: ListedTopic[] };
  assert.equal(parsed.roadmap, ROADMAP);
  assert.equal(parsed.count, TOPIC_COUNT);
  assert.equal(parsed.truncated, undefined, "the full list is under the size limit");
  assert.equal(parsed.topics.length, TOPIC_COUNT);
  assert.ok(parsed.topics.every((topic) => topic.content !== null), "every topic carries its content");
  assert.equal(github.calls.length, 0, "the copy answered every topic");
});

test("each topic's text matches its file exactly: title, description, and each resource's label, tag and url", async (t) => {
  const folder = tempFolder(t);
  const clone = path.join(folder, "clone");
  const topics = syntheticTopics(TOPIC_COUNT);
  const copy = await readyCopy(clone, contentFiles(topics));
  const tool = toolsFor(tempFolder(t), { fetch: fakeGithub({}).fetch, local: copy });

  const listed = await tool("list_roadmap_topics").execute("c1", { roadmapSlug: ROADMAP }, undefined);
  const parsed = JSON.parse(listed.content[0]?.text ?? "{}") as { topics: ListedTopic[] };
  assert.deepEqual(parsed.topics.map((topic) => topic.slug), topics.map((topic) => topic.slug));
  for (const [index, expected] of topics.entries()) {
    const listedTopic = parsed.topics[index];
    assert.equal(listedTopic?.slug, expected.slug);
    const content = listedTopic?.content;
    assert.ok(content, `${expected.slug} has content`);
    assert.equal(content.title, expected.title);
    assert.equal(content.description, expected.description);
    assert.deepEqual(content.resources, expected.resources);
    // The text on disk, read straight from the synthetic file, holds each value as written.
    const onDisk = fs.readFileSync(path.join(clone, CONTENT_FOLDER, expected.file), "utf8");
    assert.ok(onDisk.includes(`# ${content.title}\n`), `${expected.slug}: the title is the heading as written`);
    assert.ok(onDisk.includes(`\n${content.description}\n`), `${expected.slug}: the description is the paragraph as written`);
    for (const resource of content.resources) {
      assert.ok(onDisk.includes(`[${resource.label}](${resource.url})`), `${expected.slug}: ${resource.url} is written as is`);
    }
  }
});

test("a topic the copy cannot answer keeps its slot with null content and is fetched from GitHub in the background", async (t) => {
  const folder = tempFolder(t);
  const topics = syntheticTopics(TOPIC_COUNT - 2);
  const extras = ["missing-a@Ma1.md", "missing-b@Mb2.md"];
  const copy = await readyCopy(path.join(folder, "clone"), contentFiles(topics));
  // The copy lists two more topic files but cannot read them, so those topics are listed and missing.
  const local: LocalRoadmapSource = {
    listFiles: async (roadmap) => {
      const names = await copy.listFiles(roadmap);
      return names ? [...names, ...extras] : null;
    },
    readFile: async (roadmap, file) => (extras.includes(file) ? null : copy.readFile(roadmap, file)),
  };
  const missingBody = (file: string) => `# Missing from the copy ${file}\n\nFetched from GitHub.\n`;
  const listing = JSON.stringify([...topics.map((topic) => ({ name: topic.file })), ...extras.map((name) => ({ name }))]);
  const github = fakeGithub({
    [listingUrl]: listing,
    [topicUrl(extras[0] as string)]: missingBody(extras[0] as string),
    [topicUrl(extras[1] as string)]: missingBody(extras[1] as string),
  });
  const tool = toolsFor(folder, { fetch: github.fetch, local });

  const listed = await tool("list_roadmap_topics").execute("c1", { roadmapSlug: ROADMAP }, undefined);
  assert.equal(listed.isError, undefined);
  const parsed = JSON.parse(listed.content[0]?.text ?? "{}") as { count: number; topics: ListedTopic[] };
  assert.equal(parsed.count, TOPIC_COUNT);
  assert.equal(parsed.topics.length, TOPIC_COUNT, "every listed topic keeps its slot");
  const missingSlots = parsed.topics.filter((topic) => topic.content === null).map((topic) => topic.slug);
  assert.deepEqual(missingSlots, ["missing-a", "missing-b"]);
  assert.ok(parsed.topics.slice(0, TOPIC_COUNT - 2).every((topic) => topic.content !== null));

  await waitUntil(() => github.calls.some((call) => call.url === topicUrl(extras[1] as string)));
  for (const file of extras) {
    assert.ok(github.calls.some((call) => call.url === topicUrl(file)), `${file} was fetched from GitHub in the background`);
  }
});

// ---- Size guard -----------------------------------------------------------------------------------------------------

test("over the size limit the list carries slugs, titles and descriptions only, with a note on read_roadmap_topics", async (t) => {
  // Twelve resources of about 230 bytes each make the full list about 520 KB, over the 400 KB limit.
  // Titles and descriptions alone stay far under it.
  const topics = syntheticTopics(TOPIC_COUNT, { resourceCount: 12, urlPadding: 160 });
  const copy = await readyCopy(path.join(tempFolder(t), "clone"), contentFiles(topics));
  const tool = toolsFor(tempFolder(t), { fetch: fakeGithub({}).fetch, local: copy });

  const listed = await tool("list_roadmap_topics").execute("c1", { roadmapSlug: ROADMAP }, undefined);
  assert.equal(listed.isError, undefined);
  const text = listed.content[0]?.text ?? "";
  assert.ok(Buffer.byteLength(text, "utf8") <= MAX_LIST_BYTES, "the returned list is within the limit");
  const fullBytes = Buffer.byteLength(JSON.stringify({ topics: topics.map((topic) => ({ slug: topic.slug, content: topic })) }), "utf8");
  assert.ok(fullBytes > MAX_LIST_BYTES, "the full content would have been over the limit");
  const parsed = JSON.parse(text) as { truncated: boolean; note: string; topics: Record<string, unknown>[] };
  assert.equal(parsed.truncated, true);
  assert.equal(parsed.note, LIST_TRUNCATED_NOTE);
  assert.match(parsed.note, /read_roadmap_topics/);
  assert.equal(parsed.topics.length, TOPIC_COUNT);
  for (const [index, entry] of parsed.topics.entries()) {
    assert.deepEqual(Object.keys(entry).sort(), ["description", "slug", "title"], "only slug, title and description");
    assert.equal(entry.slug, topics[index]?.slug);
    assert.equal(entry.title, topics[index]?.title);
    assert.equal(entry.description, topics[index]?.description);
  }
  assert.equal(text.includes("books.example.test"), false, "no resource url is in the truncated list");
});

// ---- Logging and privacy ---------------------------------------------------------------------------------------------

test("one topic list step is logged per call, with metadata only and source local", async (t) => {
  const folder = tempFolder(t);
  const file = path.join(folder, "architect.jsonl");
  const log = createPluginLog(file);
  const topics = syntheticTopics(TOPIC_COUNT);
  const copy = await readyCopy(path.join(folder, "clone"), contentFiles(topics), log);
  const tool = toolsFor(folder, { fetch: fakeGithub({}).fetch, local: copy }, log);

  await tool("list_roadmap_topics").execute("c1", { roadmapSlug: ROADMAP }, undefined);
  const ends = logRecords(file).filter((record) => record.step === "topic list" && record.event === "step.end");
  assert.equal(ends.length, 1);
  const [end] = ends;
  assert.equal(end?.roadmap, ROADMAP);
  assert.equal(end?.count, TOPIC_COUNT);
  assert.equal(end?.source, "local");
  assert.equal(end?.ok, true);
  assert.equal(typeof end?.bytes, "number");
  assert.equal(typeof end?.durationMs, "number");
});

test("the topic list step says mixed when the copy answers some topics, and github when it answers none", async (t) => {
  const folder = tempFolder(t);
  const file = path.join(folder, "architect.jsonl");
  const log = createPluginLog(file);
  const topics = syntheticTopics(3);
  const extras = ["missing-a@Ma1.md"];
  const copy = await readyCopy(path.join(folder, "clone"), contentFiles(topics), log);
  const local: LocalRoadmapSource = {
    listFiles: async (roadmap) => [...((await copy.listFiles(roadmap)) ?? []), ...extras],
    readFile: async (roadmap, name) => (extras.includes(name) ? null : copy.readFile(roadmap, name)),
  };
  const listing = JSON.stringify([...topics.map((topic) => ({ name: topic.file })), ...extras.map((name) => ({ name }))]);
  const github = fakeGithub({ [listingUrl]: listing });
  const tool = toolsFor(folder, { fetch: github.fetch, local }, log);
  await tool("list_roadmap_topics").execute("c1", { roadmapSlug: ROADMAP }, undefined);
  await waitUntil(() => github.calls.some((call) => call.url === topicUrl(extras[0] as string)));
  assert.equal(logRecords(file).find((record) => record.step === "topic list" && record.event === "step.end")?.source, "mixed");

  // No local copy at all: the listing and every topic come from GitHub.
  const otherFolder = tempFolder(t);
  const otherFile = path.join(otherFolder, "architect.jsonl");
  const otherLog = createPluginLog(otherFile);
  const noCopy = createLocalRoadmapCopy({ directory: path.join(otherFolder, "clone"), commit: COMMIT, git: async () => { throw Object.assign(new Error("git missing"), { code: "ENOENT" }); }, log: otherLog });
  assert.equal(await noCopy.ready, false);
  const githubOnly = fakeGithub({ [listingUrl]: JSON.stringify(topics.map((topic) => ({ name: topic.file }))) });
  const otherTool = toolsFor(otherFolder, { fetch: githubOnly.fetch, local: noCopy }, otherLog);
  await otherTool("list_roadmap_topics").execute("c2", { roadmapSlug: ROADMAP }, undefined);
  assert.equal(logRecords(otherFile).find((record) => record.step === "topic list" && record.event === "step.end")?.source, "github");
});

test("privacy: learner text is in no request, git argument or log line, and the topic list step logs no topic text", async (t) => {
  const folder = tempFolder(t);
  const file = path.join(folder, "architect.jsonl");
  const log = createPluginLog(file);
  const topics = syntheticTopics(20);
  const git = fakeGit(contentFiles(topics));
  const copy = createLocalRoadmapCopy({ directory: path.join(folder, "clone"), commit: COMMIT, git: git.run, log });
  assert.equal(await copy.ready, true);
  const github = fakeGithub({});
  const tool = toolsFor(folder, { fetch: github.fetch, local: copy }, log);

  await tool("list_roadmap_topics").execute("c1", { roadmapSlug: ROADMAP }, undefined);

  for (const call of git.calls) {
    assert.equal(call.args.some((arg) => arg.includes(SECRET)), false, "no learner text in a git argument");
  }
  for (const call of github.calls) assert.equal(call.url.includes(SECRET), false, "no learner text in a request URL");

  const text = fs.readFileSync(file, "utf8");
  assert.equal(text.includes(SECRET), false, "no learner text in the log");
  for (const topic of topics.slice(0, 3)) {
    assert.equal(text.includes(topic.description), false, `no description of ${topic.slug} in the log`);
    assert.equal(text.includes(topic.title), false, `no title of ${topic.slug} in the log`);
  }
  assert.equal(text.includes("books.example.test"), false, "no resource url in the log");

  const allowed = ["ts", "event", "step", "roadmap", "count", "bytes", "source", "outcome", "ok", "durationMs", "done", "total", "rounds", "commit", "reason"];
  const listSteps = logRecords(file).filter((record) => record.step === "topic list");
  assert.ok(listSteps.length >= 2, "the list step is logged as start and end");
  for (const record of listSteps) {
    for (const key of Object.keys(record)) assert.ok(allowed.includes(key), `field ${key} is metadata`);
  }
});
