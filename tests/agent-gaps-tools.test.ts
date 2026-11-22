/** Read-only roadmap gap tool for linked teaching sessions (issue #11).
 *
 * Runs the real backend activation: registration (name, description, instruction scope), a call
 * on a linked chat, a broken store returning isError, and a call that leaves the store files as
 * they were. No model request is made.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { PluginBackendContext, PluginInstructions, PluginTools } from "learnharness-plugin-api";
import { GAPS_INSTRUCTIONS, GAPS_TOOL_NAME, registerAgentGaps } from "../src/agent-gaps-tools.ts";
import { openLearningPathStore } from "../src/store.ts";
import { makePath, AT } from "./fixtures.ts";
import { createHost } from "./host.ts";
import type { TestHost } from "./host.ts";
import type { ChatRecord } from "learnharness-plugin-api";

function chat(id: string, kind: "teach" | "practice" = "teach"): ChatRecord {
  return { id, title: id, createdAt: AT, updatedAt: AT, messages: [], kind };
}

function temporaryDirectory(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "learning-path-gaps-"));
}

function hostWithLinkedChat(): { host: TestHost; directory: string } {
  const directory = temporaryDirectory();
  openLearningPathStore(directory).savePath(makePath());
  const host = createHost({ dataDirectory: directory, chats: [chat("chat-1"), chat("chat-unlinked")] });
  return { host, directory };
}

function close(host: TestHost, directory: string): void {
  host.close();
  fs.rmSync(directory, { recursive: true, force: true });
}

/** Every tool the host would offer this turn. nativeTools() reads only the first matching contribution. */
function turnTools(host: TestHost, chatId: string, agent: "teacher" | "prober"): AgentTool[] {
  return host.toolContributions
    .filter((contribution) => (contribution.agents as readonly string[]).includes(agent))
    .flatMap((contribution) => contribution.create({ chatId, agent }));
}

function gapsToolFor(host: TestHost, chatId: string): AgentTool {
  const tool = turnTools(host, chatId, "teacher").find((candidate) => candidate.name === GAPS_TOOL_NAME);
  assert.ok(tool, `expected ${GAPS_TOOL_NAME} for ${chatId}`);
  return tool;
}

async function callGaps(tool: AgentTool): Promise<{ isError: boolean; details: Record<string, unknown>; text: string }> {
  const result = await tool.execute("call-1", {} as never, new AbortController().signal);
  const content = result.content as { type: string; text?: string }[];
  return {
    isError: result.isError === true,
    details: (result.details ?? {}) as Record<string, unknown>,
    text: content.find((part) => part.type === "text")?.text ?? "",
  };
}

/** Every file under a directory with its bytes, for proving a read writes nothing. */
function snapshot(directory: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of fs.readdirSync(directory, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const full = path.join(entry.parentPath, entry.name);
    files[path.relative(directory, full)] = fs.readFileSync(full, "utf8");
  }
  return files;
}

test("the gap tool is registered for linked teacher chats only, with a description and the teaching instruction", async () => {
  const { host, directory } = hostWithLinkedChat();
  try {
    // The fixture links chat-1 to n-concept as a teaching chat; chat-unlinked has no link.
    const instruction = host.instructions.find((entry) => entry.text === GAPS_INSTRUCTIONS);
    assert.ok(instruction, "the gap instruction is registered");
    assert.deepEqual(instruction.agents, ["teacher"]);
    assert.match(instruction.text, /roadmap_gaps/);

    const tool = gapsToolFor(host, "chat-1");
    assert.equal(tool.name, "roadmap_gaps");
    assert.match(tool.description, /prerequisite gaps/);
    assert.match(tool.description, /Read-only/);

    assert.equal(
      turnTools(host, "chat-unlinked", "teacher").some((candidate) => candidate.name === GAPS_TOOL_NAME),
      false,
      "an unlinked chat does not receive the gap tool",
    );
    assert.equal(
      turnTools(host, "chat-1", "prober").some((candidate) => candidate.name === GAPS_TOOL_NAME),
      false,
      "only teacher turns receive the gap tool",
    );
  } finally {
    close(host, directory);
  }
});

test("a call on a linked chat returns the gaps of its synthetic path, most severe first", async () => {
  const { host, directory } = hostWithLinkedChat();
  try {
    const result = await callGaps(gapsToolFor(host, "chat-1"));

    assert.equal(result.isError, false);
    assert.deepEqual(result.details, {
      isError: false,
      roadmap: "path-linear-algebra",
      gaps: [
        { nodeId: "n-concept", kind: "missing", severity: 4, blockers: [] },
        { nodeId: "n-skill", kind: "missing", severity: 3, blockers: [] },
        { nodeId: "n-contrast", kind: "missing", severity: 2, blockers: [] },
        { nodeId: "n-checkpoint", kind: "missing", severity: 1, blockers: [] },
        { nodeId: "n-bridge", kind: "missing", severity: 0, blockers: [] },
      ],
    });
    assert.equal(JSON.parse(result.text).roadmap, "path-linear-algebra");
  } finally {
    close(host, directory);
  }
});

test("a call that leaves the store files unchanged writes nothing", async () => {
  const { host, directory } = hostWithLinkedChat();
  try {
    const before = snapshot(directory);
    const tool = gapsToolFor(host, "chat-1");

    await callGaps(tool);
    await callGaps(tool);

    assert.deepEqual(snapshot(directory), before, "the data directory is byte-for-byte unchanged");
  } finally {
    close(host, directory);
  }
});

test("a failed read returns isError and no gap list", async () => {
  // Fake host context: capture the factory and drive the tool with a source that fails.
  let factory: PluginTools | undefined;
  const ctx = {
    registerInstructions: (_contribution: PluginInstructions) => () => {},
    registerTools: (contribution: PluginTools) => {
      factory = contribution;
      return () => {};
    },
  } as unknown as PluginBackendContext;
  const broken = {
    linked: () => {
      throw new Error("store unreadable");
    },
    input: () => {
      throw new Error("store unreadable");
    },
  };
  const unregister = registerAgentGaps(ctx, broken);
  assert.ok(factory);
  const [tool] = factory.create({ chatId: "chat-1", agent: "teacher" });
  assert.ok(tool, "an unreadable store keeps the tool so the failure is reported");

  const result = await callGaps(tool);
  assert.equal(result.isError, true);
  assert.equal(result.details.isError, true);
  assert.equal(result.details.error, "store unreadable");
  assert.equal("gaps" in result.details, false);
  unregister();
});

test("a malformed path from the store returns isError rather than a partial list", async () => {
  let factory: PluginTools | undefined;
  const ctx = {
    registerInstructions: () => () => {},
    registerTools: (contribution: PluginTools) => {
      factory = contribution;
      return () => {};
    },
  } as unknown as PluginBackendContext;
  registerAgentGaps(ctx, {
    linked: () => true,
    input: () => ({ path: { id: "broken", modules: "none" }, mastery: [] }),
  });
  assert.ok(factory);
  const [tool] = factory.create({ chatId: "chat-1", agent: "teacher" });
  assert.ok(tool);

  const result = await callGaps(tool);
  assert.equal(result.isError, true);
  assert.equal("gaps" in result.details, false);
});
