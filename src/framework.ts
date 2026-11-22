/** Learning Path — pedagogical prompt builders.
 *
 * Two composers, both derived from FRAMEWORK.md and free of any pacing
 * language by design (FRAMEWORK.md principle 7):
 * - `buildArchitectSystemPrompt` drives the Path Architect that designs paths.
 * - `buildChildSessionBrief` seeds a linked teaching/practice session with the
 *   node's anchor, priming hook, interleaving callbacks, watchpoints and artifact.
 */
import {
  ARTIFACT_CATALOG,
  DomainValidationError,
  NODE_TYPES,
  artifactCatalogEntry,
  defaultArtifactFor,
  formatSourceAnchor,
} from "./domain.ts";
import { UPSTREAM_REPOSITORY } from "./upstream-roadmaps.ts";
import type {
  ArtifactConfig,
  ChildSessionKind,
  ErrorEntry,
  LearningPath,
  NodeType,
  PathNode,
  PluginSettings,
  SourceSpine,
} from "./domain.ts";

export interface NodeTypeGuide {
  readonly type: NodeType;
  readonly label: string;
  readonly guidance: string;
}

export const NODE_TYPE_GUIDE: readonly NodeTypeGuide[] = [
  {
    type: "holistic",
    label: "Holistic",
    guidance: "system-level links between ideas; why the domain splits this way; how pieces flow.",
  },
  {
    type: "concept",
    label: "Isolated concept",
    guidance: "one load-bearing principle, theorem, model or mechanism; obviously true from first principles first.",
  },
  {
    type: "contrast",
    label: "Contrast",
    guidance: "boundary discrimination between confusable ideas; exact separating conditions; non-examples exposing the boundary.",
  },
  {
    type: "skill",
    label: "Skill",
    guidance: "brief procedural fluency: idioms, heuristics, notation moves, shortcuts that free working memory.",
  },
  {
    type: "checkpoint",
    label: "Integrative checkpoint",
    guidance: "multi-topic synthesis, unlabelled problems; learner picks tools without a heading naming them.",
  },
  {
    type: "bridge",
    label: "Bridge",
    guidance: "surgical, bounded repair of one missing upstream prerequisite; back to main spine once closed.",
  },
];

const nodeGuide = (type: NodeType): NodeTypeGuide => {
  const guide = NODE_TYPE_GUIDE.find((candidate) => candidate.type === type);
  if (!guide) throw new Error(`Unknown node type: ${String(type)}`);
  return guide;
};

/** Type-specific loose micro-priming hook for a child session. Never a gate. */
export function microPrimingHookFor(type: NodeType): string {
  switch (type) {
    case "holistic":
      return "Default way in (no question format set): before definitions, learner predicts how main pieces connect; compare their sketch with your structure.";
    case "concept":
      return "Default way in (no question format set): one concrete phenomenon or tiny case where the naive account breaks; elicit intuition before formal definition.";
    case "contrast":
      return "Default way in (no question format set): two near-identical scenarios differing only at the boundary; learner says which principle applies before either is named.";
    case "skill":
      return "Default way in (no question format set): worked miniature; learner predicts next mechanical step before executing it.";
    case "checkpoint":
      return "Default way in (no question format set): one unlabelled mixed problem; learner chooses a strategy before solving.";
    case "bridge":
      return "Default way in (no question format set): recall exact missing upstream step; learner reconstructs it in one line, then repair only that step.";
  }
}

/** "OSTEP (textbook)" / "uploaded: linear-algebra-notes.md" — the spine in one line. */
export function formatSourceSpine(spine: SourceSpine): string {
  if (spine.mode === "canonical") {
    return spine.references.map((reference) => `${reference.title} (${reference.kind})`).join("; ");
  }
  return spine.sources.map((source) => `${source.name} (uploaded source ${source.sourceId})`).join("; ");
}

const artifactCatalogLines = (): string =>
  ARTIFACT_CATALOG.map(
    (entry) => `- ${entry.label} (${entry.type}), best for ${entry.bestFor.join(", ")}. Why: ${entry.justification}`,
  ).join("\n");

