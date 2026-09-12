import { UpstreamError } from "../upstream/codex.ts";

/**
 * 对下游的稳定 OpenAI 风格错误。映射契约:docs/UPSTREAM.md §14。
 * 原则:保留上游有用信息(message/code),剥掉一切敏感物,状态码稳定。
 */

export class ApiError extends Error {
  readonly status: number;
  readonly type: string;
  readonly code: string | null;
  readonly param: string | null;
  /** 需要透传的响应头(如 429 的 Retry-After) */
  readonly extraHeaders: Record<string, string>;

  constructor(status: number, type: string, message: string, opts: {
    code?: string | null;
    param?: string | null;
    extraHeaders?: Record<string, string>;
  } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.type = type;
    this.code = opts.code ?? null;
    this.param = opts.param ?? null;
    this.extraHeaders = opts.extraHeaders ?? {};
  }
}

export function apiErrorBody(err: ApiError): {
  error: { message: string; type: string; code: string | null; param: string | null };
} {
  return {
    error: {
      message: err.message,
      type: err.type,
      code: err.code,
      param: err.param,
    },
  };
}

interface UpstreamErrorJson {
  error?: { message?: unknown; type?: unknown; code?: unknown };
  message?: unknown;
}

/** 从上游错误体里提取 OpenAI 风格的 message/code;提取不到就给通用文案 */
function parseUpstreamBody(body: string | null): { message: string | null; code: string | null } {
  if (!body) return { message: null, code: null };
  try {
    const parsed = JSON.parse(body) as UpstreamErrorJson;
    const message =
      typeof parsed.error?.message === "string"
        ? parsed.error.message
        : typeof parsed.message === "string"
          ? parsed.message
          : null;
    const code = typeof parsed.error?.code === "string" ? parsed.error.code : null;
    return { message, code };
  } catch {
    return { message: null, code: null };
  }
}

export function invalidRequest(message: string, param: string | null = null): ApiError {
  return new ApiError(400, "invalid_request_error", message, { param });
}

export function modelNotFound(model: string): ApiError {
  return new ApiError(404, "invalid_request_error", `The model \`${model}\` does not exist or is not available.`, {
    code: "model_not_found",
    param: "model",
  });
}

export function notAuthenticated(message = "Not authenticated. Run `osg login` first."): ApiError {
  return new ApiError(401, "authentication_error", message, { code: "not_authenticated" });
}

/** UpstreamError → 稳定 ApiError(docs/UPSTREAM.md §14 映射表) */
export function mapUpstreamError(err: UpstreamError): ApiError {
  if (err.kind === "timeout") {
    return new ApiError(504, "upstream_timeout", "Upstream request timed out.", { code: "upstream_timeout" });
  }
  if (err.kind === "network") {
    return new ApiError(503, "upstream_unavailable", "Upstream is unreachable.", { code: "upstream_unavailable" });
  }
  if (err.kind === "protocol") {
    return new ApiError(502, "upstream_error", `Upstream protocol error: ${err.message}`, { code: "upstream_protocol" });
  }
  // kind === "http"
  const { message, code } = parseUpstreamBody(err.body);
  switch (err.status) {
    case 400:
      return new ApiError(400, "invalid_request_error", message ?? "Invalid request (upstream).", { code });
    case 401:
      return notAuthenticated("Upstream rejected credentials after refresh. Run `osg login` again.");
    case 404:
      return new ApiError(404, "invalid_request_error", message ?? "Not found (upstream).", { code: code ?? "not_found" });
    case 429: {
      const extraHeaders: Record<string, string> = {};
      const retryAfter = err.headers?.get("retry-after");
      if (retryAfter) extraHeaders["retry-after"] = retryAfter;
      return new ApiError(429, "rate_limit_error", message ?? "Rate limit or quota exceeded (upstream).", {
        code: code ?? "rate_limit_exceeded",
        extraHeaders,
      });
    }
    default:
      if (err.status !== null && err.status >= 500) {
        return new ApiError(502, "upstream_error", message ?? `Upstream error (status ${err.status}).`, {
          code: code ?? "upstream_5xx",
        });
      }
      return new ApiError(502, "upstream_error", message ?? `Unexpected upstream status ${err.status ?? "?"}.`, {
        code: code ?? "upstream_unexpected",
      });
  }
}

/** 兜底:任何异常 → ApiError(已知类型直传) */
export function toApiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  if (err instanceof UpstreamError) return mapUpstreamError(err);
  const msg = err instanceof Error ? err.message : String(err);
  return new ApiError(500, "internal_error", msg, { code: "internal" });
}
