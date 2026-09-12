import { test } from "node:test";
import assert from "node:assert/strict";
import { MockUpstream } from "../helpers/mock-upstream.ts";
import { startGateway } from "../helpers/gateway-server.ts";

const COMPLETED_RESPONSE = {
  id: "resp_123",
  object: "response",
  created_at: 1800000000,
  status: "completed",
  model: "gpt-test-a",
  output: [
    {
      type: "message",
      id: "msg_1",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: "Hello!", annotations: [] }],
    },
  ],
  usage: {
    input_tokens: 12,
    input_tokens_details: { cached_tokens: 4 },
    output_tokens: 3,
    output_tokens_details: { reasoning_tokens: 1 },
    total_tokens: 15,
  },
};

function sseEvents(): string[] {
  return [
    JSON.stringify({ type: "response.created", response: { id: "resp_123", status: "in_progress" } }),
    JSON.stringify({ type: "response.output_text.delta", delta: "Hello", item_id: "msg_1", output_index: 0, content_index: 0 }),
    JSON.stringify({ type: "response.output_text.delta", delta: "!", item_id: "msg_1", output_index: 0, content_index: 0 }),
    JSON.stringify({ type: "response.completed", response: COMPLETED_RESPONSE }),
  ];
}

test("POST /v1/responses 非流式:聚合 completed,usage 原样透传", async () => {
  const mock = await MockUpstream.start();
  mock.setBehavior({ kind: "sse", events: sseEvents() });
  const gw = await startGateway(mock);
  try {
    const res = await fetch(`${gw.url}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer local-placeholder" },
      body: JSON.stringify({ model: "gpt-test-a", input: "say hi" }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as typeof COMPLETED_RESPONSE;
    assert.equal(body.id, "resp_123");
    assert.equal(body.output[0]!.content[0]!.text, "Hello!");
    assert.deepEqual(body.usage, COMPLETED_RESPONSE.usage, "usage 原样透传(含 cached/reasoning 细节)");
  } finally {
    await gw.close();
    await mock.close();
  }
});

test("POST /v1/responses:上游请求契约(头 + 强制字段)", async () => {
  const mock = await MockUpstream.start();
  mock.setBehavior({ kind: "sse", events: sseEvents() });
  const gw = await startGateway(mock);
  try {
    await fetch(`${gw.url}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-test-a",
        instructions: "Be terse.",
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
        reasoning: { effort: "high" },
        service_tier: "fast",
      }),
    });
    const upstreamReq = mock.requests.find((r) => r.url === "/responses");
    assert.ok(upstreamReq, "上游应收到 /responses");
    // 头契约(docs/UPSTREAM.md §5)
    assert.equal(upstreamReq.headers.authorization, "Bearer test-access-token");
    assert.equal(upstreamReq.headers["chatgpt-account-id"], "acct-test-123");
    assert.equal(upstreamReq.headers.originator, "codex_cli_rs");
    assert.equal(upstreamReq.headers["oai-product-sku"], "codex");
    assert.equal(upstreamReq.headers.accept, "text/event-stream");
    assert.ok(upstreamReq.headers["session-id"], "session-id 必须存在");
    // 体契约(§6)
    const ub = upstreamReq.body as Record<string, unknown>;
    assert.equal(ub.stream, true, "上游恒 stream=true");
    assert.equal(ub.store, false, "上游恒 store=false");
    assert.ok((ub.include as string[]).includes("reasoning.encrypted_content"));
    assert.equal(ub.model, "gpt-test-a");
    assert.equal(ub.instructions, "Be terse.", "instructions 透传不被覆盖");
    assert.deepEqual(ub.reasoning, { effort: "high" });
    assert.equal(ub.service_tier, "priority", "fast 按上游契约改写为 priority(UPSTREAM.md §11)");
  } finally {
    await gw.close();
    await mock.close();
  }
});

