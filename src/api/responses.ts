import { once } from "node:events";
import type { ServerResponse } from "node:http";
import type { CodexUpstream } from "../upstream/codex.ts";
import { UpstreamError, normalizeForCodex, type NormalizationNote } from "../upstream/codex.ts";
import type { ModelCatalog, CatalogModel } from "../upstream/catalog.ts";
import { parseSse, formatSse } from "../upstream/sse.ts";
import { log } from "../log.ts";
import { ApiError, invalidRequest, modelNotFound } from "./errors.ts";

/**
 * Responses 主链(docs/DESIGN.md "Responses 主链")。
 * 本文件只做:OpenAI 风格校验、透传字段挑选、流式/非流式分发。
 * Codex 私有协议全部在 upstream/。
 */

/** 允许透传的请求字段(契约:docs/UPSTREAM.md §6) */
const PASSTHROUGH_FIELDS = [
  "instructions",
  "input",
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "reasoning",
  "service_tier",
  "max_output_tokens",
  "text",
  "temperature",
  "top_p",
  "truncation",
  "prompt_cache_key",
  "metadata",
] as const;

const REQUIRED_INCLUDE = "reasoning.encrypted_content";
const TERMINAL_TYPES = new Set(["response.completed", "response.failed", "response.incomplete"]);

export interface ResponsesDeps {
  upstream: CodexUpstream;
  /** 目录不可用时为 null:跳过本地校验,交给上游裁决 */
  catalog: ModelCatalog | null;
}

interface ValidatedRequest {
  model: string;
  stream: boolean;
  upstreamBody: Record<string, unknown>;
}

/** 校验 + 组装上游请求体 */
export async function buildUpstreamBody(
  rawBody: unknown,
  catalog: ModelCatalog | null,
): Promise<ValidatedRequest> {
  if (typeof rawBody !== "object" || rawBody === null || Array.isArray(rawBody)) {
    throw invalidRequest("Request body must be a JSON object.");
  }
  const body = rawBody as Record<string, unknown>;

  if (typeof body.model !== "string" || body.model.length === 0) {
    throw invalidRequest("`model` is required and must be a string.", "model");
  }
  const model = body.model;

  if (body.store === true) {
    throw invalidRequest("`store: true` is not supported: this gateway is stateless.", "store");
  }
  if (body.previous_response_id !== undefined && body.previous_response_id !== null) {
    throw invalidRequest(
      "`previous_response_id` is not supported: upstream store is disabled.",
      "previous_response_id",
    );
  }
  if (body.input === undefined) {
    throw invalidRequest("`input` is required.", "input");
  }

  // 目录可得时的前置校验:仅用于 model 存在性(404)。
  // reasoning effort **不做**本地校验——实测(docs/UPSTREAM.md §10):
  // 目录的 supported_reasoning_levels 不是权威白名单(gpt-5.6-luna 未列
  // "none" 但上游接受),本地拦截会误杀合法请求;透传后上游的 400 自带
  // 准确合法值列表,由 errors.ts 映射为 OpenAI 风格错误。
  if (catalog) {
    let entry: CatalogModel | null = null;
    try {
      entry = await catalog.findModel(model);
    } catch (err) {
      log.warn("模型目录不可用,跳过本地校验", err instanceof Error ? err.message : String(err));
    }
    if (entry === null) {
      // 目录可用但查不到 → 404;目录挂了上面已 warn,这里 entry 为 null 需区分
      let catalogOk = true;
      try {
        await catalog.listVisible();
      } catch {
        catalogOk = false;
      }
      if (catalogOk) throw modelNotFound(model);
    }
  }

  const upstreamBody: Record<string, unknown> = { model };
  for (const key of PASSTHROUGH_FIELDS) {
    if (body[key] !== undefined) upstreamBody[key] = body[key];
  }
  // include:下游集合 ∪ {reasoning.encrypted_content}(契约:UPSTREAM.md §6)
  const include = new Set<string>(Array.isArray(body.include) ? body.include.filter((x): x is string => typeof x === "string") : []);
  include.add(REQUIRED_INCLUDE);
  upstreamBody.include = [...include];
  // 强制字段:上游恒流式、无状态
  upstreamBody.stream = true;
  upstreamBody.store = false;

  return { model, stream: body.stream === true, upstreamBody };
}

