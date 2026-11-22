/** One file per roadmap under roadmaps/, with an index, and the one-time migration from learning-paths.json. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  LEARNING_PATHS_FILE,
  ROADMAPS_DIRECTORY,
  ROADMAP_INDEX_FILE,
  STORE_SCHEMA_VERSION,
  StoreError,
  openLearningPathStore,
} from "../src/store.ts";
import { clone, makePath } from "./fixtures.ts";

function directory(t: { after: (fn: () => void) => void }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "learning-path-split-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const second = () => ({ ...clone(makePath()), id: "path-2", title: "Second path" });
const third = () => ({ ...clone(makePath()), id: "path-3", title: "Third path" });
const roadmapPath = (dir: string, id: string): string => path.join(dir, ROADMAPS_DIRECTORY, `${id}.json`);
const indexPath = (dir: string): string => path.join(dir, ROADMAPS_DIRECTORY, ROADMAP_INDEX_FILE);
const indexIds = (dir: string): string[] => JSON.parse(fs.readFileSync(indexPath(dir), "utf8")).roadmaps;
const roadmapFiles = (dir: string): string[] =>
  fs.existsSync(path.join(dir, ROADMAPS_DIRECTORY))
    ? fs.readdirSync(path.join(dir, ROADMAPS_DIRECTORY)).sort()
    : [];

/** The old single-file layout, written the way the previous release wrote it. */
function writeLegacy(dir: string, paths: unknown[], revision = 3): string {
  const text = `${JSON.stringify({ schemaVersion: STORE_SCHEMA_VERSION, revision, paths }, null, 2)}\n`;
  fs.writeFileSync(path.join(dir, LEARNING_PATHS_FILE), text);
  return text;
}

test("migration round-trip: old data in, same data out, legacy bytes kept", (t) => {
  const dir = directory(t);
  const original = [makePath(), second()];
  const legacyText = writeLegacy(dir, original);

  const store = openLearningPathStore(dir);
  assert.deepEqual(store.paths(), original);
  assert.deepEqual(store.refusals(), []);
  assert.deepEqual(indexIds(dir), ["path-linear-algebra", "path-2"]);
  for (const roadmap of original) {
    assert.deepEqual(JSON.parse(fs.readFileSync(roadmapPath(dir, roadmap.id), "utf8")).roadmap, roadmap);
  }

  // The old file is kept, byte for byte, under its migrated name; the original name is gone.
  assert.equal(fs.existsSync(path.join(dir, LEARNING_PATHS_FILE)), false);
  assert.equal(fs.readFileSync(path.join(dir, `${LEARNING_PATHS_FILE}.migrated`), "utf8"), legacyText);

  const reopened = openLearningPathStore(dir);
  assert.deepEqual(reopened.paths(), original);
  assert.deepEqual(reopened.path("path-2"), second());
});

test("migration runs once: a later legacy file is never read again", (t) => {
  const dir = directory(t);
  writeLegacy(dir, [makePath()]);
  openLearningPathStore(dir);

  const stray = writeLegacy(dir, [third()], 9);
  const store = openLearningPathStore(dir);
  assert.deepEqual(store.paths(), [makePath()]);
  assert.equal(store.path("path-3"), null);
  assert.equal(fs.readFileSync(path.join(dir, LEARNING_PATHS_FILE), "utf8"), stray, "the stray file is untouched");
  assert.deepEqual(indexIds(dir), ["path-linear-algebra"]);
  assert.equal(JSON.parse(fs.readFileSync(indexPath(dir), "utf8")).migration.version, 1);
});

test("a failed validation of a new file keeps the old file untouched and can be retried", (t) => {
  const dir = directory(t);
  const legacyText = writeLegacy(dir, [makePath(), second()]);

  // Make the read-back of the second new file see garbage, as if the write had been damaged.
  const originalRead = fs.readFileSync;
  t.mock.method(fs, "readFileSync", ((file: fs.PathOrFileDescriptor, ...rest: unknown[]) =>
    String(file).endsWith(path.join(ROADMAPS_DIRECTORY, "path-2.json"))
      ? "{ damaged"
      : (originalRead as (...args: unknown[]) => unknown)(file, ...rest)) as never);

  assert.throws(() => openLearningPathStore(dir), (error: unknown) => error instanceof StoreError);
  assert.equal(fs.readFileSync(path.join(dir, LEARNING_PATHS_FILE), "utf8"), legacyText);
  assert.equal(fs.existsSync(indexPath(dir)), false, "no index, so the migration is not marked done");
  assert.deepEqual(roadmapFiles(dir), [], "the partial copies this attempt wrote were removed");

  t.mock.restoreAll();
  const store = openLearningPathStore(dir);
  assert.deepEqual(store.paths(), [makePath(), second()]);
  assert.equal(fs.readFileSync(path.join(dir, `${LEARNING_PATHS_FILE}.migrated`), "utf8"), legacyText);
});

