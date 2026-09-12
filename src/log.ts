/**
 * 极简日志 + 密钥脱敏。
 * 红线:access_token / refresh_token / Authorization / cookie / credential JSON
 * 永远不得进入日志。所有已知密钥值通过 registerSecret() 登记,输出前统一掩码。
 */

type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let currentLevel: Level = "info";
const secrets = new Set<string>();

export function setLogLevel(level: Level): void {
  currentLevel = level;
}

/** 登记一个绝不许出现在日志里的值(token、cookie 等)。过短的值忽略避免误伤。 */
export function registerSecret(value: string | null | undefined): void {
  if (value && value.length >= 8) secrets.add(value);
}

/** 对任意字符串做脱敏:已登记密钥 + 常见 token 形态一律掩码。 */
export function redact(input: string): string {
  let out = input;
  for (const s of secrets) out = out.split(s).join("[REDACTED]");
  // Bearer <token>
  out = out.replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]");
  // JWT 形态(xxx.yyy.zzz)
  out = out.replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g, "[REDACTED-JWT]");
  return out;
}

function fmt(level: Level, msg: string, extra?: unknown): string {
  const base = `[osg ${level}] ${redact(msg)}`;
  if (extra === undefined) return base;
  let detail: string;
  try {
    detail = typeof extra === "string" ? extra : JSON.stringify(extra);
  } catch {
    detail = "[unserializable]";
  }
  return `${base} ${redact(detail)}`;
}

function write(level: Level, msg: string, extra?: unknown): void {
  if (ORDER[level] < ORDER[currentLevel]) return;
  process.stderr.write(fmt(level, msg, extra) + "\n");
}

export const log = {
  debug: (msg: string, extra?: unknown) => write("debug", msg, extra),
  info: (msg: string, extra?: unknown) => write("info", msg, extra),
  warn: (msg: string, extra?: unknown) => write("warn", msg, extra),
  error: (msg: string, extra?: unknown) => write("error", msg, extra),
};
