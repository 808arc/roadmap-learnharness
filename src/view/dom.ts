/** Small DOM helpers shared by the Roadmap views (Learny-styled controls). */
import { setIcon } from "./icons.ts";

export function el<K extends keyof HTMLElementTagNameMap>(
  document: Document,
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export type ButtonVariant = "primary" | "outline" | "ghost" | "link";

export function button(
  document: Document,
  label: string,
  onClick: () => void,
  signal: AbortSignal,
  options: { variant?: ButtonVariant; icon?: string; title?: string; className?: string } = {},
): HTMLButtonElement {
  const node = el(document, "button", `rm-btn rm-btn-${options.variant ?? "outline"}${options.className ? ` ${options.className}` : ""}`);
  node.type = "button";
  if (options.icon) {
    const icon = el(document, "span", "rm-btn-icon");
    setIcon(icon, options.icon);
    node.append(icon);
  }
  if (label) node.append(el(document, "span", undefined, label));
  if (options.title) node.title = options.title;
  node.addEventListener(
    "click",
    () => {
      if (!signal.aborted && !node.disabled) onClick();
    },
    { signal },
  );
  return node;
}

/** Date like "12 ноября" / "Nov 12" in the active locale. */
export function shortDate(value: string | number, localeTag: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString(localeTag, { day: "numeric", month: "long", ...(sameYear ? {} : { year: "numeric" }) });
}
