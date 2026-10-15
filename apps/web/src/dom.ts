/**
 * Three functions, so no view has to write `document.createElement` five times a row.
 * No framework: this app renders four pages, and a dependency that renders four pages
 * is a dependency we would have to keep (ARCHITECTURE: "thin; most logic is in packages").
 */

type Attrs = Record<string, string | number | boolean | undefined>;
type Child = Node | string | null | undefined | false;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue;
    if (key === "class") node.className = String(value);
    else if (key === "text") node.textContent = String(value);
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  node.append(...children.filter((c): c is Node | string => c !== null && c !== undefined && c !== false));
  return node;
}

export function clear(node: HTMLElement): void {
  node.replaceChildren();
}

/** Relative time, in the one unit that matters. No library, no per-person durations. */
export function ago(iso: string, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (!Number.isFinite(seconds)) return "";
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** `17:04:22` — the status bar's clock, in the reader's own locale. */
export function clockText(at: Date = new Date()): string {
  return at.toLocaleTimeString();
}
