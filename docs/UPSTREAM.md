# UPSTREAM.md — Codex 上游依赖契约

本文件记录 openai-subscription-gateway 依赖的 OpenAI Codex 上游行为。
维护规则:每次对齐上游后更新下方 verified 信息;只记录我们真正依赖的契约,不复制官方大段代码。

```text
Last verified Codex CLI version: 0.154.0 (用户 WSL 验证环境中的 codex-cli;
  历史:0.153.4 曾为验证版本,Windows PATH 上另有 0.148.0)
Last verified openai/codex revision: main branch, fetched 2026-09-10
Last verified date: 2026-09-12 (0.154.0 实测:live 套件 9/9 全通)
Gateway version: 0.1.1
```

> 注意:研究基于 main 分支(≈0.154.0)源码。本机 CLI 为 0.148.0,相差 6 个 minor。
> 落地常量(client_id、scope、端口等)在 0.148→0.154 间未见变更迹象,但每次
> upstream-check 发现版本差异时应按 MAINTENANCE.md 复核本文件。
> 2026-09-11 起 §1–§3(OAuth)与 §9(client_version 行为)已经真实账号 live 验证。

---

## 1. OAuth endpoints

我们依赖的契约:

```text
AUTHORIZE: https://auth.openai.com/oauth/authorize
TOKEN:     https://auth.openai.com/oauth/token
REVOKE:    https://auth.openai.com/oauth/revoke
ISSUER 常量: DEFAULT_ISSUER = "https://auth.openai.com"
```

- 官方源码位置:`codex-rs/login/src/server.rs`。
- CLI 留有 `CODEX_REFRESH_TOKEN_URL_OVERRIDE` / `CODEX_REVOKE_TOKEN_URL_OVERRIDE` env 覆盖;gateway 不依赖该机制,直接硬编 issuer + 路径(与 CLI 默认一致)。

## 2. OAuth client 行为(authorize 请求)

`build_authorize_url`(server.rs)逐字参数契约:

```text
response_type=code
client_id=app_EMoamEEZ73f0CkXaXp7hrann        (login/src/auth/manager.rs CLIENT_ID)
redirect_uri=http://localhost:{port}/auth/callback
scope=openid profile email offline_access api.connectors.read api.connectors.invoke
code_challenge=<BASE64URL(SHA256(verifier)),无 pad>
code_challenge_method=S256
id_token_add_organizations=true
codex_cli_simplified_flow=true
state=<32 随机字节 base64url 无 pad>
originator=codex_cli_rs
```

- callback 端口:默认 `1455`(`DEFAULT_PORT`),被占用时重试后回退 `1457`(`FALLBACK_PORT`)。
- gateway 实现:同样绑 127.0.0.1,依次尝试 1455 → 1457 → 随机空闲端口。
- state 回调精确相等校验,不匹配返回 400。
- PKCE verifier:64 随机字节 base64url 无 pad(源码:`login/src/pkce.rs`)。

## 3. Token 交换与刷新

- 授权码交换:POST TOKEN,`Content-Type: application/x-www-form-urlencoded`,
  body = `grant_type=authorization_code & code & redirect_uri & client_id & code_verifier`。**无 client_secret**。
- 刷新:POST TOKEN,`Content-Type: application/json`,
  body = `{client_id, grant_type:"refresh_token", refresh_token}`。**无 client_secret / redirect_uri / scope**。
- code 交换响应:`{id_token, access_token, refresh_token}` 三个必填,**无 expires_in**。
- refresh 响应:`{id_token?, access_token?, refresh_token?}` 全部可选。
- **关键契约:refresh 响应不含新 refresh_token 时,旧 refresh_token 必须保留,仍然有效。**
- access_token 是 JWT,过期时间取其 `exp` claim(响应不给 expires_in)。
- CLI 在 exp 前 5 分钟主动刷新(`CHATGPT_ACCESS_TOKEN_REFRESH_WINDOW_MINUTES=5`),并用信号量保证单飞刷新。gateway 复制该语义:exp-300s 内视为需刷新;进程内单飞。
- 官方源码位置:`codex-rs/login/src/server.rs`、`codex-rs/login/src/auth/manager.rs`。

