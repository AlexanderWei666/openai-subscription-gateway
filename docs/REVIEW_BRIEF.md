# 评审简报

> **本文档自包含**:无需其他对话上下文即可开始评审。所有细节都能在 `docs/` 与源码中复核。
> 面向外部评审者(全库评审),请重点看第 5、6、8 节。

---

## 1. 项目是什么

把 **ChatGPT / OpenAI Codex 订阅**(浏览器 OAuth 登录态)转换成本机可访问的、
标准 **OpenAI-compatible HTTP API**。

| | |
|---|---|
| 上游 | 唯一上游 `https://chatgpt.com/backend-api/codex`,鉴权 = ChatGPT OAuth Bearer + `ChatGPT-Account-Id` |
| 下游 | 任意 OpenAI-compatible 客户端(WorkBuddy / DSH / curl / SDK) |
| 定位 | **OpenAI-compatible supported subset**,不是完整 OpenAI API clone |
| 平台 | 开发在 Windows;当前**运行在 WSL**(绑 `0.0.0.0:10101`),Windows 侧经 WSL2 localhost 转发访问 |

**明确不是**:多 Provider 聚合器 / 路由器 / 账号池 / Agent 框架 / 工具执行器 /
公网服务 / DSH 插件 / 含 Web UI 或数据库。完整非目标清单见 `docs/DESIGN.md`。

---

## 2. 当前状态

| 项 | 值 |
|---|---|
| 版本 | `0.1.1`(`GATEWAY_VERSION` = `package.json`) |
| 提交 / tag | 两个发布点 `v0.1.0`、`v0.1.1`;HEAD 在其后(当前提交数请用 `git rev-list --count HEAD`) |
| 测试 | 离线 **138/138 PASS**;live **9/9 PASS**(live 未在本次执行);`doctor` 6 PASS + 1 WARN(Windows ACL) |
| 规模 | `src/` 18 文件 3094 行;`tests/` 22 文件 3295 行;`docs/` 8 份;`scripts/` 4 个 |
| 运行时依赖 | **0**(仅用 `node:` 内置模块);devDeps 仅 typescript + @types/node |
| 工具链 | Node ≥ 24(`engines`)、`tsc`、`node --test`(无测试框架) |
| 文档保鲜 | `node scripts/doc-check.ts` → `DOC_FRESHNESS: OK` |

---

## 3. 本次改动清单(按性质分组)

### 3.1 功能实现(v0.1.0 之前)

- **分层架构**:`server.ts`(路由) → `api/`(OpenAI 面) → `upstream/`(Codex 适配) → `auth/`(OAuth)。
  铁律:Codex 私有细节(私有头、参数怪癖)**只允许**出现在 `upstream/` 与 `auth/`;
  `grep -rn "chatgpt-account-id\|originator" src/api/` 必须为空。
- **5 条路由**:`GET /health`、`GET /v1/models`、`GET /internal/models`(诊断)、
  `POST /v1/responses`(流式+非流式)、`POST /v1/chat/completions`(兼容层,双向转换)。
- **OAuth**:PKCE 登录(本地回调 1455→1457→随机端口)、token 刷新、登出(revoke)。
  凭证独立于 Codex CLI,**不读不写** `~/.codex/auth.json`。
- **动态模型目录**:live → gateway 磁盘缓存 → Codex CLI 缓存 三级回退;零模型硬编码。
- **流式**:上游 SSE 透传 + 背压处理 + 取消传播;非流式由聚合 SSE 得到。
- **CLI**:`login/logout/status/serve/models/doctor/doctor --live/config/upstream-check`。

### 3.2 缺陷修复(3 个 fix commit)

1. `258616f` 终审发现(1 MEDIUM + 2 LOW)。
2. `3ede288` **撤销 reasoning effort 的本地校验** —— 实测证明模型目录的
   `supported_reasoning_levels` **不是权威白名单**(luna 未列 `none` 但上游接受),
   本地拦截会误杀合法请求(DSH 默认 `effort=none` 曾被误拦)。改为纯透传。
3. `116956f` clientVersion 跟随用户实际使用的 Codex 版本(曾在 Windows/WSL 之间取错)。

### 3.3 可靠性加固(v0.1.1,提交 `be37393`)

