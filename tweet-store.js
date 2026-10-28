// 推文判定状态层：判定结果缓存、待判定队列、DOM 实例索引与批次调度。
//
// 与 content.js 同处内容脚本的隔离世界（见 manifest 的 content_scripts 顺序），
// 以全局对象 TweetStore 供其调用。这里只维护状态与调度，不操作 DOM、
// 不发送消息——具体动作由 content.js 通过 setBatchListener 注入回调。
//
// 单独拆出这一层的原因：判定状态与 DOM 观察逻辑关注点不同，
// 且状态层需要在 DOM 频繁变化的情况下保持稳定（避免状态随节点销毁而丢失）。

const TweetStore = (() => {
  // 判定结果缓存：hash -> { hide:boolean, reason:string }
  const verdicts = new Map();
  // 待判定的推文：hash -> { text }
  const pending = new Map();
  // 推文 DOM 实例索引：hash -> Set<Element>
  // 同一段文本可能在页面上出现多个实例（置顶推文、话题串），
  // 判定结果需要套用到全部实例上
  const elements = new Map();

  // 批次调度的定时器与截止时间
  let batchTimer = null;
  let batchDeadline = 0;
  // 批次就绪回调：由 content.js 注入（负责发消息并套用结果）
  let batchListener = null;

  // 批次节流时长（毫秒）
  const BATCH_INTERVAL_MS = 500;

  // 文本哈希：同一段文本在不同推文实例间共享判定结果
  function hashText(text) {
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      const char = text.charCodeAt(i);
      hash = ((hash << 5) - hash + char) | 0;
    }
    return hash.toString(36);
  }

  function getVerdict(hash) {
    return verdicts.get(hash);
  }

  // 写入判定结果并结束该 hash 的待判定状态。
  // cache 为 false 时不写入缓存：请求失败需要允许后续重新判定。
  function setVerdict(hash, hide, reason, cache) {
    if (cache) {
      verdicts.set(hash, { hide, reason });
    }
    pending.delete(hash);
  }

  // 登记推文的 DOM 实例
  function trackElement(hash, element) {
    let set = elements.get(hash);
    if (!set) {
      set = new Set();
      elements.set(hash, set);
    } else {
      // 顺带清理已被 X 销毁的旧实例，避免索引随页面滚动无限膨胀
      for (const old of set) {
        if (!old.isConnected) set.delete(old);
      }
    }
    set.add(element);
  }

  function getElements(hash) {
    return elements.get(hash);
  }

  // 判定完成后释放实例索引：后续同文本的新实例走判定缓存分支，无需再索引
  function forgetElements(hash) {
    elements.delete(hash);
  }

  // 实例是否还挂在页面上：全部被销毁则无需再发请求
  function hasLiveElement(hash) {
    const set = elements.get(hash);
    if (!set) return false;
    for (const element of set) {
      if (element.isConnected) return true;
    }
    return false;
  }

  // 入队待判定推文并触发批次调度。
  // 同一段文本重复入队时沿用已有记录，不产生重复请求。
  function enqueue(hash, text) {
    if (!pending.has(hash)) {
      pending.set(hash, { text });
    }
    scheduleBatch();
  }

  // 取出待判定批次：节点已被 X 销毁的条目直接丢弃（判定结果无处应用，
  // 节点重建时会重新走完整流程，不存在漏判缝隙）
  function takePendingBatch() {
    const batch = [];
    for (const [hash, data] of pending) {
      if (!hasLiveElement(hash)) continue;
      batch.push({ hash, text: data.text });
    }
    pending.clear();
    return batch;
  }

  // 批次调度：连续滚动时新推文会不断到达，若每次都重置定时器，
  // 批次会被无限推迟，页面长时间停留在“Checking”状态且判定不断积压。
  // 这里采用“截止时间不后移”的节流：首条推文入队即确定截止时间，
  // 之后到达的推文沿用原定时器，积压量始终不超过一个节流窗口。
  function scheduleBatch() {
    const now = Date.now();

    if (batchTimer === null) {
      batchDeadline = now + BATCH_INTERVAL_MS;
      batchTimer = setTimeout(() => {
        batchTimer = null;
        notifyBatchReady();
      }, BATCH_INTERVAL_MS);
      return;
    }

    // 定时器被浏览器后台节流而延迟触发时（now 已过截止时间），立即补发
    if (now >= batchDeadline) {
      clearTimeout(batchTimer);
      batchTimer = null;
      notifyBatchReady();
    }
  }

  // 触发批次就绪回调：回调是异步的（发消息并等待判定），
  // 这里吞掉其异常，避免产生未处理的 Promise 拒绝
  function notifyBatchReady() {
    if (!batchListener) return;
    try {
      const result = batchListener();
      if (result && typeof result.catch === "function") {
        result.catch((err) => console.error("AI Twitter Filter - 批次处理失败:", err));
      }
    } catch (err) {
      console.error("AI Twitter Filter - 批次处理失败:", err);
    }
  }

  function setBatchListener(listener) {
    batchListener = listener;
  }

  // 完整重置：判定缓存、待判定队列、实例索引与定时器
  function reset() {
    verdicts.clear();
    pending.clear();
    elements.clear();
    if (batchTimer) {
      clearTimeout(batchTimer);
      batchTimer = null;
    }
  }

  return {
    hashText,
    getVerdict,
    setVerdict,
    trackElement,
    getElements,
    forgetElements,
    hasLiveElement,
    enqueue,
    takePendingBatch,
    setBatchListener,
    reset,
  };
})();
