import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { TokenManager, OAUTH_HTTP_TIMEOUT_MS, refreshTokens } from "../../src/auth/oauth.ts";
import { CredentialStore } from "../../src/auth/store.ts";
import { UPSTREAM } from "../../src/config.ts";
import { fakeJwt } from "../helpers/fixtures.ts";

/**
 * v0.1.1:OAuth refresh single-flight 加固。
 * 目标:并发刷新只能产生**一次** token endpoint 调用;排队者在锁内复用结果。
 */

const NOW = 1_800_000_000;

async function withTempHome(fn: (home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(path.join(tmpdir(), "osg-sf-"));
  try {
    await fn(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

/** 即将过期(在刷新窗口内)的凭证 */
function expiringAuth() {
  return {
    tokens: {
      idToken: fakeJwt({ sub: "u" }),
      accessToken: fakeJwt({ exp: Math.floor(Date.now() / 1000) + 60 }),
      refreshToken: "rt-old",
      accountId: "acct-1",
    },
    lastRefresh: "2026-09-01T00:00:00.000Z",
  };
}

/** 用 mock fetch 统计 token endpoint 调用次数;可注入延迟制造并发重叠 */
function withCountingFetch(
  opts: { delayMs?: number; throwTimeout?: boolean } = {},
): { calls: () => number; sawSignal: () => boolean; restore: () => void } {
  const original = globalThis.fetch;
  let calls = 0;
  let sawSignal = false;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    calls++;
    if (init?.signal) sawSignal = true;
    if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
    if (opts.throwTimeout) {
      const err = new Error("The operation was aborted due to timeout");
      err.name = "TimeoutError";
      throw err;
    }
    return new Response(
      JSON.stringify({
        access_token: fakeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 }),
        id_token: fakeJwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" } }),
        refresh_token: "rt-new",
      }),
      { status: 200 },
    );
  }) as typeof fetch;
  return {
    calls: () => calls,
    sawSignal: () => sawSignal,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

test("并发 refresh:5 个并发调用只触发 1 次 token endpoint 调用,且全部成功", async () => {
  await withTempHome(async (home) => {
    const store = new CredentialStore(home);
    await store.save(expiringAuth());
    const tm = new TokenManager(store, 300);
    const mock = withCountingFetch({ delayMs: 30 }); // 制造重叠窗口
    try {
      const results = await Promise.all([
        tm.getFresh(),
        tm.getFresh(),
        tm.getFresh(),
        tm.getFresh(),
        tm.getFresh(),
      ]);
      assert.equal(mock.calls(), 1, `token endpoint 应只被调用一次,实际 ${mock.calls()}`);
      for (const r of results) {
        assert.ok(r, "每个调用都应拿到凭证");
        assert.equal(r.tokens.refreshToken, "rt-new", "都应复用同一刷新结果");
      }
      // 落盘的也应是新凭证(只写一次,无覆盖竞争)
      const persisted = await store.load();
      assert.equal(persisted?.tokens.refreshToken, "rt-new");
      assert.equal(mock.sawSignal(), true, "刷新请求必须带 abort signal(timeout 接线)");
    } finally {
      mock.restore();
    }
  });
});

test("锁内二次判断:刷新完成后 token 已新鲜,后续调用不再打 endpoint", async () => {
  await withTempHome(async (home) => {
    const store = new CredentialStore(home);
    await store.save(expiringAuth());
    const tm = new TokenManager(store, 300);
    const mock = withCountingFetch();
    try {
      await tm.getFresh(); // 第一次:触发刷新
      assert.equal(mock.calls(), 1);
      await tm.getFresh(); // 第二次:token 已新鲜,应直接返回
      await tm.getFresh();
      assert.equal(mock.calls(), 1, "新鲜 token 不应再次刷新");
    } finally {
      mock.restore();
    }
  });
});

test("forceRefresh:401 恢复路径强制刷新(即使 token 看起来新鲜)", async () => {
  await withTempHome(async (home) => {
    const store = new CredentialStore(home);
    await store.save({
      tokens: {
        idToken: fakeJwt({ sub: "u" }),
        accessToken: fakeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 }), // 仍新鲜
        refreshToken: "rt-old",
        accountId: "acct-1",
      },
      lastRefresh: "2026-09-01T00:00:00.000Z",
    });
    const tm = new TokenManager(store, 300);
    const mock = withCountingFetch();
    try {
      await tm.getFresh({ forceRefresh: true });
      assert.equal(mock.calls(), 1, "forceRefresh 必须真刷新");
      assert.equal((await store.load())?.tokens.refreshToken, "rt-new");
    } finally {
      mock.restore();
    }
  });
});

