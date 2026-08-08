#!/usr/bin/env bash
# 呼吸森林 V2 一键启动：DNS 健康检查 + 本地后端 + cloudflared 隧道 + 自动同步隧道地址到前端
#
# 用法：
#   bash dev-up.sh          # 完整启动（后端 + 隧道 + 地址同步）
#   bash dev-up.sh --no-sync  # 只起后端和隧道，不自动改 index.html（手动填地址）
#
# 依赖：
#   - cloudflared 已安装（C:\Program Files (x86)\cloudflared\cloudflared.exe）
#   - 后端依赖已装（backend/node_modules）
#   - git 仓库已就绪（会提示 push）

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$ROOT/backend"
FRONTEND_HTML="$ROOT/frontend/index.html"
FRONTEND_404="$ROOT/frontend/404.html"
CLOUDFLARED="/c/Program Files (x86)/cloudflared/cloudflared.exe"
BACKEND_LOG="$ROOT/.tmp/backend.log"
TUNNEL_LOG="$ROOT/.tmp/tunnel.log"
SYNC="yes"

[[ "${1:-}" == "--no-sync" ]] && SYNC="no"

mkdir -p "$ROOT/.tmp"

echo "==> [1/6] 检查依赖"
if [[ ! -f "$CLOUDFLARED" ]]; then
  echo "错误：cloudflared 未安装，请先执行 winget install --id Cloudflare.cloudflared -e"
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "错误：node 未安装"
  exit 1
fi
# 后端是零依赖纯 Node 模块（无 node_modules），只需确认 node 版本
NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
if [[ "$NODE_MAJOR" -lt 20 ]]; then
  echo "错误：后端需要 Node >=20，当前 $NODE_MAJOR"
  exit 1
fi

echo "==> [2/6] DNS 健康检查（能否解析 *.trycloudflare.com）"
# 运营商 DNS 偶发屏蔽/解析失败 *.trycloudflare.com（返回 NXDOMAIN 或超时），
# 而 cloudflared 走自己的连接不受影响，导致隧道地址本机连不上。
# 用 trycloudflare.com 本域探测（Cloudflare 将其解析到 104.16.x）：
# 本域都查不到时，具体隧道子域必然更查不到。随机子域不可用（Cloudflare 只对已建隧道建 DNS 记录）。
PROBE_DOMAIN="trycloudflare.com"
if node -e "
  const dns = require('dns');
  const timer = setTimeout(() => process.exit(1), 6000);
  dns.lookup('$PROBE_DOMAIN', { all: true }, (e) => {
    clearTimeout(timer);
    process.exit(e ? 1 : 0);
  });
" >/dev/null 2>&1; then
  echo "    系统 DNS 可解析 trycloudflare.com ✓"
else
  echo "    ⚠️ 系统 DNS 解析 trycloudflare.com 失败"
  if nslookup -timeout=3 "$PROBE_DOMAIN" 1.1.1.1 2>/dev/null | grep -qE '104\.16\.|2606:4700::6810'; then
    echo "    → 公共 DNS (1.1.1.1) 可解析，确认是本机/运营商 DNS 问题"
    ACTIVE_IFACE=$(powershell -NoProfile -Command "(Get-NetRoute -DestinationPrefix '0.0.0.0/0' | Sort-Object RouteMetric | Select-Object -First 1).InterfaceAlias" 2>/dev/null | tr -d '\r\n') || true
    [[ -z "$ACTIVE_IFACE" ]] && ACTIVE_IFACE="你的网卡名"
    echo "    → 修复命令（需管理员权限，复制执行）："
    echo "      powershell -NoProfile -Command \"Set-DnsClientServerAddress -InterfaceAlias '$ACTIVE_IFACE' -ServerAddresses ('1.1.1.1','8.8.8.8'); Set-DnsClientServerAddress -InterfaceAlias '$ACTIVE_IFACE' -ServerAddresses ('2606:4700:4700::1111','2001:4860:4860::8888')\""
    echo "    → 改完执行 ipconfig /flushdns 清 DNS 缓存，再重跑本脚本"
  else
    echo "    → 公共 DNS 也无法解析，可能是网络未连接，请检查网络后重试"
  fi
  echo "    （继续启动；若下面链路验证仍失败再排查）"
fi

echo "==> [3/6] 启动本地后端 (0.0.0.0:8787, wildcard CORS)"
# 先清理可能残留的旧后端进程（占用 8787）——只匹配 LISTENING，避免 TIME_WAIT 误判
if netstat -ano 2>/dev/null | grep -E ":8787.*LISTENING" | grep -q .; then
  echo "    检测到 8787 已被占用，先停旧实例..."
  PID=$(netstat -ano 2>/dev/null | grep -E ":8787.*LISTENING" | awk '{print $NF}' | head -1 || true)
  [[ -n "$PID" ]] && taskkill //PID "$PID" //F >/dev/null 2>&1 || true
  sleep 1
