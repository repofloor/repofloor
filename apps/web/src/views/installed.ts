/**
 * C2's landing page: where an owner arrives after installing the GitHub App.
 *
 * `apps/api`'s Setup URL (`/auth/install/callback`) answers JSON unless it is given a
 * `return_to`, in which case it redirects there after reading the installation back
 * from GitHub as the App. Point it at `/installed` and this page is what the owner
 * sees instead of `{"ok":true}`.
 *
 * It deliberately does not report the installation id: the api redirects to a bare
 * path, and an id this page read out of its own query string would be unsigned and
 * worth nothing anyway. What an owner actually needs to know is the next thing that
 * has to happen — a webhook — so that is what it says.
 */

import { el } from "../dom.js";
import { signInPath } from "../endpoints.js";
import { routePath } from "../route.js";
import { officeCard, header, type View, type ViewContext } from "./buildings.js";
import { empty, failure, onRetry, skeleton } from "./states.js";

export function renderInstalled(ctx: ViewContext): View {
  const head = (): HTMLElement =>
    el(
      "div",
      {},
      header("The App is installed", "Repofloor can now receive events for the repositories you chose."),
      el(
        "ol",
        { class: "steps" },
        el("li", {}, "GitHub has recorded the installation, and Repofloor has read it back as the App."),
        el(
          "li",
          {},
          "An office appears below as soon as the first webhook arrives — a push, a pull request, a " +
            "review or a CI run. Nothing is backfilled yet, so a quiet repository stays invisible " +
            "until something happens in it.",
        ),
        el("li", {}, "Who may open an office is GitHub's answer, asked per visit. Repofloor keeps no access list."),
      ),
    );

  ctx.mount.replaceChildren(head(), skeleton(2));

  let cancelled = false;
  const load = (): void => {
    void ctx.api.offices().then(
      (listing) => {
        if (cancelled) return;
        const nodes: Node[] = [head()];
        if (listing.offices.length > 0) {
          nodes.push(
            el("h2", { class: "section__title" }, "Ready now"),
            el(
              "ul",
              { class: "cards" },
              ...listing.offices.sort((a, b) => a.officeId.localeCompare(b.officeId)).map(officeCard),
            ),
          );
        } else {
          nodes.push(
            ctx.viewer
              ? empty({
                  title: "No office yet — this is expected",
                  body:
                    "The installation is recorded, but no event has arrived for it. Push a commit or open " +
                    "a pull request on one of the repositories you selected, then reload this page.",
                  action: { label: "Back to buildings", href: routePath({ kind: "home" }) },
                })
              : empty({
                  title: "Installed, but nobody is signed in",
                  body:
                    "The App is installed. To see a private office you also have to sign in, so that " +
                    "Repofloor can ask GitHub whether your account may read it.",
                  action: { label: "Sign in with GitHub", href: signInPath(routePath({ kind: "home" })), external: true },
                }),
          );
        }
        ctx.mount.replaceChildren(...nodes);
      },
      (err: unknown) => {
        if (cancelled) return;
        const node = failure(err, { returnTo: ctx.returnTo, what: "Your offices" });
        onRetry(node, load);
        ctx.mount.replaceChildren(head(), node);
      },
    );
  };
  load();

  return {
    dispose: () => {
      cancelled = true;
    },
  };
}
