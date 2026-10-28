// 通过 DevTools WebSocket 列出所有 target（Chrome 136+ 禁用了 /json/list 发现端点）
// 用法：node tests/cdp-list-targets.mjs [port]

const port = process.argv[2] || "9222";

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
    send(method, params = {}, sessionId) {
      return new Promise((resolve, reject) => {
        const mid = ++id;
        pending.set(mid, { resolve, reject });
        const payload = { id: mid, method, params };
        if (sessionId) payload.sessionId = sessionId;
        ws.send(JSON.stringify(payload));
        setTimeout(() => {
          if (pending.has(mid)) { pending.delete(mid); reject(new Error("timeout " + method)); }
        }, 15000);
      });
    },
    ready,
  };
}

const cdp = connect(`ws://127.0.0.1:${port}/devtools/browser/any`);
await cdp.ready;

const { targetInfos } = await cdp.send("Target.getTargets");
const pages = targetInfos.filter((t) => t.type === "page");

console.log(`共 ${targetInfos.length} 个 target，其中 ${pages.length} 个页面：\n`);
for (const t of pages) {
  console.log(`  ${t.title.slice(0, 50).padEnd(52)} ${t.url.slice(0, 80)}`);
}

// 输出 JSON 供其他脚本消费
console.log("\n---JSON---");
console.log(JSON.stringify(pages.map((t) => ({ id: t.targetId, title: t.title, url: t.url }))));
process.exit(0);
