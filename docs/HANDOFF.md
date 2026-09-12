# OPENAI_SUBSCRIPTION_GATEWAY_V1 技术交接报告

生成时间:2026-09-11 13:20 (+08:00) · 最后更新:2026-09-12 19:22(隐私发布门禁)
生成依据:当前仓库真实状态(工作区无未提交改动)、实际执行结果、实际日志。
**本文档反映最新版本;正式上线后的版本变更与证据另见对应 release summary。**

## 0. 多 Agent 协作契约

本仓库的正式协作契约见根目录 [`AGENTS.md`](../AGENTS.md)。固定角色为：用户
`DECISION_OWNER`、WorkBuddy `IMPLEMENTER`、Codex `REVIEW_ARCHITECT`。交接必须遵循该文件的
字段格式；任何影响接口、行为、配置、部署、版本、验收、限制或流程的改动，都必须在同一变更中
更新受影响文档并记录 `DOC_IMPACT`，再运行 `pnpm doc-check`。

---

## 1. 项目定位

- **解决什么问题**:把 ChatGPT / OpenAI Codex 订阅(浏览器 OAuth 登录态)
  转换成本机可访问的、标准的 OpenAI-compatible HTTP API,让任意支持
  自定义 baseURL 的客户端无需知道 OAuth/Codex 私有协议即可调用。
- **上游是什么**:唯一上游 = OpenAI Codex backend
  (`https://chatgpt.com/backend-api/codex`),鉴权方式 = ChatGPT OAuth Bearer +
  `ChatGPT-Account-Id`。协议细节见 `docs/UPSTREAM.md`。
- **下游是什么**:唯一下游 = OpenAI-compatible API 客户端
  (DSH / OpenAI SDK / OpenCode / curl / 任意脚本)。
- **明确不是什么**:不是多 Provider 聚合器、不是路由器、不是账号池、
  不是 Agent 框架、不执行任何工具、不是公网服务、不是 DSH 插件、
  不含 Web UI / 数据库 / 用户系统 / 插件系统。
  (完整非目标清单见 `docs/DESIGN.md`)

---

## 2. 当前版本状态

> **本表是生成时点的快照。** 其中「提交数 / HEAD」「服务状态」「凭证有效期」
> 随时会变,请以命令输出为准,不要引用本表数值。
> 结构性字段(版本、测试数、依赖、规模)在每次发版时同步更新;
> 漂移检测:`node scripts/doc-check.ts`。

| 项 | 值 | 证据 |
|---|---|---|
| 版本 | 0.1.1 (`GATEWAY_VERSION`) | `src/config.ts:5` |
| 提交数 / HEAD | 见 `git log`(易过期,不写死) | `git log --oneline` |
| 工作区 | 干净(0 处未提交改动) | `git status --short` 为空 |
| 构建 | PASS | `pnpm build` 无错误输出 |
| 类型检查 | PASS | `pnpm typecheck` 无错误输出 |
| 离线测试 | **138/138 PASS** | `pnpm test` |
| Live 测试 | **9/9 PASS** | `OSG_URL=… LIVE_TEST=1 pnpm test:live` |
| 运行时依赖 | **0 个** | `package.json` 中无 `dependencies` 字段(`grep -c '"dependencies"'` = 0) |
| 开发依赖 | 2 个(`typescript`, `@types/node`) | `package.json` |
| 源码规模 | 18 文件 / 3094 行 | `find src -name '*.ts'` |
| 测试规模 | 22 文件 / 3295 行 | `find tests -name '*.ts'` |
| 凭证入库 | 否 | `git ls-files \| grep auth.json` 无结果 |
| 服务状态 | 不记录本机运行快照 | `GET /health` 现场核验 |
| 凭证有效期 | 不记录凭证有效期 | `osg status` / `doctor` 现场核验 |
| doctor | 6 PASS + 1 WARN(Windows ACL) | `osg doctor` |
| doctor --live | 7 PASS + 1 WARN | `osg doctor --live`(含 live inference gpt-6-astra) |
| 文档保鲜 | OK | `node scripts/doc-check.ts` |
| 上游对齐状态 | `UPSTREAM_STATUS: REVIEW_REQUIRED` | `osg upstream-check` → exit 2(原因见 §5.7) |

---

## 3. 架构

### 3.1 分层与依赖方向

```
下游客户端
   │ OpenAI-compatible HTTP
   ▼
api/       路由 + 校验 + OpenAI 风格错误       ← 不懂 OAuth,不懂 Codex 私有头
   │ 内部统一为 Responses 协议
   ▼
upstream/  极薄 Codex adapter(唯一 Codex 私有协议所在地)
   │ 注入鉴权头 / 强制 stream / SSE 解析 / 请求归一化
   ▼
auth/      OAuth 登录态 + token 刷新
   ▼
OpenAI Codex backend
```

