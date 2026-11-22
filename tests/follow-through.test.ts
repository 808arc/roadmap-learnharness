/** Follow-through metrics: study days, starts, consolidations and stalled nodes. Synthetic sessions only. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { STALLED_AFTER_DAYS, followThrough } from "../src/follow-through.ts";
import type { NativeSessionActivity } from "../src/follow-through.ts";
import type { ChildSessionLink, LearningPath, PathNode } from "../src/domain.ts";
import { makeNode, makePath } from "./fixtures.ts";

/** Local wall-clock time as an ISO string, so the tests hold in any time zone. */
const local = (year: number, month: number, day: number, hour = 12, minute = 0): string =>
  new Date(year, month - 1, day, hour, minute).toISOString();

const link = (chatId: string, createdAt: string, kind: ChildSessionLink["kind"] = "teaching"): ChildSessionLink => ({
  chatId,
  kind,
  createdAt,
  label: chatId,
});

function roadmapWith(nodes: PathNode[]): LearningPath {
  return {
    ...makePath(),
    modules: [{ id: "module-a", title: "Module A", nodes }],
  };
}

const NOW = local(2026, 3, 20, 9);

test("counts one study day per local day with at least one action, sorted", () => {
  const path = roadmapWith([
    makeNode("n1", "concept", {
      progression: "in_progress",
      childSessions: [link("chat-a", local(2026, 3, 10))],
    }),
  ]);
  const sessions: NativeSessionActivity[] = [
    {
      id: "chat-a",
      createdAt: local(2026, 3, 10),
      updatedAt: local(2026, 3, 12),
      actionTimes: [local(2026, 3, 12, 8), local(2026, 3, 12, 8, 30), local(2026, 3, 10, 9)],
    },
  ];
  const report = followThrough(path, sessions, NOW);
  assert.deepEqual(report.studyDays, ["2026-03-10", "2026-03-12"]);
});

test("a session crossing midnight counts on both local days", () => {
  const path = roadmapWith([
    makeNode("n1", "concept", {
      progression: "in_progress",
      childSessions: [link("chat-late", local(2026, 3, 14, 23, 50))],
    }),
  ]);
  // Exact action times: one at 23:50 on the 14th, one at 00:20 on the 15th.
  const exact = followThrough(
    path,
    [
      {
        id: "chat-late",
        createdAt: local(2026, 3, 14, 23, 50),
        updatedAt: local(2026, 3, 15, 0, 20),
        actionTimes: [local(2026, 3, 14, 23, 50), local(2026, 3, 15, 0, 20)],
      },
    ],
    NOW,
  );
  assert.deepEqual(exact.studyDays, ["2026-03-14", "2026-03-15"]);

  // Without action times the session's createdAt and updatedAt give the same two days.
  const endpoints = followThrough(
    path,
    [{ id: "chat-late", createdAt: local(2026, 3, 14, 23, 50), updatedAt: local(2026, 3, 15, 0, 20) }],
    NOW,
  );
  assert.deepEqual(endpoints.studyDays, ["2026-03-14", "2026-03-15"]);
});

test("only sessions linked to the roadmap count toward its study days", () => {
  const path = roadmapWith([
    makeNode("n1", "concept", {
      progression: "in_progress",
      childSessions: [link("chat-mine", local(2026, 3, 5))],
    }),
  ]);
  const report = followThrough(
    path,
    [
      { id: "chat-mine", createdAt: local(2026, 3, 5), updatedAt: local(2026, 3, 5) },
      { id: "chat-other", createdAt: local(2026, 3, 7), updatedAt: local(2026, 3, 8) },
    ],
    NOW,
  );
  assert.deepEqual(report.studyDays, ["2026-03-05"]);
});

test("a roadmap with no sessions has no study days, starts, consolidations or stalls", () => {
  const path = roadmapWith([
    makeNode("n1", "concept"),
    makeNode("n2", "skill", { progression: "in_progress" }),
  ]);
  const report = followThrough(path, [], NOW);
  assert.equal(report.roadmapId, path.id);
  assert.deepEqual(report.studyDays, []);
  assert.deepEqual(report.startedByDay, []);
  assert.deepEqual(report.consolidatedByDay, []);
  assert.deepEqual(report.stalledNodes, []);
});

