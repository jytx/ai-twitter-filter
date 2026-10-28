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
// onFeedback 用于在界面上反馈同步结果（成功 / 有标签页未响应）
export function bindFocusModeToggle(checkbox, onFeedback) {
  checkbox.addEventListener("change", () => {
    const focusMode = checkbox.checked;
    chrome.storage.local.set({ focusMode });

    chrome.tabs.query({ url: X_TAB_URL_PATTERNS }, (tabs) => {
      // 统计未能送达的标签页：多为扩展重载前打开、页面内仍是旧 content script
      let failed = 0;
      const sendPromises = tabs.map((tab) =>
        chrome.tabs
          .sendMessage(tab.id, { type: "FOCUS_MODE_UPDATED", focusMode })
          .then(() => null)
          .catch(() => {
            failed++;
            return tab.id;
          })
      );

      Promise.all(sendPromises).then((failedIds) => {
        if (!onFeedback) return;
        if (tabs.length === 0) {
          onFeedback("已保存。当前没有打开的 X 页面", false);
        } else if (failedIds.length === 0) {
          onFeedback(
            `已应用到 ${tabs.length} 个标签页`,
            true
          );
        } else {
          // 未能直送的标签页：内容脚本自身的 storage 监听会兜底，
          // 但仍提示刷新以确保生效
          onFeedback(
            `已保存，${failedIds.length}/${tabs.length} 个标签页未响应（刷新页面即可生效）`,
            false
          );
        }
      });
    });
  });
}