fi
# 后台起后端，日志写入 .tmp/backend.log
cd "$BACKEND_DIR"
HOST=0.0.0.0 ALLOW_ORIGINS_WILDCARD=1 nohup node src/server.js >"$BACKEND_LOG" 2>&1 &
BACKEND_PID=$!
cd "$ROOT"
echo "    后端 PID=$BACKEND_PID，日志: .tmp/backend.log"
# 等后端就绪
for i in $(seq 1 20); do
  if curl -s -m 2 "http://127.0.0.1:8787/v1/health" 2>/dev/null | grep -q '"status":"ok"'; then
    echo "    后端就绪 ✓"
    break
  fi
  sleep 1
  [[ $i -eq 20 ]] && { echo "错误：后端 20s 未就绪，看日志 $BACKEND_LOG"; exit 1; }
done

echo "==> [4/6] 启动 cloudflared 隧道"
# 清理旧隧道进程（Windows 下 pkill 杀不干净，用 taskkill 按镜像名全停）
taskkill //IM cloudflared.exe //F >/dev/null 2>&1 || true
sleep 2
nohup "$CLOUDFLARED" tunnel --url http://127.0.0.1:8787 >"$TUNNEL_LOG" 2>&1 &
TUNNEL_PID=$!
echo "    隧道 PID=$TUNNEL_PID，日志: .tmp/tunnel.log"
# 等隧道地址出现（最多 30s）
TUNNEL_URL=""
for i in $(seq 1 30); do
  TUNNEL_URL=$(grep -oE "https://[a-z0-9-]+\.trycloudflare\.com" "$TUNNEL_LOG" 2>/dev/null | head -1 || true)
  [[ -n "$TUNNEL_URL" ]] && break
  sleep 1
done
if [[ -z "$TUNNEL_URL" ]]; then
  echo "错误：隧道 30s 未获取到地址，看日志 $TUNNEL_LOG"
  exit 1
fi
echo "    隧道地址: $TUNNEL_URL"

echo "==> [5/6] 验证隧道 → 后端链路"
HEALTH=""
for i in $(seq 1 10); do
  # 强制 --http1.1：本机 Git Bash curl 对隧道 IPv6/HTTP2 偶发连不上，HTTP/1.x 稳定
  # --ssl-no-revoke：Windows schannel 在线检查 CRL 时若 DNS/网络被干扰会报 CRYPT_E_REVOCATION_OFFLINE，跳过吊销检查
  HEALTH=$(curl --http1.1 -s -m 10 --ssl-no-revoke "$TUNNEL_URL/v1/health" 2>&1 || true)
  [[ "$HEALTH" == *'"status":"ok"'* ]] && break
  sleep 2
done
if echo "$HEALTH" | grep -q '"status":"ok"'; then
  echo "    隧道链路通 ✓ (health: $HEALTH)"
else
  echo "警告：隧道链路未通，health=$HEALTH（检查隧道日志 .tmp/tunnel.log）"
fi

if [[ "$SYNC" == "yes" ]]; then
  echo "==> [6/6] 同步隧道地址到前端 index.html + 404.html"
  # 用 sed 把 __API_BASE__ 行替换成新地址（仅非 localhost 分支里的那行）
  sed -i "s|window\.__API_BASE__ = '[^']*'|window.__API_BASE__ = '$TUNNEL_URL/v1'|" "$FRONTEND_HTML" "$FRONTEND_404"
  echo "    已更新 index.html 和 404.html"
  echo ""
  echo "============================================================"
  echo "  ✅ 启动完成！"
  echo "  隧道地址: $TUNNEL_URL"
  echo "  后端:     http://127.0.0.1:8787 (本地)"
  echo ""
  echo "  ⚠️ 下一步（重要）：把地址变更推送到 GitHub 让手机更新"
  echo "     cd $ROOT && git add frontend/index.html frontend/404.html && git commit -m \"chore: update tunnel\" && git push"
  echo "============================================================"
else
  echo "==> [6/6] 已跳过地址同步 (--no-sync)"
  echo "  隧道地址: $TUNNEL_URL（手动填到 index.html 的 __API_BASE__）"
fi

echo ""
echo "后台进程：后端 PID=$BACKEND_PID，隧道 PID=$TUNNEL_PID"
echo "日志：$BACKEND_LOG / $TUNNEL_LOG"
echo "停止：taskkill //PID $BACKEND_PID //F 和 taskkill //PID $TUNNEL_PID //F（或重启脚本会先清理）"
