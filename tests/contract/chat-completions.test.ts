import { test } from "node:test";
import assert from "node:assert/strict";
import { MockUpstream } from "../helpers/mock-upstream.ts";
import { startGateway } from "../helpers/gateway-server.ts";

const CHAT_COMPLETED = {
  id: "resp_c1",
  object: "response",
  created_at: 1800000000,
  status: "completed",
  model: "gpt-test-a",
  output: [
    { type: "message", id: "m1", status: "completed", role: "assistant", content: [{ type: "output_text", text: "Hi there!", annotations: [] }] },
  ],
  usage: { input_tokens: 8, output_tokens: 3, total_tokens: 11 },
};

test("POST /v1/chat/completions 非流式:Chat 请求 → Responses 上行 → Chat 响应", async () => {
  const mock = await MockUpstream.start();
  mock.setBehavior({
    kind: "sse",
    events: [
      JSON.stringify({ type: "response.created", response: { id: "resp_c1" } }),
      JSON.stringify({ type: "response.completed", response: CHAT_COMPLETED }),
    ],
  });
  const gw = await startGateway(mock);
  try {
    const res = await fetch(`${gw.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer local-placeholder" },
      body: JSON.stringify({
        model: "gpt-test-a",
        messages: [
          { role: "system", content: "Be nice." },
          { role: "user", content: "hello" },
        ],
      }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.object, "chat.completion");
    const choices = body.choices as Array<Record<string, unknown>>;
    assert.deepEqual(choices[0]!.message, { role: "assistant", content: "Hi there!" });
    assert.equal(choices[0]!.finish_reason, "stop");

    // 上行契约:messages 已转成 Responses input
    const upstreamReq = mock.requests.find((r) => r.url === "/responses")!;
    const ub = upstreamReq.body as Record<string, unknown>;
    assert.equal(ub.stream, true);
    assert.equal(ub.store, false);
    const input = ub.input as Array<Record<string, unknown>>;
    assert.deepEqual(input[0], { type: "message", role: "developer", content: [{ type: "input_text", text: "Be nice." }] });
    assert.deepEqual(input[1], { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] });
  } finally {
    await gw.close();
    await mock.close();
  }
});

test("POST /v1/chat/completions 流式:chunk 序列 + usage + [DONE]", async () => {
  const mock = await MockUpstream.start();
  mock.setBehavior({
    kind: "sse",
    events: [
      JSON.stringify({ type: "response.created", response: { id: "resp_c2", model: "gpt-test-a", created_at: 1800000000 } }),
      JSON.stringify({ type: "response.output_text.delta", delta: "Hel" }),
      JSON.stringify({ type: "response.output_text.delta", delta: "lo" }),
      JSON.stringify({ type: "response.completed", response: CHAT_COMPLETED }),
    ],
  });
  const gw = await startGateway(mock);
  try {
    const res = await fetch(`${gw.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-test-a",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
        stream_options: { include_usage: true },
      }),
    });
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(text.includes("chat.completion.chunk"));
    assert.ok(text.includes('"delta":{"role":"assistant"}'), "首 chunk 带 role");
    assert.ok(text.includes('"content":"Hel"') && text.includes('"content":"lo"'), "文本 delta 到达");
    assert.ok(text.includes('"usage"'), "include_usage → usage chunk");
    assert.ok(text.trimEnd().endsWith("data: [DONE]"), "以 [DONE] 结束");
  } finally {
    await gw.close();
    await mock.close();
  }
});

