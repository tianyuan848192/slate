// 机械图解风格在 Slate 里的适配层：全屏版式、只由 t 决定的动画、页面内的几何自检。
// 工具库（kit/）是原样复制的开源代码（MIT，见同目录 LICENSE），这里不改它，只在外面包一层。
//
//   import * as A from "/skills/anatomy/slate.mjs";
//   const { k } = A;                                   // 工具库：k.fitProjection、k.slabOf、k.cylinder……
//   const st = A.stage({ title: "千分表", fig: "图 1", theme: "dark" });
//   st.mount(k.figureSvg({ width: W, height: H, label: "…", body: [...] }));
//   const motion = A.sim({ init: () => ({ x: 0 }), step: (s, dt, t) => { … } });
//   window.render = t => { const s = motion.at(t); …写到元素上…; st.readout("…"); };
//   A.ready();
import * as k from "./kit/iso-kit.mjs";

export { k };

const S = window.SLATE;
const CSS = `
html, body { background: var(--anatomy-card); }
body.iso { margin: 0; color: var(--anatomy-text); font-family: "Noto Sans CJK SC", sans-serif; }
.an-stage { position: absolute; inset: 0; background: var(--anatomy-card); overflow: hidden; }
.an-fig { position: absolute; display: flex; align-items: center; justify-content: center; }
.an-fig > svg { width: 100%; height: 100%; overflow: visible; }
/* 原版的线条固定 0.6 像素宽（按网页上 600 像素宽的插图设计），视频里要随画面等比放大 */
.an-fig .iso-svg path, .an-fig .iso-svg circle { vector-effect: none; }
.an-corner { position: absolute; color: var(--anatomy-muted); font: 500 var(--an-corner) "Noto Sans CJK SC", var(--anatomy-mono);
  letter-spacing: .06em; white-space: nowrap; line-height: 1; }
.an-corner[data-corner="fig"] { color: var(--anatomy-text); }
.an-corner[data-corner="title"] { color: var(--anatomy-strong); }
.an-corner[data-corner="readout"] { color: var(--anatomy-strong); font-variant-numeric: tabular-nums; }
`;

/** 全屏舞台：插图放在安全区内、字幕区上方，四角放图号、标题、副标题和读数（都可以不要）。
 *  theme：dark（默认，炭黑底）或 light（纸白底）。返回 {el, fig, mount(svg), readout(text), corner(name, text), box} */
export function stage({ theme = "dark", fig = "", title = "", sub = "", readout = "", pad = 0.02 } = {}) {
  const W = S.width, H = S.height, safe = S.safe, cap = S.captionZone;
  document.body.classList.add("iso");
  document.body.dataset.theme = theme;
  if (!document.getElementById("an-css")) {
    const st = document.createElement("style");
    st.id = "an-css";
    st.textContent = k.ISO_CSS + CSS;
    document.head.appendChild(st);
  }
  // 字幕的颜色跟着主题走
  const dark = theme !== "light";
  document.documentElement.style.setProperty("--slate-caption-bg", dark ? "rgba(19, 19, 19, .88)" : "rgba(250, 250, 248, .9)");
  document.documentElement.style.setProperty("--slate-caption-color", dark ? "#e6e6e6" : "#1a1a1a");
  const el = document.createElement("div");
  el.className = "an-stage";
  el.style.setProperty("--an-corner", `${(2.2 * S.u).toFixed(1)}px`);
  document.body.appendChild(el);
  const corner = 2.2 * S.u * 2.2;  // 四角文字占的高度
  const top = safe.y + corner, bottom = (S.captionsOn ? cap.y : safe.y + safe.h) - corner;
  const box = { x: safe.x + safe.w * pad, y: top, w: safe.w * (1 - 2 * pad), h: Math.max(10, bottom - top) };
  const figEl = document.createElement("div");
  figEl.className = "an-fig";
  Object.assign(figEl.style, { left: `${box.x}px`, top: `${box.y}px`, width: `${box.w}px`, height: `${box.h}px` });
  el.appendChild(figEl);
  const corners = {};
  const right = W - (safe.x + safe.w), low = bottom + corner * 0.35;
  const place = { fig: { left: safe.x, top: safe.y }, title: { right, top: safe.y }, sub: { left: safe.x, top: low }, readout: { right, top: low } };
  const setCorner = (name, text) => {
    if (!corners[name]) {
      const c = document.createElement("span");
      c.className = "an-corner"; c.dataset.corner = name;
      for (const [key, v] of Object.entries(place[name])) c.style[key] = `${v}px`;
      el.appendChild(c);
      corners[name] = c;
    }
    if (corners[name].textContent !== text) corners[name].textContent = text;
  };
  if (fig) setCorner("fig", fig);
  if (title) setCorner("title", title);
  if (sub) setCorner("sub", sub);
  if (readout) setCorner("readout", readout);
  return {
    el, fig: figEl, box,
    mount(svg) { figEl.innerHTML = svg; return figEl.querySelector("svg"); },
    readout: text => setCorner("readout", text),
    corner: setCorner,
  };
}

