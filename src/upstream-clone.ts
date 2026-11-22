/** Local copy of the pinned developer-roadmap topic files (backend only: it runs git and reads the file system;
 * the browser bundle never imports this).
 *
 * One sparse, shallow clone of `roadmaps/` at the pinned commit, kept in the plugin data folder. Every git call
 * uses execFile with fixed arguments: no learner text, and no value other than the pinned commit and the
 * constant repository URL, ever reaches git. The clone is used only when its HEAD equals the pinned commit;
 * otherwise it is discarded and never read. Any failure (no git, a failed clone, a missing file) leaves the
 * caller to use GitHub.
 */
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { UPSTREAM_REPOSITORY } from "./upstream-roadmaps.ts";
import type { LocalRoadmapSource } from "./upstream-roadmaps.ts";
import type { PluginLog } from "./plugin-log.ts";

/** The repository cloned. A constant: it is never built from input. */
const CLONE_URL = `https://github.com/${UPSTREAM_REPOSITORY}.git`;
const GIT_TIMEOUT_MS = 180_000;
const GIT_MAX_BUFFER_BYTES = 1024 * 1024;
/** A roadmap folder name: the same shape as a topic slug. */
const ROADMAP_SLUG = /^[a-z0-9]+(?:(?:--|[-.])[a-z0-9]+)*$/;
/** A topic file name as the repository publishes it: a plain file name, no folders, no leading dot. */
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._@-]*\.md$/;

/** Runs `git` with fixed arguments in `cwd` and resolves its stdout. Rejects on any failure. */
export type GitRunner = (args: readonly string[], cwd: string) => Promise<string>;

/** The real runner: execFile, no shell, no prompts, bounded in time and output. */
export const runGit: GitRunner = (args, cwd) =>
  new Promise((resolve, reject) => {
    execFile(
      "git",
      [...args],
      { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER_BYTES, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
      (error, stdout) => (error ? reject(error) : resolve(String(stdout))),
    );
  });

export interface LocalRoadmapCopyOptions {
  /** The clone folder, e.g. `<plugin data>/upstream/developer-roadmap`. */
  readonly directory: string;
  /** The pinned commit, a full 40-character SHA. */
  readonly commit: string;
  /** Test seam; the default is runGit. */
  readonly git?: GitRunner;
  /** Writes one "upstream clone" step: outcome created | reused | fallback, a reason code, the commit and durationMs. */
  readonly log?: PluginLog;
}

export interface LocalRoadmapCopy extends LocalRoadmapSource {
  /** Settles to true when the clone is verified at the pinned commit, false when it is unavailable. Never rejects. */
  readonly ready: Promise<boolean>;
}

/** Starts preparing the clone in the background. Reads return null until it is verified, so the first reads
 * use GitHub rather than wait for a clone. */
export function createLocalRoadmapCopy(options: LocalRoadmapCopyOptions): LocalRoadmapCopy {
  const git = options.git ?? runGit;
  const step = options.log?.begin("upstream clone", { commit: options.commit });
  let available = false;
  const ready = prepareClone(options.directory, options.commit, git).then((result) => {
    available = result.ok;
    step?.end(result.ok ? { outcome: result.outcome, reason: result.reason } : { outcome: "fallback", reason: result.reason, ok: false });
    return result.ok;
  });

  const contentFolder = (roadmap: string): string | null =>
    ROADMAP_SLUG.test(roadmap) ? path.join(options.directory, "roadmaps", roadmap, "content") : null;

  return {
    ready,
    async listFiles(roadmap) {
      const folder = available ? contentFolder(roadmap) : null;
      if (!folder) return null;
      try {
        return await fs.readdir(folder);
      } catch {
        return null;
      }
    },
    async readFile(roadmap, file) {
      const folder = available ? contentFolder(roadmap) : null;
      if (!folder || !FILE_NAME.test(file)) return null;
      try {
        return await fs.readFile(path.join(folder, file), "utf8");
      } catch {
        return null;
      }
    },
  };
}

/** True when `directory` is a git repository whose HEAD is `commit`. Any error is false. */
async function headIs(directory: string, commit: string, git: GitRunner): Promise<boolean> {
  try {
    await fs.stat(path.join(directory, ".git"));
    const head = (await git(["rev-parse", "HEAD"], directory)).trim();
    return head === commit;
  } catch {
    return false;
  }
}

async function exists(target: string): Promise<boolean> {
  return fs.stat(target).then(
    () => true,
    () => false,
  );
}

/** Removes the clone folder. It is the fixed plugin path, never input. */
async function discard(directory: string): Promise<void> {
  await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined);
}

/** The outcome of preparing the clone. `reason` is a fixed code, never a message from git. */
type CloneResult =
  | { readonly ok: true; readonly outcome: "created" | "reused"; readonly reason: string }
  | { readonly ok: false; readonly reason: string };

/** Git is absent when spawning it fails with ENOENT. */
function gitMissing(error: unknown): boolean {
  return (error as { readonly code?: unknown } | null)?.code === "ENOENT";
}

/** Verify an existing clone, or make one. Ok only when HEAD equals the pinned commit. Never rejects. */
async function prepareClone(directory: string, commit: string, git: GitRunner): Promise<CloneResult> {
  let stage = "setup";
  try {
    if (await headIs(directory, commit, git)) return { ok: true, outcome: "reused", reason: "head_matches" };
    // Not a clone at the pinned commit (or none yet): start again from an empty folder.
    const stale = await exists(directory);
    await discard(directory);
    await fs.mkdir(directory, { recursive: true });
    await git(["init", "--quiet"], directory);
    await git(["remote", "add", "origin", CLONE_URL], directory);
    await git(["sparse-checkout", "set", "roadmaps"], directory);
    stage = "fetch";
    await git(["fetch", "--quiet", "--depth", "1", "origin", commit], directory);
    stage = "checkout";
    await git(["checkout", "--quiet", commit], directory);
    if (await headIs(directory, commit, git)) {
      return { ok: true, outcome: "created", reason: stale ? "replaced_stale_clone" : "fresh_clone" };
    }
    await discard(directory);
    return { ok: false, reason: "head_mismatch" };
  } catch (error) {
    // No git, a network failure or a refused fetch: the clone is unusable and GitHub answers instead.
    await discard(directory);
    return { ok: false, reason: gitMissing(error) ? "no_git" : `${stage}_failed` };
  }
}
