#!/usr/bin/env node
import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { loadConfig, GATEWAY_VERSION, type Config } from "../config.ts";
import { log, setLogLevel } from "../log.ts";
import { CredentialStore } from "../auth/store.ts";
import { login, logout, TokenManager } from "../auth/oauth.ts";
import { extractUserLabel, jwtExpiration } from "../auth/jwt.ts";
import { CodexUpstream } from "../upstream/codex.ts";
import { detectCodexVersion } from "../upstream/client-version.ts";
import { ModelCatalog, isVisibleModel, supportsFast } from "../upstream/catalog.ts";
import { formatEffectiveConfigReport } from "./config-report.ts";
import { createGatewayServer } from "../server.ts";

/** 极简 CLI:无框架,单一 switch。命令契约见 README。 */

const execFileP = promisify(execFile);

interface Runtime {
  config: Config;
  store: CredentialStore;
  tokens: TokenManager;
  upstream: CodexUpstream;
  catalog: ModelCatalog;
}

function buildRuntime(opts: { alwaysDetect?: boolean } = {}): Runtime {
  const config = loadConfig(process.env, opts.alwaysDetect ? { alwaysDetect: true } : {});
  setLogLevel(config.logLevel);
  const store = new CredentialStore(config.home);
  const tokens = new TokenManager(store);
  const upstream = new CodexUpstream(config, async ({ forceRefresh }) => {
    const auth = await tokens.getFresh({ forceRefresh });
    if (!auth) return null;
    return { accessToken: auth.tokens.accessToken, accountId: auth.tokens.accountId };
  });
  const catalog = new ModelCatalog({
    home: config.home,
    codexHome: config.codexHome,
    fetchModels: async () => {
      const { json } = await upstream.getJson(`/models?client_version=${encodeURIComponent(config.clientVersion)}`);
      const models = (json as { models?: unknown }).models;
      if (!Array.isArray(models)) throw new Error("unexpected /models response shape");
      return models;
    },
  });
  return { config, store, tokens, upstream, catalog };
}

function usage(): void {
  process.stdout.write(
    [
      "openai-subscription-gateway (osg)",
      "",
      "Usage:",
      "  osg login            ChatGPT OAuth 登录(浏览器授权)",
      "  osg logout           撤销并删除本 gateway 的凭证",
      "  osg status           登录状态与 token 有效期",
      "  osg serve            启动 OpenAI-compatible API(默认 127.0.0.1:10101)",
      "  osg models           列出可用模型(动态目录)",
      "  osg doctor [--live]  自检(--live 会发一次极短真实请求)",
      "  osg config           打印 effective configuration(含各值来源)",
      "  osg upstream-check   对比已验证上游与本机 Codex CLI",
      "",
    ].join("\n"),
  );
}

function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

async function cmdServe(): Promise<void> {
  const rt = buildRuntime();
  if (!isLoopback(rt.config.host)) {
    process.stderr.write(
      "WARNING: exposing this gateway may allow other clients to consume your ChatGPT subscription.\n",
    );
  }
  const server = createGatewayServer({ config: rt.config, upstream: rt.upstream, catalog: rt.catalog });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(rt.config.port, rt.config.host, () => resolve());
  });
  process.stdout.write(`osg listening on http://${rt.config.host}:${rt.config.port}/v1\n`);
}

async function cmdLogin(): Promise<void> {
  const rt = buildRuntime();
  const { accountId } = await login(rt.store);
  process.stdout.write(`Login successful.${accountId ? ` Account: ${accountId}` : ""}\n`);
}

async function cmdLogout(): Promise<void> {
  const rt = buildRuntime();
  const removed = await logout(rt.store);
  process.stdout.write(removed ? "Logged out.\n" : "Not logged in.\n");
}

async function cmdStatus(): Promise<void> {
  const rt = buildRuntime();
  const auth = await rt.store.load();
  if (!auth) {
    process.stdout.write("Status: NOT logged in. Run `osg login`.\n");
    return;
  }
  const exp = jwtExpiration(auth.tokens.accessToken);
  const user = extractUserLabel(auth.tokens.idToken);
  const lines = [
    "Status: logged in",
    user ? `User: ${user}` : null,
    auth.tokens.accountId ? `Account ID: ${auth.tokens.accountId}` : "Account ID: (unknown)",
    exp ? `Access token expires: ${new Date(exp * 1000).toISOString()}` : "Access token expiry: unknown",
    `Last refresh: ${auth.lastRefresh || "unknown"}`,
  ].filter((x): x is string => x !== null);
  process.stdout.write(lines.join("\n") + "\n");
}

