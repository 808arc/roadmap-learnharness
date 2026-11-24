/** Ready-queue scheduler for parallel node generation (issue #64).
 *
 * Synthetic node ids only. `run` is a controllable deferred; no timers, no sleeps.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { rankOf, runScheduler, type SchedulerEvent, type SchedulerNode } from "../src/node-scheduler.ts";

const node = (id: string, ...prerequisites: string[]): SchedulerNode => ({ id, prerequisites });

/** Let every pending promise continuation run. */
async function flush(): Promise<void> {
  for (let i = 0; i < 50; i += 1) await Promise.resolve();
}

interface Call {
  id: string;
  attempt: number;
  done: ReadonlyMap<string, string>;
  signal: AbortSignal;
  resolve: (value: string) => void;
  reject: (error: unknown) => void;
}

/** A `run` whose every call is held until the test settles it. */
function controlled() {
  const calls: Call[] = [];
  const attempts = new Map<string, number>();
  let active = 0;
  let peak = 0;
  const run = (id: string, done: ReadonlyMap<string, string>, signal: AbortSignal): Promise<string> =>
    new Promise<string>((resolve, reject) => {
      active += 1;
      peak = Math.max(peak, active);
      const attempt = (attempts.get(id) ?? 0) + 1;
      attempts.set(id, attempt);
      calls.push({
        id,
        attempt,
        done,
        signal,
        resolve: (value) => {
          active -= 1;
          resolve(value);
        },
        reject: (error) => {
          active -= 1;
          reject(error);
        },
      });
    });
  return {
    run,
    calls,
    attempts,
    get active() {
      return active;
    },
    get peak() {
      return peak;
    },
    pending: (): string[] => calls.filter((c) => !settled.has(c)).map((c) => c.id),
    take(id: string): Call {
      const call = calls.find((c) => c.id === id && !settled.has(c));
      assert.ok(call, `no pending call for ${id}`);
      settled.add(call);
      return call;
    },
  };
}
const settled = new WeakSet<Call>();

test("rankOf: a chain ranks by depth", () => {
  const ranks = rankOf([node("c", "b"), node("a"), node("b", "a")]);
  assert.deepEqual([...ranks], [["c", 2], ["a", 0], ["b", 1]]);
});

test("rankOf: a diamond whose last node has prerequisites on different branches", () => {
  const ranks = rankOf([node("a"), node("b", "a"), node("x"), node("y", "x"), node("z", "y"), node("d", "b", "z")]);
  assert.equal(ranks.get("a"), 0);
  assert.equal(ranks.get("b"), 1);
  assert.equal(ranks.get("z"), 2);
  assert.equal(ranks.get("d"), 3);
});

test("rankOf: cycle members share a rank, dependants rank above, and nothing throws or hangs", () => {
  const ranks = rankOf([node("root"), node("a", "root", "c"), node("b", "a"), node("c", "b"), node("after", "c")]);
  assert.equal(ranks.get("root"), 0);
  assert.equal(ranks.get("a"), 1);
  assert.equal(ranks.get("b"), 1);
  assert.equal(ranks.get("c"), 1);
  assert.equal(ranks.get("after"), 2);
});

test("rankOf: ignores unknown and self prerequisites", () => {
  const ranks = rankOf([node("a", "a", "ghost"), node("b", "a")]);
  assert.equal(ranks.get("a"), 0);
  assert.equal(ranks.get("b"), 1);
});

test("concurrency is never exceeded and no slot idles while nodes are queued", async () => {
  const ctl = controlled();
  const nodes = ["a", "b", "c", "d", "e"].map((id) => node(id));
  const outcome = runScheduler({ nodes, concurrency: 2, retries: 0, run: ctl.run });
  await flush();
  assert.deepEqual(ctl.pending(), ["a", "b"]);
  ctl.take("a").resolve("A");
  await flush();
  assert.deepEqual(ctl.pending(), ["b", "c"], "the freed slot is refilled at once");
  ctl.take("c").resolve("C");
  ctl.take("b").resolve("B");
  await flush();
  assert.deepEqual(ctl.pending(), ["d", "e"]);
  ctl.take("d").resolve("D");
  ctl.take("e").resolve("E");
  const { results, failed } = await outcome;
  assert.equal(ctl.peak, 2);
  assert.equal(results.size, 5);
  assert.equal(failed.size, 0);
});

