import http from "node:http";
import type { Config } from "./config.ts";
import { GATEWAY_VERSION } from "./config.ts";
import type { CodexUpstream } from "./upstream/codex.ts";
import type { ModelCatalog } from "./upstream/catalog.ts";
import { ApiError, apiErrorBody, invalidRequest, toApiError } from "./api/errors.ts";
import { handleModels, handleInternalModels } from "./api/models.ts";
import { handleResponsesNonStream, handleResponsesStream } from "./api/responses.ts";
import { handleChatNonStream, handleChatStream } from "./api/chat-completions.ts";
import { log } from "./log.ts";

/**
 * Node 原生 HTTP server。选型理由(docs/DESIGN.md):5 条路由,
 * 零框架依赖换来对 SSE/背压/取消的完全控制。
 */

const BODY_LIMIT = 32 * 1024 * 1024; // 32MB,覆盖 base64 图片输入

/**
 * 输入项类型统计(仅形状,不含内容)。
 * 用途:从 debug 日志判断客户端是否在做工具循环
 * (function_call + function_call_output 成对出现即为工具往返)。
 */
function inputSummary(input: unknown): Record<string, number> {
  if (typeof input === "string") return { items: 1 };
  if (!Array.isArray(input)) return { items: 0 };
  const counts: Record<string, number> = { items: input.length };
  for (const item of input) {
    if (typeof item !== "object" || item === null) continue;
    const t = (item as Record<string, unknown>).type;
    if (typeof t === "string") counts[t] = (counts[t] ?? 0) + 1;
  }
  return counts;
}

export interface GatewayDeps {
  config: Config;
  upstream: CodexUpstream;
  catalog: ModelCatalog;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
    ...extraHeaders,
  });
  res.end(text);
}

function sendApiError(res: http.ServerResponse, err: ApiError): void {
  if (res.headersSent) {
    // 流已开始:错误只能随流关闭(流内错误已在 responses.ts 内处理)
    if (!res.writableEnded) res.end();
    return;
  }
  sendJson(res, err.status, apiErrorBody(err), err.extraHeaders);
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > BODY_LIMIT) {
      throw invalidRequest(`Request body too large (limit ${BODY_LIMIT} bytes).`);
    }
    chunks.push(buf);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.trim() === "") throw invalidRequest("Request body is empty; JSON object required.");
  try {
    return JSON.parse(text);
  } catch {
    throw invalidRequest("Request body is not valid JSON.");
  }
}

export function createGatewayServer(deps: GatewayDeps): http.Server {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname;
      const method = req.method ?? "GET";

      /**
       * 请求摘要日志(debug 级,默认不输出;只记形状不记内容,便于排查客户端行为)。
       * OSG_LOG_LEVEL=debug 时可见。
       */
      const startedAt = Date.now();
      const summary = (info: Record<string, unknown>): void => {
        log.debug(`${method} ${path}`, { ...info, ms: Date.now() - startedAt });
      };

      // placeholder API key:不校验 Authorization 值(docs/DESIGN.md 信任边界)

      if (method === "GET" && path === "/health") {
        sendJson(res, 200, { status: "ok", version: GATEWAY_VERSION });
        return;
      }
      if (method === "GET" && path === "/v1/models") {
        const { status, body } = await handleModels(deps.catalog);
        sendJson(res, status, body);
        return;
      }
      if (method === "GET" && path === "/internal/models") {
        const { status, body } = await handleInternalModels(deps.catalog);
        sendJson(res, status, body);
        return;
      }
      if (method === "POST" && path === "/v1/responses") {
        const rawBody = await readJsonBody(req);
        const b = rawBody as Record<string, unknown>;
        const wantsStream = b.stream === true;
        summary({
          model: b.model,
          stream: wantsStream,
          tools: Array.isArray(b.tools) ? b.tools.length : 0,
          ...inputSummary(b.input),
          reasoning: b.reasoning ?? null,
          serviceTier: b.service_tier ?? null,
        });
        if (wantsStream) {
          await handleResponsesStream({ upstream: deps.upstream, catalog: deps.catalog }, rawBody, res);
        } else {
          const { status, body, extraHeaders } = await handleResponsesNonStream(
            { upstream: deps.upstream, catalog: deps.catalog },
            rawBody,
          );
          sendJson(res, status, body, extraHeaders);
        }
        return;
      }

      if (method === "POST" && path === "/v1/chat/completions") {
        const rawBody = await readJsonBody(req);
        const b = rawBody as Record<string, unknown>;
        const wantsStream = b.stream === true;
        summary({
          model: b.model,
          stream: wantsStream,
          tools: Array.isArray(b.tools) ? b.tools.length : 0,
          messages: Array.isArray(b.messages) ? b.messages.length : 0,
        });
        if (wantsStream) {
          await handleChatStream({ upstream: deps.upstream, catalog: deps.catalog }, rawBody, res);
        } else {
          const { status, body, extraHeaders } = await handleChatNonStream(
            { upstream: deps.upstream, catalog: deps.catalog },
            rawBody,
          );
          sendJson(res, status, body, extraHeaders);
        }
        return;
      }

      // 未实现的 OpenAI 平台 API:明确 404,不静默吞
      throw new ApiError(404, "invalid_request_error", `Unknown or unsupported endpoint: ${method} ${path}`, {
        code: "not_found",
      });
    } catch (err) {
      const apiErr = toApiError(err);
      if (apiErr.status >= 500) log.error("request failed", apiErr.message);
      sendApiError(res, apiErr);
    }
  });
}
