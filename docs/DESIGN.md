# DESIGN.md — openai-subscription-gateway

> 目标读者:未来接手的 AI 或工程师。10 分钟读完全部。
> 上游 wire 细节不在此重复,见 `docs/UPSTREAM.md`。

## 产品目标

把 ChatGPT / OpenAI Codex 订阅变成**本地** OpenAI-compatible API。
任何支持 OpenAI API + 自定义 baseURL 的客户端,改两个配置就能用:

```text
Base URL: http://127.0.0.1:10101/v1
API Key:  local-placeholder
```

## 非目标(V1 明确不做)

不做多 Provider / Router / Account Pool / Dashboard / Web UI / 插件系统 / MCP /
Agent Loop / Shell·FS 工具 / 数据库 / 用户系统 / 公网部署 / 通用 OAuth 框架。
不是 DSH 插件、不是 OpenCodex 兼容层、不是第二个 OpenCodex。
上游永远只有 OpenAI Codex,下游永远只有 OpenAI-compatible API。

## 系统架构

```text
下游客户端 (DSH / OpenAI SDK / ...)
   │  OpenAI-compatible HTTP
   ▼
api/          路由 + 校验 + OpenAI 风格错误          (不懂 OAuth、不懂 Codex 私有头)
   │  内部统一走 Responses 协议
   ▼
upstream/     极薄 Codex adapter                     (唯一知道 Codex 私有协议的地方)
   │  注入 auth 头 / 强制 stream=true / SSE 解析
   ▼
auth/         OAuth 登录态 + token 刷新              (只被 upstream 调用)
   ▼
OpenAI Codex backend (chatgpt.com/backend-api/codex)
```

分层铁律:Codex 私有细节只允许出现在 `upstream/`(外加 `auth/` 的 OAuth 实现)。
api/ 层出现的任何 `chatgpt-account-id`、`originator` 字样都是 bug。

## 配置策略

**主配置面 = 环境变量**,不引入通用配置文件。理由:

1. **跨平台一致**:同一套写法要跑 Windows / WSL / Linux / macOS;
   配置文件会引入"放哪、权限、格式、行尾"四类平台差异,环境变量没有。
2. **与启动方式对齐**:配置跟着启动命令走(脚本/手动/bat),不存在
   "改了哪个文件才生效"的歧义。
3. **可诊断**:`osg config` 直接输出生效值与来源,不需要额外解释文件合并规则。
4. **无隐藏状态**:唯一持久状态是凭证(`auth.json`);配置不落盘,
   少一类"配置漂移"问题。

**代价(已知并接受)**:每次启动需携带变量;Windows 三种 shell 语法不同
(cmd `set` / PowerShell `$env:` / bash `export`)。
缓解:`start-serve.bat` 固化常用组合;`osg config` 随时查当前值与来源。

**唯一例外**:`{OSG_HOME}/config.json` 的 `clientVersion` 字段(优先级第 2)。
原因:该值需要**跨会话持久**(用户不会每次启动都带环境变量),且允许用户覆盖;
取值链 env → config.json → 自动检测 → `FALLBACK_CODEX_VERSION`,
详见 UPSTREAM.md §9 与 `src/upstream/client-version.ts`。

**不做的**:通用配置文件、配置热重载、配置中心、多环境 profile。
需要多实例/多账号管理时应重新评估本策略(见"非目标")。

## 信任边界

- 只监听 127.0.0.1(默认 10101)。显式 `OSG_HOST` 绑非 loopback 时打印显著警告。
- 下游 API key 是 placeholder:不校验值。它是"本机进程归属"标记,不是公网认证。
- 凭证文件:`~/.openai-subscription-gateway/auth.json`(0700 目录 / 0600 文件)。
- **Windows ACL 不由本项目管理**:OSG 假定可信本地用户环境(trusted local user
  environment),不实现 `icacls` / DACL 自动修改,也不做 Windows 专属凭证管理。
  `doctor` 在 Windows 上输出 `WARN: Windows ACL not verified`,**不显示 PASS**;
  POSIX 平台继续做 0600 校验。跨平台优先顺序:Windows / WSL / Linux / macOS。
