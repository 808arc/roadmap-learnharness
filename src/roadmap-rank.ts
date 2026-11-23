/** Ranks upstream roadmaps by how closely they cover the learner's graph topics.
 *
 * Pure: the caller passes the graph's topic keys (topicKey form, hyphenated) and each roadmap's topic slugs.
 * A graph topic that equals a roadmap topic is an exact match. A graph topic that shares a meaningful word with
 * one of a roadmap's topics is a near match, counted at a lower weight. Near matches add to a roadmap's score and
 * its place in the order, but a roadmap is chosen only when at least one of its topics matches exactly. The best
 * such roadmap is chosen; a second is chosen when it scores at least half as much as the first.
 */

export interface RoadmapMatch {
  readonly roadmap: string;
  /** Graph topics that equal a topic of this roadmap. */
  readonly matched: number;
  /** Graph topics that share a meaningful word with a topic of this roadmap (not already exact). */
  readonly near: number;
  /** Topics the roadmap lists. */
  readonly total: number;
}

export interface RoadmapRanking {
  /**
   * Best first, at most two: the chosen roadmaps. Each has at least one exact match (`matched >= 1`). Empty when no
   * roadmap has an exact match, even if some roadmaps share words with the graph (see `candidates`).
   */
  readonly chosen: readonly RoadmapMatch[];
  /** Every roadmap with a score (exact or near matches), best first. Not limited to the chosen ones. */
  readonly candidates: readonly RoadmapMatch[];
}

/** Share of the best score a second roadmap needs to be chosen too. */
export const SECOND_ROADMAP_RATIO = 0.5;
/** Weight of a near match against an exact one. */
const NEAR_WEIGHT = 0.5;

const STOPWORDS: ReadonlySet<string> = new Set([
  "a", "an", "and", "as", "at", "be", "by", "for", "from", "in", "is", "of", "on", "or", "the", "to", "vs", "with",
]);

/** Meaningful words of a hyphenated key: at least three letters or digits, not a stopword. */
function wordsOf(key: string): string[] {
  return key.split("-").filter((word) => word.length >= 3 && !STOPWORDS.has(word));
}

export function rankRoadmaps(
  graphKeys: ReadonlySet<string>,
  roadmaps: ReadonlyMap<string, readonly string[]>,
): RoadmapRanking {
  const candidates: { match: RoadmapMatch; score: number }[] = [];
  for (const [roadmap, slugs] of roadmaps) {
    const slugSet = new Set(slugs);
    const words = new Set(slugs.flatMap(wordsOf));
    let matched = 0;
    let near = 0;
    for (const key of graphKeys) {
      if (slugSet.has(key)) matched += 1;
      else if (wordsOf(key).some((word) => words.has(word))) near += 1;
    }
    const score = matched + NEAR_WEIGHT * near;
    if (score > 0) candidates.push({ match: { roadmap, matched, near, total: slugs.length }, score });
  }
  // Best score first; ties keep the more focused roadmap (fewer topics), then the name, so the order is stable.
  candidates.sort(
    (a, b) => b.score - a.score || a.match.total - b.match.total || a.match.roadmap.localeCompare(b.match.roadmap),
  );
  const ordered = candidates.map((entry) => entry.match);
  // Only a roadmap with an exact topic match can be chosen; near matches alone never are.
  const exact = candidates.filter((entry) => entry.match.matched >= 1);
  const best = exact[0];
  const second = exact[1];
  const chosen: RoadmapMatch[] = [];
  if (best) chosen.push(best.match);
  if (best && second && second.score >= best.score * SECOND_ROADMAP_RATIO) chosen.push(second.match);
  return { chosen, candidates: ordered };
}
