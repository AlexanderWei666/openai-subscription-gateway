# openai-subscription-gateway (osg)

ChatGPT / OpenAI Codex 订阅 → 本地 OpenAI-compatible API。

## 多 Agent 协作入口

本仓库按固定角色协作：用户是 `DECISION_OWNER`（总决策人），WorkBuddy 是
`IMPLEMENTER`（工程师），Codex 是 `REVIEW_ARCHITECT`（评审架构师）。完整契约见
[根目录 `AGENTS.md`](AGENTS.md)，无需依赖 `.ai/` 即可识别角色。

任何影响接口、行为、配置、部署、版本、验收、限制或流程的改动，都必须在同一变更中
同步受影响文档、示例和交接记录，并在交接/评审/提交/发布前运行
`pnpm doc-check`。若确认无文档影响，必须记录 `DOC_IMPACT: NONE` 及具体理由；文档过期时
不得评审通过或发布。

## 是什么

一个本地小网关:用你的 ChatGPT/Codex 订阅 OAuth 登录,对任何
"支持 OpenAI API + 能改 baseURL" 的客户端,暴露标准 OpenAI 接口。

定位是 **OpenAI-compatible supported subset**(受支持的子集),
**不是完整 OpenAI API clone**——见下文"支持能力"的边界。

## 不是什么

- 不是完整 OpenAI API clone(未实现端点明确 404,不假装支持)
- 不是多模型聚合/路由器(上游永远只有 OpenAI Codex)
- 不是安全产品(不做 Windows ACL 管理,假定可信本地用户环境)
- 不是公网服务(默认只监听 127.0.0.1)
- 不是 Agent 框架、不执行任何工具调用
- placeholder API key 不是公网安全认证,只是本机占位

## 安装

需要 Node.js >= 24。项目**零运行时依赖**,只用开发依赖(TypeScript)做构建:

```bash
pnpm install    # 只装 TypeScript
pnpm build      # 源码 → dist/
```

**不想安装?** Node ≥ 24 可以直接运行 TS 源码(原生 TS 支持),零安装:

```bash
node src/cli/index.ts serve     # 实测可用;所有子命令同理
```

**⚠️ `git clone` 与"复制已构建目录"不同**:`dist/` 是构建产物、**不入库**,
所以 clone 后没有 `dist/`——要么用上面的源码方式,要么先 `pnpm install && pnpm build`。
(直接复制一份已构建的目录则天然带 `dist/`,开箱即用。)

## 登录

```bash
node dist/cli/index.js login     # 或链接全局 bin 后: osg login
```

浏览器打开 ChatGPT 授权页,授权后凭证保存在
`~/.openai-subscription-gateway/auth.json`(与 Codex CLI 的登录态完全独立,
不读不写 `~/.codex/auth.json`)。

### 凭证是怎么保管和保活的

- **保存**:`{OSG_HOME}/auth.json`,目录 `0700` / 文件 `0600`(POSIX),
  **临时文件 + rename 原子写**(不会被读到半截内容)。
  内容形状:`{tokens:{id_token,access_token,refresh_token,account_id}, last_refresh}`。
- **保活**:每次请求前检查 access token 的 `exp`;剩余不足 5 分钟即自动刷新
  (刷新为进程内**单飞**——并发请求只刷新一次,且进锁后重新读凭证二次判断)。
  服务端可能轮换 `refresh_token`,新值会被原子写回。**没有请求就不会主动刷新**。
- **删除后再登录**:可以。删除文件 = 回到"未登录";此后请求返回 401,
  重新 `osg login` 即可覆盖写入,**无需重启服务**。
- **热删除/热替换(服务运行中)**:也可以——`auth.json` **每次都从磁盘读,无内存缓存**,
  改动下一条请求即生效。三点注意:
  1. 已在流式传输中的请求不受影响(其 token 已在内存里);
  2. 要删就用 **`osg logout`**(先尽力 revoke 服务端,再删本地);
     直接 `rm` 只删本地,**服务端的 refresh_token 仍然有效**;
  3. **不要手工编辑/改坏文件**——损坏的 JSON 不会被视为"未登录",
     而是报不含本地路径的 500 `corrupt credential file`。

## 启动

```bash
node dist/cli/index.js serve     # 默认 http://127.0.0.1:10101/v1
```

**监听地址与端口可指定**(不限于 loopback):

