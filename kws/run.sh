#!/usr/bin/env bash
# Linux 服务器启动「小云小云」唤醒服务（FunASR cFSMN KWS）。
# 需先装 python3.9 + 依赖：pip install -r kws/requirements.txt
# 用法：bash kws/run.sh          （前台）
#       bash kws/run.sh --daemon （后台 nohup，日志在 kws/server.log）
set -euo pipefail
cd "$(dirname "$0")/.."

PYTHON=${PYTHON:-python3}
HOST=${KWS_HOST:-127.0.0.1}
PORT=${KWS_PORT:-8901}

if [ "${1:-}" = "--daemon" ]; then
  nohup "$PYTHON" kws/server.py > kws/server.log 2>&1 &
  echo "KWS 唤醒服务已后台启动 (pid $!)，日志 kws/server.log，端口 $PORT"
  exit 0
fi

"$PYTHON" kws/server.py
