# MAINTENANCE.md — 对齐最新 Codex 的标准流程

> 适用场景:OpenAI 改了协议 / `osg upstream-check` 报 REVIEW_REQUIRED /
> 用户要求"对齐最新 Codex"。
> 执行者可以是完全不了解本项目的 AI:从本文件开始,不要先读源码。

## 前提

- 已读 `docs/DESIGN.md`(10 分钟)和 `docs/UPSTREAM.md`(15 分钟)。
- 本机装有 Codex CLI;能访问 github.com/openai/codex。
- 绝对边界:**禁止**借"对齐上游"顺手增加第二 Provider、路由系统、Web UI、
  配置系统或任何与本 issue 无关的功能。发现自己在写 ProviderRegistry 类东西,
  立即停止并缩减。

## 维护时的固定认知(不要被"完整性"诱惑)

维护/对齐过程中必须保持以下既有决策,不要"顺手改进":

1. **定位**:OSG 是 OpenAI-compatible **supported subset**,不是完整 OpenAI
   API clone。不要为"补齐兼容性"新增端点或参数面。
2. **Reasoning**:一律**原样透传**,不做本地目录校验——目录的
   `supported_reasoning_levels` 不是权威白名单(UPSTREAM.md §10 有实测)。
3. **Fast**:是 `fast` → `priority` 的**转换**,不是原样透传(UPSTREAM.md §11)。
4. **Windows ACL**:OSG 假定**可信本地用户环境**,不管理 NTFS ACL;
   `doctor` 只输出 WARN,不显示 PASS。不要引入 icacls/DACL 自动化。

## 文档保鲜(每次改动后都要做)

文档会静默过期,而**过期的文档比没有文档更糟**——读者会按错的说明操作。
先跑检查,再按需手工补:

```bash
node scripts/doc-check.ts      # 或 pnpm doc-check
```

它会自动校验(不一致即 exit 1):

1. 文档提到的 CLI 子命令是否存在;
2. `GATEWAY_VERSION` / `package.json` / `UPSTREAM.md` 三处版本号是否一致;
3. README 提到的 `OSG_*` 环境变量是否真被代码读取;
4. `FALLBACK_CODEX_VERSION` 是否与 `UPSTREAM.md` 的已验证版本一致;
5. 文档引用的仓库内文件路径是否存在。

**脚本查不到的,必须人工判断**(改动后自查这几条):

| 改动类型 | 需要同步的文档 |
|---|---|
| 新增/修改 CLI 命令或参数 | `README.md` 的用法段 + `docs/ORIENTATION.md` 的关键文件表 |
| 改默认行为(监听地址、端口、超时、tier 转换) | `README.md` 启动/安全边界 + `docs/DESIGN.md` |
| 改 API 层行为(参数支持面、错误码) | `docs/UPSTREAM.md` + `README.md` 支持能力表 |
| 正式发版(版本号变化) | `docs/UPSTREAM.md` 的 `Gateway version` + 新增 `RELEASE_SUMMARY_vX.Y.Z.md` |
| 修改架构/分层/新增模块 | `docs/DESIGN.md` + `docs/HANDOFF.md` + `docs/ORIENTATION.md` 的文件表 |
| 改测试数量、依赖、规模 | `docs/HANDOFF.md` 的"当前版本状态"表 |

**正式上线前不提交 release summary**。正式上线后，历史 release 文档不改写，
只追加新版本文件,不回填旧文件(留痕原则)。`docs/HANDOFF.md` 则始终反映最新状态。

### 多 Agent 协作强制门禁

根目录 `AGENTS.md` 是 Codex 与 WorkBuddy 共同识别的正式协作契约。任何影响接口、行为、配置、
部署、版本、测试验收、限制条件或操作流程的代码/配置改动，必须在同一变更中同步更新受影响的
正式文档、示例和交接记录。文档更新不能推迟到下一次提交或发布。

交接、评审、提交或发布前必须执行 `pnpm doc-check`（等价命令为
`node scripts/doc-check.ts`），并人工按上方映射表复核脚本无法识别的行为语义、示例、快照和交接
内容。确认没有文档受影响时，必须记录 `DOC_IMPACT: NONE — <具体理由>`；未能说明文档影响、
受影响文档未同步或内容已过期时，评审不得给出 `REVIEW_PASS`，发布不得继续。