```bash
OSG_HOST=192.168.1.20 OSG_PORT=8080 node dist/cli/index.js serve
```

Windows 上双击 `start-serve.bat` 会自动探测 WSL 网卡 IP 并绑定(供 WSL 内客户端使用)。
在 WSL 里用 `bash start-serve.sh`(默认绑 `0.0.0.0`,详见 `docs/MIGRATION_WSL.md`)。
绑非 loopback 时启动会打印安全警告——placeholder API key 不构成认证,
不要暴露给不可信网段(详见"安全边界")。

## 客户端配置

```text
Base URL: http://127.0.0.1:10101/v1
API Key:  local-placeholder
```

任何 OpenAI SDK / DSH / OpenCode / Continue 等,改这两项即可。

### 客户端在 WSL 里?(重要)

WSL2 有独立网络命名空间,`127.0.0.1` 指向 WSL 自己,**连不到 Windows 上的 gateway**。
正确做法:把 gateway 绑到 WSL 虚拟网卡(只对 WSL 可达,不暴露局域网):

```powershell
# Windows 侧:查 WSL 网卡 IP(vEthernet (WSL) 条目;重启后可能变化)
ipconfig | findstr /C:"vEthernet (WSL)" -A 5
# 启动时绑它(示例 IP 以实际为准)
$env:OSG_HOST="<WSL_HOST_IP>"; node dist/cli/index.js serve
```

WSL 侧客户端配置:

```text
Base URL: http://<WSL_HOST_IP>:10101/v1
API Key:  local-placeholder
```

WSL 里查宿主 IP 的等价命令:`ip route show default | awk '{print $3}'`。
注意:WSL 网段 IP 在重启/网络切换后可能变化,连不上先重新确认 IP。
不要为了图省事绑 `0.0.0.0`——那会让同局域网的其他设备也能消耗你的订阅。

## 支持能力

> 定位:**OpenAI-compatible supported subset**——实现上表列出的能力面,
> **不是完整 OpenAI API clone**。未列出的端点一律返回明确的 404,不假装支持。

| 能力 | 状态 |
|---|---|
| `GET /v1/models` | 动态模型目录(不硬编码模型清单) |
| `POST /v1/responses` | 流式 + 非流式 |
| `POST /v1/chat/completions` | 流式 + 非流式(兼容层) |
| reasoning effort | **原样透传,不做本地目录校验**——合法性由上游裁决(目录的 `supported_reasoning_levels` 并非权威白名单,见 UPSTREAM.md §10) |
| service_tier / Fast | **`fast` → `priority` 转换**(上游不接受 `fast`);`auto` 省略;其余透传。转换结果经 `x-osg-normalized` 头上报 |
| tool/function calling | 纯透传(不执行) |
| image input | 透传 |
| usage | 原样透传 |
| 流内失败(`response.failed` / `response.incomplete`) | 转换为网关约定的 SSE `error` 事件并结束流(**不透传上游原始失败事件**) |
| 非流式聚合 | 收到 `response.completed` 即完成,不等待上游关闭连接 |

不支持:Files / Vector Stores / Batch / Fine-tuning / Audio / Assistants /
`store:true` / `previous_response_id` / Chat 的 `stop`、`logprobs`、`penalties`(显式 400)。
Chat 的 `audio` / `file` content part 同样**显式 400**,不静默丢弃用户输入。

## 安全边界

- **默认**只监听 loopback(`127.0.0.1`);可用 `OSG_HOST` 指定任意地址,
  绑非 loopback 时启动打印显著警告(见"启动"与"客户端在 WSL 里?")
- 凭证文件 0600 / 目录 0700(仅 POSIX),原子写;token 永不进日志
- **Windows ACL 不由 OSG 管理**:OSG 假定可信本地用户环境(trusted local user
  environment),不做 `icacls` 或 DACL 自动修改;`doctor` 在 Windows 上输出
  `WARN: Windows ACL not verified`,**不显示 PASS**
- 浏览器 CORS 不开放(面向服务端/CLI 客户端)

## 维护方式

```bash
node dist/cli/index.js doctor            # 自检(不烧额度)
node dist/cli/index.js doctor --live     # 含一次极短真实调用
node dist/cli/index.js config            # 打印生效配置与各值来源
node dist/cli/index.js upstream-check    # 对比已验证上游与本机 Codex CLI
node scripts/doc-check.ts                # 文档保鲜检查(文档与实际是否一致)
```

