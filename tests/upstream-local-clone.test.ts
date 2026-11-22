/** Local clone of the pinned developer-roadmap topic files (local-topic-clone).
 *
 * Synthetic data only. Git is a fake runner that writes small synthetic roadmap files on checkout; GitHub is a
 * fake fetch. Nothing runs a real git and nothing touches the network.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { PluginAgentTool, PluginBackendContext } from "learnharness-plugin-api";
import { buildArchitectDefinition } from "../src/architect-agent.ts";
import { createLocalRoadmapCopy } from "../src/upstream-clone.ts";
import type { GitRunner, LocalRoadmapCopy } from "../src/upstream-clone.ts";
import {
  LOCAL_TOPIC_READ_CONCURRENCY,
  UPSTREAM_API_BASE,
  UPSTREAM_REPOSITORY,
  UpstreamError,
  listRoadmapTopics,
  prefetchRoadmapTopics,
  readTopic,
  topicReadConcurrency,
} from "../src/upstream-roadmaps.ts";
import type { LocalRoadmapSource, UpstreamFetch } from "../src/upstream-roadmaps.ts";
import { openLearningPathStore } from "../src/store.ts";
import type { ArchitectModelConfig } from "../src/store.ts";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const OTHER_COMMIT = "fedcba9876543210fedcba9876543210fedcba98";
const SECRET = "ZZ-LEARNER-SECRET-7731";
const ROOT = `${UPSTREAM_API_BASE}/repos/${UPSTREAM_REPOSITORY}/contents/roadmaps`;
const CLONE_URL = `https://github.com/${UPSTREAM_REPOSITORY}.git`;

const LOCAL_TOPIC = "# Local Topic\n\nSynthetic local description.\n\n- [@book@Local Book](https://books.example.test/local)\n";
const GITHUB_TOPIC = "# GitHub Topic\n\nSynthetic GitHub description.\n";

/** Synthetic roadmap files: one roadmap, two topics, plus a non-topic file and a file that is not a topic. */
const LOCAL_FILES: Record<string, string> = {
  "roadmaps/synthetic-roadmap/content/local-topic@Aa1.md": LOCAL_TOPIC,
  "roadmaps/synthetic-roadmap/content/second-topic@Bb2.md": "# Second Topic\n\nSecond local description.\n",
  "roadmaps/synthetic-roadmap/content/README.md": "# not a topic\n",
};

const githubListing = () =>
  JSON.stringify([
    { name: "local-topic@Aa1.md", type: "file" },
    { name: "second-topic@Bb2.md", type: "file" },
    { name: "github-only@Cc3.md", type: "file" },
  ]);

interface FakeGit {
  readonly run: GitRunner;
  readonly calls: { args: string[]; cwd: string }[];
}

/** A fake git. `head` is what `rev-parse HEAD` reports; `missing` makes git absent; `failFetch` refuses the fetch.
 * On checkout it writes `files` into the working folder, as a real sparse checkout would. */
