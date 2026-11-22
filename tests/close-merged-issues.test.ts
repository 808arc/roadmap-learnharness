/** Close-merged-issues tests: the parser is pure, and the main path gets a fake runner, so nothing calls the real gh or git. */
import { test } from "node:test";
import assert from "node:assert/strict";

type Result = { status: number; stdout: string; stderr: string };
type Run = (command: string, args: string[]) => Result;
interface CloseModule {
  parseIssueNumbers(subjects: string[]): number[];
  pushedCommits(run: Run, before: string, after: string): { sha: string; subject: string }[];
  closeMergedIssues(options: {
    run: Run;
    repo: string;
    commits: { sha: string; subject: string }[];
    report?: (line: string) => void;
  }): { number: number; outcome: string; error?: string }[];
}

const script: CloseModule = await import(new URL("../scripts/close-merged-issues.mjs", import.meta.url).href);
const ok = (stdout = ""): Result => ({ status: 0, stdout, stderr: "" });
const fail = (stderr: string): Result => ({ status: 1, stdout: "", stderr });

test("a subject ending in (#40) names issue 40", () => {
  assert.deepEqual(script.parseIssueNumbers(["Merge issue-40: fix parser (#40)"]), [40]);
});

test("(#40) followed by more text does not count", () => {
  assert.deepEqual(script.parseIssueNumbers(["Fix (#40) more text"]), []);
});

test("a subject with no number does not count", () => {
  assert.deepEqual(script.parseIssueNumbers(["Update docs", ""]), []);
});

test("a repeated number is returned once", () => {
  assert.deepEqual(script.parseIssueNumbers(["Merge issue-40: x (#40)", "Follow-up (#40)"]), [40]);
});

test("two different numbers both count, in order", () => {
  assert.deepEqual(script.parseIssueNumbers(["Second (#42)", "First (#7)"]), [42, 7]);
});

test("a number that is not at the end does not count", () => {
  assert.deepEqual(script.parseIssueNumbers(["See (#40) for context, then edit docs"]), []);
});

test("trailing whitespace after (#N) is allowed", () => {
  assert.deepEqual(script.parseIssueNumbers(["Done (#40)   ", "Also (#41)\t"]), [40, 41]);
});

/** A fake GitHub: `commits` is the pushed range, `issues` maps number to state, and `closeFails` numbers fail to close. */
function fakeWorld({ commits, issues, closeFails = [] }: {
  commits: { sha: string; subject: string }[];
  issues: Record<number, string>;
  closeFails?: number[];
}) {
  const calls: string[][] = [];
  const run: Run = (command, args) => {
    calls.push([command, ...args]);
    if (command === "git") {
      return ok(commits.map(c => `${c.sha}\t${c.subject}`).join("\n"));
    }
    if (command === "gh" && args[0] === "issue" && args[1] === "view") {
      const state = issues[Number(args[2])];
      return state === undefined ? fail("could not resolve to an issue") : ok(JSON.stringify({ state }));
    }
    if (command === "gh" && args[0] === "issue" && args[1] === "close") {
      const number = Number(args[2]);
      return closeFails.includes(number) ? fail("permission denied") : ok("");
    }
    return fail(`unexpected call: ${command} ${args.join(" ")}`);
  };
  return { run, calls };
}

test("main path closes only open issues, skips closed ones, and names the short sha", () => {
  const commits = [
    { sha: "abc1234", subject: "Merge issue-41: thing (#41)" },
    { sha: "def5678", subject: "Merge issue-40: other (#40)" },
    { sha: "0999999", subject: "Docs only" },
  ];
  const { run, calls } = fakeWorld({ commits, issues: { 40: "CLOSED", 41: "OPEN" } });
  const results = script.closeMergedIssues({ run, repo: "owner/repo", commits });

  assert.deepEqual(results, [
    { number: 41, outcome: "closed" },
    { number: 40, outcome: "skipped" },
  ]);
  const closes = calls.filter(c => c[0] === "gh" && c[2] === "close");
  assert.deepEqual(closes, [["gh", "issue", "close", "41", "--repo", "owner/repo", "--comment", "Closed by abc1234 on main."]]);
  assert.equal(calls.some(c => c.includes("reopen")), false, "never reopens an issue");
});

test("an error on one issue is reported and the rest still run", () => {
  const commits = [
    { sha: "aaa1111", subject: "Second (#2)" },
    { sha: "bbb2222", subject: "First (#1)" },
    { sha: "ccc3333", subject: "Missing (#9)" },
  ];
  const { run } = fakeWorld({ commits, issues: { 1: "OPEN", 2: "OPEN" }, closeFails: [2] });
  const reported: string[] = [];
  const results = script.closeMergedIssues({ run, repo: "owner/repo", commits, report: line => reported.push(line) });

  assert.equal(results.length, 3);
  assert.equal(results[0]?.outcome, "failed");
  assert.equal(results[1]?.outcome, "closed");
  assert.equal(results[2]?.outcome, "failed");
  assert.equal(reported.length, 3);
});

test("pushedCommits reads the range, or only the head for a new branch", () => {
  const seen: string[][] = [];
  const run: Run = (_command, args) => {
    seen.push(args);
    return ok("abc1234\tSubject (#3)\n");
  };
  assert.deepEqual(script.pushedCommits(run, "1111111111111111111111111111111111111111", "abc1234"), [{ sha: "abc1234", subject: "Subject (#3)" }]);
  script.pushedCommits(run, "0000000000000000000000000000000000000000", "abc1234");
  assert.deepEqual(seen[0]?.slice(-1), ["1111111111111111111111111111111111111111..abc1234"]);
  assert.deepEqual(seen[1]?.slice(-3), ["-n", "1", "abc1234"]);
});
