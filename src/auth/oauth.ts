import { spawn } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { UPSTREAM } from "../config.ts";
import { log } from "../log.ts";
import { challengeForVerifier, generateState, generateVerifier } from "./pkce.ts";
import { extractAccountId, jwtExpiration } from "./jwt.ts";
import type { CredentialStore, StoredAuth, TokenData } from "./store.ts";

/**
 * ChatGPT/Codex OAuth。wire 契约逐字对齐 docs/UPSTREAM.md §1–§3:
 * - authorize/token/revoke 端点、client_id、scope、callback 端口
 * - code 交换:form-urlencoded,无 client_secret
 * - refresh:JSON body;响应无新 refresh_token 时保留旧的
 * - 过期时间取 access_token JWT 的 exp;account_id 取 id_token claim
 */

export class OAuthError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "OAuthError";
    this.status = status;
  }
}

function tokenEndpoint(): string {
  return `${UPSTREAM.oauthIssuer}/oauth/token`;
}

export function buildAuthorizeUrl(opts: {
  redirectUri: string;
  state: string;
  codeChallenge: string;
}): string {
  const url = new URL(`${UPSTREAM.oauthIssuer}/oauth/authorize`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", UPSTREAM.oauthClientId);
  url.searchParams.set("redirect_uri", opts.redirectUri);
  url.searchParams.set("scope", UPSTREAM.oauthScope);
  url.searchParams.set("code_challenge", opts.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("id_token_add_organizations", "true");
  url.searchParams.set("codex_cli_simplified_flow", "true");
  url.searchParams.set("state", opts.state);
  url.searchParams.set("originator", "codex_cli_rs");
  return url.toString();
}

interface TokenEndpointResponse {
  id_token?: string;
  access_token?: string;
  refresh_token?: string;
}

/** OAuth HTTP 调用的上限(避免 token endpoint 挂起时请求永久等待) */
export const OAUTH_HTTP_TIMEOUT_MS = 30_000;

async function postToken(
  body: string,
  contentType: string,
): Promise<TokenEndpointResponse> {
  let res: Response;
  try {
    res = await fetch(tokenEndpoint(), {
      method: "POST",
      headers: { "content-type": contentType, accept: "application/json" },
      body,
      signal: AbortSignal.timeout(OAUTH_HTTP_TIMEOUT_MS),
    });
  } catch (err) {
    const isTimeout = err instanceof Error && err.name === "TimeoutError";
    throw new OAuthError(
      isTimeout
        ? `token endpoint timed out after ${OAUTH_HTTP_TIMEOUT_MS}ms`
        : `token endpoint unreachable: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const text = await res.text();
  if (!res.ok) {
    // 响应体可能含错误描述,但绝不含我们的密钥;仍仅截断记录
    throw new OAuthError(
      `token endpoint returned ${res.status}: ${text.slice(0, 300)}`,
      res.status,
    );
  }
  return JSON.parse(text) as TokenEndpointResponse;
}

/** 授权码交换(form-urlencoded;无 client_secret) */
export async function exchangeCode(opts: {
  code: string;
  redirectUri: string;
  codeVerifier: string;
}): Promise<TokenData> {
  const params = new URLSearchParams({
    grant_type: "authorization_code",
    code: opts.code,
    redirect_uri: opts.redirectUri,
    client_id: UPSTREAM.oauthClientId,
    code_verifier: opts.codeVerifier,
  });
  const data = await postToken(params.toString(), "application/x-www-form-urlencoded");
  if (!data.id_token || !data.access_token || !data.refresh_token) {
    throw new OAuthError("token response missing required fields");
  }
  return {
    idToken: data.id_token,
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    accountId: extractAccountId(data.id_token),
  };
}

/**
 * 刷新(JSON body)。契约:响应不含新 refresh_token 时保留旧的(docs/UPSTREAM.md §3)。
 */
export async function refreshTokens(current: TokenData): Promise<TokenData> {
  const data = await postToken(
    JSON.stringify({
      client_id: UPSTREAM.oauthClientId,
      grant_type: "refresh_token",
      refresh_token: current.refreshToken,
    }),
    "application/json",
  );
  const idToken = data.id_token ?? current.idToken;
  return {
    idToken,
    accessToken: data.access_token ?? current.accessToken,
    // 关键:不返回新 refresh_token 时保留旧值
    refreshToken: data.refresh_token ?? current.refreshToken,
    accountId: data.id_token ? extractAccountId(idToken) : current.accountId,
  };
}

/** access_token 是否处于"需刷新"窗口(exp 未知时按需要刷新处理) */
export function needsRefresh(accessToken: string, windowSec: number, nowSec: number): boolean {
  const exp = jwtExpiration(accessToken);
  if (exp === null) return true;
  return exp - nowSec <= windowSec;
}

function openBrowser(url: string): void {
  try {
    if (process.platform === "win32") {
      // 关键:URL 必须显式加双引号。cmd.exe 会把未引用的 & 当作命令分隔符,
      // 导致 authorize URL 在第一个 & 处被截断(实测:服务端报 missing_required_parameter)。
      spawn("cmd", ["/c", "start", "", `"${url}"`], { detached: true, stdio: "ignore" }).unref();
    } else if (process.platform === "darwin") {
      spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    } else {
      spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
    }
  } catch {
    log.warn("无法自动打开浏览器,请手动访问上面的 URL");
  }
}

const LOGIN_HTML_OK =
  "<html><body style='font-family:sans-serif'><h2>Login successful</h2><p>You can close this tab and return to the terminal.</p></body></html>";

/**
 * osg login:本地 callback → 浏览器授权 → 交换并保存凭证。
 * 端口策略与 Codex CLI 一致:1455 → 1457 → 随机空闲端口。
 */
export async function login(
  store: CredentialStore,
  opts: { timeoutMs?: number; openUrl?: (url: string) => void } = {},
): Promise<{ accountId: string | null }> {
  const timeoutMs = opts.timeoutMs ?? 5 * 60 * 1000;
  const verifier = generateVerifier();
  const state = generateState();

  const server = http.createServer();
  const ports = [...UPSTREAM.callbackPorts, 0];
  let boundPort: number | null = null;
  for (const port of ports) {
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => resolve());
      });
      boundPort = (server.address() as AddressInfo).port;
      break;
    } catch {
      // 端口被占,试下一个
    }
  }
  if (boundPort === null) throw new OAuthError("no available callback port");

  const redirectUri = `http://localhost:${boundPort}/auth/callback`;
  const url = buildAuthorizeUrl({
    redirectUri,
    state,
    codeChallenge: challengeForVerifier(verifier),
  });

  try {
    const code = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new OAuthError("login timed out")), timeoutMs);
      server.on("request", (req, res) => {
        const u = new URL(req.url ?? "/", `http://localhost:${boundPort}`);
        if (u.pathname !== "/auth/callback") {
          res.writeHead(404).end("not found");
          return;
        }
        const gotState = u.searchParams.get("state");
        const gotCode = u.searchParams.get("code");
        const gotError = u.searchParams.get("error");
        if (gotError) {
          res.writeHead(200, { "content-type": "text/html" }).end(LOGIN_HTML_OK);
          clearTimeout(timer);
          reject(new OAuthError(`authorization error: ${gotError}`));
          return;
        }
        if (gotState !== state) {
          res.writeHead(400).end("State mismatch");
          return;
        }
        if (!gotCode) {
          res.writeHead(400).end("Missing code");
          return;
        }
        res.writeHead(200, { "content-type": "text/html" }).end(LOGIN_HTML_OK);
        clearTimeout(timer);
        resolve(gotCode);
      });
      // 完整 URL 打印到 stdout 作为手动回退。state/code_challenge 是一次性
      // CSRF 参数(非凭证),Codex CLI 同样打印完整 URL;access/refresh token
      // 的红线不适用于此 URL。
      process.stdout.write(`If the browser did not open, visit this URL to log in:\n\n${url}\n\n`);
      (opts.openUrl ?? openBrowser)(url);
    });

    const tokens = await exchangeCode({ code, redirectUri, codeVerifier: verifier });
    await store.save({ tokens, lastRefresh: new Date().toISOString() });
    if (!tokens.accountId) {
      log.warn("未能从 id_token 解析 ChatGPT Account ID;上游可能拒绝请求(claim 形状或已变化,见 docs/UPSTREAM.md §3)");
    }
    return { accountId: tokens.accountId };
  } finally {
    server.close();
  }
}

