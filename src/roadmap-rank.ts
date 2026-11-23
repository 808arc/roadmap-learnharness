/** Ranks upstream roadmaps by how many of the learner's graph topics each one covers.
 *
 * Pure: the caller passes the graph's topic keys and each roadmap's topic slugs. The first roadmap is the best
 * match; a second is chosen only when it covers at least half as many graph topics. Roadmaps covering none are
 * never chosen.
 */

export interface RoadmapMatch {
  readonly roadmap: string;
  /** Graph topics this roadmap covers. */
  readonly matched: number;
  /** Topics the roadmap lists. */
  readonly total: number;
}

export interface RoadmapRanking {
  /** Best first, at most two: the chosen roadmaps. */
  readonly chosen: readonly RoadmapMatch[];
  /** Every roadmap that covers at least one graph topic, best first. */
  readonly candidates: readonly RoadmapMatch[];
}

/** Share of the best match's count a second roadmap needs to be chosen too. */
export const SECOND_ROADMAP_RATIO = 0.5;

export function rankRoadmaps(
  graphKeys: ReadonlySet<string>,
  roadmaps: ReadonlyMap<string, readonly string[]>,
): RoadmapRanking {
  const candidates: RoadmapMatch[] = [];
  for (const [roadmap, slugs] of roadmaps) {
    let matched = 0;
    for (const slug of slugs) if (graphKeys.has(slug)) matched += 1;
    if (matched > 0) candidates.push({ roadmap, matched, total: slugs.length });
  }
  // Ties keep the roadmap with fewer topics first (more focused), then the name, so the order is stable.
  candidates.sort((a, b) => b.matched - a.matched || a.total - b.total || a.roadmap.localeCompare(b.roadmap));
  const [best, second] = candidates;
  const chosen: RoadmapMatch[] = [];
  if (best) chosen.push(best);
  if (best && second && second.matched >= best.matched * SECOND_ROADMAP_RATIO) chosen.push(second);
  return { chosen, candidates };
}
