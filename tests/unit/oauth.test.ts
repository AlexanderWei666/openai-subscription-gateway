import { test } from "node:test";
import assert from "node:assert/strict";
import { needsRefresh, refreshTokens, buildAuthorizeUrl } from "../../src/auth/oauth.ts";
import { UPSTREAM } from "../../src/config.ts";
import { fakeJwt } from "../helpers/fixtures.ts";
import type { TokenData } from "../../src/auth/store.ts";

const NOW = 1_800_000_000;

function tokenExp(sec: number): TokenData {
  return {
    idToken: fakeJwt({ sub: "u" }),
    accessToken: fakeJwt({ exp: sec }),
    refreshToken: "rt-current",
    accountId: "acct-x",
  };
}

test("needsRefresh: 过期窗口内触发,窗口外不触发,无 exp 触发", () => {
  assert.equal(needsRefresh(fakeJwt({ exp: NOW + 100 }), 300, NOW), true);
  assert.equal(needsRefresh(fakeJwt({ exp: NOW + 1000 }), 300, NOW), false);
  assert.equal(needsRefresh("no-exp-here", 300, NOW), true);
});

/** 用 mock fetch 验证 refresh 的 wire 契约与旧 refresh_token 保留语义 */
function withMockFetch(handler: (url: string, body: string, contentType: string) => { status: number; json: unknown }, fn: () => Promise<void>): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const body = String(init?.body ?? "");
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const r = handler(url, body, headers["content-type"] ?? "");
    return new Response(JSON.stringify(r.json), { status: r.status });
  }) as typeof fetch;
  return fn().finally(() => {
    globalThis.fetch = original;
  });
}

test("refresh: JSON body 契约(client_id/grant_type/refresh_token,无 secret)", async () => {
  const current = tokenExp(NOW + 100);
  await withMockFetch(
    (url, body, contentType) => {
      assert.equal(url, `${UPSTREAM.oauthIssuer}/oauth/token`);
      assert.equal(contentType, "application/json");
      const parsed = JSON.parse(body) as Record<string, unknown>;
      assert.deepEqual(Object.keys(parsed).sort(), ["client_id", "grant_type", "refresh_token"]);
      assert.equal(parsed.client_id, UPSTREAM.oauthClientId);
      assert.equal(parsed.grant_type, "refresh_token");
      assert.equal(parsed.refresh_token, "rt-current");
      return {
        status: 200,
        json: { access_token: fakeJwt({ exp: NOW + 3600 }), id_token: fakeJwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-new" } }) },
      };
    },
    async () => {
      const next = await refreshTokens(current);
      assert.equal(next.refreshToken, "rt-current", "响应无新 refresh_token → 必须保留旧的");
      assert.equal(next.accountId, "acct-new", "新 id_token → 重新提取 account_id");
      assert.notEqual(next.accessToken, current.accessToken);
    },
  );
});

test("refresh: 响应带新 refresh_token 时才替换", async () => {
  const current = tokenExp(NOW + 100);
  await withMockFetch(
    () => ({ status: 200, json: { access_token: fakeJwt({ exp: NOW + 3600 }), refresh_token: "rt-rotated" } }),
    async () => {
      const next = await refreshTokens(current);
      assert.equal(next.refreshToken, "rt-rotated");
      assert.equal(next.accountId, "acct-x", "无新 id_token → 保留原 account_id");
    },
  );
});

test("authorize URL 逐字契约(docs/UPSTREAM.md §2)", () => {
  const url = new URL(
    buildAuthorizeUrl({ redirectUri: "http://localhost:1455/auth/callback", state: "st", codeChallenge: "cc" }),
  );
  assert.equal(url.origin + url.pathname, `${UPSTREAM.oauthIssuer}/oauth/authorize`);
  const p = url.searchParams;
  assert.equal(p.get("response_type"), "code");
  assert.equal(p.get("client_id"), UPSTREAM.oauthClientId);
  assert.equal(p.get("redirect_uri"), "http://localhost:1455/auth/callback");
  assert.equal(p.get("scope"), UPSTREAM.oauthScope);
  assert.equal(p.get("code_challenge"), "cc");
  assert.equal(p.get("code_challenge_method"), "S256");
  assert.equal(p.get("id_token_add_organizations"), "true");
  assert.equal(p.get("codex_cli_simplified_flow"), "true");
  assert.equal(p.get("state"), "st");
  assert.equal(p.get("originator"), "codex_cli_rs");
});
