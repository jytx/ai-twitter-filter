// focus.js 逻辑单元测试：用最小 DOM 桩验证状态同步与样式应用的正确性
// 运行：node tests/focus.test.mjs
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const focusSrc = fs.readFileSync(path.join(ROOT, "focus.js"), "utf8");

// ---- 最小 DOM 桩 ----

class FakeClassList {
  constructor() { this.set = new Set(); }
  add(c) { this.set.add(c); }
  remove(c) { this.set.delete(c); }
  contains(c) { return this.set.has(c); }
  toggle(c, force) {
    if (force === undefined) force = !this.set.has(c);
    if (force) this.set.add(c); else this.set.delete(c);
    return force;
  }
}

class FakeElement {
  constructor(tag = "div") {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.parentElement = null;
    this.classList = new FakeClassList();
    this.style = new FakeStyle();
    this.dataset = {};
    this.attributes = {};
    this.listeners = {};
    this.innerHTML = "";
  }
  get className() { return [...this.classList.set].join(" "); }
  set className(v) {
    this.classList = new FakeClassList();
    String(v).split(/\s+/).filter(Boolean).forEach((c) => this.classList.add(c));
  }
  setAttribute(k, v) { this.attributes[k] = v; }
  getAttribute(k) { return this.attributes[k] ?? null; }
  removeAttribute(k) { delete this.attributes[k]; }
  appendChild(child) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }
  prepend(child) {
    child.parentElement = this;
    this.children.unshift(child);
    return child;
  }
  remove() {
    if (!this.parentElement) return;
    const i = this.parentElement.children.indexOf(this);
    if (i >= 0) this.parentElement.children.splice(i, 1);
    this.parentElement = null;
  }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  closest() { return null; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  dispatch(type, evt = {}) { (this.listeners[type] || []).forEach((fn) => fn(evt)); }
  getBoundingClientRect() { return { width: 0, height: 0, x: 0, y: 0 }; }
}

class FakeStyle {
  constructor() { this.props = new Map(); }
  setProperty(k, v) { this.props.set(k, v); }
  removeProperty(k) { this.props.delete(k); }
  getPropertyValue(k) { return this.props.get(k) ?? ""; }
}

function makeDoc() {
  const doc = new FakeElement("body");
  doc.documentElement = new FakeElement("html");
  doc.body = doc;
  doc.createElement = (tag) => new FakeElement(tag);
  doc.addEventListener = () => {};
  doc.getElementById = (id) => {
    const walk = (el) => {
      if (el.id === id) return el;
      for (const c of el.children) { const r = walk(c); if (r) return r; }
      return null;
    };
    return walk(doc);
  };
  doc.querySelector = (sel) => {
    if (sel === '[data-testid="primaryColumn"]') return doc.__primary || null;
    return null;
  };
  doc.querySelectorAll = () => [];
  return doc;
}

// ---- 搭建三栏 DOM 桩 ----

function buildLayout(doc) {
  const primary = new FakeElement("div");
  primary.dataset = { testid: "primaryColumn" };
  primary.getAttribute = (k) => (k === "data-testid" ? "primaryColumn" : null);

  const mid0 = new FakeElement("div");
  const mid1 = new FakeElement("div");
  const main = new FakeElement("main");

  // 主栏挂到 mid0，mid0 -> mid1 -> main
  mid0.appendChild(primary);
  primary.closest = (sel) => (sel === "main" ? main : null);
  mid1.appendChild(mid0);
  main.appendChild(mid1);

  const leftHeader = new FakeElement("header");
  const layoutRow = new FakeElement("div");
  layoutRow.appendChild(leftHeader);
  layoutRow.appendChild(main);
  main.parentElement = layoutRow;

  // main 内的右栏
  const aside = new FakeElement("aside");
  const asideWrapper = new FakeElement("div");
  asideWrapper.appendChild(aside);
  main.appendChild(asideWrapper);

  main.querySelector = (sel) => (sel === "aside" ? aside : null);
  layoutRow.querySelector = (sel) => (sel === ":scope > header" ? leftHeader : null);

  doc.__primary = primary;
  doc.__els = { primary, mid0, mid1, main, leftHeader, aside, asideWrapper, layoutRow };
  return doc.__els;
}

// ---- 测试运行器 ----

