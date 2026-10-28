// 扩展行为测试：用 CDP 驱动无头 Chrome，加载真实扩展脚本（ui.js / tweet-store.js / content.js），
// 在模拟 X 时间线页面上验证以下行为：
//
//  1. 判定期间推文保持原始高度（不塌缩），避免虚拟列表补拉
//  2. 第一页判定中继续滚动，请求数不出现暴涨（核心回归用例）
//  3. 模型漏答的推文不会永远卡在 Checking 状态
//  4. 相同文本的多个推文实例只产生一次请求
//
// 用法：node tests/extension-tests.mjs <debugPort> <projectRoot>

const port = process.argv[2] || "9333";
const root = process.argv[3] || process.cwd();
const fs = await import("node:fs");
const path = await import("node:path");

const results = [];
let failures = 0;

function check(name, ok, detail) {
  results.push({ name, ok, detail });
  if (!ok) failures++;
  const mark = ok ? "PASS" : "FAIL";
  console.log(`[${mark}] ${name}${detail ? ` — ${detail}` : ""}`);
}

// ---- 极简 CDP 客户端（用 Node 内置 fetch + WebSocket）----
class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener("open", () => resolve());
      this.ws.addEventListener("error", (e) => reject(new Error(`WS 错误: ${e.message}`)));
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

  async send(method, params = {}, sessionId) {
    await this.ready;
    const id = ++this.id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP 超时: ${method}`));
        }
      }, 30000);
    });
  }

  close() {
    this.ws.close();
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJson(path) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  return res.json();
}

// ---- 准备测试页面：把真实扩展脚本注入模拟时间线页面 ----
const mockHtml = fs.readFileSync(path.join(root, "tests/mock-timeline.html"), "utf8");

// 扩展脚本内容
const uiJs = fs.readFileSync(path.join(root, "ui.js"), "utf8");
const storeJs = fs.readFileSync(path.join(root, "tweet-store.js"), "utf8");
const contentJs = fs.readFileSync(path.join(root, "content.js"), "utf8");

async function runScenario({ name, setup, scenario }) {
  // 新建标签页
  const target = await fetchJson(`/json/new?about:blank`).catch(() => null);
  let targetId = target?.id;
  if (!targetId) {
    // 较新版本 Chrome 需要 PUT
    const res = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" });
    const data = await res.json();
    targetId = data.id;
  }
  const targetInfo = (await fetchJson("/json/list")).find((t) => t.id === targetId);
  const cdp = new CDP(targetInfo.webSocketDebuggerUrl);

  try {
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");

    // 注入 mock 页面
    await cdp.send("Page.navigate", { url: "about:blank" });
    await sleep(300);
    await cdp.send("Runtime.evaluate", {
      expression: `document.open(); document.write(${JSON.stringify(mockHtml)}); document.close();`,
    });
    await sleep(500);

    // 安装 chrome.runtime 模拟 + 注入真实扩展脚本
    await cdp.send("Runtime.evaluate", {
      expression: `
        window.__requests = [];
        window.__settings = { enabled: true, filterReplies: false };
        window.__reply = null;
        // 合并计数：不能整体覆盖，否则会丢掉模拟页面已经记录的统计项
        window.__stats = Object.assign({ requests: 0, tweets: 0 }, window.__stats || {});
        window.chrome = {
          runtime: {
            // 与真实 API 一致：返回 Promise，判定结果通过 resolve 送达
            sendMessage: (msg) => {
              if (msg.type === "GET_SETTINGS") {
                return Promise.resolve(window.__settings);
              }
              if (msg.type === "EVALUATE_TWEETS") {
                window.__requests.push(msg.tweets.map(t => t.hash));
                window.__stats.requests += 1;
                window.__stats.tweets += msg.tweets.length;
                if (!window.__reply) {
                  // 判定一直不返回：模拟慢模型 / 排队中的请求
                  return new Promise(() => {});
                }
                return Promise.resolve(window.__reply(msg.tweets));
              }
              return Promise.resolve(null);
            },
            onMessage: { addListener: () => {} },
          },
        };
      `,
    });

    // 注入扩展脚本（ui.js 定义 TweetDom，tweet-store.js 定义 TweetStore，content.js 串联）
    for (const src of [uiJs, storeJs, contentJs]) {
      const r = await cdp.send("Runtime.evaluate", { expression: src });
      if (r.exceptionDetails) {
        throw new Error(`脚本注入失败: ${JSON.stringify(r.exceptionDetails)}`);
      }
    }

    if (setup) await setup(cdp);
    const outcome = await scenario(cdp);
    return outcome;
  } finally {
    cdp.close();
    await fetch(`http://127.0.0.1:${port}/json/close/${targetId}`).catch(() => {});
  }
}

async function evaluate(cdp, expression) {
  const r = await cdp.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.exceptionDetails) {
    throw new Error(`求值异常: ${JSON.stringify(r.exceptionDetails)}`);
  }
  return r.result.value;
}

