// popup 的"Test Connection"功能：用当前配置发一次最小真实请求，
// 验证地址可达、密钥有效、模型可用；错误信息直接回显帮助定位

import { getApiUrl } from "./providers.js";

// 测试请求超时（毫秒）：慢模型冷启动也可能较久，给足余量
const TEST_TIMEOUT_MS = 20000;

// 在测试按钮旁展示结果：ok 为 true 绿色、false 红色
function showTestResult(el, msg, ok) {
  el.textContent = msg;
  el.className = "test-result" + (msg ? (ok ? " ok" : " err") : "");
}

// 绑定测试按钮：所有依赖的 DOM 元素与权限申请函数由调用方注入，
// 避免本模块与 popup 的元素查找耦合
export function bindTestConnection(els, requestOriginPermission) {
  const runTest = async () => {
    const provider = els.apiProvider.value;
    const apiKey = els.apiKey.value.trim();
    const model =
      provider === "openrouter" ? els.modelSelect.value : els.model.value.trim();
    const customBaseUrl = els.customBaseUrl.value.trim();

    if (provider === "custom" && !customBaseUrl) {
      showTestResult(els.testResult, "Fill in the Base URL first", false);
      return;
    }
    if (!apiKey) {
      showTestResult(els.testResult, "Fill in the API key first", false);
      return;
    }
    if (!model) {
      showTestResult(els.testResult, "Fill in the model name first", false);
      return;
    }

    const url = getApiUrl({ apiProvider: provider, customBaseUrl });

    // 自定义域名需先获得授权（按钮点击属于用户手势，可弹出权限请求）
    const granted = await requestOriginPermission(url);
    if (!granted) {
      showTestResult(els.testResult, "Permission denied for this domain", false);
      return;
    }

    els.testConnection.disabled = true;
    els.testConnection.textContent = "Testing...";
    showTestResult(els.testResult, "", true);

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
        showTestResult(els.testResult, "Connected — API works", true);
      } else {
        const errText = (await res.text()).slice(0, 120);
        showTestResult(els.testResult, `HTTP ${res.status} ${errText}`, false);
      }
    } catch (err) {
      const msg =
        err.name === "AbortError"
          ? `Timed out after ${TEST_TIMEOUT_MS / 1000}s`
          : "Network error — check the URL";
      showTestResult(els.testResult, msg, false);
    } finally {
      clearTimeout(timer);
      els.testConnection.disabled = false;
      els.testConnection.textContent = "Test Connection";
    }
  };

  els.testConnection.addEventListener("click", runTest);
}
