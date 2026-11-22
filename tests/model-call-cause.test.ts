/** Model-call step end: the cause code for a run that left `running`, and the privacy of that line. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import type { PluginAgentSnapshot } from "learnharness-plugin-api";
import { architectLogPath } from "../src/plugin-log.ts";
import { createHost } from "./host.ts";
import type { TestHost } from "./host.ts";

type Line = Record<string, unknown>;

const SECRET_GOAL = "Learn the secret goal about quantum gardening";
const URL_TEXT = "https://api.example.test/v1/messages?key=abc123";

function readLines(h: TestHost): Line[] {
  return fs
    .readFileSync(architectLogPath(h.dataDirectory), "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Line);
}

/** Open a model-call step with a running snapshot, then publish `ending` as the run's end. */
async function endRun(
  t: { after: (fn: () => void) => void },
  ending: (base: PluginAgentSnapshot) => PluginAgentSnapshot,
  previous: PluginAgentSnapshot["messages"] = [],
): Promise<{ h: TestHost; end: Line }> {
  const h = createHost();
  t.after(() => h.close());
  const created = await h.call<{ conversation: PluginAgentSnapshot }>("architect.create");
  await h.call("architect.get", { id: created.conversation.id });
  const base = h.records.get(created.conversation.id);
  assert.ok(base);
  const running: PluginAgentSnapshot = {
    ...base,
    status: "running",
    messages: [...previous, { role: "user", content: SECRET_GOAL, timestamp: Date.now() } as never],
  };
  h.publish(running);
  h.publish(ending({ ...running, messages: running.messages }));
  const end = readLines(h).find((line) => line.event === "step.end" && line.step === "model call");
  assert.ok(end, "the model-call step ends");
  return { h, end };
}

const assistant = (stopReason: string): PluginAgentSnapshot["messages"][number] =>
  ({ role: "assistant", content: [{ type: "text", text: "partial reply" }], stopReason, timestamp: 0 }) as never;

test("an aborted generation logs cause aborted", async (t) => {
  const { end } = await endRun(t, (run) => ({
    ...run,
    status: "interrupted",
    partial: assistant("aborted") as PluginAgentSnapshot["partial"],
  }));
  assert.equal(end.ok, false);
  assert.equal(end.cause, "aborted");
});

test("a learner stop through architect.abort logs cause user_stop", async (t) => {
  const h = createHost();
  t.after(() => h.close());
  const created = await h.call<{ conversation: PluginAgentSnapshot }>("architect.create");
  const id = created.conversation.id;
  await h.call("architect.get", { id });
  const base = h.records.get(id);
  assert.ok(base);
  h.publish({ ...base, status: "running", messages: [{ role: "user", content: SECRET_GOAL, timestamp: 0 } as never] });
  await h.call("architect.abort", { id });
  const end = readLines(h).find((line) => line.event === "step.end" && line.step === "model call");
  assert.ok(end);
  assert.equal(end.ok, false);
  assert.equal(end.status, "interrupted");
  assert.equal(end.cause, "user_stop");
});

test("a learner stop does not carry over to a later run", async (t) => {
  const h = createHost();
  t.after(() => h.close());
  const created = await h.call<{ conversation: PluginAgentSnapshot }>("architect.create");
  const id = created.conversation.id;
  await h.call("architect.get", { id });
  const base = h.records.get(id);
  assert.ok(base);
  await h.call("architect.abort", { id });
  h.publish({ ...base, status: "running" });
  h.publish({ ...base, status: "interrupted" });
  const end = readLines(h).find((line) => line.event === "step.end" && line.step === "model call");
  assert.ok(end);
  assert.equal(end.cause, "unknown");
});

test("a provider failure logs cause provider_error", async (t) => {
  const { end } = await endRun(t, (run) => ({ ...run, status: "error", error: `Request failed at ${URL_TEXT}` }));
  assert.equal(end.ok, false);
  assert.equal(end.cause, "provider_error");
});

test("an error stop reason on the partial logs cause provider_error", async (t) => {
  const { end } = await endRun(t, (run) => ({
    ...run,
    status: "interrupted",
    partial: assistant("error") as PluginAgentSnapshot["partial"],
  }));
  assert.equal(end.cause, "provider_error");
});

test("a timed-out failure logs cause timeout", async (t) => {
  const { end } = await endRun(t, (run) => ({ ...run, status: "error", error: "The request timed out after 120 seconds" }));
  assert.equal(end.cause, "timeout");
});

test("a run with nothing to classify logs cause unknown", async (t) => {
  const { end } = await endRun(t, (run) => ({ ...run, status: "interrupted" }));
  assert.equal(end.ok, false);
  assert.equal(end.cause, "unknown");
});

test("a stop reason from an earlier run is not used for this one", async (t) => {
  const { end } = await endRun(
    t,
    (run) => ({ ...run, status: "interrupted" }),
    [assistant("error")],
  );
  assert.equal(end.cause, "unknown");
});

test("a finished run logs no cause", async (t) => {
  const { end } = await endRun(t, (run) => ({
    ...run,
    status: "idle",
    messages: [...run.messages, assistant("stop")],
  }));
  assert.equal(end.ok, true);
  assert.equal("cause" in end, false);
});

test("the log line carries no message text, error text or URL", async (t) => {
  const { h } = await endRun(t, (run) => ({
    ...run,
    status: "error",
    error: `Request failed at ${URL_TEXT} with the learner goal`,
    partial: assistant("error") as PluginAgentSnapshot["partial"],
  }));
  const raw = fs.readFileSync(architectLogPath(h.dataDirectory), "utf8");
  assert.equal(raw.includes(SECRET_GOAL), false, "no learner text");
  assert.equal(raw.includes("partial reply"), false, "no assistant text");
  assert.equal(raw.includes("api.example.test"), false, "no URL");
  assert.equal(raw.includes("with the learner goal"), false, "no error text");
});
