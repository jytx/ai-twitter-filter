// 隐藏原因文案处理的单元测试：直接引入 background 实际使用的 filter-prompt.js，
// 验证提示词要求中文、原因规范化对非中文返回的兜底行为。
//
// 用法：node tests/filter-prompt.test.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildSystemPrompt, normalizeReason, PROMPT_VERSION } from "../filter-prompt.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${name}\n      ${err.message}`);
    failed++;
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

console.log("\n[1] 提示词要求中文原因");
{
  const prompt = buildSystemPrompt("任意筛选标准");

  test("提示词明确要求简体中文", () => {
    assert(/Simplified Chinese/i.test(prompt), "提示词未要求简体中文");
  });

  test("提示词给出的示例为中文", () => {
    assert(/负面抱怨/.test(prompt), "提示词缺少中文示例");
  });

  test("提示词不再残留英文示例", () => {
    assert(!/toxic negativity/.test(prompt), "提示词仍含英文示例");
  });

  test("用户填写的筛选标准被原样注入", () => {
    assert(prompt.includes("任意筛选标准"), "筛选标准未注入提示词");
  });
}

console.log("\n[2] 隐藏原因规范化");
{
  test("中文原因原样保留", () => {
    assert(normalizeReason("负面抱怨") === "负面抱怨", "中文原因被改动");
  });

  test("英文原因被判定为无效", () => {
    assert(normalizeReason("toxic negativity") === "", "英文原因未被拦截");
  });

  test("空原因返回空串", () => {
    assert(normalizeReason("") === "", "空原因未返回空串");
  });

  test("非字符串输入返回空串", () => {
    assert(normalizeReason(undefined) === "", "undefined 未返回空串");
    assert(normalizeReason(null) === "", "null 未返回空串");
  });

  test("中英混排（含中文）予以保留", () => {
    assert(normalizeReason("负面 toxic") === "负面 toxic", "含中文的原因被误杀");
  });

  test("首尾空白被去除", () => {
    assert(normalizeReason("  负面抱怨  ") === "负面抱怨", "空白未去除");
  });
}

console.log("\n[3] 缓存版本隔离");
{
  const source = fs.readFileSync(path.join(root, "background.js"), "utf8");

  test("background 引入提示词模块", () => {
    assert(
      /from "\.\/filter-prompt\.js"/.test(source),
      "background 未引入 filter-prompt.js"
    );
  });

  test("缓存持久化时记录提示词版本", () => {
    assert(/filterCacheVersion: PROMPT_VERSION/.test(source), "缓存未记录提示词版本");
  });

  test("版本不一致时丢弃旧缓存", () => {
    assert(/filterCacheVersion !== PROMPT_VERSION/.test(source), "未做版本比对");
  });
}

console.log(`\n通过 ${passed} 项，失败 ${failed} 项\n`);
process.exit(failed === 0 ? 0 : 1);
