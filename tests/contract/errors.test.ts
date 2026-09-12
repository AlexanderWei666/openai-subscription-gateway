import { test } from "node:test";
import assert from "node:assert/strict";
import { MockUpstream } from "../helpers/mock-upstream.ts";
import { startGateway } from "../helpers/gateway-server.ts";

async function post(gwUrl: string): Promise<Response> {
  return fetch(`${gwUrl}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-test-a", input: "hi" }),
  });
}

test("上游 400 → 下游 400,message 保留", async () => {
  const mock = await MockUpstream.start();
  mock.setBehavior({ kind: "status", status: 400, body: JSON.stringify({ error: { message: "bad request here", code: "invalid" } }) });
  const gw = await startGateway(mock);
  try {
    const res = await post(gw.url);
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: { message: string; type: string } };
    assert.equal(body.error.message, "bad request here");
    assert.equal(body.error.type, "invalid_request_error");
  } finally {
    await gw.close();
    await mock.close();
  }
});

test("上游 429 → 下游 429 且透传 Retry-After", async () => {
  const mock = await MockUpstream.start();
  mock.setBehavior({
    kind: "status",
    status: 429,
    body: JSON.stringify({ error: { message: "rate limited" } }),
    headers: { "retry-after": "23" },
  });
  const gw = await startGateway(mock);
  try {
    const res = await post(gw.url);
    assert.equal(res.status, 429);
    assert.equal(res.headers.get("retry-after"), "23");
  } finally {
    await gw.close();
    await mock.close();
  }
});

test("上游 500 → 下游 502;网络不可达 → 503;超时 → 504", async () => {
  const mock = await MockUpstream.start();
  mock.setBehavior({ kind: "status", status: 500, body: "internal explosion" });
  const gw = await startGateway(mock);
  try {
    const res = await post(gw.url);
    assert.equal(res.status, 502);
    const body = (await res.json()) as { error: { type: string } };
    assert.equal(body.error.type, "upstream_error");
  } finally {
    await gw.close();
    await mock.close();
  }

  // 网络不可达:gateway 指向已关闭的端口
  const mockDead = await MockUpstream.start();
  const gwDead = await startGateway(mockDead);
  await mockDead.close(); // 端口即刻变不可达
  try {
    const res = await post(gwDead.url);
    assert.equal(res.status, 503);
    const body = (await res.json()) as { error: { type: string } };
    assert.equal(body.error.type, "upstream_unavailable");
  } finally {
    await gwDead.close();
  }

  // 超时:mock hang + 短超时
  const mock2 = await MockUpstream.start();
  mock2.setBehavior({ kind: "hang" });
  const gw2 = await startGateway(mock2);
  gw2.runtime.config.upstreamTimeoutMs = 80;
  try {
    const res = await post(gw2.url);
    assert.equal(res.status, 504);
    const body = (await res.json()) as { error: { type: string } };
    assert.equal(body.error.type, "upstream_timeout");
  } finally {
    await gw2.close();
    await mock2.close();
  }
});

test("上游 401 → 触发一次强制刷新并重试,第二次成功", async () => {
  const mock = await MockUpstream.start();
  mock.setBehavior({
    kind: "sequence",
    steps: [
      { kind: "status", status: 401, body: JSON.stringify({ error: { message: "token expired" } }) },
      {
        kind: "sse",
        events: [
          JSON.stringify({
            type: "response.completed",
            response: { id: "ok", status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
          }),
        ],
      },
    ],
  });
  const gw = await startGateway(mock);
  try {
    const res = await post(gw.url);
    assert.equal(res.status, 200, "401 后刷新重试应成功");
    const responsesReqs = mock.requests.filter((r) => r.url === "/responses");
    assert.equal(responsesReqs.length, 2, "上游应被请求两次");
    assert.ok(gw.runtime.forceRefreshCalls >= 1, "必须触发强制刷新");
  } finally {
    await gw.close();
    await mock.close();
  }
});

test("连接层瞬断自动重试:前两次 socket 断开,第三次成功 → 下游 200", async () => {
  const mock = await MockUpstream.start();
  mock.setBehavior({
    kind: "sequence",
    steps: [
      { kind: "socketDestroy" },
      { kind: "socketDestroy" },
      {
        kind: "sse",
        events: [
          JSON.stringify({
            type: "response.completed",
            response: { id: "ok", status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
          }),
        ],
      },
    ],
  });
  const gw = await startGateway(mock);
  try {
    const res = await post(gw.url);
    assert.equal(res.status, 200, "网关内部重试后应返回 200");
    const body = (await res.json()) as { status: string };
    assert.equal(body.status, "completed");
    assert.equal(mock.requests.filter((r) => r.url === "/responses").length, 3, "上游应被尝试 3 次");
  } finally {
    await gw.close();
    await mock.close();
  }
});

test("连接持续失败 → 下游 503 upstream_unavailable(重试有上限)", async () => {
  const mock = await MockUpstream.start();
  mock.setBehavior({ kind: "socketDestroy" });
  const gw = await startGateway(mock);
  try {
    const res = await post(gw.url);
    assert.equal(res.status, 503);
    const body = (await res.json()) as { error: { type: string } };
    assert.equal(body.error.type, "upstream_unavailable");
    assert.equal(mock.requests.filter((r) => r.url === "/responses").length, 3, "最多 3 次尝试后放弃");
  } finally {
    await gw.close();
    await mock.close();
  }
});

test("上游持续 401 → 下游 401 authentication_error(不无限重试)", async () => {
  const mock = await MockUpstream.start();
  mock.setBehavior({ kind: "status", status: 401, body: JSON.stringify({ error: { message: "unauthorized" } }) });
  const gw = await startGateway(mock);
  try {
    const res = await post(gw.url);
    assert.equal(res.status, 401);
    const body = (await res.json()) as { error: { type: string; message: string } };
    assert.equal(body.error.type, "authentication_error");
    const responsesReqs = mock.requests.filter((r) => r.url === "/responses");
    assert.equal(responsesReqs.length, 2, "最多重试一次");
  } finally {
    await gw.close();
    await mock.close();
  }
});
