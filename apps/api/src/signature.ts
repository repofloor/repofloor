/**
 * GitHub App webhook signature verification.
 *
 * GitHub signs every delivery with HMAC-SHA256 over the *raw* request body using the
 * webhook secret, and sends it as `X-Hub-Signature-256: sha256=<hex>`.
 * The body must be the exact bytes received — re-serializing the parsed JSON changes
 * the digest.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export const SIGNATURE_HEADER = "x-hub-signature-256";

/** The value GitHub would send for this body and secret. */
export function signWebhook(secret: string, body: Buffer | string): string {
  const mac = createHmac("sha256", secret);
  mac.update(body);
  return `sha256=${mac.digest("hex")}`;
}

/**
 * Constant-time check of a delivery signature.
 * Returns false (never throws) for a missing, malformed or wrong signature.
 */
export function verifyWebhookSignature(
  secret: string,
  body: Buffer | string,
  header: string | string[] | undefined,
): boolean {
  if (!secret) return false;
  const received = Array.isArray(header) ? header[0] : header;
  if (typeof received !== "string" || !received.startsWith("sha256=")) return false;

  const expected = Buffer.from(signWebhook(secret, body), "utf8");
  const actual = Buffer.from(received, "utf8");
  // timingSafeEqual throws on a length mismatch; a wrong length is a wrong signature.
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}
