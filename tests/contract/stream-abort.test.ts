import { test } from "node:test";
import assert from "node:assert/strict";
import { MockUpstream } from "../helpers/mock-upstream.ts";
import { startGateway } from "../helpers/gateway-server.ts";

/**
 * v0.1.1:SSE backpressure 下的客户端断开处理。
 *
 * 回归目标:`res.write()` 返回 false 后进入 drain 等待时,如果客户端已断开,
 * 必须立即结束 pump 并取消上游——旧实现裸等 `once(res,"drain")` 会永久挂起
 * (本文件中的用例在没有修复时会超时失败)。
 */

/** 生成大量事件,足以把 socket 缓冲顶到高水位(触发 write() 返回 false) */
function floodEvents(count: number): string[] {
  const events: string[] = [JSON.stringify({ type: "response.created", response: { id: "resp_flood" } })];
  const filler = "x".repeat(512);
  for (let i = 0; i < count; i++) {
    events.push(
      JSON.stringify({
        type: "response.output_text.delta",
        delta: `${String(i)}-${filler}`,
        item_id: "m1",
        output_index: 0,
        content_index: 0,
      }),
    );
  }
  events.push(
    JSON.stringify({
      type: "response.completed",
      response: { id: "resp_flood", status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
    }),
  );
  return events;
}

test("backpressure:客户端在 drain 等待期间断开 → pump 结束且上游被取消", async () => {
  const mock = await MockUpstream.start();
  // 大量事件 + 极短间隔:下游不消费时必然触发 backpressure
  mock.setBehavior({ kind: "sse", events: floodEvents(4000), delayBetweenMs: 0 });
  const gw = await startGateway(mock);
  const controller = new AbortController();
  try {
    const res = await fetch(`${gw.url}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-test-a", input: "flood", stream: true }),
      signal: controller.signal,
    });
    assert.equal(res.status, 200);
    const reader = res.body!.getReader();
    await reader.read(); // 只读第一块,其余不消费 → 触发写侧背压
    controller.abort(); // 客户端离开

    // 取消必须传播到上游;旧实现会永远卡在 drain 等待(此断言即超时失败)
    const deadline = Date.now() + 5000;
    while (!mock.clientAborted && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(mock.clientAborted, true, "drain 期间断开必须结束 pump 并取消上游");
  } finally {
    await gw.close();
    await mock.close();
  }
});

test("backpressure:正常消费全部事件时不受影响(不误伤)", async () => {
  const mock = await MockUpstream.start();
  mock.setBehavior({ kind: "sse", events: floodEvents(200), delayBetweenMs: 0 });
  const gw = await startGateway(mock);
  try {
    const res = await fetch(`${gw.url}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-test-a", input: "flood", stream: true }),
    });
    const text = await res.text(); // 完整读完
    assert.ok(text.includes("response.completed"), "正常消费路径必须拿到全部事件");
    assert.ok(!text.includes("premature_close"), "正常收尾不应注入错误");
  } finally {
    await gw.close();
    await mock.close();
  }
});
