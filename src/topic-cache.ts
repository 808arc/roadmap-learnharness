/** Disk cache of successful developer-roadmap topic reads (backend only; the browser bundle never imports this).
 *
 * Layout: `<folder>/<commit>/<roadmap>/<topic>.json`. The commit is part of the path, so a pinned-commit change
 * is a cache miss. Roadmap, topic and commit are validated slugs or a 40-character SHA before they reach here,
 * so they cannot name a path outside the folder. Writes are atomic: a temporary file, then a rename.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { TopicDiskCache, UpstreamTopic } from "./upstream-roadmaps.ts";

function entryPath(folder: string, roadmap: string, topic: string, commit: string): string {
  return path.join(folder, commit, roadmap, `${topic}.json`);
}

export function createTopicDiskCache(folder: string): TopicDiskCache {
  return {
    async read(roadmap, topic, commit) {
      try {
        return JSON.parse(await fs.readFile(entryPath(folder, roadmap, topic, commit), "utf8")) as unknown;
      } catch {
        return null;
      }
    },
    async write(value: UpstreamTopic) {
      const target = entryPath(folder, value.roadmap, value.slug, value.commit);
      const temporary = `${target}.${randomUUID()}.tmp`;
      try {
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(temporary, JSON.stringify(value));
        await fs.rename(temporary, target);
      } catch {
        await fs.rm(temporary, { force: true }).catch(() => undefined);
        throw new Error("topic cache write failed");
      }
    },
  };
}
