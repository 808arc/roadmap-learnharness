/** Which roadmaps and nodes the learner worked on each study day, from native sessions and node chat links.
 *
 * Pure: the caller passes the roadmaps and the native session list; nothing reads the clock or any other plugin's data.
 *
 * Same study-day rule as `follow-through.ts` (see that file's header for the source of the rule):
 *  - each learner action is dated by its own timestamp, in the machine's local calendar day;
 *  - a session that crosses midnight counts on both days;
 *  - a node is worked on a day when one of its linked sessions has an action on that day.
 * A chat link's createdAt is not an action, so it does not make a day on its own.
 */
import type { LearningPath } from "./domain.ts";
import { localDay } from "./follow-through.ts";
import type { NativeSessionActivity } from "./follow-through.ts";

export interface NodeDayWork {
  readonly nodeId: string;
  readonly title: string;
}

export interface RoadmapDayWork {
  readonly roadmapId: string;
  /** Nodes in path order that had a linked session with an action on the day. */
  readonly nodes: readonly NodeDayWork[];
}

export interface StudyDayWork {
  /** Local calendar day, `YYYY-MM-DD`. */
  readonly day: string;
  /** Roadmaps with at least one worked node on the day, sorted by roadmap id. */
  readonly roadmaps: readonly RoadmapDayWork[];
}

/** Local days with an action in one native session. Same fallback as `follow-through.ts`. */
function actionDays(session: NativeSessionActivity): string[] {
  const raw = session.actionTimes && session.actionTimes.length > 0
    ? session.actionTimes.map((time) => Date.parse(time))
    : [Date.parse(session.createdAt), Date.parse(session.updatedAt)];
  return [...new Set(raw.filter((ms) => Number.isFinite(ms)).map(localDay))];
}

/** For each study day, the roadmaps and nodes the learner worked on that day. Sorted by day, then roadmap id. */
export function studyDayWork(
  paths: readonly LearningPath[],
  sessions: readonly NativeSessionActivity[],
): StudyDayWork[] {
  const daysById = new Map<string, readonly string[]>();
  for (const session of sessions) {
    const days = actionDays(session);
    if (days.length > 0) daysById.set(session.id, days);
  }

  // day -> roadmap id -> node id -> node work
  const byDay = new Map<string, Map<string, Map<string, NodeDayWork>>>();
  for (const path of paths) {
    for (const module of path.modules) {
      for (const node of module.nodes) {
        for (const link of node.childSessions) {
          const days = daysById.get(link.chatId);
          if (!days) continue;
          for (const day of days) {
            let roadmaps = byDay.get(day);
            if (!roadmaps) byDay.set(day, (roadmaps = new Map()));
            let nodes = roadmaps.get(path.id);
            if (!nodes) roadmaps.set(path.id, (nodes = new Map()));
            if (!nodes.has(node.id)) nodes.set(node.id, { nodeId: node.id, title: node.title });
          }
        }
      }
    }
  }

  return [...byDay.keys()].sort().map((day) => {
    const roadmaps = [...byDay.get(day)!.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([roadmapId, nodes]): RoadmapDayWork => ({ roadmapId, nodes: [...nodes.values()] }));
    return { day, roadmaps };
  });
}