/** 流内 response.failed / response.incomplete → ApiError(契约:UPSTREAM.md §14) */
export function mapStreamFailure(eventData: string): ApiError {
  let code: string | null = null;
  let message = "Upstream reported failure.";
  let eventType: string | null = null;
  try {
    const parsed = JSON.parse(eventData) as {
      type?: unknown;
      response?: {
        error?: { code?: unknown; message?: unknown };
        incomplete_details?: { reason?: unknown };
      };
    };
    if (typeof parsed.type === "string") eventType = parsed.type;
    const err = parsed.response?.error;
    if (typeof err?.code === "string") code = err.code;
    if (typeof err?.message === "string") message = err.message;
    const incompleteReason = parsed.response?.incomplete_details?.reason;
    if (eventType === "response.incomplete" && typeof incompleteReason === "string") {
      if (typeof err?.message !== "string") message = `Response incomplete: ${incompleteReason}.`;
      if (code === null) code = "response_incomplete";
    }
  } catch {
    // 保留默认文案
  }
  switch (code) {
    case "context_window_exceeded":
      return new ApiError(400, "invalid_request_error", message, { code });
    case "quota_exceeded":
    case "rate_limit_exceeded":
      return new ApiError(429, "rate_limit_error", message, { code });
    default:
      if (code && (code.includes("policy") || code.includes("violation"))) {
        return new ApiError(400, "invalid_request_error", message, { code });
      }
      return new ApiError(502, "upstream_error", message, { code: code ?? "stream_failed" });
  }
}

/** 聚合上游 SSE,返回 completed 的完整 response 对象(Responses/Chat 共用) */
export async function aggregateCompletedResponse(res: Response): Promise<unknown> {
  if (!res.body) throw new UpstreamError("protocol", "upstream response has no body");
  let completed: Record<string, unknown> | null = null;
  // 上游怪癖(live 实测,docs/UPSTREAM.md §8):Codex backend 的
  // response.completed.response.output 恒为空数组,output items 只经
  // response.output_item.done 下发。非流式聚合必须据此重建 output。
  const doneItems: unknown[] = [];
  for await (const ev of parseSse(res.body)) {
    let parsed: { type?: string; response?: unknown; item?: unknown };
    try {
      parsed = JSON.parse(ev.data) as typeof parsed;
    } catch {
      throw new UpstreamError("protocol", "malformed SSE event JSON from upstream");
    }
    if (parsed.type === "response.output_item.done" && parsed.item !== undefined && parsed.item !== null) {
      doneItems.push(parsed.item);
    } else if (parsed.type === "response.completed") {
      completed = (parsed.response ?? null) as Record<string, unknown> | null;
      // 结束帧已到即完成聚合,**不等待上游关闭连接**:
      // 上游可能保持连接打开(见 tests/contract/responses.test.ts 的 keepOpenAfterEvents 用例)。
      // 上游契约保证 output items 在 completed 之前下发(UPSTREAM.md §8 的实测事件序列)。
      break;
    } else if (parsed.type === "response.failed" || parsed.type === "response.incomplete") {
      throw mapStreamFailure(ev.data);
    }
  }
  await res.body.cancel().catch(() => {});
  if (!completed) {
    throw new UpstreamError("protocol", "stream ended without response.completed");
  }
  if ((!Array.isArray(completed.output) || completed.output.length === 0) && doneItems.length > 0) {
    completed.output = doneItems;
  }
  return completed;
}

/** 归一化 notes → 透明上报头 */
export function normalizationHeader(notes: NormalizationNote[]): Record<string, string> {
  if (notes.length === 0) return {};
  return {
    "x-osg-normalized": notes.map((n) => `${n.param}:${n.detail}`).join(", "),
  };
}

/** 非流式:聚合上游 SSE,返回 completed 的完整 response 对象 */
export async function handleResponsesNonStream(
  deps: ResponsesDeps,
  rawBody: unknown,
): Promise<{ status: number; body: unknown; extraHeaders: Record<string, string> }> {
  const { upstreamBody } = await buildUpstreamBody(rawBody, deps.catalog);
  const normalized = normalizeForCodex(upstreamBody);
  const res = await deps.upstream.postResponsesStream(normalized.body);
  return {
    status: 200,
    body: await aggregateCompletedResponse(res),
    extraHeaders: normalizationHeader(normalized.notes),
  };
}

/**
 * 通用上游 SSE 泵:Responses 透传与 Chat Completions 转换共用。
 * 契约(docs/DESIGN.md "Streaming"):
 * - 收到即写,不整段 buffer;res.write 返回 false 时等 drain(背压)
 * - 下游断连 → abort 上游
 * - 上游 premature close → 由 transform 注入收尾错误
 */
export interface StreamTransform {
  /** 处理一个上游事件 data,返回要写给下游的 data 载荷列表(空=吞掉) */
  onEvent(data: string): string[];
  /** 上游流结束(自然或过早)后追加的载荷;isTerminal=上游是否正常收尾 */
  onEnd(isTerminal: boolean): string[];
}