test("nodes start in ascending rank, ties by input order", async () => {
  const ctl = controlled();
  const nodes = [node("c2", "b1"), node("b1", "a"), node("a"), node("c1", "b1"), node("a2")];
  const started: string[] = [];
  const outcome = runScheduler<string>({
    nodes,
    concurrency: 1,
    retries: 0,
    run: (id, done, signal) => {
      started.push(id);
      return ctl.run(id, done, signal);
    },
  });
  for (let i = 0; i < nodes.length; i += 1) {
    await flush();
    ctl.take(ctl.pending()[0]!).resolve("ok");
  }
  await outcome;
  assert.deepEqual(started, ["a", "a2", "b1", "c2", "c1"]);
});

test("a late-starting node sees finished prerequisites; an early one does not", async () => {
  const ctl = controlled();
  // a (rank 0) and b (rank 1, needs a) and c (rank 2, needs a and b); concurrency 2.
  const nodes = [node("a"), node("x"), node("b", "a"), node("c", "a", "b")];
  const outcome = runScheduler({ nodes, concurrency: 2, retries: 0, run: ctl.run });
  await flush();
  assert.deepEqual(ctl.pending(), ["a", "x"]);
  ctl.take("a").resolve("A");
  await flush();
  const b = ctl.take("b");
  assert.deepEqual([...b.done], [["a", "A"]], "b starts after a finished, so it has a's content");
  ctl.take("x").resolve("X");
  await flush();
  const c = ctl.take("c");
  assert.deepEqual([...c.done], [["a", "A"]], "b is still running, so c has only a");
  b.resolve("B");
  c.resolve("C");
  await outcome;
  assert.deepEqual([...ctl.calls.find((call) => call.id === "a")!.done], [], "the first node starts with nothing");
});

test("a node starts as soon as a slot is free, without waiting for its prerequisites", async () => {
  const ctl = controlled();
  const outcome = runScheduler({ nodes: [node("a"), node("b", "a")], concurrency: 2, retries: 0, run: ctl.run });
  await flush();
  assert.deepEqual(ctl.pending(), ["a", "b"]);
  assert.equal(ctl.calls[1]!.done.size, 0);
  ctl.take("a").resolve("A");
  ctl.take("b").resolve("B");
  await outcome;
});

test("retry then success", async () => {
  const ctl = controlled();
  const events: string[] = [];
  const outcome = runScheduler({
    nodes: [node("a")],
    concurrency: 1,
    retries: 2,
    run: ctl.run,
    onEvent: (e: SchedulerEvent<string>) => events.push(`${e.type}:${e.attempt}`),
  });
  await flush();
  ctl.take("a").reject(new Error("boom"));
  await flush();
  ctl.take("a").resolve("A");
  const { results, failed } = await outcome;
  assert.equal(results.get("a"), "A");
  assert.equal(failed.size, 0);
  assert.deepEqual(events, ["start:1", "retry:1", "start:2", "done:2"]);
});

test("retry exhausted records failed; independent and dependant nodes still run", async () => {
  const ctl = controlled();
  const boom = new Error("boom");
  const outcome = runScheduler({
    nodes: [node("a"), node("b", "a"), node("c")],
    concurrency: 2,
    retries: 1,
    run: ctl.run,
  });
  await flush();
  ctl.take("c").resolve("C");
  ctl.take("a").reject(boom);
  await flush();
  ctl.take("a").reject(boom);
  await flush();
  const b = ctl.take("b");
  assert.equal(b.done.size, 0, "the failed prerequisite gives no content");
  b.resolve("B");
  const { results, failed } = await outcome;
  assert.equal(ctl.attempts.get("a"), 2);
  assert.equal(failed.get("a"), boom);
  assert.deepEqual([...results.keys()].sort(), ["b", "c"]);
});

