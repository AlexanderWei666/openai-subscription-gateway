import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chatToResponsesRequest,
  responsesToChatCompletion,
  chatStreamTransform,
} from "../../src/api/chat-completions.ts";
import { ApiError } from "../../src/api/errors.ts";

test("chat→responses:基本消息映射(system→developer,user→input_text)", () => {
  const { responsesBody } = chatToResponsesRequest({
    model: "gpt-test-a",
    messages: [
      { role: "system", content: "Be terse." },
      { role: "user", content: "hi" },
    ],
  });
  const input = responsesBody.input as Array<Record<string, unknown>>;
  assert.deepEqual(input[0], {
    type: "message",
    role: "developer",
    content: [{ type: "input_text", text: "Be terse." }],
  });
  assert.deepEqual(input[1], {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: "hi" }],
  });
});

test("chat→responses:assistant tool_calls + tool 结果映射", () => {
  const { responsesBody } = chatToResponsesRequest({
    model: "gpt-test-a",
    messages: [
      { role: "user", content: "weather?" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: "{\"location\":\"Paris\"}" } }],
      },
      { role: "tool", tool_call_id: "call_1", content: "sunny" },
    ],
  });
  const input = responsesBody.input as Array<Record<string, unknown>>;
  assert.deepEqual(input[1], {
    type: "function_call",
    call_id: "call_1",
    name: "get_weather",
    arguments: "{\"location\":\"Paris\"}",
  });
  assert.deepEqual(input[2], { type: "function_call_output", call_id: "call_1", output: "sunny" });
});

test("chat→responses:tools/tool_choice/reasoning_effort/max_tokens 映射", () => {
  const { responsesBody } = chatToResponsesRequest({
    model: "gpt-test-a",
    messages: [{ role: "user", content: "hi" }],
    tools: [{ type: "function", function: { name: "f", description: "d", parameters: { type: "object" }, strict: true } }],
    tool_choice: { type: "function", function: { name: "f" } },
    reasoning_effort: "high",
    max_completion_tokens: 64,
    temperature: 0.3,
  });
  assert.deepEqual(responsesBody.tools, [{ type: "function", name: "f", description: "d", parameters: { type: "object" }, strict: true }]);
  assert.deepEqual(responsesBody.tool_choice, { type: "function", name: "f" });
  assert.deepEqual(responsesBody.reasoning, { effort: "high" });
  assert.equal(responsesBody.max_output_tokens, 64);
  assert.equal(responsesBody.temperature, 0.3);
});

test("chat→responses:image_url part → input_image", () => {
  const { responsesBody } = chatToResponsesRequest({
    model: "gpt-test-a",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "what is this?" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AAA", detail: "high" } },
        ],
      },
    ],
  });
  const input = responsesBody.input as Array<{ content: unknown[] }>;
  assert.deepEqual(input[0]!.content[1], { type: "input_image", image_url: "data:image/png;base64,AAA", detail: "high" });
});

test("chat→responses:语义会变的参数显式 400(不静默吞)", () => {
  for (const param of ["stop", "logprobs", "presence_penalty", "frequency_penalty"]) {
    assert.throws(
      () => chatToResponsesRequest({ model: "m", messages: [{ role: "user", content: "x" }], [param]: param === "stop" ? ["\n"] : true }),
      (err: unknown) => err instanceof ApiError && err.status === 400 && err.message.includes(param),
      param,
    );
  }
  assert.throws(
    () => chatToResponsesRequest({ model: "m", messages: [{ role: "user", content: "x" }], n: 2 }),
    (err: unknown) => err instanceof ApiError && err.status === 400,
  );
});

test("chat→responses:stream_options.include_usage 识别", () => {
  const r1 = chatToResponsesRequest({ model: "m", messages: [{ role: "user", content: "x" }], stream: true, stream_options: { include_usage: true } });
  assert.equal(r1.includeUsage, true);
  const r2 = chatToResponsesRequest({ model: "m", messages: [{ role: "user", content: "x" }], stream: true });
  assert.equal(r2.includeUsage, false);
});