const settingsLines = (settings: PluginSettings | null): string => {
  const entries = Object.entries(settings?.artifactDefaults ?? {});
  if (entries.length === 0) return "No plugin-wide artifact defaults: catalog recommendation applies.";
  return `Plugin-wide artifact defaults: ${entries
    .map(([type, artifact]) => `${type} → ${artifact}`)
    .join(", ")}. A node override always wins.`;
};

const refinementLines = (path: LearningPath): string => {
  const nodes = path.modules.flatMap((module) => module.nodes);
  const present = NODE_TYPES.filter((type) => nodes.some((node) => node.type === type));
  return [
    "## Refinement mode",
    `Refining "${path.title}" (id ${path.id}).`,
    `Learner's goal: ${path.goal}`,
    `Shape: ${path.modules.length} module(s), ${nodes.length} node(s); types present: ${
      present.length === 0 ? "none yet" : present.join(", ")
    }.`,
    "get_learning_path for current ids before saving. Keep existing ids, titles and source anchors stable unless the learner asks for a change or the source demands a correction.",
    "Refinement is additive and explicit: never silently reorder, delete or rename existing nodes.",
  ].join("\n");
};

export interface ArchitectPromptOptions {
  /** Include refinement instructions and a summary of the path being edited. */
  readonly existingPath?: LearningPath | null;
  /** Plugin artifact defaults, if settings have already been read. */
  readonly settings?: PluginSettings | null;
  /** Names of the research tools this Architect has (empty: offline). */
  readonly researchTools?: readonly string[];
  /** Upstream mode (#19): sources are the learner's graph and the developer-roadmap topic files only. */
  readonly upstream?: boolean;
}
/** Roadmap-author method (approved by the owner, 2026-11-17). Sources: Matt Warden's
 * learning-plan-creator (sequencing, verification, gaps), the roadmap.sh contribution
 * rules (one-paragraph nodes, typed resources, relevance over size) and
 * learn-anything-roadmap (skip list). */
const AUTHOR_METHOD = [
  "## Roadmap author method",
  "Learner can't judge sequencing yet; you know the graph. Wrong order worse than one good book.",
  "1. Interview: 2–3 questions per message, only what you can't infer: end ability, level, adjacent skills, constraints (language, budget, tools). Skip if message answers.",
  "2. Research first (see Research): canonical resources, then deeper strong ones.",
  "3. Dependencies per topic: what comes first. Terms before use. Solid foundations over fast, brittle start.",
  "4. Route: reaches goal. Before saving: each goal ability taught by a node; last module produces goal (final project, real task, exam-level set).",
  "5. Node: one concrete ability; goal = one paragraph a beginner gets; 2–4 outcomes; 3–8 resources, canonical first. `use` = serving parts + what to skip. Must-know: essential: true.",
  "6. Books: the field's most recommended books, even if you can't read them; lesser-known strong ones for depth. Popularity alone is no reason; say why it's here.",
  "7. Skip list: what learner can safely skip for goal (rabbit holes, outdated tools), in goal or a final optional node.",
  "8. Trace before saving, node by node: rests on earlier nodes? Unexplained term or gap? Fix order, or state gap and how to close it in node goal.",
].join("\n");

const DOSSIER_LINES = [
  "## Building from a diagnostic dossier",
  "Named (research note, origin \"diagnostic\"): read fully first: read_research_note.",
  "- Do not ask again for anything the dossier already answers (goal, level, background, preferences, constraints). Skip the interview for those.",
  "- Mastered → optional: true, or short review node. Never teach from scratch.",
  "- Gaps: bridge nodes for every prerequisite gap, before dependents.",
  "- Misconceptions: contrast node for each misconception (bridge if category prerequisite_gap), where the wrong idea would be reinforced.",
  "- Open questions: ONE message, only if answers change path; else build and state assumption.",
  "- Constraints (e.g. available time) scale depth and size only. Never dates or pacing.",
  "- Don't link the dossier's source chat. Sessions link only when launched from a node.",
].join("\n");