async function cmdModels(): Promise<void> {
  const rt = buildRuntime();
  const { models, source, fetchedAt } = await rt.catalog.getModels();
  const visible = models.filter(isVisibleModel);
  process.stdout.write(`source=${source} fetched_at=${fetchedAt ?? "unknown"}\n`);
  for (const m of visible) {
    const fast = supportsFast(m) ? " fast" : "";
    const ctx = m.contextWindow ? ` ctx=${m.contextWindow}` : "";
    const reasoning = m.supportedReasoningLevels.length > 0 ? ` reasoning=[${m.supportedReasoningLevels.join("|")}]` : "";
    process.stdout.write(`${m.slug}\t${m.displayName}${ctx}${fast}${reasoning}\n`);
  }
}

type Check = { name: string; run: () => Promise<{ ok: boolean; detail?: string }> };

async function cmdDoctor(live: boolean): Promise<void> {
  // alwaysDetect:doctor 需要展示 detected 与 fallback 的差异
  const rt = buildRuntime({ alwaysDetect: true });
  let failures = 0;
  const report = async (name: string, fn: () => Promise<{ ok: boolean; detail?: string }>) => {
    try {
      const r = await fn();
      process.stdout.write(`[${r.ok ? "PASS" : "FAIL"}] ${name}${r.detail ? ` — ${r.detail}` : ""}\n`);
      if (!r.ok) failures++;
    } catch (err) {
      process.stdout.write(`[FAIL] ${name} — ${err instanceof Error ? err.message : String(err)}\n`);
      failures++;
    }
  };

  await report("runtime", async () => {
    const major = Number(process.versions.node.split(".")[0]);
    return { ok: major >= 24, detail: `node ${process.versions.node}` };
  });
  await report("config", async () => ({
    ok: true,
    detail: `home=${rt.config.home} listen=${rt.config.host}:${rt.config.port}`,
  }));
  await report("credential path", async () => {
    try {
      await stat(rt.store.authPath);
      return { ok: true, detail: rt.store.authPath };
    } catch {
      return { ok: false, detail: "auth.json not found — run `osg login`" };
    }
  });
  // Windows:不显示 PASS。OSG 假定可信本地用户环境,不管理 NTFS ACL(设计决策,
  // 见 README "凭证与权限")。POSIX 平台继续做 0600 检查。
  if (process.platform === "win32") {
    process.stdout.write(
      "WARN: Windows ACL not verified. OSG assumes a trusted local user environment.\n",
    );
  } else {
    await report("credential permission", async () => {
      const s = await stat(rt.store.authPath);
      const mode = s.mode & 0o777;
      return { ok: mode === 0o600, detail: `mode=${mode.toString(8)}` };
    });
  }
  await report("OAuth token available", async () => {
    const auth = await rt.tokens.getFresh();
    if (!auth) return { ok: false, detail: "no usable token" };
    const exp = jwtExpiration(auth.tokens.accessToken);
    return { ok: true, detail: exp ? `expires ${new Date(exp * 1000).toISOString()}` : "expiry unknown" };
  });
  await report("upstream reachable", async () => {
    // 不带凭证打 models endpoint:401/403 即证明网络通
    const res = await fetch(`${rt.config.upstreamBaseUrl}/models?client_version=${rt.config.clientVersion}`, {
      signal: AbortSignal.timeout(10_000),
    });
    await res.arrayBuffer().catch(() => {});
    const reachable = res.status === 401 || res.status === 403 || res.ok;
    return { ok: reachable, detail: `status=${res.status}` };
  });
  await report("model catalog", async () => {
    try {
      const { models, source } = await rt.catalog.listVisible();
      return { ok: models.length > 0, detail: `source=${source} count=${models.length}` };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  });

  if (live) {
    await report("live inference (minimal)", async () => {
      const { models } = await rt.catalog.listVisible();
      const top = [...models].sort((a, b) => a.priority - b.priority)[0];
      if (!top) return { ok: false, detail: "no visible model" };
      const res = await rt.upstream.postResponsesStream({
        model: top.slug,
        // 上游契约:input 必须是 item 列表;不支持 max_output_tokens(UPSTREAM.md §6/§7)
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Reply with exactly: OK" }] }],
        stream: true,
        store: false,
        include: ["reasoning.encrypted_content"],
      });
      if (!res.body) return { ok: false, detail: "empty body" };
      // 只读到 completed 就停
      const { parseSse } = await import("../upstream/sse.ts");
      let ok = false;
      for await (const ev of parseSse(res.body)) {
        const t = (JSON.parse(ev.data) as { type?: string }).type;
        if (t === "response.completed") {
          ok = true;
          break;
        }
        if (t === "response.failed") break;
      }
      await res.body.cancel().catch(() => {});
      return { ok, detail: `model=${top.slug}` };
    });
  }

  process.stdout.write(`\n${formatEffectiveConfigReport(rt.config)}\n`);
  process.exitCode = failures > 0 ? 1 : 0;
}

/** osg config:打印 effective configuration(与 doctor 同一份数据) */
async function cmdConfig(): Promise<void> {
  const rt = buildRuntime({ alwaysDetect: true });
  process.stdout.write(`${formatEffectiveConfigReport(rt.config)}\n`);
}

async function cmdUpstreamCheck(): Promise<void> {
  const rt = buildRuntime();
  const docsPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "docs", "UPSTREAM.md");
  let verified = "unknown";
  try {
    const doc = await readFile(docsPath, "utf8");
    const m = doc.match(/Last verified Codex CLI version:\s*([0-9.]+)/);
    if (m?.[1]) verified = m[1];
  } catch {
    process.stdout.write(`WARN: cannot read ${docsPath}\n`);
  }

  let installedVersion: string | null = null;
  let installedLabel = "not found";
  // 复用统一的探测逻辑(WSL 优先 → Windows PATH;失败静默返回 null)
  const detected = detectCodexVersion();
  if (detected) {
    installedVersion = detected.value;
    installedLabel = detected.via === "wsl" ? `${detected.value} (WSL)` : detected.value;
  }

  const potential: string[] = [];
  if (installedVersion === null) {
    potential.push("Codex CLI not found on PATH/WSL (skip version comparison)");
  } else if (installedVersion !== verified) {
    potential.push(`Codex CLI version drift: verified=${verified} installed=${installedLabel}`);
  }

  // 廉价 schema 检查:目录字段是否仍符合契约
  try {
    const { models } = await rt.catalog.getModels();
    for (const m of models.slice(0, 20)) {
      if (!m.slug) potential.push("catalog entry missing slug");
      if (m.supportedReasoningLevels.length === 0) {
        potential.push(`catalog entry ${m.slug} has empty supported_reasoning_levels`);
      }
    }
  } catch (err) {
    potential.push(`catalog check failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (potential.length === 0) {
    process.stdout.write("UPSTREAM_STATUS: CURRENT\n");
  } else {
    process.stdout.write(
      [
        "UPSTREAM_STATUS: REVIEW_REQUIRED",
        "",
        `Verified Codex: ${verified}`,
        `Installed Codex: ${installedLabel}`,
        "",
        "Potential changes:",
        ...potential.map((p) => `- ${p}`),
        "",
        "Action: follow docs/MAINTENANCE.md to re-verify against official openai/codex.",
        "",
      ].join("\n"),
    );
    process.exitCode = 2;
  }
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case "login":
      await cmdLogin();
      break;
    case "logout":
      await cmdLogout();
      break;
    case "status":
      await cmdStatus();
      break;
    case "serve":
      await cmdServe();
      break;
    case "models":
      await cmdModels();
      break;
    case "doctor":
      await cmdDoctor(args.includes("--live"));
      break;
    case "config":
      await cmdConfig();
      break;
    case "upstream-check":
      await cmdUpstreamCheck();
      break;
    default:
      usage();
      process.exitCode = cmd ? 1 : 0;
  }
}

main().catch((err) => {
  log.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
