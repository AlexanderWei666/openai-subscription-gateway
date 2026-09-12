# 读代码指南(给没学过 TypeScript 的人)

> 目标:半天内看懂这个项目**在做什么、为什么这么写、要改该改哪**。
> 不需要先学完 TypeScript——本项目只用到 12 个语法点,下面全部列出。
> 总量:源码 17 文件 / 约 3000 行(v0.1.1),但**真正需要读透的只有 4 个文件**。

---

## 第 0 步:先建立地图

一次请求的路径(自外向内):

```
客户端(DSH/curl)
   ↓  HTTP + JSON
server.ts            路由层      169 行   收请求、分发
   ↓  内部统一为 Responses 格式
api/responses.ts     OpenAI 面   328 行   校验、挑字段、翻译事件
api/chat-completions.ts 兼容层   500 行   Chat ↔ Responses 双向转换
   ↓
upstream/codex.ts    Codex 适配   267 行   私有头、参数归一化、重试
upstream/catalog.ts  模型目录     213 行   三级回退(live→磁盘缓存→codex 缓存)
upstream/sse.ts      SSE 解析      86 行   流式事件切分
   ↓
auth/oauth.ts        登录态       323 行   PKCE 登录、刷新单飞、超时
   ↓
chatgpt.com/backend-api/codex
```

**一句话记住分层原则**:Codex 私有细节(请求头 `originator`、`chatgpt-account-id`、
参数怪癖)只允许出现在 `upstream/` 和 `auth/`。`api/` 里出现这类字样就是 bug。

---

## 第 1 步:TypeScript 门槛(12 个语法点,配项目真实代码)

| # | 语法 | 项目里的样子 | 人话解释 |
|---|---|---|---|
| 1 | 类型注解 | `function sendJson(res: http.ServerResponse, status: number): void` | 冒号后面是"这个位置是什么类型"。**运行时不存在**,纯给编译器和人看的 |
| 2 | `interface` | `interface Config { host: string; port: number }` | 描述一个对象长什么样。编译后消失 |
| 3 | 联合类型 | `logLevel: "debug" \| "info" \| "warn" \| "error"` | "只能是这几个值之一"。项目用这种方式代替 enum |
| 4 | 可选属性 | `opts: { forceRefresh?: boolean }` | `?` = 可以不给。用时得到 `boolean \| undefined` |
| 5 | 空值合并 `??` | `env.OSG_HOST ?? "127.0.0.1"` | 左边是 null/undefined 就用右边(**不是** `\|\|`,空字符串不会被替换) |
| 6 | 可选链 `?.` | `res.body?.cancel()` | 左边为空就直接短路,不报错 |
| 7 | `unknown` + 收窄 | `if (typeof input !== "object" \|\| input === null) continue` | 上游 JSON 一律当 `unknown`(不可信),用 `typeof` 判断后才敢用 |
| 8 | `as` 断言 | `(item as Record<string, unknown>).type` | 告诉编译器"我保证是这形状"。**不会真的检查**,是信任声明 |
| 9 | `async/await` | `const res = await fetch(url)` | 等异步结果。`await` 只能在 `async` 函数里用 |
| 10 | 泛型 | `Promise<CatalogResult>`、`Record<string, unknown>` | 尖括号里是"参数化的类型"。`Record<string, X>` = 键是字符串、值是 X 的对象 |
| 11 | `import type` | `import type { Config } from "./config.ts"` | 只导入类型(编译后整行消失)。由 `verbatimModuleSyntax` 强制 |
| 12 | 模块 | `export function loadConfig(...)` / `import { loadConfig } from "../config.ts"` | 文件即模块;`.ts` 后缀是 Node 原生 TS 支持的写法,编译后自动变 `.js` |

**唯一需要"习惯"的地方**:类型写得多、看起来啰嗦。价值在重构时——比如把
`clientVersion` 改成对象结构,编译器会直接把所有该改的地方标红。

