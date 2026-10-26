#!/bin/bash
# 官网构建脚本：安装依赖 → 拷贝素材 → Astro 构建
# 日志统一输出到项目根目录 logs/build-website.log
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="$ROOT/logs"
LOG_FILE="$LOG_DIR/build-website.log"

mkdir -p "$LOG_DIR"
cd "$ROOT/website"

{
  echo "==== build-website $(date '+%Y-%m-%d %H:%M:%S') ===="

  # 依赖未安装时先安装
  if [ ! -d node_modules ]; then
    echo "---- npm install ----"
    npm install
  fi

  echo "---- copy assets ----"
  npm run copy-assets

  echo "---- astro build ----"
  npm run build

  echo "==== done ===="
} > "$LOG_FILE" 2>&1

# 展示日志尾部，确认构建结果
tail -n 25 "$LOG_FILE"