test("POST /v1/responses:上游流内 response.failed → OpenAI 风格错误", async () => {
  const mock = await MockUpstream.start();
  mock.setBehavior({
    kind: "sse",
    events: [
      JSON.stringify({ type: "response.created", response: { id: "r" } }),
      JSON.stringify({
        type: "response.failed",
        response: { status: "failed", error: { code: "rate_limit_exceeded", message: "quota exhausted" } },
      }),
    ],
  });
  const gw = await startGateway(mock);
  try {
    const res = await fetch(`${gw.url}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-test-a", input: "hi" }),
    });
    assert.equal(res.status, 429);
    const body = (await res.json()) as { error: { type: string; code: string; message: string } };
    assert.equal(body.error.type, "rate_limit_error");
    assert.equal(body.error.code, "rate_limit_exceeded");
    assert.equal(body.error.message, "quota exhausted");
  } finally {
    await gw.close();
    await mock.close();
  }
});

test("POST /v1/responses:流结束无 completed → 502", async () => {
  const mock = await MockUpstream.start();
  mock.setBehavior({
    kind: "sse",
    events: [JSON.stringify({ type: "response.created", response: { id: "r" } })],
  });
  const gw = await startGateway(mock);
  try {
    const res = await fetch(`${gw.url}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-test-a", input: "hi" }),
    });
    assert.equal(res.status, 502);
  } finally {
    await gw.close();
    await mock.close();
  }
});

test("POST /v1/responses:上游拒绝的 reasoning effort → 上游 400 消息(含合法值)原样透传", async () => {
  const mock = await MockUpstream.start();
  mock.setBehavior({
    kind: "status",
    status: 400,
    body: JSON.stringify({
      error: {
        message:
          "Unsupported value: 'minimal' is not supported with the 'gpt-test-a' model. Supported values are: 'none', 'low', 'medium', 'high'.",
      },
    }),
  });
  const gw = await startGateway(mock);
  try {
    const res = await fetch(`${gw.url}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-test-a", input: "x", reasoning: { effort: "minimal" } }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: { message: string; type: string } };
    assert.equal(body.error.type, "invalid_request_error");
    assert.ok(body.error.message.includes("Supported values are"), "上游列举的合法值必须保留");
    assert.equal(mock.requests.filter((r) => r.url === "/responses").length, 1, "请求应到达上游(不再本地拦截)");
  } finally {
    await gw.close();
    await mock.close();
  }
});

test("POST /v1/responses:image input 原样透传(input_image/base64)", async () => {
  const mock = await MockUpstream.start();
  mock.setBehavior({ kind: "sse", events: sseEvents() });
  const gw = await startGateway(mock);
  try {
    const imageItem = {
      type: "message",
      role: "user",
      content: [
        { type: "input_text", text: "what is in this image?" },
        { type: "input_image", image_url: "data:image/png;base64,iVBORw0KGgo=", detail: "high" },
      ],
    };
    const res = await fetch(`${gw.url}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-test-a", input: [imageItem] }),
    });
    assert.equal(res.status, 200);
    const upstreamReq = mock.requests.find((r) => r.url === "/responses")!;
    const input = (upstreamReq.body as { input: unknown[] }).input;
    assert.deepEqual(input[0], imageItem, "input_image 必须零改写透传");
  } finally {
    await gw.close();
    await mock.close();
  }
});

