/** Follow-through metrics for one roadmap, computed from native sessions.
 *
 * Pure: the caller passes the native session list, the roadmap and `now`; nothing reads the clock.
 *
 * Study-day rule, the same one the Activity heatmap plugin uses
 * (https://github.com/Huskhd/learnharness-activity-heatmap, read from its public dist files):
 *  - each learner action (a message, an answered question, a practice submission) is dated by its own timestamp;
 *  - a day is a local calendar day, taken from the machine's time zone (local Date getters);
 *  - a day is a study day when it holds at least one action, so a session that crosses midnight counts on both days.
 * `actionTimes` supplies the exact action timestamps (from getSession). Without them, a session falls back to its
 * createdAt and updatedAt, which is an approximation.
 *
 * No streaks, points or deadlines.
 */
import type { LearningPath, PathNode } from "./domain.ts";

/** A node in progress with no linked session for this many local days is reported as stalled. */
export const STALLED_AFTER_DAYS = 14;

const DAY_MS = 86_400_000;

/** The fields of a native session that this module reads (a structural subset of `ChatListItem`). */
export interface NativeSessionActivity {
  readonly id: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Timestamps of each action in the session, when the caller has read the transcript. */
  readonly actionTimes?: readonly string[];
}

export interface DayCount {
  /** Local calendar day, `YYYY-MM-DD`. */
  readonly day: string;
  readonly count: number;
}

export interface StalledNode {
  readonly nodeId: string;
  readonly title: string;
  /** Local day of the latest linked session activity. */
  readonly lastLinkedDay: string;
  /** Whole local days between `lastLinkedDay` and `now`. */
  readonly daysSince: number;
}

export interface FollowThroughReport {
  readonly roadmapId: string;
  /** Nodes in progress or consolidated, counted on the day of their earliest child session link. */
  readonly startedByDay: readonly DayCount[];
  /** Consolidated nodes, counted on their latest linked session day (PathNode records no consolidation time). */
  readonly consolidatedByDay: readonly DayCount[];
  /** Sorted local days with at least one action in a session linked to this roadmap. */
  readonly studyDays: readonly string[];
  /** In-progress, non-optional nodes with no linked session for `STALLED_AFTER_DAYS` days or more. */
  readonly stalledNodes: readonly StalledNode[];
}

const pad = (n: number): string => String(n).padStart(2, "0");

function instant(iso: string, label: string): number {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) throw new Error(`${label} is not a valid timestamp: ${iso}`);
  return ms;
}

/** Local calendar day of an instant, as `YYYY-MM-DD`. */
export function localDay(ms: number): string {
  const date = new Date(ms);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Day number of a `YYYY-MM-DD` key, for whole-day arithmetic. */
function dayNumber(day: string): number {
  const [year, month, date] = day.split("-").map(Number) as [number, number, number];
  return Math.round(Date.UTC(year, month - 1, date) / DAY_MS);
}

function countByDay(days: readonly string[]): DayCount[] {
  const counts = new Map<string, number>();
  for (const day of days) counts.set(day, (counts.get(day) ?? 0) + 1);
  return [...counts.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([day, count]) => ({ day, count }));
}

/** Action days and latest activity day of one native session. */
interface SessionActivity {
  readonly days: readonly string[];
  readonly lastDay: string;
}

function sessionActivity(session: NativeSessionActivity): SessionActivity | null {
  const raw = session.actionTimes && session.actionTimes.length > 0
    ? session.actionTimes.map((time) => Date.parse(time))
    : [Date.parse(session.createdAt), Date.parse(session.updatedAt)];
  const instants = raw.filter((ms) => Number.isFinite(ms)).sort((a, b) => a - b);
  if (instants.length === 0) return null;
  const days = [...new Set(instants.map(localDay))];
  return { days, lastDay: localDay(instants[instants.length - 1]!) };
}

/** Compute one roadmap's follow-through from the native session list. */
export function followThrough(
  path: LearningPath,
  sessions: readonly NativeSessionActivity[],
  now: string,
): FollowThroughReport {
  const today = localDay(instant(now, "now"));
  const todayNumber = dayNumber(today);

  const activityById = new Map<string, SessionActivity>();
  for (const session of sessions) {
    const activity = sessionActivity(session);
    if (activity) activityById.set(session.id, activity);
  }

  const nodes: PathNode[] = path.modules.flatMap((module) => [...module.nodes]);
  const studyDays = new Set<string>();
  const startedDays: string[] = [];
  const consolidatedDays: string[] = [];
  const stalledNodes: StalledNode[] = [];

  for (const node of nodes) {
    let firstLinkDay: string | null = null;
    let lastLinkedDay: string | null = null;

    for (const link of node.childSessions) {
      const linkDay = localDay(instant(link.createdAt, `${node.id} child session createdAt`));
      if (firstLinkDay === null || linkDay < firstLinkDay) firstLinkDay = linkDay;
      if (lastLinkedDay === null || linkDay > lastLinkedDay) lastLinkedDay = linkDay;

      const activity = activityById.get(link.chatId);
      if (!activity) continue;
      for (const day of activity.days) studyDays.add(day);
      if (activity.lastDay > lastLinkedDay) lastLinkedDay = activity.lastDay;
    }

    const started = node.progression === "in_progress" || node.progression === "consolidated";
    if (started && firstLinkDay !== null) startedDays.push(firstLinkDay);
    if (node.progression === "consolidated" && lastLinkedDay !== null) consolidatedDays.push(lastLinkedDay);

    if (node.progression === "in_progress" && node.optional !== true && lastLinkedDay !== null) {
      const daysSince = todayNumber - dayNumber(lastLinkedDay);
      if (daysSince >= STALLED_AFTER_DAYS) {
        stalledNodes.push({ nodeId: node.id, title: node.title, lastLinkedDay, daysSince });
      }
    }
  }

  return {
    roadmapId: path.id,
    startedByDay: countByDay(startedDays),
    consolidatedByDay: countByDay(consolidatedDays),
    studyDays: [...studyDays].sort(),
    stalledNodes,
  };
}
