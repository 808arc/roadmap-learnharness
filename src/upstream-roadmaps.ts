/** Read-only access to the developer-roadmap topic files (issue #19).
 *
 * Two operations and nothing else: list the topics of one roadmap, and read one
 * topic's title, description and tagged resources. Requests go to the GitHub
 * contents API at one pinned commit, and only under `roadmaps/`.
 *
 * Privacy: a request URL is built from constants, the repository path, a commit
 * SHA and slugs that passed the strict pattern below. Nothing else reaches the
 * network: no learner text, statements, goals or headers derived from them.
 * The fetch function is injected, so tests never touch the network.
 */
export const UPSTREAM_REPOSITORY = "nilbuild/developer-roadmap";
export const UPSTREAM_API_BASE = "https://api.github.com";
/** The pinned upstream commit: nilbuild/developer-roadmap master when this release was cut.
 * Every request reads this commit. It is set by hand and never fetched from master at runtime. */
export const UPSTREAM_PINNED_COMMIT = "6675ce60868ce44aeecc439ad39b3df22453a8ce";
/** The source named on every topic read; resources are attributed to it. */
export const UPSTREAM_SOURCE = "roadmap.sh";
/** Longest topic file accepted, in UTF-16 code units. Real topic files are far smaller. */
export const MAX_TOPIC_CHARS = 200_000;

/** A slug is lowercase letters and digits, joined by a single hyphen, a double hyphen (`ci--cd`) or a
 * single dot (`node.js`). Every separator sits between two alphanumerics, so `.`, `..`, `../x`, `a/b`,
 * `a..b`, `--x`, `x--` and anything with a backslash, slash, `?`, `#` or `%` are all refused. */
