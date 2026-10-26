// 厂商相关的共享工具：popup 与 background（两个不同执行上下文）共用，避免 URL 拼接逻辑漂移

// 根据设置返回 chat completions 的完整请求地址
export function getApiUrl(settings) {
  if (settings.apiProvider === "openrouter") {
    return "https://openrouter.ai/api/v1/chat/completions";
  }
  // 自定义厂商：按 OpenAI 兼容规范，在用户填写的 Base URL 后拼接 chat/completions
  if (settings.apiProvider === "custom" && settings.customBaseUrl) {
    return settings.customBaseUrl.trim().replace(/\/+$/, "") + "/chat/completions";
  }
  return "https://api.openai.com/v1/chat/completions";
}
