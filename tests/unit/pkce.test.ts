import { test } from "node:test";
import assert from "node:assert/strict";
import { base64url, challengeForVerifier, generateState, generateVerifier } from "../../src/auth/pkce.ts";
import { createHash } from "node:crypto";

test("verifier: 64 字节 base64url 无 pad,字符集合法", () => {
  const v = generateVerifier();
  assert.match(v, /^[A-Za-z0-9_-]+$/);
  assert.ok(v.length >= 43 && v.length <= 128, `len=${v.length}`);
  assert.equal(Buffer.from(v.replace(/-/g, "+").replace(/_/g, "/"), "base64").length, 64);
});

test("challenge = BASE64URL(SHA256(verifier)) 无 pad", () => {
  const v = "test-verifier-123";
  const expect = createHash("sha256").update(v, "utf8").digest();
  assert.equal(challengeForVerifier(v), base64url(expect));
  assert.ok(!challengeForVerifier(v).includes("="));
});

test("state: 32 字节,两次生成不同", () => {
  const a = generateState();
  const b = generateState();
  assert.notEqual(a, b);
  assert.match(a, /^[A-Za-z0-9_-]+$/);
});
