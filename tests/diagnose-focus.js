// 专注模式诊断脚本
// 用法：在 x.com 页面按 F12 打开控制台，粘贴执行
// 输出扩展注入状态与专注模式各环节的实际值
(() => {
  const line = (k, v) => console.log(`  ${k}: ${v}`);

  console.log("%c=== AI Twitter Filter 专注模式诊断 ===", "color:#1d9bf0;font-weight:bold");

  const btn = document.getElementById("ai-filter-focus-btn");
  const attr = document.documentElement.getAttribute("data-ai-filter-focus");

  console.log("\n[1] content script 注入状态");
  line("focus.js 悬浮按钮", btn ? "已注入" : "未注入（content script 未运行）");
  line("content.js 横幅元素", document.querySelectorAll(".ai-filter-banner").length + " 个");
  line("content.js 加载动画", document.querySelectorAll(".ai-filter-loader").length + " 个");
  line("已判定的推文", document.querySelectorAll("[data-ai-filter-processed]").length + " 条");

  console.log("\n[2] 专注模式状态");
  line("html[data-ai-filter-focus]", attr === null ? "未设置（未开启）" : attr);

  console.log("\n[3] 三栏结构实测");
  const primary = document.querySelector('[data-testid="primaryColumn"]');
  if (!primary) {
    line("primaryColumn", "未找到（页面可能未加载完成或不在时间线页）");
  } else {
    const main = primary.closest("main");
    const header = main.parentElement.querySelector(":scope > header");
    const aside = main.querySelector("aside");
    const r = (el) => (el ? Math.round(el.getBoundingClientRect().width) + "px" : "null");
    line("左栏 header 宽度", r(header));
    line("右栏 aside 宽度", r(aside));
    line("主栏宽度", Math.round(primary.getBoundingClientRect().width) + "px");
    line("主栏 max-width", getComputedStyle(primary).maxWidth);
    line("main align-items", getComputedStyle(main).alignItems);
  }

  console.log("\n[4] 扩展存储（需扩展 ID 权限，失败属正常）");
  try {
    if (typeof chrome !== "undefined" && chrome.storage) {
      chrome.storage.local.get("focusMode", (d) => {
        line("storage.local.focusMode", String(d.focusMode));
        line("storage 读取", "成功");
      });
    } else {
      line("chrome.storage", "页面上下文不可访问（正常，需在扩展 popup 内查看）");
    }
  } catch (e) {
    line("storage 读取异常", e.message);
  }

  console.log("\n[5] 结论指引");
  if (!btn) {
    console.log(
      "  → 悬浮按钮不存在，说明 focus.js 没有注入。\n" +
        "    请在 chrome://extensions 确认扩展已启用并点刷新图标，然后【刷新 x.com 页面】。\n" +
        "    注意：扩展重载后，已打开的页面里的旧 content script 会被销毁，必须刷新页面。"
    );
  } else if (attr === null) {
    console.log(
      "  → 按钮已注入但专注模式未开启。\n" +
        "    请打开扩展 popup 勾选 Focus mode；若勾选无反应，\n" +
        "    说明 popup 与页面之间的状态同步链路有问题，请告知我。"
    );
  } else {
    console.log(
      "  → 专注模式已开启。若左右栏仍在显示，说明 CSS 隐藏规则未命中，\n" +
        "    可能是 X 更新了 DOM 结构，请把上面的实测数据发给我。"
    );
  }
})();
