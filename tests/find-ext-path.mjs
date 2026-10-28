// 读取浏览器中实际运行的 AI Twitter Filter 扩展信息（版本、内容脚本清单、扩展 ID）
//
// 注意：本脚本刻意不访问 chrome://extensions 页面，也不调用 chrome.developerPrivate。
// 那两类操作会让 Chrome 弹出授权确认，干扰用户正常使用。
// 磁盘路径请在 chrome://extensions 页面手动查看（卡片 → 详细信息 → 来源）。
//
// 用法：node tests/find-ext-path.mjs [port]

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

// ---- 1. 从内容脚本隔离世界读 manifest（只读扩展自身 API，无授权弹窗）----
const page = targetInfos.find(
  (t) => t.type === "page" && t.url.startsWith("https://x.com/")
);

if (page) {
  const { sessionId } = await browser.send("Target.attachToTarget", {
    targetId: page.targetId,
    flatten: true,
  });
  const contexts = [];
  browser.on((m) => {
    if (m.method === "Runtime.executionContextCreated") contexts.push(m.params.context);
  });
  await browser.send("Runtime.enable", {}, sessionId);
  await new Promise((r) => setTimeout(r, 800));

  const extCtxs = contexts.filter((c) => c.name === EXT_NAME);
  const extCtx = extCtxs[extCtxs.length - 1];

  if (extCtx) {
    const ev = async (expr) => {
      const r = await browser.send(
        "Runtime.evaluate",
        { expression: expr, returnByValue: true, awaitPromise: true, contextId: extCtx.id },
        sessionId
      );
      if (r.exceptionDetails) return { __err: JSON.stringify(r.exceptionDetails).slice(0, 300) };
      return r.result.value;
    };

    console.log("=== 扩展 manifest（内容脚本隔离世界）===");
    console.log(JSON.stringify(await ev(
      "(() => { const m = chrome.runtime.getManifest(); return { name: m.name, version: m.version, contentScripts: m.content_scripts[0].js, css: m.content_scripts[0].css }; })()"
    ), null, 2));

    console.log("\n=== 扩展 ID ===");
    console.log(await ev("chrome.runtime.getURL('')"));

    console.log("\n=== 磁盘路径 ===");
    console.log("  请在 chrome://extensions 页面手动查看：");
    console.log("  找到该扩展卡片 → 点“详细信息” → “来源”一栏即为磁盘路径");
  } else {
    console.log("未在 x.com 页面上找到扩展隔离世界（扩展可能未注入该页面）");
  }
} else {
  console.log("未找到 x.com 页面，跳过隔离世界检查");
}

// ---- 2. 从 Service Worker 读实际加载的脚本内容（只读，无副作用）----
console.log("\n=== Service Worker 中的实际脚本 ===");
for (const t of targetInfos.filter((x) => x.type === "service_worker" && x.url.startsWith("chrome-extension://"))) {
  const extId = new URL(t.url).host;
  const { sessionId } = await browser.send("Target.attachToTarget", { targetId: t.targetId, flatten: true });
  await browser.send("Runtime.enable", {}, sessionId);
  const ev = async (expr) => {
    const r = await browser.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, sessionId);
    if (r.exceptionDetails) return null;
    return r.result.value;
  };
  const name = await ev("chrome.runtime.getManifest().name");
  if (name !== EXT_NAME) continue;

  console.log(JSON.stringify(await ev(`(async () => {
    const out = { 扩展ID: chrome.runtime.getURL('') };
    for (const f of ['content.js', 'ui.js', 'tweet-store.js', 'focus.js']) {
      try {
        const t = await (await fetch(chrome.runtime.getURL(f))).text();
        const bm = t.match(/build [0-9A-Za-z._-]+/);
        out[f] = { 字节数: t.length, 构建标记: bm ? bm[0] : '(无)' };
      } catch (e) { out[f] = '未加载'; }
    }
    return out;
  })()`), null, 2));
  console.log(`  (扩展 ID: ${extId})`);
  break;
}

process.exit(0);