**分层铁律**:`grep -rn "chatgpt-account-id\|originator" src/api/` 无结果
——Codex 私有细节仅存在于 `src/upstream/` 与 `src/auth/`。

### 3.2 源码构成(行数)

| 文件 | 行数 | 职责 |
|---|---|---|
| `src/server.ts` | 169 | Node 原生 HTTP 路由、body 读取、debug 请求摘要 |
| `src/config.ts` | 63 | env 解析 + 上游常量 |
| `src/log.ts` | 55 | 日志 + 密钥脱敏(registerSecret/redact) |
| `src/api/responses.ts` | 292 | Responses 主链:校验、字段挑选、SSE 聚合与透传泵 |
| `src/api/chat-completions.ts` | 487 | Chat ↔ Responses 双向适配(含流式 chunk 转换) |
| `src/api/models.ts` | 51 | `/v1/models` 与 `/internal/models` |
| `src/api/errors.ts` | 129 | 错误映射与 OpenAI 风格错误体 |
| `src/upstream/codex.ts` | 267 | 头注入、连接重试、请求归一化 |
| `src/upstream/catalog.ts` | 208 | 动态模型目录(三级回退) |
| `src/upstream/sse.ts` | 86 | SSE 解析/序列化(支持 abort) |
| `src/auth/oauth.ts` | 293 | PKCE 登录、刷新单飞、登出 |
| `src/auth/store.ts` | 107 | 凭证读写(0600/0700、原子写) |
| `src/auth/jwt.ts` | 54 | JWT payload 解析(exp / account_id) |
| `src/auth/pkce.ts` | 21 | verifier / challenge / state |
| `src/cli/index.ts` | 338 | 7 个子命令 |
| `scripts/probe-*.ts` | 160 | 三个上游探查脚本(维护用) |

### 3.3 关键设计决策(与上游 wire 强相关)

| 决策 | 依据 |
|---|---|
| 上游恒 `stream=true`,非流式由 gateway 聚合 | Codex backend 只支持流式 |
| 非流式聚合**必须**从 `output_item.done` 重建 output | 上游 `completed.response.output` 恒为空数组 |
| `clientVersion` 发已验证的 Codex 版本(现 0.154.0) | 上游按此值过滤目录,未知版本返回空数组 |
| `normalizeForCodex`:input 字符串→列表;剥离 temperature/top_p/truncation/metadata/max_output_tokens;`fast`→`priority`;`auto`→省略 | 逐参数实测得出,详见 `docs/UPSTREAM.md §6/§7/§11` |
| reasoning 完全透传,零本地校验 | 目录 `supported_reasoning_levels` 非权威(luna 未列 `none` 但上游接受) |
| 连接层自动重试(3 次,指数退避),仅限未向下游写出字节时 | 上游 `store=false` 无状态,此时重试幂等安全 |
| 连接层自动重试(3 次,指数退避),仅限未向下游写出字节时 | 上游 `store=false` 无状态,此时重试幂等安全 |
| OAuth 刷新单飞 + 锁内二次判断 | 防 rotation 下并发重复刷新/credential 覆盖 |
| 模型目录:live 空结果不覆盖缓存 | 一次上游抖动不应清空有效目录 |
| SSE drain 等待同时响应 close/error/abort | 客户端断开时必须结束 pump 并取消上游 |
| Chat 流式:自行跟踪 `sawToolCall` | 上游 `completed.output` 恒为空,不能据此判 tool_calls |
| 所有改写通过 `x-osg-normalized` 响应头透明上报 | 不静默吞参数 |

### 3.4 契约保鲜机制

```
OpenAI 改协议
  → upstream-check 报 REVIEW_REQUIRED
  → 按 docs/MAINTENANCE.md 18 步流程
  → scripts/probe-*.ts 逐参数/逐事件实测
  → 先写 failing contract test
  → 最小改动(集中在 upstream/ + auth/)
  → pnpm test 全绿 → 更新 UPSTREAM.md verified 块
```

---

## 4. 边界

**功能边界(V1 明确不做)**:多 Provider / Router / AccountPool / 负载均衡 /
自动故障转移 / Dashboard / Web UI / 插件系统 / MCP Server / Agent Loop /
Shell·FS 工具 / Prompt 管理 / 数据库 / 用户系统 / 公网部署 /
OpenCodex 兼容层 / 通用 OAuth 框架 / 通用 Provider 抽象。