test("responses→chat completion:文本 + usage 映射", () => {
  const chat = responsesToChatCompletion({
    id: "resp_1",
    created_at: 1800000000,
    status: "completed",
    model: "gpt-test-a",
    output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Hello!" }] }],
    usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 2 }, output_tokens: 4, output_tokens_details: { reasoning_tokens: 1 }, total_tokens: 14 },
  }) as Record<string, unknown>;
  assert.equal(chat.object, "chat.completion");
  assert.equal(String(chat.id).startsWith("chatcmpl-"), true);
  const choices = chat.choices as Array<Record<string, unknown>>;
  assert.deepEqual(choices[0]!.message, { role: "assistant", content: "Hello!" });
  assert.equal(choices[0]!.finish_reason, "stop");
  const usage = chat.usage as Record<string, unknown>;
  assert.equal(usage.prompt_tokens, 10);
  assert.equal(usage.completion_tokens, 4);
  assert.deepEqual(usage.prompt_tokens_details, { cached_tokens: 2 });
  assert.deepEqual(usage.completion_tokens_details, { reasoning_tokens: 1 });
});

test("responses→chat completion:function_call → tool_calls + finish_reason=tool_calls", () => {
  const chat = responsesToChatCompletion({
    id: "resp_2",
    status: "completed",
    model: "gpt-test-a",
    output: [{ type: "function_call", call_id: "call_9", name: "get_weather", arguments: "{}" }],
  }) as Record<string, unknown>;
  const choices = chat.choices as Array<Record<string, unknown>>;
  const msg = choices[0]!.message as Record<string, unknown>;
  assert.deepEqual(msg.tool_calls, [{ id: "call_9", type: "function", function: { name: "get_weather", arguments: "{}" } }]);
  assert.equal(choices[0]!.finish_reason, "tool_calls");
});

test("chat 流式转换:text delta / tool args delta / completed / [DONE]", () => {
  const t = chatStreamTransform({ includeUsage: true });
  const out: string[] = [];
  const feed = (data: string) => out.push(...t.onEvent(data));

  feed(JSON.stringify({ type: "response.created", response: { id: "resp_s", model: "gpt-test-a", created_at: 1800000000 } }));
  feed(JSON.stringify({ type: "response.output_text.delta", delta: "Hi" }));
  feed(JSON.stringify({ type: "response.output_item.added", output_index: 1, item: { type: "function_call", call_id: "c1", name: "f", arguments: "" } }));
  feed(JSON.stringify({ type: "response.function_call_arguments.delta", output_index: 1, delta: "{}" }));
  feed(JSON.stringify({ type: "response.completed", response: { id: "resp_s", status: "completed", output: [{ type: "function_call", call_id: "c1" }], usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 } } }));
  out.push(...t.onEnd(true));

  const chunks = out.map((s) => (s === "[DONE]" ? s : (JSON.parse(s) as Record<string, unknown>)));
  assert.equal(out[out.length - 1], "[DONE]");
  // role chunk
  assert.deepEqual((chunks[0] as Record<string, unknown> & { choices: Array<{ delta: unknown }> }).choices[0]!.delta, { role: "assistant" });
  // text delta
  const textChunk = chunks.find((c): c is Record<string, unknown> => typeof c === "object" && JSON.stringify(c).includes('"Hi"'));
  assert.ok(textChunk);
  // tool call start + args
  const joined = out.join("");
  assert.ok(joined.includes('"tool_calls"'));
  assert.ok(joined.includes('"name":"f"'));
  // usage chunk(include_usage=true)
  assert.ok(joined.includes('"usage"'));
  // finish_reason
  assert.ok(joined.includes('"finish_reason":"tool_calls"'));
});

// ---------- v0.1.1:流式工具兼容(只修确定性问题) ----------

/** 统计 chat.completion.chunk 里出现 role delta 的次数 */
function countRoleChunks(out: string[]): number {
  return out.filter((s) => {
    if (s === "[DONE]") return false;
    try {
      const c = JSON.parse(s) as { choices?: Array<{ delta?: Record<string, unknown> }> };
      return c.choices?.[0]?.delta?.role === "assistant";
    } catch {
      return false;
    }
  }).length;
}

