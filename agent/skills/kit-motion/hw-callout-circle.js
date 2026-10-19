/* 改编自 Apache-2.0 许可的开源素材，动画和写法有改动。许可证原文见 /opt/slate/licenses/kit/LICENSE */
/** 手绘圈注：抖动椭圆圈住目标→斜线填充→弧形引线→手写标签带冲劲弹出，圈线受压回弹并持续轻微抖动。参数：at, dur, label, labelAt, strokeType, boil, scribble, connector, seed, padX, padY, outAt, ink, accent, font */
(function () {
  KIT.motions = KIT.motions || {};
  const NS = "http://www.w3.org/2000/svg";
  let uid = 0;
  const hash = (n, seed) => { const x = Math.sin(n * 127.1 + (seed || 1) * 311.7) * 43758.5453; return (x - Math.floor(x)) * 2 - 1; };

  function wobbleEllipse(cx, cy, rx, ry, seed, pct) {
    const N = 14, pts = [];
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2, wr = 1 + hash(i * 13 + 5, seed) * (pct / 100);
      pts.push([cx + Math.cos(a) * rx * wr, cy + Math.sin(a) * ry * wr]);
    }
    let d = "M" + ((pts[0][0] + pts[N - 1][0]) / 2).toFixed(1) + " " + ((pts[0][1] + pts[N - 1][1]) / 2).toFixed(1);
    for (let j = 0; j < N; j++) {
      const p = pts[j], q = pts[(j + 1) % N];
      d += " Q" + p[0].toFixed(1) + " " + p[1].toFixed(1) + " " + ((p[0] + q[0]) / 2).toFixed(1) + " " + ((p[1] + q[1]) / 2).toFixed(1);
    }
    return d;
  }

  function spring(zeta, response) {
    const w0 = (2 * Math.PI) / response, T = Math.log(1000) / (zeta * w0);
    const wd = w0 * Math.sqrt(1 - zeta * zeta);
    const x = t => 1 - Math.exp(-zeta * w0 * t) * (Math.cos(wd * t) + ((zeta * w0) / wd) * Math.sin(wd * t));
    const xT = x(T);
    return { ease: p => (p >= 1 ? 1 : x(p * T) / xT), duration: T };
  }
  const SPR = spring(0.9, 0.22);

  // 笔触：返回需要做描线动画的路径（plain/soft 是自身，sharp/spray 是遮罩里的克隆）
  function strokeApply(path, type, w, f, seed) {
    if (type === "soft") { path.style.filter = "blur(" + (0.6 * f).toFixed(2) + "px)"; return path; }
    if (type !== "sharp" && type !== "spray") return path;
    const svg = path.ownerSVGElement;
    let defs = svg.querySelector("defs");
    if (!defs) { defs = document.createElementNS(NS, "defs"); svg.insertBefore(defs, svg.firstChild); }
    const id = "kit-hwco-m" + (++uid);
    const mask = document.createElementNS(NS, "mask");
    mask.setAttribute("id", id); mask.setAttribute("maskUnits", "userSpaceOnUse");
    const clone = document.createElementNS(NS, "path");
    clone.setAttribute("d", path.getAttribute("d"));
    clone.setAttribute("fill", "none"); clone.setAttribute("stroke", "#fff");
    const scatter = 2.6 * f;
    clone.setAttribute("stroke-width", type === "spray" ? 2 * w + 2 * scatter : w * 1.7);
    clone.setAttribute("stroke-linecap", "round"); clone.setAttribute("stroke-linejoin", "round");
    mask.appendChild(clone); defs.appendChild(mask);
    const g = document.createElementNS(NS, "g");
    g.setAttribute("mask", "url(#" + id + ")");
    path.parentNode.insertBefore(g, path); g.appendChild(path);
    if (type === "sharp") {
      path.setAttribute("stroke-dasharray", (3 * w).toFixed(1) + " " + (1.55 * w).toFixed(1));
    } else {
      path.setAttribute("stroke-opacity", 0.5);
      path.style.filter = "blur(" + (0.4 * f).toFixed(2) + "px)";
      const len = path.getTotalLength(), n = Math.round((len / f) * 0.16);
      const col = getComputedStyle(path).stroke, dots = document.createElementNS(NS, "g");
      for (let i = 0; i < n; i++) {
        const t = Math.min(1, Math.max(0, (i + 0.5) / n + (hash(i * 7, seed) * 0.35) / n));
        const pt = path.getPointAtLength(t * len), pt2 = path.getPointAtLength(Math.min(len, t * len + 0.5));
        const tx = pt2.x - pt.x, ty = pt2.y - pt.y, tl2 = Math.hypot(tx, ty) || 1;
        const off = hash(i * 7 + 1, seed) * (scatter + w * 0.55);
        const r = (1.1 + Math.abs(hash(i * 7 + 2, seed)) * 1.5) * f;
        const c = document.createElementNS(NS, "circle");
        c.setAttribute("cx", (pt.x - (ty / tl2) * off).toFixed(1));
        c.setAttribute("cy", (pt.y + (tx / tl2) * off).toFixed(1));
        c.setAttribute("r", r.toFixed(2)); c.setAttribute("fill", col);
        dots.appendChild(c);
      }
      g.appendChild(dots);
    }
    return clone;
  }

  KIT.css("kit-hw-callout", `
    .kit-hwco{position:absolute;pointer-events:none;}
    .kit-hwco .co-boil,.kit-hwco .co-deform,.kit-hwco .co-pop{position:absolute;inset:0;}
    .kit-hwco .co-deform{transform-origin:50% 100%;}
    .kit-hwco svg{position:absolute;inset:0;width:100%;height:100%;overflow:visible;}
    .kit-hwco path{fill:none;stroke-linecap:round;stroke-linejoin:round;}
    .kit-hwco .co-label{position:absolute;white-space:nowrap;font-weight:700;line-height:1.1;}
  `);

  KIT.motions.hwCalloutCircle = function (tl, target, o = {}) {
    const els = KIT.els(target);
    const at = o.at ?? 0, dur = o.dur ?? 2.03;
    const k = dur / 2.03;
    const u = SLATE.u, f = u / 10.8; // 原设计 1080 高时 u=10.8
    const labelAt = ["left", "right", "below"].includes(o.labelAt) ? o.labelAt : "right";
    const strokeType = o.strokeType || "plain";
    const poses = { calm: { amp: 1.6, rot: 0.5 }, lively: { amp: 2.6, rot: 0.9 } };
    const boil = o.boil === "off" ? null : poses[o.boil] || poses.calm;
    const ink = o.ink || "#f4f2ec", accent = o.accent || "#ffb020";
    const font = o.font || '"Long Cang", "Caveat", cursive';
    const fs = o.fontSize ?? 5 * u;

    els.forEach((el, idx) => {
      const seed = (o.seed ?? 4) + idx * 3;
      const parent = el.parentElement;
      if (getComputedStyle(parent).position === "static") parent.style.position = "relative";
      const pr = parent.getBoundingClientRect(), er = el.getBoundingClientRect();
      const sc = parent.offsetWidth / (pr.width || 1) || 1;
      const tw = er.width * sc, th = er.height * sc;
      const tcx = (er.left - pr.left) * sc + tw / 2, tcy = (er.top - pr.top) * sc + th / 2;
      const rx = (tw / 2) * (o.padX ?? 1.3), ry = (th / 2) * (o.padY ?? 1.2);
      const W = (2 * rx) / 0.84, H = (2 * ry) / 0.72, cx = W / 2, cy = H / 2;

      const wrap = document.createElement("div");
      wrap.className = "kit-hwco";
      wrap.setAttribute("data-qa", "ignore");
      Object.assign(wrap.style, { left: tcx - W / 2 + "px", top: tcy - H / 2 + "px", width: W + "px", height: H + "px", zIndex: 5 });
      wrap.innerHTML = `<div class="co-boil"><div class="co-deform"><svg viewBox="0 0 ${W} ${H}"><path class="co-scr"/><path class="co-out"/></svg></div><svg class="co-conn-l" viewBox="0 0 ${W} ${H}"><path class="co-conn"/></svg><div class="co-pop"><div class="co-label"></div></div></div>`;
      parent.appendChild(wrap);
      const boilEl = wrap.querySelector(".co-boil"), deform = wrap.querySelector(".co-deform");
      const outline = wrap.querySelector(".co-out"), scr = wrap.querySelector(".co-scr"), conn = wrap.querySelector(".co-conn");
      const pop = wrap.querySelector(".co-pop"), label = wrap.querySelector(".co-label");

      const wOut = 6 * f, wConn = 4 * f;
      Object.assign(outline.style, { stroke: ink, strokeWidth: wOut });
      Object.assign(scr.style, { stroke: accent, strokeWidth: 3 * f, opacity: 0.42 });
      Object.assign(conn.style, { stroke: ink, strokeWidth: wConn });
      outline.setAttribute("d", wobbleEllipse(cx, cy, rx, ry, seed, 4));

      // 斜线填充
      let d = "";
      const rows = 11;
      for (let i = 0; i < rows; i++) {
        const yy = cy - ry + ((i + 0.5) / rows) * ry * 2;
        const half = Math.sqrt(Math.max(0.05, 1 - Math.pow((yy - cy) / ry, 2)));
        const xw = rx * half * 0.86;
        const xa = cx - xw + hash(i * 7 + 2, seed) * 8 * f, xb = cx + xw + hash(i * 7 + 3, seed) * 8 * f;
        d += (i === 0 ? "M " : " L ") + (i % 2 ? xa : xb).toFixed(1) + " " + yy.toFixed(1);
        d += " L " + (i % 2 ? xb : xa).toFixed(1) + " " + (yy + hash(i * 7 + 4, seed) * 4 * f).toFixed(1);
      }
      scr.setAttribute("d", d);
      const useScr = o.scribble !== false, useConn = o.connector !== false;
      if (!useScr) scr.style.display = "none";

      // 引线 + 标签位置
      let ex = null, ey = null;
      Object.assign(label.style, { fontFamily: font, fontSize: fs + "px", color: ink, textShadow: `0 ${0.2 * u}px ${1.3 * u}px rgba(0,0,0,0.45)` });
      const txt = Array.isArray(o.label) ? o.label[idx] ?? "" : o.label ?? "";
      label.textContent = txt;
      if (useConn) {
        const sx = labelAt === "left" ? cx - rx : labelAt === "below" ? cx : cx + rx;
        const sy = labelAt === "below" ? cy + ry : cy + ry * 0.35;
        ex = labelAt === "left" ? sx - 70 * f : labelAt === "below" ? sx + 40 * f : sx + 70 * f;
        ey = sy + 55 * f;
        conn.setAttribute("d", `M ${sx.toFixed(1)} ${sy.toFixed(1)} Q ${((sx + ex) / 2 + hash(21, seed) * 14 * f).toFixed(1)} ${(sy + 46 * f).toFixed(1)} ${ex.toFixed(1)} ${ey.toFixed(1)}`);
        if (labelAt === "left") { label.style.left = ex - 12 * f + "px"; label.style.transform = "translateX(-100%)"; }
        else label.style.left = ex + 12 * f + "px";
        label.style.top = ey - 24 * f + "px";
        pop.style.transformOrigin = `${ex.toFixed(1)}px ${ey.toFixed(1)}px`;
      } else {
        conn.style.display = "none";
        Object.assign(label.style, { left: "50%", top: "50%", transform: "translate(-50%,-50%)" });
        pop.style.transformOrigin = "50% 50%";
      }

      // 描线：外圈 → 填充 → 引线，每段在上一段 85% 处开始
      const seq = [[strokeApply(outline, strokeType, wOut, f, seed), 0.7]];
      if (useScr) seq.push([scr, 0.55]);
      if (useConn) seq.push([strokeApply(conn, strokeType, wConn, f, seed), 0.35]);
      let t = 0;
      seq.forEach(([p, dd]) => {
        const len = p.getTotalLength();
        p.setAttribute("stroke-dasharray", len + " " + len);
        p.style.strokeDashoffset = len;
        p.style.opacity = 0;
        tl.set(p, { opacity: 1 }, at + t * k);
        tl.tween(p, { strokeDashoffset: [len, 0] }, { at: at + t * k, dur: dd * k, ease: "inOutCubic" });
        t += dd * 0.85;
      });

      // 标签带冲劲弹出（加速撞到 1.0）
      const tp = at + t * k;
      tl.tween(pop, { opacity: [0, 1] }, { at: tp, dur: 0.08 * k, ease: "linear" });
      tl.tween(pop, { scale: [0.001, 1] }, { at: tp, dur: 0.3 * k, ease: "inQuad" });

      // 受压量：到达速度（inQuad 终点斜率 2 → 原式中差分约 1）× rx / 0.3，按 1080 设计稿折算
      const vPop = (rx / f) / 0.3;
      const S = Math.min(0.08 * (vPop / 2000), 0.25);
      const t0 = tp + 0.3 * k, t1 = t0 + (3 / 30) * k;
      const sq = 2 / 30 * k, sd = SPR.duration * k;

      tl.call((p, time) => {
        let s = 0;
        if (time >= t0) { const a = Math.min(1, (time - t0) / sq); s = S * (1 - Math.pow(1 - a, 4)); }
        if (time >= t1) { const b = Math.min(1, (time - t1) / sd); s = S * (1 - SPR.ease(b)); }
        const along = 1 - s;
        deform.style.transform = `scale(${(1 / along).toFixed(5)}, ${along.toFixed(5)})`;
        if (boil) {
          const step = Math.floor((time * 30) / 3);
          const bx = hash(step * 3, seed) * boil.amp * f, by = hash(step * 3 + 1, seed) * boil.amp * f;
          const br = hash(step * 3 + 2, seed) * boil.rot;
          boilEl.style.transform = `translate(${bx.toFixed(2)}px, ${by.toFixed(2)}px) rotate(${br.toFixed(3)}deg)`;
        }
      }, { at: at, dur: 0 });

      if (o.outAt != null) tl.tween(wrap, { opacity: 0 }, { at: o.outAt, dur: 0.35, ease: "inQuad" });
    });
    return tl;
  };
})();