/** Issue #41: roadmap structure only from the two upstream tools; no repo path from memory in any research question. */
const REPO_RULE =
  "Roadmap structure comes only from list_roadmap_topics and read_roadmap_topic. Never write a repo URL or path from memory. " +
  "A research question may name a repo only if a tool result in this conversation gave that name.";
/** Outside upstream mode the source is named here, since the Sources section does not name it. */
const UPSTREAM_SOURCE_RULE = `- Upstream source: ${UPSTREAM_REPOSITORY}, the only one. ${REPO_RULE}`;

/** Upstream mode (#19): the only sources are the learner's graph and the roadmap.sh topic files. */
const UPSTREAM_SOURCE_LINES = [
  "## Sources (upstream mode)",
  `Order: learner's Knowledge Graph → topic files of ${UPSTREAM_REPOSITORY} (roadmap.sh), only upstream source. Books and web second, only to enrich existing nodes.`,
  "- read_learner_graph first. Known topics → optional review nodes, per graph brief.",
  "- list_roadmap_topics(roadmapSlug), then read_roadmap_topic per topic used. Only slugs these tools return.",
  `- ${REPO_RULE}`,
  "- Books and web never create topics, nodes or roadmap structure. GitHub unreachable: say so, stop; never substitute a source for structure.",
  "- Node resources = tagged resources of its topic file, copied exactly (link text, url, tag). Never reword, shorten or invent. url only from a topic read in this conversation.",
  `- sourceSpine: mode "canonical", reference "roadmap.sh developer roadmap (${UPSTREAM_REPOSITORY})", kind "course"; sourceAnchor reference = topic title.`,
  "- Resource not in topic file: don't add. No tagged resources: node has none.",
].join("\n");

const researchLines = (tools: readonly string[], upstream = false): string => {
  const has = (name: string): boolean => tools.includes(name);
  const lines = [upstream ? "## Research (second: enrichment only)" : "## Research"];
  const web = has("web_search") || has("find_books") || has("read_page");
  if (!web && !has("list_research_notes")) {
    // Upstream mode without research tools: the structure stands on the graph and topic files alone.
    if (upstream) return "";
    lines.push("Offline: no research tools in this setup. Own knowledge only; say so once; never invent links, chapters or editions.");
    lines.push(UPSTREAM_SOURCE_RULE);
    return lines.join("\n");
  }
  lines.push(upstream
    ? "After graph and topic files: research only to enrich existing nodes (resources, context). Cite only links these tools returned; never invent one."
    : "Before drafting a new path, and when learner asks for sources. Use only the sources this setup allows (your tools). Don't cite from memory what you could check.");
  // Upstream mode states the rule once, in its Sources section.
  if (!upstream) lines.push(UPSTREAM_SOURCE_RULE);
  if (has("list_research_notes")) lines.push("- list_research_notes first. Read relevant reports fully: read_research_note.");
  if (has("find_books")) lines.push("- find_books: canonical first (\"<field> textbook\", \"<field> introduction\", subtopics, learner's language), then deeper. Compare editions, ratings. book_contents on every book in path.");
  if (has("find_papers")) lines.push("- find_papers: surveys, tutorials, classic papers. search_wikipedia: field map, classic references.");
  if (has("web_search")) lines.push("- web_search, many angles: best books, course syllabus, roadmap, lecture notes, practitioner forums; learner's language and English.");
  if (has("read_page")) lines.push("- read_page: look inside sources relied on (syllabus, contents, chapter list, review). Skim, never whole books. checked: true only where you looked inside.");
  if (has("deep_research")) lines.push("- deep_research: slow, costly (10–30 min). Only when learner turns deep research on; once per path; complete brief (goal, level, language, what to find).");
  lines.push("- Budget: 10–25 research calls per new path; with deep research 30–60.");
  lines.push("- Say what you checked and what you could not verify.");
  return lines.join("\n");
};

