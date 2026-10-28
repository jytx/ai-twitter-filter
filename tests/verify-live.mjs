// 严格验证：刷新 x.com 后，确认浏览器实际运行的是新代码
// 关键：只统计刷新之后新产生的日志（CDP 的 Runtime.enable 会回放历史日志）
// 用法：node tests/verify-live.mjs [port]

const port = process.argv[2] || "9222";

function connect(u) {
  const ws = new WebSocket(u);
  const p = new Map();
  const L = [];
  let id = 0;
  const ready = new Promise((res, rej) => {
    ws.addEventListener("open", res);
    ws.addEventListener("error", (e) => rej(new Error(e.message)));
  });
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (m.id && p.has(m.id)) {
      const h = p.get(m.id);
      p.delete(m.id);
      m.error ? h.reject(new Error(JSON.stringify(m.error))) : h.resolve(m.result);
      return;
    }
    for (const f of L) f(m);
  });
  return {
    ws, ready, on: (f) => L.push(f),
    send(method, params = {}, sessionId) {
      return new Promise((resolve, reject) => {
        const mid = ++id;
        p.set(mid, { resolve, reject });
        const pl = { id: mid, method, params };
        if (sessionId) pl.sessionId = sessionId;
        ws.send(JSON.stringify(pl));
        setTimeout(() => {
          if (p.has(mid)) { p.delete(mid); reject(new Error("timeout " + method)); }
        }, 25000);
      });
    },
  };
}

const b = connect(`ws://127.0.0.1:${port}/devtools/browser/any`);
await b.ready;

const { targetInfos } = await b.send("Target.getTargets");
const page = targetInfos.find((t) => t.type === "page" && t.url === "https://x.com/home");
if (!page) { console.log("未找到 x.com/home 标签页"); process.exit(1); }

const { sessionId } = await b.send("Target.attachToTarget", { targetId: page.targetId, flatten: true });

const contexts = [];
const logs = [];
b.on((m) => {
  if (m.method === "Runtime.executionContextCreated") contexts.push(m.params.context);
  if (m.method === "Runtime.consoleAPICalled") {
    logs.push({
      ts: Date.now(),
      text: (m.params.args || []).map((a) => a.value ?? a.description ?? "").join(" "),
    });
  }
});

await b.send("Runtime.enable", {}, sessionId);
await b.send("Page.enable", {}, sessionId);
await new Promise((r) => setTimeout(r, 500));

// ---- 刷新，并只记录刷新之后产生的日志 ----
const reloadAt = Date.now();
await b.send("Page.reload", { ignoreCache: true }, sessionId);
await new Promise((r) => setTimeout(r, 7000));

const fresh = logs.filter((l) => l.ts >= reloadAt);
console.log("=== 刷新后新产生的扩展日志 ===");
for (const l of fresh) {
  console.log("  " + l.text.slice(0, 140));
}

const buildMatch = fresh.find((l) => l.text.includes("Content script loaded"));
const build = buildMatch ? (buildMatch.text.match(/build [0-9A-Za-z._-]+/) || ["未知"])[0] : "未捕获到";

console.log(`\n实际运行的构建版本: ${build}`);
console.log(build === "build 1.2.0" ? "✓ 新代码已生效" : "✗ 仍是旧代码");

// ---- 读取扩展隔离世界的内部状态（刷新后上下文 ID 会变，取最新的一个）----
const extCtxs = contexts.filter((c) => c.name === "AI Twitter Filter");
const extCtx = extCtxs[extCtxs.length - 1];
const ev = async (expr, ctxId) => {
  const r = await b.send(
    "Runtime.evaluate",
    { expression: expr, returnByValue: true, awaitPromise: true, ...(ctxId ? { contextId: ctxId } : {}) },
    sessionId
  );
  if (r.exceptionDetails) return { __err: JSON.stringify(r.exceptionDetails).slice(0, 250) };
  return r.result.value;
};

console.log("\n=== 扩展隔离世界内部状态 ===");
console.log(JSON.stringify(await ev(
  "({ TweetStore: typeof TweetStore, TweetDom: typeof TweetDom, hideChildren: typeof hideChildren })",
  extCtx?.id
), null, 2));

console.log("\n=== 页面 DOM 状态 ===");
const dom = await ev(`(() => {
  const arts = [...document.querySelectorAll('article[data-testid="tweet"]')];
  const loaders = document.querySelectorAll('.ai-filter-loader');
  const banners = document.querySelectorAll('.ai-filter-banner');
  const pending = document.querySelectorAll('article[data-ai-filter-pending="true"]');
  const heights = [...pending].map(a => Math.round(a.getBoundingClientRect().height));
  return {
    推文数: arts.length,
    转圈中: loaders.length,
    折叠横幅: banners.length,
    判定中标记: pending.length,
    判定中高度: heights.slice(0, 8),
    视口高度: window.innerHeight,
  };
})()`);
console.log(JSON.stringify(dom, null, 2));

process.exit(0);