test("并发 force + 例行:复用同一次 in-flight 刷新,仍只调用一次", async () => {
  await withTempHome(async (home) => {
    const store = new CredentialStore(home);
    await store.save(expiringAuth());
    const tm = new TokenManager(store, 300);
    const mock = withCountingFetch({ delayMs: 25 });
    try {
      const [a, b] = await Promise.all([tm.getFresh(), tm.getFresh({ forceRefresh: true })]);
      assert.equal(mock.calls(), 1, "同一时刻只允许一次刷新在飞");
      assert.equal(a?.tokens.refreshToken, "rt-new");
      assert.equal(b?.tokens.refreshToken, "rt-new");
    } finally {
      mock.restore();
    }
  });
});

test("refresh timeout:token endpoint 超时 → 明确错误消息,不泄漏内容", async () => {
  await withTempHome(async (home) => {
    const store = new CredentialStore(home);
    await store.save(expiringAuth());
    const tm = new TokenManager(store, 300);
    const mock = withCountingFetch({ throwTimeout: true });
    try {
      await assert.rejects(
        () => tm.getFresh(),
        (err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          assert.match(msg, /timed out after \d+ms/);
          assert.ok(!msg.includes("rt-"), "错误消息不得包含 token 内容");
          return true;
        },
      );
      assert.equal(mock.calls(), 1, "超时不应自动重试(避免放大压力)");
    } finally {
      mock.restore();
    }
  });
});

test("refreshTokens 直接调用:超时同样映射为明确错误", async () => {
  const mock = withCountingFetch({ throwTimeout: true });
  try {
    await assert.rejects(
      () =>
        refreshTokens({
          idToken: fakeJwt({ sub: "u" }),
          accessToken: fakeJwt({ exp: NOW + 100 }),
          refreshToken: "rt-x",
          accountId: null,
        }),
      /timed out after/,
    );
  } finally {
    mock.restore();
  }
});

test("OAUTH_HTTP_TIMEOUT_MS 为有限值(防止配置退化为永久等待)", () => {
  assert.ok(Number.isFinite(OAUTH_HTTP_TIMEOUT_MS));
  assert.ok(OAUTH_HTTP_TIMEOUT_MS > 0 && OAUTH_HTTP_TIMEOUT_MS <= 120_000);
});

test("未登录:getFresh 返回 null,不触发任何网络调用", async () => {
  await withTempHome(async (home) => {
    const store = new CredentialStore(home);
    const tm = new TokenManager(store, 300);
    const mock = withCountingFetch();
    try {
      assert.equal(await tm.getFresh(), null);
      assert.equal(mock.calls(), 0);
    } finally {
      mock.restore();
    }
  });
});

test("token endpoint 返回非 2xx → OAuthError 带状态码", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })) as typeof fetch;
  try {
    await assert.rejects(
      () =>
        refreshTokens({
          idToken: fakeJwt({ sub: "u" }),
          accessToken: fakeJwt({ exp: NOW + 100 }),
          refreshToken: "rt-x",
          accountId: null,
        }),
      /token endpoint returned 400/,
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("UPSTREAM.refreshWindowSec 语义未变(单飞不改变刷新窗口)", () => {
  assert.equal(UPSTREAM.refreshWindowSec, 300);
});