/** The Path Architect system prompt: grounding, taxonomy, pedagogy and hard exclusions. */
export function buildArchitectSystemPrompt(options: ArchitectPromptOptions = {}): string {
  const { existingPath = null, settings = null, researchTools = [], upstream = false } = options;
  const sections = [
    [
      "Roadmap Architect, LearnHarness (Roadmap plugin: path drawn as a roadmap.sh-style map).",
      "Goal → stable, legible path. Refine when asked.",
      "Design structure only. Teaching, practice, diagnostics, artifacts: child sessions launched from nodes.",
    ].join("\n"),

    upstream ? UPSTREAM_SOURCE_LINES : [
      "## Source grounding",
      "Do not require the learner to supply a reference. Uploaded source: use it, even unnamed. Else pick 1–2 reputable primary textbooks, courses or specs you know well; tell learner which. Never block path creation to ask.",
      "Call list_uploaded_sources at the start of a new path. None, none named: own choice.",
      "Spine: one mode per path.",
      '- "canonical": learner-given or chosen refs. title + kind ("textbook", "course" or "specification"). author, edition only when known.',
      '- "uploaded": learner corpus. Real sourceIds from list_uploaded_sources. Before drafting: read contents/table of contents, chapter headings, brief intros, in bounded chunks; combine with subject knowledge. Do not read the whole book; no full chapter text. Align nodes to real chapters. Deeper reads only to clarify an ambiguous heading. Canonical supplements only for real gaps.',
      "- Every node: sourceAnchor = reference, plus chapter/section only when verified, at source granularity. Unverified: reference + topic, never an invented location.",
      "- Never invent chapter numbers, page ranges, authors or editions. Canonical from memory: no exact locations unless confident; offer refinement when a contents list exists.",
      "- Notation consistent with spine. No competing notations in one module without a contrast node.",
    ].join("\n"),

    [
      "## Node types",
      ...NODE_TYPE_GUIDE.map((guide) => `- ${guide.label} (${guide.type}): ${guide.guidance}`),
    ].join("\n"),

    [
      "## Proactive placement of holistic and contrast nodes",
      "Holistic and contrast nodes: baseline path structure, not repairs. Place while designing, before any learner failure.",
      "- Holistic: start of each module or layer (macro-schema linking parts).",
      "- Contrast: ideas sharing surface features that trigger false pattern-matching; notation or boundary conditions diverging.",
      "- Never defer a holistic or contrast node until the learner reports confusion.",
    ].join("\n"),

    [
      "## Roadmap quality (roadmap.sh standard)",
      "- Start from the end: goal states the ability wanted at the end.",
      "- Most important ~20% first. Useful-but-unneeded → optional: true. Never mark optional just to shorten path.",
      "- Node = one concrete ability; 2–4 outcomes completing \"After this node I can …\" (e.g. \"Explain what a pointer stores\").",
      "- Practice in applied form: code, speaking and writing, solved problems.",
      "- 3–8 resources {title, kind, url?, free?, use?, essential?, checked?}; kind: book|article|video|course|docs|exercises|paper. url only if seen in research or sure it exists; never invent links.",
      "- Interchangeable choices (GCC, Clang): same alternativeGroup string.",
      "- Checkpoint node: consolidates a module. Task applying it + question linking neighbouring nodes. Not a recall quiz.",
    ].join("\n"),

    AUTHOR_METHOD,
    DOSSIER_LINES,
    researchLines(researchTools, upstream),

    [
      "## Ungated progression",
      "States: unstarted, in_progress, consolidated, skipped. Only the learner sets skipped.",
      "No gate, no priming state: any node, any time. Never lock, hide or require one node before another.",
      "Never consolidate a node automatically, including a node that matches the learner's graph. A node is consolidated only when the learner can reconstruct the idea and, if configured, completed its artifact with no unresolved blocking misconception.",
    ].join("\n"),

    [
      "## Self-directed light pre-reading instead of macro-priming chats",
      "- Each module or dense node: one short lightPreReading pointer (chapter intro, summary, overview, first section; no proofs).",
      "- Do not create separate macro-priming conversations. No priming as precondition. Optional.",
    ].join("\n"),

    [
      "## Three levels of interleaving",
      "- Micro: inside node. Vary structure, edge cases, non-examples. Never one template repeated.",
      "- Meso: alternate types (holistic, concept, skill, contrast). interleavesNodeIds: earlier ids (typically N-1, N-2), so examples and artifacts recall them.",
      "- Macro: integrative checkpoints across modules; revisit foundations deeper later.",
      "interleavesNodeIds: existing ids in this path, never the node itself.",
    ].join("\n"),

    [
      "## Generative artifacts",
      "Force generation, structure, precision; guard against illusion of competence. Justifications:",
      artifactCatalogLines(),
      "artifactConfig: on nodes needing a specific artifact; reason goes in its instructions. No override: path artifactDefault, then plugin default.",
      'type "none" when conversation alone fits. Never choose an artifact silently or without reason.',
      settingsLines(settings),
    ].join("\n"),

    [
      "## Diagnostics and advisory adaptation",
      "- Log friction by root cause: misconception, discrimination_error, prerequisite_gap, procedural_slip, cue_failure. No numeric grades.",
      "- Unresolved errors → watchpoints in interleaved sessions.",
      "- Only when a topic genuinely is not sticking, for a diagnosed reason: advisory pivot suggestion: bridge (missing prerequisite), contrast (persistent boundary confusion), skill (mechanical bottleneck), holistic (missing macro-schema).",
      "- Pivots start pending. Never rewrite, reorder or delete the path yourself; learner accepts, refines or dismisses.",
    ].join("\n"),

    [
      "## Hard exclusions (non-negotiable)",
      "- Never prescribe fixed study allotments, recurring slots, countdown pressure, completion targets or gamified pressure.",
      "- Never attach pacing metadata to path, module or node. Order only by conceptual dependency.",
      "- Never imply the learner is behind or must catch up.",
      "Speed is nonlinear: path = dependency map, not plan of dates.",
    ].join("\n"),

    [
      "## Output contract",
      "save_learning_path: title, goal, sourceSpine, modules. Module: title, nodes. Node: type, title, goal, sourceAnchor OBJECT (reference; optional chapter, section, pages).",
      "New path: omit ids (except draft ids), timestamps, progression, interleavesNodeIds, childSessions, errors, pivotSuggestions. Server fills them, incl. links to preceding nodes. e.g. {\"type\":\"concept\",\"title\":\"Hash functions\",\"goal\":\"Explain why hashes appear irregular\",\"sourceAnchor\":{\"reference\":\"The Book of Shaders\",\"chapter\":\"Random\"},\"prerequisites\":[]}",
      "Refinement: get_learning_path first; save full outline with every existing id. Server always keeps learner state. Never invent ids for existing nodes.",
      "Prerequisites: required on every new node. Ids needed first, same draft; [] = starts a branch. New node: id \"draft:<name>\" (e.g. \"draft:hashing\"), only for prerequisites in this draft; server replaces it. Only from graph chains or topic files; never invent.",
      "Several nodes: prefer save_learning_path_json, whole draft as one JSON string in draftJson. Small: save_learning_path. Nested modules as string or parse fails: save_learning_path_json. Never retry XML/DSML tags. Never print tool-call tags or JSON code blocks in chat. Validation fails: fix named field, retry.",
    ].join("\n"),
  ];

  const language = settings?.contentLanguage ?? "auto";
  sections.push(
    language === "auto"
      ? "## Language\nLearner-facing fields (titles, goals, outcomes, pre-reading, resource titles you describe): learner's language. Book and course titles as published."
      : `## Language\nLearner-facing fields (titles, goals, outcomes, pre-reading): ${language === "ru" ? "Russian" : "English"}, whatever learner writes. Book and course titles as published.`,
  );
  if (existingPath) sections.push(refinementLines(existingPath));
  return sections.filter(Boolean).join("\n\n");
}

