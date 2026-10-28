// 从 AI Twitter Filter 的内容脚本隔离世界读取 manifest 与磁盘线索
// 并打开 chrome://extensions 读取扩展的磁盘路径
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
const page = targetInfos.find((t) => t.type === "page" && t.url === "https://x.com/home");

const { sessionId } = await browser.send("Target.attachToTarget", { targetId: page.targetId, flatten: true });
const contexts = [];
browser.on((m) => {
  if (m.method === "Runtime.executionContextCreated") contexts.push(m.params.context);
});
await browser.send("Runtime.enable", {}, sessionId);
await new Promise((r) => setTimeout(r, 800));

const extCtx = contexts.find((c) => c.name === EXT_NAME);
const ev = async (expr) => {
  const r = await browser.send(
    "Runtime.evaluate",
    { expression: expr, returnByValue: true, awaitPromise: true, contextId: extCtx.id },
    sessionId
  );
  if (r.exceptionDetails) return { __err: JSON.stringify(r.exceptionDetails).slice(0, 300) };
  return r.result.value;
};

console.log("=== 扩展 manifest（来自内容脚本隔离世界）===");
console.log(JSON.stringify(await ev(
  "(() => { const m = chrome.runtime.getManifest(); return { name: m.name, version: m.version, contentScripts: m.content_scripts[0].js, css: m.content_scripts[0].css }; })()"
), null, 2));

console.log("\n=== 扩展自身 URL ===");
console.log(await ev("chrome.runtime.getURL('')"));

// 打开 chrome://extensions 读取磁盘路径
console.log("\n=== 读取 chrome://extensions 中的路径信息 ===");
const { targetId } = await browser.send("Target.createTarget", { url: "chrome://extensions/" });
await new Promise((r) => setTimeout(r, 2500));

const { sessionId: extPageSession } = await browser.send("Target.attachToTarget", { targetId, flatten: true });
await browser.send("Runtime.enable", {}, extPageSession);

const extPageEv = async (expr) => {
  const r = await browser.send(
    "Runtime.evaluate",
    { expression: expr, returnByValue: true, awaitPromise: true },
    extPageSession
  );
  if (r.exceptionDetails) return { __err: JSON.stringify(r.exceptionDetails).slice(0, 300) };
  return r.result.value;
};

const info = await extPageEv(`(() => {
  const manager = document.querySelector('extensions-manager');
  const list = manager && manager.shadowRoot.querySelector('extensions-item-list');
  if (!list) return { err: '未找到扩展列表', html: document.body.innerHTML.slice(0, 300) };
  const items = list.shadowRoot.querySelectorAll('extensions-item');
  const out = [];
  for (const it of items) {
    const nameEl = it.shadowRoot.querySelector('#name');
    const name = nameEl ? nameEl.textContent.trim() : '?';
    if (!name.includes('Twitter')) continue;
    const idEl = it.shadowRoot.querySelector('#extension-id');
    // 来源路径在 tooltip / 描述区域
    const desc = it.shadowRoot.querySelector('#description');
    const tooltip = it.shadowRoot.querySelector('#tooltip');
    out.push({
      name,
      id: idEl ? idEl.textContent.trim() : '?',
      desc: desc ? desc.textContent.trim() : '',
      tooltip: tooltip ? tooltip.textContent.trim() : '',
    });
  }
  return out;
})()`);

console.log(JSON.stringify(info, null, 2));

await browser.send("Target.closeTarget", { targetId });
process.exit(0);
