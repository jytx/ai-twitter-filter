// 修复前后对比：用同一套模拟时间线，分别加载修复前（git HEAD）与修复后的扩展脚本，
// 测量“第一页判定中继续滚动”场景下的请求量与推文高度。
//
// 这是修复有效性的直接证据：修复前推文被压缩成 44px，虚拟列表为填满视口
// 需挂载数倍推文，请求量随之放大；修复后两者回到同一量级。
//
// 用法：node tests/compare-legacy.mjs <debugPort> <projectRoot>

const port = process.argv[2] || "9333";
const root = process.argv[3] || process.cwd();
const fs = await import("node:fs");
const path = await import("node:path");
const { execFileSync } = await import("node:child_process");

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

// 对照基线固定到具体 commit，不用分支名——分支指针会移动，用名字取到的
// 可能是修复后的代码，对比就失去意义。
// 111d053 是用户浏览器中实际运行的版本（build 1.1.1，含专注模式但不含本次修复）
const BASELINE_REF = "111d053";

function gitShow(file) {
  return execFileSync("git", ["show", `${BASELINE_REF}:${file}`], { cwd: root, encoding: "utf8" });
}

const VARIANTS = {
  legacy: {
    label: "修复前",
    scripts: () => [gitShow("ui.js"), gitShow("content.js")],
  },
  fixed: {
    label: "修复后",
    scripts: () => [
      fs.readFileSync(path.join(root, "ui.js"), "utf8"),
      fs.readFileSync(path.join(root, "tweet-store.js"), "utf8"),
      fs.readFileSync(path.join(root, "content.js"), "utf8"),
    ],
  },
};

async function openPage() {
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
  return { cdp, targetId: target.id };
}

async function evaluate(cdp, expression) {
  const r = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
  return r.result.value;
}

// chrome.runtime 模拟：同时兼容 Promise 与回调两种调用形式
const CHROME_MOCK = `
  window.__requests = [];
  window.__settings = { enabled: true, filterReplies: false };
  // 合并计数：不能整体覆盖，否则会丢掉模拟页面已经记录的统计项
  window.__stats = Object.assign({ requests: 0, tweets: 0 }, window.__stats || {});
  window.chrome = {
    runtime: {
      sendMessage: (msg, cb) => {
        if (msg.type === "GET_SETTINGS") {
          if (typeof cb === "function") { cb(window.__settings); return; }
          return Promise.resolve(window.__settings);
        }
        if (msg.type === "EVALUATE_TWEETS") {
          window.__requests.push(msg.tweets.map(t => t.hash));
          window.__stats.requests += 1;
          window.__stats.tweets += msg.tweets.length;
          // 判定一直不返回：模拟慢模型 / 排队中的请求
          const p = new Promise(() => {});
          if (typeof cb === "function") return;
          return p;
        }
        if (typeof cb === "function") { cb(null); return; }
        return Promise.resolve(null);
      },
      onMessage: { addListener: () => {} },
    },
  };
`;

// 测量判定中推文的高度：两版的"判定中"标识不同，需同时识别
//   修复前：插入 .ai-filter-loader 占位动画
//   修复后：只加 data-ai-filter-pending 标记，不改推文尺寸
const PENDING_HEIGHT_EXPR = `
  (() => {
    const nodes = [
      ...[...document.querySelectorAll('.ai-filter-loader')].map((l) => l.closest('article')),
      ...[...document.querySelectorAll('article[data-ai-filter-pending="true"]')],
    ];
    return [...new Set(nodes.filter(Boolean))]
      .map((a) => Math.round(a.getBoundingClientRect().height));
  })()
`;

