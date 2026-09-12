/** 一次性探针:逐个参数探测 /responses 支持面(只打印状态与错误 body,不含凭证) */
import { loadConfig } from "../src/config.ts";
import { CredentialStore } from "../src/auth/store.ts";
import { TokenManager } from "../src/auth/oauth.ts";
import { CodexUpstream } from "../src/upstream/codex.ts";
import { ModelCatalog, isVisibleModel } from "../src/upstream/catalog.ts";

const config = loadConfig();
const store = new CredentialStore(config.home);
const tokens = new TokenManager(store);
const upstream = new CodexUpstream(config, async ({ forceRefresh }) => {
  const auth = await tokens.getFresh({ forceRefresh });
  return auth ? { accessToken: auth.tokens.accessToken, accountId: auth.tokens.accountId } : null;
});
const catalog = new ModelCatalog({
  home: config.home,
  codexHome: config.codexHome,
  fetchModels: async () => {
    const { json } = await upstream.getJson(`/models?client_version=${config.clientVersion}`);
    return (json as { models: unknown[] }).models;
  },
});
const { models } = await catalog.getModels();
const top = [...models.filter(isVisibleModel)].sort((a, b) => a.priority - b.priority)[0]!;
console.log("using model:", top.slug);

const baseInput = [{ type: "message", role: "user", content: [{ type: "input_text", text: "Say OK" }] }];
const base: Record<string, unknown> = {
  model: top.slug,
  input: baseInput,
  stream: true,
  store: false,
  include: ["reasoning.encrypted_content"],
};

const variants: Array<[string, Record<string, unknown>]> = [
  ["baseline (最小集)", {}],
  ["instructions 非空", { instructions: "You are terse." }],
  ["reasoning effort", { reasoning: { effort: "low" } }],
  ["service_tier fast", { service_tier: "fast" }],
  ["temperature", { temperature: 0.5 }],
  ["top_p", { top_p: 0.9 }],
  ["truncation", { truncation: "auto" }],
  ["prompt_cache_key", { prompt_cache_key: "probe" }],
  ["metadata", { metadata: { k: "v" } }],
  ["tool_choice auto", { tool_choice: "auto" }],
  ["parallel_tool_calls", { parallel_tool_calls: true }],
  ["text.format", { text: { format: { type: "text" } } }],
  ["max_output_tokens", { max_output_tokens: 16 }],
  ["max_tokens", { max_tokens: 16 }],
];

for (const [name, extra] of variants) {
  const body = { ...base, ...extra };
  try {
    const res = await upstream.postResponsesStream(body);
    const reader = res.body!.getReader();
    let completed = false;
    let failed = "";
    const decoder = new TextDecoder();
    // 读到 completed/failed 或最多 60 个事件
    for (let i = 0; i < 60; i++) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      if (text.includes('"response.completed"')) {
        completed = true;
        break;
      }
      if (text.includes('"response.failed"')) {
        failed = text.slice(0, 200);
        break;
      }
    }
    await reader.cancel();
    console.log(`${name} -> 200 completed=${completed}${failed ? " failed=" + failed : ""}`);
  } catch (err) {
    const e = err as { status?: number; body?: string; message?: string };
    console.log(`${name} -> ${e.status ?? "?"}: ${(e.body ?? e.message ?? "").slice(0, 160)}`);
  }
}
