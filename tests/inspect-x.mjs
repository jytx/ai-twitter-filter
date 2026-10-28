// 在真实的 x.com 页面上采集诊断数据：扩展是否生效、当前有多少推文在转圈等
// 用法：node tests/inspect-x.mjs [port] [urlFilter]

const port = process.argv[2] || "9222";
const urlFilter = process.argv[3] || "x.com";

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
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
    }
  });
  return {
    ws,
    ready,
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
const pages = targetInfos.filter((t) => t.type === "page" && t.url.includes(urlFilter));

if (pages.length === 0) {
  console.log(`没有找到包含 "${urlFilter}" 的页面`);
  process.exit(1);
}

for (const page of pages) {
  console.log(`\n########## ${page.title.slice(0, 60)} ##########`);
  console.log(`URL: ${page.url}`);

  const { sessionId } = await browser.send("Target.attachToTarget", {
    targetId: page.targetId,
    flatten: true,
  });

  const ev = async (expr) => {
    const r = await browser.send(
      "Runtime.evaluate",
      { expression: expr, returnByValue: true, awaitPromise: true },
      sessionId
    );
    if (r.exceptionDetails) {
      return { __error: JSON.stringify(r.exceptionDetails).slice(0, 300) };
    }
    return r.result.value;
  };

  // 1. 扩展内容脚本是否已注入（看 build 标记）
  const build = await ev(`(() => {
    try {
      return typeof TweetStore !== 'undefined' ? 'TweetStore 已定义' : 'TweetStore 未定义';
    } catch (e) { return 'TweetStore 未定义'; }
  })()`);
  console.log(`状态层: ${build}`);

  const dom = await ev(`(() => {
    try {
      return typeof TweetDom !== 'undefined' ? 'TweetDom 已定义' : 'TweetDom 未定义';
    } catch (e) { return 'TweetDom 未定义'; }
  })()`);
  console.log(`DOM 层: ${dom}`);

  // 2. 时间线上的推文状态统计
  const stats = await ev(`(() => {
    const arts = [...document.querySelectorAll('article[data-testid="tweet"]')];
    const loaders = document.querySelectorAll('.ai-filter-loader');
    const banners = document.querySelectorAll('.ai-filter-banner');
    const processed = document.querySelectorAll('article[data-ai-filter-processed="true"]');
    const pendingMark = document.querySelectorAll('article[data-ai-filter-pending="true"]');
    const heights = [...pendingMark].map(a => Math.round(a.getBoundingClientRect().height));
    const allHeights = [...arts].map(a => Math.round(a.getBoundingClientRect().height));
    return {
      推文总数: arts.length,
      已标记processed: processed.length,
      带pending标记: pendingMark.length,
      转圈加载中: loaders.length,
      折叠横幅: banners.length,
      判定中高度: heights.slice(0, 12),
      全部推文高度区间: allHeights.length
        ? Math.min(...allHeights) + '~' + Math.max(...allHeights)
        : '无',
      视口高度: window.innerHeight,
      滚动位置: Math.round(window.scrollY),
      文档高度: Math.round(document.documentElement.scrollHeight),
    };
  })()`);
  console.log("时间线状态:", JSON.stringify(stats, null, 2));

  // 3. 收集控制台日志（含扩展的 build 标记）
  console.log("\n（已开启 Console 日志捕获，滚动后再看）");
}

process.exit(0);
