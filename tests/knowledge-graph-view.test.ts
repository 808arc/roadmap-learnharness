/** Roadmap view: Graph shows the learner's Knowledge Graph (graph.knowledge), Tree shows the roadmap. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mountPathHub } from "../src/view/path-hub.ts";
import { makePath } from "./fixtures.ts";
import { createViewFixture } from "./view-host.ts";

test("the Graph tab draws propositions and chains from the learner's graph; Tree keeps the roadmap", async () => {
  const fixture = createViewFixture({
    paths: [makePath()],
    knowledge: {
      nodes: [
        { id: "n1", name: "Pointers hold addresses", statement: "A pointer holds an address." },
        { id: "n2", name: "Arrays decay", statement: "An array decays to a pointer." },
      ],
      edges: [{ from: "n1", to: "n2" }],
    },
  });
  try {
    const root = fixture.root;
    fixture.context.signal.addEventListener("abort", () => root.replaceChildren());
    mountPathHub(fixture.context, root, fixture.context.signal);
    await fixture.flush();
    await fixture.flush();
    const tabs = [...root.querySelectorAll<HTMLButtonElement>(".rm-top .rm-seg button")];
    assert.deepEqual(tabs.map((tab) => tab.textContent), ["Tree", "Graph"], "the switch offers Tree and Graph");
    assert.equal(tabs[0]!.className, "rm-on", "Tree is the default");
    assert.ok(root.querySelector(".rm-stage [data-node-id]"), "Tree draws roadmap nodes");

    tabs[1]!.click();
    await fixture.flush();
    assert.ok(fixture.calls.some((call) => call.name === "graph.knowledge"));
    assert.equal(root.querySelectorAll(".rm-stage [data-proposition-id]").length, 2, "Graph draws the propositions");
    assert.equal(root.querySelector(".rm-stage [data-node-id]"), null, "Graph does not draw roadmap nodes");
    assert.equal(root.querySelectorAll(".rm-edges line").length, 1, "one chain arrow");
    assert.equal(root.querySelectorAll(".rm-stage .rm-pill").length, 2, "every proposition is a pill");
    assert.equal(root.querySelectorAll(".rm-box").length, 0, "Graph draws no module frames");
    assert.equal(root.querySelectorAll(".rm-alt-group").length, 0, "Graph draws no alternative brackets");
    assert.equal(root.querySelectorAll(".rm-module-label").length, 0, "Graph draws no module labels");

    tabs[0]!.click();
    await fixture.flush();
    assert.ok(root.querySelector(".rm-stage [data-node-id]"));
    root.querySelector<HTMLButtonElement>(".rm-text-toggle")!.click();
    await fixture.flush();
    assert.ok(root.querySelector(".rm-text-node"), "Tree switches to text only");
  } finally {
    fixture.controller.abort();
  }
});