test("counts starts on the day of the first child session link, and consolidations on the last activity day", () => {
  const path = roadmapWith([
    makeNode("n1", "concept", {
      progression: "consolidated",
      childSessions: [link("chat-1", local(2026, 3, 2)), link("chat-2", local(2026, 3, 6))],
    }),
    makeNode("n2", "skill", {
      progression: "in_progress",
      childSessions: [link("chat-3", local(2026, 3, 2))],
    }),
    makeNode("n3", "checkpoint", { progression: "unstarted" }),
  ]);
  const sessions: NativeSessionActivity[] = [
    { id: "chat-1", createdAt: local(2026, 3, 2), updatedAt: local(2026, 3, 2) },
    { id: "chat-2", createdAt: local(2026, 3, 6), updatedAt: local(2026, 3, 6) },
    { id: "chat-3", createdAt: local(2026, 3, 2), updatedAt: local(2026, 3, 19) },
  ];
  const report = followThrough(path, sessions, NOW);
  assert.deepEqual(report.startedByDay, [{ day: "2026-03-02", count: 2 }]);
  assert.deepEqual(report.consolidatedByDay, [{ day: "2026-03-06", count: 1 }]);
});

test("an in-progress node with no linked session for STALLED_AFTER_DAYS days is stalled", () => {
  assert.equal(STALLED_AFTER_DAYS, 14);
  const lastActive = local(2026, 3, 6);
  const path = roadmapWith([
    makeNode("n-stale", "concept", {
      title: "Stale node",
      progression: "in_progress",
      childSessions: [link("chat-stale", lastActive)],
    }),
  ]);
  const sessions: NativeSessionActivity[] = [
    { id: "chat-stale", createdAt: lastActive, updatedAt: lastActive },
  ];
  // 6 March to 20 March is exactly 14 local days.
  const report = followThrough(path, sessions, NOW);
  assert.deepEqual(report.stalledNodes, [
    { nodeId: "n-stale", title: "Stale node", lastLinkedDay: "2026-03-06", daysSince: 14 },
  ]);
});

test("a node active 13 days ago is not stalled, and any recent activity resets the clock", () => {
  const path = roadmapWith([
    makeNode("n-recent", "concept", {
      progression: "in_progress",
      childSessions: [link("chat-recent", local(2026, 3, 7))],
    }),
  ]);
  const sessions: NativeSessionActivity[] = [
    { id: "chat-recent", createdAt: local(2026, 3, 7), updatedAt: local(2026, 3, 7) },
  ];
  assert.deepEqual(followThrough(path, sessions, NOW).stalledNodes, []);
});

test("consolidated and unstarted nodes are never stalled", () => {
  const old = local(2026, 1, 1);
  const path = roadmapWith([
    makeNode("n-done", "concept", { progression: "consolidated", childSessions: [link("chat-done", old)] }),
    makeNode("n-fresh", "skill", { progression: "unstarted" }),
  ]);
  const sessions: NativeSessionActivity[] = [{ id: "chat-done", createdAt: old, updatedAt: old }];
  assert.deepEqual(followThrough(path, sessions, NOW).stalledNodes, []);
});

test("optional in-progress nodes are excluded from stalled, but still count toward starts", () => {
  const old = local(2026, 2, 1);
  const path = roadmapWith([
    makeNode("n-optional", "concept", {
      progression: "in_progress",
      optional: true,
      childSessions: [link("chat-opt", old)],
    }),
  ]);
  const sessions: NativeSessionActivity[] = [{ id: "chat-opt", createdAt: old, updatedAt: old }];
  const report = followThrough(path, sessions, NOW);
  assert.deepEqual(report.stalledNodes, []);
  assert.deepEqual(report.startedByDay, [{ day: "2026-02-01", count: 1 }]);
});

test("a link whose native session is gone still dates the node by the link", () => {
  const linkedAt = local(2026, 3, 1);
  const path = roadmapWith([
    makeNode("n-gone", "concept", {
      title: "Gone chat",
      progression: "in_progress",
      childSessions: [link("chat-deleted", linkedAt)],
    }),
  ]);
  const report = followThrough(path, [], NOW);
  assert.deepEqual(report.studyDays, []);
  assert.deepEqual(report.startedByDay, [{ day: "2026-03-01", count: 1 }]);
  assert.deepEqual(report.stalledNodes, [
    { nodeId: "n-gone", title: "Gone chat", lastLinkedDay: "2026-03-01", daysSince: 19 },
  ]);
});

test("rejects an invalid now instead of reading the clock", () => {
  assert.throws(() => followThrough(roadmapWith([]), [], "not-a-date"), /not a valid timestamp/);
});
