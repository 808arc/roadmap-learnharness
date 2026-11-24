/** Research through a normal LearnHarness session.
 *
 * The teacher already has web research with the app's own search engine and
 * key (its researcher sub-agent). Roadmap opens a teaching chat with a research
 * brief, remembers that chat, and gives that chat alone one extra tool —
 * `roadmap_submit_research` — which saves the report as a research note for the
 * Architect. The key never reaches the plugin.
 */
import fs from "node:fs";
import path from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { PluginBackendContext, PluginTools } from "learnharness-plugin-api";
import type { ResearchNotes } from "./notes.ts";

export interface ResearchChat {
  readonly chatId: string;
  readonly topic: string;
  readonly createdAt: string;
  readonly noteIds: readonly string[];
}

export interface ResearchChats {
  list(): ResearchChat[];
  get(chatId: string): ResearchChat | null;
  add(chatId: string, topic: string): ResearchChat;
  attachNote(chatId: string, noteId: string): void;
}

export function createResearchChats(dataDirectory: string): ResearchChats {
  const file = path.join(dataDirectory, "research-chats.json");
  const load = (): ResearchChat[] => {
    try {
      const value = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
      return Array.isArray(value) ? (value as ResearchChat[]).filter((entry) => typeof entry?.chatId === "string") : [];
    } catch {
      return [];
    }
  };
  const save = (value: ResearchChat[]): void => {
    fs.mkdirSync(dataDirectory, { recursive: true });
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 2));
    fs.renameSync(`${file}.tmp`, file);
  };
  return {
    list: load,
    get: (chatId) => load().find((entry) => entry.chatId === chatId) ?? null,
    add(chatId, topic) {
      const entry: ResearchChat = { chatId, topic: topic.slice(0, 500), createdAt: new Date().toISOString(), noteIds: [] };
      save([...load().filter((item) => item.chatId !== chatId), entry]);
      return entry;
    },
    attachNote(chatId, noteId) {
      save(load().map((entry) => (entry.chatId === chatId ? { ...entry, noteIds: [...entry.noteIds, noteId] } : entry)));
    },
  };
}

export function researchBrief(topic: string, details: string): string {
  return [
    `This is a research session for a Roadmap learning path. Topic: ${topic}.`,
    details ? `Learner's goal and context: ${details}` : "",
    "",
    "Research brief (do this yourself, do not ask the learner to do it):",
    "1. Dispatch several web research jobs from different angles: the field map and prerequisites; the most recommended books and courses " +
      "(\"best books for…\", university syllabi, curated lists, practitioner forums); deeper strong but less popular sources " +
      "(lecture notes, university courses, papers, books in other languages); how practitioners say to practise; what to skip.",
    "2. Make the researcher READ the sources it relies on: tables of contents, syllabi, chapter lists — not just titles.",
    "3. When the jobs return, call roadmap_submit_research with one Markdown report: field map in teaching order with prerequisites; " +
      "canonical resources with why they are recommended; deeper resources; per resource the chapters/modules for each subarea; " +
      "practice; what to skip; links for every claim; what could not be verified.",
    "4. Then tell the learner briefly that the report is in Roadmap and they can ask the Architect to build or refine the path.",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

const INSTRUCTIONS =
  "Roadmap research sessions: when the tool roadmap_submit_research is available in this chat, this chat is a research session " +
  "for the Roadmap plugin. Follow the research brief in the first message, use your web research, and finish by calling " +
  "roadmap_submit_research with the full report. Without that tool, ignore this note.";

export function registerResearchSessions(
  ctx: PluginBackendContext,
  options: { chats: ResearchChats; notes: ResearchNotes; enabled: () => boolean; onNote: (noteId: string, chatId: string) => void },
): () => void {
  const unregisterInstructions = ctx.registerInstructions({ agents: ["teacher"], text: INSTRUCTIONS });
  const contribution: PluginTools = {
    agents: ["teacher"],
    create: (context) => {
      if (!options.enabled()) return [];
      const chat = options.chats.get(context.chatId);
      if (!chat) return [];
      const tool: AgentTool = {
        name: "roadmap_submit_research",
        label: "roadmap_submit_research",
        description:
          "Save the research report for the Roadmap Architect (Markdown, with links). Call it once the research is complete; " +
          "calling again adds another note.",
        parameters: {
          type: "object",
          properties: { title: { type: "string" }, report: { type: "string" } },
          required: ["title", "report"],
          additionalProperties: false,
        } as never,
        execute: async (_id, params) => {
          const value = (params ?? {}) as { title?: unknown; report?: unknown };
          const report = typeof value.report === "string" ? value.report.trim() : "";
          if (report.length < 200) {
            return { content: [{ type: "text", text: "Error: the report is too short; submit the full research report." }], details: {}, isError: true } as never;
          }
          const note = options.notes.add({
            title: typeof value.title === "string" && value.title.trim() ? value.title : chat.topic,
            origin: "session",
            body: report,
            chatId: context.chatId,
          });
          options.chats.attachNote(context.chatId, note.id);
          options.onNote(note.id, context.chatId);
          return { content: [{ type: "text", text: `Saved as research note ${note.id}. The Roadmap Architect can read it now.` }], details: { noteId: note.id } };
        },
      };
      return [tool];
    },
  };
  const unregisterTools = ctx.registerTools(contribution);
  return () => {
    unregisterInstructions();
    unregisterTools();
  };
}