/**
 * 单飞刷新器:同一时刻全进程只允许一个 refresh 在飞。
 * 401 恢复路径(强制刷新)与例行路径(过期窗口)共用。
 *
 * 双重保护(防 OAuth rotation 下的 credential 覆盖 / 重复刷新):
 *   1. `inFlight` 复用:并发调用只产生一次 token endpoint 调用;
 *   2. 进锁后**重新读取最新 credential 并二次判断**——若在排队期间
 *      已有其他调用完成刷新,这里直接复用,不再打第二次。
 * 注意:已有 inFlight 时新来的 forceRefresh 会复用同一次刷新结果
 * (该结果必然是刚产生的新 token,语义仍正确)。
 */
export class TokenManager {
  private readonly store: CredentialStore;
  private readonly refreshWindowSec: number;
  private inFlight: Promise<StoredAuth> | null = null;

  constructor(store: CredentialStore, refreshWindowSec = UPSTREAM.refreshWindowSec) {
    this.store = store;
    this.refreshWindowSec = refreshWindowSec;
  }

  /** 取可用凭证:过期窗口内自动刷新;未登录返回 null */
  async getFresh(opts: { forceRefresh?: boolean | undefined } = {}): Promise<StoredAuth | null> {
    const auth = await this.store.load();
    if (!auth) return null;
    const force = opts.forceRefresh === true;
    const nowSec = Math.floor(Date.now() / 1000);
    if (!force && !needsRefresh(auth.tokens.accessToken, this.refreshWindowSec, nowSec)) {
      return auth;
    }
    return this.refreshSingleFlight(force);
  }

