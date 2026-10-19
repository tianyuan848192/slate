// 时间线工具的单元测试（不需要浏览器）：node --test agent/image/runtime/
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// 最小的页面环境：运行时加载时只用到这些
const el = (cs = {}) => ({ nodeType: 1, style: { setProperty(k, v) { this[k] = v; }, removeProperty(k) { delete this[k]; } }, attrs: {}, textContent: "",
  getAttribute(k) { return this.attrs[k] ?? null; }, setAttribute(k, v) { this.attrs[k] = String(v); }, removeAttribute(k) { delete this.attrs[k]; }, _cs: cs });
globalThis.window = globalThis;
globalThis.addEventListener = () => {};
globalThis.document = { head: { appendChild() {} }, documentElement: {}, createElement: () => el(), querySelectorAll: () => [], images: [], fonts: null };
globalThis.getComputedStyle = e => ({ getPropertyValue: k => e._cs[k] ?? "", ...e._cs });
globalThis.MutationObserver = class { observe() {} disconnect() {} };
new Function(readFileSync(new URL("./slate-runtime.js", import.meta.url), "utf8"))();
const { timeline, easing } = window.SLATE;

test("缓动：常用名字和端点", () => {
  for (const n of ["linear", "outCubic", "inOutSine", "outBack(1.7)", "outElastic(1, 0.3)", "outBounce", "inExpo", "inOutCirc", "out", "steps(4)"]) {
    const f = easing(n);
    assert.ok(Math.abs(f(0)) < 1e-9 && Math.abs(f(1) - 1) < 1e-9, n);
  }
  assert.equal(easing("steps(4)")(0.3), 0.25);
  assert.ok(easing("outBack")(0.6) > 1);              // 回弹会冲过终点
  assert.throws(() => easing("power2.out"));          // 不认 GSAP 的写法，改写时要换成 outCubic
});

test("补间：终值、起值和衔接", () => {
  const a = el({ opacity: "0.5" });
  const tl = timeline()
    .tween(a, { opacity: 1, x: [-40, 0] }, { at: 1, dur: 1, ease: "linear" })
    .tween(a, { x: 100 }, { at: 3, dur: 1, ease: "linear" });
  tl.at(0); assert.equal(a.style.opacity, "0.5"); assert.equal(a.style.transform, "translate3d(-40px, 0px, 0px)");  // 起值立即生效
  tl.at(1.5); assert.equal(a.style.opacity, "0.75"); assert.equal(a.style.transform, "translate3d(-20px, 0px, 0px)");
  tl.at(2.5); assert.equal(a.style.transform, "");                         // 第一段结束停在 0
  tl.at(3.5); assert.equal(a.style.transform, "translate3d(50px, 0px, 0px)"); // 第二段从上一段终值接着走
  tl.at(9); assert.equal(a.style.opacity, "1");
  tl.at(1.5); assert.equal(a.style.opacity, "0.75");                      // 乱序跳转结果一样
  assert.equal(tl.duration, 4);
});

test("from、set、错开、往返、颜色、属性、文字和回调", () => {
  const items = [el(), el(), el()];
  const box = el({ backgroundColor: "rgb(0, 0, 0)" }), path = el(), label = el();
  let got = null;
  const tl = timeline()
    .tween(items, { y: { from: 30 } }, { at: 0, dur: 1, each: 0.5, ease: "linear" })
    .tween(box, { backgroundColor: "#ffffff" }, { at: 0, dur: 1, ease: "linear" })
    .tween(box, { scale: 1.2 }, { at: 0, dur: 1, repeat: 1, yoyo: true, ease: "linear" })
    .tween(path, { attr: { "stroke-dashoffset": [100, 0] } }, { at: 0, dur: 2, ease: "linear" })
    .tween(label, { text: "你好世界" }, { at: 0, dur: 2, ease: "linear" })
    .set(label, { display: "none" }, 3)
    .call((p, t) => { got = [p, t]; }, { at: 1, dur: 2 });
  tl.at(0.5);
  assert.deepEqual(items.map(i => i.style.transform), ["translate3d(0px, 15px, 0px)", "translate3d(0px, 30px, 0px)", "translate3d(0px, 30px, 0px)"]);
  assert.equal(box.style.backgroundColor, "rgba(128, 128, 128, 1)");
  assert.equal(box.style.transform, "scale(1.1, 1.1)");
  assert.equal(path.attrs["stroke-dashoffset"], "75");
  assert.equal(label.textContent, "你");
  tl.at(1.5); assert.equal(box.style.transform, "scale(1.1, 1.1)");     // 往返的回程
  tl.at(2); assert.deepEqual(got, [0.5, 2]); assert.equal(label.textContent, "你好世界");
  tl.at(5); assert.equal(box.style.transform, ""); assert.equal(label.style.display, "none"); assert.deepEqual(got, [1, 5]);
  tl.at(2.9); assert.equal(label.style.display, "");                      // 原来没有内联值：恢复成空
});

test("原来没有的属性：之前不写入", () => {
  const c = el();
  const tl = timeline().tween(c, { attr: { r: 20 } }, { at: 1, dur: 1, ease: "linear" });
  tl.at(0); assert.equal("r" in c.attrs, false);
  tl.at(2); assert.equal(c.attrs.r, "20");
});

test("子时间线和函数值", () => {
  const xs = [el(), el()];
  const child = timeline().tween(xs, { x: (i) => (i + 1) * 10 }, { at: 0, dur: 1, ease: "linear" });
  const tl = timeline().add(child, 2);
  tl.at(2.5); assert.deepEqual(xs.map(e => e.style.transform), ["translate3d(5px, 0px, 0px)", "translate3d(10px, 0px, 0px)"]);
  assert.equal(tl.duration, 3);
});

test("多数字字符串逐个补间", () => {
  const c = el();
  const tl = timeline().tween(c, { clipPath: ["inset(0 100% 0 0)", "inset(0 0% 0 0)"], filter: ["blur(8px)", "blur(0px)"] }, { at: 0, dur: 1, ease: "linear" });
  tl.at(0.25); assert.equal(c.style.clipPath, "inset(0 75% 0 0)"); assert.equal(c.style.filter, "blur(6px)");
});

test("结束后停在终值（浮点误差）", () => {
  const c = el();
  const tl = timeline().tween(c, { opacity: [0, 1], y: [22, 0] }, { at: 0.44, dur: 0.5, ease: "outQuart" });
  tl.at(3); assert.equal(c.style.opacity, "1"); assert.equal(c.style.transform, "");
});
