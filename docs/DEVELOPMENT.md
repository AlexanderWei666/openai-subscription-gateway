# 开发与代码导览

本文帮助新维护者快速建立代码地图。它不记录文件行数、测试数量或当前机器状态；这些都应从
当前 checkout 和命令输出确认。

## 先理解请求路径

```text
下游客户端
   │ OpenAI-compatible HTTP
   ▼
src/server.ts                 路由和 HTTP 生命周期
   ▼
src/api/                      参数校验与 Responses / Chat 兼容
   ▼
src/upstream/                 Codex 私有协议、目录和 SSE
   ▼
src/auth/                     OAuth、凭证和 token 刷新
   ▼
OpenAI Codex backend
```

分层原则：Codex 私有请求头和 wire workaround 应集中在 `src/upstream/`；OAuth 细节集中在
`src/auth/`。如果 `src/api/` 开始理解 `originator` 或 ChatGPT 账号头，通常意味着分层泄漏。

## 按任务找文件

| 想修改什么 | 主要入口 | 同时阅读 |
|---|---|---|
| CLI 命令或启动 | `src/cli/index.ts` | `src/config.ts`、`README.md` |
| HTTP 路由和请求生命周期 | `src/server.ts` | `src/api/errors.ts` |
| Responses 参数与流 | `src/api/responses.ts` | `src/upstream/codex.ts`、`src/upstream/sse.ts` |
| Chat Completions 兼容 | `src/api/chat-completions.ts` | `src/api/responses.ts` |
| 模型目录 | `src/api/models.ts` | `src/upstream/catalog.ts`、`docs/UPSTREAM.md` |
| OAuth 和凭证 | `src/auth/oauth.ts`、`src/auth/store.ts` | `src/auth/jwt.ts`、`src/auth/pkce.ts` |
| 上游版本探测 | `src/upstream/client-version.ts` | `docs/UPSTREAM.md`、`docs/MAINTENANCE.md` |
| 文档一致性 | `scripts/doc-check.ts` | `docs/MAINTENANCE.md` |

## 推荐阅读顺序

1. `src/server.ts`：看路由、流式与非流式分叉、统一错误出口。
2. `src/api/responses.ts`：看支持的参数面和 SSE 聚合规则。
3. `src/upstream/codex.ts`：看私有头、最小 wire 归一化和连接重试。
4. `src/auth/oauth.ts`：看 PKCE 登录和单飞刷新。
5. 按任务补读 Chat 兼容、模型目录或凭证存储。

上游行为看起来反常时，不要先猜；先在 `docs/UPSTREAM.md` 查是否已有实测契约。

## TypeScript 最低知识

项目只使用 Node.js 可直接擦除的 TypeScript 语法：

- `interface`、类型注解和 `import type` 只在编译期存在；
- `unknown` 表示外部 JSON 尚未验证，使用前必须收窄；
- `T | undefined` 对应可缺省值，常配合 `?.` 和 `??`；
- `Promise<T>` 与 `async` / `await` 负责异步流程；
- `Record<string, unknown>` 是未知 JSON 对象的常见表示。

`tsconfig.json` 启用了严格检查，并允许 Node 24 直接运行 `.ts` 源码。不要为了省事引入
依赖运行时转换的 TypeScript 特性。

## 本地开发

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
pnpm doc-check
```

- `pnpm test`：离线单元和契约测试，不消耗订阅额度。
- `pnpm dev`：直接以 watch 模式运行 TypeScript 服务。
- `pnpm test:live`：真实账号测试，只有获得明确授权后才能运行。

Node 24 也可以直接执行源码命令，例如：

```bash
node src/cli/index.ts config
node src/cli/index.ts doctor
```

## 修改原则

1. 先用测试描述行为；bug 修复先得到可复现的失败。
2. 上游适配保持薄，只登记有证据的 workaround。
3. 不为单个客户端硬编码模型或特殊分支。
4. 代码、正式文档和示例必须在同一变更中保持一致。
5. 提交前按 `docs/MAINTENANCE.md` 的映射表做人工文档影响检查。

Agent 参与开发时还必须遵守根目录 `AGENTS.md` 的角色、权限和交接规则。
