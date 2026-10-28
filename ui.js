// 推文 DOM 操作层：内容隐藏/恢复、判定中占位、折叠横幅。
//
// 作为经典脚本先于 content.js 注入（见 manifest 的 content_scripts 顺序），
// 以全局对象 TweetDom 供 content.js 调用。这里只操作 DOM，
// 不涉及状态管理与消息通信。

const TweetDom = (() => {
  // 隐藏推文内容：折叠横幅始终保持可见
  function hideChildren(article) {
    for (const child of article.children) {
      if (isBanner(child)) continue;
      child.style.setProperty("display", "none", "important");
    }
  }

  // 恢复推文内容可见
  function showChildren(article) {
    for (const child of article.children) {
      if (isBanner(child)) continue;
      child.style.removeProperty("display");
    }
  }

  // 折叠横幅是我们插入的，不参与内容的隐藏/恢复
  function isBanner(child) {
    return child.classList.contains("ai-filter-banner");
  }

  // 判定中的标记：只切换标记，内容隐藏与视觉提示都交给 CSS 完成。
  //
  // 为什么判定期间绝不能碰尺寸：
  //   1. 尺寸一旦变化，X 会认为页面仍在加载而启用渐进渲染，
  //      表现为推文分批冒出、需要滚动才继续加载
  //   2. 测量高度（getBoundingClientRect）与改样式交替进行会造成
  //      layout thrashing——每次读布局都强制浏览器同步重排，
  //      连续处理一批推文时主线程被占满，X 的渲染同样被迫分片
  //
  // 判定期间内容必须完全不可见：装插件的意义就是不让未过滤的内容出现，
  // 若只是变淡或加遮罩，用户仍会先读到内容再被折叠，筛选就失去了意义。
  // 具体隐藏方式见 styles.css 的 data-ai-filter-pending 规则：
  // 用 visibility 而非 display，保留布局空间，高度不受影响。
  function markPending(article) {
    article.dataset.aiFilterPending = "true";

    // loading 指示器用绝对定位绘制，需要推文自身是定位祖先。
    // 推文的定位方式由 X 决定（虚拟列表里常是 absolute），不能由样式覆盖，
    // 否则会破坏 X 的布局、让指示器定位错乱。仅在推文是 static 时临时补一个
    // relative，判定结束后立即还原。
    if (getComputedStyle(article).position === "static") {
      article.style.setProperty("position", "relative", "important");
      article.dataset.aiFilterPositionAdded = "true";
    }
  }

  // 判定结束：撤除判定中标记，并还原临时补上的定位方式
  function clearPending(article) {
    delete article.dataset.aiFilterPending;
    if (article.dataset.aiFilterPositionAdded) {
      delete article.dataset.aiFilterPositionAdded;
      article.style.removeProperty("position");
    }
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
