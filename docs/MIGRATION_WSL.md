# 在 WSL 中运行 OSG(手工迁移清单)

> 前提事实(已核实):
> - `package.json` **无 `dependencies`**(零运行时依赖),源码只 import `node:` 内置模块 → **不需要 `pnpm install`**
> - `engines.node >= 24.0.0`
> - `dist/` 已构建,直接 `node dist/cli/index.js <cmd>` 即可
>
> 本清单未在 WSL 中实测过(当前验证环境未提供 `wsl.exe`),凡涉及 WSL 实际行为的
> 环节都给出了**验证命令**,请以命令输出为准。

---

## 0. 前提:Node ≥ 24

```bash
node -v          # 需要 v24.x 或更高
```

没有的话(任选其一):

```bash
# 方案 A:nvm
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
exec $SHELL -l && nvm install 24

# 方案 B:NodeSource
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash - && sudo apt-get install -y nodejs
```

## 1. 获取代码(两种方式)

### 方式 A:从现有目录复制(带 `dist/`,开箱即用)

跨文件系统(`/mnt/c`)的 I/O 慢,权限语义也不同。复制到 WSL 家目录:

```bash
mkdir -p ~/src
cp -r /mnt/c/path/to/openai-subscription-gateway ~/src/
cd ~/src/openai-subscription-gateway
rm -rf node_modules          # 用不上(零运行时依赖),删掉省空间
```

### 方式 B:从 GitHub clone

`dist/` 是构建产物、**不入库**,clone 后需要补一步——二选一:

```bash
git clone <你的私有仓库> ~/src/openai-subscription-gateway
cd ~/src/openai-subscription-gateway

# B1) 零安装:直接用 Node 原生 TS 支持跑源码(Node ≥ 24)
node src/cli/index.ts doctor

# B2) 或走传统构建
pnpm install && pnpm build      # 之后用 node dist/cli/index.js
```

> WSL 里若用方式 B,注意 `start-serve.sh` 里执行的是 `dist/cli/index.js`;
> 走 B1 的话直接 `node src/cli/index.ts serve` 即可(或 `pnpm install && pnpm build` 后用脚本)。

验证:

```bash
node dist/cli/index.js doctor        # 或 node src/cli/index.ts doctor
```

## 2. 网络连通性(最关键的一步)

OSG 需要访问 `chatgpt.com`。**WSL 有独立网络栈,默认不走 Windows 的代理**——
如果 Windows 侧靠代理(如 fake-ip 分流)才能通,那么 WSL 里会连不上。

```bash
curl -s -o /dev/null -w "%{http_code}\n" --max-time 10 \
  https://chatgpt.com/backend-api/codex/models
```

- 输出 `401` → 网络通(401 只是没带 token),继续下一步;
- 输出 `000` / 超时 → WSL 不通,需要给它配代理:

```bash
# 取 Windows 宿主 IP 与你的代理端口(Clash 常见 7890)
HOST_IP=$(ip route show default | awk '{print $3}')
export https_proxy=http://$HOST_IP:7890
export http_proxy=http://$HOST_IP:7890
# 再验证一次上面的 curl
```

> 代理端口以你本机软件为准;若代理只监听 Windows 的 127.0.0.1,需要在代理软件里
> 开启"允许局域网连接"(Allow LAN),否则 WSL 连不到。

## 3. 凭证(二选一,**不要两边同时跑**)

### 方案 A:在 WSL 里重新登录(推荐)

```bash
node dist/cli/index.js login
```

浏览器回调到 `localhost:1455`。WSL2 对 Windows → WSL 的 localhost 有自动转发,
通常能直接完成;若浏览器打不开回调页,改用方案 B。

### 方案 B:复制 Windows 侧已有凭证

```bash
mkdir -p ~/.openai-subscription-gateway
cp /mnt/c/path/to/.openai-subscription-gateway/auth.json ~/.openai-subscription-gateway/
chmod 700 ~/.openai-subscription-gateway
chmod 600 ~/.openai-subscription-gateway/auth.json    # POSIX 下 doctor 会校验 0600
```

### ⚠️ 重要:同一份订阅不要两边同时刷新

OAuth 的 `refresh_token` 会**轮换**:一方刷新成功后,另一方手上的旧
refresh_token 即失效。因此:

- 同一时间只保留一处运行(Windows 侧 `osg logout` 或停掉其服务);
- 复制凭证后,建议在 Windows 侧执行 `node dist/cli/index.js logout`
  (只删本 gateway 的凭证,不影响 Codex CLI)。

## 4. 自检与启动

```bash
node dist/cli/index.js doctor      # POSIX 平台会检查凭证 0600(WSL 不是 Windows 分支)
./start-serve.sh                   # 绑 0.0.0.0(见下),或直接 node dist/cli/index.js serve
```

### 监听地址怎么选(重要)

WSL2 的 **localhost 自动转发只穿透监听在 `0.0.0.0` 的端口**
(来源:微软 WSL 互操作文档)。因此:

| WSL 侧绑定 | Windows 侧能否用 `127.0.0.1:10101` 访问 | 说明 |
|---|---|---|
| `0.0.0.0`(推荐) | **能** ✓ | WSL 内、Windows 侧**都用 `127.0.0.1`**,IP 变化不影响任何配置 |
| `127.0.0.1` | 不能 ✗ | Windows 侧必须走 `netsh portproxy` 打洞或填 WSL IP |
| WSL 具体 IP | 不能 ✗ | 同上,且该 IP 重启会变 |

安全说明:**WSL2 是 NAT,局域网设备访问不到 WSL 内部服务**(除非主动 `netsh portproxy`),
所以 WSL 里绑 `0.0.0.0` 与"在 Windows 侧绑 `0.0.0.0`"的暴露面不同——前者仅本机可达。

客户端配置(两侧一致):

```text
Base URL: http://127.0.0.1:10101/v1
API Key:  local-placeholder
```

## 5. 时钟(容易被忽略)

WSL2 长时间挂起/休眠后系统时钟可能漂移,会导致 token 时间校验异常:

```bash
date -u                                    # 与真实 UTC 对比
sudo hwclock -s 2>/dev/null || sudo ntpdate pool.ntp.org   # 需要时校正
```

## 6. Windows 侧访问(由上一步的 0.0.0.0 绑定直接获得)

无需额外配置:WSL 里跑 `./start-serve.sh` 后,Windows 侧任何客户端直接填
`http://127.0.0.1:10101/v1/...` 即可。

验证(在 **Windows** 侧执行):

```powershell
curl.exe -s http://127.0.0.1:10101/health     # 期望 {"status":"ok",...}
```

> 若此处不通:先确认 WSL 侧绑定的是 `0.0.0.0`(而非 `127.0.0.1`);
> 再检查 `.wslconfig` 是否关掉了 localhost 转发(`localhostForwarding=false`)。

## 7. 不做的部分

- 不装 systemd service / 不开机自启(v0.1.x 未提供,需求也未确认);
- 不在 Windows 与 WSL 同时运行(凭证轮换会互相踢掉);
- 不从 Windows 侧远程管理 WSL 内的进程。