- 与 Codex CLI 登录态完全独立:不读、不写 `~/.codex/auth.json`。
  (唯一例外:`/v1/models` 的兜底目录可读 `~/.codex/models_cache.json`——只读,非凭证。)

## API 范围

定位:**OpenAI-compatible supported subset**——只实现下列端点,
**不是完整 OpenAI API clone**;未实现端点明确 404,不假装支持。

```text
GET  /health                 无需登录
GET  /v1/models              OpenAI 标准模型列表(动态目录派生)
POST /v1/responses           核心链,stream / 非 stream
POST /v1/chat/completions    兼容层,内部转 Responses
GET  /internal/models        只读诊断:完整目录元数据(非 OpenAI schema)
```

不实现 Files / Vector Stores / Batch / Fine-tuning / Audio / Assistants。
收到此类路径请求 → 404 OpenAI 风格错误,message 说明不支持。

## OAuth 策略

- 独立登录:`osg login` 起本地 callback(1455→1457→随机端口),开浏览器走 PKCE。
- 参数逐字对齐 UPSTREAM.md §2;不凭记忆改。
- `osg logout`:只删自己的 auth.json(先调 revoke,失败也删本地)。
- `osg status`:登录状态、account、token 剩余有效期、目录模型数。

## Credential storage

- JSON:`{tokens:{id_token, access_token, refresh_token, account_id}, last_refresh}`。
- 写盘:临时文件 + rename 原子写;Windows 下权限用 ACL 尽力而为(0600 语义在
  Windows 由 NTFS 继承,doctor 检查并提示);目录创建 0700。
- 凭证 JSON 损坏或字段不完整时保持 500 `corrupt credential file`,但错误消息不得
  暴露服务端绝对路径。
- 进程内单飞刷新(mutex);401 时强制刷新重试一次。
- token 永不进日志、异常 dump、HTTP 响应、Git。

## Responses 主链

```text
校验(model 必填且在目录 / store!==true / 基本 schema)
  → 组装上游体:透传字段 + stream=true + store=false + include∪encrypted_content
  → 注入头(UPSTREAM.md §5)
  → 上游恒 SSE
  → 下游 stream=true:事件级透传(解析-转发,盯 terminal/error 事件)
  → 下游 stream=false:聚合 SSE → 单个 response JSON
```

## Chat Completions 兼容策略

薄 adapter:messages → input items;tools 直转; Responses 结果 → chat.completion[.chunk]。
不维护第二套上游。能力子集:text、image、streaming、tool calls、usage、errors。
不支持:logprobs、n>1(显式 400)、response_format json_schema(先透传,上游报错即映射)。

**user content part 的处理原则**:只支持 `text` 与 `image_url`;遇到其他类型
(`input_audio`、`file` 等)一律**显式 400**,param 为 `messages.content`。
理由:静默丢弃会让模型"看不见"这段输入而给出看似正常、实则缺少依据的回答——
这比报错更危险。也不因报错而擅自扩展 audio/file 支持范围。

## Streaming

- 真流式:收到上游 chunk 即写下游,不整段 buffer;Node 原生流控(write 返回 false 时暂停上游读)。
- 下游断连 → AbortController 取消上游;上游 premature close → 注入 error 事件后关闭;
  所有路径释放连接。

## Model discovery

优先级:① 实时 models endpoint(上游地址与参数见 UPSTREAM.md §4/§9;
client_version 发送**已验证的 Codex CLI 版本**——上游按它过滤目录,
发自身版本号会得到静默空目录,实测见 UPSTREAM.md §9)→ ② 本 gateway
磁盘缓存(任意年龄,带 stale 警告)→ ③ 只读 `~/.codex/models_cache.json` →
④ 对 /v1/models 返回 503 并说明原因(doctor / upstream-check 会暴露该状态)。
V1 不在仓库内置目录快照:快照即另一种会过期的硬编码,与"动态发现"原则相悖。
(注:Codex CLI 自身的 binary 内置 models.json 兜底是 CLI 的机制,不是本
gateway 的回退链一环。)
内存缓存 TTL 300s(对齐上游)。过滤 `visibility==list && supported_in_api`。
`/v1/models` 只出 OpenAI 标准字段;富诊断走 `/internal/models`。

