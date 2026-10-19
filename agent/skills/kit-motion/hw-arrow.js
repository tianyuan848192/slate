/* 改编自 Apache-2.0 许可的开源素材，动画和写法有改动。许可证原文见 /opt/slate/licenses/kit/LICENSE */
/** 手绘箭头：在目标旁画出抖动的手绘箭头，箭头尖到达时沿行进方向拉伸并弹簧回弹，停留时轻抖，最后淡出。
 *  参数：at, dur(默认4), side(left|right), style(straight|gentle|swoop), stroke(plain|soft|sharp|spray),
 *  boil(off|calm|lively), color, weight, size, gap, each, seed */
(function () {
  window.KIT = window.KIT || {};
  KIT.motions = KIT.motions || {};
  const NS = "http://www.w3.org/2000/svg";
  let uid = 0;

  function hash(n, seed) {
    const x = Math.sin(n * 127.1 + (seed || 1) * 311.7) * 43758.5453;
    return (x - Math.floor(x)) * 2 - 1;
  }
  const BENDS = { straight: 0.06, gentle: 0.28, swoop: 0.55 };
  const STROKES = {
    plain: {},
    soft: { blur: 0.6 },
    sharp: { dash: [3.0, 1.55] },
    spray: { coreOpacity: 0.5, coreBlur: 0.4, density: 0.16, scatter: 2.6, rMin: 1.1, rMax: 2.6 },
  };
  const BOILS = { calm: { amp: 1.6, rot: 0.5 }, lively: { amp: 2.6, rot: 0.9 } };

  // 弹簧（阻尼 0.9，响应 0.22s）
  const ZETA = 0.9, RESP = 0.22;
  const W0 = (2 * Math.PI) / RESP;
  const SPRING_T = Math.log(1000) / (ZETA * W0);
  const WD = W0 * Math.sqrt(1 - ZETA * ZETA);
  const sx = (t) => 1 - Math.exp(-ZETA * W0 * t) * (Math.cos(WD * t) + ((ZETA * W0) / WD) * Math.sin(WD * t));
  const SXT = sx(SPRING_T);
  const spring = (p) => (p >= 1 ? 1 : sx(p * SPRING_T) / SXT);
  const outQuart = (p) => 1 - Math.pow(1 - p, 4);

  function mk(tag, attrs, parent) {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }

  KIT.motions.hwArrow = function (tl, target, o = {}) {
    const els = KIT.els(target);
    const at = o.at ?? 0, dur = o.dur ?? 4;
    const k = dur / 4;
    const u = SLATE.u;
    const each = (o.each ?? 0.5) * k;

    els.forEach((el, idx) => {
      const A = at + idx * each;
      const parent = el.parentElement;
      if (getComputedStyle(parent).position === "static") parent.style.position = "relative";
      const pr = parent.getBoundingClientRect(), er = el.getBoundingClientRect();
      const sc = parent.offsetWidth ? pr.width / parent.offsetWidth : 1;
      const ex = (er.left - pr.left) / sc - parent.clientLeft;
      const ey = (er.top - pr.top) / sc - parent.clientTop;
      const ew = er.width / sc, eh = er.height / sc;

      const VW = 380, VH = 180;
      const W = o.size ?? 26 * u, H = (W * VH) / VW;
      const side = o.side === "right" ? "right" : "left";
      const bend = BENDS[o.style] ?? BENDS.gentle;
      const sType = STROKES[o.stroke] ? o.stroke : "plain";
      const cfg = STROKES[sType];
      const boil = o.boil === "off" ? null : BOILS[o.boil] || BOILS.calm;
      const color = o.color ?? "#f4f2ec";
      const sw = o.weight ?? 6;
      const myId = ++uid;
      const seed = ((((o.seed ?? myId * 17) % 96) + 96) % 96) + 1;
      const wob = (v, n, r) => v + hash(n, seed) * r;

      // 几何（viewBox 坐标）
      const x0 = wob(4, 1, 3), y0 = wob(VH * 0.72, 2, 4);
      const x1 = wob(VW - 10, 3, 4), y1 = wob(VH * 0.3, 4, 4);
      const cx1 = wob(VW * 0.35, 5, 10), cy1 = wob(VH * (0.72 + bend * 0.5), 6, 8);
      const cx2 = wob(VW * 0.7, 7, 10), cy2 = wob(VH * (0.3 + bend), 8, 8);
      const ang = Math.atan2(y1 - cy2, x1 - cx2);
      const arm = (da, len) => {
        const a = ang + Math.PI + da;
        return [Math.cos(a) * len, Math.sin(a) * len];
      };
      const a1 = arm(0.5, wob(34, 9, 6)), a2 = arm(-0.5, wob(34, 10, 6));

      // 放置：箭头尖贴近目标边缘中点
      const tipX = (x1 / VW) * W, tipY = (y1 / VH) * H;
      const gap = o.gap ?? 1.5 * u;
      const left = side === "left" ? ex - gap - tipX : ex + ew + gap - (W - tipX);
      const top = ey + eh / 2 - tipY;

      const wrap = document.createElement("div");
      wrap.className = "kit-hw-arrow";
      Object.assign(wrap.style, {
        position: "absolute", left: left + "px", top: top + "px", width: W + "px", height: H + "px",
        pointerEvents: "none", zIndex: 5,
      });
      parent.appendChild(wrap);
      const jit = document.createElement("div");
      Object.assign(jit.style, { position: "absolute", left: 0, top: 0, width: "100%", height: "100%" });
      wrap.appendChild(jit);
      const svg = mk("svg", { viewBox: `0 0 ${VW} ${VH}`, width: "100%", height: "100%" }, jit);
      svg.style.overflow = "visible";
      svg.style.display = "block";
      if (side === "right") svg.style.transform = "scaleX(-1)";

      const base = { fill: "none", stroke: color, "stroke-width": sw, "stroke-linecap": "round", "stroke-linejoin": "round" };
      const f = (v) => v.toFixed(1);
      const curve = mk("path", Object.assign({
        d: `M ${f(x0)} ${f(y0)} C ${f(cx1)} ${f(cy1)}, ${f(cx2)} ${f(cy2)}, ${f(x1)} ${f(y1)}`,
      }, base), svg);

      let draw = curve;
      if (sType === "soft") {
        curve.style.filter = `blur(${cfg.blur}px)`;
      } else if (sType === "sharp" || sType === "spray") {
        const id = "kit-hwa-mask-" + myId;
        const defs = mk("defs", {});
        svg.insertBefore(defs, svg.firstChild);
        const mask = mk("mask", { id, maskUnits: "userSpaceOnUse", x: -100, y: -100, width: VW + 200, height: VH + 200 }, defs);
        draw = mk("path", {
          d: curve.getAttribute("d"), fill: "none", stroke: "#fff",
          "stroke-width": sw * (sType === "spray" ? 2 + (cfg.scatter * 2) / sw : 1.7),
          "stroke-linecap": "round", "stroke-linejoin": "round",
        }, mask);
        const group = mk("g", { mask: `url(#${id})` });
        svg.insertBefore(group, curve);
        group.appendChild(curve);
        if (sType === "sharp") {
          curve.setAttribute("stroke-dasharray", f(cfg.dash[0] * sw) + " " + f(cfg.dash[1] * sw));
        } else {
          curve.setAttribute("stroke-opacity", cfg.coreOpacity);
          curve.style.filter = `blur(${cfg.coreBlur}px)`;
          const len = curve.getTotalLength();
          const n = Math.round(len * cfg.density);
          const dots = mk("g", {}, group);
          for (let i = 0; i < n; i++) {
            const t = Math.min(1, Math.max(0, (i + 0.5) / n + (hash(i * 7, seed) * 0.35) / n));
            const pt = curve.getPointAtLength(t * len);
            const pt2 = curve.getPointAtLength(Math.min(len, t * len + 0.5));
            const tx = pt2.x - pt.x, ty = pt2.y - pt.y;
            const tl2 = Math.hypot(tx, ty) || 1;
            const nx = -ty / tl2, ny = tx / tl2;
            const off = hash(i * 7 + 1, seed) * (cfg.scatter + sw * 0.55);
            const r = cfg.rMin + Math.abs(hash(i * 7 + 2, seed)) * (cfg.rMax - cfg.rMin);
            mk("circle", { cx: f(pt.x + nx * off), cy: f(pt.y + ny * off), r: r.toFixed(2), fill: color }, dots);
          }
        }
      }

      // 箭头尖（沿行进方向拉伸）
      const headG = mk("g", {}, svg);
      mk("path", Object.assign({
        d: `M ${f(x1)} ${f(y1)} l ${f(a1[0])} ${f(a1[1])} M ${f(x1)} ${f(y1)} l ${f(a2[0])} ${f(a2[1])}`,
      }, base), headG);
      const xs = [x1, x1 + a1[0], x1 + a2[0]], ys = [y1, y1 + a1[1], y1 + a2[1]];
      const hcx = (Math.min(...xs) + Math.max(...xs)) / 2, hcy = (Math.min(...ys) + Math.max(...ys)) / 2;
      const angDeg = (ang * 180) / Math.PI;
      const setStretch = (s) => {
        const a = 1 + s;
        headG.setAttribute("transform",
          `translate(${hcx} ${hcy}) rotate(${angDeg}) scale(${a} ${1 / a}) rotate(${-angDeg}) translate(${-hcx} ${-hcy})`);
      };
      setStretch(0);
      headG.style.opacity = 0;

      // 画线：加速冲向箭头尖
      const len = draw.getTotalLength() || 400;
      draw.setAttribute("stroke-dasharray", len + " " + len);
      draw.setAttribute("stroke-dashoffset", len);
      draw.style.opacity = 0;
      const drawAt = A + 0.4 * k, drawDur = 0.7 * k, arrive = drawAt + drawDur;
      tl.set(draw, { opacity: 1 }, drawAt);
      tl.tween(draw, { attr: { "stroke-dashoffset": 0 } }, { at: drawAt, dur: drawDur, ease: "inQuad" });

      // 到达拉伸 + 弹簧回弹
      const v = 2 * (len / drawDur);
      const S = Math.min(0.06 * (v / 2000), 0.25);
      const d1 = (2 / 30) * k, hold = (3 / 30) * k, rec = SPRING_T * k;
      const win = hold + rec;
      tl.set(headG, { opacity: 1 }, arrive);
      tl.call((p) => {
        const tau = p * win;
        let s = 0;
        if (p > 0) {
          if (tau < d1) s = S * outQuart(tau / d1);
          else if (tau < hold) s = S;
          else s = S * (1 - spring((tau - hold) / rec));
        }
        setStretch(s);
      }, { at: arrive, dur: win, ease: "linear" });

      // 停留抖动（10Hz 跳变）
      if (boil) {
        const amp = boil.amp * (u / 10.8);
        tl.call((p) => {
          const step = Math.floor((p * dur * 30) / 3);
          const bx = hash(step * 3, seed) * amp;
          const by = hash(step * 3 + 1, seed) * amp;
          const br = hash(step * 3 + 2, seed) * boil.rot;
          jit.style.transform = `translate(${bx.toFixed(2)}px, ${by.toFixed(2)}px) rotate(${br.toFixed(3)}deg)`;
        }, { at: A, dur: dur, ease: "linear" });
      }

      // 退场
      tl.tween(wrap, { opacity: [1, 0] }, { at: A + 3.4 * k, dur: 0.3 * k, ease: "inQuad" });
    });
    return tl;
  };
})();