## 4. Backend URL

```text
BASE:      https://chatgpt.com/backend-api/codex
RESPONSES: POST {BASE}/responses
MODELS:    GET  {BASE}/models?client_version={ver}
```

- 常量 `CHATGPT_CODEX_BASE_URL`(`codex-rs/model-provider-info/src/lib.rs`);路径由 `codex-rs/codex-api/src/endpoint/responses.rs`、`endpoint/models.rs` 固定。
- CLI 无 `OPENAI_BASE_URL` 类 env 覆盖;config 有 `chatgpt_base_url` 可改。gateway 硬编默认 BASE,允许 `OSG_UPSTREAM_BASE_URL` 仅供测试/mock 使用。

## 5. Required headers

我们向上游发送 responses 请求时注入的头(契约):

| Header | 值 | 来源 |
|---|---|---|
| `Authorization` | `Bearer <access_token>` | 必需,缺失/过期 → 401 |
| `ChatGPT-Account-Id` | `<account_id>`(见 §3 id_token claim) | 必需,缺失被拒 |
| `originator` | `codex_cli_rs` | CLI 默认值;env `CODEX_INTERNAL_ORIGINATOR_OVERRIDE` 可覆盖 |
| `User-Agent` | `"{originator}/{version} (...)"` | 由 default_client 生成 |
| `session-id` / `thread-id` | gateway 生成的 UUID | 可选但强烈建议(`codex-api/src/requests/headers.rs`) |
| `OAI-Product-Sku` | `codex` | `chatgpt/src/chatgpt_client.rs` |
| `accept` | `text/event-stream` | responses 流强制 |
| `content-type` | `application/json` | |
| `OpenAI-Beta` | **不发送** | HTTP 路径不带;仅 WebSocket 握手用 |

- 官方源码位置:`codex-rs/login/src/auth/default_client.rs`、`codex-rs/model-provider/src/bearer_auth_provider.rs`、`codex-rs/codex-api/src/requests/headers.rs`。

## 6. Responses endpoint 请求体

CLI `build_responses_request`(`codex-rs/core/src/client.rs`)行为契约:

- 强制固定:`stream=true`、`store=false`、`include` 含 `"reasoning.encrypted_content"`。
- CLI 将 `tool_choice` 硬编码为 `"auto"`,并将 `instructions` 覆盖为 Codex 自身系统提示。
  **这是 CLI 行为,不是 backend 强制**——backend 接受调用方给出的 instructions。

**参数支持矩阵(2026-09-11 真实账号逐参数探测,scripts/probe-responses.ts):**

| 参数 | backend 行为 |
|---|---|
| `instructions`(含空串)、`reasoning.effort`、`prompt_cache_key`、`tool_choice`("auto")、`parallel_tool_calls`、`text.format`、`tools`、`input`(列表) | 接受,正常完成 |
| `input` 为字符串 | **400** `Input must be a list` → gateway 归一化为 message item 列表 |
| `temperature` / `top_p` / `truncation` / `metadata` / `max_output_tokens` / `max_tokens` | **400** `Unsupported parameter: X` → gateway 剥离并以 `x-osg-normalized` 头透明上报 |
| `service_tier` | 见 §11 |

- gateway 决策(见 DESIGN.md):
  - 上表"接受"的参数 → **透传**;
  - 上表"400"的参数 → **剥离/归一化 + notes 上报**(见 §7);
  - `stream` 对上游恒为 `true`(下游非流式请求由 gateway 聚合 SSE);
  - `store` 恒为 `false`(下游显式 `store=true` → 400,我们不支持状态存储);
  - `include` = 下游 include ∪ `{"reasoning.encrypted_content"}`。

## 7. Request normalization

