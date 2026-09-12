/** 一次性探针:直连上游 dump tools 请求的完整 SSE 事件序列(不含凭证) */
import { loadConfig } from "../src/config.ts";
import { CredentialStore } from "../src/auth/store.ts";
import { TokenManager } from "../src/auth/oauth.ts";
import { CodexUpstream } from "../src/upstream/codex.ts";
import { parseSse } from "../src/upstream/sse.ts";

const config = loadConfig();
const store = new CredentialStore(config.home);
const tokens = new TokenManager(store);
const upstream = new CodexUpstream(config, async ({ forceRefresh }) => {
  const auth = await tokens.getFresh({ forceRefresh });
  return auth ? { accessToken: auth.tokens.accessToken, accountId: auth.tokens.accountId } : null;
});

const res = await upstream.postResponsesStream({
  model: "gpt-5.6-sol",
  input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "What is the weather in Paris? Use the get_weather tool." }] }],
  tools: [{ type: "function", name: "get_weather", description: "Get weather for a city", parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } }],
  tool_choice: "auto",
  stream: true,
  store: false,
  include: ["reasoning.encrypted_content"],
});

const counts = new Map<string, number>();
let completedPayload = "";
for await (const ev of parseSse(res.body!)) {
  let type = "?";
  try {
    type = (JSON.parse(ev.data) as { type?: string }).type ?? "?";
  } catch { /* keep */ }
  counts.set(type, (counts.get(type) ?? 0) + 1);
  if (type === "response.completed") completedPayload = ev.data;
}
console.log("event counts:", JSON.stringify([...counts.entries()]));
if (completedPayload) {
  const parsed = JSON.parse(completedPayload) as { response?: Record<string, unknown> };
  const r = parsed.response ?? {};
  console.log("completed.status:", r.status);
  console.log("completed.output:", JSON.stringify(r.output).slice(0, 500));
  console.log("completed keys:", Object.keys(r).sort().join(","));
} else {
  console.log("NO response.completed received");
}
