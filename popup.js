import { getApiUrl } from "./providers.js";

const DEFAULT_SETTINGS = {
  enabled: true,
  filterReplies: false,
  apiProvider: "openai",
  apiKey: "",
  model: "gpt-4o-mini",
  customBaseUrl: "",
  filterPrompt:
    "Is this tweet negative, toxic, or complaining? Reply with true to hide it, false to keep it.",
  savedFilters: [],
};

const els = {
  enabled: document.getElementById("enabled"),
  filterReplies: document.getElementById("filterReplies"),
  apiProvider: document.getElementById("apiProvider"),
  apiKey: document.getElementById("apiKey"),
  customBaseUrl: document.getElementById("customBaseUrl"),
  customBaseUrlField: document.getElementById("customBaseUrlField"),
  customBaseUrlStatus: document.getElementById("customBaseUrlStatus"),
  model: document.getElementById("model"),
  modelTextField: document.getElementById("modelTextField"),
  modelSelect: document.getElementById("modelSelect"),
  modelSelectField: document.getElementById("modelSelectField"),
  apiKeyNotice: document.getElementById("apiKeyNotice"),
  savedFilters: document.getElementById("savedFilters"),
  deleteSavedFilter: document.getElementById("deleteSavedFilter"),
  filterPrompt: document.getElementById("filterPrompt"),
  saveFilter: document.getElementById("saveFilter"),
  testConnection: document.getElementById("testConnection"),
  testResult: document.getElementById("testResult"),
  status: document.getElementById("status"),
};

// 内置厂商的域名已在 manifest host_permissions 中声明，无需动态授权
const BUILTIN_ORIGINS = ["https://api.openai.com", "https://openrouter.ai"];

let currentSavedFilters = [];

function updateModelVisibility(provider) {
  // openrouter 用预置模型下拉；openai 与 custom 用文本框自由填写模型名
  const useModelSelect = provider === "openrouter";
  els.modelTextField.style.display = useModelSelect ? "none" : "";
  els.modelSelectField.style.display = useModelSelect ? "" : "none";

  // custom 模式额外显示 Base URL 输入框，并放宽模型名占位提示
  els.customBaseUrlField.style.display = provider === "custom" ? "" : "none";
  els.model.placeholder = provider === "custom" ? "e.g. deepseek-chat" : "gpt-4o-mini";
}

