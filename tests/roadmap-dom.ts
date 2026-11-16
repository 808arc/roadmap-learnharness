/** DOM helpers for Roadmap view tests (Learny-styled plain buttons, host menus). */
import assert from "node:assert/strict";
import type { PluginMenuProps } from "learnharness-plugin-api";
import type { ViewFixture } from "./view-host.ts";

/** The button whose visible text is exactly `label`, inside `scope`. */
export function buttonByText(scope: ParentNode, label: string): HTMLButtonElement {
  const found = [...scope.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === label);
  assert.ok(found, `Missing button "${label}"`);
  return found;
}

export function click(scope: ParentNode, label: string): void {
  buttonByText(scope, label).click();
}

/** A node on the roadmap canvas (graph or tree). */
export function canvasNode(fixture: ViewFixture, nodeId: string): HTMLButtonElement {
  const found = fixture.root.querySelector<HTMLButtonElement>(`.rm-canvas .rm-node[data-node-id="${nodeId}"]`);
  assert.ok(found, `Missing canvas node ${nodeId}`);
  return found;
}

export async function selectNode(fixture: ViewFixture, nodeId: string): Promise<void> {
  canvasNode(fixture, nodeId).click();
  await fixture.flush();
}

export function inspector(fixture: ViewFixture): HTMLElement {
  const found = fixture.root.querySelector<HTMLElement>(".rm-insp");
  assert.ok(found, "the node panel exists");
  return found;
}

/** Choose `key` in the most recently opened host menu. */
export async function chooseMenuItem(fixture: ViewFixture, key: string): Promise<PluginMenuProps> {
  const menu = fixture.findLast("openMenu");
  const props = menu.props as PluginMenuProps;
  const item = props.items.find((entry) => entry.key === key);
  assert.ok(item, `Missing menu item ${key}; have ${props.items.map((entry) => entry.key).join(", ")}`);
  await item.onSelect();
  await fixture.flush();
  return props;
}