| 修复 | 要点 |
|---|---|
| OAuth refresh single-flight | 进锁后**重新读取最新凭证并二次判断**;并发刷新只产生 1 次 token endpoint 调用(防 rotation 下 credential 覆盖) |
| OAuth timeout | exchange/refresh/revoke 统一 30s;超时映射为明确错误,不自动重试 |
| Model catalog 缓存保护 | live 返回空数组(或全为无法识别条目)时**不覆盖**有效缓存/内存态,回退旧缓存;无缓存则 `CatalogUnavailableError` |
| clientVersion 校验收紧 | 配置值必须**整体**匹配 `x.y.z`;垃圾串丢弃并降级 |
| SSE backpressure abort | `waitForDrain` 同时响应 drain/close/error/abort;客户端断开即结束 pump 并取消上游(**不引入 idle timeout**) |
| Chat 流式工具兼容 | role chunk 恰好一次;tool call 出现时 `finish_reason=tool_calls`(上游 `completed.output` 恒空,靠 `sawToolCall` 自行跟踪) |

新增 25 个测试(含 mock 层新增 `socketDestroy` 行为以模拟连接层瞬断)。

### 3.4 上游协议实测结论(本项目最核心的资产)

全部记录在 `docs/UPSTREAM.md`,均由实测得出(非文档推测):

- **`client_version` 是行为参数**:上游按它过滤目录;发送"不认识的版本"→ 200 但
  **空数组**(极易误诊为"账号无权限")。
- **`response.completed.response.output` 恒为空数组** → 非流式聚合**必须**从
  `response.output_item.done` 重建 output。
- **参数支持矩阵**:`temperature` / `top_p` / `truncation` / `metadata` /
  `max_output_tokens` 均被上游 400 拒绝 → 由 `normalizeForCodex` 剥离并记入
  `x-osg-normalized` 响应头;`input` 必须是列表。
- **`service_tier`**:上游只认 `priority` / `default`;`fast` 被 400 →
  gateway 做 `fast`→`priority` 转换,`auto` 省略。
- **reasoning effort**:一律透传,不做本地校验(见 3.2)。
- **连接层重试**:网络类失败最多 3 次(指数退避),仅限尚未向下游写出字节时。
- **对齐版本**:Codex **0.154.0**(2026-09-12 实测 live 9/9 全通后更新);
  `FALLBACK_CODEX_VERSION` 与 `UPSTREAM.md` verified 块由 `doc-check` 强制一致。

### 3.5 评审遗留项收口(当前修复)

- `response.incomplete` 没有 `response.error` 时,流式错误仍保留
  `incomplete_details.reason`,并使用稳定 code `response_incomplete`。
- Chat 的非对象 content part 与缺少 URL 的 `image_url` part 显式返回 400
  `invalid_request_error`,不再静默丢弃输入。
- 损坏凭证仍保持 500 语义,但错误消息不再回显服务端绝对路径。
- 本节修复新增 3 个真实路由契约测试;凭证路径脱敏由单元测试覆盖。

### 3.6 配置与工程

- **clientVersion 参数化**:`OSG_CODEX_CLIENT_VERSION` → `{OSG_HOME}/config.json`
  → 自动检测 `codex --version`(Windows 优先 WSL) → `FALLBACK_CODEX_VERSION`。
  约束:检测失败不阻断启动、不自动升级、不自动改写配置、已有配置时短路探测。
- **`osg config` / `doctor` 输出 effective configuration**(值 + 来源)。
- **文档保鲜机制**:`scripts/doc-check.ts` 自动校验 5 类不一致
  (CLI 子命令存在性 / 版本三方一致 / 环境变量真实读取 / fallback 版本对齐 / 引用路径存在),
  并**显式声明未覆盖范围**(语义描述、快照数值)。
- **`.gitattributes`**:`.sh`=LF、`.bat`=CRLF(避免 WSL 下 `bad interpreter`)。
- **`.gitignore` 穷尽**:含 `auth.json`、`auth.json.tmp-*`、`.codebuddy/`、`.workbuddy/`、
  `.env*`、`*.tsbuildinfo`、`.ai/` 等,每条经 `git check-ignore` 实测。
- **启动脚本**:`start-serve.bat`(Windows,自动探测 WSL 网卡并绑定)、
  `start-serve.sh`(WSL,默认绑 `0.0.0.0`)。
- **探针脚本**(维护用,真实账号最小调用):`scripts/probe-{models,responses,tools}.ts`。
- **debug 观测**:`OSG_LOG_LEVEL=debug` 输出请求摘要(model/stream/tools 数/输入项类型计数/
  reasoning/tier),**不含内容**。

