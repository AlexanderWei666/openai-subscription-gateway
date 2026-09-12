import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

/**
 * Layer 3 — Live smoke。只有 LIVE_TEST=1 才允许访问真实 OpenAI。
 * 原则:极短请求,最少 token 消耗。
 * 运行方式:先 `osg login` + `osg serve`,再 LIVE_TEST=1 pnpm test:live
 */

const LIVE = process.env.LIVE_TEST === "1";
const BASE = process.env.OSG_URL ?? "http://127.0.0.1:10101";

async function pickModel(): Promise<string> {
  const res = await fetch(`${BASE}/internal/models`);
  assert.equal(res.status, 200, "gateway 须在运行且已登录");
  const body = (await res.json()) as { models: Array<{ id: string; priority: number }> };
  const top = [...body.models].sort((a, b) => a.priority - b.priority)[0];
  assert.ok(top, "无可用模型");
  return top.id;
}

test("live: models / responses / streaming / reasoning / fast", { skip: !LIVE }, async (t) => {
  const model = await pickModel();

  await t.test("models", async () => {
    const res = await fetch(`${BASE}/v1/models`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { data: unknown[] };
    assert.ok(body.data.length > 0);
  });

  await t.test("simple response", async () => {
    const res = await fetch(`${BASE}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, input: "Reply with exactly: OK", max_output_tokens: 16 }),
    });
    if (res.status !== 200) assert.fail(`status=${res.status}: ${await res.text()}`);
    const body = (await res.json()) as { status: string; usage?: unknown };
    assert.equal(body.status, "completed");
    assert.ok(body.usage, "usage 必须透传");
  });

  await t.test("streaming", async () => {
    const res = await fetch(`${BASE}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, input: "Count: 1 2", max_output_tokens: 16, stream: true }),
    });
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(text.includes("response.output_text.delta"));
    assert.ok(text.includes("response.completed"));
  });

  await t.test("reasoning effort", async () => {
    const res = await fetch(`${BASE}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, input: "1+1=?", max_output_tokens: 16, reasoning: { effort: "low" } }),
    });
    if (res.status !== 200) assert.fail(`status=${res.status}: ${await res.text()}`);
  });

  await t.test("fast service tier", async () => {
    const res = await fetch(`${BASE}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, input: "Reply with exactly: OK", max_output_tokens: 16, service_tier: "fast" }),
    });
    if (res.status !== 200) assert.fail(`status=${res.status}: ${await res.text()}`);
    assert.ok((res.headers.get("x-osg-normalized") ?? "").includes("fast->priority"), "tier 改写应透明上报");
  });

  await t.test("tool calling(纯透传,gateway 不执行)", async () => {
    const res = await fetch(`${BASE}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        input: "What is the weather in Paris? Use the get_weather tool.",
        tools: [
          {
            type: "function",
            name: "get_weather",
            description: "Get weather for a city",
            parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
          },
        ],
        tool_choice: { type: "function", name: "get_weather" },
      }),
    });
    if (res.status !== 200) assert.fail(`status=${res.status}: ${await res.text()}`);
    const body = (await res.json()) as { output?: Array<Record<string, unknown>> };
    const fc = (body.output ?? []).find((i) => i.type === "function_call");
    assert.ok(fc, "响应应包含 function_call item(模型应发起工具调用)");
    assert.equal(fc.name, "get_weather", "tool name 不得被改");
    assert.ok(typeof fc.arguments === "string" && fc.arguments.length > 0, "arguments 必须透传");
  });

  await t.test("image input(input_image 透传)", async () => {
    // 1x1 PNG
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const res = await fetch(`${BASE}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        input: [
          {
            type: "message",
            role: "user",
            content: [
              { type: "input_text", text: "Describe this image in one word." },
              { type: "input_image", image_url: `data:image/png;base64,${png}` },
            ],
          },
        ],
      }),
    });
    if (res.status !== 200) assert.fail(`status=${res.status}: ${await res.text()}`);
    const body = (await res.json()) as { output?: Array<Record<string, unknown>> };
    assert.ok((body.output ?? []).length > 0, "图像请求应产出非空 output");
  });
});

test("live: token refresh 通路(osg status 侧证)", { skip: !LIVE }, async () => {
  const execFileP = promisify(execFile);
  const { stdout } = await execFileP(process.execPath, ["dist/cli/index.js", "status"], {
    cwd: process.cwd(),
  });
  assert.match(stdout, /logged in/);
});
