import { loadFocusMode, bindFocusModeToggle } from "./focus-toggle.js";
import { bindTestConnection } from "./test-connection.js";

const DEFAULT_SETTINGS = {
  enabled: true,
  filterReplies: false,
  apiProvider: "openai",
  apiKey: "",
  model: "gpt-4o-mini",
  customBaseUrl: "",
  filterPrompt:
    "这条推文是否负面、有毒或在抱怨？如果是则回复 true 隐藏它，否则回复 false 保留它。",
  savedFilters: [],
};

const els = {
  enabled: document.getElementById("enabled"),
  filterReplies: document.getElementById("filterReplies"),
  focusMode: document.getElementById("focusMode"),
  focusModeStatus: document.getElementById("focusModeStatus"),
  apiProvider: document.getElementById("apiProvider"),
  apiKey: document.getElementById("apiKey"),
  apiKeyStatus: document.getElementById("apiKeyStatus"),
  customBaseUrl: document.getElementById("customBaseUrl"),
  customBaseUrlField: document.getElementById("customBaseUrlField"),
  customBaseUrlStatus: document.getElementById("customBaseUrlStatus"),
  model: document.getElementById("model"),
  modelStatus: document.getElementById("modelStatus"),
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
  version: document.getElementById("version"),
};

// 显示当前版本号：未打包扩展需要手动重载，版本号是确认代码是否更新的唯一依据
els.version.textContent = `v${chrome.runtime.getManifest().version}`;

// 内置厂商的域名已在 manifest host_permissions 中声明，无需动态授权
const BUILTIN_ORIGINS = ["https://api.openai.com", "https://openrouter.ai"];

let currentSavedFilters = [];
// 上次已保存的 Base URL：失焦保存时用于判断是否需要重新请求域名授权
let lastSavedBaseUrl = "";

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

// 通用就地状态提示：写入指定元素并 6 秒后自动清除；
// 每个元素独立定时器，避免多条提示互相干扰
const fieldStatusTimers = new Map();

function showFieldStatus(el, msg, ok) {
  el.textContent = msg;
  el.className = "field-status" + (msg ? (ok ? " ok" : " err") : "");
  const old = fieldStatusTimers.get(el);
  if (old) clearTimeout(old);
  fieldStatusTimers.set(
    el,
    setTimeout(() => {
      el.textContent = "";
      fieldStatusTimers.delete(el);
    }, 6000)
  );
}

function showBaseUrlStatus(msg, ok) {
  showFieldStatus(els.customBaseUrlStatus, msg, ok);
}

// 常驻状态提示：不自动清除，直到下次状态变化覆盖它。
// 用于专注模式这类需要用户持续确认是否生效的反馈
function showPersistentStatus(el, msg, ok) {
  el.textContent = msg;
  el.className = "field-status" + (msg ? (ok ? " ok" : " err") : "");
  const old = fieldStatusTimers.get(el);
  if (old) clearTimeout(old);
  fieldStatusTimers.delete(el);
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
  lastSavedBaseUrl = els.customBaseUrl.value.trim();

  updateModelVisibility(settings.apiProvider);
  els.apiKeyNotice.style.display = settings.apiKey ? "none" : "block";

  if (settings.apiProvider === "openrouter") {
    els.modelSelect.value = settings.model;
  }

  currentSavedFilters = settings.savedFilters || [];
  renderSavedFilters();
});

// 专注模式状态存在 local 存储（与页面内悬浮按钮共用同一份）
loadFocusMode(els.focusMode);

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

// 专注模式开关：写入 local 存储后通知所有 x.com 标签页立即生效
// 同步结果在开关下方就地反馈，便于判断是"已生效"还是"标签页未响应"
bindFocusModeToggle(els.focusMode, (msg, ok) => {
  showPersistentStatus(els.focusModeStatus, msg, ok);
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

els.customBaseUrl.addEventListener("blur", () => {
  const urlText = els.customBaseUrl.value.trim();
  if (!urlText) {
    if (lastSavedBaseUrl) {
      save("customBaseUrl", "");
      lastSavedBaseUrl = "";
    }
    return;
  }

  // 校验 URL 格式：非法则不保存并提示
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

  const changed = urlText !== lastSavedBaseUrl;
  lastSavedBaseUrl = urlText;

  // 值未变化或内置厂商域名时无需请求授权
  if (!changed || BUILTIN_ORIGINS.includes(origin)) return;

  // 值变化的自定义域名请求授权，结果仅用于覆盖提示：
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

els.apiKey.addEventListener("blur", () => {
  // 失焦即保存（storage 写入幂等），不依赖 change 的值比较
  saveApiKey(els.apiKey.value.trim());
  showFieldStatus(els.apiKeyStatus, "API key saved", true);
  els.apiKeyNotice.style.display = els.apiKey.value.trim() ? "none" : "block";
});

els.model.addEventListener("blur", () => {
  // 失焦即保存，并就地提示（openai / custom 模式下的文本输入框）
  save("model", els.model.value.trim());
  showFieldStatus(els.modelStatus, "Model saved", true);
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

// 测试连接功能独立成模块，此处仅负责绑定
bindTestConnection(els, requestOriginPermission);
