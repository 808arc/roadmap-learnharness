/** Issue #55: opening a chat on a node starts it; closing never resets it. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChatRecord } from "learnharness-plugin-api";
import { openLearningPathStore } from "../src/store.ts";
import { makePath, AT } from "./fixtures.ts";
import { createHost } from "./host.ts";
import type { PathNode } from "../src/domain.ts";

const PATH_ID = "path-linear-algebra";
const NODE_ID = "n-skill";

function chat(id: string): ChatRecord {
  return { id, title: id, createdAt: AT, updatedAt: AT, messages: [], kind: "teach" };
}

function withNode(progression: PathNode["progression"]) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "learning-path-status-"));
  const base = makePath();
  openLearningPathStore(directory).savePath({
    ...base,
    modules: base.modules.map((module) => ({
      ...module,
      nodes: module.nodes.map((node) => (node.id === NODE_ID ? { ...node, progression } : node)),
    })),
  });
  const host = createHost({ dataDirectory: directory, chats: [chat("c1")] });
  const stored = () => {
    const found = openLearningPathStore(directory).path(PATH_ID);
    assert.ok(found);
    return found.modules.flatMap((m) => m.nodes).find((n) => n.id === NODE_ID)!.progression;
  };
  const cleanup = () => {
    host.close();
    fs.rmSync(directory, { recursive: true, force: true });
  };
  return { host, stored, cleanup };
}

const link = { pathId: PATH_ID, nodeId: NODE_ID, chatId: "c1", kind: "teaching" };

test("opening a chat on an unstarted node sets it in progress; closing does not reset it", async () => {
  const { host, stored, cleanup } = withNode("unstarted");
  try {
    assert.equal(stored(), "unstarted");
    await host.call("sessions.link", link);
    assert.equal(stored(), "in_progress");
    assert.equal(host.removeChat("c1"), true);
    await host.call("sessions.unlink", { pathId: PATH_ID, nodeId: NODE_ID, chatId: "c1" });
    assert.equal(stored(), "in_progress");
  } finally {
    cleanup();
  }
});

for (const state of ["consolidated", "skipped", "in_progress"] as const) {
  test(`opening a chat keeps a ${state} node ${state}`, async () => {
    const { host, stored, cleanup } = withNode(state);
    try {
      await host.call("sessions.link", link);
      assert.equal(stored(), state);
    } finally {
      cleanup();
    }
  });
}