test("abort stops new starts, signals in-flight runs and resolves with what exists", async () => {
  const ctl = controlled();
  const abort = new AbortController();
  const outcome = runScheduler({
    nodes: [node("a"), node("b"), node("c"), node("d")],
    concurrency: 2,
    retries: 3,
    run: ctl.run,
    signal: abort.signal,
  });
  await flush();
  ctl.take("a").resolve("A");
  await flush();
  assert.deepEqual(ctl.pending(), ["b", "c"]);
  abort.abort();
  const b = ctl.take("b");
  const c = ctl.take("c");
  assert.equal(b.signal, abort.signal);
  b.resolve("B");
  c.reject(new Error("aborted"));
  const { results, failed } = await outcome;
  assert.deepEqual([...results.keys()].sort(), ["a", "b"]);
  assert.deepEqual([...failed.keys()], ["c"], "no retry after an abort");
  assert.equal(ctl.attempts.has("d"), false, "d never started");
  assert.equal(results.has("d") || failed.has("d"), false);
});

test("abort before the start resolves empty without running anything", async () => {
  const ctl = controlled();
  const abort = new AbortController();
  abort.abort();
  const { results, failed } = await runScheduler({ nodes: [node("a")], concurrency: 1, retries: 0, run: ctl.run, signal: abort.signal });
  assert.equal(results.size + failed.size, 0);
  assert.equal(ctl.calls.length, 0);
});

test("invalid options throw RangeError", () => {
  const run = async (): Promise<string> => "x";
  for (const concurrency of [0, -1, 1.5, Number.NaN]) {
    assert.throws(() => runScheduler({ nodes: [], concurrency, retries: 0, run }), RangeError);
  }
  for (const retries of [-1, 0.5, Number.NaN]) {
    assert.throws(() => runScheduler({ nodes: [], concurrency: 1, retries, run }), RangeError);
  }
});

test("unknown and self prerequisites are ignored; duplicate ids run once", async () => {
  const calls: string[] = [];
  const { results } = await runScheduler({
    nodes: [node("a", "a", "ghost"), node("b", "a"), node("a", "b")],
    concurrency: 1,
    retries: 0,
    run: async (id, done) => {
      calls.push(`${id}:${[...done.keys()].join(",")}`);
      return id.toUpperCase();
    },
  });
  assert.deepEqual(calls, ["a:", "b:a"]);
  assert.equal(results.size, 2);
});

test("a cycle terminates and every node runs once", async () => {
  const calls: string[] = [];
  const { results } = await runScheduler({
    nodes: [node("a", "c"), node("b", "a"), node("c", "b")],
    concurrency: 2,
    retries: 0,
    run: async (id) => {
      calls.push(id);
      return id;
    },
  });
  assert.deepEqual(calls, ["a", "b", "c"]);
  assert.equal(results.size, 3);
});

/** Small seeded generator (mulberry32). */
function seeded(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

for (const concurrency of [1, 3, 8]) {
  test(`30-node random DAG runs every node once with concurrency ${concurrency}`, async () => {
    const random = seeded(64 + concurrency);
    const nodes: SchedulerNode[] = [];
    for (let i = 0; i < 30; i += 1) {
      const prerequisites: string[] = [];
      for (let j = 0; j < i; j += 1) if (random() < 0.15) prerequisites.push(`n${j}`);
      nodes.push(node(`n${i}`, ...prerequisites));
    }
    const ctl = controlled();
    const outcome = runScheduler({ nodes, concurrency, retries: 0, run: ctl.run });
    for (let settledCount = 0; settledCount < 30; ) {
      await flush();
      const pending = ctl.pending();
      assert.ok(pending.length > 0 && pending.length <= concurrency);
      // Finish in reverse start order to vary which prerequisites are ready.
      ctl.take(pending[pending.length - 1]!).resolve("ok");
      settledCount += 1;
    }
    const { results, failed } = await outcome;
    assert.equal(results.size, 30);
    assert.equal(failed.size, 0);
    assert.equal(ctl.peak <= concurrency, true);
    for (const attempts of ctl.attempts.values()) assert.equal(attempts, 1);
    assert.equal(ctl.attempts.size, 30);
  });
}
