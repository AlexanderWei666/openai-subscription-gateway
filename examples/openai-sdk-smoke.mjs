/**
 * OpenAI SDK smoke:验证 gateway 对标准 SDK 开箱可用。
 *
 * 前置:
 *   1. osg serve 已启动(默认 127.0.0.1:10101)
 *   2. 已完成 osg login
 *   3. 本目录安装 openai: pnpm add openai (或在任意有 openai 包的环境运行)
 *
 * 运行: node examples/openai-sdk-smoke.mjs
 */
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: process.env.OSG_URL ?? "http://127.0.0.1:10101/v1",
  apiKey: "local-placeholder",
});

const model = process.env.OSG_MODEL ?? "gpt-5.5";

// 1. models
const models = await client.models.list();
console.log(`[PASS] models.list: ${models.data.length} models`);

// 2. responses 非流式
const resp = await client.responses.create({
  model,
  input: "Reply with exactly: SMOKE_OK",
  max_output_tokens: 32,
});
console.log(`[PASS] responses.create: status=${resp.status} usage=${JSON.stringify(resp.usage ?? null)}`);

// 3. responses 流式
const stream = await client.responses.create({
  model,
  input: "Count: 1 2 3",
  max_output_tokens: 32,
  stream: true,
});
let deltas = 0;
for await (const event of stream) {
  if (event.type === "response.output_text.delta") deltas++;
}
console.log(`[PASS] responses stream: ${deltas} text deltas`);

// 4. chat completions(兼容层)
const chat = await client.chat.completions.create({
  model,
  messages: [{ role: "user", content: "Reply with exactly: CHAT_OK" }],
  max_completion_tokens: 32,
});
console.log(`[PASS] chat.completions: finish=${chat.choices[0]?.finish_reason}`);

console.log("SMOKE PASS");
