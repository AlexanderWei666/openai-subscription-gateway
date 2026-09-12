import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeJwtPayload, extractAccountId, jwtExpiration } from "../../src/auth/jwt.ts";
import { fakeJwt } from "../helpers/fixtures.ts";

test("decodeJwtPayload 正常解码", () => {
  const token = fakeJwt({ sub: "user-1", exp: 2000000000 });
  assert.equal(decodeJwtPayload(token).sub, "user-1");
});

test("jwtExpiration 取 exp;非法 token 返回 null", () => {
  assert.equal(jwtExpiration(fakeJwt({ exp: 2000000000 })), 2000000000);
  assert.equal(jwtExpiration("not-a-jwt"), null);
  assert.equal(jwtExpiration(fakeJwt({ sub: "x" })), null);
});

test("extractAccountId: 标准 claim 路径 https://api.openai.com/auth", () => {
  const token = fakeJwt({
    "https://api.openai.com/auth": { chatgpt_account_id: "acct-abc" },
  });
  assert.equal(extractAccountId(token), "acct-abc");
});

test("extractAccountId: 顶层兜底 / 缺失返回 null", () => {
  assert.equal(extractAccountId(fakeJwt({ chatgpt_account_id: "acct-top" })), "acct-top");
  assert.equal(extractAccountId(fakeJwt({ sub: "x" })), null);
  assert.equal(extractAccountId("garbage"), null);
});
