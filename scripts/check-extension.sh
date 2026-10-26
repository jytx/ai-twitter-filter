#!/bin/bash
# 扩展静态检查脚本：对核心 JS 文件做语法检查（node --check）
# background.js / popup.js / providers.js 为 ES module，通过 stdin + input-type 检查
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

check_module() {
  node --check --input-type=module < "$1"
}

check_module background.js
check_module popup.js
check_module providers.js
check_module focus-toggle.js
check_module test-connection.js
node --check content.js
node --check ui.js
node --check focus.js

# 逻辑单元测试：验证专注模式的状态同步与样式应用
node tests/focus.test.mjs

# 模块完整性检查：验证 popup 拆分后的导入导出与元素对应关系
node tests/popup-modules.test.mjs

echo "All extension scripts passed syntax check."
