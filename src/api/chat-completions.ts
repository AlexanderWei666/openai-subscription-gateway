import type { ServerResponse } from "node:http";
import type { CodexUpstream } from "../upstream/codex.ts";
import { UpstreamError, normalizeForCodex } from "../upstream/codex.ts";
import type { ModelCatalog } from "../upstream/catalog.ts";
import { invalidRequest } from "./errors.ts";
import { aggregateCompletedResponse, buildUpstreamBody, normalizationHeader, pumpUpstreamStream, type StreamTransform } from "./responses.ts";

/**
 * Chat Completions 兼容层(docs/DESIGN.md "Chat Completions 兼容策略")。
 * 只做 Chat ↔ Responses 双向转换;不维护第二套上游。
 * 支持:system/developer/user/assistant/tool 消息、text、image、streaming、
 * tool calls、usage、errors。
 * 显式拒绝(语义会变,不静默吞):stop、logprobs、n>1、presence/frequency_penalty。
 */

interface ChatMessage {
  role: string;
  content?: unknown;
  tool_calls?: unknown;
  tool_call_id?: unknown;
}

export interface ChatToResponsesResult {
  responsesBody: Record<string, unknown>;
  includeUsage: boolean;
  model: string;
  stream: boolean;
}

function textOfContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p === "object" && p !== null && (p as Record<string, unknown>).type === "text" ? String((p as Record<string, unknown>).text ?? "") : ""))
      .join("");
  }
  return "";
}

/** user content 数组 → Responses content parts */
function userContentParts(content: unknown): unknown[] {
  if (typeof content === "string") return [{ type: "input_text", text: content }];
  if (!Array.isArray(content)) return [{ type: "input_text", text: textOfContent(content) }];
  const parts: unknown[] = [];
  for (const p of content) {
    if (typeof p !== "object" || p === null) {
      throw invalidRequest("Chat content parts must be objects.", "messages.content");
    }
    const part = p as Record<string, unknown>;
    if (part.type === "text") {
      parts.push({ type: "input_text", text: String(part.text ?? "") });
    } else if (part.type === "image_url") {
      const imageUrl = typeof part.image_url === "object" && part.image_url !== null
        ? (part.image_url as Record<string, unknown>).url
        : part.image_url;
      if (typeof imageUrl !== "string") {
        throw invalidRequest("Chat image_url content part must include a string URL.", "messages.content");
      }
      const detail = typeof part.image_url === "object" && part.image_url !== null
        ? (part.image_url as Record<string, unknown>).detail
        : undefined;
      parts.push({
        type: "input_image",
        image_url: imageUrl,
        ...(typeof detail === "string" ? { detail } : {}),
      });
    } else {
      // 明确 400,不得静默丢弃:静默丢弃会让模型"看不见"这部分输入而给出看似正常、
      // 实则缺少依据的回答。audio/file 不在本网关支持范围,也不擅自扩展支持。
      throw invalidRequest(
        `Chat content part type "${String(part.type ?? "unknown")}" is not supported. ` +
          `Supported: "text", "image_url". audio/file inputs are not implemented by this gateway.`,
        "messages.content",
      );
    }
  }
  return parts;
}

function mapMessages(messages: ChatMessage[]): unknown[] {
  const input: unknown[] = [];
  for (const m of messages) {
    switch (m.role) {
      case "system":
      case "developer":
        input.push({
          type: "message",
          role: "developer",
          content: [{ type: "input_text", text: textOfContent(m.content) }],
        });
        break;
      case "user":
        input.push({ type: "message", role: "user", content: userContentParts(m.content) });
        break;
      case "assistant": {
        const text = textOfContent(m.content);
        if (text) {
          input.push({
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text, annotations: [] }],
          });
        }
        if (Array.isArray(m.tool_calls)) {
          for (const tc of m.tool_calls) {
            if (typeof tc !== "object" || tc === null) continue;
            const call = tc as Record<string, unknown>;
            const fn = (call.function ?? {}) as Record<string, unknown>;
            input.push({
              type: "function_call",
              call_id: String(call.id ?? ""),
              name: String(fn.name ?? ""),
              arguments: typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments ?? {}),
            });
          }
        }
        break;
      }
      case "tool":
        input.push({
          type: "function_call_output",
          call_id: String(m.tool_call_id ?? ""),
          output: textOfContent(m.content),
        });
        break;
      default:
        throw invalidRequest(`Unsupported message role: \`${m.role}\`.`, "messages");
    }
  }
  return input;
}

