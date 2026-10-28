// 真实环境诊断：连到用户正在使用的 Chrome，定位 x.com 页面上的
// content script 隔离世界，在里面 hook 消息发送、统计请求量与转圈推文数。
//
// 用法：node tests/diagnose-real.mjs [port]

const port = process.argv[2] || "9222";

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  const listeners = [];
  let id = 0;
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", (e) => reject(new Error(e.message)));
  });
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
      return;
    }
    for (const fn of listeners) fn(msg);
  });
  return {
    ws,
    ready,
    on: (fn) => listeners.push(fn),
    send(method, params = {}, sessionId) {
      return new Promise((resolve, reject) => {
        const mid = ++id;
        pending.set(mid, { resolve, reject });
        const payload = { id: mid, method, params };
        if (sessionId) payload.sessionId = sessionId;
        ws.send(JSON.stringify(payload));
        setTimeout(() => {
          if (pending.has(mid)) { pending.delete(mid); reject(new Error("timeout " + method)); }
        }, 30000);
      });
    },
  };
}

const browser = connect(`ws://127.0.0.1:${port}/devtools/browser/any`);
await browser.ready;

const { targetInfos } = await browser.send("Target.getTargets");
const page = targetInfos.find((t) => t.type === "page" && t.url === "https://x.com/home");
if (!page) {
  console.log("未找到 https://x.com/home 标签页");
  process.exit(1);
}
console.log(`目标页面: ${page.title} — ${page.url}\n`);

const { sessionId } = await browser.send("Target.attachToTarget", {
  targetId: page.targetId,
  flatten: true,
});

// 收集执行上下文与控制台日志
const contexts = [];
const consoleLogs = [];
browser.on((msg) => {
  if (msg.method === "Runtime.executionContextCreated") {
    contexts.push(msg.params.context);
  }
  if (msg.method === "Runtime.consoleAPICalled") {
    const text = (msg.params.args || [])
      .map((a) => a.value ?? a.description ?? "")
      .join(" ");
    consoleLogs.push({ level: msg.params.type, text });
  }
});

await browser.send("Runtime.enable", {}, sessionId);
await browser.send("Page.enable", {}, sessionId);
await sleep(600);

console.log("=== 执行上下文 ===");
for (const c of contexts) {
  const origin = c.origin || "";
  const name = c.name || "";
  if (origin.includes("extension") || name.includes("extension")) {
    console.log(`  ★ 扩展隔离世界: id=${c.id} name="${name}" origin="${origin}"`);
  } else {
    console.log(`    id=${c.id} name="${name}" origin="${origin}"`);
  }
}

console.log("\n=== 控制台日志 ===");
for (const l of consoleLogs.slice(-20)) {
  console.log(`  [${l.level}] ${l.text.slice(0, 160)}`);
}

const extContext = contexts.find(
  (c) => (c.origin || "").includes("extension") || (c.name || "").includes("extension")
);

if (!extContext) {
  console.log("\n未找到扩展隔离世界（可能扩展未注入该页面）");
  process.exit(1);
}

const ev = async (expr) => {
  const r = await browser.send(
    "Runtime.evaluate",
    { expression: expr, returnByValue: true, awaitPromise: true, contextId: extContext.id },
    sessionId
  );
  if (r.exceptionDetails) {
    return { __error: JSON.stringify(r.exceptionDetails).slice(0, 400) };
  }
  return r.result.value;
};

console.log("\n=== 扩展内部状态（隔离世界） ===");
const internals = await ev(`(() => ({
  TweetStore: typeof TweetStore,
  TweetDom: typeof TweetDom,
  判定缓存数: typeof TweetStore !== 'undefined' ? TweetStore.getVerdict ? '可访问' : 'n/a' : 'n/a',
}))()`);
console.log(JSON.stringify(internals, null, 2));

// 确认 content script 加载的是哪一版：读取构建标记
const buildInfo = await ev(`(() => {
  // content script 在加载时打印构建标记，这里用脚本特征反查版本
  return {
    有pending标记逻辑: typeof TweetDom !== 'undefined' && typeof TweetDom.markPending === 'function',
    有状态层: typeof TweetStore !== 'undefined',
  };
})()`);
console.log("版本特征:", JSON.stringify(buildInfo));

process.exit(0);

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
