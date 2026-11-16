/** Learner-activity metrics for one native session.
 *
 * Pure module. "Focused time" follows the Activity Heatmap convention: the sum of
 * gaps between consecutive learner actions, skipping any gap longer than the
 * break threshold (a break, not study). Learner actions are the learner's own
 * messages, answered questions and practice submissions.
 */
export const DEFAULT_BREAK_MS = 15 * 60 * 1000;

export interface SessionMetrics {
  readonly startedAt: number | null;
  readonly focusedMs: number;
  readonly answered: number;
  readonly correct: number;
}

interface MessageLike {
  readonly role?: unknown;
  readonly timestamp?: unknown;
  readonly details?: unknown;
  readonly customType?: unknown;
}

/** Timestamps of learner actions plus answer outcomes, in message order. */
export function learnerActions(messages: readonly unknown[]): { at: number; outcome: "correct" | "wrong" | "unknown" | null }[] {
  const actions: { at: number; outcome: "correct" | "wrong" | "unknown" | null }[] = [];
  for (const raw of messages) {
    if (!raw || typeof raw !== "object") continue;
    const message = raw as MessageLike;
    let at = typeof message.timestamp === "number" ? message.timestamp : Number.NaN;
    let outcome: "correct" | "wrong" | "unknown" | null = null;
    if (message.role === "user") {
      // counted as an action
    } else if (message.role === "toolResult") {
      const details = message.details as Record<string, unknown> | null;
      if (!details || typeof details !== "object" || typeof details.answeredAt !== "string" || details.dismissed) continue;
      const answered = Date.parse(details.answeredAt);
      if (Number.isFinite(answered)) at = answered;
      outcome = details.dontKnow ? "unknown" : details.correct === true ? "correct" : details.correct === false ? "wrong" : null;
    } else if (message.role === "custom" && message.customType === "practice-thinking") {
      // a practice submission
    } else {
      continue;
    }
    if (!Number.isFinite(at) || Math.abs(at) > 8.64e15) continue;
    actions.push({ at, outcome });
  }
  return actions.sort((a, b) => a.at - b.at);
}

export function sessionMetrics(messages: readonly unknown[], breakMs = DEFAULT_BREAK_MS): SessionMetrics {
  const actions = learnerActions(messages);
  let focusedMs = 0;
  for (let index = 1; index < actions.length; index += 1) {
    const gap = actions[index]!.at - actions[index - 1]!.at;
    if (gap > 0 && gap <= breakMs) focusedMs += gap;
  }
  const graded = actions.filter((action) => action.outcome !== null);
  return {
    startedAt: actions[0]?.at ?? null,
    focusedMs,
    answered: graded.length,
    correct: graded.filter((action) => action.outcome === "correct").length,
  };
}