async function measure(variantKey) {
  const variant = VARIANTS[variantKey];
  const { cdp, targetId } = await openPage();
  try {
    await evaluate(cdp, CHROME_MOCK);
    // 注入当前版本的样式，保证两侧的渲染条件一致
    await evaluate(cdp, `(() => {
      const style = document.createElement("style");
      style.textContent = ${JSON.stringify(fs.readFileSync(path.join(root, "styles.css"), "utf8"))};
      document.head.appendChild(style);
    })()`);
    for (const src of variant.scripts()) {
      const r = await cdp.send("Runtime.evaluate", { expression: src });
      if (r.exceptionDetails) throw new Error(`脚本注入失败: ${JSON.stringify(r.exceptionDetails)}`);
    }

    await sleep(1500); // 等待首批判定发出（判定不返回，保持 pending 状态）

    const before = await evaluate(
      cdp,
      `({
        tweets: window.__stats.tweets,
        exposed: window.__stats.exposed,
        band: window.__stats.band,
        mounted: window.__stats.mounted,
        scrollY: window.scrollY,
        pendingHeights: ${PENDING_HEIGHT_EXPR},
      })`
    );

    // 模拟用户持续向下滚动
    for (let i = 0; i < 10; i++) {
      await evaluate(cdp, `window.scrollBy(0, 600);`);
      await sleep(200);
    }
    await sleep(1500);

    const after = await evaluate(
      cdp,
      `({
        tweets: window.__stats.tweets,
        exposed: window.__stats.exposed,
        band: window.__stats.band,
        mounted: window.__stats.mounted,
        maxMounted: window.__stats.maxMounted,
        scrollY: window.scrollY,
        pendingHeights: ${PENDING_HEIGHT_EXPR},
      })`
    );

    return { before, after };
  } finally {
    cdp.close();
    await fetch(`http://127.0.0.1:${port}/json/close/${targetId}`).catch(() => {});
  }
}

const legacy = await measure("legacy");
const fixed = await measure("fixed");

function summarize(m) {
  const newTweets = m.after.tweets - m.before.tweets;
  const newExposed = m.after.exposed - m.before.exposed;
  const newBand = m.after.band - m.before.band;
  const heights = [...m.before.pendingHeights, ...m.after.pendingHeights].filter((h) => h > 0);
  const scrolled = m.after.scrollY - m.before.scrollY;
  return {
    "判定中推文高度(px)": heights.length ? `${Math.min(...heights)}~${Math.max(...heights)}` : "无",
    "滚动距离(px)": scrolled,
    "滚动中新进入观察带": newBand,
    "滚动中新暴露推文": newExposed,
    "滚动中新发请求条目": newTweets,
    "请求/观察带 比值": newBand ? (newTweets / newBand).toFixed(2) : "-",
    "挂载推文峰值": m.after.maxMounted,
  };
}

const l = summarize(legacy);
const f = summarize(fixed);

console.log("\n=========== 场景：第一页判定中继续向下滚动（判定始终未返回）===========\n");
console.log("指标".padEnd(24), "修复前".padEnd(14), "修复后");
console.log("-".repeat(62));
for (const key of Object.keys(l)) {
  console.log(key.padEnd(24), String(l[key]).padEnd(14), String(f[key]));
}
console.log("-".repeat(62));
console.log("\n说明：观察带 = 视口上下各 800px，与扩展 IntersectionObserver 的 rootMargin 一致，");
console.log("      即扩展实际会触发判定的范围。推文被压缩时，同样距离内能进入观察带的");
console.log("      推文数暴增，判定请求随之暴增 —— 这就是线上“滚了很多次、数据没增加”的成因。");

const legacyBand = l["滚动中新进入观察带"];
const fixedBand = f["滚动中新进入观察带"];
const legacyH = parseInt(String(l["判定中推文高度(px)"]).split("~")[0], 10);
const fixedH = parseInt(String(f["判定中推文高度(px)"]).split("~")[0], 10);

const checks = [
  {
    name: "修复前：判定中推文被压缩到 44px 左右（问题存在）",
    ok: legacyH < 100,
    detail: `实际高度 ${l["判定中推文高度(px)"]}`,
  },
  {
    name: "修复后：判定中推文保持原始高度",
    ok: fixedH >= 150,
    detail: `实际高度 ${f["判定中推文高度(px)"]}`,
  },
  {
    name: "修复后：同样滚动距离内进入观察带的推文数明显减少",
    ok: fixedBand < legacyBand * 0.75,
    detail: `观察带推文数 ${legacyBand} → ${fixedBand}（减少 ${(((legacyBand - fixedBand) / legacyBand) * 100).toFixed(0)}%）`,
  },
  {
    name: "修复后：请求量与观察带推文数一致（无漏判也无放大）",
    ok: Math.abs(parseFloat(f["请求/观察带 比值"]) - 1) <= 0.35,
    detail: `请求/观察带 = ${f["请求/观察带 比值"]}（修复前 ${l["请求/观察带 比值"]}）`,
  },
];

let failures = 0;
console.log("\n--- 判定 ---\n");
for (const c of checks) {
  if (!c.ok) failures++;
  console.log(`[${c.ok ? "PASS" : "FAIL"}] ${c.name} — ${c.detail}`);
}
console.log(`\n${checks.length - failures}/${checks.length} 项通过`);
process.exit(failures > 0 ? 1 : 0);
