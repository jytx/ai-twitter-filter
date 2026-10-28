// 诊断脚本：量化"第一页判定中一直往下拉"场景下的三个指标
//   1. 累计请求条目数        —— 浪费了多少 API 调用
//   2. 累计出现过的转圈推文数 —— 用户视觉上感受到的"一直加载"
//   3. 结束时仍在转圈的推文数
//
// 用法：node tests/diagnose-loading.mjs <debugPort> <projectRoot>

const port = process.argv[2] || "9333";
const root = process.argv[3] || process.cwd();
const fs = await import("node:fs");
const path = await import("node:path");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener("open", () => resolve());
      this.ws.addEventListener("error", (e) => reject(new Error(e.message)));
    });
    this.ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    });
  }
  async send(method, params = {}) {
    await this.ready;
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error("timeout " + method)); }
      }, 20000);
    });
  }
  close() { this.ws.close(); }
}

const mockHtml = fs.readFileSync(path.join(root, "tests/mock-timeline.html"), "utf8");
const uiJs = fs.readFileSync(path.join(root, "ui.js"), "utf8");
const storeJs = fs.readFileSync(path.join(root, "tweet-store.js"), "utf8");
const contentJs = fs.readFileSync(path.join(root, "content.js"), "utf8");

const res = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" });
const target = await res.json();
const cdp = new CDP(target.webSocketDebuggerUrl);
await cdp.send("Page.enable");
await cdp.send("Runtime.enable");
await cdp.send("Page.navigate", { url: "about:blank" });
await sleep(300);
await cdp.send("Runtime.evaluate", {
  expression: `document.open(); document.write(${JSON.stringify(mockHtml)}); document.close();`,
});
await sleep(600);

const evaluate = async (expr) => {
  const r = await cdp.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
  return r.result.value;
};

// 统计"曾经出现过加载动画"的推文数：用 MutationObserver 记录
await evaluate(`
  window.__spinnerSeen = new Set();
  window.__spinnerCount = 0;
  new MutationObserver((muts) => {
    for (const m of muts) {
      for (const n of m.addedNodes) {
        if (n.nodeType !== 1) continue;
        if (n.classList?.contains('ai-filter-loader')) {
          const art = n.closest('article[data-testid="tweet"]');
          if (art && !art.dataset.spinnerMark) {
            art.dataset.spinnerMark = '1';
            window.__spinnerSeen.add(art.dataset.aiFilterHash || ('node' + window.__spinnerCount));
            window.__spinnerCount++;
          }
        }
      }
    }
  }).observe(document.body, { childList: true, subtree: true });
`);

await evaluate(`
  window.__stats = Object.assign({ requests: 0, tweets: 0 }, window.__stats || {});
  window.__settings = { enabled: true, filterReplies: false };
  window.chrome = {
    runtime: {
      sendMessage: (msg) => {
        if (msg.type === "GET_SETTINGS") return Promise.resolve(window.__settings);
        if (msg.type === "EVALUATE_TWEETS") {
          window.__stats.requests += 1;
          window.__stats.tweets += msg.tweets.length;
          return new Promise(() => {});   // 判定永不返回：模拟慢模型
        }
        return Promise.resolve(null);
      },
      onMessage: { addListener: () => {} },
    },
  };
`);

for (const src of [uiJs, storeJs, contentJs]) {
  const r = await cdp.send("Runtime.evaluate", { expression: src });
  if (r.exceptionDetails) throw new Error("脚本注入失败: " + JSON.stringify(r.exceptionDetails));
}

await sleep(1500);

const before = await evaluate(`({
  requests: window.__stats.requests,
  tweets: window.__stats.tweets,
  spinners: window.__spinnerCount,
  exposed: window.__stats.exposed,
})`);

// 模拟用户持续向下拉 10 秒
for (let i = 0; i < 40; i++) {
  await evaluate(`window.scrollBy(0, 500);`);
  await sleep(250);
}

const after = await evaluate(`({
  requests: window.__stats.requests,
  tweets: window.__stats.tweets,
  spinners: window.__spinnerCount,
  exposed: window.__stats.exposed,
  spinningNow: document.querySelectorAll('.ai-filter-loader').length,
  scrollY: window.scrollY,
})`);

console.log("\n=========== 诊断：第一页判定中持续下拉 10 秒（判定永不返回）===========\n");
console.log("指标".padEnd(28), "数值");
console.log("-".repeat(52));
console.log("滚动距离(px)".padEnd(28), after.scrollY - before.exposed * 0);
console.log("累计请求批次数".padEnd(28), after.requests);
console.log("累计请求条目数".padEnd(28), after.tweets);
console.log("累计出现过的转圈推文数".padEnd(28), after.spinners);
console.log("结束时仍在转圈的推文数".padEnd(28), after.spinningNow);
console.log("滚动中新暴露的推文数".padEnd(28), after.exposed - before.exposed);
console.log("-".repeat(52));
console.log("\n判读：");
console.log(`  · 累计请求 ${after.tweets} 条，用户滚动中新看到 ${after.exposed - before.exposed} 条`);
console.log(`  · 请求/新内容 = ${((after.tweets) / Math.max(1, after.exposed - before.exposed)).toFixed(2)} 倍`);
console.log(`  · 结束时仍有 ${after.spinningNow} 条推文在转圈 —— 即用户看到的"一直加载"`);

process.exit(0);
