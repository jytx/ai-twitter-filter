(() => {
  let enabled = true;
  // 是否对评论（回复推文）也做 AI 验证；默认关闭，时间线上的回复直接放行
  let filterReplies = false;

  // ---- 推文文本与作者提取 ----

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

  // ---- 判定结果套用 ----

  // 套用判定结果到该文本的全部 DOM 实例，并清理判定中状态。
  // cache 为 false 时不写入判定缓存：请求失败需要允许后续重新判定。
  function applyVerdict(hash, hide, reason, cache) {
    TweetStore.setVerdict(hash, hide, reason, cache);

    const elements = TweetStore.getElements(hash);
    if (!elements) return;

    for (const element of [...elements]) {
      // 已被 X 销毁的节点无需处理：节点重建后会重新走完整流程
      if (!element.isConnected) continue;
      // 先恢复内容再释放高度占位：顺序反了会让 article 瞬间塌缩，
      // X 的虚拟列表据此重新计算可视窗口，多拉一批无用的推文
      if (hide) {
        TweetDom.applyHidden(element, reason, extractAuthor(element));
      } else {
        TweetDom.showChildren(element);
      }
      TweetDom.clearPending(element);
      // 高度占位在内容恢复之后才撤除，全程 article 高度保持稳定
    }

    // 判定已完成，后续同文本的新实例走判定缓存分支，无需再索引
    TweetStore.forgetElements(hash);
  }

  // ---- 批次发送 ----

  async function sendBatch() {
    const batch = TweetStore.takePendingBatch();
    if (batch.length === 0) return;

    try {
      const results = await chrome.runtime.sendMessage({
        type: "EVALUATE_TWEETS",
        tweets: batch,
      });

      // background 未返回结果时按放行兜底，避免推文永远停留在加载状态
      const verdicts = Array.isArray(results) ? results : [];

      const applied = new Set();
      for (const verdict of verdicts) {
        applyVerdict(verdict.id, Boolean(verdict.hide), verdict.reason || "", true);
        applied.add(verdict.id);
      }

      // 模型漏答的条目按放行兜底：请求已完成但没拿到判定，
      // 若不放行推文会一直卡在“Checking”状态
      for (const item of batch) {
        if (!applied.has(item.hash)) {
          applyVerdict(item.hash, false, "", false);
        }
      }
    } catch (err) {
      console.error("AI Twitter Filter - Error sending batch:", err);
      // Fail open - show all tweets in this batch
      for (const item of batch) {
        applyVerdict(item.hash, false, "", false);
      }
    }
  }

  // ---- 推文处理 ----

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

    const hash = TweetStore.hashText(text);
    article.dataset.aiFilterProcessed = "true";
    article.dataset.aiFilterHash = hash;

    // 已有判定结果：直接套用，不再发起请求
    const verdict = TweetStore.getVerdict(hash);
    if (verdict) {
      if (verdict.hide) {
        TweetDom.applyHidden(article, verdict.reason, extractAuthor(article));
      } else {
        TweetDom.showChildren(article);
      }
      return;
    }

    // 同一文本正在判定中：只登记实例，等结果回来统一套用。
    //
    // X 的虚拟列表会回收并重建 DOM 节点，重建出的新实例拿不到已有判定
    // （结果还没回来），若照常显示加载占位，同一条推文就会反复出现
    // "Checking"状态，而判定结果其实马上就到。
    // 表现为时间线上"下面几条已经渲染好、上面那条还在转圈"。
    if (TweetStore.isPending(hash)) {
      TweetStore.trackElement(hash, article);
      return;
    }

    // 判定中：只切标记，不改动推文尺寸（见 ui.js 的 markPending 说明）
    TweetDom.markPending(article);
    TweetStore.trackElement(hash, article);
    TweetStore.enqueue(hash, text);
  }

  // ---- DOM 观察 ----

  // 视口观察：推文接近视口（提前 1500px）才发起判定。
  //
  // 提前量决定用户"翻到时还要等多久"：余量越大，判定在推文进入视口前
  // 就开始，抵达时通常已有结果。800px 约等于一秒的滚动距离，快速滚动时
  // 判定总是落后于视线，用户每翻一处都得停下来等。
  //
  // 余量放大不会导致请求量失控：请求量正比于观察带内的推文数，
  // 而判定期间推文保持原始高度（见 ui.js 的 markPending 说明），
  // 带内推文数量与真实可见数量保持同一量级，不会成倍放大。
  // 已判定的节点由 processTweet 的 dataset 守卫自然跳过
  const viewportObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        viewportObserver.unobserve(entry.target);
        processTweet(entry.target);
      }
    },
    { rootMargin: "1500px 0px" }
  );

  // 统一入口：新出现的推文先观察视口，接近可见时才判定
  function queueTweet(article) {
    viewportObserver.observe(article);
  }

  // DOM 观察：捕获新插入的推文节点。
  //
  // X 渲染一条推文会新增几十个元素节点，本回调对每个元素节点都会执行一次
  // querySelectorAll，累积开销可观——主线程被占满时 X 会启用渐进渲染，
  // 表现为推文分批冒出。因此这里做两处优化：
  //   1. 节点自身就是推文时直接入队，不再遍历其子树（推文内不会嵌套推文）
  //   2. 用 querySelector 先做存在性判断，命中即停，不遍历完整个子树
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;

        if (node.matches?.('article[data-testid="tweet"]')) {
          queueTweet(node);
          continue;
        }

        // 子树里含推文时才展开，避免对每个元素节点都做完整遍历
        if (!node.querySelector?.('article[data-testid="tweet"]')) continue;

        const articles = node.querySelectorAll('article[data-testid="tweet"]');
        for (const article of articles) {
          queueTweet(article);
        }
      }
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });

  // ---- 状态重置 ----

  // 仅重置 DOM 侧状态：移除横幅/加载动画并恢复显示，清掉节点上的处理标记
  // （路由切换时使用：X 会重建推文 DOM，但判定结果可复用）
  function resetDomState() {
    TweetDom.removeOverlays();
    TweetDom.showAll();
    document.querySelectorAll("[data-ai-filter-processed]").forEach((el) => {
      delete el.dataset.aiFilterProcessed;
      delete el.dataset.aiFilterHash;
    });
  }

  // 完整重置：DOM 状态 + 判定缓存（仅设置变化需要重新判定时使用）
  function resetAll() {
    resetDomState();
    TweetStore.reset();
  }

  // 重新扫描当前页面的全部推文
  function rescanPage() {
    document
      .querySelectorAll('article[data-testid="tweet"]')
      .forEach(queueTweet);
  }

  // ---- SPA 路由检测 ----
  // X 切换页面不刷新（SPA），轮询检测地址变化：
  // 进入详情页时恢复所有隐藏状态，返回列表页时重新扫描
  let lastPathname = location.pathname;

  function handleRouteChange() {
    // 进出详情页时 X 会重建推文 DOM，旧节点标记随节点销毁；
    // 仅重置 DOM 状态并保留判定缓存——
    // 返回列表后同批推文直接应用已有判定，不再重走 Checking 动画与节流等待
    resetDomState();
    if (!isDetailPage()) {
      rescanPage();
    }
  }

  setInterval(() => {
    if (location.pathname === lastPathname) return;
    lastPathname = location.pathname;
    handleRouteChange();
  }, 500);

  // ---- Message listener ----

  chrome.runtime.onMessage.addListener((message) => {
    if (message.type !== "SETTINGS_UPDATED") return;

    if ("enabled" in message.changes) {
      enabled = message.changes.enabled;
      if (enabled) {
        resetAll();
        rescanPage();
      } else {
        // 关闭过滤：只恢复显示，保留判定缓存，重新开启时无需重复请求
        resetDomState();
      }
    }

    if ("filterPrompt" in message.changes) {
      resetAll();
      rescanPage();
    }

    // 回复验证开关变化时，重置所有标记并重新扫描当前页面
    if ("filterReplies" in message.changes) {
      filterReplies = message.changes.filterReplies === true;
      resetAll();
      rescanPage();
    }
  });

  // Load initial settings
  chrome.runtime.sendMessage({ type: "GET_SETTINGS" }, (settings) => {
    if (settings) {
      enabled = settings.enabled;
      filterReplies = settings.filterReplies === true;
    }
  });

  // 批次就绪回调：交给状态层调度，content.js 负责发消息与套用结果
  TweetStore.setBatchListener(sendBatch);

  // Process tweets already on the page
  if (!isDetailPage()) {
    rescanPage();
  }

  // 构建标记：用于在控制台区分新旧代码（排查扩展未重载问题）
  console.log("AI Twitter Filter - Content script loaded [build 1.3.1]");
})();
