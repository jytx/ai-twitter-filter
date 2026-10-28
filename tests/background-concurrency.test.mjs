// 并发调度的单元测试：直接引入 background 实际使用的 api-scheduler.js，
// 验证同时在途数量、发起间隔、失败隔离与名额释放。
//
// 用法：node tests/background-concurrency.test.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createScheduler } from "../api-scheduler.js";

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 与 background.js 保持一致的调度参数
const MAX_CONCURRENT_REQUESTS = 3;
const MIN_API_INTERVAL_MS = 500;

console.log("\n[1] background 接入检查");
{
  const source = fs.readFileSync(path.join(root, "background.js"), "utf8");
  test("background 引入 api-scheduler", () => {
    assert(/import \{ createScheduler \} from "\.\/api-scheduler\.js"/.test(source), "未引入调度器");
  });
  test("background 不再保留串行队列 apiQueue", () => {
    assert(!/apiQueue/.test(source), "仍存在 apiQueue 串行队列");
  });
  test("批次之间并发发起而非逐批 await", () => {
    assert(/Promise\.all\(batchTasks\)/.test(source), "批次未并发执行");
  });
  test("并发上限与间隔取自调度器常量", () => {
    assert(/maxConcurrent: MAX_CONCURRENT_REQUESTS/.test(source), "并发上限未传入调度器");
    assert(/minIntervalMs: MIN_API_INTERVAL_MS/.test(source), "发起间隔未传入调度器");
  });
}

console.log("\n[2] 调度器行为验证（真实实现）");
{
  const scheduler = createScheduler({
    maxConcurrent: MAX_CONCURRENT_REQUESTS,
    minIntervalMs: MIN_API_INTERVAL_MS,
  });

  const startedAt = [];
  let peakActive = 0;

  const tasks = [];
  for (let i = 0; i < 8; i++) {
    tasks.push(
      scheduler.run(async () => {
        startedAt.push(Date.now());
        peakActive = Math.max(peakActive, scheduler.activeCount());
        await sleep(300);
      })
    );
    await sleep(10);
  }
  await Promise.all(tasks);

  test("同时在途的任务不超过并发上限", () => {
    assert(
      peakActive <= MAX_CONCURRENT_REQUESTS,
      `在途峰值 ${peakActive} 超过上限 ${MAX_CONCURRENT_REQUESTS}`
    );
  });

  test("相邻两次发起的间隔不小于 MIN_API_INTERVAL_MS", () => {
    for (let i = 1; i < startedAt.length; i++) {
      const gap = startedAt[i] - startedAt[i - 1];
      assert(
        gap >= MIN_API_INTERVAL_MS - 30,
        `第 ${i} 次发起间隔 ${gap}ms，低于 ${MIN_API_INTERVAL_MS}ms`
      );
    }
  });

  test("全部任务完成且名额全部释放", () => {
    assert(startedAt.length === 8, `只发起了 ${startedAt.length} 个任务`);
    assert(scheduler.activeCount() === 0, `结束时仍有 ${scheduler.activeCount()} 个名额未释放`);
  });

  test("并发带来的吞吐高于纯串行", () => {
    // 纯串行完成 8 个任务（各 300ms + 500ms 间隔）约需 6.4 秒
    const elapsed = startedAt[startedAt.length - 1] - startedAt[0];
    assert(elapsed < 4000, `实际耗时 ${elapsed}ms，未体现并发优势`);
  });
}

{
  const scheduler = createScheduler({
    maxConcurrent: MAX_CONCURRENT_REQUESTS,
    minIntervalMs: MIN_API_INTERVAL_MS,
  });

  let afterFailureRan = false;
  const failing = scheduler.run(async () => {
    await sleep(50);
    throw new Error("boom");
  });
  const following = scheduler.run(async () => {
    afterFailureRan = true;
  });

  await failing.then(
    () => assert(false, "失败任务未抛出异常"),
    () => {}
  );
  await following;

  test("单个任务失败不会阻塞后续任务", () => {
    assert(afterFailureRan, "失败后后续任务未执行");
  });
  test("失败后名额已释放", () => {
    assert(scheduler.activeCount() === 0, `失败后仍有 ${scheduler.activeCount()} 个名额未释放`);
  });
}

console.log(`\n通过 ${passed} 项断言`);
process.exit(failed > 0 ? 1 : 0);
