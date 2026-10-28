// 真实环境验证：在用户实际使用的 x.com 时间线上滚动，
// 测量判定中推文的高度与转圈数量，验证"高度塌缩"问题是否已消除。
//
// 注意：本脚本会真实滚动页面，会打断用户当前的浏览位置。
// 确需执行时再手动运行，不要放进常规检查流程。
// 用法：node tests/verify-scroll-real.mjs [port]

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
// 优先选时间线首页（真实使用场景），没有再退回任意 x.com 页面
const candidates = targetInfos.filter((t) => t.type === "page" && t.url.startsWith("https://x.com/"));
const page =
  candidates.find((t) => t.url === "https://x.com/home") ||
  candidates.find((t) => t.url.includes("/home")) ||
  candidates[0];
if (!page) { console.log("未找到 x.com 标签页"); process.exit(1); }
console.log(`目标页面: ${page.title.slice(0, 50)} — ${page.url}\n`);

const { sessionId } = await b.send("Target.attachToTarget", { targetId: page.targetId, flatten: true });
const contexts = [];
b.on((m) => {
  if (m.method === "Runtime.executionContextCreated") contexts.push(m.params.context);
});
await b.send("Runtime.enable", {}, sessionId);
await new Promise((r) => setTimeout(r, 1000));

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

// 在扩展隔离世界里安装采样器：统计出现过的判定推文与当前转圈情况
await ev(`(() => {
  window.__seenHashes = new Set();
  window.__spinnerEver = 0;
  const scan = () => {
    for (const a of document.querySelectorAll('article[data-ai-filter-hash]')) {
      if (a.dataset.aiFilterHash) window.__seenHashes.add(a.dataset.aiFilterHash);
    }
    window.__spinnerEver = Math.max(window.__spinnerEver, document.querySelectorAll('.ai-filter-loader').length);
  };
  window.__scanTimer = setInterval(scan, 120);
  scan();
  return true;
})()`, extCtx.id);

const sample = async () =>
  await ev(`(() => {
    const arts = [...document.querySelectorAll('article[data-testid="tweet"]')];
    const pending = [...document.querySelectorAll('article[data-ai-filter-pending="true"]')];
    const heights = pending.map(a => Math.round(a.getBoundingClientRect().height));
    return {
      推文数: arts.length,
      判定中: pending.length,
      判定中高度: heights,
      转圈中: document.querySelectorAll('.ai-filter-loader').length,
      横幅: document.querySelectorAll('.ai-filter-banner').length,
      已判定推文数: window.__seenHashes ? window.__seenHashes.size : 0,
      历史最大转圈数: window.__spinnerEver,
      滚动位置: Math.round(window.scrollY),
    };
  })()`, extCtx.id);

// 等待时间线加载
console.log("等待时间线加载...");
for (let i = 0; i < 20; i++) {
  const s = await sample();
  if (s.推文数 > 5) break;
  await new Promise((r) => setTimeout(r, 1000));
}

const before = await sample();
console.log("滚动前:", JSON.stringify(before, null, 2));

// 模拟用户持续下拉
console.log("\n模拟持续下拉 15 秒...");
for (let i = 0; i < 30; i++) {
  await ev(`window.scrollBy(0, 600);`);
  await new Promise((r) => setTimeout(r, 500));
}

const after = await sample();
console.log("\n滚动后:", JSON.stringify(after, null, 2));

// 汇总
const heights = after.判定中高度;
const minH = heights.length ? Math.min(...heights) : null;
console.log("\n=========== 判定 ===========");
console.log(`判定中推文高度: ${heights.length ? Math.min(...heights) + '~' + Math.max(...heights) + 'px' : '无（无推文卡在判定中）'}`);
console.log(`历史最大同时转圈数: ${after.历史最大转圈数}`);
console.log(`滚动中新增已判定推文: ${after.已判定推文数 - before.已判定推文数}`);

const ok1 = heights.length === 0 || minH >= 120;
console.log(`\n[${ok1 ? "PASS" : "FAIL"}] 判定中的推文未被压缩成 44px（保持原始高度）`);
const ok2 = after.历史最大转圈数 <= 12;
console.log(`[${ok2 ? "PASS" : "FAIL"}] 同时转圈的推文数在合理范围（≤12）`);

process.exit(ok1 && ok2 ? 0 : 1);
