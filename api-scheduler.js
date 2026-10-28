// API 调用的并发调度器。
//
// 单独成模块的原因：并发控制涉及名额获取、发起间隔、异常释放三处细节，
// 极易出现竞态（名额泄漏、间隔失效、失败阻塞后续）。抽成独立模块后，
// background 与测试共用同一份实现，测试验证的是真实行为而非复刻逻辑。
//
// 调度规则：
//   1. 同时在途的任务不超过 maxConcurrent
//   2. 相邻两次"发起"时刻至少间隔 minIntervalMs，防止瞬时打爆供应商
//   3. 单个任务失败不影响其他任务，且失败时必定释放名额

/**
 * 创建调度器
 * @param {{ maxConcurrent: number, minIntervalMs: number }} options 调度参数
 * @returns {{ run: (task: () => Promise<any>) => Promise<any>, activeCount: () => number }}
 */
export function createScheduler(options) {
  const maxConcurrent = options.maxConcurrent;
  const minIntervalMs = options.minIntervalMs;

  // 当前在途任务数与等待名额的任务
  let active = 0;
  // 下一次可发起请求的最早时刻
  let nextAvailableAt = 0;
  const waiters = [];

  // 预约发起时刻：返回本次需要等待的时长，同时把下一次可用时刻往后推。
  //
  // 预约必须是原子的（同步完成，中间不能有 await）：否则多个任务并发进入时
  // 会各自算出相同的等待时长，到点后同时发起，实际间隔远小于设定值，
  // 瞬间打爆供应商。这里的实现让每个任务拿到互不重叠的发起时刻。
  function reserveStartSlot() {
    const now = Date.now();
    const startAt = Math.max(now, nextAvailableAt);
    nextAvailableAt = startAt + minIntervalMs;
    return startAt - now;
  }

  // 获取名额：达到上限时排队等待，前一个任务结束即唤醒一个等待者
  function acquire() {
    if (active < maxConcurrent) {
      active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => waiters.push(resolve)).then(() => {
      active += 1;
    });
  }

  // 释放名额并唤醒等待者
  function release() {
    active -= 1;
    const next = waiters.shift();
    if (next) next();
  }

  /**
   * 在调度约束下执行任务
   * @param {() => Promise<any>} task 实际要执行的异步任务
   * @returns {Promise<any>} 任务结果，异常原样向上抛出
   */
  async function run(task) {
    await acquire();
    try {
      const waitMs = reserveStartSlot();
      if (waitMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
      return await task();
    } finally {
      // 放在 finally：任务失败时同样释放名额，避免后续请求被永久阻塞
      release();
    }
  }

  return {
    run,
    activeCount: () => active,
  };
}
