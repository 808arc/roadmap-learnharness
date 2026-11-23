/** Local, metadata-only timing log for the Architect (`<data>/logs/architect-runs.jsonl`).
 *
 * One JSON object per line. Every step writes a `step.start` and a `step.end`
 * line; the end line carries `durationMs` and `ok`. Callers pass counts, sizes,
 * ids, provider/model names and timings only: never the learner's goal,
 * statements, source text or model output.
 *
 * Writes never throw. A failed write goes to `console.warn` and the caller
 * keeps running. When the file grows past its cap, only the newest half of the
 * lines is kept.
 */
import fs from "node:fs";
import path from "node:path";

export const LOG_DIRECTORY = "logs";
export const ARCHITECT_LOG_FILE = "architect-runs.jsonl";
/** Size at which the file is trimmed to its newest half. */
export const LOG_MAX_BYTES = 512 * 1024;

export type LogValue = string | number | boolean | null;
export type LogFields = Readonly<Record<string, LogValue | undefined>>;

export interface LogStep {
  /** Write the end line once; later calls are ignored. `ok: false` marks a step that did not succeed. */
  end(fields?: LogFields): void;
  /** End the step as failed. Only the error's class name is logged, never its message. */
  fail(error: unknown, fields?: LogFields): void;
}

export interface ActiveLogStep {
  readonly step: string;
  readonly elapsedMs: number;
  readonly fields: LogFields;
}

export interface PluginLog {
  /** Absolute path of the log file (it is created on the first write). */
  readonly path: string;
  /** Write a start line now and return the handle that writes the end line. */
  begin(step: string, fields?: LogFields): LogStep;
  /** Write a single event line. */
  event(name: string, fields?: LogFields): void;
  /** Steps begun and not yet ended, oldest first: name, elapsed time and the metadata they began with. Writes nothing. */
  active(): readonly ActiveLogStep[];
}

export interface PluginLogOptions {
  readonly maxBytes?: number;
  /** Monotonic clock in milliseconds; injected by tests. */
  readonly clock?: () => number;
}

export function architectLogPath(dataDirectory: string): string {
  return path.join(dataDirectory, LOG_DIRECTORY, ARCHITECT_LOG_FILE);
}

export function createPluginLog(filePath: string, options: PluginLogOptions = {}): PluginLog {
  const maxBytes = options.maxBytes ?? LOG_MAX_BYTES;
  const clock = options.clock ?? (() => performance.now());

  const write = (record: Record<string, unknown>): void => {
    try {
      const line = `${JSON.stringify({ ts: new Date().toISOString(), ...record })}\n`;
      fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
      fs.appendFileSync(filePath, line);
      if (fs.statSync(filePath).size > maxBytes) trim();
    } catch (error) {
      console.warn(
        "[roadmap] could not write the Architect log:",
        error instanceof Error ? error.message : "unknown error",
      );
    }
  };

  /** Keep the newest half of the lines. */
  const trim = (): void => {
    const lines = fs.readFileSync(filePath, "utf8").split("\n").filter((line) => line.length > 0);
    const kept = lines.slice(lines.length - Math.ceil(lines.length / 2));
    const temporary = `${filePath}.tmp`;
    fs.writeFileSync(temporary, kept.map((line) => `${line}\n`).join(""));
    fs.renameSync(temporary, filePath);
  };

  const errorName = (error: unknown): string =>
    error instanceof Error ? error.name : "NonError";

  const open = new Map<number, { step: string; started: number; fields: LogFields }>();
  let nextId = 0;

  return {
    path: filePath,
    event(name, fields = {}) {
      write({ ...fields, event: name });
    },
    active() {
      const now = clock();
      return [...open.values()].map((entry) => ({
        step: entry.step,
        elapsedMs: Math.max(0, Math.round(now - entry.started)),
        fields: entry.fields,
      }));
    },
    begin(step, fields = {}) {
      const started = clock();
      const id = nextId++;
      open.set(id, { step, started, fields });
      write({ ...fields, event: "step.start", step });
      let done = false;
      const finish = (record: Record<string, unknown>): void => {
        if (done) return;
        done = true;
        open.delete(id);
        const durationMs = Math.max(0, Math.round(clock() - started));
        write({ ...fields, ...record, event: "step.end", step, durationMs });
      };
      return {
        end(extra = {}) {
          finish({ ...extra, ok: extra.ok !== false });
        },
        fail(error, extra = {}) {
          finish({ ...extra, ok: false, error: errorName(error) });
        },
      };
    },
  };
}
