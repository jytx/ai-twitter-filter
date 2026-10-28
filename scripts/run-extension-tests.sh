#!/bin/bash
# 扩展行为测试脚本：用无头 Chrome 加载真实扩展代码，
# 在模拟的 X 时间线页面上验证判定、滚动与请求节流行为。
#
# 两部分：
#   1. 行为用例（tests/extension-tests.mjs）—— 校验修复后的实现
#   2. 修复前后对比（tests/compare-legacy.mjs）—— 用 git HEAD 的旧实现做对照，
#      确认旧实现确实会压缩推文高度、放大观察带内的推文数量
#
# 用法：bash scripts/run-extension-tests.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="$ROOT/logs"
LOG_FILE="$LOG_DIR/extension-test.log"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
PORT="${CHROME_DEBUG_PORT:-9333}"
PROFILE_DIR="$(mktemp -d /tmp/ai-tf-test-profile.XXXXXX)"

mkdir -p "$LOG_DIR"

cleanup() {
  if [ -n "${CHROME_PID:-}" ]; then
    kill "$CHROME_PID" 2>/dev/null || true
    wait "$CHROME_PID" 2>/dev/null || true
  fi
  # Chrome 退出时可能仍在写 profile，清理失败不阻断脚本
  rm -rf "$PROFILE_DIR" 2>/dev/null || true
}
trap cleanup EXIT

# ---- 启动带调试端口的无头 Chrome ----
"$CHROME" \
  --headless=new \
  --remote-debugging-port="$PORT" \
  --user-data-dir="$PROFILE_DIR" \
  --no-first-run \
  --no-default-browser-check \
  --disable-gpu \
  about:blank >"$LOG_FILE" 2>&1 &
CHROME_PID=$!

# 等待调试端口就绪
for _ in $(seq 1 50); do
  if curl -s --max-time 1 "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1; then
    break
  fi
  sleep 0.2
done

if ! curl -s --max-time 2 "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1; then
  echo "Chrome 调试端口未就绪，日志：$LOG_FILE" | tee -a "$LOG_FILE"
  exit 1
fi

STATUS=0

# ---- 1. 行为用例 ----
echo "########## 行为用例 ##########" | tee -a "$LOG_FILE"
if node "$ROOT/tests/extension-tests.mjs" "$PORT" "$ROOT" 2>&1 | tee -a "$LOG_FILE"; then
  echo "行为用例通过" | tee -a "$LOG_FILE"
else
  STATUS=1
  echo "行为用例失败" | tee -a "$LOG_FILE"
fi

# ---- 2. 修复前后对比 ----
echo "" | tee -a "$LOG_FILE"
echo "########## 修复前后对比 ##########" | tee -a "$LOG_FILE"
if node "$ROOT/tests/compare-legacy.mjs" "$PORT" "$ROOT" 2>&1 | tee -a "$LOG_FILE"; then
  echo "修复前后对比通过" | tee -a "$LOG_FILE"
else
  STATUS=1
  echo "修复前后对比失败" | tee -a "$LOG_FILE"
fi

exit "$STATUS"