**API 边界**:实现 `GET /health`、`GET /v1/models`、`POST /v1/responses`、
`POST /v1/chat/completions`、`GET /internal/models`。
未实现的 OpenAI 平台 API(Files/Vector Stores/Batch/Fine-tuning/Audio/Assistants)
返回 404 OpenAI 风格错误,不静默吞。

**安全边界**:
- 默认监听 `127.0.0.1`;绑非 loopback 时打印显著警告。
- 下游 API key 为 placeholder,**不校验值**,不构成公网认证。
- 凭证独立于 Codex CLI(`~/.openai-subscription-gateway/auth.json`),
  **不读不写** `~/.codex/auth.json`;唯一例外是 `/v1/models` 末级兜底可只读
  `~/.codex/models_cache.json`(非凭证)。
- token 全域脱敏:日志、异常、HTTP 响应、Git 均无凭证。

**语义边界**:gateway 不执行任何工具、不改 tool name、不改 arguments;
不改写客户端请求的语义(除已登记的 Codex wire 适配,且全部透明上报)。

---

## 5. 风险与已知问题

### 5.1 网络链路抖动(外部,未消除)
现象:间歇 `fetch failed` → 503 `upstream_unavailable`。
根因:当前网络路径经过本地代理分流,链路偶发瞬断。原生 Codex CLI 同样受影响。
缓解:gateway 连接层自动重试(最多 3 次,300/600ms 退避),把"对话失败"
降级为"偶发数百毫秒延迟"。**未消除**,根因不在本项目可控范围。
证据:`src/upstream/codex.ts` `postResponsesStream`;契约测试
"连接层瞬断自动重试"。

### 5.2 `src/api/chat-completions.ts` 偏大(487 行)
全项目最大文件。原因是 Chat 兼容层需要双向转换(请求侧消息/工具/参数映射,
响应侧非流式与流式 chunk 生成)。目前职责仍单一(纯适配),但后续若增长
应拆分。**不阻塞 V1**。

### 5.3 `osg doctor` 的 config 行有误导风险(低)
该行显示 `config` 的默认 host,而非运行中进程的实际绑定地址。
当 serve 以 `OSG_HOST=<WSL IP>` 启动时,另一终端跑 doctor 仍显示
`listen=127.0.0.1:10101`。**如实记录,未修(已停止开发)**。

### 5.4 DSH 模型下拉与真实可用模型不一致(客户端侧)
DSH UI 使用其依赖 `@earendil-works/pi-ai` 内置的静态清单
(`dist/providers/data/openai.json`,646 条),不读 `GET /v1/models`。
实测"添加模型"对话框出现的 10 个 id 全部命中该文件;其中仅 5 个
(`gpt-6-astra`、`gpt-5.6-sol/terra/luna`、`gpt-5.5`)真实可调用,
选择其余(gpt-5.4-pro / o1 / gpt-realtime-2.1 等)会得到稳定的
404 `model_not_found`。gateway 不为此加任何特判(见 DESIGN 非目标),
已记录于 README。

### 5.5 单实例假设(设计边界)
凭证刷新为进程内单飞(`TokenManager`),无跨进程文件锁。
同一凭证目录被多进程同时刷新不在 V1 范围。`docs/DESIGN.md` 已声明。

### 5.6 `FALLBACK_CODEX_VERSION` 需随上游更新(已参数化)
取值链为 env `OSG_CODEX_CLIENT_VERSION` → `{OSG_HOME}/config.json` → 自动检测
`codex --version` → `FALLBACK_CODEX_VERSION`(`src/upstream/client-version.ts`)。
用户可自行覆盖;但**兜底常量**仍须按 `docs/MAINTENANCE.md` 第 8 步与上游对齐
(`scripts/doc-check.ts` 会校验它与 UPSTREAM.md verified 块一致)。

### 5.7 `upstream-check` 报 REVIEW_REQUIRED(当前环境所致,非缺陷)
当前输出 `Installed Codex: not found`,原因:当前评审环境中
`codex` 不在 PATH,且 `wsl.exe` 被安全策略禁止调用。若在用户普通终端执行,
探测顺序为 `wsl codex --version` → Windows PATH,可得到 `0.154.0 (WSL)`
并返回 `CURRENT`。exit code 2 为 REVIEW_REQUIRED 的正确返回值。
**注意**:报告生成时该次 catalog 兜底同时触发了 5.1 的网络抖动(使用了磁盘缓存)。

### 5.8 上游私有行为依赖(固有风险)本项目依赖若干未文档化的上游行为(见 `docs/UPSTREAM.md` §6/§7/§8/§11)。
上游一旦变更,依赖契约测试与 `upstream-check` 发现;这是本架构的固有成本,
已通过"薄 adapter + 集中隔离 + 实测探针"控制影响面。

