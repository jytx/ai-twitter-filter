#!/bin/bash
# 版本号升级脚本：每次功能改动完成后执行一次，同步更新三处版本标识。
#
#   manifest.json 的 version    —— 扩展版本号（Chrome 扩展页显示的就是它）
#   content.js 的 build 标记    —— 控制台日志，用于确认内容脚本已更新
#   popup 标题下的版本号        —— 由 popup.js 读取 manifest 自动显示
#
# 未打包扩展必须手动在 chrome://extensions 点刷新才会生效，
# 版本号是用户确认"代码确实更新了"的唯一依据，因此每次功能改动都要执行本脚本。
#
# 用法：bash scripts/bump-version.sh [patch|minor|major]
#   patch  1.3.1 → 1.3.2   缺陷修复、样式调整（默认）
#   minor  1.3.1 → 1.4.0   新功能
#   major  1.3.1 → 2.0.0   不兼容的大改动
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

LEVEL="${1:-patch}"

case "$LEVEL" in
  patch|minor|major) ;;
  *)
    echo "用法: bash scripts/bump-version.sh [patch|minor|major]" >&2
    exit 1
    ;;
esac

CURRENT="$(node -p "require('./manifest.json').version")"

if ! [[ "$CURRENT" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)$ ]]; then
  echo "当前版本号格式无法解析: $CURRENT" >&2
  exit 1
fi

MAJOR="${BASH_REMATCH[1]}"
MINOR="${BASH_REMATCH[2]}"
PATCH="${BASH_REMATCH[3]}"

case "$LEVEL" in
  patch) PATCH=$((PATCH + 1)) ;;
  minor) MINOR=$((MINOR + 1)); PATCH=0 ;;
  major) MAJOR=$((MAJOR + 1)); MINOR=0; PATCH=0 ;;
esac

NEW="$MAJOR.$MINOR.$PATCH"

# 同步 manifest.json 的 version
# 只替换 version 那一行，不重写整个 JSON：否则数组会被展开成多行，diff 变乱
if ! grep -q '"version":' manifest.json; then
  echo "manifest.json 中未找到 version 字段" >&2
  exit 1
fi
sed -i '' -E "s/(\"version\":[[:space:]]*)\"[0-9]+\.[0-9]+\.[0-9]+\"/\1\"$NEW\"/" manifest.json

# 同步 content.js 的构建标记
if ! grep -q "build [0-9]" content.js; then
  echo "content.js 中未找到构建标记，请手动检查" >&2
  exit 1
fi
sed -i '' -E "s/build [0-9]+\.[0-9]+\.[0-9]+/build $NEW/" content.js

echo "版本号已更新: $CURRENT → $NEW"
echo "  manifest.json version = $NEW"
echo "  content.js build 标记 = build $NEW"
echo ""
echo "提醒：扩展为未打包安装，需在 chrome://extensions 点击刷新图标才会生效；"
echo "      之后打开 popup 确认标题下方的版本号已更新。"