- `input` item 类型:message / reasoning / function_call / function_call_output / input_image 等,与公开 Responses API 一致;**字符串 input 必须归一化为 message item 列表**(实测:上游对字符串 input 返回 400)。
- `prompt_cache_key`:透传;缺省时 gateway 不伪造。
- 本地 workaround 记录(全部有 live 实证,2026-09-11;实现在 `src/upstream/codex.ts normalizeForCodex`):
  1. `input` 字符串 → `[{type:"message",role:"user",content:[{type:"input_text",text}]}]`(上游只要列表)。
  2. 剥离 `temperature/top_p/truncation/metadata/max_output_tokens/max_tokens`(上游各返 400 `Unsupported parameter`);剥离事实以响应头 `x-osg-normalized` 透明上报下游。
  3. `service_tier` 映射见 §11。
  任何未来新增的改写必须在此登记原因与实证。
- 官方源码位置:`codex-rs/core/src/client.rs`(`build_responses_request`)、`codex-rs/protocol/src/models.rs`。

## 8. Streaming 格式(SSE)

源码:`codex-rs/codex-api/src/sse/responses.rs`。契约:

- `data: {json}\n\n` 行,`type` 字段区分事件。
- 关键事件:`response.created`、`response.output_item.added`、`response.output_text.delta`、`response.function_call_arguments.delta`、`response.output_item.done`、`response.completed`(带 usage)、`response.failed`、`response.incomplete`。
- 流以 `response.completed` 或连接关闭结束。`response.failed`/`response.incomplete` 必须映射为错误。
- **gateway 侧约定(行为,曾为 P1 缺陷已修)**:
  - 流式:这两个事件**不得**原样透传,由 `responsesPassthroughTransform` 转成网关
    error 事件(`{"type":"error","error":{type,code,message}}`)后结束流;
  - 非流式聚合:抛错,不返回部分结果;
  - 非流式聚合收到 `response.completed` 后**立即完成**,不等待上游关闭连接
    (上游可能在结束帧后仍保持连接;`keepOpenAfterEvents` 用例已覆盖)。
- 无独立 HTTP cancel endpoint;取消 = 客户端断开(CLI 用 CancellationToken 监听)。
- gateway 契约:下游断连 → abort 上游请求;上游 premature close(未收 completed/failed)→ 向下游注入 error 事件后关闭。
- **重大怪癖(live 实测 2026-09-11,scripts/probe-tools.ts)**:`response.completed.response.output` **恒为空数组**——纯文本与 tool call 场景均如此;output items 只经 `response.output_item.done` 逐一下发。非流式聚合**必须**用 item.done 事件重建 output(gateway 在 `aggregateCompletedResponse` 实现:仅当 completed.output 为空时填充,不覆盖上游已给的值)。
  实测 tool call 事件序列:`created → in_progress → output_item.added(function_call) → function_call_arguments.delta ×N → function_call_arguments.done → output_item.done → completed`。
  completed.response 还回响大量请求侧字段(background/frequency_penalty/max_output_tokens/temperature 等),原样透传给下游即可,SDK 会忽略。

## 9. Model catalog schema

- 动态目录三层:binary 内置 `models.json` 兜底 → backend `/models` 刷新 → `~/.codex/models_cache.json`(TTL 300s,含 `client_version` 强校验)。
- `GET {BASE}/models?client_version={ver}`,header 只需 `Authorization: Bearer <token>`;响应 `{models: [...]}`,ETag 支持 `If-None-Match` 复用。
- **行为关键(live 实测 2026-09-11)**:`client_version` 不是装饰参数,上游按它过滤目录。
  实测:client_version=0.1.0(本 gateway 自身版本)→ **200 但 models 为空数组**;
  =0.148.0 → 6 条(无 gpt-6-astra);=0.154.0 → 7 条(含 gpt-6-astra)。
  因此 gateway 必须发送已验证的 Codex 版本(config `clientVersion`,可用
  `OSG_CODEX_CLIENT_VERSION` 覆盖),由 upstream-check 发现版本漂移。
  发送自身版本号会得到静默空目录,这是最容易误诊为"账号无权限"的坑。
