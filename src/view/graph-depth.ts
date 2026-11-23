/** Inference depth (pure, DOM-free), ported from LearnHarness's `inferenceDepths` (core/layout.ts).
 *
 * The depth of a node is the longest chain of arrows (prerequisite to dependent) that ends at it.
 * Cycles are collapsed first: every node in one strongly connected component shares its component's
 * depth, so mutual dependence reads as equal footing and the condensation is acyclic. Iterative
 * Tarjan, so no recursion limit applies. Deterministic for the same input order.
 */

export interface DepthEdge {
  readonly from: string;
  readonly to: string;
}

export function inferenceDepth(ids: readonly string[], edges: readonly DepthEdge[]): Map<string, number> {
  const valid = new Set(ids);
  const adjacent = new Map<string, string[]>();
  for (const edge of edges) {
    if (edge.from === edge.to || !valid.has(edge.from) || !valid.has(edge.to)) continue;
    const list = adjacent.get(edge.from) ?? [];
    list.push(edge.to);
    adjacent.set(edge.from, list);
  }

  // Iterative Tarjan: components come out sinks first.
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const component = new Map<string, number>();
  let counter = 0;
  let components = 0;
  for (const start of valid) {
    if (index.has(start)) continue;
    index.set(start, counter);
    low.set(start, counter);
    counter += 1;
    stack.push(start);
    onStack.add(start);
    const work: [string, number][] = [[start, 0]];
    while (work.length > 0) {
      const frame = work[work.length - 1]!;
      const v = frame[0];
      const outs = adjacent.get(v) ?? [];
      if (frame[1] < outs.length) {
        const w = outs[frame[1]!]!;
        frame[1] += 1;
        if (!index.has(w)) {
          index.set(w, counter);
          low.set(w, counter);
          counter += 1;
          stack.push(w);
          onStack.add(w);
          work.push([w, 0]);
        } else if (onStack.has(w)) {
          low.set(v, Math.min(low.get(v)!, index.get(w)!));
        }
        continue;
      }
      work.pop();
      if (low.get(v) === index.get(v)) {
        let w: string;
        do {
          w = stack.pop()!;
          onStack.delete(w);
          component.set(w, components);
        } while (w !== v);
        components += 1;
      }
      if (work.length > 0) {
        const parent = work[work.length - 1]![0];
        low.set(parent, Math.min(low.get(parent)!, low.get(v)!));
      }
    }
  }

  // Longest path over the condensation. Higher component index = earlier in the order (sources first).
  const predecessors: Set<number>[] = Array.from({ length: components }, () => new Set<number>());
  for (const edge of edges) {
    const from = component.get(edge.from);
    const to = component.get(edge.to);
    if (from === undefined || to === undefined || from === to) continue;
    predecessors[to]!.add(from);
  }
  const depthOf = new Array<number>(components).fill(0);
  for (let c = components - 1; c >= 0; c -= 1) {
    for (const p of predecessors[c]!) depthOf[c] = Math.max(depthOf[c]!, depthOf[p]! + 1);
  }

  const result = new Map<string, number>();
  for (const id of valid) result.set(id, depthOf[component.get(id)!] ?? 0);
  return result;
}
