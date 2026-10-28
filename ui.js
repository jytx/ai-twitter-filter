// 推文 DOM 操作层：内容隐藏/恢复、判定中占位、折叠横幅。
//
// 作为经典脚本先于 content.js 注入（见 manifest 的 content_scripts 顺序），
// 以全局对象 TweetDom 供 content.js 调用。这里只操作 DOM，
// 不涉及状态管理与消息通信。

const TweetDom = (() => {
  // 隐藏推文内容：横幅与加载动画始终保持可见
  function hideChildren(article) {
    for (const child of article.children) {
      if (isOverlay(child)) continue;
      child.style.setProperty("display", "none", "important");
    }
  }

  // 恢复推文内容可见
  function showChildren(article) {
    for (const child of article.children) {
      if (isOverlay(child)) continue;
      child.style.removeProperty("display");
    }
  }

  // 横幅与加载动画是我们插入的覆盖层，不参与内容的隐藏/恢复
  function isOverlay(child) {
    return (
      child.classList.contains("ai-filter-banner") ||
      child.classList.contains("ai-filter-loader")
    );
  }

  function addLoader(article) {
    if (article.querySelector(".ai-filter-loader")) return;
    const loader = document.createElement("div");
    loader.className = "ai-filter-loader";
    loader.innerHTML = `
      <div class="ai-filter-spinner"></div>
      <span>Checking tweet...</span>
    `;
    article.prepend(loader);
  }

  function removeLoader(article) {
    const loader = article.querySelector(".ai-filter-loader");
    if (loader) loader.remove();
  }

  // 判定中的占位处理：隐藏推文内容，但用加载动画占住推文原本的空间。
  //
  // 为什么必须保留高度：推文内容隐藏后 article 只剩加载动画（约 44px），
  // 整条时间线的高度随之塌缩。X 的时间线是虚拟列表，会按当前高度重新
  // 计算可视窗口并补拉更多推文，导致判定期间滚动页面会触发大量无效请求，
  // 而用户实际看到的内容并没有增加。
  //
  // 高度占在加载动画上（min-height）而不是 article 上：加载动画是判定期间
  // article 里唯一可见的子元素，由它撑起高度，article 总高度即与判定前一致；
  // 同时加载动画铺满整块空间，"Checking"提示居中显示，不会出现大片空白。
  function markPending(article) {
    if (article.dataset.aiFilterPending) return;

    // 在隐藏内容之前测量原始高度
    const originalHeight = Math.ceil(article.getBoundingClientRect().height);

    hideChildren(article);
    addLoader(article);

    // 让加载动画撑起原始高度，article 总高度因此与判定前一致
    const loader = article.querySelector(".ai-filter-loader");
    if (loader && originalHeight > 0) {
      loader.style.setProperty("min-height", `${originalHeight}px`, "important");
    }
    article.dataset.aiFilterPending = "true";
  }

  // 判定结束：移除加载动画与高度占位，article 回到自然高度
  function clearPending(article) {
    if (!article.dataset.aiFilterPending) return;
    delete article.dataset.aiFilterPending;
    removeLoader(article);
  }

  // 移除全部横幅与加载动画
  function removeOverlays() {
    document
      .querySelectorAll(".ai-filter-banner, .ai-filter-loader")
      .forEach((el) => el.remove());
  }

  // 恢复全部推文内容可见：清除隐藏标记与判定中状态
  function showAll() {
    document
      .querySelectorAll(".ai-filter-hidden, [data-ai-filter-processed]")
      .forEach((article) => {
        article.classList.remove("ai-filter-hidden");
        delete article.dataset.aiFilterPending;
        showChildren(article);
      });
  }

  // 创建折叠横幅：第一行为图标 + 作者 + 隐藏原因（整行宽度），
  // 第二行为 Show/Hide 切换按钮（靠右），上下布局避免理由文字被按钮挤压折行
  function createBanner(author, reason) {
    const banner = document.createElement("div");
    banner.className = "ai-filter-banner";
    banner.innerHTML = `
      <div class="ai-filter-banner-head">
        <svg class="ai-filter-banner-icon" viewBox="0 0 24 24">
          <path d="M3.72 3.72a.75.75 0 0 1 1.06 0L12 10.94l7.22-7.22a.75.75 0 1 1 1.06 1.06L13.06 12l7.22 7.22a.75.75 0 1 1-1.06 1.06L12 13.06l-7.22 7.22a.75.75 0 0 1-1.06-1.06L10.94 12 3.72 4.78a.75.75 0 0 1 0-1.06Z"/>
        </svg>
        <span class="ai-filter-banner-text">
          <span class="ai-filter-banner-author"></span>
          <span class="ai-filter-banner-reason"></span>
        </span>
      </div>
      <button class="ai-filter-banner-show">Show</button>
    `;
    banner.querySelector(".ai-filter-banner-author").textContent = author;
    const reasonEl = banner.querySelector(".ai-filter-banner-reason");
    reasonEl.textContent = reason ? ` — ${reason}` : " — hidden by AI filter";

    // Show/Hide 双向切换：横幅常驻不消失，展开后按钮变 Hide 可重新折叠，
    // 折叠后按钮变回 Show（纯本地切换，不重新调 AI）
    const btn = banner.querySelector(".ai-filter-banner-show");
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const article = banner.closest("article");
      if (!article) return;
      // 以按钮文字为状态源：横幅是我们创建的节点，不受 X 重渲染覆写影响；
      // article 上的标记 class 仅作样式钩子同步维护
      if (btn.textContent === "Show") {
        article.classList.remove("ai-filter-hidden");
        showChildren(article);
        btn.textContent = "Hide";
      } else {
        article.classList.add("ai-filter-hidden");
        hideChildren(article);
        btn.textContent = "Show";
      }
    });
    return banner;
  }

  // 隐藏推文并插入折叠横幅
  function applyHidden(article, reason, author) {
    article.classList.add("ai-filter-hidden");
    hideChildren(article);
    if (!article.querySelector(".ai-filter-banner")) {
      article.prepend(createBanner(author, reason));
    }
  }

  return {
    hideChildren,
    showChildren,
    markPending,
    clearPending,
    removeOverlays,
    showAll,
    applyHidden,
  };
})();
