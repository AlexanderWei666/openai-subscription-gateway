import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CredentialStore, type StoredAuth } from "../../src/auth/store.ts";

async function withTempHome(fn: (home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(path.join(tmpdir(), "osg-store-"));
  try {
    await fn(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

const SAMPLE: StoredAuth = {
  tokens: {
    idToken: "id-token-value",
    accessToken: "access-token-value",
    refreshToken: "refresh-token-value",
    accountId: "acct-1",
  },
  lastRefresh: "2026-09-10T00:00:00.000Z",
};

test("save → load 往返;文件为 snake_case 契约字段", async () => {
  await withTempHome(async (home) => {
    const store = new CredentialStore(home);
    await store.save(SAMPLE);
    const loaded = await store.load();
    assert.deepEqual(loaded, SAMPLE);

    const raw = JSON.parse(await readFile(store.authPath, "utf8")) as Record<string, unknown>;
    const tokens = raw.tokens as Record<string, unknown>;
    assert.equal(tokens.access_token, "access-token-value");
    assert.equal(tokens.refresh_token, "refresh-token-value");
    assert.equal(tokens.account_id, "acct-1");
    assert.equal(raw.last_refresh, SAMPLE.lastRefresh);
  });
});

test("未登录 load 返回 null;clear 幂等", async () => {
  await withTempHome(async (home) => {
    const store = new CredentialStore(home);
    assert.equal(await store.load(), null);
    await store.clear(); // 不存在的文件不报错
    await store.save(SAMPLE);
    await store.clear();
    assert.equal(await store.load(), null);
  });
});

test("损坏文件报错(不静默当未登录)", async () => {
  await withTempHome(async (home) => {
    const store = new CredentialStore(home);
    await writeFile(store.authPath, JSON.stringify({ tokens: {} }), "utf8");
    await assert.rejects(() => store.load(), (err: unknown) => {
      assert.match(err instanceof Error ? err.message : "", /corrupt credential/);
      assert.equal(err instanceof Error ? err.message.includes(store.authPath) : false, false);
      return true;
    });
  });
});

test("非法 JSON 凭证 → 明确报 corrupt(不裸抛 SyntaxError)", async () => {
  await withTempHome(async (home) => {
    const store = new CredentialStore(home);
    await writeFile(store.authPath, "{truncated json", "utf8");
    await assert.rejects(() => store.load(), (err: unknown) => {
      assert.match(err instanceof Error ? err.message : "", /corrupt credential file/);
      assert.equal(err instanceof Error ? err.message.includes(store.authPath) : false, false);
      return true;
    });
  });
});

test("文件权限 0600(仅 POSIX 强校验)", async () => {
  await withTempHome(async (home) => {
    const store = new CredentialStore(home);
    await store.save(SAMPLE);
    const mode = (await stat(store.authPath)).mode & 0o777;
    if (process.platform === "win32") {
      // Windows NTFS 不遵守 posix mode;doctor 负责提示,这里只确保文件存在
      assert.ok((await stat(store.authPath)).isFile());
    } else {
      assert.equal(mode, 0o600, `mode=${mode.toString(8)}`);
    }
  });
});

test("save 是原子写:完成后无 tmp 残留", async () => {
  await withTempHome(async (home) => {
    const store = new CredentialStore(home);
    await store.save(SAMPLE);
    const { readdir } = await import("node:fs/promises");
    const files = await readdir(home);
    assert.deepEqual(files.filter((f) => f.includes("tmp")), []);
  });
});
