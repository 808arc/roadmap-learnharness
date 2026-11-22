/** Read-only roadmap gap tool for linked teaching sessions (issue #11).
 *
 * Registers `roadmap_gaps` through the host's registerTools/registerInstructions. The tool is
 * present only in teacher turns of a chat linked to a node. Its handler calls readNodeGaps and
 * writes nothing. The data (the linked path and the learner's mastery) comes from the backend.
 */
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { PluginBackendContext, PluginTools } from "learnharness-plugin-api";
import { readNodeGaps } from "./agent-gaps.ts";

export const GAPS_TOOL_NAME = "roadmap_gaps";

export const GAPS_INSTRUCTIONS = [
  "# Roadmap gap check",
  "This applies only when the tool roadmap_gaps is in your current tool set; otherwise ignore this section.",
  "Call roadmap_gaps before teaching a linked node to see which prerequisite nodes the learner has not seen or practised yet, then review the most severe ones first.",
  "Treat the result as read-only data: it does not change progress or the path, and do not invent gaps that are not in it.",
].join("\n");

/** The backend's view of linked chats: whether a chat is linked, and the input for a read. */
export interface LinkedGapsSource {
  /** True when the chat is linked to a node. Throws when the store cannot be read. */
  linked(chatId: string): boolean;
  /** The linked path and the learner's mastery. Throws when the read fails. */
  input(chatId: string): unknown;
}

const errorResult = (message: string): AgentToolResult<{ isError: true; error: string }> => ({
  content: [{ type: "text", text: `Error: ${message}` }],
  details: { isError: true, error: message },
  isError: true,
});

function gapsTool(source: LinkedGapsSource, chatId: string): AgentTool {
  return {
    name: GAPS_TOOL_NAME,
    label: "Roadmap gaps",
    description:
      "Read the prerequisite gaps of this session's roadmap: nodes the learner has not seen or practised yet that " +
      "block a node, most severe first. Read-only; takes no arguments.",
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
    execute: async () => {
      let result: ReturnType<typeof readNodeGaps>;
      try {
        result = readNodeGaps(source.input(chatId));
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error));
      }
      if (result.isError) return errorResult(result.error);
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
    },
  };
}

/** Register the teaching instruction and the per-turn gap tool for linked teacher chats. */
export function registerAgentGaps(ctx: PluginBackendContext, source: LinkedGapsSource): () => void {
  const unregisterInstructions = ctx.registerInstructions({ agents: ["teacher"], text: GAPS_INSTRUCTIONS });
  const contribution: PluginTools = {
    agents: ["teacher"],
    create: (context) => {
      try {
        if (!source.linked(context.chatId)) return [];
      } catch {
        // An unreadable store keeps the tool, so its call reports the failure instead of hiding it.
      }
      return [gapsTool(source, context.chatId)];
    },
  };
  const unregisterTools = ctx.registerTools(contribution);
  return () => {
    unregisterInstructions();
    unregisterTools();
  };
}
