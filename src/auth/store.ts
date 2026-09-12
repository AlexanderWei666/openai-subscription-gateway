import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { registerSecret } from "../log.ts";

/**
 * 凭证存储:<home>/auth.json。
 * 安全契约(docs/DESIGN.md):
 * - 目录 0700 / 文件 0600(Windows 上 chmod 尽力而为,由 doctor 复核)
 * - 临时文件 + rename 原子写
 * - 与 Codex CLI 的 ~/.codex/auth.json 完全独立
 */

export interface TokenData {
  idToken: string;
  accessToken: string;
  refreshToken: string;
  accountId: string | null;
}

export interface StoredAuth {
  tokens: TokenData;
  /** ISO 时间,对齐 Codex auth.json 的 last_refresh 语义 */
  lastRefresh: string;
}

interface AuthFileShape {
  tokens?: {
    id_token?: string;
    access_token?: string;
    refresh_token?: string;
    account_id?: string | null;
  };
  last_refresh?: string;
}

export class CredentialStore {
  readonly home: string;

  constructor(home: string) {
    this.home = home;
  }

  get authPath(): string {
    return path.join(this.home, "auth.json");
  }

  async load(): Promise<StoredAuth | null> {
    let raw: string;
    try {
      raw = await readFile(this.authPath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
    let parsed: AuthFileShape;
    try {
      parsed = JSON.parse(raw) as AuthFileShape;
    } catch {
      // 文件被截断/手改成非法 JSON:明确报损坏,不裸抛 SyntaxError
      throw new Error("corrupt credential file");
    }
    const t = parsed.tokens;
    if (!t?.access_token || !t.refresh_token || !t.id_token) {
      throw new Error("corrupt credential file");
    }
    // 读入即登记密钥,保证任何后续日志都不会泄漏
    registerSecret(t.access_token);
    registerSecret(t.refresh_token);
    registerSecret(t.id_token);
    return {
      tokens: {
        idToken: t.id_token,
        accessToken: t.access_token,
        refreshToken: t.refresh_token,
        accountId: t.account_id ?? null,
      },
      lastRefresh: parsed.last_refresh ?? "",
    };
  }

  async save(auth: StoredAuth): Promise<void> {
    await mkdir(this.home, { recursive: true, mode: 0o700 });
    await chmod(this.home, 0o700).catch(() => {});
    const body: AuthFileShape = {
      tokens: {
        id_token: auth.tokens.idToken,
        access_token: auth.tokens.accessToken,
        refresh_token: auth.tokens.refreshToken,
        account_id: auth.tokens.accountId,
      },
      last_refresh: auth.lastRefresh,
    };
    // 原子写:临时文件 + rename
    const tmp = `${this.authPath}.tmp-${process.pid}`;
    await writeFile(tmp, JSON.stringify(body, null, 2) + "\n", { mode: 0o600 });
    await chmod(tmp, 0o600).catch(() => {});
    await rename(tmp, this.authPath);
    registerSecret(auth.tokens.accessToken);
    registerSecret(auth.tokens.refreshToken);
    registerSecret(auth.tokens.idToken);
  }

  /** 只删除自己的凭证文件,绝不触碰 ~/.codex */
  async clear(): Promise<void> {
    await rm(this.authPath, { force: true });
  }
}
