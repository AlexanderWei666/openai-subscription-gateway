/**
 * 文档保鲜检查(零依赖,Node 24 直接跑:`node scripts/doc-check.ts`)。
 *
 * 为什么需要它:文档最容易静默过期——入口结构残留旧文件、README 说
 * "只监听 127.0.0.1",这类不一致人工很难发现,而且一旦发现就是"读者被误导"。
 * 本脚本把"文档里的事实"与"代码里的事实"对照,不一致就报错退出(exit 1)。
 *
 * 检查项:
 *   1. 文档入口结构是否完整且没有遗留文件
 *   2. 文档提到的 CLI 子命令是否真实存在
 *   3. 版本号三方一致(GATEWAY_VERSION / package.json / UPSTREAM.md)
 *   4. README 提到的 OSG_* 环境变量是否真的被读取
 *   5. FALLBACK_CODEX_VERSION 是否与 UPSTREAM.md 的已验证版本一致
 *   6. 文档引用的仓库内路径是否存在
 *
 * 有意不做:文档里的行数/测试数(数值随提交变化,硬校验噪音大于收益)。
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string): string => readFileSync(path.join(ROOT, rel), "utf8");
const exists = (rel: string): boolean => existsSync(path.join(ROOT, rel));

interface Problem {
  doc: string;
  message: string;
}
const problems: Problem[] = [];
const note = (doc: string, message: string): void => {
  problems.push({ doc, message });
};

const requiredDocs = [
  "README.md",
  "AGENTS.md",
  "docs/README.md",
  "docs/WSL.md",
  "docs/DEVELOPMENT.md",
  "docs/REVIEWING.md",
  "docs/DESIGN.md",
  "docs/UPSTREAM.md",
  "docs/MAINTENANCE.md",
] as const;

const legacyDocs = [
  "docs/HANDOFF.md",
  "docs/MIGRATION_WSL.md",
  "docs/ORIENTATION.md",
  "docs/READING_GUIDE.md",
  "docs/REVIEW_BRIEF.md",
] as const;

/** 全部长期文档:README + AGENTS + docs/**.md */
const docFiles: string[] = [
  "README.md",
  "AGENTS.md",
  ...readdirSync(path.join(ROOT, "docs"))
    .filter((f) => f.endsWith(".md"))
    .map((f) => `docs/${f}`),
];

const cliSource = read("src/cli/index.ts");
const configSource = read("src/config.ts");
const clientVersionSource = read("src/upstream/client-version.ts");
const pkg = JSON.parse(read("package.json")) as { version: string; scripts?: Record<string, string> };

/** 递归收集某目录下所有 .ts 源码(环境变量检查要覆盖全部读取点,不只 config.ts) */
function collectTs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...collectTs(rel));
    else if (entry.name.endsWith(".ts")) out.push(rel);
  }
  return out;
}
const codeFiles = [...collectTs("src"), ...collectTs("tests"), ...collectTs("scripts")];
const allCode = codeFiles.map((f) => read(f)).join("\n");

// ---------- 1. 文档入口结构 ----------
for (const doc of requiredDocs) {
  if (!exists(doc)) note(doc, "缺少约定的入口文档");
}
for (const doc of legacyDocs) {
  if (exists(doc)) note(doc, "旧入口文档仍存在;内容应迁入新的职责文档后删除");
}

for (const doc of docFiles) {
  const text = read(doc);
  for (const legacy of legacyDocs) {
    if (text.includes(legacy)) note(doc, `仍引用旧入口文档 \`${legacy}\``);
  }
}

// ---------- 2. CLI 子命令 ----------
// 断言排除日志前缀形态 `[osg debug]`(那是 log 输出的标签,不是命令)。
const realCommands = new Set(
  [...cliSource.matchAll(/case "([a-z][a-z-]*)"/g)].map((m) => m[1] as string),
);
const CMD_RE = /(?<!\[)\bosg ([a-z][a-z-]*)(?!\])/g;
for (const doc of docFiles) {
  const text = read(doc);
  for (const m of text.matchAll(CMD_RE)) {
    const cmd = m[1]!;
    if (!realCommands.has(cmd)) {
      note(doc, `提到了不存在的子命令 \`osg ${cmd}\`(实际:${[...realCommands].sort().join(", ")})`);
    }
  }
  for (const m of text.matchAll(/dist\/cli\/index\.js ([a-z][a-z-]*)(?!\])/g)) {
    const cmd = m[1]!;
    if (!realCommands.has(cmd)) {
      note(doc, `提到了不存在的子命令 \`node dist/cli/index.js ${cmd}\``);
    }
  }
}