test("POST /v1/responses:completed.output 为空时从 output_item.done 重建(上游怪癖)", async () => {
  const mock = await MockUpstream.start();
  // 对齐真实 Codex backend:completed.response.output=[],items 只在 item.done 下发
  const functionCallItem = { type: "function_call", id: "fc_1", call_id: "call_1", name: "get_weather", arguments: "{\"city\":\"Paris\"}" };
  const messageItem = { type: "message", id: "m1", status: "completed", role: "assistant", content: [{ type: "output_text", text: "Hi", annotations: [] }] };
  mock.setBehavior({
    kind: "sse",
    events: [
      JSON.stringify({ type: "response.created", response: { id: "resp_r", status: "in_progress" } }),
      JSON.stringify({ type: "response.output_item.done", output_index: 0, item: messageItem }),
      JSON.stringify({ type: "response.output_item.done", output_index: 1, item: functionCallItem }),
      JSON.stringify({
        type: "response.completed",
        response: { id: "resp_r", status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 } },
      }),
    ],
  });
  const gw = await startGateway(mock);
  try {
    const res = await fetch(`${gw.url}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-test-a", input: "hi" }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { output: Array<{ type: string; name?: string }> };
    assert.equal(body.output.length, 2, "output 必须从 item.done 重建");
    assert.equal(body.output[0]!.type, "message");
    assert.equal(body.output[1]!.type, "function_call");
    assert.equal(body.output[1]!.name, "get_weather");
  } finally {
    await gw.close();
    await mock.close();
  }
});

test("POST /v1/responses:不支持参数被剥离并透明上报(x-osg-normalized)", async () => {
  const mock = await MockUpstream.start();
  mock.setBehavior({ kind: "sse", events: sseEvents() });
  const gw = await startGateway(mock);
  try {
    const res = await fetch(`${gw.url}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-test-a", input: "hi", temperature: 0.7, max_output_tokens: 32, service_tier: "fast" }),
    });
    assert.equal(res.status, 200);
    const header = res.headers.get("x-osg-normalized") ?? "";
    assert.ok(header.includes("temperature"), header);
    assert.ok(header.includes("max_output_tokens"), header);
    assert.ok(header.includes("fast->priority"), header);
    assert.ok(header.includes("string->message-list"), header);
    // 上游收到的体:无被剥离参数,tier 已改写,input 已列表化
    const ub = mock.requests.find((r) => r.url === "/responses")!.body as Record<string, unknown>;
    assert.equal("temperature" in ub, false);
    assert.equal("max_output_tokens" in ub, false);
    assert.equal(ub.service_tier, "priority");
    assert.ok(Array.isArray(ub.input));
  } finally {
    await gw.close();
    await mock.close();
  }
});

test("POST /v1/responses:畸形 JSON 体 → 400 OpenAI 风格", async () => {
  const mock = await MockUpstream.start();
  const gw = await startGateway(mock);
  try {
    const res = await fetch(`${gw.url}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: { type: string } };
    assert.equal(body.error.type, "invalid_request_error");
  } finally {
    await gw.close();
    await mock.close();
  }
});

// ---------- P1-1:流内 failed / incomplete 必须转为网关 error 事件 ----------

function parseSsePayloads(text: string): Array<Record<string, unknown>> {
  return text
    .split("\n")
    .filter((l) => l.startsWith("data: "))
    .map((l) => JSON.parse(l.slice(6)) as Record<string, unknown>);
}

test("契约:流式 response.failed → 转换为网关 error 事件(不原样透传),并结束流", async () => {
  const mock = await MockUpstream.start();
  mock.setBehavior({
    kind: "sse",
    events: [
      JSON.stringify({ type: "response.created", response: { id: "resp_f", status: "in_progress" } }),
      JSON.stringify({ type: "response.output_text.delta", delta: "partial", item_id: "m1", output_index: 0, content_index: 0 }),
      JSON.stringify({
        type: "response.failed",
        response: { id: "resp_f", status: "failed", error: { code: "server_error", message: "upstream blew up" } },
      }),
    ],
  });
  const gw = await startGateway(mock);
  try {
    const res = await fetch(`${gw.url}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-test-a", input: "x", stream: true }),
      signal: AbortSignal.timeout(8000),
    });
    assert.equal(res.status, 200, "流已开始,状态码保持 200");
    const text = await res.text();

    assert.ok(text.includes('"type":"error"'), "必须下发网关约定的 error 事件");
    assert.ok(!text.includes('"type":"response.failed"'), "禁止把上游 failed 事件原样当成功数据透传");
    assert.ok(text.includes("upstream blew up"), "上游错误信息应予保留");

    const payloads = parseSsePayloads(text);
    const errEvent = payloads.find((p) => p.type === "error");
    assert.ok(errEvent, "应存在 error 事件");
    const err = errEvent.error as { type?: string; message?: string };
    assert.ok(typeof err?.type === "string" && err.type.length > 0, "error 事件须带 type");
    assert.ok(text.trim().endsWith("}"), "流应正常结束(读到结尾)");
  } finally {
    await gw.close();
    await mock.close();
  }
});

