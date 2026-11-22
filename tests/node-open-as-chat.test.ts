/** Every node can be opened as a chat: "Open" opens the latest linked chat, or starts a Lesson when there is none.
 *
 * Covers plain, optional and alternative nodes. The native host is injected, so no chat is created in storage.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { NativeSessionHost } from "../src/native-session-host.ts";
import type { LearningPath } from "../src/domain.ts";
import { clearPathHubTarget } from "../src/session-navigation.ts";
import { latestOpenableChat } from "../src/view/node-inspector.ts";
import { mountPathHub } from "../src/view/path-hub.ts";
import { AT, makeNode, makePath } from "./fixtures.ts";
import { selectNode } from "./roadmap-dom.ts";
import { createViewFixture } from "./view-host.ts";
import type { ViewFixture } from "./view-host.ts";

function fakeHost(fixture: ViewFixture): NativeSessionHost & { created: string[] } {
  const created: string[] = [];
  return {
    created,
    async create(input) {
      created.push(input.kind);
      // Each new chat gets its own id: a node cannot link the same chat twice.
      const chatId = `chat-new-${created.length}`;
      fixture.nativeChats.set(chatId, {
        id: chatId,
        title: input.title,
        kind: input.kind === "practice" ? "practice" : "teach",
      });
      return { chatId };
    },
    stageOpeningPrompt() {
      return true;
    },
    clearOpeningPrompt() {},
  };
}

async function mounted(fixture: ViewFixture, host: NativeSessionHost): Promise<void> {
  mountPathHub(fixture.context, fixture.root, fixture.context.signal, { sessionHost: host });
  await fixture.flush();
  await fixture.flush();
}

function openButton(fixture: ViewFixture): HTMLButtonElement {
  const foot = fixture.root.querySelector<HTMLElement>(".rm-insp-foot");
  assert.ok(foot, "the node panel has a footer");
  const button = [...foot.querySelectorAll<HTMLButtonElement>("button")].find((entry) => entry.textContent?.trim() === "Open");
  assert.ok(button, "the footer offers Open");
  return button;
}

test("Open on a node with no chats starts a Lesson session", async () => {
  const path = makePath();
  const fixture = createViewFixture({ paths: [path] });
  try {
    const host = fakeHost(fixture);
    await mounted(fixture, host);
    await selectNode(fixture, "n-contrast");

    openButton(fixture).click();
    await fixture.flush();
    await fixture.flush();

    assert.deepEqual(host.created, ["teaching"]);
    assert.deepEqual(fixture.openedSessions, ["chat-new-1"]);
  } finally {
    clearPathHubTarget();
    fixture.restore();
  }
});

test("Open on a node with a linked chat opens it without creating a session", async () => {
  const path = makePath();
  const fixture = createViewFixture({ paths: [path] });
  try {
    const host = fakeHost(fixture);
    await mounted(fixture, host);
    await selectNode(fixture, "n-concept");

    openButton(fixture).click();
    await fixture.flush();

    assert.deepEqual(host.created, []);
    assert.deepEqual(fixture.openedSessions, ["chat-1"]);
  } finally {
    clearPathHubTarget();
    fixture.restore();
  }
});

test("Open picks the most recent linked chat, skipping one that was deleted", async () => {
  const base = makePath();
  const path: LearningPath = {
    ...base,
    modules: base.modules.map((module) => ({
      ...module,
      nodes: module.nodes.map((node) =>
        node.id === "n-concept"
          ? {
              ...node,
              childSessions: [
                { chatId: "chat-1", kind: "teaching", createdAt: "2026-01-10T00:00:00.000Z", label: "Old" },
                { chatId: "chat-2", kind: "practice", createdAt: "2026-02-10T00:00:00.000Z", label: "Newer" },
                { chatId: "chat-3", kind: "practice", createdAt: "2026-03-10T00:00:00.000Z", label: "Newest, deleted" },
              ],
            }
          : node,
      ),
    })),
  };
  const fixture = createViewFixture({
    paths: [path],
    nativeChats: [
      { id: "chat-1", title: "Old", kind: "teach" },
      { id: "chat-2", title: "Newer", kind: "practice" },
    ],
  });
  try {
    // The view fixture treats every linked chat as live unless it is removed here.
    fixture.nativeChats.delete("chat-3");
    const host = fakeHost(fixture);
    await mounted(fixture, host);
    await selectNode(fixture, "n-concept");

    openButton(fixture).click();
    await fixture.flush();

    assert.deepEqual(host.created, [], "an existing chat is opened, not replaced");
    assert.deepEqual(fixture.openedSessions, ["chat-2"]);
  } finally {
    clearPathHubTarget();
    fixture.restore();
  }
});

test("optional and alternative nodes can be opened too", async () => {
  const base = makePath();
  const path: LearningPath = {
    ...base,
    modules: [
      base.modules[0]!,
      {
        ...base.modules[1]!,
        nodes: [
          makeNode("n-optional", "contrast", { optional: true }),
          makeNode("n-alt", "bridge", { alternativeGroup: "gcc-or-clang" }),
        ],
      },
    ],
  };
  const fixture = createViewFixture({ paths: [path] });
  try {
    const host = fakeHost(fixture);
    await mounted(fixture, host);

    await selectNode(fixture, "n-optional");
    openButton(fixture).click();
    await fixture.flush();
    await fixture.flush();
    assert.deepEqual(host.created, ["teaching"]);
    assert.deepEqual(fixture.openedSessions, ["chat-new-1"]);

    await selectNode(fixture, "n-alt");
    openButton(fixture).click();
    await fixture.flush();
    await fixture.flush();
    assert.deepEqual(host.created, ["teaching", "teaching"]);
    assert.deepEqual(fixture.openedSessions, ["chat-new-1", "chat-new-2"]);
  } finally {
    clearPathHubTarget();
    fixture.restore();
  }
});

test("latestOpenableChat ignores missing chats and breaks ties toward the later entry", () => {
  const node = makeNode("n", "concept", {
    childSessions: [
      { chatId: "a", kind: "teaching", createdAt: AT, label: "a" },
      { chatId: "b", kind: "teaching", createdAt: AT, label: "b" },
      { chatId: "c", kind: "practice", createdAt: "2020-01-01T00:00:00.000Z", label: "c" },
    ],
  });
  assert.equal(latestOpenableChat(node)?.chatId, "b");
  const missingB = new Map([["b", { chatId: "b", exists: false }]]) as never;
  assert.equal(latestOpenableChat(node, missingB)?.chatId, "a");
  assert.equal(latestOpenableChat(makeNode("m", "concept")), null);
});
