#!/bin/bash
# 真实环境诊断入口：连到用户正在使用的 Chrome，检查扩展的加载状态与运行行为。
#
# 排查"改了代码没生效"类问题时先跑这个脚本：
#   1. 扩展实际加载的版本与磁盘路径是否一致
#   2. 内容脚本跑的是不是最新构建（build 标记）
#   3. 时间线上的判定状态（转圈数、判定中推文高度）
#
# 前提：Chrome 需以 --remote-debugging-port=9222 启动
# 用法：bash scripts/inspect-extension.sh [debugPort]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${1:-9222}"
LOG_DIR="$ROOT/logs"
LOG_FILE="$LOG_DIR/inspect-extension.log"

mkdir -p "$LOG_DIR"

if ! curl -s --max-time 3 "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1; then
  echo "端口 $PORT 无响应。若 Chrome 136+ 禁用了 HTTP 发现端点属正常，" | tee -a "$LOG_FILE"
  echo "脚本将通过 WebSocket 直连，请确认 Chrome 已开启远程调试。" | tee -a "$LOG_FILE"
fi

{
  echo "===== 扩展安装信息 ====="
  node "$ROOT/tests/find-ext-path.mjs" "$PORT"

  echo ""
  echo "===== 实际运行的代码版本 ====="
  node "$ROOT/tests/inspect-ext-version.mjs" "$PORT"

  echo ""
  echo "===== 页面隔离世界内部状态 ====="
  node "$ROOT/tests/verify-live.mjs" "$PORT"
} 2>&1 | tee -a "$LOG_FILE"
