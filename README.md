# openai-subscription-gateway

把 ChatGPT / OpenAI Codex 订阅接到本机，提供一个精简的 OpenAI-compatible API。
支持自定义 Base URL 的客户端可以通过它调用 Codex 模型，无需改客户端代码。

> 这是非官方的个人本地网关，依赖 OpenAI Codex 的非公开上游接口。上游权限、模型和协议可能变化；它不是完整 OpenAI API，也不适合部署到公网。

## 快速开始

需要 Node.js 24 或更高版本。项目没有运行时依赖，可以直接运行 TypeScript 源码：

```bash
git clone https://github.com/AlexanderWei666/openai-subscription-gateway.git
cd openai-subscription-gateway
node src/cli/index.ts login
node src/cli/index.ts serve
```

登录会打开浏览器完成 ChatGPT OAuth。凭证保存在
`~/.openai-subscription-gateway/auth.json`，与 Codex CLI 的登录态相互独立。

如果需要编译产物，再安装开发依赖并构建：

```bash
pnpm install
pnpm build
node dist/cli/index.js serve
```

服务默认监听：

```text
http://127.0.0.1:10101
```

先确认服务和模型目录：

```bash
curl http://127.0.0.1:10101/health
curl http://127.0.0.1:10101/v1/models
```

然后发送一条非流式 Responses 请求。模型 ID 请从 `/v1/models` 的实际结果中选择：

```bash
curl http://127.0.0.1:10101/v1/responses \
  -H "content-type: application/json" \
  -d '{"model":"<MODEL_ID>","input":"只回复 OK","stream":false}'
```

## 客户端配置

```text
Base URL: http://127.0.0.1:10101/v1
API Key:  local-placeholder
```

API Key 只是满足客户端必填项的占位值，网关不会校验它。不要把它当成安全认证。

## 支持范围

| 接口或能力 | 支持情况 |
|---|---|
| `GET /v1/models` | 动态模型目录；不硬编码模型名单 |
| `POST /v1/responses` | 流式和非流式 |
| `POST /v1/chat/completions` | 流式和非流式兼容层 |
| reasoning、工具调用、图像输入、usage | 在受支持范围内透传 |
| `service_tier` | 按 Codex wire 约定做最小转换 |

未实现的 OpenAI 平台接口会返回明确的 404。Files、Vector Stores、Batch、
Fine-tuning、Audio、Assistants，以及有状态的 `store:true`、
`previous_response_id` 不在支持范围内。

模型出现在 `/v1/models` 中不代表账号权限永久不变。最终能否调用由上游按当前账号、
模型和请求参数裁决；网关会把上游错误转换成稳定的 OpenAI 风格错误。

## Windows 与 WSL

只在 Windows 本机使用时，保持默认的 `127.0.0.1` 最安全。

如果网关和客户端分处 Windows / WSL，网络地址和启动方式不同。仓库提供：

- `start-serve.bat`：网关运行在 Windows，供 WSL 客户端访问；
- `start-serve.sh`：网关运行在 WSL / Linux。

两个脚本都直接运行 `src/cli/index.ts`，不依赖仓库中不存在的 `dist/`。

完整安装、网络选择和故障排查见 [WSL 使用指南](docs/WSL.md)。

## 常用命令

| 命令 | 用途 |
|---|---|
| `node src/cli/index.ts login` | 登录或重新登录 |
| `node src/cli/index.ts logout` | 撤销并删除本地凭证 |
| `node src/cli/index.ts status` | 查看登录状态 |
| `node src/cli/index.ts serve` | 启动网关 |
| `node src/cli/index.ts models` | 查看模型目录 |
| `node src/cli/index.ts config` | 查看生效配置及来源 |
| `node src/cli/index.ts doctor` | 本地自检，不发起推理 |
| `node src/cli/index.ts upstream-check` | 检查 Codex 版本漂移 |

`doctor --live` 和 `pnpm test:live` 会发起真实请求并消耗少量订阅额度，默认验证流程不会运行它们。

## 配置

常用环境变量：

| 变量 | 默认值 | 用途 |
|---|---|---|
| `OSG_HOST` | `127.0.0.1` | 监听地址 |
| `OSG_PORT` | `10101` | 监听端口 |
| `OSG_HOME` | `~/.openai-subscription-gateway` | 凭证和缓存目录 |
| `OSG_LOG_LEVEL` | `info` | 日志级别 |
| `OSG_UPSTREAM_TIMEOUT_MS` | 项目默认值 | 上游请求超时 |
| `OSG_CODEX_CLIENT_VERSION` | 自动检测后兜底 | 覆盖 Codex client version |

需要知道每个值从哪里来时，运行 `node src/cli/index.ts config`。

## 安全边界

- 默认只监听 loopback；绑定其他地址时会打印警告。
- 非 loopback 暴露没有 API 认证保护，只能用于你信任的本机网络边界。
- POSIX 平台会检查凭证目录和文件权限；Windows ACL 不由本项目管理。
- 网关不读取或修改 `~/.codex/auth.json`。
- 同一个凭证目录不支持多个网关进程并发刷新。

## 文档

不知道该从哪里读时，从 [文档索引](docs/README.md) 开始。

- 使用和边界：[README](README.md)
- WSL 安装与网络：[WSL](docs/WSL.md)
- 开发与代码导览：[DEVELOPMENT](docs/DEVELOPMENT.md)
- 架构与设计取舍：[DESIGN](docs/DESIGN.md)
- Codex 上游契约：[UPSTREAM](docs/UPSTREAM.md)
- 维护和升级流程：[MAINTENANCE](docs/MAINTENANCE.md)
- 独立评审方法：[REVIEWING](docs/REVIEWING.md)

## 开发

```bash
pnpm test
pnpm typecheck
pnpm build
pnpm doc-check
```

`pnpm test` 只运行离线单元和契约测试，不使用订阅额度。参与修改前请阅读
[开发指南](docs/DEVELOPMENT.md)；Agent 还必须遵守 [AGENTS.md](AGENTS.md)。
