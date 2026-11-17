/** Research notes: reports written by research sessions and deep-research runs.
 * One JSON file per note under `<data>/research/`; the Architect reads them back. */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type NoteOrigin = "session" | "claude-cli" | "architect";

export interface ResearchNote {
  readonly id: string;
  readonly title: string;
  readonly origin: NoteOrigin;
  readonly createdAt: string;
  readonly body: string;
  /** Native chat that produced it, for session notes. */
  readonly chatId?: string;
}

export interface ResearchNoteSummary {
  readonly id: string;
  readonly title: string;
  readonly origin: NoteOrigin;
  readonly createdAt: string;
  readonly size: number;
  readonly chatId?: string;
}

export interface ResearchNotes {
  list(): ResearchNoteSummary[];
  read(id: string): ResearchNote | null;
  add(note: { title: string; origin: NoteOrigin; body: string; chatId?: string }): ResearchNote;
  remove(id: string): boolean;
}

const ID = /^[a-z0-9-]{8,64}$/;
const MAX_BODY = 400_000;

export function createResearchNotes(dataDirectory: string): ResearchNotes {
  const directory = path.join(dataDirectory, "research");
  const file = (id: string): string => path.join(directory, `${id}.json`);
  const readFile = (name: string): ResearchNote | null => {
    try {
      const value = JSON.parse(fs.readFileSync(path.join(directory, name), "utf8")) as ResearchNote;
      return typeof value.id === "string" && typeof value.body === "string" ? value : null;
    } catch {
      return null;
    }
  };
  return {
    list() {
      if (!fs.existsSync(directory)) return [];
      return fs
        .readdirSync(directory)
        .filter((name) => name.endsWith(".json"))
        .map(readFile)
        .filter((note): note is ResearchNote => note !== null)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map(({ body, ...rest }) => ({ ...rest, size: body.length }));
    },
    read(id) {
      return ID.test(id) ? readFile(`${id}.json`) : null;
    },
    add(input) {
      fs.mkdirSync(directory, { recursive: true });
      const note: ResearchNote = {
        id: randomUUID(),
        title: input.title.trim().slice(0, 200) || "Research",
        origin: input.origin,
        createdAt: new Date().toISOString(),
        body: input.body.slice(0, MAX_BODY),
        ...(input.chatId ? { chatId: input.chatId } : {}),
      };
      const temporary = `${file(note.id)}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify(note, null, 2));
      fs.renameSync(temporary, file(note.id));
      return note;
    },
    remove(id) {
      if (!ID.test(id) || !fs.existsSync(file(id))) return false;
      fs.rmSync(file(id));
      return true;
    },
  };
}