// ---------- 3. 版本号三方一致 ----------
const gwVersion = configSource.match(/GATEWAY_VERSION = "([^"]+)"/)?.[1];
const upstreamDoc = read("docs/UPSTREAM.md");
const docVersion = upstreamDoc.match(/Gateway version:\s*([0-9.]+)/)?.[1];
if (!gwVersion) {
  note("src/config.ts", "找不到 GATEWAY_VERSION");
} else {
  if (pkg.version !== gwVersion) {
    note("package.json", `version=${pkg.version} 与 GATEWAY_VERSION=${gwVersion} 不一致`);
  }
  if (docVersion && docVersion !== gwVersion) {
    note("docs/UPSTREAM.md", `"Gateway version: ${docVersion}" 与 GATEWAY_VERSION=${gwVersion} 不一致`);
  }
  if (!docVersion) {
    note("docs/UPSTREAM.md", "verified 块缺少 `Gateway version:` 行");
  }
}

// ---------- 4. README 里的环境变量确实被读取 ----------
// 检查范围含 src + tests + scripts:测试专用变量(如 OSG_URL)也算"被读取"。
const readme = read("README.md");
const declared = new Set([...readme.matchAll(/\bOSG_[A-Z_]+/g)].map((m) => m[0]));
for (const name of declared) {
  if (!allCode.includes(name)) {
    note("README.md", `提到了环境变量 \`${name}\`,但代码里没有读取它`);
  }
}

// ---------- 5. FALLBACK_CODEX_VERSION 与 UPSTREAM.md 对齐 ----------
const fallback = clientVersionSource.match(/FALLBACK_CODEX_VERSION = "([^"]+)"/)?.[1];
const verified = upstreamDoc.match(/Last verified Codex CLI version:\s*([0-9.]+)/)?.[1];
if (!fallback) {
  note("src/upstream/client-version.ts", "找不到 FALLBACK_CODEX_VERSION");
} else if (verified && fallback !== verified) {
  note(
    "docs/UPSTREAM.md",
    `verified 版本(${verified})与 FALLBACK_CODEX_VERSION(${fallback})不一致——` +
      "对齐上游后需同步修改(见 MAINTENANCE.md 第 8 步)",
  );
}

// ---------- 6. 文档引用的仓库内路径存在 ----------
const PATH_RE = /`((?:src|tests|scripts|docs|examples)\/[A-Za-z0-9_./-]+\.(?:ts|js|mjs|md|json))`/g;
const MARKDOWN_LINK_RE = /\[[^\]]+\]\(([^)]+)\)/g;
for (const doc of docFiles) {
  const text = read(doc);
  for (const m of text.matchAll(PATH_RE)) {
    const rel = m[1]!;
    if (!exists(rel)) {
      note(doc, `引用了不存在的文件 \`${rel}\``);
    }
  }
  for (const m of text.matchAll(MARKDOWN_LINK_RE)) {
    const target = m[1]!.split("#", 1)[0]!;
    if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
    const rel = path.normalize(path.join(path.dirname(doc), target));
    if (!exists(rel)) note(doc, `链接指向不存在的文件 \`${target}\``);
  }
}

// ---------- 输出 ----------
if (problems.length === 0) {
  process.stdout.write(
    `DOC_FRESHNESS: OK\n` +
      `  检查 ${docFiles.length} 份文档 · CLI 子命令 ${realCommands.size} 个 · 版本 ${gwVersion ?? "?"}\n` +
      `  已校验:入口结构 / 命令存在性 / 版本三方一致 / 环境变量真实读取 / fallback 版本对齐 / 引用路径存在\n` +
      `  未覆盖(须人工判断):行为语义描述、行数与测试数等快照数值、架构与设计意图的表述\n`,
  );
} else {
  process.stdout.write(`DOC_FRESHNESS: STALE (${problems.length} 处)\n\n`);
  for (const p of problems) process.stdout.write(`- ${p.doc}: ${p.message}\n`);
  process.stdout.write("\n修正后重跑本脚本;规则见 docs/MAINTENANCE.md「文档保鲜」。\n");
  process.exitCode = 1;
}