test("契约:流式 response.incomplete → 同样转为网关 error 事件", async () => {
  const mock = await MockUpstream.start();
  mock.setBehavior({
    kind: "sse",
    events: [
      JSON.stringify({ type: "response.created", response: { id: "resp_inc", status: "in_progress" } }),
      JSON.stringify({
        type: "response.incomplete",
        response: {
          id: "resp_inc",
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
          error: { code: "context_window_exceeded", message: "too long" },
        },
      }),
    ],
  });
  const gw = await startGateway(mock);
  try {
    const res = await fetch(`${gw.url}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-test-a", input: "x", stream: true }),
      signal: AbortSignal.timeout(8000),
    });
    const text = await res.text();
    assert.ok(text.includes('"type":"error"'), "incomplete 也必须转 error 事件");
    assert.ok(!text.includes('"type":"response.incomplete"'), "禁止原样透传 incomplete");
    assert.ok(text.includes("too long"), "错误信息应保留");
  } finally {
    await gw.close();
    await mock.close();
  }
});

test("契约:流式 response.incomplete 无 error 时保留 incomplete_details.reason", async () => {
  const mock = await MockUpstream.start();
  mock.setBehavior({
    kind: "sse",
    events: [
      JSON.stringify({ type: "response.created", response: { id: "resp_inc_reason", status: "in_progress" } }),
      JSON.stringify({
        type: "response.incomplete",
        response: {
          id: "resp_inc_reason",
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
        },
      }),
    ],
  });
  const gw = await startGateway(mock);
  try {
    const res = await fetch(`${gw.url}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-test-a", input: "x", stream: true }),
      signal: AbortSignal.timeout(8000),
    });
    const payloads = parseSsePayloads(await res.text());
    const errEvent = payloads.find((p) => p.type === "error");
    assert.ok(errEvent, "应存在 error 事件");
    const err = errEvent.error as { code?: string; message?: string };
    assert.equal(err.code, "response_incomplete");
    assert.match(err.message ?? "", /max_output_tokens/);
  } finally {
    await gw.close();
    await mock.close();
  }
});

// ---------- P1-2:收到 response.completed 即完成,不等待上游关闭连接 ----------

test("契约:非流式聚合收到 completed 即返回(上游保持连接不关)", async () => {
  const mock = await MockUpstream.start();
  mock.setBehavior({
    kind: "sse",
    keepOpenAfterEvents: true, // 关键:结束帧之后上游仍然挂着连接
    events: [
      JSON.stringify({ type: "response.created", response: { id: "resp_ko", status: "in_progress" } }),
      JSON.stringify({
        type: "response.output_item.done",
        output_index: 0,
        item: { type: "message", id: "m1", status: "completed", role: "assistant", content: [{ type: "output_text", text: "done", annotations: [] }] },
      }),
      JSON.stringify({
        type: "response.completed",
        response: { id: "resp_ko", status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
      }),
    ],
  });
  const gw = await startGateway(mock);
  try {
    const startedAt = Date.now();
    const res = await fetch(`${gw.url}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-test-a", input: "x" }),
      signal: AbortSignal.timeout(6000), // 修复前会挂到超时 → 该用例失败
    });
    const elapsed = Date.now() - startedAt;
    assert.equal(res.status, 200);
    const body = (await res.json()) as { status: string; output: Array<{ type: string }> };
    assert.equal(body.status, "completed");
    assert.equal(body.output.length, 1, "output 应从 output_item.done 重建");
    assert.ok(elapsed < 5000, `completed 后应立即返回,实际耗时 ${elapsed}ms`);
  } finally {
    await gw.close();
    await mock.close();
  }
});