test("流式:role chunk 只发一次(created + text delta + tool call 混合)", () => {
  const t = chatStreamTransform({ includeUsage: false });
  const out: string[] = [];
  out.push(...t.onEvent(JSON.stringify({ type: "response.created", response: { id: "resp_r", model: "m" } })));
  out.push(...t.onEvent(JSON.stringify({ type: "response.output_text.delta", delta: "hi" })));
  out.push(...t.onEvent(JSON.stringify({ type: "response.output_item.added", output_index: 1, item: { type: "function_call", call_id: "c1", name: "f" } })));
  out.push(...t.onEvent(JSON.stringify({ type: "response.function_call_arguments.delta", output_index: 1, delta: "{}" })));
  out.push(...t.onEvent(JSON.stringify({ type: "response.completed", response: { id: "resp_r", status: "completed", output: [] } })));

  assert.equal(countRoleChunks(out), 1, "role chunk 必须恰好一次");
});

test("流式:tool call 出现时 finish_reason=tool_calls(completed.output 为空也要正确)", () => {
  const t = chatStreamTransform({ includeUsage: false });
  const out: string[] = [];
  out.push(...t.onEvent(JSON.stringify({ type: "response.created", response: { id: "resp_t" } })));
  out.push(...t.onEvent(JSON.stringify({ type: "response.output_item.added", output_index: 0, item: { type: "function_call", call_id: "c1", name: "f" } })));
  out.push(...t.onEvent(JSON.stringify({ type: "response.function_call_arguments.delta", output_index: 0, delta: "{}" })));
  // 上游怪癖:completed 的 output 恒为空
  out.push(...t.onEvent(JSON.stringify({ type: "response.completed", response: { id: "resp_t", status: "completed", output: [] } })));

  const last = JSON.parse(out[out.length - 1]!) as { choices: Array<{ finish_reason: string }> };
  assert.equal(last.choices[0]!.finish_reason, "tool_calls");
});

test("流式:仅 output_item.done 携带 function_call 也能识别(sawToolCall 兜底)", () => {
  const t = chatStreamTransform({ includeUsage: false });
  const out: string[] = [];
  out.push(...t.onEvent(JSON.stringify({ type: "response.created", response: { id: "resp_d" } })));
  out.push(...t.onEvent(JSON.stringify({ type: "response.output_item.done", output_index: 0, item: { type: "function_call", call_id: "c9", name: "g", arguments: "{}" } })));
  out.push(...t.onEvent(JSON.stringify({ type: "response.completed", response: { id: "resp_d", status: "completed", output: [] } })));

  const last = JSON.parse(out[out.length - 1]!) as { choices: Array<{ finish_reason: string }> };
  assert.equal(last.choices[0]!.finish_reason, "tool_calls");
});

test("流式:纯文本且 completed.output 为空 → finish_reason=stop(不误判)", () => {
  const t = chatStreamTransform({ includeUsage: false });
  const out: string[] = [];
  out.push(...t.onEvent(JSON.stringify({ type: "response.created", response: { id: "resp_s" } })));
  out.push(...t.onEvent(JSON.stringify({ type: "response.output_text.delta", delta: "hello" })));
  out.push(...t.onEvent(JSON.stringify({ type: "response.completed", response: { id: "resp_s", status: "completed", output: [] } })));

  const last = JSON.parse(out[out.length - 1]!) as { choices: Array<{ finish_reason: string }> };
  assert.equal(last.choices[0]!.finish_reason, "stop");
  assert.equal(countRoleChunks(out), 1);
});

test("流式:incomplete 状态 → 映射为错误载荷", () => {
  const t = chatStreamTransform({ includeUsage: false });
  const out: string[] = [];
  out.push(...t.onEvent(JSON.stringify({ type: "response.created", response: { id: "resp_i" } })));
  out.push(...t.onEvent(JSON.stringify({ type: "response.incomplete", response: { id: "resp_i", status: "incomplete", output: [] } })));
  const joined = out.join("");
  assert.ok(joined.includes("upstream_error"), "incomplete 应映射为错误载荷");
});
