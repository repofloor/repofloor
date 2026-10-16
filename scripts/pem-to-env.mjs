/**
 * A GitHub App private key is a multi-line PEM; an env var is one line. This turns the
 * first into the second.
 *
 *   node scripts/pem-to-env.mjs ~/Downloads/your-app.private-key.pem
 *
 * Prints `GITHUB_APP_PRIVATE_KEY=...` for pasting into .env. It only reads the file and
 * writes to stdout — it never stores the key anywhere, and .env is git-ignored and
 * excluded from the Docker build context.
 *
 * `apps/api` accepts the `\n` escapes this produces (see `normalizePem` in
 * src/app-auth.ts), which is why this is safe to do rather than a trick.
 */

import { readFileSync } from "node:fs";

const path = process.argv[2];
if (!path) {
  console.error("usage: node scripts/pem-to-env.mjs <path-to-private-key.pem>");
  process.exit(1);
}

let pem;
try {
  pem = readFileSync(path, "utf8");
} catch (err) {
  console.error(`cannot read ${path}: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
}

if (!pem.includes("-----BEGIN") || !pem.includes("PRIVATE KEY-----")) {
  console.error(`${path} does not look like a PEM private key.`);
  process.exit(1);
}

// Normalise line endings first: a file saved on Windows carries \r\n, and a stray \r
// inside the key makes the parse fail in a way the error message does not explain.
const oneLine = pem.replace(/\r\n/g, "\n").trim().split("\n").join("\\n");

console.log(`GITHUB_APP_PRIVATE_KEY=${oneLine}`);
