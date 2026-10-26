#!/bin/bash
# 扩展打包脚本：将商店/本地试用所需的扩展文件打成 ZIP
# 产物：dist/ai-twitter-filter.zip，日志输出到 logs/pack-extension.log
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="$ROOT/logs"
LOG_FILE="$LOG_DIR/pack-extension.log"
OUT_DIR="$ROOT/dist"
OUT="$OUT_DIR/ai-twitter-filter.zip"

mkdir -p "$LOG_DIR" "$OUT_DIR"

# 扩展所需文件清单（不含 website/、announcement-video/ 等非扩展内容）
FILES=(
  manifest.json
  background.js
  content.js
  ui.js
  providers.js
  popup.html
  popup.js
  popup.css
  styles.css
  icons
)

# 打包前先检查清单内文件齐全
for f in "${FILES[@]}"; do
  if [ ! -e "$ROOT/$f" ]; then
    echo "缺少文件: $f" | tee -a "$LOG_FILE"
    exit 1
  fi
done

# 清理上次产物后重新打包（zip 追加模式会残留旧文件，故先删）
if [ -f "$OUT" ]; then
  rm "$OUT"
fi

cd "$ROOT"
zip -r "$OUT" "${FILES[@]}" -x '*.DS_Store' > "$LOG_FILE" 2>&1

unzip -l "$OUT" | tee -a "$LOG_FILE"
echo "打包完成: $OUT"
