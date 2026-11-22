/** Closes the GitHub issues named by commits pushed to main. A subject ending "(#N)" names issue N.
 * Usage: node scripts/close-merged-issues.mjs <before-sha> <after-sha>
 * Needs git and gh on PATH and GITHUB_REPOSITORY (set by GitHub Actions). Node built-ins only.
 * Never reopens an issue. An error on one issue is reported and the rest still run. */
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const CLOSING_REF = /\(#(\d+)\)\s*$/;
const ZERO_SHA = /^0+$/;

/** Issue numbers named at the end of each subject, in first-seen order, without repeats. */
export function parseIssueNumbers(subjects) {
  const numbers = new Set();
  for (const subject of subjects) {
    const match = CLOSING_REF.exec(subject);
    if (match) numbers.add(Number(match[1]));
  }
  return [...numbers];
}

/** Real command runner. Tests inject their own and never reach this. */
export function systemRunner(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.error ? result.error.message : (result.stderr ?? ""),
  };
}

/** Commits in the pushed range as { sha, subject }, newest first. A new branch push (all-zero or
 * missing "before") covers only the pushed head. Throws if git cannot read the range. */
export function pushedCommits(run, before, after) {
  const range = before && !ZERO_SHA.test(before) ? [`${before}..${after}`] : ["-n", "1", after];
  const result = run("git", ["log", "--format=%h%x09%s", ...range]);
  if (result.status !== 0) throw new Error(`Could not read commits ${range.join(" ")}: ${result.stderr.trim()}`);
  return result.stdout
    .split("\n")
    .filter(line => line.length > 0)
    .map(line => {
      const tab = line.indexOf("\t");
      return { sha: line.slice(0, tab), subject: line.slice(tab + 1) };
    });
}

/** Closes each open issue named by the commits. Closed issues are skipped; nothing is reopened.
 * Returns one { number, outcome, error? } per issue, outcome "closed", "skipped" or "failed". */
export function closeMergedIssues({ run, repo, commits, report = () => {} }) {
  // Commits are newest first, so the first commit naming an issue is the one cited in its comment.
  const shaByIssue = new Map();
  for (const { sha, subject } of commits) {
    for (const number of parseIssueNumbers([subject])) {
      if (!shaByIssue.has(number)) shaByIssue.set(number, sha);
    }
  }

  const results = [];
  for (const number of parseIssueNumbers(commits.map(commit => commit.subject))) {
    try {
      const view = run("gh", ["issue", "view", String(number), "--repo", repo, "--json", "state"]);
      if (view.status !== 0) throw new Error(`gh issue view failed: ${view.stderr.trim()}`);
      const { state } = JSON.parse(view.stdout);
      if (state !== "OPEN") {
        report(`#${number}: already closed, skipped.`);
        results.push({ number, outcome: "skipped" });
        continue;
      }
      const sha = shaByIssue.get(number);
      const close = run("gh", ["issue", "close", String(number), "--repo", repo, "--comment", `Closed by ${sha} on main.`]);
      if (close.status !== 0) throw new Error(`gh issue close failed: ${close.stderr.trim()}`);
      report(`#${number}: closed by ${sha}.`);
      results.push({ number, outcome: "closed" });
    } catch (error) {
      report(`#${number}: error: ${error.message}`);
      results.push({ number, outcome: "failed", error: error.message });
    }
  }
  return results;
}

const usage = "Usage: node scripts/close-merged-issues.mjs <before-sha> <after-sha>\nNeeds gh and git on PATH and GITHUB_REPOSITORY (set by GitHub Actions).";

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [before = "", after] = process.argv.slice(2);
  const repo = process.env.GITHUB_REPOSITORY;
  if (!after || !repo) {
    console.error(usage);
    process.exitCode = 1;
  } else {
    try {
      const commits = pushedCommits(systemRunner, before, after);
      const results = closeMergedIssues({ run: systemRunner, repo, commits, report: line => console.log(line) });
      if (results.some(result => result.outcome === "failed")) process.exitCode = 1;
    } catch (error) {
      console.error(`[close-merged-issues] ${error.message}`);
      process.exitCode = 1;
    }
  }
}
