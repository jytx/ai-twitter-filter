// 判定提示词与隐藏原因文案处理。
//
// 单独成模块的原因：提示词是唯一决定"隐藏原因"文案的地方，
// 与判定调度（并发、缓存）、消息通信关注点不同，独立出来便于维护与单独测试。

// 判定提示词版本：提示词的实质内容变化时递增。
//
// 判定结果被持久化在 chrome.storage.session 中，Service Worker 重启会从会话存储
// 恢复缓存。若提示词变了（如隐藏原因的语言要求），缓存里仍是旧提示词产出的结果
// ——用户会继续看到旧文案。缓存按版本分区，版本不一致时整体作废。
export const PROMPT_VERSION = 2;

// 中日韩统一表意文字区间：用于判断模型返回的原因里是否真的含中文
const CJK_PATTERN = /[\u4e00-\u9fff]/;

// 构造系统提示词。
//
// filterPrompt 为用户在 popup 中填写的筛选标准，原样注入给模型。
// 隐藏原因（reason）会被直接展示在折叠横幅上，因此明确要求使用简体中文：
// 模型会模仿提示词中的示例，示例语言即输出语言。
export function buildSystemPrompt(filterPrompt) {
  return `You are a tweet filter. The user has set this filter criteria:

"${filterPrompt}"

You will receive a JSON array of tweets, each with an "id" and "text" field.
For each tweet, decide if it should be hidden based on the filter criteria.
Respond with ONLY a JSON array of objects with "id" (string), "hide" (boolean), and "reason" (string) fields.
If hide is false, reason should be an empty string.

The "reason" is displayed directly to the user as a short label next to the hidden tweet.
It MUST be written in Simplified Chinese, no English words allowed, no more than 6 Chinese characters.
Describe why the tweet was hidden, e.g. "负面抱怨", "政治煽动", "垃圾推广", "人身攻击", "焦虑贩卖".
No explanation, no markdown, just the JSON array.`;
}

// 规范化模型返回的隐藏原因。
//
// 模型并非总会遵守"用简体中文"的指令（尤其是较小的模型），直接展示会出现
// 中英混杂的横幅。此处把不含中文的原因视为无效，交由调用方用统一的中文兜底文案，
// 保证横幅上不会出现英文。
export function normalizeReason(reason) {
  if (typeof reason !== "string") return "";
  const trimmed = reason.trim();
  if (!trimmed) return "";
  return CJK_PATTERN.test(trimmed) ? trimmed : "";
}
