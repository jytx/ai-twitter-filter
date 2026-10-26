// 推文展示层 DOM 操作：隐藏/恢复内容、加载动画、折叠横幅
// 作为经典脚本先于 content.js 注入（见 manifest 的 content_scripts 顺序），
// 这里的函数在内容脚本的隔离世界中直接供 content.js 调用

function hideChildren(article) {
  for (const child of article.children) {
    if (
      child.classList.contains("ai-filter-banner") ||
      child.classList.contains("ai-filter-loader")
    )
      continue;
    child.style.setProperty("display", "none", "important");
  }
}

function showChildren(article) {
  for (const child of article.children) {
    if (
      child.classList.contains("ai-filter-banner") ||
      child.classList.contains("ai-filter-loader")
    )
      continue;
    child.style.removeProperty("display");
  }
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
  reasonEl.textContent = reason ? ` \u2014 ${reason}` : " \u2014 hidden by AI filter";

  // Show/Hide 双向切换：横幅常驻不消失，展开后按钮变 Hide 可重新折叠，
  // 折叠后按钮变回 Show（纯本地切换，不重新调 AI）
  const btn = banner.querySelector(".ai-filter-banner-show");
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const article = banner.closest("article");
    if (!article) return;
    if (article.classList.contains("ai-filter-hidden")) {
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
