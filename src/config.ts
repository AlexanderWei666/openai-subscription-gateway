import os from "node:os";
import path from "node:path";
import {
  resolveClientVersion,
  type ClientVersionInfo,
  type DetectedVersion,
} from "./upstream/client-version.ts";

/** 与 package.json 的 version 保持一致(发版时同步修改)。 */
export const GATEWAY_VERSION = "0.1.1";

/**
 * 上游常量。取值来源:docs/UPSTREAM.md(官方 openai/codex 源码)。
 * 修改这些值前必须先按 docs/MAINTENANCE.md 核对上游。
 */
export const UPSTREAM = {
  baseUrl: "https://chatgpt.com/backend-api/codex",
  oauthIssuer: "https://auth.openai.com",
  oauthClientId: "app_EMoamEEZ73f0CkXaXp7hrann",
  oauthScope:
    "openid profile email offline_access api.connectors.read api.connectors.invoke",
  callbackPorts: [1455, 1457],
  /** access_token 过期前多少秒触发主动刷新(对齐 Codex CLI 的 5 分钟窗口) */
  refreshWindowSec: 300,
} as const;

/** 单字段的取值来源,供 doctor / osg config 展示 */
export type FieldSource = "env" | "config" | "detect" | "fallback" | "default";

export interface Config {
  host: string;
  port: number;
  /** 凭证与缓存目录,默认 ~/.openai-subscription-gateway */
  home: string;
  logLevel: "debug" | "info" | "warn" | "error";
  /** 仅供测试/mock 覆盖,生产永远是 UPSTREAM.baseUrl */
  upstreamBaseUrl: string;
  upstreamTimeoutMs: number;
  /**
   * 发给上游 models endpoint 的 client_version(= clientVersionInfo.effective)。
   * 行为关键(docs/UPSTREAM.md §9):上游按此值过滤目录,
   * 不认识的版本返回空 models 数组。
   */
  clientVersion: string;
  /** clientVersion 的完整解析结果(configured/detected/fallback/effective/source) */
  clientVersionInfo: ClientVersionInfo;
  /** 各字段的取值来源,便于未来维护者定位"这个值从哪来" */
  sources: Record<"host" | "port" | "home" | "logLevel" | "codexHome" | "clientVersion", FieldSource>;
  /** Codex CLI 的 home(只读 models_cache.json 兜底用),默认 ~/.codex */
  codexHome: string;
}

const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
type LogLevel = (typeof LOG_LEVELS)[number];

function parseLogLevel(v: string | undefined): LogLevel {
  if (v && (LOG_LEVELS as readonly string[]).includes(v)) return v as LogLevel;
  return "info";
}

function pick(envValue: string | undefined, fallback: string): [string, FieldSource] {
  return envValue !== undefined && envValue.trim() !== "" ? [envValue, "env"] : [fallback, "default"];
}

export interface LoadConfigOptions {
  /** 注入 codex 版本探测(测试用);省略则执行真实探测 */
  detect?: () => DetectedVersion | null;
  /** 已有配置值时也强制探测(doctor / osg config 展示用) */
  alwaysDetect?: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, opts: LoadConfigOptions = {}): Config {
  const [host, hostSrc] = pick(env.OSG_HOST, "127.0.0.1");
  const [portRaw, portSrc] = pick(env.OSG_PORT, "10101");
  const [home, homeSrc] = pick(env.OSG_HOME, path.join(os.homedir(), ".openai-subscription-gateway"));
  const logLevel = parseLogLevel(env.OSG_LOG_LEVEL);
  const [codexHome, codexHomeSrc] = pick(env.CODEX_HOME, path.join(os.homedir(), ".codex"));

  // clientVersion:env > config.json > 自动检测 > 已验证版本兜底(永不抛,不阻断启动)
  const clientVersionInfo = resolveClientVersion({
    env,
    home,
    ...(opts.detect ? { detect: opts.detect } : {}),
    ...(opts.alwaysDetect ? { alwaysDetect: true } : {}),
  });

  return {
    host,
    port: Number.parseInt(portRaw, 10),
    home,
    logLevel,
    upstreamBaseUrl: env.OSG_UPSTREAM_BASE_URL ?? UPSTREAM.baseUrl,
    upstreamTimeoutMs: Number.parseInt(env.OSG_UPSTREAM_TIMEOUT_MS ?? "300000", 10),
    clientVersion: clientVersionInfo.effective,
    clientVersionInfo,
    sources: {
      host: hostSrc,
      port: portSrc,
      home: homeSrc,
      logLevel: env.OSG_LOG_LEVEL ? "env" : "default",
      codexHome: codexHomeSrc,
      clientVersion: clientVersionInfo.source,
    },
    codexHome,
  };
}
