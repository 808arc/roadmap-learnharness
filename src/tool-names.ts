/** Native tool names shared by the backend bridge and the frontend renderers.
 *
 * Pure runtime constants only: both bundles import this module, so it must not
 * touch Node built-ins, the store or browser globals.
 */
export const LEARNING_PATH_TOOL_NAMES = [
  "roadmap_get_brief",
  "roadmap_update_progress",
  "roadmap_log_error",
  "roadmap_suggest_pivot",
] as const;

/** Pivots proposed from a child session are limited to surgical repairs. */
export const CHILD_PIVOT_TYPES = ["bridge", "contrast", "skill"] as const;