test("POST /v1/chat/completions:不支持参数(stop)→ 400 不静默吞", async () => {
  const mock = await MockUpstream.start();
  const gw = await startGateway(mock);
  try {
    const res = await fetch(`${gw.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-test-a",
        messages: [{ role: "user", content: "hi" }],
        stop: ["\n"],
      }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: { message: string } };
    assert.ok(body.error.message.includes("stop"));
    assert.equal(mock.requests.filter((r) => r.url === "/responses").length, 0, "不得打到上游");
  } finally {
    await gw.close();
    await mock.close();
  }
});

test("POST /v1/chat/completions 流式 tool call:tool_calls chunk 序列正确", async () => {
  const mock = await MockUpstream.start();
  mock.setBehavior({
    kind: "sse",
    events: [
      JSON.stringify({ type: "response.created", response: { id: "resp_tc", model: "gpt-test-a" } }),
      JSON.stringify({ type: "response.output_item.added", output_index: 0, item: { type: "function_call", call_id: "call_1", name: "get_weather", arguments: "" } }),
      JSON.stringify({ type: "response.function_call_arguments.delta", output_index: 0, delta: "{\"city\":" }),
      JSON.stringify({ type: "response.function_call_arguments.delta", output_index: 0, delta: "\"Paris\"}" }),
      JSON.stringify({
        type: "response.completed",
        response: {
          id: "resp_tc",
          status: "completed",
          output: [{ type: "function_call", call_id: "call_1", name: "get_weather", arguments: "{\"city\":\"Paris\"}" }],
          usage: { input_tokens: 4, output_tokens: 6, total_tokens: 10 },
        },
      }),
    ],
  });
  const gw = await startGateway(mock);
  try {
    const res = await fetch(`${gw.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-test-a",
        messages: [{ role: "user", content: "weather?" }],
        tools: [{ type: "function", function: { name: "get_weather", parameters: { type: "object" } } }],
        stream: true,
      }),
    });
    const text = await res.text();
    assert.ok(text.includes('"name":"get_weather"'));
    assert.ok(text.includes('"arguments":"{\\"city\\":"'));
    assert.ok(text.includes('"finish_reason":"tool_calls"'));
    // 上行 tools 已转为 Responses 形态
    const upstreamReq = mock.requests.find((r) => r.url === "/responses")!;
    const tools = (upstreamReq.body as { tools: Array<Record<string, unknown>> }).tools;
    assert.deepEqual(tools, [{ type: "function", name: "get_weather", parameters: { type: "object" } }]);
  } finally {
    await gw.close();
    await mock.close();
  }
});

test("契约:流式 tool call 的 role chunk 只出现一次且 finish_reason=tool_calls", async () => {
  const mock = await MockUpstream.start();
  mock.setBehavior({
    kind: "sse",
    events: [
      JSON.stringify({ type: "response.created", response: { id: "resp_tc2", model: "gpt-test-a" } }),
      JSON.stringify({ type: "response.output_item.added", output_index: 0, item: { type: "function_call", call_id: "call_7", name: "get_weather", arguments: "" } }),
      JSON.stringify({ type: "response.function_call_arguments.delta", output_index: 0, delta: "{\"city\":\"Paris\"}" }),
      JSON.stringify({ type: "response.output_item.done", output_index: 0, item: { type: "function_call", call_id: "call_7", name: "get_weather", arguments: "{\"city\":\"Paris\"}" } }),
      // 上游怪癖:completed 的 output 恒为空数组
      JSON.stringify({ type: "response.completed", response: { id: "resp_tc2", status: "completed", output: [], usage: { input_tokens: 3, output_tokens: 5, total_tokens: 8 } } }),
    ],
  });
  const gw = await startGateway(mock);
  try {
    const res = await fetch(`${gw.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-test-a",
        messages: [{ role: "user", content: "weather?" }],
        tools: [{ type: "function", function: { name: "get_weather", parameters: { type: "object" } } }],
        stream: true,
      }),
    });
    assert.equal(res.status, 200);
    const text = await res.text();
    const payloads = text
      .split("\n")
      .filter((l) => l.startsWith("data: ") && !l.includes("[DONE]"))
      .map((l) => JSON.parse(l.slice(6)) as { choices?: Array<{ delta?: Record<string, unknown>; finish_reason: string | null }> });
    const roleChunks = payloads.filter((p) => p.choices?.[0]?.delta?.role === "assistant");
    assert.equal(roleChunks.length, 1, `role chunk 必须恰好一次,实际 ${roleChunks.length}`);
    const finish = payloads.map((p) => p.choices?.[0]?.finish_reason).filter((f) => f !== null);
    assert.deepEqual(finish, ["tool_calls"], "finish_reason 必须为 tool_calls");
    assert.ok(text.includes("Paris"), "tool 参数必须完整下发");
  } finally {
    await gw.close();
    await mock.close();
  }
});

// ---------- P1-3:不支持的 content part 必须 400,不得静默丢弃用户输入 ----------

test("契约:chat audio content part → 400 且不发送到上游", async () => {
  const mock = await MockUpstream.start();
  const gw = await startGateway(mock);
  try {
    const res = await fetch(`${gw.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-test-a",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "transcribe this" },
              { type: "input_audio", input_audio: { data: "UklGRg==", format: "wav" } },
            ],
          },
        ],
      }),
    });
    assert.equal(res.status, 400, "audio part 必须明确 400");
    const body = (await res.json()) as { error: { type: string; message: string } };
    assert.equal(body.error.type, "invalid_request_error");
    assert.match(body.error.message, /audio/i, "错误消息须指明 audio 不受支持");
    assert.equal(
      mock.requests.filter((r) => r.url === "/responses").length,
      0,
      "必须在发往上游之前拒绝(不消耗上游调用)",
    );
  } finally {
    await gw.close();
    await mock.close();
  }
});

