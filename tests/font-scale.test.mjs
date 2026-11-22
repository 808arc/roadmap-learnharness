/** Font scale guard: every font-size in the plugin stylesheet uses a --rm-font-* token, and the tokens resolve everywhere. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const project = fileURLToPath(new URL("../", import.meta.url));
const css = fs.readFileSync(path.join(project, "src/styles.css"), "utf8");
const SCALE = [["xs", "11px"], ["sm", "12px"], ["md", "13px"], ["lg", "15px"], ["xl", "18px"]];
// Classes the plugin sets on the roots it renders into (view, settings page, proposal card, research settings).
const PLUGIN_ROOTS = ["roadmap-view", "roadmap-settings", "rm-proposal", "rm-research-settings"];

/** The body of every rule whose selector list mentions the given class. */
function rulesFor(className) {
  return [...css.matchAll(/^([^{}]+)\{([^{}]*)\}/gm)]
    .filter(([, selector]) => new RegExp(`\\.${className}(?![\\w-])`).test(selector))
    .map(([, , body]) => body);
}

test("every font-size declaration uses a var(--rm-font-*) token", () => {
  const declarations = [...css.matchAll(/font-size\s*:\s*([^;}]+)[;}]/g)].map((m) => m[1].trim());
  assert.ok(declarations.length > 0, "expected font-size declarations in styles.css");
  const offenders = declarations.filter((value) => !/^var\(--rm-font-(xs|sm|md|lg|xl)\)$/.test(value));
  assert.deepEqual(offenders, [], `font-size values that are not scale tokens: ${offenders.join(", ")}`);
});

test("the font scale tokens are defined on :root with the exact values", () => {
  const root = css.match(/^:root \{([\s\S]*?)^\}/m);
  assert.ok(root, "expected a :root rule");
  for (const [name, px] of SCALE) {
    assert.match(root[1], new RegExp(`--rm-font-${name}:\\s*${px};`), `missing --rm-font-${name}: ${px}`);
  }
});

test("every plugin root that uses a font token also resolves the tokens", () => {
  for (const className of PLUGIN_ROOTS) {
    const usesToken = rulesFor(className).some((body) => body.includes("var(--rm-font-"));
    if (!usesToken) continue;
    const defines = rulesFor(className).some((body) => /--rm-font-xs:/.test(body));
    // Otherwise the tokens come from :root, which the previous test pins down.
    assert.ok(defines || /--rm-font-xs:/.test(css.match(/^:root \{[\s\S]*?^\}/m)[0]), `.${className} uses --rm-font tokens without defining them`);
  }
});