function fakeGit(options: { head?: string; missing?: boolean; failFetch?: boolean; files?: Record<string, string> } = {}): FakeGit {
  const calls: { args: string[]; cwd: string }[] = [];
  const run: GitRunner = async (args, cwd) => {
    calls.push({ args: [...args], cwd });
    if (options.missing) throw Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" });
    const [verb] = args;
    if (verb === "init") fs.mkdirSync(path.join(cwd, ".git"), { recursive: true });
    if (verb === "fetch" && options.failFetch) throw new Error("synthetic refused fetch");
    if (verb === "checkout") {
      for (const [relative, body] of Object.entries(options.files ?? LOCAL_FILES)) {
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

/** A fake GitHub: serves the listing and the topic files at the pinned commit, and records every request. */
function fakeGithub() {
  const calls: { url: string; headers: Readonly<Record<string, string>> }[] = [];
  const bodies: Record<string, string> = {
    [`${ROOT}/synthetic-roadmap/content?ref=${COMMIT}`]: githubListing(),
    [`${ROOT}/synthetic-roadmap/content/local-topic@Aa1.md?ref=${COMMIT}`]: LOCAL_TOPIC,
    [`${ROOT}/synthetic-roadmap/content/second-topic@Bb2.md?ref=${COMMIT}`]: "# Second Topic\n\nSecond GitHub description.\n",
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "upstream-local-clone-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A clone made with the fake git, waited on, so reads in the test see its final state. */
async function readyCopy(directory: string, git: FakeGit["run"], commit = COMMIT): Promise<LocalRoadmapCopy> {
  const copy = createLocalRoadmapCopy({ directory, commit, git });
  assert.equal(await copy.ready, true, "the clone is verified");
  return copy;
}

const notCalled = () => {
  throw new Error("GitHub must not be asked");
};

test("the clone runs fixed git arguments: sparse roadmaps only, a shallow fetch of the pinned commit, then a HEAD check", async (t) => {
  const directory = path.join(tempFolder(t), "upstream", "developer-roadmap");
  const git = fakeGit();
  await readyCopy(directory, git.run);
  assert.deepEqual(
    git.calls.map((call) => call.args),
    [
      ["init", "--quiet"],
      ["remote", "add", "origin", CLONE_URL],
      ["sparse-checkout", "set", "roadmaps"],
      ["fetch", "--quiet", "--depth", "1", "origin", COMMIT],
      ["checkout", "--quiet", COMMIT],
      ["rev-parse", "HEAD"],
    ],
  );
  assert.ok(git.calls.every((call) => call.cwd === directory), "every git call runs in the clone folder");
  assert.equal(git.calls.filter((call) => call.args[0] === "sparse-checkout").length, 1);
});

test("a clone whose HEAD is another commit is discarded, and no read uses it", async (t) => {
  const directory = path.join(tempFolder(t), "developer-roadmap");
  const copy = await createLocalRoadmapCopy({ directory, commit: COMMIT, git: fakeGit({ head: OTHER_COMMIT }).run }).ready;
  assert.equal(copy, false, "a mismatched HEAD is not ready");
  assert.equal(fs.existsSync(directory), false, "the mismatched clone is removed");
  const local = createLocalRoadmapCopy({ directory, commit: COMMIT, git: fakeGit({ head: OTHER_COMMIT }).run });
  await local.ready;
  assert.equal(await local.listFiles("synthetic-roadmap"), null);
  assert.equal(await local.readFile("synthetic-roadmap", "local-topic@Aa1.md"), null);
});

test("a clone that fails to fetch is discarded, and reads fall back to GitHub", async (t) => {
  const directory = path.join(tempFolder(t), "developer-roadmap");
  const copy = createLocalRoadmapCopy({ directory, commit: COMMIT, git: fakeGit({ failFetch: true }).run });
  assert.equal(await copy.ready, false);
  assert.equal(fs.existsSync(directory), false, "the partial clone is removed");
});

test("a valid clone already at the pinned commit is reused: only rev-parse runs", async (t) => {
  const directory = path.join(tempFolder(t), "developer-roadmap");
  fs.mkdirSync(path.join(directory, ".git"), { recursive: true });
  const git = fakeGit();
  await readyCopy(directory, git.run);
  assert.deepEqual(git.calls.map((call) => call.args), [["rev-parse", "HEAD"]]);
});

test("reads come from the local files: the listing and a topic are served with no request to GitHub", async (t) => {
  const directory = path.join(tempFolder(t), "developer-roadmap");
  const copy = await readyCopy(directory, fakeGit().run);
  const github = fakeGithub();
  const options = { fetch: github.fetch, local: copy };

  const listing = await listRoadmapTopics("synthetic-roadmap", COMMIT, options);
  assert.deepEqual(listing, [
    { slug: "local-topic", file: "local-topic@Aa1.md" },
    { slug: "second-topic", file: "second-topic@Bb2.md" },
  ]);

  const topic = await readTopic("synthetic-roadmap", "local-topic", COMMIT, options);
  assert.equal(topic.title, "Local Topic");
  assert.equal(topic.description, "Synthetic local description.");
  assert.deepEqual(topic.resources, [{ label: "@book@Local Book", tag: "book", url: "https://books.example.test/local" }]);
  assert.equal(topic.commit, COMMIT);
  assert.equal(github.calls.length, 0, "no GitHub request was made");
});

test("a topic file missing locally falls back to the GitHub read, and a topic absent everywhere is not found", async (t) => {
  const directory = path.join(tempFolder(t), "developer-roadmap");
  const copy = await readyCopy(directory, fakeGit().run);
  // Remove one local file: the listing still names it, so the GitHub path answers for it.
  fs.rmSync(path.join(directory, "roadmaps/synthetic-roadmap/content/second-topic@Bb2.md"));
  const github = fakeGithub();
  const options = { fetch: github.fetch, local: copy };

  const fromGithub = await readTopic("synthetic-roadmap", "second-topic", COMMIT, options);
  assert.equal(fromGithub.title, "Second Topic");
  assert.equal(fromGithub.description, "Second GitHub description.");
  assert.ok(github.calls.length > 0, "GitHub answered for the missing file");

  // A topic that is on GitHub but not in the local folder is read from GitHub too.
  const githubOnly = await readTopic("synthetic-roadmap", "github-only", COMMIT, options);
  assert.equal(githubOnly.description, "Synthetic GitHub description.");

  await assert.rejects(readTopic("synthetic-roadmap", "absent-topic", COMMIT, options), (error: unknown) => error instanceof UpstreamError && error.kind === "not_found");
});

test("no git executable means no clone, and every read uses GitHub", async (t) => {
  const directory = path.join(tempFolder(t), "developer-roadmap");
  const git = fakeGit({ missing: true });
  const copy = createLocalRoadmapCopy({ directory, commit: COMMIT, git: git.run });
  assert.equal(await copy.ready, false);
  assert.equal(fs.existsSync(directory), false);
  const github = fakeGithub();
  const topic = await readTopic("synthetic-roadmap", "local-topic", COMMIT, { fetch: github.fetch, local: copy });
  assert.equal(topic.title, "Local Topic", "the GitHub copy of the file is read");
  assert.ok(github.calls.length >= 2, "the listing and the file came from GitHub");
});

test("a read before the clone is verified uses GitHub, without waiting for git", async (t) => {
  const directory = path.join(tempFolder(t), "developer-roadmap");
  const copy = createLocalRoadmapCopy({ directory, commit: COMMIT, git: fakeGit().run });
  const github = fakeGithub();
  assert.equal(await copy.listFiles("synthetic-roadmap"), null, "not ready yet: no local answer");
  await copy.ready;
  assert.equal((await copy.listFiles("synthetic-roadmap"))?.length, 3, "after the clone is verified the local folder answers");
  assert.equal(github.calls.length, 0);
});

test("the batch cap of 10 still holds with a local copy: 11 is refused before any read, 10 are read locally", async (t) => {
  const directory = path.join(tempFolder(t), "developer-roadmap");
  const copy = await readyCopy(directory, fakeGit().run);
  const github = fakeGithub();
  let localReads = 0;
  const counting: LocalRoadmapSource = {
    listFiles: (roadmap) => copy.listFiles(roadmap),
    readFile: (roadmap, file) => {
      localReads += 1;
      return copy.readFile(roadmap, file);
    },
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "upstream-local-store-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const context = { signal: new AbortController().signal, learning: { graph: () => ({ propositions: [], chains: [] }) } } as unknown as PluginBackendContext;
  const model = { provider: "synthetic", id: "synthetic-model" } as unknown as ArchitectModelConfig;
  const definition = buildArchitectDefinition(context, model, {
    store: openLearningPathStore(dir),
    activeChatId: () => "chat-synthetic",
    upstream: { fetch: github.fetch, commit: COMMIT, local: counting },
  });
  const batch = definition.tools?.find((tool: PluginAgentTool) => tool.name === "read_roadmap_topics") as unknown as {
    execute(id: string, params: unknown, signal: undefined): Promise<{ isError?: boolean; content: { text: string }[] }>;
  };

  const eleven = Array.from({ length: 11 }, (_v, i) => (i % 2 === 0 ? "local-topic" : "second-topic"));
  const refused = await batch.execute("c1", { roadmapSlug: "synthetic-roadmap", topicSlugs: eleven }, undefined);
  assert.equal(refused.isError, true);
  assert.equal(localReads, 0, "nothing was read for the refused batch");
  assert.equal(github.calls.length, 0);

  const ten = eleven.slice(0, 10);
  const result = await batch.execute("c2", { roadmapSlug: "synthetic-roadmap", topicSlugs: ten }, undefined);
  assert.equal(result.isError, undefined);
  const parsed = JSON.parse(result.content[0]?.text ?? "{}") as { results: { ok: boolean }[] };
  assert.equal(parsed.results.length, 10);
  assert.ok(parsed.results.every((entry) => entry.ok));
  assert.equal(localReads, 2, "the ten slugs are two distinct topics, read once each from the local copy");
  assert.equal(github.calls.length, 0);
});

test("local reads run up to 32 at a time, and a bad slug is refused before any local read", async () => {
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
      await new Promise((resolve) => setTimeout(resolve, 15));
      inFlight -= 1;
      return `# ${file}\n\nSynthetic description.\n`;
    },
  };
  assert.equal(topicReadConcurrency({ local }), 32);
  const github = fakeGithub();
  await prefetchRoadmapTopics("synthetic-roadmap", slugs, COMMIT, { fetch: github.fetch, local });
  assert.equal(maxInFlight, 32, "the local reads reach the limit and stay under it");
  assert.equal(reads, 40);
  assert.equal(github.calls.length, 0);

  let touched = 0;
  const counting: LocalRoadmapSource = { listFiles: async () => { touched += 1; return []; }, readFile: async () => { touched += 1; return null; } };
  await assert.rejects(readTopic("Bad/Slug", "local-topic", COMMIT, { fetch: notCalled, local: counting }), (error: unknown) => error instanceof UpstreamError && error.kind === "invalid");
  await assert.rejects(readTopic("synthetic-roadmap", "../etc", COMMIT, { fetch: notCalled, local: counting }), (error: unknown) => error instanceof UpstreamError && error.kind === "invalid");
  assert.equal(touched, 0, "a refused slug never reaches the local copy");
});

test("the GitHub path keeps its 12-request cap when no local copy is given", () => {
  assert.equal(topicReadConcurrency({}), 12);
});

test("privacy: no learner text reaches a git argument, a clone folder name or a GitHub request", async (t) => {
  const directory = path.join(tempFolder(t), "developer-roadmap");
  const git = fakeGit();
  const copy = await readyCopy(directory, git.run);
  fs.rmSync(path.join(directory, "roadmaps/synthetic-roadmap/content/second-topic@Bb2.md"));
  const github = fakeGithub();
  const options = { fetch: github.fetch, local: copy };
  await listRoadmapTopics("synthetic-roadmap", COMMIT, options);
  await readTopic("synthetic-roadmap", "local-topic", COMMIT, options);
  await readTopic("synthetic-roadmap", "second-topic", COMMIT, options);

  for (const call of git.calls) {
    assert.equal(JSON.stringify(call.args).includes(SECRET), false, "no learner text in a git argument");
    assert.equal(call.cwd.includes(SECRET), false, "no learner text in the clone folder");
  }
  for (const call of github.calls) {
    assert.equal(call.url.includes(SECRET), false, "no learner text in a request URL");
    assert.equal(JSON.stringify(call.headers).includes(SECRET), false, "no learner text in headers");
  }
  assert.ok(git.calls.every((call) => !call.args.some((arg) => arg.includes(SECRET))));
});