function mapTools(tools: unknown[]): unknown[] {
  return tools.map((t) => {
    const tool = t as Record<string, unknown>;
    if (tool.type !== "function") {
      throw invalidRequest("Only `function` tools are supported by Chat Completions adapter.", "tools");
    }
    const fn = (tool.function ?? {}) as Record<string, unknown>;
    return {
      type: "function",
      name: fn.name,
      ...(fn.description !== undefined ? { description: fn.description } : {}),
      ...(fn.parameters !== undefined ? { parameters: fn.parameters } : {}),
      ...(fn.strict !== undefined ? { strict: fn.strict } : {}),
    };
  });
}

function mapToolChoice(choice: unknown): unknown {
  if (choice === undefined || choice === null) return undefined;
  if (typeof choice === "string") {
    if (choice === "auto" || choice === "none" || choice === "required") return choice;
    throw invalidRequest(`Unsupported tool_choice: \`${choice}\`.`, "tool_choice");
  }
  if (typeof choice === "object") {
    const c = choice as Record<string, unknown>;
    if (c.type === "function") {
      const fn = (c.function ?? {}) as Record<string, unknown>;
      return { type: "function", name: fn.name };
    }
  }
  throw invalidRequest("Unsupported tool_choice shape.", "tool_choice");
}

/** Chat Completions 请求体 → Responses 请求体(纯函数,便于单测) */
export function chatToResponsesRequest(rawBody: unknown): ChatToResponsesResult {
  if (typeof rawBody !== "object" || rawBody === null || Array.isArray(rawBody)) {
    throw invalidRequest("Request body must be a JSON object.");
  }
  const body = rawBody as Record<string, unknown>;

  if (typeof body.model !== "string" || body.model.length === 0) {
    throw invalidRequest("`model` is required and must be a string.", "model");
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw invalidRequest("`messages` is required and must be a non-empty array.", "messages");
  }
  // 语义会变且 Responses 无对应物的参数:显式拒绝
  for (const unsupported of ["stop", "logprobs", "top_logprobs", "presence_penalty", "frequency_penalty"]) {
    if (body[unsupported] !== undefined && body[unsupported] !== null) {
      throw invalidRequest(
        `\`${unsupported}\` is not supported by the upstream Responses protocol; refusing to silently drop it.`,
        unsupported,
      );
    }
  }
  if (body.n !== undefined && body.n !== null && body.n !== 1) {
    throw invalidRequest("`n > 1` is not supported.", "n");
  }

  const responsesBody: Record<string, unknown> = {
    model: body.model,
    input: mapMessages(body.messages as ChatMessage[]),
  };

  if (Array.isArray(body.tools)) responsesBody.tools = mapTools(body.tools);
  const toolChoice = mapToolChoice(body.tool_choice);
  if (toolChoice !== undefined) responsesBody.tool_choice = toolChoice;

  if (body.reasoning_effort !== undefined) {
    responsesBody.reasoning = { effort: body.reasoning_effort };
  } else if (body.reasoning !== undefined) {
    responsesBody.reasoning = body.reasoning;
  }

  if (body.service_tier !== undefined) responsesBody.service_tier = body.service_tier;
  if (body.temperature !== undefined) responsesBody.temperature = body.temperature;
  if (body.top_p !== undefined) responsesBody.top_p = body.top_p;

  const maxTokens = body.max_completion_tokens ?? body.max_tokens;
  if (maxTokens !== undefined) responsesBody.max_output_tokens = maxTokens;

  // response_format → text.format
  if (body.response_format !== undefined && body.response_format !== null) {
    const rf = body.response_format as Record<string, unknown>;
    if (rf.type === "json_object") {
      responsesBody.text = { format: { type: "json_object" } };
    } else if (rf.type === "json_schema") {
      const js = (rf.json_schema ?? {}) as Record<string, unknown>;
      responsesBody.text = {
        format: {
          type: "json_schema",
          name: js.name,
          ...(js.schema !== undefined ? { schema: js.schema } : {}),
          ...(js.strict !== undefined ? { strict: js.strict } : {}),
        },
      };
    } else if (rf.type !== "text") {
      throw invalidRequest(`Unsupported response_format type: \`${String(rf.type)}\`.`, "response_format");
    }
  }

  const stream = body.stream === true;
  const streamOptions = (body.stream_options ?? {}) as Record<string, unknown>;
  const includeUsage = stream === true && streamOptions.include_usage === true;

  return { responsesBody, includeUsage, model: body.model, stream };
}

// ---------- 响应方向:Responses → Chat ----------

interface ChatUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: { cached_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
}