test("契约:chat file content part → 400 且不发送到上游", async () => {
  const mock = await MockUpstream.start();
  const gw = await startGateway(mock);
  try {
    const res = await fetch(`${gw.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-test-a",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "read this file" },
              { type: "file", file: { filename: "a.pdf", file_data: "data:application/pdf;base64,AAAA" } },
            ],
          },
        ],
      }),
    });
    assert.equal(res.status, 400, "file part 必须明确 400");
    const body = (await res.json()) as { error: { type: string; message: string } };
    assert.equal(body.error.type, "invalid_request_error");
    assert.match(body.error.message, /file/i, "错误消息须指明 file 不受支持");
    assert.equal(mock.requests.filter((r) => r.url === "/responses").length, 0);
  } finally {
    await gw.close();
    await mock.close();
  }
});

test("契约:chat 非对象 content part → 400 且不发送到上游", async () => {
  const mock = await MockUpstream.start();
  const gw = await startGateway(mock);
  try {
    for (const part of [null, "not-a-content-part"]) {
      const res = await fetch(`${gw.url}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-test-a", messages: [{ role: "user", content: [part] }] }),
      });
      assert.equal(res.status, 400, `content part ${String(part)} 必须明确 400`);
      const body = (await res.json()) as { error: { type: string; param?: string } };
      assert.equal(body.error.type, "invalid_request_error");
      assert.equal(body.error.param, "messages.content");
    }
    assert.equal(mock.requests.filter((r) => r.url === "/responses").length, 0);
  } finally {
    await gw.close();
    await mock.close();
  }
});

test("契约:chat image_url 缺少 URL → 400 且不发送到上游", async () => {
  const mock = await MockUpstream.start();
  const gw = await startGateway(mock);
  try {
    const res = await fetch(`${gw.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-test-a",
        messages: [{ role: "user", content: [{ type: "image_url", image_url: { detail: "high" } }] }],
      }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: { type: string; param?: string } };
    assert.equal(body.error.type, "invalid_request_error");
    assert.equal(body.error.param, "messages.content");
    assert.equal(mock.requests.filter((r) => r.url === "/responses").length, 0);
  } finally {
    await gw.close();
    await mock.close();
  }
});

test("契约:chat 纯文本与 image_url 仍正常工作(不误伤已支持路径)", async () => {
  const mock = await MockUpstream.start();
  mock.setBehavior({
    kind: "sse",
    events: [
      JSON.stringify({ type: "response.created", response: { id: "resp_ok", model: "gpt-test-a" } }),
      JSON.stringify({
        type: "response.output_item.done",
        output_index: 0,
        item: { type: "message", id: "m1", status: "completed", role: "assistant", content: [{ type: "output_text", text: "ok", annotations: [] }] },
      }),
      JSON.stringify({ type: "response.completed", response: { id: "resp_ok", status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }),
    ],
  });
  const gw = await startGateway(mock);
  try {
    const res = await fetch(`${gw.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-test-a",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "describe" },
              { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } },
            ],
          },
        ],
      }),
    });
    assert.equal(res.status, 200, "text + image_url 组合必须继续可用");
    const upstreamReq = mock.requests.find((r) => r.url === "/responses")!;
    const body = upstreamReq.body as { input: Array<{ content: Array<{ type: string }> }> };
    const partTypes = body.input[0]!.content.map((c) => c.type);
    assert.deepEqual(partTypes, ["input_text", "input_image"]);
  } finally {
    await gw.close();
    await mock.close();
  }
});
