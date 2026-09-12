#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# openai-subscription-gateway launcher (WSL / Linux)
#
# 为什么默认绑 0.0.0.0:
#   让常见 WSL2 NAT + localhost forwarding 配置下的 Windows 客户端可通过
#   http://127.0.0.1:10101 访问。镜像网络、防火墙或自定义 .wslconfig 可能改变结果。
#
# 安全性:0.0.0.0 会监听 WSL 的全部接口。启动前应确认宿主网络边界可信,
#   不要把 localhost forwarding 当成访问控制。
#
# 详见 docs/WSL.md
# ---------------------------------------------------------------------------
set -euo pipefail
cd "$(dirname "$0")"

export OSG_HOST="${OSG_HOST:-0.0.0.0}"
export OSG_PORT="${OSG_PORT:-10101}"

echo "osg listening on http://${OSG_HOST}:${OSG_PORT}/v1"
echo "  WSL 内客户端   : http://127.0.0.1:${OSG_PORT}/v1"
echo "  Windows 侧客户端: http://127.0.0.1:${OSG_PORT}/v1   (经 WSL2 localhost 转发)"

exec node src/cli/index.ts serve
