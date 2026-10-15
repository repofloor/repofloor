import { test } from "node:test";
import assert from "node:assert/strict";
import { signWebhook, verifyWebhookSignature } from "../src/signature.ts";

const SECRET = "it is a secret to everybody";
const BODY = JSON.stringify({ action: "opened", number: 7 });

test("accepts the signature GitHub would send", () => {
  const signature = signWebhook(SECRET, BODY);
  assert.match(signature, /^sha256=[0-9a-f]{64}$/);
  assert.equal(verifyWebhookSignature(SECRET, BODY, signature), true);
  assert.equal(verifyWebhookSignature(SECRET, Buffer.from(BODY), signature), true);
});

test("rejects a wrong secret, a tampered body and a flipped digest", () => {
  const signature = signWebhook(SECRET, BODY);
  assert.equal(verifyWebhookSignature("other secret", BODY, signature), false);
  assert.equal(verifyWebhookSignature(SECRET, BODY + " ", signature), false);
  const flipped = signature.slice(0, -1) + (signature.endsWith("a") ? "b" : "a");
  assert.equal(verifyWebhookSignature(SECRET, BODY, flipped), false);
});

test("rejects missing, malformed and sha1 signatures without throwing", () => {
  assert.equal(verifyWebhookSignature(SECRET, BODY, undefined), false);
  assert.equal(verifyWebhookSignature(SECRET, BODY, ""), false);
  assert.equal(verifyWebhookSignature(SECRET, BODY, "sha256="), false);
  assert.equal(verifyWebhookSignature(SECRET, BODY, "deadbeef"), false);
  // the retired X-Hub-Signature (sha1) prefix must not be accepted
  assert.equal(verifyWebhookSignature(SECRET, BODY, "sha1=0b1c2d"), false);
  // a secret we do not have configured can never verify
  assert.equal(verifyWebhookSignature("", BODY, signWebhook("", BODY)), false);
});

test("reads only the first value of a repeated header", () => {
  const signature = signWebhook(SECRET, BODY);
  assert.equal(verifyWebhookSignature(SECRET, BODY, [signature, "sha256=nope"]), true);
  assert.equal(verifyWebhookSignature(SECRET, BODY, ["sha256=nope", signature]), false);
});
