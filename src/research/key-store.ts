/** The learner's own search key (optional channel, off by default).
 *
 * Stored apart from settings.json in `<data>/secrets/search-key.json` so settings
 * exports never carry it, and never sent back to the interface (only "a key is set").
 * Plugins cannot use the system keychain, so the file is plain text on disk:
 * the settings page says so, and suggests a key with a spending limit.
 */
import fs from "node:fs";
import path from "node:path";
import type { KeyEngine } from "../domain.ts";

export interface KeyStore {
  read(engine: KeyEngine): string | null;
  has(engine: KeyEngine): boolean;
  save(engine: KeyEngine, key: string): void;
  clear(engine: KeyEngine): void;
}

export function createKeyStore(dataDirectory: string): KeyStore {
  const directory = path.join(dataDirectory, "secrets");
  const file = path.join(directory, "search-key.json");
  const load = (): Record<string, string> => {
    try {
      const value = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
      return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
    } catch {
      return {};
    }
  };
  const write = (value: Record<string, string>): void => {
    fs.mkdirSync(directory, { recursive: true });
    // A note for backup tools that respect it (e.g. a Git-based backup plugin).
    const ignore = path.join(directory, ".gitignore");
    if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, "*\n");
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(value), { mode: 0o600 });
    fs.renameSync(`${file}.tmp`, file);
  };
  return {
    read: (engine) => load()[engine] ?? null,
    has: (engine) => Boolean(load()[engine]),
    save(engine, key) {
      const trimmed = key.trim();
      if (!/^[\x21-\x7e]{8,200}$/.test(trimmed)) throw new Error("The key looks malformed.");
      write({ ...load(), [engine]: trimmed });
    },
    clear(engine) {
      const value = load();
      delete value[engine];
      write(value);
    },
  };
}