---

## 4. 建议的评审入口(按此顺序)

1. `README.md` —— 用法与边界(10 分钟)
2. `docs/DESIGN.md` —— 为什么这么设计、非目标、信任边界
3. `docs/UPSTREAM.md` —— 上游实测契约(**改上游相关代码前必读**)
4. `src/server.ts`(169 行) → `src/api/responses.ts`(核心链) → `src/upstream/codex.ts`
5. `docs/MAINTENANCE.md` —— 上游变更时的 18 步流程

辅助:`docs/HANDOFF.md`(交接报告)、`docs/ORIENTATION.md`(Java 视角导览)、
`docs/READING_GUIDE.md`。正式上线后的版本变更再以 release summary 记录。

---

## 5. 已知问题(已记录,未修 —— 请评估严重性)

1. **无凭证时错误措辞不符**:返回 `Upstream rejected credentials after refresh`,
   实际原因是"压根没有凭证"。
2. **DSH 模型下拉含不可用模型** —— 属**客户端**限制:DSH 用其依赖
   `@earendil-works/pi-ai` 内置的静态清单(646 条),不读 `/v1/models`;
   实测该对话框 10 个 id 全部命中该文件,其中仅 5 个真实可用。gateway 不加特判。
3. **`doctor` 的 config 行**显示 config 默认 host,而非运行中进程的实际绑定地址。
4. **`src/api/chat-completions.ts` 500 行**,全项目最大文件(职责单一但偏大)。
5. **`upstream-check` 在无 codex 的环境**显示 `Installed Codex: not found`(正确行为,但易被误读)。

---

## 6. 未验证项(请**不要**当作 PASS 采信)

| 项 | 状态 |
|---|---|
| 官方 OpenAI SDK 包调用 | **未验证**。仅用 curl 做等效验证;`examples/openai-sdk-smoke.mjs` 已备未执行 |
| 原生 macOS / Linux | **未验证**。WSL(Linux 内核)已实测通过;原生 macOS/Linux、POSIX 权限检查未在真机跑过 |
| DSH 端**工具执行**结果 | **部分未验证**。已证实:tools 送达(27 个)、多轮输入项成对递增、gateway 侧透传 PASS;未直接观测 DSH 端执行输出 |
| 长期连续运行 | **未验证**。最长连续运行约 2h17m;跨 token 过期周期未观察 |
| 多客户端并发 | **未验证**。未做并发压测(仅顺序使用 + 一次 5 并发冒烟) |
| Codex 0.154.0 源码级 diff | **未做**。GitHub release notes 为空,对齐依据是 live 实测 9/9 |
| Windows 侧绑定 `0.0.0.0` | 未采用(当前 WSL 内绑定;理由见 `docs/MIGRATION_WSL.md`) |

---

## 7. 边界(本项目有意不做,请勿作为缺陷提出)

多 Provider / 路由 / 账号池 / 负载均衡 / 自动故障转移 / Web UI / Dashboard /
插件系统 / MCP Server / Agent Loop / 工具执行 / 数据库 / 用户系统 /
公网部署 / Docker / NAS / systemd 自启 / 完整 OpenAI API clone /
多进程凭证锁(单实例假设) / OpenCodex 兼容层 / 通用 Provider 抽象。

---

## 8. 建议重点评审的位置

1. **`src/upstream/codex.ts`** —— 私有头注入、`normalizeForCodex` 的剥离/改写清单、
   连接层重试的边界条件(是否可能在已写出字节后重试)。
2. **`src/api/responses.ts` 的 `pumpUpstreamStream` / `waitForDrain`** ——
   背压、取消传播、`finally` 中 abort/end 的顺序、监听器是否泄漏。
3. **`src/auth/oauth.ts` 的 `TokenManager`** —— single-flight 的并发正确性、
   forceRefresh 与例行刷新并发时的语义、凭证明文是否可能进日志。
4. **`src/upstream/catalog.ts`** —— 三级回退的判定条件、缓存写入时机、
   "空结果不覆盖"是否覆盖所有路径。
5. **`src/api/chat-completions.ts`** —— 双向转换的完整性(工具调用、多轮、
   流式 delta 累积、`finish_reason` 判定),这是最"机械"也最容易漏 case 的文件。
6. **测试盲区** —— `tests/{unit,contract,live}` 覆盖了什么、哪些路径没有测试
   (例如 Windows 分支、非 loopback 绑定)。
