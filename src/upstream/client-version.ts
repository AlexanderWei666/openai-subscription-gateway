import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Codex clientVersion 解析(docs/UPSTREAM.md §9)。
 *
 * 为什么需要它:上游按 `client_version` 参数过滤模型目录,不认识的版本返回
 * 空数组(极易误诊为"账号无权限")。因此该值必须跟随用户实际使用的 Codex 版本。
 *
 * 优先级(高 → 低):
 *   1. 环境变量 OSG_CODEX_CLIENT_VERSION
 *   2. {OSG_HOME}/config.json 的 clientVersion
 *   3. 自动检测 `codex --version`(Windows 上优先 WSL 内的 codex)
 *   4. FALLBACK_CODEX_VERSION(= 最后 live 验证过的版本)
 *
 * 硬性约束:任何一步失败都**不得**中断启动;不自动升级;不自动改写配置。
 */

/**
 * 最后经 live 验证的 Codex 版本。发版或对齐上游后按
 * docs/MAINTENANCE.md 第 8 步手工更新(同时更新 UPSTREAM.md verified 块)。
 *
 * 0.154.0 的对齐依据(2026-09-12):用户 WSL 中的 codex 已升级到 0.154.0,
 * 以该版本实测 live 套件 9/9 全通(models / responses / streaming / reasoning /
 * fast / tools / image / refresh),即 UPSTREAM.md 记录的全部契约在 0.154.0 下依然成立。
 * 注意:未做上游源码级 diff(GitHub release notes 为空),以**实测**为验证依据——
 * 这与本项目既有做法一致(UPSTREAM.md 的契约本就来自实测)。
 */
export const FALLBACK_CODEX_VERSION = "0.154.0";

export type ClientVersionSource = "env" | "config" | "detect" | "fallback";

export interface DetectedVersion {
  value: string;
  /** 探测途径:wsl / codex.exe / cmd / codex */
  via: string;
}

export interface ClientVersionInfo {
  effective: string;
  source: ClientVersionSource;
  /** 来自 env 的值(未设为 null) */
  configuredEnv: string | null;
  /** 来自 config.json 的值(缺失/非法为 null) */
  configuredFile: string | null;
  /** 自动检测结果(失败为 null) */
  detected: DetectedVersion | null;
  fallback: string;
  /** 非致命问题(config 损坏、检测失败等),供 doctor 展示 */
  notes: string[];
}

export interface ResolveClientVersionDeps {
  env: NodeJS.ProcessEnv;
  /** OSG_HOME(config.json 所在目录) */
  home: string;
  /** 可注入以便测试;省略则执行真实探测 */
  detect?: () => DetectedVersion | null;
  /**
   * 即使 env/config 已给出值时也执行探测(doctor / osg config 展示 detected 用)。
   * 默认 false:已有配置就短路,避免每次 CLI 启动白等一次进程。
   */
  alwaysDetect?: boolean;
}

/** 提取用(宽松):从 `codex --version` 输出里抓版本号 */
const VERSION_RE = /([0-9]+\.[0-9]+\.[0-9]+)/;
/** 校验用(严格):配置值必须**整体**是 x.y.z,防止垃圾串进入上游 */
const STRICT_VERSION_RE = /^\d+\.\d+\.\d+$/;

/**
 * 版本号校验(严格)。配置来源(env / config.json)的取值必须通过它,
 * 否则该来源被忽略并降级到下一优先级——不允许明显垃圾字符串进入 upstream。
 */
export function isValidVersion(v: unknown): v is string {
  return typeof v === "string" && STRICT_VERSION_RE.test(v.trim());
}

/**
 * 真实探测:Windows 上优先 WSL 中的 codex(用户实际使用的那个),
 * 其次 Windows PATH。任何失败返回 null,绝不抛异常。
 */
export function detectCodexVersion(): DetectedVersion | null {
  const candidates: Array<[string, string[], string]> =
    process.platform === "win32"
      ? [
          ["wsl", ["codex", "--version"], "wsl"],
          ["codex.exe", ["--version"], "codex.exe"],
          ["cmd.exe", ["/c", "codex", "--version"], "cmd"],
        ]
      : [["codex", ["--version"], "codex"]];

  for (const [cmd, args, via] of candidates) {
    try {
      const out = execFileSync(cmd, args, {
        timeout: 8000,
        stdio: ["ignore", "pipe", "ignore"],
        encoding: "utf8",
      });
      const m = VERSION_RE.exec(out);
      if (m?.[1]) return { value: m[1], via };
    } catch {
      // 不可用/超时/被安全策略拦截 → 试下一个
    }
  }
  return null;
}

