/** Architect pane build strip: six steps render, statuses follow tool events, and English keys exist. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createArchitectPane } from "../src/view/architect-pane.ts";
import { tables } from "../src/i18n.ts";
import { makeConversation, createViewFixture } from "./view-host.ts";
import type { PluginAgentSnapshot } from "learnharness-plugin-api";

/** A snapshot with loose message literals: the pane reads only role, content and tool fields. */
const snapshot = (overrides: Record<string, unknown>) =>
  makeConversation("c1", overrides as unknown as Partial<PluginAgentSnapshot>);

const call = (id: string, name: string) => ({ type: "toolCall", id, name, arguments: {} });
const assistant = (...parts: unknown[]) => ({ role: "assistant", content: parts });
const result = (toolCallId: string, toolName: string, text = "{}") => ({
  role: "toolResult",
  toolCallId,
  toolName,
  content: [{ type: "text", text }],
  isError: false,
});

const STEP_KEYS = ["readGraph", "findTopics", "readTopics", "research", "draft", "save"] as const;

test("the build strip shows six steps and follows tool events", () => {
  const fixture = createViewFixture({});
  const container = fixture.root.ownerDocument.createElement("div");
  fixture.root.append(container);
  const pane = createArchitectPane(fixture.context, container, fixture.controller.signal);
  try {
    const strip = container.querySelector<HTMLElement>(".lp-architect-progress")!;
    assert.ok(strip, "the pane renders the strip");
    assert.equal(strip.hidden, true, "the strip stays hidden while idle");

    const steps = () => [...container.querySelectorAll<HTMLElement>(".lp-progress-step")];
    const stateOf = () => steps().map((step) => `${step.dataset.step}:${step.dataset.state}`);
    const labels = () => steps().map((step) => step.querySelector(".lp-progress-label")?.textContent);
    const user = { role: "user", content: "Build a backend roadmap" };

    // Busy with no tool yet: all six steps render, Read graph runs.
    pane.setConversation(snapshot({ status: "running", messages: [user] }));
    assert.equal(strip.hidden, false);
    assert.equal(steps().length, 6);
    assert.deepEqual(labels(), ["Read graph", "Find topics", "Read topics", "Research", "Draft", "Save"]);
    assert.deepEqual(stateOf(), [
      "readGraph:running", "findTopics:pending", "readTopics:pending",
      "research:pending", "draft:pending", "save:pending",
    ]);
    assert.equal(steps()[0]!.getAttribute("aria-current"), "step");

    // The topic listing is in flight, then done; the count appears once reads start.
    pane.setConversation(snapshot({
      status: "running",
      messages: [user, assistant(call("l", "list_roadmap_topics"))],
    }));
    assert.equal(steps()[1]!.dataset.state, "running");
    assert.equal(steps()[0]!.dataset.state, "done");

    pane.setConversation(snapshot({
      status: "running",
      messages: [
        user,
        assistant(call("l", "list_roadmap_topics")),
        result("l", "list_roadmap_topics", JSON.stringify({ topics: ["a", "b", "c", "d", "e", "f", "g", "h"] })),
      ],
      partial: assistant(call("r1", "read_roadmap_topic")),
    }));
    assert.equal(steps()[1]!.dataset.state, "done");
    assert.equal(steps()[2]!.dataset.state, "running");
    assert.equal(steps()[2]!.querySelector(".lp-progress-count")?.textContent, "0/8");

    pane.setConversation(snapshot({
      status: "running",
      messages: [
        user,
        assistant(call("l", "list_roadmap_topics")),
        result("l", "list_roadmap_topics", JSON.stringify({ topics: ["a", "b", "c", "d", "e", "f", "g", "h"] })),
        assistant(call("r1", "read_roadmap_topic")),
        result("r1", "read_roadmap_topic"),
        assistant(call("r2", "read_roadmap_topic")),
        result("r2", "read_roadmap_topic"),
      ],
      partial: assistant(call("w", "web_search")),
    }));
    assert.equal(steps()[2]!.dataset.state, "done");
    assert.equal(steps()[2]!.querySelector(".lp-progress-count")?.textContent, "2/8");
    assert.equal(steps()[3]!.dataset.state, "running");

    // Saved: the save step is done, and the strip hides once the Architect is idle.
    pane.setConversation(snapshot({
      status: "idle",
      messages: [
        user,
        assistant(call("s", "save_learning_path")),
        result("s", "save_learning_path"),
      ],
    }));
    assert.equal(strip.hidden, true);

    pane.setConversation(snapshot({
      status: "running",
      messages: [user, assistant(call("s", "save_learning_path")), result("s", "save_learning_path")],
    }));
    assert.equal(steps()[5]!.dataset.state, "done");
    assert.equal(steps().some((step) => step.dataset.state === "running"), false);
  } finally {
    pane.dispose();
    fixture.restore();
  }
});

test("every build strip label exists in English", () => {
  const keys = [...STEP_KEYS.map((step) => `archProgress.${step}`), "archProgress.label", "archProgress.count"];
  for (const key of keys) {
    assert.ok(tables.en[key as keyof typeof tables.en], `EN ${key}`);
  }
});
