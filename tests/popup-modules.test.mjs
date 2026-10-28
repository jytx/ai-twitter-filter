// popup 模块完整性检查：验证拆分后的模块导入与导出关系正确
// 运行：node tests/popup-modules.test.mjs
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}\n    ${err.message}`);
    process.exitCode = 1;
  }
}

console.log("\n[1] popup 模块导入");
{
  const popup = read("popup.js");

  test("导入 focus-toggle 的两个函数", () => {
    assert.match(popup, /import\s*\{[^}]*loadFocusMode[^}]*bindFocusModeToggle[^}]*\}\s*from\s*"\.\/focus-toggle\.js"/);
  });

  test("导入 test-connection 的绑定函数", () => {
    assert.match(popup, /import\s*\{[^}]*bindTestConnection[^}]*\}\s*from\s*"\.\/test-connection\.js"/);
  });

  test("不再直接导入 providers（已由 test-connection 承担）", () => {
    assert.doesNotMatch(popup, /from\s*"\.\/providers\.js"/);
  });

  test("已移除内联的 Test Connection 实现", () => {
    assert.doesNotMatch(popup, /async function runTestConnection/);
    assert.doesNotMatch(popup, /max_tokens: 1/);
  });

  test("调用 bindTestConnection 并注入依赖", () => {
    assert.match(popup, /bindTestConnection\(els,\s*requestOriginPermission\)/);
  });
}

console.log("\n[2] focus-toggle 导出");
{
  const mod = read("focus-toggle.js");
  test("导出 loadFocusMode", () => assert.match(mod, /export function loadFocusMode/));
  test("导出 bindFocusModeToggle", () => assert.match(mod, /export function bindFocusModeToggle/));
  test("绑定函数接受反馈回调", () => {
    assert.match(mod, /bindFocusModeToggle\(checkbox,\s*onFeedback\)/);
  });
}

console.log("\n[3] test-connection 导出与依赖");
{
  const mod = read("test-connection.js");
  test("导出 bindTestConnection", () => assert.match(mod, /export function bindTestConnection/));
  test("从 providers 导入 getApiUrl", () => {
    assert.match(mod, /import\s*\{\s*getApiUrl\s*\}\s*from\s*"\.\/providers\.js"/);
  });
  test("不依赖 popup 的全局元素表", () => {
    assert.doesNotMatch(mod, /document\.getElementById/);
  });
}

console.log("\n[4] popup.html 与 popup.js 的元素 id 对应");
{
  const html = read("popup.html");
  const popup = read("popup.js");
  const htmlIds = [...html.matchAll(/id="([\w-]+)"/g)].map((m) => m[1]);
  const jsIds = [...popup.matchAll(/getElementById\("([\w-]+)"\)/g)].map((m) => m[1]);

  test("popup.js 引用的所有 id 在 popup.html 中存在", () => {
    const missing = jsIds.filter((id) => !htmlIds.includes(id));
    assert.equal(missing.length, 0, `缺少元素: ${missing.join(", ")}`);
  });

  test("focusMode 勾选框与状态提示元素都在 HTML 中", () => {
    assert.ok(htmlIds.includes("focusMode"), "缺少 focusMode 勾选框");
    assert.ok(htmlIds.includes("focusModeStatus"), "缺少 focusModeStatus 提示元素");
  });

  test("popup 显示版本号（便于确认浏览器里跑的是最新构建）", () => {
    assert.ok(htmlIds.includes("version"), "popup.html 缺少版本号元素");
    assert.ok(
      /getManifest\(\)\.version/.test(popup),
      "popup.js 未从 manifest 读取版本号"
    );
  });
}

console.log("\n[6] 版本号标识一致性");
{
  const manifest = JSON.parse(read("manifest.json"));
  const content = read("content.js");
  const buildMatch = content.match(/build (\d+\.\d+\.\d+)/);

  test("content.js 的构建标记与 manifest 版本号一致", () => {
    assert.ok(buildMatch, "content.js 中未找到构建标记");
    assert.equal(
      buildMatch[1],
      manifest.version,
      `构建标记 ${buildMatch[1]} 与 manifest 版本 ${manifest.version} 不一致`
    );
  });

  test("版本号为三段式语义化版本", () => {
    assert.ok(
      /^\d+\.\d+\.\d+$/.test(manifest.version),
      `版本号格式非法: ${manifest.version}`
    );
  });
}

console.log("\n[5] manifest 内容脚本清单");
{
  const manifest = JSON.parse(read("manifest.json"));
  const js = manifest.content_scripts[0].js;
  test("content_scripts 含 focus.js", () => assert.ok(js.includes("focus.js")));
  test("ui.js 在 focus.js 之前（供 content.js 调用其函数）", () => {
    assert.ok(js.indexOf("ui.js") < js.indexOf("focus.js"));
    assert.ok(js.indexOf("ui.js") < js.indexOf("content.js"));
  });
  test("tweet-store.js 在 content.js 之前（content.js 依赖 TweetStore）", () => {
    assert.ok(js.includes("tweet-store.js"));
    assert.ok(js.indexOf("tweet-store.js") < js.indexOf("content.js"));
  });
  test("permissions 含 tabs（popup 广播需要）", () => {
    assert.ok(manifest.permissions.includes("tabs"));
  });
}

console.log(`\n通过 ${passed} 项断言`);
