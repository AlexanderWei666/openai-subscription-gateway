import { test } from "node:test";
import assert from "node:assert/strict";
import { MockUpstream } from "../helpers/mock-upstream.ts";
import { startGateway } from "../helpers/gateway-server.ts";

test("GET /v1/models:OpenAI 标准 schema,过滤隐藏模型", async () => {
  const mock = await MockUpstream.start();
  const gw = await startGateway(mock);
  try {
    const res = await fetch(`${gw.url}/v1/models`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { object: string; data: Array<Record<string, unknown>> };
    assert.equal(body.object, "list");
    const ids = body.data.map((m) => m.id).sort();
    assert.deepEqual(ids, ["gpt-test-a", "gpt-test-b"], "hide / supported_in_api=false 被过滤");
    for (const m of body.data) {
      assert.deepEqual(Object.keys(m).sort(), ["created", "id", "object", "owned_by"], "不泄漏内部元数据");
      assert.equal(m.owned_by, "openai");
    }
    // 上游确实被打了 models endpoint 且带 client_version
    const upstreamReq = mock.requests.find((r) => r.url.startsWith("/models"));
    assert.ok(upstreamReq);
    assert.match(upstreamReq.url, /client_version=/);
  } finally {
    await gw.close();
    await mock.close();
  }
});

test("GET /internal/models:诊断面包含能力元数据", async () => {
  const mock = await MockUpstream.start();
  const gw = await startGateway(mock);
  try {
    const res = await fetch(`${gw.url}/internal/models`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { models: Array<Record<string, unknown>>; source: string };
    const a = body.models.find((m) => m.id === "gpt-test-a");
    assert.ok(a);
    assert.equal(a.supports_fast, true);
    assert.deepEqual(a.supported_reasoning_efforts, ["low", "medium", "high"]);
    assert.equal(a.context_window, 272000);
    assert.deepEqual(a.input_modalities, ["text", "image"]);
  } finally {
    await gw.close();
    await mock.close();
  }
});

test("GET /health 无需登录", async () => {
  const mock = await MockUpstream.start();
  const gw = await startGateway(mock);
  try {
    const res = await fetch(`${gw.url}/health`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { status: string };
    assert.equal(body.status, "ok");
  } finally {
    await gw.close();
    await mock.close();
  }
});

test("未知路径 → 404 OpenAI 风格错误", async () => {
  const mock = await MockUpstream.start();
  const gw = await startGateway(mock);
  try {
    const res = await fetch(`${gw.url}/v1/files`, { method: "POST" });
    assert.equal(res.status, 404);
    const body = (await res.json()) as { error: { type: string; message: string } };
    assert.match(body.error.message, /unknown|unsupported|not found/i);
  } finally {
    await gw.close();
    await mock.close();
  }
});
