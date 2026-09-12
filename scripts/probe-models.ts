/** 一次性探针:dump 实时 /models 响应的 shape(不含任何凭证) */
import { loadConfig } from "../src/config.ts";
import { CredentialStore } from "../src/auth/store.ts";
import { TokenManager } from "../src/auth/oauth.ts";
import { CodexUpstream } from "../src/upstream/codex.ts";

const config = loadConfig();
const store = new CredentialStore(config.home);
const tokens = new TokenManager(store);
const upstream = new CodexUpstream(config, async ({ forceRefresh }) => {
  const auth = await tokens.getFresh({ forceRefresh });
  return auth ? { accessToken: auth.tokens.accessToken, accountId: auth.tokens.accountId } : null;
});

const { status, json, headers } = await upstream.getJson(`/models?client_version=${config.clientVersion}`);
const top = json as Record<string, unknown>;
console.log("status:", status);
console.log("etag:", headers.get("etag"));
console.log("top-level keys:", Object.keys(top));
const models = top.models;
console.log("models is array:", Array.isArray(models), "length:", Array.isArray(models) ? models.length : "n/a");
if (Array.isArray(models) && models.length > 0) {
  const first = models[0] as Record<string, unknown>;
  console.log("first entry keys:", Object.keys(first).sort());
  console.log("first entry sample:", JSON.stringify({
    slug: first.slug,
    id: first.id,
    visibility: first.visibility,
    supported_in_api: first.supported_in_api,
    display_name: first.display_name,
  }));
  const visibilities = [...new Set(models.map((m) => String((m as Record<string, unknown>).visibility)))];
  console.log("distinct visibility values:", visibilities);
}