function mapUsage(usage: unknown): ChatUsage | null {
  if (typeof usage !== "object" || usage === null) return null;
  const u = usage as Record<string, unknown>;
  const input = typeof u.input_tokens === "number" ? u.input_tokens : 0;
  const output = typeof u.output_tokens === "number" ? u.output_tokens : 0;
  const inDetails = (u.input_tokens_details ?? {}) as Record<string, unknown>;
  const outDetails = (u.output_tokens_details ?? {}) as Record<string, unknown>;
  const result: ChatUsage = {
    prompt_tokens: input,
    completion_tokens: output,
    total_tokens: typeof u.total_tokens === "number" ? u.total_tokens : input + output,
  };
  if (typeof inDetails.cached_tokens === "number") {
    result.prompt_tokens_details = { cached_tokens: inDetails.cached_tokens };
  }
  if (typeof outDetails.reasoning_tokens === "number") {
    result.completion_tokens_details = { reasoning_tokens: outDetails.reasoning_tokens };
  }
  return result;
}

function finishReason(response: Record<string, unknown>, hasToolCalls: boolean): string {
  if (hasToolCalls) return "tool_calls";
  if (response.status === "incomplete") return "length";
  return "stop";
}

/** Responses 完整响应 → Chat Completion(非流式) */
export function responsesToChatCompletion(response: unknown): Record<string, unknown> {
  if (typeof response !== "object" || response === null) {
    throw new UpstreamError("protocol", "upstream returned malformed response object");
  }
  const r = response as Record<string, unknown>;
  const output = Array.isArray(r.output) ? (r.output as Record<string, unknown>[]) : [];

  let content = "";
  const toolCalls: unknown[] = [];
  for (const item of output) {
    if (item.type === "message" && Array.isArray(item.content)) {
      for (const c of item.content as Record<string, unknown>[]) {
        if (c.type === "output_text" && typeof c.text === "string") content += c.text;
        if (c.type === "refusal" && typeof c.refusal === "string") content += c.refusal;
      }
    } else if (item.type === "function_call") {
      toolCalls.push({
        id: String(item.call_id ?? item.id ?? ""),
        type: "function",
        function: { name: String(item.name ?? ""), arguments: String(item.arguments ?? "") },
      });
    }
  }

  const id = typeof r.id === "string" ? r.id : "unknown";
  return {
    id: id.startsWith("chatcmpl-") ? id : `chatcmpl-${id}`,
    object: "chat.completion",
    created: typeof r.created_at === "number" ? r.created_at : Math.floor(Date.now() / 1000),
    model: typeof r.model === "string" ? r.model : "unknown",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: content || null,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: finishReason(r, toolCalls.length > 0),
      },
    ],
    ...(mapUsage(r.usage) ? { usage: mapUsage(r.usage) } : {}),
  };
}

// ---------- 流式转换 ----------

interface ChatStreamState {
  id: string;
  model: string;
  created: number;
  toolCallIndices: Map<number, number>; // output_index → tool_calls index
  sentRole: boolean;
  /**
   * 是否已见过 function_call。
   * 必须自行跟踪:上游 `response.completed.response.output` 恒为空数组
   * (docs/UPSTREAM.md §8),靠它判断会永远得出 finish_reason=stop。
   */
  sawToolCall: boolean;
  includeUsage: boolean;
}

function chatChunk(state: ChatStreamState, delta: Record<string, unknown>, finish: string | null, usage?: ChatUsage | null): string {
  const chunk: Record<string, unknown> = {
    id: state.id,
    object: "chat.completion.chunk",
    created: state.created,
    model: state.model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  };
  if (usage) chunk.usage = usage;
  return JSON.stringify(chunk);
}