/** 只读 {home}/config.json 的 clientVersion;缺失/损坏/非法均返回 null 并记 note */
export function readConfigFileClientVersion(home: string, notes: string[]): string | null {
  const file = path.join(home, "config.json");
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      notes.push(`config.json 不可读(${code ?? "unknown"}),已忽略`);
    }
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    notes.push("config.json 不是合法 JSON,已忽略");
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    notes.push("config.json 顶层不是对象,已忽略");
    return null;
  }
  const value = (parsed as Record<string, unknown>).clientVersion;
  if (value === undefined) return null;
  if (!isValidVersion(value)) {
    notes.push("config.json 的 clientVersion 非法(需形如 0.153.4),已忽略");
    return null;
  }
  return value.trim();
}

/** 进程内探测缓存:同一进程只探测一次(避免每个 CLI 命令重复等待) */
let detectCache: DetectedVersion | null | undefined;

export function resetDetectCache(): void {
  detectCache = undefined;
}

/**
 * 按优先级解析出有效 clientVersion。**永不抛异常**。
 */
export function resolveClientVersion(deps: ResolveClientVersionDeps): ClientVersionInfo {
  const notes: string[] = [];

  const envRaw = deps.env.OSG_CODEX_CLIENT_VERSION;
  const envTrimmed = typeof envRaw === "string" ? envRaw.trim() : "";
  /** 仅用于日志展示;截断以免把超长垃圾串写进日志 */
  const envDisplay = envTrimmed.slice(0, 32);
  let configuredEnv: string | null = null;
  if (envRaw !== undefined) {
    if (envTrimmed === "") {
      notes.push("OSG_CODEX_CLIENT_VERSION 为空,已忽略");
    } else if (!isValidVersion(envTrimmed)) {
      // 严格校验:垃圾值直接丢弃并降级,不送上游
      notes.push(`OSG_CODEX_CLIENT_VERSION 非法(需形如 0.153.4),已忽略并降级:${envDisplay}`);
    } else {
      configuredEnv = envTrimmed;
    }
  }

  const configuredFile = readConfigFileClientVersion(deps.home, notes);

  // 短路:env/config 已提供值时默认不探测(探测要起进程,0.5–2s)。
  // doctor / osg config 传 alwaysDetect 以展示 detected 信息。
  const haveConfigured = configuredEnv !== null || configuredFile !== null;
  const shouldDetect = deps.alwaysDetect === true || !haveConfigured;

  let detected: DetectedVersion | null = null;
  if (shouldDetect) {
    if (deps.detect) {
      try {
        detected = deps.detect();
      } catch {
        notes.push("codex 版本检测抛错,已忽略");
        detected = null;
      }
    } else {
      try {
        detectCache ??= detectCodexVersion();
        detected = detectCache;
      } catch {
        notes.push("codex 版本检测失败,已忽略");
        detected = null;
      }
    }
  }

  let effective: string;
  let source: ClientVersionSource;
  if (configuredEnv !== null) {
    effective = configuredEnv;
    source = "env";
  } else if (configuredFile !== null) {
    effective = configuredFile;
    source = "config";
  } else if (detected !== null) {
    effective = detected.value;
    source = "detect";
  } else {
    effective = FALLBACK_CODEX_VERSION;
    source = "fallback";
    notes.push(`未检测到 codex CLI,使用已验证版本兜底(${FALLBACK_CODEX_VERSION})`);
  }

  return {
    effective,
    source,
    configuredEnv,
    configuredFile,
    detected,
    fallback: FALLBACK_CODEX_VERSION,
    notes: withDriftNote(notes, effective, source),
  };
}

/**
 * 检测得出的版本若低于已验证版本,目录可能缩水(上游按 client_version 过滤,
 * 低版本拿不到新模型)。这里只**提示**,不自动改动取值——保持"配置优先、
 * 不自动升级/降级"的原则。
 */
function withDriftNote(notes: string[], effective: string, source: ClientVersionSource): string[] {
  if (source !== "detect" && source !== "fallback") return notes;
  const cmp = compareVersions(effective, FALLBACK_CODEX_VERSION);
  if (cmp < 0) {
    notes.push(
      `检测到的版本(${effective})低于已验证版本(${FALLBACK_CODEX_VERSION}),` +
        "上游模型目录可能缩水;如需强制指定请设置 OSG_CODEX_CLIENT_VERSION 或 config.json",
    );
  }
  return notes;
}

/** 简易 x.y.z 比较:仅用于提示,不参与取值决策 */
export function compareVersions(a: string, b: string): number {
  const pa = VERSION_RE.exec(a)?.[1]?.split(".").map(Number) ?? null;
  const pb = VERSION_RE.exec(b)?.[1]?.split(".").map(Number) ?? null;
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}
