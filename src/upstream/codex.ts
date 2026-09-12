import { randomUUID } from "node:crypto";
import type { Config } from "../config.ts";
import { GATEWAY_VERSION } from "../config.ts";
import { log } from "../log.ts";

/**
 * 极薄 Codex 上游客户端。全项目唯一知道 Codex 私有 header/端点的地方
 * (OAuth 细节在 auth/)。契约:docs/UPSTREAM.md §4/§5/§14。
 */

export type UpstreamErrorKind = "http" | "network" | "timeout" | "protocol";

export class UpstreamError extends Error {
  readonly kind: UpstreamErrorKind;
  readonly status: number | null;
  /** 上游响应体原文(可能含错误细节;上游不会回传我们的密钥) */
  readonly body: string | null;
  readonly headers: Headers | null;

  constructor(kind: UpstreamErrorKind, message: string, opts: {
    status?: number | null;
    body?: string | null;
    headers?: Headers | null;
  } = {}) {
    super(message);
    this.name = "UpstreamError";
    this.kind = kind;
    this.status = opts.status ?? null;
    this.body = opts.body ?? null;
    this.headers = opts.headers ?? null;
  }
}

export interface UpstreamAuth {
  accessToken: string;
  accountId: string | null;
}

/** 由 auth 层提供:取当前可用凭证;forceRefresh 用于 401 恢复 */
export type AuthProvider = (opts: { forceRefresh?: boolean | undefined }) => Promise<UpstreamAuth | null>;

// ---------------------------------------------------------------------------
// 请求归一化:公开 OpenAI Responses API → Codex backend 实际接受面
// 依据:docs/UPSTREAM.md §6/§7/§11(2026-09-11 真实账号逐参数探测)
// ---------------------------------------------------------------------------

export interface NormalizationNote {
  param: string;
  action: "stripped" | "rewritten" | "normalized";
  detail: string;
}

/** Codex backend 明确拒绝(400 Unsupported parameter)的参数 */
const UPSTREAM_UNSUPPORTED_PARAMS = [
  "temperature",
  "top_p",
  "truncation",
  "metadata",
  "max_output_tokens",
  "max_tokens",
] as const;

/**
 * 把标准 OpenAI Responses 请求体归一化为 Codex backend 可接受的形式。
 * 只放上游驱动的 wire 怪癖;每个改动返回 note 供透明上报。
 */
export function normalizeForCodex(input: Record<string, unknown>): {
  body: Record<string, unknown>;
  notes: NormalizationNote[];
} {
  const body = { ...input };
  const notes: NormalizationNote[] = [];

  // 1. input 字符串 → message item 列表(上游:"Input must be a list")
  if (typeof body.input === "string") {
    body.input = [
      { type: "message", role: "user", content: [{ type: "input_text", text: body.input }] },
    ];
    notes.push({ param: "input", action: "normalized", detail: "string->message-list" });
  }

  // 2. 上游不支持的参数:剥离(语义变化通过 notes 透明上报)
  for (const p of UPSTREAM_UNSUPPORTED_PARAMS) {
    if (body[p] !== undefined) {
      delete body[p];
      notes.push({ param: p, action: "stripped", detail: "unsupported by codex backend" });
    }
  }

  // 3. service_tier 映射(上游实测:fast/auto/flex 400;priority/default 200)
  if (body.service_tier === "fast") {
    body.service_tier = "priority";
    notes.push({ param: "service_tier", action: "rewritten", detail: "fast->priority" });
  } else if (body.service_tier === "auto") {
    delete body.service_tier;
    notes.push({ param: "service_tier", action: "stripped", detail: "auto->omitted(=default)" });
  }

  return { body, notes };
}

export class CodexUpstream {
  private readonly config: Config;
  private readonly getAuth: AuthProvider;
  /** 进程级 session id(对齐 CLI 的 session-id 语义,见 UPSTREAM.md §5) */
  private readonly sessionId = randomUUID();

  constructor(config: Config, getAuth: AuthProvider) {
    this.config = config;
    this.getAuth = getAuth;
  }

