/** Architect build strip: tool-event to step mapping and step states. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ARCHITECT_STEPS, architectSteps, stepForTool } from "../src/architect-progress.ts";
import type { ArchitectStepState } from "../src/architect-progress.ts";

const call = (id: string, name: string) => ({ type: "toolCall", id, name, arguments: {} });
const assistant = (...parts: unknown[]) => ({ role: "assistant", content: parts });
const result = (toolCallId: string, toolName: string, text = "{}", isError = false) => ({
  role: "toolResult",
  toolCallId,
  toolName,
  content: [{ type: "text", text }],
  isError,
});
const user = { role: "user", content: "Build a backend roadmap" };

function states(steps: ReturnType<typeof architectSteps>): Record<string, ArchitectStepState> {
  return Object.fromEntries(steps.map((view) => [view.step, view.state]));
}

test("every Architect tool event maps to one of the six strip steps", () => {
  assert.deepEqual(ARCHITECT_STEPS, ["readGraph", "findTopics", "readTopics", "research", "draft", "save"]);
  assert.equal(stepForTool("read_learner_graph"), "readGraph");
  assert.equal(stepForTool("list_roadmap_topics"), "findTopics");
  assert.equal(stepForTool("read_roadmap_topic"), "readTopics");
  assert.equal(stepForTool("get_learning_path"), "draft");
  assert.equal(stepForTool("save_learning_path"), "save");
  assert.equal(stepForTool("save_learning_path_json"), "save");
  for (const name of ["web_search", "find_books", "book_contents", "find_papers", "search_wikipedia", "read_page", "deep_research", "list_research_notes", "read_research_note"]) {
    assert.equal(stepForTool(name), "research", name);
  }
  assert.equal(stepForTool("roadmap_get_brief"), null);
  assert.equal(stepForTool("unknown_tool"), null);
});

test("no tool events leave every step pending, and the first step runs while busy", () => {
  assert.deepEqual(Object.values(states(architectSteps([user], undefined, false))), Array(6).fill("pending"));
  const busy = architectSteps([user], undefined, true);
  assert.equal(busy[0]!.state, "running");
  assert.equal(busy.slice(1).every((view) => view.state === "pending"), true);
});

test("an in-flight tool runs its step and earlier steps read as done", () => {
  const messages = [user, assistant(call("a", "read_learner_graph")), result("a", "read_learner_graph")];
  const partial = assistant(call("b", "list_roadmap_topics"));
  const views = architectSteps(messages, partial, true);
  assert.deepEqual(states(views), {
    readGraph: "done",
    findTopics: "running",
    readTopics: "pending",
    research: "pending",
    draft: "pending",
    save: "pending",
  });
});

test("topic reads count against the listed total", () => {
  const listing = result("l", "list_roadmap_topics", JSON.stringify({ topics: ["a", "b", "c", "d", "e", "f", "g", "h"] }));
  const reads = [1, 2, 3].flatMap((index) => [
    assistant(call(`r${index}`, "read_roadmap_topic")),
    result(`r${index}`, "read_roadmap_topic", "{}"),
  ]);
  const messages = [user, assistant(call("l", "list_roadmap_topics")), listing, ...reads];
  const views = architectSteps(messages, assistant(call("r4", "read_roadmap_topic")), true);
  const topics = views.find((view) => view.step === "readTopics")!;
  assert.equal(topics.state, "running");
  assert.deepEqual(topics.count, { done: 3, total: 8 });
});

test("a failed topic read is not counted", () => {
  const messages = [
    user,
    assistant(call("r1", "read_roadmap_topic")),
    result("r1", "read_roadmap_topic", "missing", true),
  ];
  const topics = architectSteps(messages, undefined, false).find((view) => view.step === "readTopics")!;
  assert.deepEqual(topics.count, undefined);
});

test("only the current build counts: earlier turns do not mark steps done", () => {
  const messages = [
    user,
    assistant(call("old", "save_learning_path")),
    result("old", "save_learning_path"),
    { role: "assistant", content: [{ type: "text", text: "Saved." }] },
    { role: "user", content: "Add a section on testing" },
  ];
  const views = architectSteps(messages, undefined, true);
  assert.equal(views[0]!.state, "running");
  assert.equal(views[5]!.state, "pending");
});

test("after a successful save the model's wrap-up leaves no step running", () => {
  const messages = [
    user,
    assistant(call("g", "read_learner_graph")),
    result("g", "read_learner_graph"),
    assistant(call("s", "save_learning_path")),
    result("s", "save_learning_path"),
  ];
  const views = architectSteps(messages, undefined, true);
  assert.equal(views.some((view) => view.state === "running"), false);
  assert.equal(views[5]!.state, "done");
});

test("a finished, idle build reads as done up to the furthest step reached", () => {
  const messages = [user, assistant(call("g", "read_learner_graph")), result("g", "read_learner_graph")];
  assert.deepEqual(Object.values(states(architectSteps(messages, undefined, false))), [
    "done", "pending", "pending", "pending", "pending", "pending",
  ]);
});

test("topics answered in full by the listing count as read, once even if read again", () => {
  const listing = result(
    "l",
    "list_roadmap_topics",
    JSON.stringify({
      topics: [
        { slug: "a", content: { title: "A" } },
        { slug: "b", content: { title: "B" } },
        { slug: "c", content: null },
      ],
    }),
  );
  const reread = result("r", "read_roadmap_topics", JSON.stringify({ results: [{ slug: "a", ok: true }, { slug: "c", ok: true }] }));
  const messages = [user, assistant(call("l", "list_roadmap_topics")), listing, assistant(call("r", "read_roadmap_topics")), reread];
  const views = architectSteps(messages, undefined, true);
  const topics = views.find((view) => view.step === "readTopics")!;
  assert.deepEqual(topics.count, { done: 3, total: 3 });
});

test("topics from two roadmaps count against both listings, and a shared slug is two topics", () => {
  const listA = result("la", "list_roadmap_topics", JSON.stringify({ roadmap: "a", topics: [{ slug: "x", content: {} }, { slug: "y", content: {} }, { slug: "z", content: {} }] }));
  const listB = result("lb", "list_roadmap_topics", JSON.stringify({ roadmap: "b", topics: [{ slug: "x", content: {} }, { slug: "w", content: null }] }));
  const readB = result("rb", "read_roadmap_topic", JSON.stringify({ roadmap: "b", slug: "w" }));
  const messages = [
    user,
    assistant(call("la", "list_roadmap_topics")), listA,
    assistant(call("lb", "list_roadmap_topics")), listB,
    assistant(call("rb", "read_roadmap_topic")), readB,
  ];
  const views = architectSteps(messages, undefined, true);
  const topics = views.find((view) => view.step === "readTopics")!;
  // 3 of A and 2 of B are answered: 5 of 5, and the shared slug "x" counts once per roadmap.
  assert.deepEqual(topics.count, { done: 5, total: 5 });
});