// ============ 用例 1：判定期间推文保持原始高度 ============
{
  const outcome = await runScenario({
    name: "高度保持",
    setup: async (cdp) => {
      // 模拟慢速 API：让判定一直处于 pending 状态
      await evaluate(cdp, `window.__reply = null;`);
    },
    scenario: async (cdp) => {
      await sleep(1200); // 等待首批判定发出
      return await evaluate(
        cdp,
        `(() => {
          const arts = [...document.querySelectorAll('article[data-testid="tweet"]')];
          const pending = arts.filter(a => a.dataset.aiFilterPending);
          return {
            total: arts.length,
            pending: pending.length,
            pendingHeights: pending.map(a => Math.round(a.getBoundingClientRect().height)),
            stats: window.__stats,
          };
        })()`
      );
    },
  });

  check(
    "判定中的推文保持原始高度（未被压缩成 44px）",
    outcome.pending > 0 && outcome.pendingHeights.every((h) => h >= 150),
    `pending=${outcome.pending} heights=${JSON.stringify(outcome.pendingHeights.slice(0, 5))}`
  );
}

// ============ 用例 2：核心回归——第一页判定中继续滚动，请求量不放大 ============
//
// 判定一直不返回（模拟慢模型 / 排队中的请求），此时推文处于“判定中”状态。
// 关键指标是“每滚动一屏所暴露的推文数”：
//   推文被压缩成 44px 时，同样一屏能暴露的推文数翻数倍，
//   扩展的请求量也随之翻数倍 —— 这正是线上“滚了好多次、数据却没增加”的现象。
// 修复后推文保持原始高度，暴露数与请求数应保持在同一量级。
{
  const outcome = await runScenario({
    name: "滚动不放大",
    setup: async (cdp) => {
      // 判定一直不返回（模拟慢模型 / 排队中的请求）
      await evaluate(cdp, `window.__reply = null;`);
    },
    scenario: async (cdp) => {
      await sleep(1200);
      const before = await evaluate(
        cdp,
        `({
          tweets: window.__stats.tweets,
          exposed: window.__stats.exposed,
          mounted: window.__stats.mounted,
        })`
      );

      // 模拟用户持续向下滚动（固定步长）
      const SCROLL_STEP = 600;
      const STEPS = 10;
      for (let i = 0; i < STEPS; i++) {
        await evaluate(cdp, `window.scrollBy(0, ${SCROLL_STEP});`);
        await sleep(200);
      }
      await sleep(1200);

      const after = await evaluate(
        cdp,
        `({
          tweets: window.__stats.tweets,
          exposed: window.__stats.exposed,
          mounted: window.__stats.mounted,
          maxMounted: window.__stats.maxMounted,
          expectedMounted: window.__stats.expectedMounted,
          scrollY: window.scrollY,
        })`
      );

      return { before, after };
    },
  });

  const { before, after } = outcome;
  const newTweets = after.tweets - before.tweets;
  const newExposed = after.exposed - before.exposed;

  // 核心断言：请求量与“用户实际可能看到的推文数”同量级（不超过 2 倍）。
  // 修复前推文被压缩成 44px，暴露数与请求数都会放大数倍。
  check(
    "判定中滚动：请求量与实际暴露的推文数同量级（无请求放大）",
    newTweets <= newExposed * 2,
    `暴露推文=${newExposed} 请求条目=${newTweets}（倍数=${(newTweets / Math.max(newExposed, 1)).toFixed(2)}）`
  );
  // 挂载数不应数倍于按自然高度推算的所需数量：
  // 推文被压缩成 44px 时，同样空间要挂载约 5 倍的推文
  check(
    "判定中滚动：挂载的推文数量不因高度塌缩而暴涨",
    after.maxMounted <= after.expectedMounted * 1.5,
    `挂载峰值=${after.maxMounted}（按自然高度推算应为 ${after.expectedMounted}）`
  );
}

// ============ 用例 3：模型漏答的推文不会卡在 Checking ============
{
  const outcome = await runScenario({
    name: "漏答兜底",
    setup: async (cdp) => {
      // 模拟模型只回答部分推文
      await evaluate(
        cdp,
        `window.__reply = (tweets) => tweets.slice(0, 1).map(t => ({ id: t.hash, hide: false, reason: "" }));`
      );
    },
    scenario: async (cdp) => {
      await sleep(1500);
      return await evaluate(
        cdp,
        `(() => {
          const arts = [...document.querySelectorAll('article[data-testid="tweet"]')];
          const stillPending = arts.filter(a => a.dataset.aiFilterPending);
          const loaders = document.querySelectorAll('.ai-filter-loader');
          return { total: arts.length, stillPending: stillPending.length, loaders: loaders.length };
        })()`
      );
    },
  });

  check(
    "模型漏答的推文已放行，未卡在 Checking 状态",
    outcome.stillPending === 0 && outcome.loaders === 0,
    `stillPending=${outcome.stillPending} loaders=${outcome.loaders}`
  );
}