/** 固定步长仿真：画面只由 t 决定，任意跳到某一帧都能复现。
 *  init() 返回初始状态（普通对象，可以嵌套数组）；step(state, dt, t) 原地推进一步；at(t) 返回 t 时刻的状态。
 *  内部每隔 checkpoint 秒存一份快照：顺着往后渲染只多算一小段，往回跳从最近的快照重算 */
export function sim({ init, step, dt = 1 / 240, checkpoint = 0.5 }) {
  const per = Math.max(1, Math.round(checkpoint / dt));
  const snaps = [JSON.parse(JSON.stringify(init()))];
  let cur = JSON.parse(JSON.stringify(snaps[0])), n = 0;
  return {
    at(t) {
      const want = Math.max(0, Math.round(t / dt));
      if (want < n) {  // 往回跳：从最近的快照开始
        const i = Math.min(Math.floor(want / per), snaps.length - 1);
        cur = JSON.parse(JSON.stringify(snaps[i])); n = i * per;
      }
      while (n < want) {
        step(cur, dt, n * dt);
        n++;
        if (n % per === 0 && snaps.length === n / per) snaps.push(JSON.parse(JSON.stringify(cur)));
      }
      return cur;
    },
  };
}

/** 指数跟随一步：x 朝 target 靠近，tau 越小越快（原版常用 0.1～0.3 秒） */
export const follow = (x, target, dt, tau = 0.28) => {
  const v = x + (target - x) * (1 - Math.exp(-dt / tau));
  return Math.abs(target - v) < 1e-4 ? target : v;
};

/** 弹簧一步：s = {at, rate}，原地更新。stiff 刚度、drag 阻尼（原版的千分表用 420 和 26） */
export function spring(s, target, dt, stiff = 420, drag = 26) {
  s.rate += ((target - s.at) * stiff - s.rate * drag) * dt;
  s.at += s.rate * dt;
  if (Math.abs(target - s.at) < 5e-4 && Math.abs(s.rate) < 5e-4) { s.at = target; s.rate = 0; }
  return s;
}

/** 时间表：[[秒, 值], …] 按时间切换的目标值（阶跃），比如旁白讲到第二块量块时把滑台的目标移过去。
 *  用法：const target = A.cue([[0, 18], [2.4, 14], [4.8, 10]]); target(t) */
export const cue = keys => {
  const ks = [...keys].sort((a, b) => a[0] - b[0]);
  return t => { let v = ks[0][1]; for (const [at, val] of ks) if (t >= at) v = val; return v; };
};

/** 页面里跑工具库的几何自检（零件穿模、管线收口、遮挡顺序……），有问题用 console.error 报出来，slate-qa 会把它当页面错误报告。
 *  R、P 是 audit.recorder 记下的结果和投影，用法同原版的 auditOrExit（见 references/kit.md 第 12 节） */
export async function audit(R, P = R.P, options = {}) {
  const Au = await import("./kit/audit.mjs");
  const res = Au.audit(R, P, options);
  const n = Au.failures(res);
  if (n) console.error(`几何自检发现 ${n} 个问题：${Au.report(res).slice(0, 1200)}`);
  return res;
}

/** 字体和图片加载完再开拍；初始化都做完后调用 */
export function ready() {
  const waits = [document.fonts ? document.fonts.ready : null, document.fonts ? document.fonts.load('500 20px "Noto Sans CJK SC"', "图") : null];
  Promise.all(waits).then(() => { window.READY = true; });
}