const SLUG_PATTERN = /^[a-z0-9]+(?:(?:--|[-.])[a-z0-9]+)*$/;
const MAX_SLUG_CHARS = 80;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
/** Topic file names are `<slug>@<id>.md`. */
const TOPIC_FILE_PATTERN = /^([a-z0-9]+(?:(?:--|[-.])[a-z0-9]+)*)@[A-Za-z0-9_-]+\.md$/;
/** A tagged resource: `[@book@Title](https://...)`. The link text and URL are kept as written. */
const RESOURCE_PATTERN = /\[(@[^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g;

export interface UpstreamResponse {
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
}

/** The only network seam. Tests pass a fake; production passes a fetch wrapper. */
export type UpstreamFetch = (
  url: string,
  init: { readonly headers: Readonly<Record<string, string>> },
) => Promise<UpstreamResponse>;

/** Longest wait for one GitHub response, headers and body together. A slower request is reported as unreachable. */
export const UPSTREAM_TIMEOUT_MS = 15_000;
/** Most topics one batch read may name (read_roadmap_topics). The Architect prompt states the same cap. */
export const MAX_TOPICS_PER_BATCH = 10;
/** Most topic requests in flight at once to GitHub, for a batch read or a background prefetch. */
export const TOPIC_READ_CONCURRENCY = 12;
/** Most topic reads in flight at once from the local clone (file reads; see src/upstream-clone.ts). */
export const LOCAL_TOPIC_READ_CONCURRENCY = 32;

/** Topic reads in flight at once for these options: the local limit when a local copy is given, else the GitHub one. */
export function topicReadConcurrency(options: { readonly local?: LocalRoadmapSource }): number {
  return options.local ? LOCAL_TOPIC_READ_CONCURRENCY : TOPIC_READ_CONCURRENCY;
}

/** A local copy of the topic files at the pinned commit. Reads return null when the copy cannot answer
 * (not ready, the folder or file is missing, or the name is refused); the caller then uses GitHub. */
export interface LocalRoadmapSource {
  /** Names in roadmaps/<roadmap>/content, or null when that folder is not available locally. */
  listFiles(roadmap: string): Promise<readonly string[] | null>;
  /** Slugs of the roadmaps in the local copy, or null when the copy is not available. */
  listRoadmaps?(): Promise<readonly string[] | null>;
  /** Settles when the git fetch of the copy has finished: true when the copy is usable. */
  readonly ready?: Promise<boolean>;
  /** Text of one file in that folder, or null when it is not available locally. */
  readFile(roadmap: string, file: string): Promise<string | null>;
}

/** Runs `work` with at most `limit` in flight; the rest wait in order. */
function createLimiter(limit: number): <T>(work: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async <T>(work: () => Promise<T>): Promise<T> => {
    if (active >= limit) await new Promise<void>((resolve) => waiting.push(resolve));
    active += 1;
    try {
      return await work();
    } finally {
      active -= 1;
      waiting.shift()?.();
    }
  };
}

/** One GitHub gate per fetch function, so every GitHub request in the process stays under TOPIC_READ_CONCURRENCY. */
const githubGates = new WeakMap<UpstreamFetch, ReturnType<typeof createLimiter>>();
function githubGate(fetchFn: UpstreamFetch): ReturnType<typeof createLimiter> {
  let gate = githubGates.get(fetchFn);
  if (!gate) {
    gate = createLimiter(TOPIC_READ_CONCURRENCY);
    githubGates.set(fetchFn, gate);
  }
  return gate;
}

/** Wrap a real fetch so every request is bounded by `timeoutMs`. The caller's init is passed through unchanged. */
export function withUpstreamTimeout(
  send: (url: string, init: { readonly headers: Readonly<Record<string, string>>; readonly signal: AbortSignal }) => Promise<UpstreamResponse>,
  timeoutMs: number = UPSTREAM_TIMEOUT_MS,
): UpstreamFetch {
  return (url, init) => send(url, { headers: init.headers, signal: AbortSignal.timeout(timeoutMs) });
}

export interface UpstreamOptions {
  readonly fetch: UpstreamFetch;
  /** Local copy of the pinned topic files (src/upstream-clone.ts). Tried first; any miss falls back to GitHub. */
  readonly local?: LocalRoadmapSource;
  /** Topic listings already read, keyed by roadmap and commit. Optional: when given, a listing is fetched once
   * and reused, because a pinned commit never changes. A failed read is not kept, so the next call retries. */
  readonly listings?: Map<string, Promise<UpstreamTopicRef[]>>;
  /** Disk cache of successful topic reads, provided by the backend (src/topic-cache.ts). Absent: no disk cache.
   * Only successful reads are written; the commit is part of every key, so a commit change misses. */
  readonly topicCache?: TopicDiskCache;
  /** Topic reads in progress or done, keyed by roadmap, topic and commit. A prefetch and a batch read
   * that ask for the same topic share one request. A failed read is removed, so the next call retries. */
  readonly topics?: Map<string, Promise<UpstreamTopic>>;
  /** Opens a trace for each topic read that reaches a source (the disk cache, the local copy or GitHub). Absent: no trace.
   * A read served from `topics` reaches no source and is not traced. */
  readonly trace?: TopicReadTracer;
}

/** Where a traced topic read found its text. */
export type TopicReadSource = "local" | "github" | "cache";
/** How a traced topic read ended: accepted, the file not found, or refused (invalid, too large, unreachable). */
export type TopicReadOutcome = "accepted" | "not_found" | "rejected";
/** One open trace of a topic read; `end` is called once with where the text came from and the outcome. */
export interface TopicReadStep {
  end(result: { readonly source: TopicReadSource; readonly outcome: TopicReadOutcome }): void;
}
/** Opens the trace of one topic read of `roadmap`. Only the roadmap slug is passed: never a topic slug, text or URL. */
export type TopicReadTracer = (roadmap: string) => TopicReadStep;

/** Storage for successful topic reads. `read` resolves what was stored (validated here) or null. */
export interface TopicDiskCache {
  read(roadmap: string, topic: string, commit: string): Promise<unknown>;
  write(topic: UpstreamTopic): Promise<void>;
}

export type UpstreamErrorKind = "invalid" | "not_found" | "unreachable";

export class UpstreamError extends Error {
  readonly kind: UpstreamErrorKind;
  constructor(kind: UpstreamErrorKind, message: string) {
    super(message);
    this.name = "UpstreamError";
    this.kind = kind;
  }
}

export interface UpstreamTopicRef {
  readonly slug: string;
  /** The file name in roadmaps/<roadmap>/content, as published. */
  readonly file: string;
}

export interface UpstreamResource {
  /** Link text as written, tag included, e.g. "@book@Some Title". */
  readonly label: string;
  /** The tag between the @ signs, e.g. "book" or "official"; null when there is none. */
  readonly tag: string | null;
  /** The URL exactly as written in the topic file. */
  readonly url: string;
}

export interface UpstreamTopic {
  readonly roadmap: string;
  readonly slug: string;
  readonly title: string;
  readonly description: string;
  readonly resources: readonly UpstreamResource[];
  readonly source: typeof UPSTREAM_SOURCE;
  readonly repository: typeof UPSTREAM_REPOSITORY;
  readonly commit: string;
}

/** Slug check. Rejects anything that could name a path other than one plain folder or file stem. */
export function assertSlug(value: unknown, what: string): string {
  if (typeof value !== "string" || value.length > MAX_SLUG_CHARS || !SLUG_PATTERN.test(value)) {
    throw new UpstreamError("invalid", `${what} must be a lowercase slug (letters, digits, single dots, and hyphens that are not at the start or end).`);
  }
  return value;
}

function assertCommit(value: unknown): string {
  if (typeof value !== "string" || !COMMIT_PATTERN.test(value)) {
    throw new UpstreamError("invalid", "The upstream commit must be a full 40-character SHA.");
  }
  return value;
}

function contentsUrl(roadmapSlug: string, commit: string, file?: string): string {
  const folder = `roadmaps/${roadmapSlug}/content`;
  const path = file === undefined ? folder : `${folder}/${file}`;
  return `${UPSTREAM_API_BASE}/repos/${UPSTREAM_REPOSITORY}/contents/${path}?ref=${commit}`;
}

const HEADERS_JSON = {
  Accept: "application/vnd.github+json",
  "User-Agent": "learnharness-roadmap-plugin",
  "X-GitHub-Api-Version": "2022-11-28",
} as const;
const HEADERS_RAW = { ...HEADERS_JSON, Accept: "application/vnd.github.raw" } as const;

async function request(fetchFn: UpstreamFetch, url: string, headers: Readonly<Record<string, string>>, what: string): Promise<string> {
  let response: UpstreamResponse;
  try {
    response = await githubGate(fetchFn)(() => fetchFn(url, { headers }));
  } catch {
    throw new UpstreamError("unreachable", `GitHub could not be reached while reading ${what}.`);
  }
  if (response.status === 404) throw new UpstreamError("not_found", `${what} was not found at the pinned commit.`);
  if (!response.ok) throw new UpstreamError("unreachable", `GitHub returned status ${response.status} for ${what}.`);
  try {
    return await response.text();
  } catch {
    throw new UpstreamError("unreachable", `GitHub returned an unreadable response for ${what}.`);
  }
}

/** Topic files of one roadmap at one commit. The local copy answers when it has the folder; otherwise GitHub does.
 * With `options.listings`, a GitHub listing is read once per roadmap and commit. */
export async function listRoadmapTopics(
  roadmapSlug: string,
  commit: string,
  options: UpstreamOptions,
): Promise<UpstreamTopicRef[]> {
  const roadmap = assertSlug(roadmapSlug, "roadmapSlug");
  const sha = assertCommit(commit);
  const local = await localTopicListing(roadmap, options);
  if (local) return local;
  return githubTopicListing(roadmap, sha, options);
}

function githubTopicListing(roadmap: string, sha: string, options: UpstreamOptions): Promise<UpstreamTopicRef[]> {
  const cache = options.listings;
  const key = `${roadmap}@${sha}`;
  const cached = cache?.get(key);
  if (cached) return cached;
  const pending = fetchTopicListing(roadmap, sha, options);
  if (cache) {
    cache.set(key, pending);
    pending.catch(() => {
      if (cache.get(key) === pending) cache.delete(key);
    });
  }
  return pending;
}

/** Topic refs from a folder's file names; names that are not topic files are ignored. */
/** One topic per slug. Upstream has a few slugs with more than one file (the name carries a random suffix); the
 * first one listed is kept, so the listing, the reads and the counts all agree. */
/** Slugs of every roadmap at the pinned commit. Waits for the git fetch of the local copy; when that copy is not
 * usable, the roadmaps folder is listed from GitHub. */
export async function listRoadmapNames(commit: string, options: UpstreamOptions): Promise<string[]> {
  const sha = assertCommit(commit);
  if (options.local?.listRoadmaps) {
    await options.local.ready;
    const names = await options.local.listRoadmaps();
    if (names && names.length > 0) return [...names].sort();
  }
  const body = await request(options.fetch, `${UPSTREAM_API_BASE}/repos/${UPSTREAM_REPOSITORY}/contents/roadmaps?ref=${sha}`, HEADERS_JSON, "the roadmaps folder");
  let entries: unknown;
  try {
    entries = JSON.parse(body);
  } catch {
    throw new UpstreamError("unreachable", "GitHub returned an unreadable roadmaps folder.");
  }
  if (!Array.isArray(entries)) return [];
  const names: string[] = [];
  for (const entry of entries) {
    const name = (entry as { name?: unknown; type?: unknown } | null);
    if (name?.type === "dir" && typeof name.name === "string" && /^[a-z0-9]+(?:(?:--|[-.])[a-z0-9]+)*$/.test(name.name)) names.push(name.name);
  }
  return names.sort();
}

export function topicRefsOf(names: readonly unknown[]): UpstreamTopicRef[] {
  const topics: UpstreamTopicRef[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    if (typeof name !== "string") continue;
    const match = TOPIC_FILE_PATTERN.exec(name);
    if (!match || seen.has(match[1] as string)) continue;
    seen.add(match[1] as string);
    topics.push({ slug: match[1] as string, file: name });
  }
  return topics;
}

/** The local listing, or null when the local copy does not have the folder (or it is empty): GitHub answers then. */
async function localTopicListing(roadmap: string, options: UpstreamOptions): Promise<UpstreamTopicRef[] | null> {
  if (!options.local) return null;
  try {
    const names = await options.local.listFiles(roadmap);
    if (!names) return null;
    const topics = topicRefsOf(names);
    return topics.length > 0 ? topics : null;
  } catch {
    return null;
  }
}

async function fetchTopicListing(roadmap: string, sha: string, options: UpstreamOptions): Promise<UpstreamTopicRef[]> {
  const body = await request(options.fetch, contentsUrl(roadmap, sha), HEADERS_JSON, `roadmap "${roadmap}"`);
  let entries: unknown;
  try {
    entries = JSON.parse(body);
  } catch {
    throw new UpstreamError("unreachable", `GitHub returned an unreadable listing for roadmap "${roadmap}".`);
  }
  if (!Array.isArray(entries)) throw new UpstreamError("not_found", `Roadmap "${roadmap}" has no content folder.`);
  return topicRefsOf(entries.map((entry) => (entry as { name?: unknown } | null)?.name));
}

/** Title, description and tagged resources of one topic, as the file writes them. */
export function parseTopicMarkdown(markdown: string): { title: string; description: string; resources: UpstreamResource[] } {
  const lines = markdown.split(/\r?\n/);
  const titleIndex = lines.findIndex((line) => /^#\s+\S/.test(line));
  const title = titleIndex === -1 ? "" : (lines[titleIndex] as string).replace(/^#\s+/, "").trim();
  const paragraph: string[] = [];
  for (const line of lines.slice(titleIndex + 1)) {
    const text = line.trim();
    if (text === "") {
      if (paragraph.length > 0) break;
      continue;
    }
    if (/^(#|[-*+]\s|\[|\d+\.\s)/.test(text)) break;
    paragraph.push(text);
  }
  const resources: UpstreamResource[] = [];
  const seen = new Set<string>();
  for (const match of markdown.matchAll(RESOURCE_PATTERN)) {
    const label = match[1] as string;
    const url = match[2] as string;
    const key = `${label}\u0000${url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const tag = /^@([^@\s]+)@/.exec(label);
    resources.push({ label, tag: tag ? (tag[1] as string) : null, url });
  }
  return { title, description: paragraph.join(" "), resources };
}

/** Run `work` over `items` with at most `limit` in flight. Results keep the input order. */
export async function mapWithConcurrency<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await work(items[index] as T);
    }
  });
  await Promise.all(runners);
  return results;
}

function isCachedTopic(value: unknown, roadmap: string, topic: string, commit: string): value is UpstreamTopic {
  if (typeof value !== "object" || value === null) return false;
  const cached = value as Partial<UpstreamTopic>;
  return (
    cached.roadmap === roadmap &&
    cached.slug === topic &&
    cached.commit === commit &&
    cached.source === UPSTREAM_SOURCE &&
    cached.repository === UPSTREAM_REPOSITORY &&
    typeof cached.title === "string" &&
    typeof cached.description === "string" &&
    Array.isArray(cached.resources)
  );
}

/** A cached topic, or null. Any unreadable or mismatched entry is a miss, never an error. */
async function readTopicCache(cache: TopicDiskCache | undefined, roadmap: string, topic: string, commit: string): Promise<UpstreamTopic | null> {
  if (!cache) return null;
  try {
    const stored = await cache.read(roadmap, topic, commit);
    return isCachedTopic(stored, roadmap, topic, commit) ? stored : null;
  } catch {
    return null;
  }
}

/** The topic file's text from the local copy, or null when any part of it is missing there. */
async function readLocalTopic(roadmap: string, topic: string, options: UpstreamOptions): Promise<string | null> {
  if (!options.local) return null;
  const ref = (await localTopicListing(roadmap, options))?.find((candidate) => candidate.slug === topic);
  if (!ref) return null;
  try {
    return await options.local.readFile(roadmap, ref.file);
  } catch {
    return null;
  }
}

/** The topic file's text from GitHub at the pinned commit. */
async function githubTopicMarkdown(roadmap: string, topic: string, sha: string, options: UpstreamOptions): Promise<string> {
  const ref = (await githubTopicListing(roadmap, sha, options)).find((candidate) => candidate.slug === topic);
  if (!ref) throw new UpstreamError("not_found", `Topic "${topic}" was not found in roadmap "${roadmap}".`);
  return request(options.fetch, contentsUrl(roadmap, sha, ref.file), HEADERS_RAW, `topic "${topic}" of roadmap "${roadmap}"`);
}

/** Thrown by a local-only load when the local copy cannot answer. It is never shown to the model. */
class TopicNotLocal extends Error {}

/** One topic from the disk cache, then the local copy, then GitHub (the local copy only when `localOnly`).
 * A load that reaches a source is traced once, with where its text came from and how the read ended. */
async function loadTopic(roadmap: string, topic: string, sha: string, options: UpstreamOptions, localOnly: boolean): Promise<UpstreamTopic> {
  const step = options.trace?.(roadmap);
  let source: TopicReadSource = "cache";
  let result: UpstreamTopic;
  let fromCache = false;
  try {
    const cached = await readTopicCache(options.topicCache, roadmap, topic, sha);
    if (cached) {
      fromCache = true;
      result = cached;
    } else {
      source = "local";
      let markdown = await readLocalTopic(roadmap, topic, options);
      if (markdown === null) {
        if (localOnly) throw new TopicNotLocal(`Topic "${topic}" is not in the local copy.`);
        source = "github";
        markdown = await githubTopicMarkdown(roadmap, topic, sha, options);
      }
      if (markdown.length > MAX_TOPIC_CHARS) throw new UpstreamError("invalid", `Topic "${topic}" is larger than the reader accepts.`);
      result = {
        roadmap,
        slug: topic,
        ...parseTopicMarkdown(markdown),
        source: UPSTREAM_SOURCE,
        repository: UPSTREAM_REPOSITORY,
        commit: sha,
      };
    }
  } catch (error) {
    const outcome: TopicReadOutcome = error instanceof UpstreamError && error.kind === "not_found" ? "not_found" : "rejected";
    step?.end({ source, outcome });
    throw error;
  }
  step?.end({ source, outcome: "accepted" });
  // Best effort: a cache that cannot be written only costs a later request.
  if (!fromCache && options.topicCache) await options.topicCache.write(result).catch(() => undefined);
  return result;
}

/** One topic: its title, description and resources, read from its file at the pinned commit.
 * A cache hit (see `topicCacheDirectory`) makes no request. Errors are never cached. */
export async function readTopic(
  roadmapSlug: string,
  topicSlug: string,
  commit: string,
  options: UpstreamOptions,
): Promise<UpstreamTopic> {
  const roadmap = assertSlug(roadmapSlug, "roadmapSlug");
  const topic = assertSlug(topicSlug, "topicSlug");
  const sha = assertCommit(commit);
  const key = `${roadmap}/${topic}@${sha}`;
  const shared = options.topics?.get(key);
  if (shared) return shared;
  const pending = loadTopic(roadmap, topic, sha, options, false);
  const topics = options.topics;
  if (topics) {
    topics.set(key, pending);
    pending.catch(() => {
      if (topics.get(key) === pending) topics.delete(key);
    });
  }
  return pending;
}

/** One topic from the local copy only (no GitHub request), or null when the copy cannot answer it. A topic already
 * read in this definition is reused; a topic read here is kept for the later reads, as readTopic keeps its own. */
async function localTopic(roadmap: string, slug: string, sha: string, options: UpstreamOptions): Promise<UpstreamTopic | null> {
  try {
    assertSlug(slug, "topicSlug");
  } catch {
    return null;
  }
  const key = `${roadmap}/${slug}@${sha}`;
  const shared = options.topics?.get(key);
  if (shared) return shared.then(
    (topic) => topic,
    () => null,
  );
  try {
    const topic = await loadTopic(roadmap, slug, sha, options, true);
    if (options.topics && !options.topics.has(key)) options.topics.set(key, Promise.resolve(topic));
    return topic;
  } catch {
    return null;
  }
}

/** The listed topics of one roadmap read from the local copy, LOCAL_TOPIC_READ_CONCURRENCY at a time, in the order
 * listed. A topic the copy cannot answer is left out, and no request is made to GitHub for it. */
export async function readLocalTopics(
  roadmapSlug: string,
  topicSlugs: readonly string[],
  commit: string,
  options: UpstreamOptions,
): Promise<UpstreamTopic[]> {
  const roadmap = assertSlug(roadmapSlug, "roadmapSlug");
  const sha = assertCommit(commit);
  if (!options.local) return [];
  // The copy has no folder for this roadmap (not ready, or absent): nothing to read locally.
  const names = await options.local.listFiles(roadmap).catch(() => null);
  if (!names) return [];
  const found = await mapWithConcurrency(topicSlugs, LOCAL_TOPIC_READ_CONCURRENCY, (slug) => localTopic(roadmap, slug, sha, options));
  return found.filter((topic): topic is UpstreamTopic => topic !== null);
}

/** Start reading the listed topics of one roadmap in the background, bounded by TOPIC_READ_CONCURRENCY, so later
 * batch reads are cache hits. Best effort: it never rejects and a failed topic is simply not cached. */
export async function prefetchRoadmapTopics(
  roadmapSlug: string,
  topicSlugs: readonly string[],
  commit: string,
  options: UpstreamOptions,
): Promise<void> {
  try {
    const roadmap = assertSlug(roadmapSlug, "roadmapSlug");
    const sha = assertCommit(commit);
    await mapWithConcurrency(topicSlugs, topicReadConcurrency(options), (slug) =>
      readTopic(roadmap, slug, sha, options).then(
        () => undefined,
        () => undefined,
      ),
    );
  } catch {
    // Best effort: a prefetch never breaks a read.
  }
}
