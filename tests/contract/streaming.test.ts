import { test } from "node:test";
import assert from "node:assert/strict";
import { MockUpstream } from "../helpers/mock-upstream.ts";
import { startGateway } from "../helpers/gateway-server.ts";

const DELAY = 150;

function delayedEvents(): string[] {
  return [
    JSON.stringify({ type: "response.created", response: { id: "resp_s", status: "in_progress" } }),
    JSON.stringify({ type: "response.output_text.delta", delta: "A", item_id: "m1", output_index: 0, content_index: 0 }),
    JSON.stringify({ type: "response.output_text.delta", delta: "B", item_id: "m1", output_index: 0, content_index: 0 }),
    JSON.stringify({
      type: "response.completed",
      response: { id: "resp_s", status: "completed", model: "gpt-test-a", output: [], usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 } },
    }),
  ];
}

async function readStream(res: Response): Promise<{ chunks: string[]; firstAt: number; endAt: number }> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let firstAt = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (chunks.length === 0) firstAt = Date.now();
    chunks.push(decoder.decode(value, { stream: true }));
  }
  return { chunks, firstAt, endAt: Date.now() };
}

test("真流式:首 chunk 在上游发完前到达;事件逐字透传;completed 后正常关闭", async () => {
  const mock = await MockUpstream.start();
  mock.setBehavior({ kind: "sse", events: delayedEvents(), delayBetweenMs: DELAY });
  const gw = await startGateway(mock);
  try {
    const start = Date.now();
    const res = await fetch(`${gw.url}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-test-a", input: "hi", stream: true }),
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);

    const { chunks, firstAt, endAt } = await readStream(res);
    const total = endAt - start;
    assert.ok(chunks.length >= 3, `应分多个 chunk 到达,实际 ${chunks.length}`);
    assert.ok(
      firstAt - start < total - DELAY / 2,
      `首 chunk(${firstAt - start}ms)应远早于流结束(${total}ms)——不允许整段 buffer`,
    );

    // 事件逐字透传
    const joined = chunks.join("");
    for (const raw of delayedEvents()) {
      assert.ok(joined.includes(`data: ${raw}\n\n`), `事件应原样到达:${raw.slice(0, 60)}`);
    }
    assert.ok(joined.includes("response.completed"));
  } finally {
    await gw.close();
    await mock.close();
  }
});

test("上游 premature close → 下游收到 error 事件", async () => {
  const mock = await MockUpstream.start();
  mock.setBehavior({
    kind: "sse",
    events: delayedEvents(),
    closeAfterEvents: 2, // 只发 2 个就断,没有 terminal
  });
  const gw = await startGateway(mock);
  try {
    const res = await fetch(`${gw.url}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-test-a", input: "hi", stream: true }),
    });
    const { chunks } = await readStream(res);
    const joined = chunks.join("");
    assert.ok(joined.includes('"code":"premature_close"'), `应注入 premature_close 错误:${joined}`);
  } finally {
    await gw.close();
    await mock.close();
  }
});

test("下游断连 → 上游被中止(取消传播)", async () => {
  const mock = await MockUpstream.start();
  // 上游慢速推流,给客户端留出断开窗口
  mock.setBehavior({ kind: "sse", events: delayedEvents(), delayBetweenMs: 500 });
  const gw = await startGateway(mock);
  try {
    const controller = new AbortController();
    const res = await fetch(`${gw.url}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-test-a", input: "hi", stream: true }),
      signal: controller.signal,
    });
    assert.equal(res.status, 200);
    // 读到第一个 chunk 立刻断开
    const reader = res.body!.getReader();
    await reader.read();
    controller.abort();

    // 等取消传播到 mock upstream
    const deadline = Date.now() + 3000;
    while (!mock.clientAborted && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(mock.clientAborted, true, "客户端断开必须在合理时间内中止上游请求");
  } finally {
    await gw.close();
    await mock.close();
  }
});

test("流式 tool calling:function_call_arguments.delta 原样到达下游", async () => {
  const mock = await MockUpstream.start();
  const toolEvents = [
    JSON.stringify({ type: "response.created", response: { id: "resp_t" } }),
    JSON.stringify({
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "get_weather", arguments: "" },
    }),
    JSON.stringify({ type: "response.function_call_arguments.delta", item_id: "fc_1", output_index: 0, delta: "{\"location\":" }),
    JSON.stringify({ type: "response.function_call_arguments.delta", item_id: "fc_1", output_index: 0, delta: "\"Paris\"}" }),
    JSON.stringify({
      type: "response.output_item.done",
      output_index: 0,
      item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "get_weather", arguments: "{\"location\":\"Paris\"}" },
    }),
    JSON.stringify({
      type: "response.completed",
      response: {
        id: "resp_t",
        status: "completed",
        output: [{ type: "function_call", id: "fc_1", call_id: "call_1", name: "get_weather", arguments: "{\"location\":\"Paris\"}" }],
        usage: { input_tokens: 5, output_tokens: 7, total_tokens: 12 },
      },
    }),
  ];
  mock.setBehavior({ kind: "sse", events: toolEvents });
  const gw = await startGateway(mock);
  try {
    const res = await fetch(`${gw.url}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-test-a",
        input: "weather in Paris?",
        stream: true,
        tools: [{ type: "function", name: "get_weather", description: "w", parameters: { type: "object", properties: { location: { type: "string" } } } }],
      }),
    });
    const { chunks } = await readStream(res);
    const joined = chunks.join("");
    assert.ok(joined.includes("response.function_call_arguments.delta"), "arguments delta 必须到达下游");
    assert.ok(joined.includes("\\\"Paris\\\""), "arguments 片段语义不得改变");
    // tools schema 原样上行
    const upstreamReq = mock.requests.find((r) => r.url === "/responses");
    const tools = (upstreamReq!.body as { tools: Array<{ name: string }> }).tools;
    assert.equal(tools[0]!.name, "get_weather", "tool name 不得被改");
  } finally {
    await gw.close();
    await mock.close();
  }
});