test("a corrupt roadmap file blocks only itself and is never overwritten", (t) => {
  const dir = directory(t);
  const store = openLearningPathStore(dir);
  store.savePath(makePath());
  store.savePath(second());
  const damaged = roadmapPath(dir, "path-2");
  fs.writeFileSync(damaged, "{ not json");

  const reopened = openLearningPathStore(dir);
  assert.deepEqual(reopened.paths(), [makePath()]);
  assert.equal(reopened.refusals().length, 1);
  assert.equal(reopened.refusals()[0]?.id, "path-2");
  assert.equal(reopened.refusals()[0]?.code, "corrupt");
  assert.match(reopened.refusals()[0]?.message ?? "", /corrupt/);

  assert.throws(() => reopened.savePath({ ...second(), title: "Overwrite attempt" }), StoreError);
  assert.throws(() => reopened.deletePath("path-2"), StoreError);
  assert.equal(fs.readFileSync(damaged, "utf8"), "{ not json");

  // The refused roadmap keeps its place in the index, so saving another roadmap does not drop it.
  reopened.savePath(third());
  assert.deepEqual(indexIds(dir), ["path-linear-algebra", "path-2", "path-3"]);
  assert.equal(fs.readFileSync(damaged, "utf8"), "{ not json");
  assert.deepEqual(openLearningPathStore(dir).paths().map((roadmap) => roadmap.id), ["path-linear-algebra", "path-3"]);
});

test("a newer roadmap file is refused and not overwritten", (t) => {
  const dir = directory(t);
  const store = openLearningPathStore(dir);
  store.savePath(makePath());
  store.savePath(second());
  const newer = JSON.stringify({ schemaVersion: STORE_SCHEMA_VERSION + 1, revision: 4, roadmap: second() });
  fs.writeFileSync(roadmapPath(dir, "path-2"), newer);

  const reopened = openLearningPathStore(dir);
  assert.deepEqual(reopened.paths(), [makePath()]);
  assert.equal(reopened.refusals()[0]?.code, "newer-schema");
  assert.match(reopened.refusals()[0]?.message ?? "", /newer schema version 2/);
  assert.throws(() => reopened.savePath(second()), (error: unknown) => error instanceof StoreError && error.code === "newer-schema");
  assert.equal(fs.readFileSync(roadmapPath(dir, "path-2"), "utf8"), newer);
});

test("a save writes only the changed roadmap, plus the index when membership changed", (t) => {
  const dir = directory(t);
  const store = openLearningPathStore(dir);
  store.savePath(makePath());
  store.savePath(second());

  const originalRename = fs.renameSync;
  const targets: string[] = [];
  t.mock.method(fs, "renameSync", ((from: fs.PathLike, to: fs.PathLike) => {
    targets.push(path.relative(dir, String(to)));
    return originalRename(from, to);
  }) as never);

  store.savePath({ ...second(), title: "Renamed second" });
  assert.deepEqual(targets, [path.join(ROADMAPS_DIRECTORY, "path-2.json")], "order and membership unchanged: index not written");

  targets.length = 0;
  store.savePath(third());
  // The index goes first on a new id, so a crash in between leaves a listed roadmap with no file, never the reverse.
  assert.deepEqual(targets, [path.join(ROADMAPS_DIRECTORY, ROADMAP_INDEX_FILE), path.join(ROADMAPS_DIRECTORY, "path-3.json")]);

  targets.length = 0;
  store.savePath(third());
  assert.deepEqual(targets, [], "an unchanged save writes nothing");
});

test("deleting a roadmap removes its file and its index entry", (t) => {
  const dir = directory(t);
  const store = openLearningPathStore(dir);
  store.savePath(makePath());
  store.savePath(second());

  assert.equal(store.deletePath("path-2"), true);
  assert.equal(fs.existsSync(roadmapPath(dir, "path-2")), false);
  assert.deepEqual(indexIds(dir), ["path-linear-algebra"]);
  assert.equal(store.deletePath("path-2"), false);

  const reopened = openLearningPathStore(dir);
  assert.deepEqual(reopened.paths(), [makePath()]);
  assert.deepEqual(roadmapFiles(dir), [ROADMAP_INDEX_FILE, "path-linear-algebra.json"]);
});