// 为自定义厂商请求主机权限（必须在用户手势事件内调用，如 change）
// URL 无法解析或用户拒绝授权时返回 false；内置厂商域名直接视为通过
async function requestOriginPermission(urlText) {
  const trimmed = urlText.trim();
  if (!trimmed) return false;

  let origin;
  try {
    origin = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`).origin;
  } catch {
    return false;
  }
  if (BUILTIN_ORIGINS.includes(origin)) return true;

  return chrome.permissions.request({ origins: [`${origin}/*`] });
}

function renderSavedFilters() {
  // Clear existing options (keep placeholder)
  els.savedFilters.innerHTML =
    '<option value="" disabled selected>Load a saved filter...</option>';

  for (let i = 0; i < currentSavedFilters.length; i++) {
    const opt = document.createElement("option");
    opt.value = i;
    // Truncate long filters for the dropdown label
    const text = currentSavedFilters[i];
    opt.textContent = text.length > 50 ? text.slice(0, 50) + "..." : text;
    opt.title = text;
    els.savedFilters.appendChild(opt);
  }
}

let statusTimer = null;

function showStatus(msg) {
  showStatusFor(msg, 2000);
}

// 状态提示并指定显示时长（毫秒）；清掉旧定时器避免提前清掉新文案
function showStatusFor(msg, durationMs) {
  els.status.textContent = msg;
  if (statusTimer) clearTimeout(statusTimer);
  statusTimer = setTimeout(() => {
    els.status.textContent = "";
    statusTimer = null;
  }, durationMs);
}

// Base URL 就地状态提示（显示在输入框正下方，成功绿/失败红，6 秒后消失）
let baseUrlStatusTimer = null;
function showBaseUrlStatus(msg, ok) {
  const el = els.customBaseUrlStatus;
  el.textContent = msg;
  el.className = "field-status" + (msg ? (ok ? " ok" : " err") : "");
  if (baseUrlStatusTimer) clearTimeout(baseUrlStatusTimer);
  baseUrlStatusTimer = setTimeout(() => {
    el.textContent = "";
    baseUrlStatusTimer = null;
  }, 6000);
}

// Load saved settings（经 background 读取，密钥会从本地存储获取并完成旧版迁移）
chrome.runtime.sendMessage({ type: "GET_SETTINGS" }, (settings) => {
  if (chrome.runtime.lastError || !settings) settings = DEFAULT_SETTINGS;
  els.enabled.checked = settings.enabled;
  els.filterReplies.checked = settings.filterReplies === true;
  els.apiProvider.value = settings.apiProvider;
  els.apiKey.value = settings.apiKey;
  els.model.value = settings.model;
  els.filterPrompt.value = settings.filterPrompt;
  els.customBaseUrl.value = settings.customBaseUrl || "";

  updateModelVisibility(settings.apiProvider);
  els.apiKeyNotice.style.display = settings.apiKey ? "none" : "block";

  if (settings.apiProvider === "openrouter") {
    els.modelSelect.value = settings.model;
  }

  currentSavedFilters = settings.savedFilters || [];
  renderSavedFilters();
});

// Auto-save on change
function save(key, value) {
  chrome.storage.sync.set({ [key]: value });
}

// API 密钥只保存在本地（chrome.storage.local），不随 Chrome 账号同步上传
function saveApiKey(value) {
  chrome.storage.local.set({ apiKey: value });
}

els.enabled.addEventListener("change", () => {
  save("enabled", els.enabled.checked);
});

els.filterReplies.addEventListener("change", () => {
  save("filterReplies", els.filterReplies.checked);
});

els.apiProvider.addEventListener("change", () => {
  const provider = els.apiProvider.value;
  save("apiProvider", provider);
  updateModelVisibility(provider);

  if (provider === "openrouter") {
    save("model", els.modelSelect.value);
  } else if (provider === "openai") {
    save("model", "gpt-4o-mini");
    els.model.value = "gpt-4o-mini";
  } else {
    // custom：模型名由用户自由填写，保留当前输入
    save("model", els.model.value);
    // 已填有 Base URL 时顺带请求对应域名授权
    if (els.customBaseUrl.value.trim()) {
      requestOriginPermission(els.customBaseUrl.value).then((granted) => {
        showBaseUrlStatus(
          granted ? "Permission granted" : "Permission denied — click Test Connection to grant",
          granted
        );
      });
    }
  }
});

els.customBaseUrl.addEventListener("change", () => {
  const urlText = els.customBaseUrl.value.trim();
  if (!urlText) {
    save("customBaseUrl", "");
    return;
  }

  // 校验 URL 格式：合法即立即保存（保证 background 马上用上新地址），
  // 权限请求独立进行——此前"权限通过才保存"会导致权限被拒时地址静默不生效，
  // 输入框显示新地址而实际仍请求旧地址
  let origin;
  try {
    origin = new URL(urlText.includes("://") ? urlText : `https://${urlText}`).origin;
  } catch {
    showBaseUrlStatus("Invalid URL — not saved", false);
    return;
  }

  save("customBaseUrl", urlText);
  // 保存成功立即提示，不依赖权限请求结果（权限 promise 异常不应吞掉保存反馈）
  showBaseUrlStatus("Base URL saved", true);

  if (BUILTIN_ORIGINS.includes(origin)) return;

  // 自定义域名请求授权，结果仅用于覆盖提示：
  // 拒绝或手势丢失（request 会直接抛错而非返回 false）时指引点 Test Connection 补授权
  chrome.permissions
    .request({ origins: [`${origin}/*`] })
    .then((granted) => {
      if (!granted) {
        showBaseUrlStatus("Saved — permission denied, click Test Connection to grant", false);
      }
    })
    .catch(() => {
      showBaseUrlStatus("Saved — click Test Connection to grant access", false);
    });
});

els.apiKey.addEventListener("change", () => {
  saveApiKey(els.apiKey.value);
  els.apiKeyNotice.style.display = els.apiKey.value ? "none" : "block";
});

els.model.addEventListener("change", () => {
  save("model", els.model.value);
});

els.modelSelect.addEventListener("change", () => {
  save("model", els.modelSelect.value);
});

els.filterPrompt.addEventListener("change", () => {
  save("filterPrompt", els.filterPrompt.value);
});

// Load a saved filter
els.savedFilters.addEventListener("change", () => {
  const idx = parseInt(els.savedFilters.value, 10);
  if (isNaN(idx) || !currentSavedFilters[idx]) return;

  els.filterPrompt.value = currentSavedFilters[idx];
  save("filterPrompt", currentSavedFilters[idx]);
  showStatus("Filter loaded");
});

// Save current filter
els.saveFilter.addEventListener("click", () => {
  const prompt = els.filterPrompt.value.trim();
  if (!prompt) return;

  // Don't save duplicates
  if (currentSavedFilters.includes(prompt)) {
    showStatus("Already saved");
    return;
  }

  currentSavedFilters.push(prompt);
  save("savedFilters", currentSavedFilters);
  renderSavedFilters();
  showStatus("Filter saved");
});

// Delete selected saved filter
els.deleteSavedFilter.addEventListener("click", () => {
  const idx = parseInt(els.savedFilters.value, 10);
  if (isNaN(idx) || !currentSavedFilters[idx]) {
    showStatus("Select a filter first");
    return;
  }

  currentSavedFilters.splice(idx, 1);
  save("savedFilters", currentSavedFilters);
  renderSavedFilters();
  showStatus("Filter deleted");
});

// ---- Test Connection ----

// 测试请求超时（毫秒）：慢模型冷启动也可能较久，给足余量
const TEST_TIMEOUT_MS = 20000;

// 在测试按钮旁展示结果：ok 为 true 绿色、false 红色
function showTestResult(msg, ok) {
  els.testResult.textContent = msg;
  els.testResult.className = "test-result" + (msg ? (ok ? " ok" : " err") : "");
}

// 用当前输入框里的配置发一次最小真实请求（max_tokens=1，消耗可忽略），
// 验证地址可达、密钥有效、模型可用；错误信息直接回显帮助定位
async function runTestConnection() {
  const provider = els.apiProvider.value;
  const apiKey = els.apiKey.value.trim();
  const model = provider === "openrouter" ? els.modelSelect.value : els.model.value.trim();
  const customBaseUrl = els.customBaseUrl.value.trim();

  if (provider === "custom" && !customBaseUrl) {
    showTestResult("Fill in the Base URL first", false);
    return;
  }
  if (!apiKey) {
    showTestResult("Fill in the API key first", false);
    return;
  }
  if (!model) {
    showTestResult("Fill in the model name first", false);
    return;
  }

  const url = getApiUrl({ apiProvider: provider, customBaseUrl });

  // 自定义域名需先获得授权（按钮点击属于用户手势，可弹出权限请求）
  const granted = await requestOriginPermission(url);
  if (!granted) {
    showTestResult("Permission denied for this domain", false);
    return;
  }

  els.testConnection.disabled = true;
  els.testConnection.textContent = "Testing...";
  showTestResult("", true);

  // 超时中断，避免网络问题时按钮长时间卡在 Testing 状态
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS);

  try {
    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    };
    if (provider === "openrouter") {
      headers["HTTP-Referer"] = "https://github.com/ai-twitter-filter";
      headers["X-Title"] = "AI Twitter Filter";
    }

    const res = await fetch(url, {
      method: "POST",
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        model,
        max_tokens: 1,
        messages: [{ role: "user", content: "Reply with OK" }],
      }),
    });

    if (res.ok) {
      showTestResult("Connected — API works", true);
    } else {
      const errText = (await res.text()).slice(0, 120);
      showTestResult(`HTTP ${res.status} ${errText}`, false);
    }
  } catch (err) {
    const msg =
      err.name === "AbortError"
        ? `Timed out after ${TEST_TIMEOUT_MS / 1000}s`
        : "Network error — check the URL";
    showTestResult(msg, false);
  } finally {
    clearTimeout(timer);
    els.testConnection.disabled = false;
    els.testConnection.textContent = "Test Connection";
  }
}

els.testConnection.addEventListener("click", runTestConnection);
