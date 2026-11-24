/** Event-driven ready queue for generating roadmap nodes in parallel (issue #64).
 *
 * Pure: no I/O, no DOM, no timers of its own. The injected `run` does the work.
 *
 * After the skeleton exists every node is structurally ready (it carries a title and a one-line
 * goal), so the queue order is the whole policy: nodes start in ascending rank (prerequisite
 * depth), ties by input order. A free slot is never left idle; a node that has to wait for a slot
 * simply sees more finished prerequisites when it finally starts.
 */

export interface SchedulerNode {
  readonly id: string;
  readonly prerequisites: readonly string[];
}

export type SchedulerEvent<R> = {
  type: "start" | "done" | "retry" | "failed";
  id: string;
  /** 1 for the first attempt. */
  attempt: number;
  result?: R;
  error?: unknown;
};

export interface SchedulerOptions<R> {
  /** The whole skeleton. Later nodes that repeat an earlier id are ignored. */
  readonly nodes: readonly SchedulerNode[];
  /** Positive integer: the host's workerRequestConcurrency. */
  readonly concurrency: number;
  /** Extra attempts per node after the first, >= 0. */
  readonly retries: number;
  /** Runs one node. `done` holds the results of its prerequisites that have ALREADY finished; the others are structural only. */
  readonly run: (id: string, done: ReadonlyMap<string, R>, signal: AbortSignal) => Promise<R>;
  readonly signal?: AbortSignal;
  readonly onEvent?: (event: SchedulerEvent<R>) => void;
}

export interface SchedulerOutcome<R> {
  results: ReadonlyMap<string, R>;
  failed: ReadonlyMap<string, unknown>;
}

/** First occurrence of each id, with prerequisites restricted to known ids and without self-references. */
function normalise(nodes: readonly SchedulerNode[]): Array<{ id: string; prerequisites: string[] }> {
  const ids = new Set(nodes.map((node) => node.id));
  const seen = new Set<string>();
  const out: Array<{ id: string; prerequisites: string[] }> = [];
  for (const node of nodes) {
    if (seen.has(node.id)) continue;
    seen.add(node.id);
    out.push({ id: node.id, prerequisites: [...new Set(node.prerequisites)].filter((p) => p !== node.id && ids.has(p)) });
  }
  return out;
}

/** Depth over the prerequisite DAG: 0 without prerequisites, else 1 + the highest prerequisite rank.
 *  Members of a cycle share one rank (1 + the highest rank among the prerequisites outside the cycle). */
export function rankOf(nodes: readonly SchedulerNode[]): Map<string, number> {
  const clean = normalise(nodes);
  const prereqs = new Map(clean.map((node) => [node.id, node.prerequisites]));

  // Tarjan's strongly connected components; a component is emitted after everything it depends on.
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const component = new Map<string, number>();
  const members: string[][] = [];
  let counter = 0;
  const visit = (id: string): void => {
    index.set(id, counter);
    low.set(id, counter);
    counter += 1;
    stack.push(id);
    onStack.add(id);
    for (const next of prereqs.get(id) ?? []) {
      if (!index.has(next)) {
        visit(next);
        low.set(id, Math.min(low.get(id)!, low.get(next)!));
      } else if (onStack.has(next)) {
        low.set(id, Math.min(low.get(id)!, index.get(next)!));
      }
    }
    if (low.get(id) !== index.get(id)) return;
    const group: string[] = [];
    for (;;) {
      const top = stack.pop()!;
      onStack.delete(top);
      component.set(top, members.length);
      group.push(top);
      if (top === id) break;
    }
    members.push(group);
  };
  for (const node of clean) if (!index.has(node.id)) visit(node.id);

  const groupRank: number[] = [];
  const ranks = new Map<string, number>();
  members.forEach((group, groupIndex) => {
    let highest = -1;
    for (const id of group) {
      for (const p of prereqs.get(id) ?? []) {
        if (component.get(p) !== groupIndex) highest = Math.max(highest, groupRank[component.get(p)!]!);
      }
    }
    groupRank[groupIndex] = highest + 1;
    for (const id of group) ranks.set(id, highest + 1);
  });
  return new Map(clean.map((node) => [node.id, ranks.get(node.id)!]));
}

export function runScheduler<R>(options: SchedulerOptions<R>): Promise<SchedulerOutcome<R>> {
  const { concurrency, retries, run, signal, onEvent } = options;
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new RangeError("concurrency must be a positive integer");
  if (!Number.isInteger(retries) || retries < 0) throw new RangeError("retries must be an integer >= 0");

  const nodes = normalise(options.nodes);
  const rank = rankOf(nodes);
  const queue = nodes
    .map((node, order) => ({ node, order }))
    .sort((a, b) => rank.get(a.node.id)! - rank.get(b.node.id)! || a.order - b.order)
    .map((entry) => entry.node);
  const idle = new AbortController();
  const runSignal = signal ?? idle.signal;
  const results = new Map<string, R>();
  const failed = new Map<string, unknown>();
  const emit = (event: SchedulerEvent<R>): void => {
    try {
      onEvent?.(event);
    } catch {
      // An observer must not break scheduling.
    }
  };

  return new Promise((resolve) => {
    let inFlight = 0;
    let next = 0;
    let finished = false;

    const execute = async (node: { id: string; prerequisites: string[] }): Promise<void> => {
      for (let attempt = 1; ; attempt += 1) {
        const done = new Map<string, R>();
        for (const p of node.prerequisites) if (results.has(p)) done.set(p, results.get(p) as R);
        emit({ type: "start", id: node.id, attempt });
        try {
          const result = await run(node.id, done, runSignal);
          results.set(node.id, result);
          emit({ type: "done", id: node.id, attempt, result });
          return;
        } catch (error) {
          if (attempt <= retries && !runSignal.aborted) {
            emit({ type: "retry", id: node.id, attempt, error });
            // The observer may have aborted; an abort stops new attempts too.
            if (!runSignal.aborted) continue;
          }
          failed.set(node.id, error);
          emit({ type: "failed", id: node.id, attempt, error });
          return;
        }
      }
    };

    const pump = (): void => {
      if (finished) return;
      while (!runSignal.aborted && inFlight < concurrency && next < queue.length) {
        const node = queue[next++]!;
        inFlight += 1;
        void execute(node).then(() => {
          inFlight -= 1;
          pump();
        });
      }
      if (inFlight === 0 && (runSignal.aborted || next >= queue.length)) {
        finished = true;
        // A long-lived signal must not keep this run (and its result maps) alive.
        signal?.removeEventListener("abort", pump);
        resolve({ results, failed });
      }
    };

    signal?.addEventListener("abort", pump, { once: true });
    pump();
  });
}