### 5.9 本机 pnpm 调用方式(Git Bash 下的坑)
本机 `pnpm` 由 corepack shim 提供,在 Git Bash 中直接执行会因路径转换失败
(`Cannot find module 'c:\c\Users\...\corepack\dist\pnpm.js'`)。
可用方式:`export PATH="/c/nvm4w/nodejs:$PATH"` 后用系统 npm 安装的 pnpm,
或在 PowerShell/cmd 中执行。**维护者在写脚本/文档时需注意此限制**,
否则会得到看似"命令无输出"实则失败的结果。

### 5.10 评审遗留项已修复:凭证文件损坏时不回显服务端绝对路径

2026-09-12 修复:把 `auth.json` 改成非法 JSON 或字段不完整时,请求仍返回
500 `internal_error`,但对外错误消息只保留 `corrupt credential file`,不包含
服务端绝对路径;文件删除仍返回 401 `not_authenticated`。`tests/unit/store.test.ts`
已覆盖两种损坏形态。

---

## 6. UNVERIFIED 清单(未真实验证,不得当作 PASS)

| 项 | 状态 | 说明 |
|---|---|---|
| 官方 OpenAI SDK 包调用 | **UNVERIFIED** | 未安装 `openai` npm 包。已用 curl 对 models/responses/stream/chat 做等效验证;`examples/openai-sdk-smoke.mjs` 已备但未执行 |
| WSL 内运行本项目 | **UNVERIFIED** | 当前验证环境未提供 `wsl.exe`,无法在 WSL 内启动 gateway / 运行测试。WSL 侧仅验证了"客户端接入"(DSH 实际调用成功) |
| macOS / Linux 平台 | **UNVERIFIED** | 浏览器打开分支(`open`/`xdg-open`)与 POSIX 0600 权限校验均未在真机执行;Windows 上 NTFS 权限检查被 doctor 跳过 |
| DSH 工具**执行**结果 | **部分 UNVERIFIED** | 已证实:DSH 每请求携带 `tools:27`、多轮 `inputs` 中 function_call/function_call_output 成对递增、gateway 侧 tools 透传 live 测试 PASS。未直接观测到 DSH 端工具执行的具体输出 |
| 长期连续运行 | **UNVERIFIED** | 最长连续运行约 2h17m(已观察到稳定)。跨 token 过期周期(当前 token 至 09-21)的长期行为未观察 |
| 并发多客户端 | **UNVERIFIED** | 未做多客户端并发压测;仅单客户端顺序使用 |

---

## 7. 后续维护方式

**日常**
```bash
.\start-serve.bat              # 起服务(自动绑 WSL 网卡 IP)
node dist/cli/index.js status  # 登录态与 token 有效期
node dist/cli/index.js doctor  # 自检(零额度)
```

**上游变更时(核心维护动作)**
1. `node dist/cli/index.js upstream-check` → 若 `REVIEW_REQUIRED`;
2. 按 `docs/MAINTENANCE.md` 的 18 步流程执行(其中第 4–9 步为逐项比对,
   第 10 步要求"先写 failing test");
3. `scripts/probe-models.ts` / `probe-responses.ts` / `probe-tools.ts`
   三个探针用真实账号做最小实测(不打印凭证);
4. 改动集中在 `src/upstream/` 与 `src/auth/`;若必须改 `src/api/`,
   先重审设计(大概率是上游逻辑泄漏);
5. `pnpm test` 全绿 → 更新 `docs/UPSTREAM.md` verified 块与 §条目 →
   单独 commit(`chore(upstream): align with codex <version>`)。

**观测手段**
- 请求形状(不含内容):`OSG_LOG_LEVEL=debug` 启动,看 `[osg debug]` 行
  (model / stream / tools 数 / 输入项类型计数 / reasoning / service_tier)。
- 密钥此类信息由 `src/log.ts` 统一脱敏,新增日志请走 `log.*` 接口。

**红线(维护时不得违反)**
- 不新增第二 Provider / Router / AccountPool / 插件系统 / Web UI;
- 不引入模型 id 白名单或按模型名的特判;
- 不为单个客户端(含 DSH)写专属 hack;
- 不改 `~/.codex/auth.json`;不为图省事绑 `0.0.0.0`。

---

## 8. 运维收尾(交接时)

- 后台服务进程为本次会话启动的临时进程,会话结束后不保证存活;
  长期使用请用 `start-serve.bat` 自行启动。
- 凭证位于 `~/.openai-subscription-gateway/auth.json`,到期前自动刷新;
  登出用 `osg logout`(只删本 gateway 的凭证,不影响 Codex CLI)。
- 未提交文件:无。未入库凭证:无。
