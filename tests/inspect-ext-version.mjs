// 读取浏览器中实际运行的 AI Twitter Filter 扩展代码版本
// 用法：node tests/inspect-ext-version.mjs [port]

const port = process.argv[2] || "9222";
const EXT_NAME = "AI Twitter Filter";

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
    ws, ready,
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
        }, 20000);
      });
    },
  };
}

const browser = connect(`ws://127.0.0.1:${port}/devtools/browser/any`);
await browser.ready;

const { targetInfos } = await browser.send("Target.getTargets");

// ---- 1. 从 Service Worker 读 manifest ----
console.log("=== Service Worker 中的扩展信息 ===");
for (const t of targetInfos.filter((x) => x.type === "service_worker" && x.url.startsWith("chrome-extension://"))) {
  const extId = new URL(t.url).host;
  const { sessionId } = await browser.send("Target.attachToTarget", { targetId: t.targetId, flatten: true });
  await browser.send("Runtime.enable", {}, sessionId);
  const ev = async (expr) => {
    const r = await browser.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, sessionId);
    if (r.exceptionDetails) return { __err: JSON.stringify(r.exceptionDetails).slice(0, 200) };
    return r.result.value;
  };
  const name = await ev("chrome.runtime.getManifest().name");
  if (name === EXT_NAME) {
    console.log(`★ 命中扩展: ${extId}`);
    const info = await ev(`(async () => {
      const m = chrome.runtime.getManifest();
      const out = { version: m.version, contentScripts: m.content_scripts && m.content_scripts[0] && m.content_scripts[0].js };
      for (const f of ['content.js', 'ui.js', 'tweet-store.js']) {
        try {
          const t = await (await fetch(chrome.runtime.getURL(f))).text();
          const bm = t.match(/build [0-9A-Za-z._-]+/);
          out[f] = { bytes: t.length, build: bm ? bm[0] : '(无构建标记)', hasMarkPending: t.includes('markPending') };
        } catch (e) { out[f] = 'ERR ' + e.message; }
      }
      return out;
    })()`);
    console.log(JSON.stringify(info, null, 2));
    break;
  }
}

// ---- 2. 从页面隔离世界读全局对象 ----
const page = targetInfos.find((t) => t.type === "page" && t.url === "https://x.com/home");
if (page) {
  const { sessionId } = await browser.send("Target.attachToTarget", { targetId: page.targetId, flatten: true });
  const contexts = [];
  browser.on((m) => {
    if (m.method === "Runtime.executionContextCreated") contexts.push(m.params.context);
  });
  await browser.send("Runtime.enable", {}, sessionId);
  await new Promise((r) => setTimeout(r, 800));

  const extCtx = contexts.find((c) => c.name === EXT_NAME);
  if (extCtx) {
    const ev = async (expr) => {
      const r = await browser.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true, contextId: extCtx.id }, sessionId);
      if (r.exceptionDetails) return { __err: JSON.stringify(r.exceptionDetails).slice(0, 250) };
      return r.result.value;
    };
    console.log("\n=== 页面隔离世界中的全局对象 ===");
    console.log(JSON.stringify(await ev(
      "({ TweetStore: typeof TweetStore, TweetDom: typeof TweetDom, hideChildren: typeof hideChildren, processedHashes: typeof processedHashes })"
    ), null, 2));

    console.log("\n=== 扩展内部实时状态 ===");
    console.log(JSON.stringify(await ev(
      "({ 判定缓存条数: typeof processedHashes !== 'undefined' ? processedHashes.size : 'n/a', 待判定条数: typeof pendingTweets !== 'undefined' ? pendingTweets.size : 'n/a' })"
    ), null, 2));
  }
}

process.exit(0);
