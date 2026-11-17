/** Roadmap — frontend activation shell.
 * Registers the Roadmap view, session actions/tool cards and the dedicated
 * settings page (display, artifact defaults, Architect model, safe deletion). */
import type { PluginFrontendContext } from "learnharness-plugin-api";
import { resolveLocale, setLocale, t } from "./i18n.ts";
import { registerSessionActions } from "./session-actions.ts";
import { mountSettingsPage } from "./settings.ts";
import { mountPathHub } from "./view/path-hub.ts";
import { registerLearningPathToolRenderers } from "./view/tool-renderers.ts";
import { registerProposalCard } from "./view/proposal-card.ts";

export function activate(ctx: PluginFrontendContext): () => void {
  const disposers: (() => void)[] = [];
  // The view name is fixed at activation; the view itself re-reads the language setting.
  setLocale(resolveLocale("auto"));

  disposers.push(
    ctx.registerView({
      id: "paths",
      name: t("view.name"),
      mount(container, signal) {
        container.classList.add("roadmap-view");
        let cleanup: (() => void) | null = null;
        let child: AbortController | null = null;
        // A language change rebuilds the view so every static label follows it.
        const mount = (): void => {
          cleanup?.();
          child?.abort();
          container.replaceChildren();
          if (signal.aborted) return;
          child = new AbortController();
          const scoped = AbortSignal.any([signal, child.signal]);
          cleanup = mountPathHub(ctx, container, scoped, { onLocaleChange: () => queueMicrotask(mount) });
        };
        mount();
        return () => {
          cleanup?.();
          child?.abort();
          container.replaceChildren();
          container.classList.remove("roadmap-view");
        };
      },
    }),
  );

  disposers.push(
    ctx.registerAction({
      id: "open-paths",
      name: t("view.name"),
      run: () => ctx.app.openView("paths"),
    }),
  );
  disposers.push(ctx.placeAction({ id: "paths-sidebar", actionId: "open-paths", location: "sidebar" }));

  // Session top-bar actions and compact roadmap_* result cards.
  disposers.push(registerSessionActions(ctx));
  disposers.push(registerLearningPathToolRenderers(ctx));
  disposers.push(registerProposalCard(ctx));

  disposers.push(
    ctx.registerSettings((settingsContainer, settingsSignal) => {
      settingsContainer.classList.add("roadmap-settings");
      let cleanup: (() => void) | null = null;
      // A language change rebuilds the whole page so static headings follow it.
      const mount = (): void => {
        cleanup?.();
        settingsContainer.replaceChildren();
        if (!settingsSignal.aborted) cleanup = mountSettingsPage(ctx, settingsContainer, settingsSignal, () => queueMicrotask(mount));
      };
      mount();
      return () => {
        cleanup?.();
        settingsContainer.replaceChildren();
        settingsContainer.classList.remove("roadmap-settings");
      };
    }),
  );

  // Registrations expire with the activation; release them explicitly for symmetry.
  return () => {
    for (const dispose of disposers.reverse()) dispose();
  };
}
