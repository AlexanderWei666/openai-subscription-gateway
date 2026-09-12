import { test } from "node:test";
import assert from "node:assert/strict";
import { redact, registerSecret } from "../../src/log.ts";
import { fakeJwt } from "../helpers/fixtures.ts";

test("已登记密钥被掩码", () => {
  registerSecret("super-secret-refresh-token-123");
  assert.equal(redact("token=super-secret-refresh-token-123 ok"), "token=[REDACTED] ok");
});

test("Bearer 头与 JWT 形态被掩码", () => {
  const jwt = fakeJwt({ exp: 2000000000, sub: "abc123" });
  const out = redact(`Authorization: Bearer ${jwt}`);
  assert.ok(!out.includes(jwt), "JWT 不得残留");
  assert.ok(out.includes("[REDACTED"));
});

test("短值不登记(防误伤)", () => {
  registerSecret("abc");
  assert.equal(redact("abc abc"), "abc abc");
});

test("普通文本不受影响", () => {
  assert.equal(redact("model=gpt-test-a status=200"), "model=gpt-test-a status=200");
});