// ============ 用例 4：相同文本的多个实例只产生一次请求 ============
{
  const outcome = await runScenario({
    name: "重复文本去重",
    setup: async (cdp) => {
      await evaluate(cdp, `window.__reply = null;`);
      // 追加三条内容完全相同的推文
      await evaluate(
        cdp,
        `(() => {
          const tl = document.getElementById('spacer');
          for (let i = 0; i < 3; i++) {
            const a = document.createElement('article');
            a.setAttribute('data-testid', 'tweet');
            a.innerHTML = '<div class="tweet-body"><div data-testid="tweetText">Duplicate body text</div></div>';
            tl.appendChild(a);
          }
        })()`
      );
    },
    scenario: async (cdp) => {
      await sleep(1500);
      return await evaluate(
        cdp,
        `(() => {
          const all = window.__requests.flat();
          return { total: all.length, unique: new Set(all).size };
        })()`
      );
    },
  });

  check(
    "相同文本的多个推文实例合并为一次请求",
    outcome.total === outcome.unique,
    `请求条目=${outcome.total} 去重后=${outcome.unique}`
  );
}

// ============ 用例 5：隐藏推文后横幅正常出现且高度不塌缩 ============
{
  const outcome = await runScenario({
    name: "隐藏横幅",
    setup: async (cdp) => {
      await evaluate(cdp, `window.__reply = (tweets) => tweets.map(t => ({ id: t.hash, hide: true, reason: "toxic" }));`);
    },
    scenario: async (cdp) => {
      await sleep(1500);
      return await evaluate(
        cdp,
        `(() => {
          const banners = document.querySelectorAll('.ai-filter-banner');
          const hidden = document.querySelectorAll('.ai-filter-hidden');
          const loaders = document.querySelectorAll('.ai-filter-loader');
          const heights = [...hidden].map(a => Math.round(a.getBoundingClientRect().height));
          return { banners: banners.length, hidden: hidden.length, loaders: loaders.length, heights };
        })()`
      );
    },
  });

  check(
    "判定为隐藏的推文显示折叠横幅且加载动画已移除",
    outcome.banners > 0 && outcome.loaders === 0,
    `banners=${outcome.banners} hidden=${outcome.hidden} loaders=${outcome.loaders}`
  );
}

// ============ 用例 6：连续滚动时批次不会被无限推迟 ============
//
// 原实现每次有新推文入队都重置防抖定时器，持续滚动时定时器永远等不到触发，
// 判定全部积压、页面长时间停在 Checking 状态。修复后改为“截止时间不后移”的节流，
// 批次按固定间隔发出。
{
  const outcome = await runScenario({
    name: "批次不被推迟",
    setup: async (cdp) => {
      await evaluate(cdp, `window.__reply = null;`);
    },
    scenario: async (cdp) => {
      // 持续滚动：间隔小于批次节流时长（500ms），模拟用户连续滑动
      for (let i = 0; i < 12; i++) {
        await evaluate(cdp, `window.scrollBy(0, 400);`);
        await sleep(120);
      }
      const during = await evaluate(cdp, `window.__stats.requests`);

      // 停止滚动后应不再有待发批次
      await sleep(1500);
      const after = await evaluate(cdp, `window.__stats.requests`);

      return { during, after };
    },
  });

  check(
    "连续滚动过程中批次仍按固定间隔发出（未被无限推迟）",
    outcome.during >= 2,
    `滚动期间发出 ${outcome.during} 个批次（预期 ≥2）`
  );
  check(
    "停止滚动后无残留批次（不会重复发送）",
    outcome.after - outcome.during <= 1,
    `停止后新增 ${outcome.after - outcome.during} 个批次`
  );
}

// ============ 用例 7：manifest 的脚本注入顺序可用 ============
//
// 扩展的 content_scripts 按 manifest 里的 js 数组顺序注入：
// ui.js 定义 TweetDom，tweet-store.js 定义 TweetStore，content.js 串联三者。
// 顺序错误会在页面加载时报 ReferenceError，扩展整体失效。
{
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  const order = manifest.content_scripts[0].js;
  const expected = ["ui.js", "tweet-store.js", "content.js"];

  check(
    "manifest 的 content_scripts 顺序为 ui.js → tweet-store.js → content.js",
    JSON.stringify(order) === JSON.stringify(expected),
    `实际顺序 ${JSON.stringify(order)}`
  );

  // 校验被注入的脚本里确实声明了对应的全局对象
  const decls = {
    "ui.js": /const TweetDom\s*=/,
    "tweet-store.js": /const TweetStore\s*=/,
  };
  const missing = [];
  for (const [file, pattern] of Object.entries(decls)) {
    const src = fs.readFileSync(path.join(root, file), "utf8");
    if (!pattern.test(src)) missing.push(file);
  }
  check(
    "各脚本均声明了预期的全局对象（TweetDom / TweetStore）",
    missing.length === 0,
    missing.length ? `缺少：${missing.join("、")}` : "全部就位"
  );
}

// ============ 汇总 ============
console.log("\n================ 测试汇总 ================");
console.log(`总计 ${results.length} 项，通过 ${results.length - failures} 项，失败 ${failures} 项`);
if (failures > 0) {
  console.log("\n失败用例：");
  for (const r of results.filter((x) => !x.ok)) {
    console.log(`  - ${r.name}${r.detail ? ` (${r.detail})` : ""}`);
  }
}
process.exit(failures > 0 ? 1 : 0);
