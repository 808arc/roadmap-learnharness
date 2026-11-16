/** Static inline SVG icons (Learny line style, 16px grid, currentColor). */
import type { ProgressionState } from "../domain.ts";

const svg = (body: string, extra = ""): string =>
  `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}>${body}</svg>`;

export const ICONS = {
  check: svg('<path d="M3 8.5l3 3 7-7"/>', 'stroke-width="1.8"'),
  flag: svg('<path d="M3.5 14V2.5h8l-1.5 3 1.5 3h-8"/>'),
  repeat: svg('<path d="M3 6h9l-2-2M13 10H4l2 2"/>'),
  book: svg('<path d="M2 3h4.5A1.5 1.5 0 0 1 8 4.5V13a1.5 1.5 0 0 0-1.5-1.5H2zM14 3H9.5A1.5 1.5 0 0 0 8 4.5V13a1.5 1.5 0 0 1 1.5-1.5H14z"/>'),
  article: svg('<path d="M4 1.5h5l3 3v10H4zM9 1.5v3h3M6 8h4M6 11h4"/>'),
  video: svg('<rect x="1.5" y="4" width="9" height="8" rx="1"/><path d="M10.5 7l4-2v6l-4-2"/>'),
  course: svg('<path d="M1.5 6L8 3l6.5 3L8 9zM4 7.5v3.5c0 1 2 2 4 2s4-1 4-2V7.5"/>'),
  docs: svg('<path d="M3 2h7l3 3v9H3zM6 6.5l-1.5 1.5L6 9.5M10 6.5l1.5 1.5L10 9.5"/>'),
  exercises: svg('<path d="M1.5 6v4M4 4.5v7M12 4.5v7M14.5 6v4M4 8h8"/>'),
  chat: svg('<path d="M2 3h12v8H6l-3 2.5V11H2z"/>'),
  warn: svg('<path d="M8 2l6.5 12h-13zM8 6.5v3.5M8 12v.2"/>'),
  chevronDown: svg('<path d="M4 6l4 4 4-4"/>', 'width="12" height="12"'),
  chevronRight: svg('<path d="M6 4l4 4-4 4"/>', 'width="12" height="12"'),
  close: svg('<path d="M4 4l8 8M12 4l-8 8"/>'),
  minus: svg('<path d="M4 8h8"/>'),
  plus: svg('<path d="M4 8h8M8 4v8"/>'),
  more: svg('<circle cx="3.5" cy="8" r=".8" fill="currentColor"/><circle cx="8" cy="8" r=".8" fill="currentColor"/><circle cx="12.5" cy="8" r=".8" fill="currentColor"/>'),
  sparkle: svg('<path d="M8 1.5l1.4 4.1 4.1 1.4-4.1 1.4L8 12.5 6.6 8.4 2.5 7l4.1-1.4z"/>'),
  link: svg('<path d="M6.5 9.5l3-3M7 4.5l1-1a2.5 2.5 0 0 1 3.5 3.5l-1 1M9 11.5l-1 1A2.5 2.5 0 0 1 4.5 9l1-1"/>'),
} as const;

export function statusIcon(state: ProgressionState): string {
  switch (state) {
    case "consolidated":
      return `<span class="rm-st rm-st-done">${ICONS.check}</span>`;
    case "in_progress":
      return '<span class="rm-st rm-st-progress"><i></i></span>';
    case "skipped":
      return '<span class="rm-st rm-st-skipped"><i></i></span>';
    default:
      return '<span class="rm-st rm-st-todo"><i></i></span>';
  }
}

export function setIcon(element: Element, html: string): void {
  // Only the static constants above are ever assigned; never learner or model text.
  element.innerHTML = html;
}