  private refreshSingleFlight(force: boolean): Promise<StoredAuth> {
    if (!this.inFlight) {
      this.inFlight = (async () => {
        // 进锁后重新读取:排队期间可能已被别的调用刷新
        const latest = await this.store.load();
        if (!latest) throw new OAuthError("credential disappeared during refresh");
        const nowSec = Math.floor(Date.now() / 1000);
        if (!force && !needsRefresh(latest.tokens.accessToken, this.refreshWindowSec, nowSec)) {
          return latest; // 已被并发调用刷新,无需再打 token endpoint
        }
        const tokens = await refreshTokens(latest.tokens);
        const next: StoredAuth = { tokens, lastRefresh: new Date().toISOString() };
        await this.store.save(next);
        log.info("access token 已刷新");
        return next;
      })().finally(() => {
        this.inFlight = null;
      });
    }
    return this.inFlight;
  }
}

/** osg logout:尽力 revoke 后只删除自己的凭证文件 */
export async function logout(store: CredentialStore): Promise<boolean> {
  const auth = await store.load();
  if (!auth) return false;
  try {
    const params = new URLSearchParams({
      token: auth.tokens.refreshToken,
      client_id: UPSTREAM.oauthClientId,
    });
    await fetch(`${UPSTREAM.oauthIssuer}/oauth/revoke`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: params.toString(),
      signal: AbortSignal.timeout(OAUTH_HTTP_TIMEOUT_MS),
    });
  } catch (err) {
    log.warn("revoke 请求失败(继续删除本地凭证)", err instanceof Error ? err.message : String(err));
  }
  await store.clear();
  return true;
}
