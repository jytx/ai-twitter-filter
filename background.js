import { getApiUrl } from "./providers.js";

// 判定结果缓存：内存 Map 作为一级缓存，并镜像持久化到 chrome.storage.session，
// 避免 MV3 Service Worker 被回收后缓存丢失、刷新页面时重复调用 API
const cache = new Map();

const DEFAULT_SETTINGS = {
  enabled: true,
  filterReplies: false,
  apiProvider: "openai",
  apiKey: "",
  model: "gpt-4o-mini",
  customBaseUrl: "",
  filterPrompt: "Is this tweet negative, toxic, or complaining? Reply with true to hide it, false to keep it.",
};

// API 调用最小间隔（毫秒），配合串行队列防止快速滚动时间线时产生请求风暴
const MIN_API_INTERVAL_MS = 1000;
let lastApiCallAt = 0;
let apiQueue = Promise.resolve();

// 读取 API 密钥：密钥只保存在本地（chrome.storage.local），不随 Chrome 账号同步上传。
// 兼容旧版本：若发现遗留在 sync 中的密钥，迁移到本地后立即从 sync 中删除
async function getLocalApiKey() {
  const local = await chrome.storage.local.get("apiKey");
  if (local.apiKey) return local.apiKey;

  const sync = await chrome.storage.sync.get("apiKey");
  if (sync.apiKey) {
    await chrome.storage.local.set({ apiKey: sync.apiKey });
    await chrome.storage.sync.remove("apiKey");
    console.log("AI Twitter Filter - API key migrated from sync to local storage");
    return sync.apiKey;
  }
  return "";
}

async function getSettings() {
  const syncData = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  const apiKey = await getLocalApiKey();
  return { ...syncData, apiKey };
}