function runFocus(env) {
  const sandbox = {
    document: env.doc,
    chrome: env.chrome,
    console,
    setTimeout,
    clearTimeout,
    setInterval: () => 0,
    MutationObserver: class { observe() {} disconnect() {} },
    getComputedStyle: (el) => ({
      display: el.style.getPropertyValue("display") || "flex",
    }),
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(focusSrc, sandbox, { filename: "focus.js" });
  return sandbox;
}

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

// ============================================================
// 测试 1：初始状态读取 —— 存储为 true 时应立即开启专注模式
// ============================================================
console.log("\n[1] 初始状态从 storage.local 读取");
{
  const doc = makeDoc();
  buildLayout(doc);
  const store = { focusMode: true };
  const chrome = {
    storage: {
      local: {
        get: (key, cb) => cb({ ...store }),
        set: (obj) => Object.assign(store, obj),
      },
      onChanged: { addListener: () => {} },
    },
    runtime: { onMessage: { addListener: () => {} } },
  };

  runFocus({ doc, chrome });

  const { primary, leftHeader, aside } = doc.__els;
  test("storage 为 true 时 html 属性置为 on", () => {
    assert.equal(doc.documentElement.getAttribute("data-ai-filter-focus"), "on");
  });
  test("左栏被隐藏", () => {
    assert.equal(leftHeader.style.getPropertyValue("display"), "none");
  });
  test("右栏被隐藏", () => {
    assert.equal(aside.style.getPropertyValue("display"), "none");
  });
  test("主栏放开宽度上限", () => {
    assert.equal(primary.style.getPropertyValue("max-width"), "none");
  });
}

// ============================================================
// 测试 2：storage.onChanged 触发同步（本次修复的核心）
// ============================================================
console.log("\n[2] storage.onChanged 监听（修复点）");
{
  const doc = makeDoc();
  buildLayout(doc);
  const store = { focusMode: false };
  const storageListeners = [];
  const chrome = {
    storage: {
      local: {
        get: (key, cb) => cb({ ...store }),
        set: (obj) => Object.assign(store, obj),
      },
      onChanged: {
        addListener: (fn) => storageListeners.push(fn),
      },
    },
    runtime: { onMessage: { addListener: () => {} } },
  };

  runFocus({ doc, chrome });

  test("已注册 storage.onChanged 监听器", () => {
    assert.ok(storageListeners.length > 0, "storage.onChanged 未注册");
  });

  test("local 区域变化时开启专注模式", () => {
    storageListeners.forEach((fn) =>
      fn({ focusMode: { newValue: true, oldValue: false } }, "local")
    );
    assert.equal(doc.documentElement.getAttribute("data-ai-filter-focus"), "on");
    assert.equal(doc.__els.leftHeader.style.getPropertyValue("display"), "none");
    assert.equal(doc.__els.primary.style.getPropertyValue("max-width"), "none");
  });

  test("local 区域变化为 false 时关闭专注模式并还原样式", () => {
    storageListeners.forEach((fn) =>
      fn({ focusMode: { newValue: false, oldValue: true } }, "local")
    );
    assert.equal(doc.documentElement.getAttribute("data-ai-filter-focus"), null);
    assert.equal(doc.__els.leftHeader.style.getPropertyValue("display"), "");
    assert.equal(doc.__els.primary.style.getPropertyValue("max-width"), "");
  });

  test("sync 区域的变化被忽略", () => {
    storageListeners.forEach((fn) =>
      fn({ focusMode: { newValue: true, oldValue: false } }, "sync")
    );
    assert.equal(doc.documentElement.getAttribute("data-ai-filter-focus"), null);
  });

  test("无关的 key 变化被忽略", () => {
    storageListeners.forEach((fn) =>
      fn({ apiKey: { newValue: "x", oldValue: "y" } }, "local")
    );
    assert.equal(doc.documentElement.getAttribute("data-ai-filter-focus"), null);
  });
}

// ============================================================
// 测试 3：runtime 消息同步
// ============================================================
// ============================================================
console.log("\n[3] runtime 消息同步");
{
  const doc = makeDoc();
  buildLayout(doc);
  const msgListeners = [];
  const chrome = {
    storage: {
      local: {
        get: (key, cb) => cb({ focusMode: false }),
        set: () => {},
      },
      onChanged: { addListener: () => {} },
    },
    runtime: {
      onMessage: { addListener: (fn) => msgListeners.push(fn) },
    },
  };

  runFocus({ doc, chrome });

  test("已注册 runtime.onMessage 监听器", () => {
    assert.ok(msgListeners.length > 0, "runtime.onMessage 未注册");
  });

  test("FOCUS_MODE_UPDATED 消息可开启专注模式", () => {
    msgListeners.forEach((fn) => fn({ type: "FOCUS_MODE_UPDATED", focusMode: true }));
    assert.equal(doc.documentElement.getAttribute("data-ai-filter-focus"), "on");
  });

  test("其它类型消息被忽略", () => {
    doc.documentElement.removeAttribute("data-ai-filter-focus");
    msgListeners.forEach((fn) => fn({ type: "SETTINGS_UPDATED", changes: {} }));
    assert.equal(doc.documentElement.getAttribute("data-ai-filter-focus"), null);
  });
}

// ============================================================
// 测试 4：悬浮按钮注入与点击切换
// ============================================================
// ============================================================
console.log("\n[4] 悬浮按钮");
{
  const doc = makeDoc();
  buildLayout(doc);
  const store = { focusMode: false };
  const chrome = {
    storage: {
      local: {
        get: (key, cb) => cb({ ...store }),
        set: (obj) => Object.assign(store, obj),
      },
      onChanged: { addListener: () => {} },
    },
    runtime: { onMessage: { addListener: () => {} } },
  };

  runFocus({ doc, chrome });

  test("按钮已注入到 body", () => {
    const btn = doc.getElementById("ai-filter-focus-btn");
    assert.ok(btn, "悬浮按钮未注入");
  });

  test("点击按钮切换到开启并写入存储", () => {
    const btn = doc.getElementById("ai-filter-focus-btn");
    btn.dispatch("click");
    assert.equal(store.focusMode, true);
    assert.equal(doc.documentElement.getAttribute("data-ai-filter-focus"), "on");
  });

  test("再次点击切换回关闭", () => {
    const btn = doc.getElementById("ai-filter-focus-btn");
    btn.dispatch("click");
    assert.equal(store.focusMode, false);
    assert.equal(doc.documentElement.getAttribute("data-ai-filter-focus"), null);
  });
}

console.log(`\n通过 ${passed} 项断言`);