/** 流式 Chat transform:上游 Responses 事件 → chat.completion.chunk 载荷 */
export function chatStreamTransform(opts: { includeUsage: boolean }): StreamTransform {
  const state: ChatStreamState = {
    id: "chatcmpl-stream",
    model: "unknown",
    created: Math.floor(Date.now() / 1000),
    toolCallIndices: new Map(),
    sentRole: false,
    sawToolCall: false,
    includeUsage: opts.includeUsage,
  };

  const rolePrefix = (out: string[]): string[] => {
    if (!state.sentRole) {
      state.sentRole = true;
      out.unshift(chatChunk(state, { role: "assistant" }, null));
    }
    return out;
  };

  return {
    onEvent(data: string): string[] {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(data) as Record<string, unknown>;
      } catch {
        return [];
      }
      const type = parsed.type;
      const out: string[] = [];

      if (type === "response.created") {
        const resp = (parsed.response ?? {}) as Record<string, unknown>;
        if (typeof resp.id === "string") state.id = resp.id.startsWith("chatcmpl-") ? resp.id : `chatcmpl-${resp.id}`;
        if (typeof resp.model === "string") state.model = resp.model;
        if (typeof resp.created_at === "number") state.created = resp.created_at;
        // 关键:首帧就带 role,并立即置位,避免后续 rolePrefix 再发一次 role chunk
        return rolePrefix([]);
      }
      if (type === "response.output_text.delta") {
        return rolePrefix([chatChunk(state, { content: String(parsed.delta ?? "") }, null)]);
      }
      if (type === "response.output_item.added" || type === "response.output_item.done") {
        const item = (parsed.item ?? {}) as Record<string, unknown>;
        if (item.type === "function_call") {
          state.sawToolCall = true;
          // .done 只用于标记;chunk 序列由 .added 发起
          if (type === "response.output_item.done") return [];
          const outputIndex = typeof parsed.output_index === "number" ? parsed.output_index : 0;
          const idx = state.toolCallIndices.size;
          state.toolCallIndices.set(outputIndex, idx);
          return rolePrefix([
            chatChunk(
              state,
              {
                tool_calls: [
                  {
                    index: idx,
                    id: String(item.call_id ?? item.id ?? ""),
                    type: "function",
                    function: { name: String(item.name ?? ""), arguments: "" },
                  },
                ],
              },
              null,
            ),
          ]);
        }
        return [];
      }
      if (type === "response.function_call_arguments.delta") {
        state.sawToolCall = true;
        const outputIndex = typeof parsed.output_index === "number" ? parsed.output_index : 0;
        const idx = state.toolCallIndices.get(outputIndex) ?? 0;
        return rolePrefix([
          chatChunk(state, { tool_calls: [{ index: idx, function: { arguments: String(parsed.delta ?? "") } }] }, null),
        ]);
      }
      if (type === "response.completed") {
        const resp = (parsed.response ?? {}) as Record<string, unknown>;
        const output = Array.isArray(resp.output) ? (resp.output as Record<string, unknown>[]) : [];
        // 双保险:本流见过的 function_call 优先;output 非空时也计入
        const hasToolCalls = state.sawToolCall || output.some((i) => i.type === "function_call");
        const finish = finishReason(resp, hasToolCalls);
        const usage = mapUsage(resp.usage);
        const chunks: string[] = [];
        if (state.includeUsage && usage) {
          chunks.push(JSON.stringify({
            id: state.id,
            object: "chat.completion.chunk",
            created: state.created,
            model: state.model,
            choices: [],
            usage,
          }));
        }
        chunks.push(chatChunk(state, {}, finish));
        return chunks;
      }
      if (type === "response.failed" || type === "response.incomplete") {
        const resp = (parsed.response ?? {}) as Record<string, unknown>;
        const err = (resp.error ?? {}) as Record<string, unknown>;
        return [
          JSON.stringify({
            error: {
              message: typeof err.message === "string" ? err.message : "Upstream stream failed.",
              type: "upstream_error",
              code: typeof err.code === "string" ? err.code : "stream_failed",
            },
          }),
        ];
      }
      // 其余事件(content_part、item.done 等)在 Chat 语义里无对应,吞掉
      return out;
    },
    onEnd(isTerminal: boolean): string[] {
      const tail: string[] = [];
      if (!isTerminal) {
        tail.push(JSON.stringify({
          error: {
            message: "Upstream closed the stream before a terminal event.",
            type: "upstream_error",
            code: "premature_close",
          },
        }));
      }
      tail.push("[DONE]");
      return tail;
    },
  };
}

export interface ChatDeps {
  upstream: CodexUpstream;
  catalog: ModelCatalog | null;
}

/** 非流式:/v1/chat/completions → Responses 聚合 → chat.completion */
export async function handleChatNonStream(
  deps: ChatDeps,
  rawBody: unknown,
): Promise<{ status: number; body: unknown; extraHeaders: Record<string, string> }> {
  const { responsesBody } = chatToResponsesRequest(rawBody);
  const { upstreamBody } = await buildUpstreamBody(responsesBody, deps.catalog);
  const normalized = normalizeForCodex(upstreamBody);
  const res = await deps.upstream.postResponsesStream(normalized.body);
  const completed = await aggregateCompletedResponse(res);
  return { status: 200, body: responsesToChatCompletion(completed), extraHeaders: normalizationHeader(normalized.notes) };
}

/** 流式:/v1/chat/completions → Responses SSE → chat.completion.chunk SSE */
export async function handleChatStream(deps: ChatDeps, rawBody: unknown, res: ServerResponse): Promise<void> {
  const { responsesBody, includeUsage } = chatToResponsesRequest(rawBody);
  const { upstreamBody } = await buildUpstreamBody(responsesBody, deps.catalog);
  const normalized = normalizeForCodex(upstreamBody);
  const upstreamRes = await deps.upstream.postResponsesStream(normalized.body);
  await pumpUpstreamStream(upstreamRes, res, chatStreamTransform({ includeUsage }), normalizationHeader(normalized.notes));
}