/** Resolve the artifact a child session should prompt for, in override order. */
export function resolveNodeArtifact(
  path: LearningPath,
  node: PathNode,
  settings: PluginSettings | null = null,
): ArtifactConfig {
  if (node.artifactConfig) return node.artifactConfig;
  if (path.artifactDefault) return { type: path.artifactDefault };
  const fromSettings = settings?.artifactDefaults[node.type];
  if (fromSettings) return { type: fromSettings };
  return { type: defaultArtifactFor(node.type) };
}

export interface ErrorWatchpoint {
  readonly nodeId: string;
  readonly nodeTitle: string;
  readonly entry: ErrorEntry;
}

export interface ChildSessionBriefInput {
  readonly path: LearningPath;
  readonly nodeId: string;
  readonly kind: ChildSessionKind;
  readonly settings?: PluginSettings | null;
  /** Optional override for the loose priming hook; a loose suggestion either way. */
  readonly primingHook?: string;
}

export interface ChildSessionBrief {
  readonly text: string;
  readonly node: PathNode;
  readonly artifact: ArtifactConfig;
  readonly interleavedNodes: readonly PathNode[];
  readonly watchpoints: readonly ErrorWatchpoint[];
}

const WATCHPOINT_LIMIT = 8;

/** Unresolved errors that follow a node: its own, its interleaved predecessors',
 * then the nearest upstream nodes. The limit keeps a child brief bounded. */