## 流程

1. **查本机 Codex CLI 版本**:`codex --version`。
2. **查项目最后验证版本**:见 `docs/UPSTREAM.md` 头部 verified 块。
3. **获取最新 openai/codex**:GitHub releases 页确认最新 tag;
   源码抓 `raw.githubusercontent.com/openai/codex/<tag>/...`(优先用 release tag,不用 main)。
4. **对比 OAuth**:核对 `codex-rs/login/src/server.rs` 的 authorize 参数、
   token endpoint、refresh 请求体,与 UPSTREAM.md §1–§3 逐项对。
5. **对比 backend URL 与 headers**:`codex-rs/model-provider-info/src/lib.rs`、
   `codex-rs/login/src/auth/default_client.rs`、`codex-rs/model-provider/src/bearer_auth_provider.rs`、
   `codex-rs/codex-api/src/requests/headers.rs`,与 UPSTREAM.md §4–§5 对。
6. **对比 Responses wire protocol**:`codex-rs/core/src/client.rs` 的
   `build_responses_request`,核对强制字段(stream/store/include/tool_choice)
   与透传字段,与 UPSTREAM.md §6–§7 对。
7. **对比 SSE**:`codex-rs/codex-api/src/sse/responses.rs`,核对事件类型与
   terminal 事件,与 UPSTREAM.md §8 对。
8. **对比 model catalog**:`codex-rs/codex-api/src/endpoint/models.rs`、
   `codex-rs/models-manager/`,核对 endpoint、schema、过滤语义,与 UPSTREAM.md §9 对;
   如本机已登录 Codex,可读 `~/.codex/models_cache.json`(只读)看真实 schema。
   **同时更新 `FALLBACK_CODEX_VERSION`**(`src/upstream/client-version.ts`):
   它必须等于当前已验证的 Codex CLI 版本(上游按 client_version 过滤目录,
   见 UPSTREAM.md §9 的实测记录)。用户侧还可用 `OSG_CODEX_CLIENT_VERSION`
   或 `{OSG_HOME}/config.json` 覆盖;`osg config` 可查看当前生效值与来源。
9. **对比 reasoning / service tiers / tools / image input / errors / usage**:
   对 UPSTREAM.md §10–§15。
10. **先写 failing test**:任何确认的上游变化,先在 `tests/contract/` 写一个
    能复现新行为的失败测试(mock 按新行为),再改代码。
11. **最小修复**:改动应集中在 `src/upstream/` 与 `src/auth/`。
    若发现必须改 `src/api/`,先停下来重审设计——大概率是上游逻辑泄漏。
12. **跑全量离线测试**:`pnpm test` 必须全绿。
13. **可选 live smoke**:`LIVE_TEST=1 pnpm test:live`(需已 `osg login` + `osg serve`
    运行中,烧极少额度)。**live 探针脚本**(真实账号、最小请求、不打印凭证):
    `node scripts/probe-models.ts`(目录 shape)、`node scripts/probe-responses.ts`
    (逐参数支持面)、`node scripts/probe-tools.ts`(SSE 事件序列)——上游行为
    存疑时先跑探针再改代码,结论回写 UPSTREAM.md 并标注实测日期。
14. **更新 UPSTREAM.md**:改 verified 块(CLI 版本、codex revision、日期、
    gateway 版本),并修订变化的条目;本地 workaround 要写明原因。
15. **提交**:单独一个 commit,信息格式 `chore(upstream): align with codex <version>`。

## upstream-check 输出语义

```text
UPSTREAM_STATUS: CURRENT           → 本机 CLI 与 verified 一致,廉价检查通过
UPSTREAM_STATUS: REVIEW_REQUIRED   → 版本差异或目录 schema 漂移,执行本文件流程
```

upstream-check 永远不自动改代码。

## 常见坑

- refresh 响应没有新 refresh_token 时**保留旧的**;覆盖成 undefined 会直接丢登录态。
- 上游 `stream=true` 是硬要求;非流式下游请求靠 gateway 聚合,不要试图对上游发 stream=false。
- `tool_choice="auto"` 是 CLI 的强制行为而非已证实的 backend 约束;改这里要有 live 证据并记录。
- models_cache.json 的 `client_version` 强校验是 Codex 的行为;gateway 的缓存不要复刻它
  (否则每次上游发版我们的缓存就失效)。
