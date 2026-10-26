const DEFAULT_SETTINGS = {
  enabled: true,
  apiProvider: "openai",
  apiKey: "",
  model: "gpt-4o-mini",
  filterPrompt:
    "Is this tweet negative, toxic, or complaining? Reply with true to hide it, false to keep it.",
  savedFilters: [],
};

const els = {
  enabled: document.getElementById("enabled"),
  apiProvider: document.getElementById("apiProvider"),
  apiKey: document.getElementById("apiKey"),
  model: document.getElementById("model"),
  modelTextField: document.getElementById("modelTextField"),
  modelSelect: document.getElementById("modelSelect"),
  modelSelectField: document.getElementById("modelSelectField"),
  apiKeyNotice: document.getElementById("apiKeyNotice"),
  savedFilters: document.getElementById("savedFilters"),
  deleteSavedFilter: document.getElementById("deleteSavedFilter"),
  filterPrompt: document.getElementById("filterPrompt"),
  saveFilter: document.getElementById("saveFilter"),
  status: document.getElementById("status"),
};

let currentSavedFilters = [];

function updateModelVisibility(provider) {
  if (provider === "openrouter") {
    els.modelTextField.style.display = "none";
    els.modelSelectField.style.display = "";
  } else {
    els.modelTextField.style.display = "";
    els.modelSelectField.style.display = "none";
  }
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

function showStatus(msg) {
  els.status.textContent = msg;
  setTimeout(() => {
    els.status.textContent = "";
  }, 2000);
}

// Load saved settings（经 background 读取，密钥会从本地存储获取并完成旧版迁移）
chrome.runtime.sendMessage({ type: "GET_SETTINGS" }, (settings) => {
  if (chrome.runtime.lastError || !settings) settings = DEFAULT_SETTINGS;
  els.enabled.checked = settings.enabled;
  els.apiProvider.value = settings.apiProvider;
  els.apiKey.value = settings.apiKey;
  els.model.value = settings.model;
  els.filterPrompt.value = settings.filterPrompt;

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

els.apiProvider.addEventListener("change", () => {
  const provider = els.apiProvider.value;
  save("apiProvider", provider);
  updateModelVisibility(provider);

  if (provider === "openrouter") {
    save("model", els.modelSelect.value);
  } else {
    save("model", "gpt-4o-mini");
    els.model.value = "gpt-4o-mini";
  }
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
