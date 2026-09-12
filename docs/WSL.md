# 在 WSL 中使用 OSG

本指南覆盖两种场景：网关运行在 WSL，以及网关运行在 Windows、客户端运行在 WSL。
先选一种，不要让两个网关进程共用同一份凭证。

## 方案 A：网关运行在 WSL

### 1. 获取代码

在 WSL 的 Linux 文件系统中保存项目，不要把 `/mnt/c` 当成正式工作目录。

```bash
git clone https://github.com/AlexanderWei666/openai-subscription-gateway.git ~/src/openai-subscription-gateway
cd ~/src/openai-subscription-gateway
node --version  # 需要 24 或更高版本
```

运行源码不需要安装依赖或生成 `dist/`。只有开发、类型检查或构建发布产物时才需要
`pnpm install`。

### 2. 登录

```bash
node src/cli/index.ts login
```

浏览器完成授权后，凭证保存在 WSL 的
`~/.openai-subscription-gateway/auth.json`。如果回调页无法打开，先检查 WSL 的
localhost 转发和防火墙，不要手工修改凭证文件。

### 3. 启动

只供 WSL 内客户端使用：

```bash
node src/cli/index.ts serve
```

同时供 Windows 本机客户端使用：

```bash
bash start-serve.sh
```

脚本默认在 WSL 内绑定 `0.0.0.0:10101`，依赖 WSL localhost forwarding 让
Windows 客户端通过 `http://127.0.0.1:10101/v1` 访问。不同 WSL 网络模式、
防火墙或 `.wslconfig` 会影响该转发；绑定 `0.0.0.0` 前应确认宿主网络边界可信。

### 4. 验证

WSL 内：

```bash
curl http://127.0.0.1:10101/health
curl http://127.0.0.1:10101/v1/models
```

Windows PowerShell 内：

```powershell
curl.exe http://127.0.0.1:10101/health
```

## 方案 B：网关运行在 Windows，客户端运行在 WSL

先在 Windows 获取代码并登录，然后运行：

```powershell
.\start-serve.bat
```

脚本会查找 Windows 的 WSL 虚拟网卡地址，并让网关绑定该地址。启动日志会打印
WSL 客户端应使用的 Base URL，例如：

```text
http://<WSL_HOST_IP>:10101/v1
```

如果自动探测失败，在 Windows PowerShell 中查看网卡地址后手工启动：

```powershell
Get-NetIPAddress -AddressFamily IPv4 | Where-Object InterfaceAlias -Like '*WSL*'
$env:OSG_HOST = '<WSL_HOST_IP>'
node src/cli/index.ts serve
```

WSL 内验证：

```bash
curl http://<WSL_HOST_IP>:10101/health
```

WSL 网络重启后地址可能变化；连接失败时重新查看启动日志和网卡地址。

## 网络和代理排查

网关所在环境必须能访问 Codex 上游。只检查连通性时可运行：

```bash
curl -s -o /dev/null -w '%{http_code}\n' --max-time 10 \
  https://chatgpt.com/backend-api/codex/models
```

返回 `401` 说明网络链路已通，只是请求没有凭证。返回 `000` 或超时通常是 DNS、
代理或防火墙问题。Windows 的代理配置不会自动等价地出现在 WSL 中；是否设置代理、
代理地址和端口应以你的网络环境为准。

## 凭证注意事项

- 推荐在实际运行网关的环境里执行 `login`。
- 不要让 Windows 和 WSL 两个网关进程共用或轮流刷新同一份凭证。
- 需要退出时使用 `node src/cli/index.ts logout`，不要手工编辑 `auth.json`。
- WSL / Linux 上 `doctor` 会检查凭证文件的 POSIX 权限。

## 不包含的运维能力

仓库不提供 systemd 服务、开机自启、Windows portproxy 或公网部署方案。这些操作会改变
系统或网络暴露面，应由使用者另行设计和审核。
