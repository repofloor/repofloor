/**
 * A path that is not a building, an office or the install landing.
 *
 * Reached only for paths that look like neither: `/:owner` and `/:owner/:repo` are
 * accepted on sight and then asked about, because this page cannot know what exists.
 */

import { el } from "../dom.js";
import { routePath } from "../route.js";
import type { View, ViewContext } from "./buildings.js";
import { empty } from "./states.js";

export function renderNotFound(ctx: ViewContext, path: string): View {
  ctx.mount.replaceChildren(
    empty({
      title: "No such page",
      body: `Nothing here answers to ${path}. An office lives at /owner/repo — the same path it has on GitHub.`,
      action: { label: "Back to buildings", href: routePath({ kind: "home" }) },
    }),
    el("p", { class: "state__hint" }, "If you followed a link from somewhere, it was probably written for an older version of this app."),
  );
  return { dispose: () => {} };
}
