# 维护与上游对齐

本文描述两类工作：普通代码变更的文档保鲜，以及 Codex 上游协议变化时的对齐流程。
长期设计约束见 `docs/DESIGN.md`，当前依赖的 wire 契约见 `docs/UPSTREAM.md`。

## 固定边界

维护工作不能借机扩大产品：

1. OSG 是 OpenAI-compatible supported subset，不是完整 OpenAI API clone。
2. 上游只有 OpenAI Codex；不增加第二 Provider、路由器或账号池。
3. reasoning 原样透传，不把模型目录当成本地权威白名单。
4. `fast` 按已验证 wire 契约转换为 `priority`。
5. Windows ACL 不由项目管理；非 loopback 监听也不获得真实 API 认证。
6. 不为单个客户端加入模型 ID 或请求形状特判。

如果上游变化迫使项目突破这些边界，应停止实施并由 `DECISION_OWNER` 重新决定产品方向。

## 文档保鲜

每次改动后运行：

```bash
pnpm doc-check
```

检查器会验证：

1. 约定的入口文档完整，旧入口没有残留；
2. 文档中的 CLI 子命令真实存在；
3. `GATEWAY_VERSION`、`package.json` 和 `docs/UPSTREAM.md` 版本一致；
4. README 中的 `OSG_*` 变量确实被代码读取；
5. `FALLBACK_CODEX_VERSION` 与上游验证基线一致；
6. 文档引用的仓库内文件存在。

自动检查无法理解语义。还必须按改动类型人工核对：

| 改动类型 | 需要检查的文档 |
|---|---|
| 安装、登录、启动、CLI 或配置 | `README.md`；涉及 WSL 时再看 `docs/WSL.md` |
| API 支持面、错误或客户端可见行为 | `README.md`、`docs/DESIGN.md`、`docs/UPSTREAM.md` |
| 架构、分层或模块职责 | `docs/DESIGN.md`、`docs/DEVELOPMENT.md`、`docs/REVIEWING.md` |
| OAuth、Codex headers、SSE、模型目录、reasoning、tier | `docs/UPSTREAM.md`、本文 |
| 测试或发布门禁 | `docs/DEVELOPMENT.md`、`docs/REVIEWING.md`、本文 |
| Agent 角色、权限或交接规则 | `AGENTS.md`、`docs/README.md` |

如果确认没有文档影响，交接或提交说明必须写：

```text
DOC_IMPACT: NONE — <具体理由>
```

不要把测试数量、文件行数、当前服务状态、某次评审结论或机器特有故障写入长期入口文档。
这些信息应由 Git、CI、新鲜命令输出和 `.ai/tasks/` 提供。

## 什么时候需要上游对齐

出现任一情况时执行本节：

- `osg upstream-check` 返回 `REVIEW_REQUIRED`；
- Codex CLI 或上游协议版本变化；
- 模型目录为空、schema 漂移或已验证字段消失；
- 请求参数、SSE 事件、OAuth 或错误行为与 `docs/UPSTREAM.md` 不符。

`upstream-check` 只报告漂移，不自动修改代码。

## 上游对齐流程

### 1. 固定基线

记录目标 Git commit、已安装 Codex CLI 版本、`docs/UPSTREAM.md` 的 verified 块，以及
本次允许的 live 验证范围。真实 OAuth、推理和外部写入必须先获得明确授权。

### 2. 使用官方源码核对

优先按 release tag 获取 OpenAI Codex 源码，逐项比较：

- OAuth authorize、token、refresh 和 revoke；
- backend URL 与必需 headers；
- Responses 请求体和参数归一化；
- SSE 事件及终止条件；
- model catalog endpoint、schema 和 `client_version`；
- reasoning、service tier、tools、image、errors 和 usage。

对应的依赖契约按章节记录在 `docs/UPSTREAM.md`。只记录本项目真正依赖的行为，不复制
大段上游实现。

### 3. 用最小探针确认不确定行为

仓库提供：

- `scripts/probe-models.ts`：目录结构；
- `scripts/probe-responses.ts`：参数支持面；
- `scripts/probe-tools.ts`：工具调用和 SSE 事件。

这些脚本使用真实账号，只能在明确授权后运行。探针必须保持最小请求，且不得打印凭证。

### 4. 先得到失败测试

确认上游变化后，先在 `tests/contract/` 或 `tests/unit/` 写出能复现新行为的失败测试。
没有失败证据时，不要靠猜测修改 adapter。

### 5. 做最小修复

修复应优先集中在 `src/upstream/` 与 `src/auth/`。如果必须让 `src/api/` 理解
Codex 私有行为，先重新检查分层是否泄漏。

`FALLBACK_CODEX_VERSION` 位于 `src/upstream/client-version.ts`，必须与
`docs/UPSTREAM.md` 的已验证 Codex CLI 版本一致。用户仍可通过
`OSG_CODEX_CLIENT_VERSION` 或 `{OSG_HOME}/config.json` 覆盖。

### 6. 验证和记录

默认运行：

```bash
pnpm test
pnpm typecheck
pnpm build
pnpm doc-check
git diff --check
```

获得授权后再运行所需 live smoke。最后更新 `docs/UPSTREAM.md` 的 verified 块和发生变化的
章节，清楚区分源码确认、真实账号实测与仍未验证的推断。

## 常见高风险点

- refresh 响应没有新 refresh token 时必须保留旧值。
- 上游恒用 `stream=true`；下游非流式响应由网关聚合。
- 非流式 output 需要兼容从 `response.output_item.done` 重建。
- 一旦向下游写出字节，不得把连接重试伪装成一次完整响应。
- 模型目录的 reasoning 列表不是上游请求校验的权威来源。
- 所有参数改写必须有证据，并通过 `x-osg-normalized` 对下游透明说明。
- token、Authorization、OAuth code/state 和凭证内容不得进入日志、错误或测试 fixture。