async function evaluateWithAI(tweets, settings) {
  const url = getApiUrl(settings);

  const systemPrompt = `You are a tweet filter. The user has set this filter criteria:

"${settings.filterPrompt}"

You will receive a JSON array of tweets, each with an "id" and "text" field.
For each tweet, decide if it should be hidden based on the filter criteria.
Respond with ONLY a JSON array of objects with "id" (string), "hide" (boolean), and "reason" (string, max 3 words, e.g. "toxic negativity", "political rage-bait", "spam promotion") fields.
If hide is false, reason should be an empty string.
No explanation, no markdown, just the JSON array.`;

  const userMessage = JSON.stringify(
    tweets.map((t) => ({ id: t.hash, text: t.text }))
  );

  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${settings.apiKey}`,
  };

  if (settings.apiProvider === "openrouter") {
    headers["HTTP-Referer"] = "https://github.com/ai-twitter-filter";
    headers["X-Title"] = "AI Twitter Filter";
  }

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: settings.model,
      temperature: 0,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`API error ${response.status}: ${errorText}`);
  }

  const data = await response.json();
  const content = data.choices[0].message.content.trim();

  // Parse JSON, stripping markdown code fences if present
  let cleaned = content;
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
  }

  return JSON.parse(cleaned);
}

// 所有 AI 请求经此函数排队：全局串行执行且相邻两次调用至少间隔 MIN_API_INTERVAL_MS，
// 一次失败不会阻塞后续调用（错误在队列尾部被吞掉，由调用方各自 catch）
function rateLimitedEvaluate(tweets, settings) {
  const run = async () => {
    const waitMs = lastApiCallAt + MIN_API_INTERVAL_MS - Date.now();
    if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
    lastApiCallAt = Date.now();
    return evaluateWithAI(tweets, settings);
  };
  const result = apiQueue.then(run);
  apiQueue = result.catch(() => {});
  return result;
}

// Service Worker 启动时从 session 恢复缓存（session 存活于整个浏览器会话期间）
async function loadCacheFromSession() {
  const data = await chrome.storage.session.get("filterCache");
  if (data.filterCache) {
    for (const [hash, verdict] of Object.entries(data.filterCache)) {
      cache.set(hash, verdict);
    }
  }
}

async function persistCache() {
  await chrome.storage.session.set({
    filterCache: Object.fromEntries(cache),
  });
}

async function clearAllCache() {
  cache.clear();
  await chrome.storage.session.remove("filterCache");
}

// 在途请求去重：hash -> 判定结果 Promise
// 结果返回前同一推文再次进入（滚动重排的新 DOM 实例、路由切换重扫、
// 多标签页并发）时，复用同一在途请求，避免同文重复调用 API
const inflight = new Map();

// 从一批判定结果中提取指定推文的结果；模型漏答该条时按放行兜底
function pickVerdict(verdicts, hash) {
  const found = verdicts.find((v) => v.id === hash);
  if (found) return { hide: found.hide, reason: found.reason || "" };
  return { hide: false, reason: "" };
}

loadCacheFromSession();

async function handleEvaluateTweets(tweets) {
  const settings = await getSettings();

  if (!settings.enabled || !settings.apiKey) {
    return tweets.map((t) => ({ id: t.hash, hide: false }));
  }

  // 拆分：已缓存 / 在途（复用同一结果）/ 需新判定
  const results = [];
  const waiting = [];
  const uncached = [];

  for (const tweet of tweets) {
    if (cache.has(tweet.hash)) {
      const cached = cache.get(tweet.hash);
      results.push({ id: tweet.hash, hide: cached.hide, reason: cached.reason });
    } else if (inflight.has(tweet.hash)) {
      waiting.push({ id: tweet.hash, promise: inflight.get(tweet.hash) });
    } else {
      uncached.push(tweet);
    }
  }

  // Process in batches of 15
  for (let i = 0; i < uncached.length; i += 15) {
    const batch = uncached.slice(i, i + 15);

    // 发起前同步登记在途 Promise，让并发到达的请求立即观察到并复用
    const verdictsPromise = rateLimitedEvaluate(batch, settings);
    for (const tweet of batch) {
      inflight.set(
        tweet.hash,
        verdictsPromise.then((verdicts) => pickVerdict(verdicts, tweet.hash))
      );
    }

    try {
      const verdicts = await verdictsPromise;
      for (const verdict of verdicts) {
        cache.set(verdict.id, { hide: verdict.hide, reason: verdict.reason || "" });
        results.push(verdict);
      }
      // 每批判定后立即持久化，防止 SW 中途被回收丢掉整批结果
      await persistCache();
    } catch (err) {
      console.error("AI Twitter Filter - API error:", err);
      // Fail open: show tweets on error
      for (const tweet of batch) {
        results.push({ id: tweet.hash, hide: false });
      }
    } finally {
      for (const tweet of batch) inflight.delete(tweet.hash);
    }
  }

  // 等待复用的在途结果并合并返回；在途请求失败时按放行兜底
  for (const w of waiting) {
    const verdict = await w.promise.catch(() => ({ hide: false, reason: "" }));
    results.push({ id: w.id, hide: verdict.hide, reason: verdict.reason });
  }

  return results;
}

// Message listener
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "EVALUATE_TWEETS") {
    handleEvaluateTweets(message.tweets).then(sendResponse);
    return true; // async response
  }

  if (message.type === "GET_SETTINGS") {
    getSettings().then(sendResponse);
    return true;
  }

  if (message.type === "CLEAR_CACHE") {
    clearAllCache().then(() => {
      console.log("AI Twitter Filter - Cache cleared");
      sendResponse({ success: true });
    });
    return true; // async response
  }
});

// Listen for settings changes and broadcast to content scripts
chrome.storage.onChanged.addListener((changes, area) => {
  // 专注模式状态存在 local 中：单独处理并广播给内容脚本
  // （其余 local 键如 apiKey 不需要广播给内容脚本）
  if (area === "local") {
    if (!("focusMode" in changes)) return;
    broadcastToXTabs({
      type: "FOCUS_MODE_UPDATED",
      focusMode: changes.focusMode.newValue === true,
    });
    return;
  }

  // filterPrompt 存在 sync 中；apiKey 存在 local 中但无需广播给内容脚本
  if (area !== "sync") return;

  // Auto-clear cache when filter prompt changes
  if (changes.filterPrompt) {
    clearAllCache();
    console.log("AI Twitter Filter - Cache cleared (filter changed)");
  }

  // Broadcast settings update to all x.com tabs
  const settings = {};
  for (const [key, change] of Object.entries(changes)) {
    settings[key] = change.newValue;
  }
  broadcastToXTabs({ type: "SETTINGS_UPDATED", changes: settings });
});

// 向所有 x.com / twitter.com 标签页广播消息
// 目标页面尚未加载内容脚本时会 reject，这里静默忽略（由内容脚本的 storage 监听兜底）
function broadcastToXTabs(message) {
  chrome.tabs.query({ url: ["https://x.com/*", "https://twitter.com/*"] }, (tabs) => {
    for (const tab of tabs) {
      chrome.tabs.sendMessage(tab.id, message).catch(() => {
        // Tab might not have content script loaded yet
      });
    }
  });
}
