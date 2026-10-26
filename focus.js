// 专注模式：隐藏 X 的左右两栏（左侧导航 + 右侧推荐），让中间推文流撑满窗口
//
// 实现要点：
// 1. 宽度放开由 JS 直接写行内样式完成——X 的祖先链有多层宽度/收缩约束，
//    纯 CSS 的 :has() 逐级匹配不可靠，实测无法撑满（详见下方"祖先链"说明）
// 2. 隐藏左右栏仍由 CSS 兜底（html[data-ai-filter-focus="on"] 选择器），
//    即使 JS 定位暂时失败（页面尚未渲染），隐藏效果依然生效
// 3. X 重建 DOM 后行内样式会丢失，用 MutationObserver 监听并重新应用
// 4. 状态写入 chrome.storage.local，刷新与跨标签页均保持

(() => {
  const ATTR = "data-ai-filter-focus";
  const BUTTON_ID = "ai-filter-focus-btn";

  // 专注模式开关状态
  let focusEnabled = false;
  // 悬浮按钮是否已注入页面
  let buttonInjected = false;

  // 需要在专注模式下放开宽度约束的属性
  const WIDTH_PROPS = [
    "max-width",
    "width",
    "flex-grow",
    "flex-shrink",
  ];

  // ---- 定位三栏结构 ----

  // 主栏（推文流）：X 用 data-testid="primaryColumn" 标记，跨版本稳定
  function getPrimaryColumn() {
    return document.querySelector('[data-testid="primaryColumn"]');
  }

  // 三栏容器的直接子元素中，左栏是 header、右栏由 aside 承载。
  // 这里不依赖 X 的原子类名（如 r-18u37iz），只依赖标签语义与 testid
  function getLayoutElements() {
    const primary = getPrimaryColumn();
    if (!primary) return null;

    const main = primary.closest("main");
    if (!main) return null;

    // 左栏：main 的前一个兄弟 header（桌面端三栏布局）
    const layoutRow = main.parentElement;
    const leftHeader = layoutRow
      ? layoutRow.querySelector(":scope > header")
      : null;

    // 右栏：main 内的 aside，其外层包裹容器也需一并隐藏，否则仍会占位
    const rightAside = main.querySelector("aside");
    const rightWrapper = rightAside ? rightAside.parentElement : null;

    return { primary, main, leftHeader, rightAside, rightWrapper };
  }

  // 收集主栏到 main 之前的整条祖先链：
  // X 在这些层级上叠加了 max-width / flex-shrink 等约束，
  // 任意一层未放开，主栏就无法撑满窗口
  function collectAncestorChain(primary, main) {
    const chain = [];
    let el = primary;
    while (el && el !== main.parentElement) {
      chain.push(el);
      el = el.parentElement;
    }
    return chain;
  }

  // ---- 应用与撤销 ----

  // 开启专注模式：隐藏左右栏，并把主栏宽度上限放开
  function applyFocus() {
    const els = getLayoutElements();
    if (!els) return false;

    const { primary, main, leftHeader, rightAside, rightWrapper } = els;

    // 隐藏左栏导航
    if (leftHeader) leftHeader.style.setProperty("display", "none", "important");

    // 隐藏右栏推荐：aside 与其外层容器都隐藏，避免 350px 空位残留
    if (rightAside) rightAside.style.setProperty("display", "none", "important");
    if (rightWrapper) rightWrapper.style.setProperty("display", "none", "important");

    // 整条祖先链放开宽度约束
    collectAncestorChain(primary, main).forEach((node) => {
      WIDTH_PROPS.forEach((prop) => {
        const value = prop === "flex-grow" ? "1" : prop === "flex-shrink" ? "0" : "none";
        node.style.setProperty(prop, prop === "width" ? "100%" : value, "important");
      });
    });

    // main 的 align-items 默认是 flex-start，子元素会按内容宽度收缩；
    // 改回 stretch 后主栏才会真正占满整个宽度
    main.style.setProperty("align-items", "stretch", "important");

    return true;
  }

  // 撤销专注模式：把上面改过的行内样式全部还原
  function revertFocus() {
    const els = getLayoutElements();
    if (!els) return;

    const { primary, main, leftHeader, rightAside, rightWrapper } = els;
    [leftHeader, rightAside, rightWrapper].forEach((el) => {
      if (el) el.style.removeProperty("display");
    });

    collectAncestorChain(primary, main).forEach((node) => {
      WIDTH_PROPS.forEach((prop) => node.style.removeProperty(prop));
      node.style.removeProperty("align-items");
    });
  }

  // ---- 状态同步 ----

  // 把当前状态同步到 <html> 属性，CSS 据此应用隐藏规则
  function syncState() {
    if (focusEnabled) {
      document.documentElement.setAttribute(ATTR, "on");
      applyFocus();
    } else {
      document.documentElement.removeAttribute(ATTR);
      revertFocus();
    }
    updateButton();
  }

  // ---- 悬浮按钮 ----

  // 注入右下角悬浮按钮（幂等，重复调用不会重复插入）
  function injectButton() {
    if (buttonInjected && document.getElementById(BUTTON_ID)) return;
    // body 尚未就绪时无法挂载：等待 DOMContentLoaded 后重试
    if (!document.body) {
      document.addEventListener(
        "DOMContentLoaded",
        () => {
          injectButton();
          updateButton();
        },
        { once: true }
      );
      return;
    }

    const btn = document.createElement("button");
    btn.id = BUTTON_ID;
    btn.className = "ai-filter-focus-button";
    btn.type = "button";
    btn.title = "专注模式：隐藏左右栏";
    btn.setAttribute("aria-label", "切换专注模式");
    btn.innerHTML = `
      <svg viewBox="0 0 24 24" class="ai-filter-focus-icon">
        <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5v-13Zm2.5.5v12h11V6h-11Z"/>
        <path d="M8 9h3v6H8V9Zm5 0h3v6h-3V9Z"/>
      </svg>
    `;
    btn.addEventListener("click", toggleFocus);
    document.body.appendChild(btn);
    buttonInjected = true;
  }

  // 根据当前状态更新按钮外观（图标切换 + 悬停提示）
  function updateButton() {
    const btn = document.getElementById(BUTTON_ID);
    if (!btn) return;
    btn.classList.toggle("ai-filter-focus-active", focusEnabled);
    btn.title = focusEnabled
      ? "退出专注模式：恢复左右栏"
      : "专注模式：隐藏左右栏";
  }

  // 切换专注模式
  function toggleFocus() {
    focusEnabled = !focusEnabled;
    // 写入本地存储：刷新、切换标签页后保持状态
    chrome.storage.local.set({ focusMode: focusEnabled });
    syncState();
  }

  // ---- 初始状态加载 ----

  chrome.storage.local.get("focusMode", (data) => {
    focusEnabled = data.focusMode === true;
    injectButton();
    syncState();
  });

  // ---- 与扩展弹窗同步 ----
  // 弹窗切换专注模式时立即广播到所有 x.com 标签页，无需刷新
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type !== "FOCUS_MODE_UPDATED") return;
    focusEnabled = message.focusMode === true;
    injectButton();
    syncState();
  });

  // 监听本地存储变化：这是最可靠的同步通道。
  // popup 写入 focusMode 后，background 的 storage.onChanged 只处理 sync 区域，
  // local 区域的变化不会转发；由内容脚本自行监听可保证任何打开时机都能生效
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !("focusMode" in changes)) return;
    focusEnabled = changes.focusMode.newValue === true;
    injectButton();
    syncState();
  });

  // ---- DOM 重建后的重新应用 ----
  // X 是 SPA，路由切换与推文加载都会重建三栏容器，
  // 重建后行内样式会丢失，需要重新应用（仅在专注模式开启时）

  const layoutWatcher = new MutationObserver(() => {
    if (!focusEnabled) return;
    const els = getLayoutElements();
    if (!els) return;
    // 仅当左右栏重新可见时重应用，避免每次 DOM 变动都重复写样式
    const { leftHeader, rightAside } = els;
    const needReapply =
      (leftHeader && getComputedStyle(leftHeader).display !== "none") ||
      (rightAside && getComputedStyle(rightAside).display !== "none");
    if (needReapply) applyFocus();
  });

  const startWatcher = () => {
    if (document.body) {
      layoutWatcher.observe(document.body, { childList: true, subtree: true });
    }
  };

  if (document.body) {
    startWatcher();
  } else {
    document.addEventListener("DOMContentLoaded", startWatcher, { once: true });
  }
})();