### tsconfig.json 里值得知道的三行

```jsonc
"strict": true,                    // 严格模式:null 检查等全开,少踩运行时坑
"noUncheckedIndexedAccess": true,  // arr[0] 的类型是"可能 undefined",强制判空
"erasableSyntaxOnly": true         // 禁止 enum/namespace 等"编译不掉"的语法
```

最后一项是为了**能直接用 Node 跑 .ts**(不编译也能 `node src/cli/index.ts serve`)。

---

## 第 2 步:关键配置(先读这个,5 分钟)

### 2.1 `src/config.ts`(106 行)—— 所有可调项的唯一入口

三个层次:

```ts
export const GATEWAY_VERSION = "0.1.1";        // 与 package.json 同步
export const UPSTREAM = {                       // 上游常量(改动必须先核对文档)
  baseUrl: "https://chatgpt.com/backend-api/codex",
  oauthClientId: "app_EMoamEEZ73f0CkXaXp7hrann",
  callbackPorts: [1455, 1457],
  refreshWindowSec: 300,                        // 提前 5 分钟刷新 token
} as const;
export function loadConfig(env) { ... }         // 环境变量 → Config 对象
```

**你要知道的**:所有行为都从 `loadConfig()` 出来的 `Config` 对象传下去,
没有全局单例、没有配置文件读取(除了可选的 `clientVersion` 覆盖)。

### 2.2 环境变量(README "环境变量"一节)

| 变量 | 作用 | 默认 |
|---|---|---|
| `OSG_HOST` / `OSG_PORT` | 监听地址/端口 | `127.0.0.1` / `10101` |
| `OSG_HOME` | 凭证与缓存目录 | `~/.openai-subscription-gateway` |
| `OSG_LOG_LEVEL` | `debug` 会打印请求形状 | `info` |
| `OSG_CODEX_CLIENT_VERSION` | 覆盖发往上游的 client_version | 自动探测 → 兜底 0.154.0(见 `src/upstream/client-version.ts`) |

查看当前生效值与**来源**:`node dist/cli/index.js config`

### 2.3 `package.json`

```jsonc
"dependencies": 无        // 零运行时依赖:只用 Node 内置模块
"devDependencies": ["typescript", "@types/node"]
"engines": { "node": ">=24.0.0" }
"scripts": { "build": "tsc -p tsconfig.json", "start": "node dist/cli/index.js serve", ... }
```

**零依赖是刻意的**:没有供应链风险,升级 Node 就是全部升级动作。

---

## 第 3 步:关键代码(4 个文件,按顺序读)

### 3.1 `src/server.ts`(169 行)· 先读这个

看三件事:
1. **4 条路由怎么分发**(`if (method === "POST" && path === "/v1/responses")`);
2. **流式与非流式的分叉**:`stream === true` 走 SSE,否则聚合后一次性返回;
3. **统一错误出口** `sendApiError`:响应头已发出(流已开始)时不能再改状态码,
   只能结束流——这个细节决定了所有流内错误必须走 SSE 事件。

### 3.2 `src/api/responses.ts`(328 行)· 核心中的核心

两个函数读懂即可:

- `buildUpstreamBody(body, catalog)`:**校验 + 挑字段**。这里定义"哪些参数能去上游"。
  被拒绝的字段(`store`、`previous_response_id` 等)在这里返回 400。
- `normalizeForCodex()`(在 codex.ts 里):**只做上游要求的改写**,并记录 notes
  供 `x-osg-normalized` 响应头上报。

还有 `aggregateCompletedResponse`:非流式请求要把 SSE 重新拼成一个响应对象。
注意里面那条注释——上游 `completed.output` **恒为空数组**,必须从
`output_item.done` 事件重建。这是踩出来的坑,别改掉。

### 3.3 `src/upstream/codex.ts`(267 行)· 私有协议的隔离带