export function collectErrorWatchpoints(
  path: LearningPath,
  nodeId: string,
  limit: number = WATCHPOINT_LIMIT,
): readonly ErrorWatchpoint[] {
  if (limit <= 0) return [];
  const ordered = path.modules.flatMap((module) => module.nodes);
  const node = ordered.find((candidate) => candidate.id === nodeId);
  if (!node) {
    throw new DomainValidationError([{ path: "nodeId", message: `unknown node id "${nodeId}"` }]);
  }
  const index = ordered.indexOf(node);
  const upstream = ordered.slice(0, index);
  const interleavedNodes = node.interleavesNodeIds
    .map((id) => ordered.find((candidate) => candidate.id === id))
    .filter((candidate): candidate is PathNode => candidate !== undefined);

  const seenNodes = new Set<string>();
  const watchSources: PathNode[] = [];
  for (const candidate of [node, ...interleavedNodes, ...[...upstream].reverse()]) {
    if (seenNodes.has(candidate.id)) continue;
    seenNodes.add(candidate.id);
    watchSources.push(candidate);
  }
  const watchpoints: ErrorWatchpoint[] = [];
  for (const source of watchSources) {
    for (const entry of source.errors) {
      if (entry.resolved) continue;
      watchpoints.push({ nodeId: source.id, nodeTitle: source.title, entry });
      if (watchpoints.length === limit) return watchpoints;
    }
  }
  return watchpoints;
}

/**
 * Rederive (rederive-lh) runs in the same native teaching sessions. These sentences keep
 * the roadmap text from contradicting its flow; native-bridge.ts reuses them.
 */
export const REDERIVE_DEFERRAL =
  "Rederive (rederive-lh) may share this session. While one of its problems is active (its rederive_* tools are in your tool set and a problem is open), its flow comes first: it decides who poses the next question, the question form (its cards and ask_user_question, one question per message) and when a problem ends. Do not pose a micro-priming question or a roadmap check in plain text in its place, and do not show a worked solution; the hook and any interleaved example wait until that problem is logged or skipped. A Rederive problem about the learner's own repo is not off-anchor: the anchor still names this node's topic.";

export const REDERIVE_PROGRESS_SENTENCE =
  "Whatever Rederive's flow ends with, still call roadmap_update_progress as understanding consolidates and roadmap_log_error for each diagnosed root cause before the session ends; Rederive's log tools do not replace them.";

export const ROADMAP_SAFETY_SENTENCE =
  "These roadmap rules hold alongside Rederive: do not give answers away, do not grade the learner (Rederive's own graded cards are not roadmap scores), log errors by root cause only, and never restructure the path.";

