/** Source anchor line in the node panel: English labels are unchanged, and a chapter label the
 * Architect wrote in the learner's language ("auto" content language) is not prefixed again. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { formatAnchor } from "../src/view/node-inspector.ts";

test("a bare chapter gets the English prefix; an English label is kept as written", () => {
  assert.equal(formatAnchor({ reference: "K&R", chapter: "5", section: "5.1", pages: "93–117" }), "K&R · ch. 5 · \u00a75.1 · pp. 93–117");
  assert.equal(formatAnchor({ reference: "K&R", chapter: "Ch. 8" }), "K&R · Ch. 8");
  assert.equal(formatAnchor({ reference: "K&R", chapter: "Hashing" }), "K&R · ch. Hashing");
});

test("a chapter label in the learner's language is not prefixed with ch.", () => {
  // Cyrillic "Glava 8" and Greek "Kefalaio 8", escaped so the source stays ASCII.
  assert.equal(formatAnchor({ reference: "Book", chapter: "\u0413\u043b\u0430\u0432\u0430 8" }), "Book · \u0413\u043b\u0430\u0432\u0430 8");
  assert.equal(formatAnchor({ reference: "Book", chapter: "\u039a\u03b5\u03c6\u03ac\u03bb\u03b1\u03b9\u03bf 3" }), "Book · \u039a\u03b5\u03c6\u03ac\u03bb\u03b1\u03b9\u03bf 3");
});
