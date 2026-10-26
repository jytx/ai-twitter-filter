// popup 中的专注模式开关：与页面内悬浮按钮共用 chrome.storage.local 的 focusMode
// 状态写入后广播到所有 x.com 标签页，实现跨标签页实时生效

const X_TAB_URL_PATTERNS = ["https://x.com/*", "https://twitter.com/*"];

// 读取当前专注模式状态并回填勾选框
export function loadFocusMode(checkbox) {
  chrome.storage.local.get("focusMode", (data) => {
    checkbox.checked = data.focusMode === true;
  });
}

// 切换专注模式：写入本地存储并通知所有 x.com 标签页
export function bindFocusModeToggle(checkbox) {
  checkbox.addEventListener("change", () => {
    const focusMode = checkbox.checked;
    chrome.storage.local.set({ focusMode });

    chrome.tabs.query({ url: X_TAB_URL_PATTERNS }, (tabs) => {
      for (const tab of tabs) {
        chrome.tabs
          .sendMessage(tab.id, { type: "FOCUS_MODE_UPDATED", focusMode })
          .catch(() => {
            // 标签页可能尚未加载内容脚本，忽略
          });
      }
    });
  });
}