- `buildHeaders()`:注入 `originator`、`user-agent`、`session-id`、
  `chatgpt-account-id`——**这是整个项目唯一"伪装成 Codex CLI"的地方**。
- `normalizeForCodex()`:剥离上游不认的参数(`temperature`/`top_p`/…),
  `fast` → `priority` 转换,`input` 字符串 → 列表。
- `postResponsesStream()`:**连接层自动重试**(3 次指数退避),
  只在还没往下游写字节时重试。

### 3.4 `src/auth/oauth.ts`(323 行)· 登录态

- `login()`:PKCE + 本地回调服务器(1455→1457→随机端口);
  Windows 上开浏览器必须给 URL 加双引号(cmd 会把 `&` 当命令分隔符,已踩过)。
- `TokenManager`:刷新**单飞**——并发请求只产生一次刷新;进锁后重新读凭证再判断。
- `postToken()`:统一 30s 超时。

### 可以**暂时跳过**的文件

`chat-completions.ts`(500 行,纯粹是 Chat 与 Responses 两种格式的互转,长但机械)、
`cli/index.ts`(343 行,命令拼装)、`catalog.ts`(目录三级回退)、`sse.ts`(86 行,看名字就懂)。

---

## 第 4 步:关键文档(4 份,按这个顺序)

| 顺序 | 文档 | 读它的理由 |
|---|---|---|
| 1 | `README.md` | 用法与边界。10 分钟 |
| 2 | `docs/DESIGN.md` | **为什么这么设计**:非目标清单、分层铁律、信任边界。最重要 |
| 3 | `docs/UPSTREAM.md` | **上游实测契约**:每个参数/事件的真实现象+实测日期。改上游相关代码前必读 |
| 4 | `docs/MAINTENANCE.md` | OpenAI 改协议后的 18 步对齐流程(给未来的 AI/你执行) |

另有 `docs/HANDOFF.md`(技术交接报告)、`MIGRATION_WSL.md`(WSL 运行清单)。
正式上线后再按版本补充 release summary。

**读文档的顺序比读代码更重要**:这个项目的复杂度 90% 在"上游很怪",
而怪处全部记录在 `UPSTREAM.md`——先读它,看代码时会少 80% 的困惑。

---

## 第 5 步:动手验证(每条都能立刻看到结果)

```bash
# 看当前配置与来源
node dist/cli/index.js config

# 自检
node dist/cli/index.js doctor

# 看真实请求形状(只记类型不记内容)
OSG_LOG_LEVEL=debug node dist/cli/index.js serve

# 直接打一条(另开终端)
curl -s http://127.0.0.1:10101/v1/responses \
  -H "content-type: application/json" \
  -d '{"model":"gpt-6-astra","input":"说OK"}' | head -c 400
```

**想改代码试手**:先 `git tag v0.1.1` 已存在,随便改;改坏了 `git checkout .` 回到原样。
建议第一个练习:把 `UPSTREAM.refreshWindowSec` 从 300 改成 3600,跑 `osg status`
观察"token 提前刷新"的行为变化(记得改回来)。

---

## 常见困惑

**Q:为什么 import 写 `.ts` 结尾?**
A:Node 24 能直接跑 .ts(`erasableSyntaxOnly` 保证语法可擦除)。
编译时 `rewriteRelativeImportExtensions` 自动把 `.ts` 改写成 `.js`。

**Q:为什么不用 Express/Fastify?**
A:4 条路由,但需要精确控制 SSE、背压、取消。原生 `node:http` 反而更短更可控。

**Q:零依赖怎么做 OAuth / SSE / 加密?**
A:都靠 Node 内置:`fetch`、`AbortSignal.timeout`、`node:http`、`node:crypto`、`node:zlib`。

**Q:测试在哪、怎么跑?**
A:`tests/unit`(纯函数)、`tests/contract`(用 mock 上游测 HTTP 层)、
`tests/live`(真账号,需 `LIVE_TEST=1`)。`pnpm test` 只跑前三类中的前两类,不烧额度。
