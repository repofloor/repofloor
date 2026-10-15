/**
 * The four states every view owes a reader: loading, empty, error, and the real thing.
 *
 * They live together because they have to agree. A skeleton that is a different height
 * from the list it stands in for makes the page jump when the data lands, and an error
 * that says "404" tells a reader nothing they can act on.
 */

import { ApiError, type FailureKind } from "../api.js";
import { el } from "../dom.js";
import { signInPath } from "../endpoints.js";

/** Reserved-height placeholder rows, so nothing moves when the answer arrives. */
export function skeleton(rows = 3): HTMLElement {
  return el(
    "div",
    { class: "skeleton", "aria-busy": "true", "aria-live": "polite", "aria-label": "Loading" },
    ...Array.from({ length: rows }, () => el("div", { class: "skeleton__row" })),
  );
}

export interface EmptyOptions {
  title: string;
  /** Why it is empty — the half that "No records" leaves out. */
  body: string;
  action?: { label: string; href: string; external?: boolean; hint?: string } | undefined;
}

export function empty(options: EmptyOptions): HTMLElement {
  return el(
    "div",
    { class: "state" },
    el("h2", { class: "state__title", text: options.title }),
    el("p", { class: "state__body", text: options.body }),
    options.action
      ? el(
          "a",
          {
            class: "button button--primary",
            href: options.action.href,
            ...(options.action.external ? { "data-external": true } : {}),
          },
          options.action.label,
        )
      : null,
    options.action?.hint ? el("p", { class: "state__hint", text: options.action.hint }) : null,
  );
}

/**
 * An error a reader can do something about.
 *
 * `not_found` is the interesting one. The api answers `404` both for an office that
 * does not exist and for one this caller may not read — on purpose, because whether a
 * private repository exists is itself private (rule 6). So this page must not claim
 * either, and the honest text says both and offers the one action that can change the
 * answer: sign in.
 */
export function failure(error: unknown, context: { returnTo: string; what: string }): HTMLElement {
  const kind: FailureKind = error instanceof ApiError ? error.kind : "unavailable";
  const text = MESSAGES[kind];
  return el(
    "div",
    { class: "state state--error", role: "alert" },
    el("h2", { class: "state__title", text: text.title }),
    el("p", { class: "state__body", text: text.body(context.what) }),
    kind === "unauthenticated" || kind === "not_found"
      ? el(
          "a",
          { class: "button button--primary", href: signInPath(context.returnTo), "data-external": true },
          "Sign in with GitHub",
        )
      : el("button", { class: "button button--primary", type: "button", "data-retry": true }, "Try again"),
    el("p", { class: "state__hint", text: text.hint }),
  );
}

const MESSAGES: Record<FailureKind, { title: string; body: (what: string) => string; hint: string }> = {
  unauthenticated: {
    title: "Sign in to see this",
    body: (what) => `${what} is not public, so GitHub has to vouch for you first.`,
    hint: "Repofloor never stores your GitHub token in its database — the session lives in the service's memory.",
  },
  not_found: {
    title: "Not found, or not yours",
    body: (what) =>
      `${what} either does not exist here yet, or your GitHub account cannot see it. Repofloor cannot tell you which — the api answers both alike on purpose, so that the existence of a private repository stays private.`,
    hint: "If it is private, sign in with an account that has access. If the App was just installed, the office appears after its first webhook.",
  },
  unavailable: {
    title: "Repofloor could not ask GitHub",
    body: (what) => `${what} could not be loaded because the service could not reach GitHub or its own database.`,
    hint: "Nothing is wrong with your account. This is ours to fix; retrying in a moment usually works.",
  },
  offline: {
    title: "No connection",
    body: () => "The request never left this browser. You are probably offline.",
    hint: "The page keeps showing the last thing it loaded until the network comes back.",
  },
  bad_response: {
    title: "Unexpected answer",
    body: (what) => `${what} came back in a shape this page does not understand — probably a version mismatch.`,
    hint: "The protocol version is pinned; a server newer than this page can cause it. Reloading picks up a newer page.",
  },
};

/** Wire the "Try again" button a `failure()` may contain. */
export function onRetry(node: HTMLElement, retry: () => void): void {
  node.querySelector<HTMLButtonElement>("[data-retry]")?.addEventListener("click", retry);
}