- **取值决策(已更新为 0.154.0,2026-09-12)**:当前 `FALLBACK_CODEX_VERSION = "0.154.0"`
  (用户 WSL 验证环境中的 codex-cli 版本;0.153.4 为更早的验证版本,Windows PATH 上另有 0.148.0)。
  gateway 伪装成它则上游目录与用户 CLI 一致;gpt-6-astra 推理实测通过
  (status=completed,usage 含新版 `attribution` 明细,原样透传)。`upstream-check` 优先探测 `wsl codex --version`(不可用
  时回退 PATH),与该值对齐报 CURRENT/REVIEW_REQUIRED。
- **取值来源(RC 收口后,实现在 `src/upstream/client-version.ts`)**:
  优先级 `OSG_CODEX_CLIENT_VERSION` → `{OSG_HOME}/config.json#clientVersion`
  → 自动检测 `codex --version`(Windows 优先 WSL) → `FALLBACK_CODEX_VERSION`。
  约束:检测失败不阻断启动;不自动升级;不自动改写配置;已有配置时短路探测;
  检测值低于已验证版本仅提示不改值。`osg config` / `osg doctor` 会输出
  effective / source / configured / detected / fallback。
- **0.154.0 对齐记录(2026-09-12)**:用户 WSL 中的 codex 升级到 0.154.0,
  `upstream-check` 报 drift;以该版本实测 live 套件 **9/9 全通**
  (models / responses / streaming / reasoning / fast / tools / image / refresh)
  → 判定本文件记录的全部契约在 0.154.0 下依然成立,`FALLBACK_CODEX_VERSION`
  与 verified 块同步更新为 0.154.0。
  **未做上游源码级 diff**(GitHub release notes 为空),验证依据是实测——
  与本项目"契约来自实测"的既有做法一致。
- 条目关键字段(实测本机 models_cache.json,2026-09-10):
  `slug, display_name, description, default_reasoning_level, supported_reasoning_levels[{effort,description}], visibility(list|hide|none), supported_in_api, priority, additional_speed_tiers[], service_tiers[{id,name,description}], default_service_tier, context_window, max_context_window, effective_context_window_percent, input_modalities[], default_reasoning_summary, truncation_policy, upgrade?`。
- gateway 契约:仅暴露 `visibility=="list"` 且 `supported_in_api==true` 的模型;**严禁模型白名单硬编码**。
- 官方源码位置:`codex-rs/models-manager/`、`codex-rs/codex-api/src/endpoint/models.rs`、`codex-rs/app-server/src/models.rs`。

## 10. Reasoning 语义

- wire:`reasoning: {effort, summary?}`;effort 枚举 `none|minimal|low|medium|high|xhigh|max|ultra`(模型各自子集,见目录 `supported_reasoning_levels`);默认取目录 `default_reasoning_level`(全局兜底 medium)。
- summary 枚举 `none|auto|detailed`,模型级 `default_reasoning_summary`(实测多为 `none`)。
- **目录不是权威白名单(live 实测 2026-09-11,gpt-5.6-luna)**:
  - 目录 `supported_reasoning_levels` = low/medium/high/xhigh/max(**无 none**)
  - 但上游实际:effort=`none` → **200 接受**;effort=`minimal` → 400
    (`Supported values are: 'none', 'low', 'medium', 'high', 'xhigh', and 'max'`)
  - 结论:以目录做本地前置校验会**误杀合法请求**(DSH 默认 effort=none 被拦即为实例)。
- gateway 契约:**reasoning 不做任何本地校验、不改写、不 clamp,一律透传**;
  上游 400 自带准确合法值列表,由 errors.ts 映射为 OpenAI 风格错误(消息保留)。
  这是"越薄越成功"原则的直接体现——目录只用于 `/v1/models` 展示与 model 存在性。

## 11. Service tier 语义

- wire:请求体 `service_tier` 字段。
- 实测目录:`service_tiers:[{id:"priority", name:"Fast", ...}]`、`additional_speed_tiers:["fast"]`。
- **枚举值实测矩阵(2026-09-11,gpt-5.6-sol)——与研究结论冲突处以实测为准**:
  - `"priority"` → 200(Fast 的真实 wire 值,与 CLI 物化一致)
  - `"default"` → 200
  - `"fast"` → **400** `Unsupported service_tier: fast`(注意:公开 API 文档说 fast/priority 等价,**Codex backend 并不接受 fast**)
  - `"auto"` → 400 `Unsupported service_tier: auto`
  - `"flex"` → 400 `Unsupported service_tier: flex`
