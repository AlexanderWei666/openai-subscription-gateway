#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# openai-subscription-gateway launcher (WSL / Linux)
#
# 为什么默认绑 0.0.0.0:
#   WSL2 的 localhost 自动转发**只穿透监听在 0.0.0.0 的端口**。
#   若绑 127.0.0.1 或 WSL 具体 IP,Windows 侧访问 http://localhost:10101 会被拒。
#   绑 0.0.0.0 后:WSL 内用 127.0.0.1、Windows 侧也用 127.0.0.1,IP 变化不影响任何配置。
#
# 安全性:WSL2 是 NAT,局域网设备访问不到 WSL 内部服务(除非主动 netsh portproxy),
#   所以这里的 0.0.0.0 与"在 Windows 侧绑 0.0.0.0"风险不同,暴露面仅限本机。
#
# 详见 docs/MIGRATION_WSL.md
# ---------------------------------------------------------------------------
set -euo pipefail
cd "$(dirname "$0")"

export OSG_HOST="${OSG_HOST:-0.0.0.0}"
export OSG_PORT="${OSG_PORT:-10101}"

echo "osg listening on http://${OSG_HOST}:${OSG_PORT}/v1"
echo "  WSL 内客户端   : http://127.0.0.1:${OSG_PORT}/v1"
echo "  Windows 侧客户端: http://127.0.0.1:${OSG_PORT}/v1   (经 WSL2 localhost 转发)"

exec node dist/cli/index.js serve
