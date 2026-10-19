/* 改编自 Apache-2.0 许可的开源素材，动画和写法有改动。许可证原文见 /opt/slate/licenses/kit/LICENSE */
(function () {
  if (!document.querySelector('link[data-kit-font="caveat"]')) {
    ["/assets/fonts/lib/caveat.css", "/assets/fonts/lib/ma-shan-zheng.css"].forEach(function (href, i) {
      var l = document.createElement("link");
      l.rel = "stylesheet";
      l.href = href;
      l.setAttribute("data-kit-font", i ? "ma-shan-zheng" : "caveat");
      document.head.appendChild(l);
    });
  }
  SLATE.waits = SLATE.waits || [];
  SLATE.waits.push(document.fonts.load('700 56px "Caveat"'), document.fonts.load('400 56px "Ma Shan Zheng"', "想法录制发布"));
})();

KIT.shots["hw-pipeline"] = function (root, o = {}) {
  const content = Object.assign({
    nodes: ["想法", "录制", "发布！"], // 节点标签，按顺序描出
    boxW: 320,      // 方框宽
    boxH: 170,      // 方框高
    gap: 190,       // 方框间距
    y: 455,         // 方框顶边
    fontSize: 56,   // 标签字号
    seed: 11,       // 手绘随机种子
    boil: true      // 逐帧抖动
  }, o.content);
  const theme = Object.assign({
    "--kit-ink": "#f4f2ec",
    "--kit-accent": "#ffb020",
    "--kit-font": "\"Caveat\", \"Ma Shan Zheng\", \"Noto Sans CJK SC\", cursive"
  }, o.theme);
  const { k, d, exitAt } = KIT.fit(7, o.dur);

  KIT.css("hw-pipeline", `
    .kit-hw-pipeline { font-family: var(--kit-font); }
    .kit-hw-pipeline .hp-svg { position:absolute; left:0; top:0; width:100%; height:100%; overflow:visible; }
    .kit-hw-pipeline .hp-svg path { fill:none; stroke-linecap:round; stroke-linejoin:round; }
    .kit-hw-pipeline .hp-box { stroke: var(--kit-ink); stroke-width:6; }
    .kit-hw-pipeline .hp-conn { stroke: var(--kit-accent); stroke-width:5; transform-box: fill-box; transform-origin: center; }
    .kit-hw-pipeline .hp-labels { position:absolute; left:0; top:0; width:100%; height:100%; }
    .kit-hw-pipeline .hp-label { position:absolute; text-align:center; font-weight:700; line-height:1.24;
      color: var(--kit-ink); white-space:nowrap; opacity:0; text-shadow:0 2px 14px rgba(0,0,0,0.4); }
  `);

  const stage = KIT.stage(root, 1920, 1080);
  stage.classList.add("kit-hw-pipeline");
  KIT.theme(stage, theme);
  stage.innerHTML = `<svg class="hp-svg" viewBox="0 0 1920 1080"></svg><div class="hp-labels"></div>`;
  const svg = stage.querySelector(".hp-svg");
  const labels = stage.querySelector(".hp-labels");
  const NS = "http://www.w3.org/2000/svg";

  const hash = (n, seed) => {
    const x = Math.sin(n * 127.1 + (seed || 1) * 311.7) * 43758.5453;
    return (x - Math.floor(x)) * 2 - 1;
  };
  const wobbleRect = (w, h, r, seed, amp = 3.5) => {
    const q = n => hash(n, seed) * amp;
    let s = `M ${r + q(1)} ${q(2)}`;
    s += ` L ${w / 2 + q(3)} ${q(4)} L ${w - r + q(5)} ${q(6)}`;
    s += ` Q ${w + q(7)} ${q(8)} ${w + q(9)} ${r + q(10)}`;
    s += ` L ${w + q(11)} ${h / 2 + q(12)} L ${w + q(13)} ${h - r + q(14)}`;
    s += ` Q ${w + q(15)} ${h + q(16)} ${w - r + q(17)} ${h + q(18)}`;
    s += ` L ${w / 2 + q(19)} ${h + q(20)} L ${r + q(21)} ${h + q(22)}`;
    s += ` Q ${q(23)} ${h + q(24)} ${q(25)} ${h - r + q(26)}`;
    s += ` L ${q(27)} ${h / 2 + q(28)} L ${q(29)} ${r + q(30)}`;
    s += ` Q ${q(31)} ${q(32)} ${r + q(33)} ${q(34)}`;
    return s;
  };

  const C = content;
  const nodes = C.nodes.map(v => (typeof v === "string" ? v : v.label));
  const n = nodes.length;
  const totalW = n * C.boxW + (n - 1) * C.gap;
  const x0 = (1920 - totalW) / 2;
  const boxes = [], boxG = [], conns = [], labelEls = [];

  nodes.forEach((text, i) => {
    const bx = x0 + i * (C.boxW + C.gap);
    const gOuter = document.createElementNS(NS, "g");
    gOuter.setAttribute("transform", `translate(${bx} ${C.y})`);
    const g = document.createElementNS(NS, "g");
    gOuter.appendChild(g);
    const p = document.createElementNS(NS, "path");
    p.setAttribute("class", "hp-box");
    p.setAttribute("d", wobbleRect(C.boxW, C.boxH, 24, C.seed + i));
    g.appendChild(p);
    svg.appendChild(gOuter);
    boxes.push(p); boxG.push(g);

    const label = document.createElement("div");
    label.className = "hp-label";
    label.textContent = text;
    label.style.left = bx + "px";
    label.style.top = (C.y + C.boxH / 2 - C.fontSize * 0.62) + "px";
    label.style.width = C.boxW + "px";
    label.style.fontSize = C.fontSize + "px";
    labels.appendChild(label);
    labelEls.push(label);

    if (i < n - 1) {
      const cx = bx + C.boxW, cy = C.y + C.boxH / 2;
      const ex = cx + C.gap, ey = cy;
      const sx = cx + 10, tx = ex - 10;
      const qx = cx + C.gap / 2 + hash(i * 9 + 2, C.seed) * 16;
      const qy = cy - 46 - hash(i * 9 + 3, C.seed) * 12;
      const ang = Math.atan2(ey - qy, tx - qx) + Math.PI;
      const BARB = 26, SPREAD = 0.42;
      const b1x = tx + BARB * Math.cos(ang - SPREAD), b1y = ey + BARB * Math.sin(ang - SPREAD);
      const b2x = tx + BARB * Math.cos(ang + SPREAD), b2y = ey + BARB * Math.sin(ang + SPREAD);
      const c = document.createElementNS(NS, "path");
      c.setAttribute("class", "hp-conn");
      c.setAttribute("d", `M ${sx} ${cy} Q ${qx} ${qy} ${tx} ${ey} M ${tx} ${ey} L ${b1x} ${b1y} M ${tx} ${ey} L ${b2x} ${b2y}`);
      svg.appendChild(c);
      conns.push(c);
    }
  });

  const tl = SLATE.timeline();

  // 顺序：方框描出 → 标签淡入 → 箭头描出 → 下一个方框
  let t = 0.3;
  nodes.forEach((_, i) => {
    const p = boxes[i];
    const len = p.getTotalLength();
    p.style.strokeDasharray = len;
    p.style.strokeDashoffset = len;
    tl.tween(p, { strokeDashoffset: [len, 0] }, { at: t * k, dur: 0.65 * k, ease: "inOutCubic" });
    tl.tween(labelEls[i], { opacity: [0, 1] }, { at: (t + 0.45) * k, dur: 0.35 * k, ease: "outCubic" });
    t += 0.7;
    if (i < conns.length) {
      const c = conns[i];
      const cl = c.getTotalLength();
      c.style.strokeDasharray = cl;
      c.style.strokeDashoffset = cl;
      tl.tween(c, { strokeDashoffset: [cl, 0] }, { at: t * k, dur: 0.45 * k, ease: "inOutCubic" });
      t += 0.5;
    }
  });

  // 逐帧抖动：30fps 下每 3 帧换一个姿态
  if (C.boil) {
    const amp = 1.6, rot = 0.4, fps = 30, drop = 3, seed = C.seed;
    const cxB = C.boxW / 2, cyB = C.boxH / 2;
    const targets = boxG.concat(conns, labelEls);
    tl.call((p, tt) => {
      const step = Math.floor((tt * fps) / drop);
      targets.forEach((el, i) => {
        const x = hash(step * 3 + i * 97, seed) * amp;
        const y = hash(step * 3 + 1 + i * 97, seed) * amp;
        const r = hash(step * 3 + 2 + i * 97, seed) * rot;
        if (i < boxG.length) {
          el.setAttribute("transform", `translate(${x} ${y}) rotate(${r} ${cxB} ${cyB})`);
        } else {
          el.style.transform = `translate(${x}px, ${y}px) rotate(${r}deg)`;
        }
      });
    }, { at: 0, dur: d });
  }

  // 退场
  const OUT = SLATE.clamp(d * 0.06, 0.25, 0.6);
  tl.tween([svg, labels], { opacity: [1, 0] }, { at: exitAt(OUT + 0.05), dur: OUT, ease: "inCubic" });
  tl.set(stage, { visibility: "hidden" }, Math.max(0, d - 0.02));
  return tl;
};