OpenAI 改协议后:按 `docs/MAINTENANCE.md` 流程对齐,设计约束见
`docs/DESIGN.md`,上游契约见 `docs/UPSTREAM.md`。

## 环境变量

`OSG_HOST` / `OSG_PORT` / `OSG_HOME` / `OSG_LOG_LEVEL` /
`OSG_UPSTREAM_TIMEOUT_MS` / `OSG_CODEX_CLIENT_VERSION`
(`OSG_UPSTREAM_BASE_URL` 仅测试用)

### clientVersion 的取值来源(优先级从高到低)

上游按 `client_version` 过滤模型目录(不认识的版本返回空目录),该值可配置:

1. 环境变量 `OSG_CODEX_CLIENT_VERSION`
2. `{OSG_HOME}/config.json` 的 `clientVersion` 字段
3. 自动检测 `codex --version`(Windows 上优先 WSL 内的 codex)
4. 已验证版本兜底(见 `src/upstream/client-version.ts` 的 `FALLBACK_CODEX_VERSION`)

规则:配置优先;检测失败不阻断启动;不自动升级;不自动改写配置。
若检测到的版本低于已验证版本,只在 `doctor` 的 notes 里提示(不改取值)。
查看当前生效值与来源:

```bash
node dist/cli/index.js config     # 或 osg config
```

## 已知限制

- 上游恒 `stream=true` + `store=false`(Codex backend 硬约束);
  非流式下游请求由网关聚合 SSE 后返回
- 单实例假设:多进程并发刷新同一凭证文件不在 V1 范围
- Live 验证(真实 OAuth + 真实调用)见仓库最新状态报告

### DSH 推理档位 → wire 值(实测,2026-09-11)

用 `OSG_LOG_LEVEL=debug` 观察 DSH 真实请求得到:

| DSH UI | 实际透传 |
|---|---|
| Off | `{"effort":"none"}` |
| Default | `{"effort":"none"}`(与 Off 同值) |
| Low | `{"effort":"low","summary":"auto"}` |
| Medium | `{"effort":"medium","summary":"auto"}` |
| High | `{"effort":"high","summary":"auto"}` |
| Xhigh | `{"effort":"xhigh","summary":"auto"}` |
| Max | `{"effort":"max","summary":"auto"}` |

两点注意:①非 Off 档位会附带 `summary:"auto"`(请求推理摘要),Off/Default 不带;
②"Default" 取值等于模型在客户端目录中声明的默认 effort,并非"省略字段"。
gateway 对以上内容零改写,原样透传(见 DESIGN.md "Reasoning")。

### 已知问题(2026-09-12)

1. **无凭证时的错误措辞**略有误导:返回
   `Upstream rejected credentials after refresh`,实际是"压根没有凭证"。

### 客户端侧限制:DSH 的模型下拉(不是 gateway 的问题)

DSH 的模型下拉框**不读** `GET /v1/models`,而是用其依赖
`@earendil-works/pi-ai` 内置的静态清单(`dist/providers/data/openai.json`,
646 条,含 gpt-5.1–5.6 全系列与 o1/realtime 等)。实测 2026-09-11:
DSH"添加模型"对话框中出现的 10 个 id 全部命中该内置文件,无一来自 gateway。
因此下拉里会出现订阅实际调不通的模型(如 gpt-5.4-pro/o1/gpt-realtime-2.1);
选中它们会得到 gateway 稳定的 404 `model_not_found`——这是设计内的明确错误,
不是 bug。gateway 侧不为此加任何特判(见 DESIGN.md 非目标)。
DSH 自身具备模型发现能力(`llm-pi-ai/discovery.ts` 会请求 `{baseURL}/models`),
可在其设置中启用,或在其 provider 配置里显式列出来自 `/v1/models` 的模型。

## 开发

```bash
pnpm test          # 单元 + 契约测试(全离线,零额度)
pnpm test:live     # LIVE_TEST=1 才跑真实账号
pnpm typecheck
pnpm dev           # watch 模式起服务
```

**Live 测试注意**:若 serve 绑定的是非 loopback 地址(如 WSL 网卡 IP),
跑 live 测试时需指明地址:

```bash
WSL_HOST_IP="REPLACE_WITH_WSL_HOST_IP"
OSG_URL="http://${WSL_HOST_IP}:10101" LIVE_TEST=1 pnpm test:live
```