/** Compose the brief for a child teaching/practice session linked to one node. */
export function buildChildSessionBrief(input: ChildSessionBriefInput): ChildSessionBrief {
  const { path, nodeId, kind } = input;
  const ordered = path.modules.flatMap((module) => module.nodes);
  const node = ordered.find((candidate) => candidate.id === nodeId);
  if (!node) {
    throw new DomainValidationError([{ path: "nodeId", message: `unknown node id "${nodeId}"` }]);
  }
  const index = ordered.indexOf(node);
  const upstream = ordered.slice(0, index);
  const interleavedNodes = node.interleavesNodeIds
    .map((id) => ordered.find((candidate) => candidate.id === id))
    .filter((candidate): candidate is PathNode => candidate !== undefined);

  const watchpoints = collectErrorWatchpoints(path, nodeId);

  const artifact = resolveNodeArtifact(path, node, input.settings ?? null);
  const catalog = artifactCatalogEntry(artifact.type);
  const anchor = formatSourceAnchor(node.sourceAnchor);
  const guide = nodeGuide(node.type);

  const interleavingLines =
    interleavedNodes.length === 0
      ? ["No earlier node is linked yet: vary examples inside this session and connect back to the module's holistic node when one exists."]
      : interleavedNodes.map(
          (earlier) =>
            `- ${earlier.title} (${earlier.type}): re-surface it briefly, inside an example, question or task where the format allows; no heading naming which idea applies.`,
        );

  const watchpointLines =
    watchpoints.length === 0
      ? ["No unresolved error is on record. Probe for gaps anyway; log what you find with the roadmap tools."]
      : watchpoints.map(
          (watchpoint) =>
            `- [${watchpoint.entry.category}] ${watchpoint.entry.summary} (from "${watchpoint.nodeTitle}", still unresolved): verify quietly whether the repair held.`,
        );

  const artifactLines = [
    `Recommended: ${catalog.label} (${catalog.type}).`,
    `Why: ${catalog.justification}`,
    ...(artifact.instructions === undefined
      ? []
      : [`Node-specific framing: ${artifact.instructions}`]),
    'Respect "none" if the learner prefers conversation-only; never present the artifact as a gate.',
  ];

  const text = [
    "# Roadmap child session brief",
    `You are opening a ${kind} session for one node of the learner's learning path "${path.title}".`,
    `Path goal: ${path.goal}`,
    "",
    "## Node",
    `${node.title} (${node.type}: ${guide.label})`,
    `Goal: ${node.goal}`,
    ...(node.codeRepo
      ? [`Code repository for this node: "${node.codeRepo.location}" (roadmap only names it; it does not read the repo).`]
      : []),
    `Progression: ${node.progression} (learner-controlled; there is no gate and no priming requirement).`,
    ...(node.outcomes?.length
      ? ["After this node the learner should be able to:", ...node.outcomes.map((outcome) => `- ${outcome}`), "Aim at these abilities; check them in applied form where the format allows."]
      : []),
    "",
    "## Source anchor",
    `Spine: ${formatSourceSpine(path.sourceSpine)}`,
    `Anchor: ${anchor}`,
    "Stay inside this anchor and this spine's notation; no substitute curriculum.",
    "",
    "## Light pre-reading (self-directed, optional)",
    node.lightPreReading ??
      "No pre-reading pointer is set for this node. If orientation helps, suggest one short self-directed skim; never a requirement.",
    "",
    "## Loose micro-priming (recommended, never a gate)",
    "Question format (count, type, answer form) is not set here. If the learner or a session plugin set one, it governs how questions are posed; the hook below is only a default for when none is set.",
    input.primingHook ?? microPrimingHookFor(node.type),
    "One possible hook: offer it once, accept a skip immediately, move on to the node's goal.",
    REDERIVE_DEFERRAL,
    "",
    "## Meso-interleaving callbacks",
    ...interleavingLines,
    "Keep micro-interleaving inside this session: mix edge cases, non-examples and variations.",
    "",
    "## Active error watchpoints",
    ...watchpointLines,
    "",
    "## Generative artifact",
    ...artifactLines,
    "",
    "## Reporting back",
    "roadmap_update_progress as understanding consolidates; roadmap_log_error per diagnosed root cause; roadmap_suggest_pivot only when a topic is not sticking, for a specific reason.",
    REDERIVE_PROGRESS_SENTENCE,
    ROADMAP_SAFETY_SENTENCE,
    "Never restructure the path yourself; the learner decides.",
  ].join("\n");

  return { text, node, artifact, interleavedNodes, watchpoints };
}
