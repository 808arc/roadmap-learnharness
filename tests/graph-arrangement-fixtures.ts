/** Fixtures for the graph arrangement tests and renders: a seeded generator, random DAGs and the owner's shape. */

/** Seeded generator (mulberry32). */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A random DAG: node i may depend on up to three earlier nodes, some of them far back (long arrows). */
export function randomDag(size: number, seed: number): Record<string, string[]> {
  const random = seeded(seed);
  const after: Record<string, string[]> = {};
  for (let i = 0; i < size; i += 1) {
    const wanted = i === 0 ? 0 : random() < 0.12 ? 0 : 1 + Math.floor(random() * 3);
    const picks = new Set<number>();
    for (let k = 0; k < wanted; k += 1) picks.add(random() < 0.6 ? Math.max(0, i - 1 - Math.floor(random() * 5)) : Math.floor(random() * i));
    after[`n${i}`] = [...picks].filter((p) => p < i).sort((a, b) => a - b).map((p) => `n${p}`);
  }
  return after;
}

/** The owner's shape: 40 nodes in 9 layers with branches, merges and long skip edges. */
export function ownerShape(): Record<string, string[]> {
  const sizes = [3, 5, 6, 6, 6, 5, 4, 3, 2];
  const random = seeded(7);
  const layers: string[][] = [];
  const after: Record<string, string[]> = {};
  sizes.forEach((count, depth) => {
    const ids = Array.from({ length: count }, (_, i) => `L${depth}n${i}`);
    layers.push(ids);
    ids.forEach((id, i) => {
      if (depth === 0) {
        after[id] = [];
        return;
      }
      const above = layers[depth - 1]!;
      const first = above[Math.min(above.length - 1, Math.floor((i * above.length) / ids.length))]!;
      const second = above[Math.floor(random() * above.length)]!;
      after[id] = [...new Set(random() < 0.45 ? [first, second] : [first])];
    });
  });
  after["L8n1"] = [...after["L8n1"]!, "L0n0"]; // the long skip edge
  after["L5n2"] = [...after["L5n2"]!, "L1n1"];
  after["L7n0"] = [...after["L7n0"]!, "L3n4"];
  return after;
}