  private buildHeaders(auth: UpstreamAuth): Record<string, string> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${auth.accessToken}`,
      originator: "codex_cli_rs",
      "user-agent": `codex_cli_rs/${GATEWAY_VERSION} (${process.platform} ${process.arch}) osg/${GATEWAY_VERSION}`,
      "session-id": this.sessionId,
      "OAI-Product-Sku": "codex",
      accept: "application/json",
    };
    if (auth.accountId) headers["chatgpt-account-id"] = auth.accountId;
    return headers;
  }

  private url(pathWithQuery: string): string {
    return `${this.config.upstreamBaseUrl}${pathWithQuery}`;
  }

  /**
   * GET JSON(用于 models 等)。401 → 强制刷新重试一次。
   */
  async getJson(pathWithQuery: string): Promise<{ status: number; json: unknown; headers: Headers }> {
    let auth = await this.requireAuth(false);
    let res = await this.fetchWithTimeout(this.url(pathWithQuery), {
      method: "GET",
      headers: this.buildHeaders(auth),
    });
    if (res.status === 401) {
      auth = await this.requireAuth(true);
      res = await this.fetchWithTimeout(this.url(pathWithQuery), {
        method: "GET",
        headers: this.buildHeaders(auth),
      });
    }
    const text = await res.text();
    if (!res.ok) {
      throw new UpstreamError("http", `upstream GET ${pathWithQuery} -> ${res.status}`, {
        status: res.status,
        body: text.slice(0, 2000),
        headers: res.headers,
      });
    }
    try {
      return { status: res.status, json: JSON.parse(text), headers: res.headers };
    } catch {
      throw new UpstreamError("protocol", `upstream returned non-JSON for ${pathWithQuery}`, {
        status: res.status,
        body: text.slice(0, 500),
        headers: res.headers,
      });
    }
  }

  /**
   * POST /responses。上游恒 stream=true;返回原始 Response 由调用方解析 SSE。
   * 超时语义:只覆盖到响应头到达;流式 body 不设总时限(长生成是常态)。
   *
   * 连接阶段自动重试(docs/DESIGN.md "稳定性"):本机网络/代理链路的瞬断
   * (fetch failed)不应把整个请求推给下游重试。因为上游 store=false 且
   * 此时尚未向下游写出任何字节,重试是幂等安全的;一旦开始流式下发就
   * 不再重试(那会产生重复输出)。
   */
  async postResponsesStream(body: unknown, opts: { maxAttempts?: number } = {}): Promise<Response> {
    const maxAttempts = opts.maxAttempts ?? 3;
    let lastErr: unknown = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await this.postResponsesOnce(body);
      } catch (err) {
        lastErr = err;
        const retryable =
          err instanceof UpstreamError && (err.kind === "network" || err.kind === "timeout");
        if (!retryable || attempt === maxAttempts) throw err;
        const delayMs = Math.round(300 * 2 ** (attempt - 1) + Math.random() * 200);
        log.warn(
          `上游连接失败(${(err as UpstreamError).kind}),${delayMs}ms 后重试 ${attempt}/${maxAttempts - 1}`,
        );
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
    throw lastErr;
  }

  private async postResponsesOnce(body: unknown): Promise<Response> {
    let auth = await this.requireAuth(false);
    let res = await this.fetchStream(body, auth);
    if (res.status === 401) {
      await res.body?.cancel().catch(() => {});
      auth = await this.requireAuth(true);
      res = await this.fetchStream(body, auth);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new UpstreamError("http", `upstream POST /responses -> ${res.status}`, {
        status: res.status,
        body: text.slice(0, 2000),
        headers: res.headers,
      });
    }
    if (!res.body) {
      throw new UpstreamError("protocol", "upstream response has no body", { status: res.status });
    }
    return res;
  }

  private async fetchStream(body: unknown, auth: UpstreamAuth): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.upstreamTimeoutMs);
    try {
      const res = await fetch(this.url("/responses"), {
        method: "POST",
        headers: {
          ...this.buildHeaders(auth),
          "content-type": "application/json",
          accept: "text/event-stream",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timer);
      return res;
    } catch (err) {
      clearTimeout(timer);
      throw classifyFetchError(err);
    }
  }

  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    try {
      return await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(this.config.upstreamTimeoutMs),
      });
    } catch (err) {
      throw classifyFetchError(err);
    }
  }

  private async requireAuth(forceRefresh: boolean): Promise<UpstreamAuth> {
    const auth = await this.getAuth({ forceRefresh });
    if (!auth) {
      throw new UpstreamError("http", "not authenticated: run `osg login`", { status: 401 });
    }
    return auth;
  }
}

function classifyFetchError(err: unknown): UpstreamError {
  if (err instanceof UpstreamError) return err;
  const msg = err instanceof Error ? err.message : String(err);
  if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
    return new UpstreamError("timeout", `upstream timeout: ${msg}`);
  }
  log.debug("upstream network error", msg);
  return new UpstreamError("network", `upstream network error: ${msg}`);
}
