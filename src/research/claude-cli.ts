/** Deep research through the Claude Code CLI — the same `claude` binary
 * LearnHarness itself runs for its claude-code provider, on the learner's own
 * subscription. Only WebSearch and WebFetch are available to it: no shell, no
 * file access, no MCP servers, no hooks, no project instructions, and it runs
 * in an empty temporary folder.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MAX_RUN_MS = 40 * 60_000;
const MAX_OUTPUT = 2_000_000;

export function findClaudeBinary(env: NodeJS.ProcessEnv = process.env): string | null {
  const windows = process.platform === "win32";
  const home = os.homedir();
  const names = windows ? ["claude.exe"] : ["claude"];
  const dirs = [
    ...(env.PATH ?? env.Path ?? "").split(path.delimiter),
    path.join(home, ".local", "bin"),
    path.join(home, ".claude", "local"),
    windows ? (env.npm_config_prefix ?? path.join(env.APPDATA ?? path.join(home, "AppData", "Roaming"), "npm")) : path.join(home, ".npm-global", "bin"),
    ...(windows ? [] : ["/opt/homebrew/bin", "/usr/local/bin"]),
  ].filter(Boolean);
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        // Not here.
      }
    }
  }
  return null;
}

const SYSTEM = `You are a research assistant preparing material for a learning roadmap.
Search widely and READ the pages you rely on (syllabi, tables of contents, reviews, "best books" threads, university courses).
Report in Markdown:
1. The field map: subareas and the order experts teach them in, with prerequisites.
2. Canonical resources (the most recommended books, courses, official docs) — with why they are recommended and where (links).
3. Deeper resources beyond the obvious: strong but less popular books, lecture notes, university courses, papers, other languages.
4. For every book/course you inspected: the chapters or modules relevant to each subarea.
5. What learners commonly skip or should skip for this goal, common pitfalls, and how practitioners recommend practising.
Cite every claim with a link. Mark anything you could not verify.`;

export interface ClaudeRunProgress {
  (activity: string): void;
}

export async function runClaudeResearch(
  binary: string,
  question: string,
  options: { signal?: AbortSignal; onActivity?: ClaudeRunProgress; model?: string },
): Promise<string> {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "roadmap-research-"));
  const args = [
    "-p",
    "--output-format", "stream-json",
    "--verbose",
    "--append-system-prompt", SYSTEM,
    "--tools", "WebSearch,WebFetch",
    "--allowedTools", "WebSearch,WebFetch",
    "--strict-mcp-config",
    "--setting-sources", "user",
    "--settings", JSON.stringify({ disableAllHooks: true, outputStyle: "default", env: { CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1" } }),
    "--disable-slash-commands",
    "--no-session-persistence",
    "--permission-prompts", "none",
    ...(options.model ? ["--model", options.model] : []),
  ];
  try {
    return await new Promise<string>((resolve, reject) => {
      const child = spawn(binary, args, { cwd, windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: process.env });
      const timer = setTimeout(() => child.kill("SIGKILL"), MAX_RUN_MS);
      const abort = (): void => {
        child.kill("SIGKILL");
      };
      options.signal?.addEventListener("abort", abort, { once: true });
      let buffer = "";
      let stderr = "";
      let result: string | null = null;
      let failure: string | null = null;
      let size = 0;
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        size += chunk.length;
        if (size > MAX_OUTPUT * 4) return;
        buffer += chunk;
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (!line) continue;
          try {
            const event = JSON.parse(line) as Record<string, unknown>;
            if (event.type === "assistant") {
              const content = (event.message as { content?: { type?: string; name?: string; input?: Record<string, unknown> }[] } | undefined)?.content ?? [];
              for (const block of content) {
                if (block.type === "tool_use") {
                  const detail = String(block.input?.query ?? block.input?.url ?? "").slice(0, 160);
                  options.onActivity?.(`${block.name === "WebSearch" ? "search" : "read"}: ${detail}`);
                }
              }
            } else if (event.type === "result") {
              if (event.is_error === true || event.subtype !== "success") failure = String(event.result ?? event.subtype ?? "error");
              else result = String(event.result ?? "");
            }
          } catch {
            // Not a JSON line.
          }
        }
      });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        if (stderr.length < 4000) stderr += chunk;
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
        if (options.signal?.aborted) return reject(new Error("Research was cancelled."));
        if (result !== null && result.trim()) return resolve(result.slice(0, MAX_OUTPUT));
        reject(new Error(failure ?? (stderr.trim().split("\n").at(-1) || `Claude Code exited with code ${code}.`)));
      });
      child.stdin.end(question);
    });
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}
