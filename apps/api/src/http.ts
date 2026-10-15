/**
 * The handful of `node:http` helpers the routes share. No framework (ADR 0001): the
 * service is a dozen routes, and this is the whole of what a framework would give us.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

/** GitHub rejects deliveries above 25 MB; so do we, before buffering them. */
export const MAX_BODY_BYTES = 25 * 1024 * 1024;

export function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    // Authorized snapshots and sign-in answers must never land in a shared cache.
    "cache-control": "no-store",
  });
  res.end(payload);
}

/** A 302 to `location`, keeping any `Set-Cookie` already staged on the response. */
export function redirect(res: ServerResponse, location: string): void {
  res.writeHead(302, { location, "cache-control": "no-store", "content-length": 0 });
  res.end();
}

/** Stage one more `Set-Cookie` without dropping the ones already there. */
export function addCookie(res: ServerResponse, cookie: string): void {
  const existing = res.getHeader("set-cookie");
  const all = Array.isArray(existing) ? [...existing, cookie] : existing ? [String(existing), cookie] : [cookie];
  res.setHeader("set-cookie", all);
}

export function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  const first = Array.isArray(value) ? value[0] : value;
  return first && first.length > 0 ? first : undefined;
}

export function readBody(req: IncomingMessage, limit = MAX_BODY_BYTES): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("body_too_large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/**
 * A post-sign-in destination we are willing to send a browser to: a path on our own
 * site. Anything absolute, protocol-relative or otherwise exotic is dropped rather
 * than redirected to — an open redirect in a sign-in flow is a phishing primitive.
 */
export function safeReturnTo(value: string | null | undefined, fallback = "/"): string {
  if (typeof value !== "string" || value.length === 0) return fallback;
  if (!value.startsWith("/") || value.startsWith("//")) return fallback;
  if (/[\r\n]/.test(value)) return fallback;
  return value;
}