- gateway 契约:`fast` → **改写为 `priority`**(notes 上报);`auto` → **省略**(=default 语义,notes 上报);`priority`/`default` 透传;其他值透传交上游裁决。能力判断只看目录(`additional_speed_tiers`/`service_tiers`),不做模型名硬编码。
- 官方源码位置:`codex-rs/protocol/src/openai_models.rs`(ServiceTier 与 request_value)、`codex-rs/models-manager/`(目录字段);改名背景见 openai/codex PR #23537。

## 12. Tool calling

- 请求侧 `tools`:标准 Responses function tool schema,透传。
- 响应侧:`function_call` output item + `response.function_call_arguments.delta` SSE 事件(CLI 业务层忽略该 delta,但原始流中存在;下游 harness 需要,必须透传)。
- 回传:`function_call_output` item 进入下一轮 input。
- gateway 契约:不改 tool name、不改 arguments、不执行任何 tool。

## 13. Image input

- 实测目录所有 list 模型 `input_modalities: ["text","image"]`,即当前 Codex 模型均支持图像输入。
- item 形式:`input_image`(base64 data URL,`detail` 参数;目录有 `supports_image_detail_original`)。
- gateway 契约:按标准 Responses schema 透传,零改写。V1 支持。

## 14. Errors

- 非 2xx:CLI 行为是 `{status}: {body}` 原样上抛;body 形状官方源码未显式解析,[推测] 为 OpenAI 风格 `{error:{type,code,message}}`。
- 流内:`response.failed` 的 `error.code` 已知枚举:`context_window_exceeded`、`quota_exceeded`、`rate_limit_exceeded`、policy 类。
- 401:CLI 判 recoverable 后刷新 token 重试一次。gateway 复制:上游 401 → 强制刷新 → 重试一次 → 仍 401 则对下游报 401 `authentication_error`(提示重新 `osg login`)。
- gateway 对下游错误映射契约(稳定):

```text
400 invalid_request_error   请求校验失败 / 上游 400
401 authentication_error    未登录 / 刷新后仍 401
404 not_found_error         模型不存在
429 rate_limit_error        上游 429(透传 Retry-After,若有)
502 upstream_error          上游协议错误(坏 SSE/非法 JSON/上游 5xx 内容异常)
503 upstream_unavailable    网络不可达
504 upstream_timeout        上游超时
```

- 日志红线:access_token、refresh_token、Authorization、cookie、credential JSON 一律不落日志;URL 敏感 query(state/code/token)脱敏。
- 官方源码位置:`codex-rs/codex-api/src/sse/responses.rs`(流内错误映射)、`codex-rs/chatgpt/src/chatgpt_client.rs`(非 2xx 处理)、`codex-rs/login/src/auth/manager.rs`(401 刷新重试)。

## 15. Usage

- `response.completed.usage`:`input_tokens`、`input_tokens_details{cached_tokens, cache_write_tokens}`、`output_tokens`、`output_tokens_details{reasoning_tokens}`、`total_tokens`、Codex 专属 `codex_rollout_budget_units`。
- gateway 契约:usage 原样透传(含 Codex 扩展字段,OpenAI SDK 会忽略未知字段);**不估算、不伪造**;非流式聚合时取 completed 事件的 usage。

---

## 附:本机 models_cache.json 实测摘要(2026-09-10)

- 顶层:`{fetched_at, etag, client_version:"0.153.4", models:[7]}`。
- list+api 可见模型:`gpt-6-astra`(priority 1,默认)、`gpt-5.6-sol`、`gpt-5.6-terra`、`gpt-5.6-luna`、`gpt-5.5`。
- 全模型:`input_modalities:["text","image"]`,`additional_speed_tiers:["fast"]`。
- reasoning:gpt-6-astra / gpt-5.6-* 支持 low→ultra 六档;gpt-5.5 支持 low→xhigh 四档。
- context_window 272000;max_context_window 多数 872000(gpt-5.5 为 272000)。
