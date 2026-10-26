import { getApiUrl } from "./providers.js";

// 判定结果缓存：内存 Map 作为一级缓存，并镜像持久化到 chrome.storage.session，
// 避免 MV3 Service Worker 被回收后缓存丢失、刷新页面时重复调用 API
const cache = new Map();

const DEFAULT_SETTINGS = {
  enabled: true,
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

loadCacheFromSession();

async function handleEvaluateTweets(tweets) {
  const settings = await getSettings();

  if (!settings.enabled || !settings.apiKey) {
    return tweets.map((t) => ({ id: t.hash, hide: false }));
  }

  // Split into cached and uncached
  const results = [];
  const uncached = [];

  for (const tweet of tweets) {
    if (cache.has(tweet.hash)) {
      const cached = cache.get(tweet.hash);
      results.push({ id: tweet.hash, hide: cached.hide, reason: cached.reason });
    } else {
      uncached.push(tweet);
    }
  }

  if (uncached.length === 0) {
    return results;
  }

  // Process in batches of 15
  for (let i = 0; i < uncached.length; i += 15) {
    const batch = uncached.slice(i, i + 15);
    try {
      const verdicts = await rateLimitedEvaluate(batch, settings);
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
    }
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
  // filterPrompt 存在 sync 中；apiKey 存在 local 中但无需广播给内容脚本
  if (area !== "sync") return;

  // Auto-clear cache when filter prompt changes
  if (changes.filterPrompt) {
    clearAllCache();
    console.log("AI Twitter Filter - Cache cleared (filter changed)");
  }

  // Broadcast settings update to all x.com tabs
  chrome.tabs.query({ url: ["https://x.com/*", "https://twitter.com/*"] }, (tabs) => {
    const settings = {};
    for (const [key, change] of Object.entries(changes)) {
      settings[key] = change.newValue;
    }
    for (const tab of tabs) {
      chrome.tabs.sendMessage(tab.id, {
        type: "SETTINGS_UPDATED",
        changes: settings,
      }).catch(() => {
        // Tab might not have content script loaded yet
      });
    }
  });
});