## Reasoning

**透传** `reasoning:{effort,summary}`,不做本地校验、不改写、不 clamp。
实测证明目录的 `supported_reasoning_levels` 不是权威白名单(luna 未列 none 但上游
接受,none 是 DSH 的默认值),本地拦截会误杀合法请求(见 UPSTREAM.md §10)。
非法值由上游 400 裁决,其消息自带准确合法值列表,原样映射给下游。

## Service tier

上游实测只接受 `priority` / `default`(`fast` / `auto` / `flex` 均 400,
见 UPSTREAM.md §11)。gateway 契约:

- 下游 `fast` → **改写为 `priority`**(这是 Fast 能力的真实 wire 值,不是原样透传);
- 下游 `auto` → **省略**(语义等价 default);
- `priority` / `default` 及其他值 → 原样透传交上游裁决。

改写事实经 `x-osg-normalized` 响应头透明上报下游。能力来源只看目录
(`additional_speed_tiers` / `service_tiers`),不按模型名硬编码,不注入默认 tier。

## Tools

纯透传。不执行、不改名、不改 arguments 语义。`function_call_arguments.delta` 事件必须到达下游。

## Image input

标准 `input_image` 透传。V1 支持(研究结论:当前全部 list 模型支持 image)。

## Errors

对下游:稳定 OpenAI 风格 `{error:{message,type,code}}`,映射表见 UPSTREAM.md §14。
对上游:401 刷新重试一次;5xx→502;网络错误→503;超时→504(默认上游超时 300s,可配)。
流内 `response.failed` / `response.incomplete` → **转换为网关约定的 SSE `error` 事件**后关闭流:

- 事件形状(与 `premature_close` / `malformed_event` 一致,下游已见过):
  `{"type":"error","error":{"type":…,"code":…,"message":…}}`
- **严禁**把上游原始 `response.failed` / `response.incomplete` 事件名透传给下游——下游会把"失败"当作正常流内容处理(曾为 P1 缺陷,现由 `responsesPassthroughTransform` 在 transform 层转换)。
- 非流式聚合遇到这两个事件则直接抛错(不返回部分结果)。

## 稳定性:非流式聚合的完成条件

收到 `response.completed` 即完成并释放连接,**不等待上游关闭连接**——上游可能
在结束帧之后仍然保持连接打开。依据:上游契约保证 output items 在 completed 之前
下发(UPSTREAM.md §8 的实测事件序列)。

## 稳定性:连接阶段重试

上游连接层瞬断(本机代理链路抖动、`fetch failed`)会在**尚未向下游写出任何
字节**时自动重试:最多 3 次尝试,指数退避 300ms/600ms + jitter。
依据:上游 `store=false` 无状态,未开始下发时重试幂等安全;一旦开始流式下发
就不再重试(避免重复输出)。这减少了下游(如 DSH)自行重试整轮对话的浪费。
非幂等场景(已流式下发后中断)保持"宁可报错不重复"。

## 配置

只有 env:`OSG_HOST`、`OSG_PORT`、`OSG_HOME`、`OSG_LOG_LEVEL`、`OSG_UPSTREAM_BASE_URL`(测试用)、
`OSG_UPSTREAM_TIMEOUT_MS`。无配置文件。

## 测试

三层(全部 `node:test`,零测试框架依赖):
1. `tests/unit/`:credential store、刷新保留旧 token、catalog 归一化、校验、
   Chat→Responses 转换、错误映射、日志脱敏。
2. `tests/contract/`:本地 mock upstream(可控 SSE/错误/超时/截断),覆盖流式、
   工具、reasoning、tier、image、usage、取消、premature close。
3. `tests/live/`:`LIVE_TEST=1 pnpm test:live` 才跑,真实账号,极短请求。
`pnpm test` 只跑 1+2,零额度消耗。

## 明确不做什么(再强调)

任何 `ProviderRegistry / Router / AccountPool / PluginSystem / UniversalAdapter`
出现即越界。模型 id 白名单出现即越界。为单个客户端(含 DSH)写的特判出现即越界。
