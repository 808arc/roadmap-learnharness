/** Study-day work: which roadmaps and nodes were worked on each day. Synthetic sessions only. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { studyDayWork } from "../src/study-day-work.ts";
import { followThrough } from "../src/follow-through.ts";
import type { NativeSessionActivity } from "../src/follow-through.ts";
import type { ChildSessionLink, LearningPath, PathNode } from "../src/domain.ts";
import { makeNode, makePath } from "./fixtures.ts";

/** Local wall-clock time as an ISO string, so the tests hold in any time zone. */
const local = (year: number, month: number, day: number, hour = 12, minute = 0): string =>
  new Date(year, month - 1, day, hour, minute).toISOString();

const link = (chatId: string, createdAt: string): ChildSessionLink => ({
  chatId,
  kind: "teaching",
  createdAt,
  label: chatId,
});

function roadmap(id: string, nodes: PathNode[]): LearningPath {
  return { ...makePath(), id, modules: [{ id: "module-a", title: "Module A", nodes }] };
}

test("a day with two roadmaps lists both, each with its own node", () => {
  const first = roadmap("path-algebra", [
    makeNode("n-alg", "concept", { title: "Algebra", childSessions: [link("chat-alg", local(2026, 3, 10))] }),
  ]);
  const second = roadmap("path-systems", [
    makeNode("n-sys", "skill", { title: "Systems", childSessions: [link("chat-sys", local(2026, 3, 10))] }),
  ]);
  const sessions: NativeSessionActivity[] = [
    { id: "chat-alg", createdAt: local(2026, 3, 10), updatedAt: local(2026, 3, 10) },
    { id: "chat-sys", createdAt: local(2026, 3, 10, 15), updatedAt: local(2026, 3, 10, 15) },
  ];
  assert.deepEqual(studyDayWork([second, first], sessions), [
    {
      day: "2026-03-10",
      roadmaps: [
        { roadmapId: "path-algebra", nodes: [{ nodeId: "n-alg", title: "Algebra" }] },
        { roadmapId: "path-systems", nodes: [{ nodeId: "n-sys", title: "Systems" }] },
      ],
    },
  ]);
});

test("a session crossing midnight is listed on both local days", () => {
  const path = roadmap("path-late", [
    makeNode("n-late", "concept", {
      title: "Late night",
      childSessions: [link("chat-late", local(2026, 3, 14, 23, 50))],
    }),
  ]);
  const sessions: NativeSessionActivity[] = [
    {
      id: "chat-late",
      createdAt: local(2026, 3, 14, 23, 50),
      updatedAt: local(2026, 3, 15, 0, 20),
      actionTimes: [local(2026, 3, 14, 23, 50), local(2026, 3, 15, 0, 20)],
    },
  ];
  const work = studyDayWork([path], sessions);
  const node = [{ nodeId: "n-late", title: "Late night" }];
  assert.deepEqual(work, [
    { day: "2026-03-14", roadmaps: [{ roadmapId: "path-late", nodes: node }] },
    { day: "2026-03-15", roadmaps: [{ roadmapId: "path-late", nodes: node }] },
  ]);
});

test("the days match the follow-through study days for the same roadmap", () => {
  const path = roadmap("path-match", [
    makeNode("n1", "concept", {
      progression: "in_progress",
      childSessions: [link("chat-a", local(2026, 3, 2)), link("chat-b", local(2026, 3, 9))],
    }),
  ]);
  const sessions: NativeSessionActivity[] = [
    {
      id: "chat-a",
      createdAt: local(2026, 3, 2),
      updatedAt: local(2026, 3, 4),
      actionTimes: [local(2026, 3, 2, 8), local(2026, 3, 4, 21)],
    },
    { id: "chat-b", createdAt: local(2026, 3, 9), updatedAt: local(2026, 3, 9) },
  ];
  const workDays = studyDayWork([path], sessions).map((entry) => entry.day);
  const studyDays = followThrough(path, sessions, local(2026, 3, 20)).studyDays;
  assert.deepEqual(workDays, [...studyDays]);
  assert.deepEqual(workDays, ["2026-03-02", "2026-03-04", "2026-03-09"]);
});

test("a node with no linked session is not listed, and a link's createdAt alone is not a study day", () => {
  const path = roadmap("path-quiet", [
    makeNode("n-untouched", "concept", { title: "Untouched" }),
    makeNode("n-linked", "skill", {
      title: "Linked",
      // The link was made on the 5th, but the session only has actions on the 6th.
      childSessions: [link("chat-later", local(2026, 3, 5))],
    }),
  ]);
  const sessions: NativeSessionActivity[] = [
    {
      id: "chat-later",
      createdAt: local(2026, 3, 5),
      updatedAt: local(2026, 3, 6),
      actionTimes: [local(2026, 3, 6, 10)],
    },
  ];
  assert.deepEqual(studyDayWork([path], sessions), [
    { day: "2026-03-06", roadmaps: [{ roadmapId: "path-quiet", nodes: [{ nodeId: "n-linked", title: "Linked" }] }] },
  ]);
});

test("an optional node is listed only on days it has a session", () => {
  const path = roadmap("path-opt", [
    makeNode("n-optional", "concept", {
      title: "Optional",
      optional: true,
      childSessions: [link("chat-opt", local(2026, 3, 11))],
    }),
    makeNode("n-optional-idle", "concept", { title: "Optional idle", optional: true }),
  ]);
  const sessions: NativeSessionActivity[] = [
    { id: "chat-opt", createdAt: local(2026, 3, 11), updatedAt: local(2026, 3, 11) },
  ];
  assert.deepEqual(studyDayWork([path], sessions), [
    {
      day: "2026-03-11",
      roadmaps: [{ roadmapId: "path-opt", nodes: [{ nodeId: "n-optional", title: "Optional" }] }],
    },
  ]);
});

test("a link to a session that no longer exists lists nothing", () => {
  const path = roadmap("path-gone", [
    makeNode("n-gone", "concept", { childSessions: [link("chat-deleted", local(2026, 3, 1))] }),
  ]);
  assert.deepEqual(studyDayWork([path], []), []);
});

test("a session linked to a node in two roadmaps is listed under both", () => {
  const shared = { id: "chat-shared", createdAt: local(2026, 3, 4), updatedAt: local(2026, 3, 4) };
  const first = roadmap("path-one", [makeNode("n-a", "concept", { title: "A", childSessions: [link(shared.id, shared.createdAt)] })]);
  const second = roadmap("path-two", [makeNode("n-b", "concept", { title: "B", childSessions: [link(shared.id, shared.createdAt)] })]);
  const [only] = studyDayWork([first, second], [shared]);
  assert.deepEqual(only?.roadmaps.map((r) => r.roadmapId), ["path-one", "path-two"]);
});
