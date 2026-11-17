/** Extension points filled by optional build-time modules.
 *
 * The public build leaves them empty. A private build may inject a module that
 * sets them (see scripts/build.mjs: `src/local-only/index.ts` is injected into
 * the backend bundle when it exists; that folder is git-ignored).
 */
import type { PluginBackendContext } from "learnharness-plugin-api";
import type { PageReader, WebSearch } from "./tools.ts";

export interface HostWebChannel {
  /** Null when no search engine is configured in LearnHarness. */
  readonly search: WebSearch | null;
  readonly read: PageReader;
}

export const localChannels: {
  /** Host-mediated web search, where the host provides it. */
  hostWeb?: (ctx: PluginBackendContext) => HostWebChannel | null;
} = {};