/**
 * 等待 socket drain,同时响应客户端关闭/错误/上游 abort。
 *
 * 为什么必须这样:res.write() 返回 false 后若客户端已断开,drain 永远不会到来,
 * 裸等 `once(res,"drain")` 会让 pump 永久挂起(同时上游连接也无法释放)。
 * 返回 false 表示"不该继续写",调用方应立即结束 pump。
 * 注意:不引入固定 idle timeout——只对真实的 close/error/abort 作出反应。
 */
async function waitForDrain(res: ServerResponse, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted || res.writableEnded || res.destroyed) return false;
  return await new Promise<boolean>((resolve) => {
    const cleanup = (): void => {
      res.off("drain", onDrain);
      res.off("close", onGone);
      res.off("error", onGone);
      signal.removeEventListener("abort", onAbort);
    };
    const finish = (ok: boolean): void => {
      cleanup();
      resolve(ok);
    };
    const onDrain = (): void => finish(true);
    const onGone = (): void => finish(false);
    const onAbort = (): void => finish(false);
    res.on("drain", onDrain);
    res.on("close", onGone);
    res.on("error", onGone);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export async function pumpUpstreamStream(
  upstreamRes: Response,
  res: ServerResponse,
  transform: StreamTransform,
  extraHeaders: Record<string, string> = {},
): Promise<void> {
  if (!upstreamRes.body) throw new UpstreamError("protocol", "upstream response has no body");

  const abort = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) abort.abort();
  });

  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    ...extraHeaders,
  });

  const writeData = async (data: string): Promise<boolean> => {
    if (abort.signal.aborted || res.writableEnded || res.destroyed) return false;
    if (res.write(formatSse({ event: null, data }))) return true;
    return await waitForDrain(res, abort.signal); // false = 客户端已离开
  };

  let sawTerminal = false;
  try {
    for await (const ev of parseSse(upstreamRes.body, abort.signal)) {
      if (abort.signal.aborted) return;
      let type: string | null = null;
      try {
        type = (JSON.parse(ev.data) as { type?: string }).type ?? null;
      } catch {
        await writeData(
          JSON.stringify({
            type: "error",
            error: { type: "upstream_error", code: "malformed_event", message: "Upstream sent malformed SSE event." },
          }),
        );
        sawTerminal = true; // 已注入错误帧,onEnd 不再补发 premature_close
        break;
      }
      if (type && TERMINAL_TYPES.has(type)) sawTerminal = true;
      for (const out of transform.onEvent(ev.data)) {
        if (!(await writeData(out))) return; // 客户端已离开:drain 期间被 close/abort
      }
      if (sawTerminal) break;
    }
    if (!abort.signal.aborted && !res.writableEnded) {
      for (const out of transform.onEnd(sawTerminal)) {
        if (!(await writeData(out))) return;
      }
    }
  } finally {
    if (!abort.signal.aborted) abort.abort(); // 确保上游读取被取消/资源释放
    if (!res.writableEnded) res.end();
  }
}

/** Responses 透传 transform:事件原样转发;premature close 注入 error 事件 */
export function responsesPassthroughTransform(): StreamTransform {
  return {
    onEvent: (data: string): string[] => {
      // 上游的失败帧**不得**当作成功数据透传:必须转成网关约定的 error 事件
      // (形状与下方的 premature_close / malformed_event 一致)。
      // 上游原始事件名为 response.failed / response.incomplete,若直接下发,
      // 下游会把"失败"当成正常流内容处理。
      let type: string | null = null;
      try {
        type = (JSON.parse(data) as { type?: string }).type ?? null;
      } catch {
        return [data]; // 畸形帧交给 pump 层统一注入 malformed_event
      }
      if (type !== "response.failed" && type !== "response.incomplete") return [data];
      const err = mapStreamFailure(data);
      return [
        JSON.stringify({
          type: "error",
          error: {
            type: err.type,
            code: err.code ?? (type === "response.incomplete" ? "response_incomplete" : "upstream_error"),
            message: err.message,
            param: err.param,
          },
        }),
      ];
    },
    onEnd: (isTerminal) =>
      isTerminal
        ? []
        : [
            JSON.stringify({
              type: "error",
              error: { type: "upstream_error", code: "premature_close", message: "Upstream closed the stream before a terminal event." },
            }),
          ],
  };
}

export async function handleResponsesStream(
  deps: ResponsesDeps,
  rawBody: unknown,
  res: ServerResponse,
): Promise<void> {
  const { upstreamBody } = await buildUpstreamBody(rawBody, deps.catalog);
  const normalized = normalizeForCodex(upstreamBody);
  const upstreamRes = await deps.upstream.postResponsesStream(normalized.body);
  await pumpUpstreamStream(upstreamRes, res, responsesPassthroughTransform(), normalizationHeader(normalized.notes));
}
