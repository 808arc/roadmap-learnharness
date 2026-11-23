/** Build-progress model for the Architect pane's step strip.
 *
 * Pure functions only: the pane feeds in the committed messages and the streamed
 * partial, and gets back one view per step. Tool names map to steps here so the
 * mapping is testable without a DOM.
 */

export const ARCHITECT_STEPS = [
  "readGraph",
  "findTopics",
  "readTopics",
  "research",
  "draft",
  "save",
] as const;

export type ArchitectStep = (typeof ARCHITECT_STEPS)[number];
export type ArchitectStepState = "pending" | "running" | "done";

export interface ArchitectStepView {
  readonly step: ArchitectStep;
  readonly state: ArchitectStepState;
  /** Topic reads finished, and the topic total from the listing when known (readTopics only). */
  readonly count?: { readonly done: number; readonly total?: number };
}

const RESEARCH_TOOLS: ReadonlySet<string> = new Set([
  "web_search",
  "search_wikipedia",
  "find_books",
  "book_contents",
  "find_papers",
  "read_page",
  "deep_research",
  "list_research_notes",
  "read_research_note",
]);

/** The step a tool event belongs to, or null for tools outside the build strip. */
export function stepForTool(name: string): ArchitectStep | null {
  switch (name) {
    case "read_learner_graph":
      return "readGraph";
    case "list_roadmap_topics":
      return "findTopics";
    case "read_roadmap_topic":
    case "read_roadmap_topics":
      return "readTopics";
    case "get_learning_path":
      return "draft";
    case "save_learning_path":
    case "save_learning_path_json":
      return "save";
    default:
      return RESEARCH_TOOLS.has(name) ? "research" : null;
  }
}

interface ToolCallRef {
  readonly id: string;
  readonly name: string;
}

interface ToolResultRef {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly isError: boolean;
  readonly text: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function toolCallsOf(message: unknown): ToolCallRef[] {
  if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content)) return [];
  const calls: ToolCallRef[] = [];
  for (const part of message.content) {
    if (isRecord(part) && part.type === "toolCall" && typeof part.name === "string") {
      calls.push({ id: typeof part.id === "string" ? part.id : "", name: part.name });
    }
  }
  return calls;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** Slugs of topics whose content came back in one result, so a topic counted twice is still one topic.
 * `list_roadmap_topics` carries full content for each topic it answers; `read_roadmap_topic(s)` answer one or many. */
function readTopicSlugs(result: ToolResultRef): string[] {
  const parsed = parseJson(result.text);
  if (result.toolName === "list_roadmap_topics") {
    if (!isRecord(parsed) || !Array.isArray(parsed.topics)) return [];
    return parsed.topics
      .filter((entry) => isRecord(entry) && entry.content !== null && entry.content !== undefined)
      .map((entry) => (isRecord(entry) && typeof entry.slug === "string" ? entry.slug : ""))
      .filter((slug) => slug !== "");
  }
  if (result.toolName === "read_roadmap_topics") {
    if (!isRecord(parsed) || !Array.isArray(parsed.results)) return [];
    return parsed.results.flatMap((entry, index) => {
      if (!isRecord(entry) || entry.ok !== true) return [];
      return [typeof entry.slug === "string" ? entry.slug : `${result.toolCallId}#${index}`];
    });
  }
  // A single read without a slug in its result is keyed by its call, so it still counts once.
  return [isRecord(parsed) && typeof parsed.slug === "string" ? parsed.slug : `${result.toolCallId}#0`];
}

function resultOf(message: unknown): ToolResultRef | null {
  if (!isRecord(message) || message.role !== "toolResult") return null;
  if (typeof message.toolName !== "string") return null;
  const text = Array.isArray(message.content)
    ? message.content
        .filter((part): part is { text: string } => isRecord(part) && typeof part.text === "string")
        .map((part) => part.text)
        .join("")
    : "";
  return {
    toolCallId: typeof message.toolCallId === "string" ? message.toolCallId : "",
    toolName: message.toolName,
    isError: message.isError === true,
    text,
  };
}

/** Topic count from the last successful `list_roadmap_topics` result of this build. */
function topicTotal(results: readonly ToolResultRef[]): number | undefined {
  for (let index = results.length - 1; index >= 0; index -= 1) {
    const result = results[index]!;
    if (result.toolName !== "list_roadmap_topics" || result.isError) continue;
    const parsed = parseJson(result.text);
    if (isRecord(parsed) && Array.isArray(parsed.topics)) return parsed.topics.length;
  }
  return undefined;
}

/**
 * One view per step for the current build: the messages since the learner's last
 * message, plus the streamed partial. `running` is whether the Architect is busy.
 */
export function architectSteps(
  messages: readonly unknown[],
  partial: unknown,
  running: boolean,
): ArchitectStepView[] {
  let start = 0;
  messages.forEach((message, index) => {
    if (isRecord(message) && message.role === "user") start = index + 1;
  });
  const current = messages.slice(start);

  const calls: ToolCallRef[] = [];
  const results: ToolResultRef[] = [];
  for (const message of current) {
    calls.push(...toolCallsOf(message));
    const result = resultOf(message);
    if (result) results.push(result);
  }
  calls.push(...toolCallsOf(partial));

  const answered = new Set(results.map((result) => result.toolCallId));
  const pendingCalls = calls.filter((call) => !answered.has(call.id));
  const activeCall = pendingCalls.length > 0 ? pendingCalls[pendingCalls.length - 1]! : null;
  const activeStep = activeCall ? stepForTool(activeCall.name) : null;

  const indexOf = (step: ArchitectStep): number => ARCHITECT_STEPS.indexOf(step);
  let reached = -1;
  for (const call of calls) {
    const step = stepForTool(call.name);
    if (step) reached = Math.max(reached, indexOf(step));
  }
  const saveDone = results.some((result) => result.toolName.startsWith("save_learning_path") && !result.isError);

  // The step the Architect is on right now: a tool in flight, otherwise the model
  // itself (Read graph before any tool, Draft between tools, nothing once saved).
  let runningIndex: number | null = null;
  if (running) {
    if (activeStep) runningIndex = indexOf(activeStep);
    else if (reached < 0) runningIndex = 0;
    else if (!saveDone) runningIndex = Math.max(reached, indexOf("draft"));
  }
  // Every step up to the furthest one reached counts as done, even if it was skipped.
  const frontier = Math.max(reached, runningIndex ?? -1);

  const total = topicTotal(results);
  const doneSlugs = new Set<string>();
  for (const result of results) {
    if (result.isError) continue;
    if (result.toolName !== "list_roadmap_topics" && result.toolName !== "read_roadmap_topic" && result.toolName !== "read_roadmap_topics") continue;
    for (const slug of readTopicSlugs(result)) doneSlugs.add(slug);
  }
  const topicsDone = doneSlugs.size;

  return ARCHITECT_STEPS.map((step, index) => {
    const state: ArchitectStepState =
      index === runningIndex ? "running" : index <= frontier ? "done" : "pending";
    if (step === "readTopics" && (topicsDone > 0 || total !== undefined)) {
      return { step, state, count: { done: topicsDone, ...(total === undefined ? {} : { total }) } };
    }
    return { step, state };
  });
}
