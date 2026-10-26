(() => {
  let enabled = true;
  // 是否对评论（回复推文）也做 AI 验证；默认关闭，时间线上的回复直接放行
  let filterReplies = false;
  let debounceTimer = null;
  const pendingTweets = new Map(); // hash -> { element, text }
  const processedHashes = new Map(); // hash -> { hide: boolean, reason: string }

  // Simple string hash
  function hashText(text) {
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      const char = text.charCodeAt(i);
      hash = ((hash << 5) - hash + char) | 0;
    }
    return hash.toString(36);
  }

  function extractTweetText(article) {
    const textEl = article.querySelector('div[data-testid="tweetText"]');
    if (!textEl) return null;
    return textEl.innerText.trim();
  }

  function extractAuthor(article) {
    const userNameEl = article.querySelector('div[data-testid="User-Name"]');
    if (userNameEl) {
      const link = userNameEl.querySelector("a");
      if (link) {
        const spans = link.querySelectorAll("span");
        for (const span of spans) {
          const text = span.textContent.trim();
          if (text && !text.startsWith("@")) return text;
        }
      }
    }
    return "Unknown";
  }

  // 判断是否为评论（回复推文）：推文顶部的上下文条里出现 @ 开头的 handle，
  // 即 "Replying to @xxx" / “回复 @xxx”，该特征与界面语言无关。
  // 用整条 innerText 判断而非内部 span 结构，避免依赖 X 的内部 DOM 细节
  function isReplyTweet(article) {
    const ctx = article.querySelector('div[data-testid="socialContext"]');
    if (!ctx) return false;
    return ctx.innerText.includes("@");
  }

  // ---- Tweet processing ----

  // 判断是否为详情页（/<用户>/status/<id>，含 analytics、photo 等变体）：
  // 详情页只做过滤，不做筛选
  function isDetailPage() {
    return location.pathname.includes("/status/");
  }

  function processTweet(article) {
    if (!enabled) return;
    if (article.dataset.aiFilterProcessed) return;

    // 详情页不筛选：直接跳过且不标记 processed，便于返回列表页后重新处理
    if (isDetailPage()) return;

    // 评论默认不验证：直接跳过且不标记 processed，用户开启开关后可重新处理
    if (!filterReplies && isReplyTweet(article)) return;

    const text = extractTweetText(article);
    if (!text) return;

    const hash = hashText(text);
    article.dataset.aiFilterProcessed = "true";
    article.dataset.aiFilterHash = hash;

    // If we already have a verdict for this hash, apply immediately
    if (processedHashes.has(hash)) {
      const verdict = processedHashes.get(hash);
      if (verdict.hide) {
        applyHidden(article, verdict.reason);
      }
      return;
    }

    // Hide content and show loader while we wait for AI
    hideChildren(article);
    addLoader(article);

    pendingTweets.set(hash, { element: article, text });
    scheduleBatch();
  }

  function scheduleBatch() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(sendBatch, 500);
  }

  async function sendBatch() {
    if (pendingTweets.size === 0) return;

    const batch = [];
    const elements = new Map();

    for (const [hash, data] of pendingTweets) {
      batch.push({ hash, text: data.text });
      elements.set(hash, data.element);
    }
    pendingTweets.clear();

    try {
      const results = await chrome.runtime.sendMessage({
        type: "EVALUATE_TWEETS",
        tweets: batch,
      });

      if (!results) return;

      for (const verdict of results) {
        processedHashes.set(verdict.id, { hide: verdict.hide, reason: verdict.reason || "" });
        applyVerdictToAll(verdict.id, verdict.hide, verdict.reason || "");
      }
    } catch (err) {
      console.error("AI Twitter Filter - Error sending batch:", err);
      // Fail open - show all tweets in this batch
      for (const [hash] of elements) {
        applyVerdictToAll(hash, false);
      }
    }
  }

  function applyVerdictToAll(hash, hide, reason) {
    const articles = document.querySelectorAll(
      `article[data-testid="tweet"][data-ai-filter-hash="${hash}"]`
    );
    for (const article of articles) {
      removeLoader(article);
      if (hide) {
        applyHidden(article, reason);
      } else {
        showChildren(article);
      }
    }
  }

  function applyHidden(article, reason) {
    article.classList.add("ai-filter-hidden");
    hideChildren(article);
    if (!article.querySelector(".ai-filter-banner")) {
      const author = extractAuthor(article);
      article.prepend(createBanner(author, reason));
    }
  }

  function unhideAll() {
    // Remove banners and loaders
    document.querySelectorAll(".ai-filter-banner, .ai-filter-loader").forEach((el) => el.remove());
    // Restore children visibility
    document.querySelectorAll(".ai-filter-hidden, [data-ai-filter-processed]").forEach((article) => {
      article.classList.remove("ai-filter-hidden");
      showChildren(article);
    });
  }

  // 仅重置 DOM 侧状态：移除横幅/加载动画并恢复显示，清掉节点上的处理标记
  // （路由切换时使用：X 会重建推文 DOM，但判定结果可复用）
  function resetDomState() {
    unhideAll();
    document.querySelectorAll("[data-ai-filter-processed]").forEach((el) => {
      delete el.dataset.aiFilterProcessed;
      delete el.dataset.aiFilterHash;
    });
  }

  // 完整重置：DOM 状态 + 判定缓存（仅设置变化需要重新判定时使用）
  function resetAll() {
    resetDomState();
    processedHashes.clear();
    pendingTweets.clear();
  }

  // ---- DOM observer ----

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;

        if (node.matches?.('article[data-testid="tweet"]')) {
          processTweet(node);
        }

        const articles = node.querySelectorAll?.(
          'article[data-testid="tweet"]'
        );
        if (articles) {
          for (const article of articles) {
            processTweet(article);
          }
        }
      }
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });

  // Process tweets already on the page
  if (!isDetailPage()) {
    document.querySelectorAll('article[data-testid="tweet"]').forEach(processTweet);
  }

  // ---- SPA 路由检测 ----
  // X 切换页面不刷新（SPA），轮询检测地址变化：
  // 进入详情页时恢复所有隐藏状态，返回列表页时重新扫描
  let lastPathname = location.pathname;

  function handleRouteChange() {
    // 进出详情页时 X 会重建推文 DOM，旧节点标记随节点销毁；
    // 仅重置 DOM 状态并保留判定缓存（processedHashes）——
    // 返回列表后同批推文直接应用已有判定，不再重走 Checking 动画与防抖等待
    resetDomState();
    if (!isDetailPage()) {
      document
        .querySelectorAll('article[data-testid="tweet"]')
        .forEach(processTweet);
    }
  }

  setInterval(() => {
    if (location.pathname === lastPathname) return;
    lastPathname = location.pathname;
    handleRouteChange();
  }, 500);

  // ---- Message listener ----

  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === "SETTINGS_UPDATED") {
      if ("enabled" in message.changes) {
        enabled = message.changes.enabled;
        if (!enabled) {
          unhideAll();
        } else {
          resetAll();
          document
            .querySelectorAll('article[data-testid="tweet"]')
            .forEach(processTweet);
        }
      }

      if ("filterPrompt" in message.changes) {
        resetAll();
        document
          .querySelectorAll('article[data-testid="tweet"]')
          .forEach(processTweet);
      }

      // 回复验证开关变化时，重置所有标记并重新扫描当前页面
      if ("filterReplies" in message.changes) {
        filterReplies = message.changes.filterReplies === true;
        resetAll();
        document
          .querySelectorAll('article[data-testid="tweet"]')
          .forEach(processTweet);
      }
    }
  });

  // Load initial settings
  chrome.runtime.sendMessage({ type: "GET_SETTINGS" }, (settings) => {
    if (settings) {
      enabled = settings.enabled;
      filterReplies = settings.filterReplies === true;
    }
  });

  // 构建标记：用于在控制台区分新旧代码（排查扩展未重载问题）
  console.log("AI Twitter Filter - Content script loaded [build 1.0.1-b1]");
})();
