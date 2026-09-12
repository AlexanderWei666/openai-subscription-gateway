import path from "node:path";
import type { Config } from "../config.ts";

/**
 * effective configuration 报告(doctor 与 `osg config` 共用)。
 * 目的:让维护者/AI 一眼看出每个值"生效的是多少、从哪来",
 * 尤其是 clientVersion 的 configured / detected / fallback / effective。
 * 纯函数,便于单测。
 */
export function formatEffectiveConfigReport(config: Config): string {
  const info = config.clientVersionInfo;
  const lines: string[] = [];

  lines.push("Effective configuration:");
  lines.push(`  host           = ${config.host}   (source: ${config.sources.host})`);
  lines.push(`  port           = ${config.port}   (source: ${config.sources.port})`);
  lines.push(`  home           = ${config.home}   (source: ${config.sources.home})`);
  lines.push(`  auth path      = ${path.join(config.home, "auth.json")}`);
  lines.push(`  codex home     = ${config.codexHome}   (source: ${config.sources.codexHome})`);
  lines.push(`  log level      = ${config.logLevel}   (source: ${config.sources.logLevel})`);
  lines.push(`  clientVersion  = ${info.effective}   (source: ${info.source})`);
  lines.push(`     configured  : env=${info.configuredEnv ?? "<none>"} config.json=${info.configuredFile ?? "<none>"}`);
  lines.push(`     detected    : ${info.detected ? `${info.detected.value} (via ${info.detected.via})` : "<none>"}`);
  lines.push(`     fallback    : ${info.fallback}`);
  if (info.notes.length > 0) {
    lines.push("     notes       :");
    for (const n of info.notes) lines.push(`       - ${n}`);
  }

  return lines.join("\n");
}
