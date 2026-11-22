/** Font scale guard: every font-size in the plugin stylesheet uses a --rm-font-* token. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const project = fileURLToPath(new URL("../", import.meta.url));
const css = fs.readFileSync(path.join(project, "src/styles.css"), "utf8");

test("every font-size declaration uses a var(--rm-font-*) token", () => {
  const declarations = [...css.matchAll(/font-size\s*:\s*([^;}]+)[;}]/g)].map((m) => m[1].trim());
  assert.ok(declarations.length > 0, "expected font-size declarations in styles.css");
  const offenders = declarations.filter((value) => !/^var\(--rm-font-(xs|sm|md|lg|xl)\)$/.test(value));
  assert.deepEqual(offenders, [], `font-size values that are not scale tokens: ${offenders.join(", ")}`);
});

test("the font scale tokens are defined on the plugin root", () => {
  const root = css.match(/^\.roadmap-view \{([\s\S]*?)^\}/m);
  assert.ok(root, "expected a .roadmap-view rule");
  for (const [name, px] of [["xs", "11px"], ["sm", "12px"], ["md", "13px"], ["lg", "15px"], ["xl", "18px"]]) {
    assert.match(root[1], new RegExp(`--rm-font-${name}:\\s*${px};`), `missing --rm-font-${name}: ${px}`);
  }
});
