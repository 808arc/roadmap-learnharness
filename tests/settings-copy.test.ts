/** Settings copy: every settings string has an English string, and no
 * description names a tool or a file the learner cannot see. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync(new URL("../src/i18n.ts", import.meta.url), "utf8");
const enBlock = source.slice(source.indexOf("const en = {"), source.indexOf("export type MessageKey"));

const entries = (block: string): [string, string][] =>
  [...block.matchAll(/^\s+"([\w.-]+)":\s*"((?:[^"\\]|\\.)*)",?$/gm)].map((match) => [match[1]!, match[2]!]);

const SETTINGS_PREFIXES = ["s.", "r.", "artWhy.", "art."];
const inSettings = (key: string): boolean => SETTINGS_PREFIXES.some((prefix) => key.startsWith(prefix));

const en = new Map(entries(enBlock));
const settingsEn = [...en.keys()].filter(inSettings).sort();

const TOOL_NAMES = [
  "read_page",
  "find_books",
  "book_contents",
  "find_papers",
  "search_wikipedia",
  "web_search",
  "deep_research",
  "list_research_notes",
  "read_research_note",
];
const FILE_NAME = /\b[\w-]+\.(ts|tsx|js|mjs|cjs|json|md|css|html|txt|yaml|yml)\b/i;

test("every settings string key has an English string and no Cyrillic appears in src/i18n.ts", () => {
  assert.ok(settingsEn.length > 0, "settings keys were found");
  assert.doesNotMatch(source, /[\u0400-\u04FF]/, "no Cyrillic in src/i18n.ts");
  for (const key of en.keys()) {
    assert.ok((en.get(key) ?? "").trim().length > 0, `${key} has an English value`);
  }
});

test("no settings description names a tool or a file", () => {
  for (const [lang, table] of [["en", en]] as const) {
    for (const key of settingsEn) {
      const value = table.get(key) ?? "";
      for (const tool of TOOL_NAMES) {
        assert.ok(!value.includes(tool), `${lang} ${key} must not name the tool ${tool}`);
      }
      assert.ok(!FILE_NAME.test(value), `${lang} ${key} must not name a file: ${value}`);
    }
  }
});

test("artifact descriptions avoid unexplained jargon", () => {
  for (const key of [...en.keys()].filter((candidate) => candidate.startsWith("artWhy."))) {
    assert.doesNotMatch(en.get(key) ?? "", /textbook|layout|seed|hook|scaffold/i, `${key} stays in plain words`);
  }
});

test("no interface string names the upstream roadmap source", () => {
  for (const [lang, table] of [["en", en]] as const) {
    for (const [key, value] of table) {
      assert.doesNotMatch(value, /roadmap\.sh|nilbuild/i, `${lang} ${key} must not name the upstream source`);
    }
  }
});

test("artifact names avoid unexplained jargon", () => {
  for (const [lang, table] of [["en", en]] as const) {
    for (const key of [...table.keys()].filter((candidate) => candidate.startsWith("art."))) {
      assert.doesNotMatch(table.get(key) ?? "", /seed|textbook/i, `${lang} ${key} stays in plain words`);
    }
  }
});

test("artifact catalog text in domain.ts avoids seed and textbook wording", () => {
  const domain = fs.readFileSync(new URL("../src/domain.ts", import.meta.url), "utf8");
  const catalog = domain.slice(domain.indexOf("ARTIFACT_CATALOG"), domain.indexOf("export function artifactCatalogEntry"));
  assert.ok(catalog.length > 100, "catalog block was found");
  const texts = [...catalog.matchAll(/(?:label|justification):\s*\n?\s*"((?:[^"\\]|\\.)*)"/g)].map((match) => match[1]!);
  assert.ok(texts.length > 0, "catalog strings were found");
  for (const text of texts) {
    assert.doesNotMatch(text, /seed|textbook|flashcard/i, `catalog text stays in plain words: ${text}`);
  }
});
