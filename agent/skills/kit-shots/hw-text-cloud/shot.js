/* 改编自 Apache-2.0 许可的开源素材，动画和写法有改动。许可证原文见 /opt/slate/licenses/kit/LICENSE */
KIT.shots["hw-text-cloud"] = function (root, o = {}) {
  const content = Object.assign({
    text: "你到底在看什么呀？", // 气泡里的手写台词
    x: 620,        // 气泡左上角 x
    y: 180,        // 气泡左上角 y
    w: 560,        // 气泡宽
    h: 300,        // 气泡高
    fontSize: 58,  // 字号
    tipSide: "bottom-left", // 尾巴方向 bottom-left | bottom-right
    tipLen: 90,    // 尾巴长度
    seed: 6,       // 轮廓随机种子
    boil: true,    // 是否逐格抖动
    boilAmp: 1.6,  // 抖动位移幅度
    boilRot: 0.4,  // 抖动旋转幅度
    boilFrameDrop: 3, // 每几帧换一次抖动
    typeCharDelay: 0.03 // 每个字的间隔
  }, o.content);
  const theme = Object.assign({
    "--hw-ink": "#f4f2ec",
    "--hw-ink-dark": "#26241f",
    "--kit-font": "\"Caveat\", \"Ma Shan Zheng\", \"Noto Sans CJK SC\", cursive"
  }, o.theme);
  const { k, d } = KIT.fit(6, o.dur);

  // 字体
  ["/assets/fonts/lib/caveat.css", "/assets/fonts/lib/ma-shan-zheng.css"].forEach(href => {
    if (!document.querySelector('link[href="' + href + '"]')) {
      const l = document.createElement("link");
      l.rel = "stylesheet"; l.href = href;
      document.head.appendChild(l);
    }
  });
  SLATE.waits = SLATE.waits || [];
  SLATE.waits.push(document.fonts.load('700 58px "Caveat"', "Aa").catch(() => {}));
  SLATE.waits.push(document.fonts.load('400 58px "Ma Shan Zheng"', content.text).catch(() => {}));

  KIT.css("hw-text-cloud", `
    .kit-hw-text-cloud{font-family:var(--kit-font);}
    .kit-hw-text-cloud .tc-wrap{position:absolute;pointer-events:none;}
    .kit-hw-text-cloud .tc-wrap svg{position:absolute;inset:0;width:100%;height:100%;overflow:visible;}
    .kit-hw-text-cloud .tc-fill{fill:var(--hw-ink);opacity:0;}
    .kit-hw-text-cloud .tc-stroke{fill:none;stroke:var(--hw-ink-dark);stroke-width:4;stroke-linecap:round;stroke-linejoin:round;}
    .kit-hw-text-cloud .tc-text{position:absolute;display:flex;align-items:center;justify-content:center;text-align:center;font-weight:700;color:var(--hw-ink-dark);line-height:1.05;}
    .kit-hw-text-cloud .tc-text .ch{opacity:0;}
  `);
  const stage = KIT.stage(root, 1920, 1080);
  stage.classList.add("kit-hw-text-cloud");
  KIT.theme(stage, theme);

  const hash = (n, seed) => {
    const x = Math.sin(n * 127.1 + (seed || 1) * 311.7) * 43758.5453;
    return (x - Math.floor(x)) * 2 - 1;
  };

  function cloudPath(W, H, side, tipLen, seed) {
    const cx = W / 2, cy = H / 2 - 14, rx = W / 2 - 12, ry = H / 2 - 34;
    const N = 16, pts = [];
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2;
      const wr = 1 + hash(i * 11 + 3, seed) * 0.06;
      pts.push([cx + Math.cos(a) * rx * wr, cy + Math.sin(a) * ry * wr]);
    }
    const mx = (pts[0][0] + pts[N - 1][0]) / 2, my = (pts[0][1] + pts[N - 1][1]) / 2;
    let p = "M" + mx.toFixed(1) + " " + my.toFixed(1);
    for (let j = 0; j < N; j++) {
      const a = pts[j], b = pts[(j + 1) % N];
      p += " Q" + a[0].toFixed(1) + " " + a[1].toFixed(1) + " " + ((a[0] + b[0]) / 2).toFixed(1) + " " + ((a[1] + b[1]) / 2).toFixed(1);
    }
    p += "Z";
    const left = side !== "bottom-right";
    const bx = cx + (left ? -rx * 0.45 : rx * 0.45), by = cy + ry * 0.92;
    const tx = bx + (left ? -tipLen * 0.5 : tipLen * 0.5), ty = by + tipLen;
    p += " M " + (bx - 26).toFixed(1) + " " + (by - 6).toFixed(1) +
      " Q " + (bx - 8 + hash(31, seed) * 6).toFixed(1) + " " + ((by + ty) / 2).toFixed(1) +
      " " + tx.toFixed(1) + " " + ty.toFixed(1) +
      " Q " + (bx + 18).toFixed(1) + " " + ((by + ty) / 2).toFixed(1) +
      " " + (bx + 30).toFixed(1) + " " + (by - 2).toFixed(1);
    return p;
  }

  const W = content.w, H = content.h;
  const wrap = document.createElement("div");
  wrap.className = "tc-wrap";
  Object.assign(wrap.style, { left: content.x + "px", top: content.y + "px", width: W + "px", height: H + "px" });
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 " + W + " " + H);
  const pathD = cloudPath(W, H, content.tipSide, content.tipLen, content.seed);
  const fillEl = document.createElementNS(NS, "path");
  fillEl.setAttribute("class", "tc-fill");
  fillEl.setAttribute("d", pathD);
  const stroke = document.createElementNS(NS, "path");
  stroke.setAttribute("class", "tc-stroke");
  stroke.setAttribute("d", pathD);
  svg.appendChild(fillEl); svg.appendChild(stroke);
  wrap.appendChild(svg);

  const text = document.createElement("div");
  text.className = "tc-text";
  Object.assign(text.style, {
    left: W * 0.12 + "px", top: H * 0.1 + "px", width: W * 0.76 + "px", height: H * 0.62 + "px",
    fontSize: content.fontSize + "px"
  });
  const inner = document.createElement("div");
  Array.from(content.text).forEach(ch => {
    const s = document.createElement("span");
    s.className = "ch";
    s.textContent = ch;
    inner.appendChild(s);
  });
  text.appendChild(inner);
  wrap.appendChild(text);
  stage.appendChild(wrap);

  const tl = SLATE.timeline();
  const len = stroke.getTotalLength ? stroke.getTotalLength() || 1600 : 1600;
  stroke.style.strokeDasharray = len;
  stroke.style.strokeDashoffset = len;

  const t0 = 0.3 * k;
  tl.tween(stroke, { strokeDashoffset: [len, 0] }, { at: t0, dur: 0.8 * k, ease: "inOutCubic" });
  tl.tween(fillEl, { opacity: [0, 0.94] }, { at: t0 + 0.55 * k, dur: 0.4 * k, ease: "outCubic" });
  const chars = Array.from(inner.querySelectorAll(".ch"));
  const each = Math.min(content.typeCharDelay, 1.8 / Math.max(1, chars.length)) * k;
  tl.tween(chars, { opacity: [0, 1] }, { at: t0 + 0.9 * k, dur: 0.02, each, ease: "linear" });

  // 逐格抖动
  tl.call((p, t) => {
    if (!content.boil) { wrap.style.transform = ""; return; }
    const step = Math.floor((t * 30) / (content.boilFrameDrop || 3));
    const s = content.seed;
    const bx = hash(step * 3, s) * content.boilAmp;
    const by = hash(step * 3 + 1, s) * content.boilAmp;
    const br = hash(step * 3 + 2, s) * content.boilRot;
    wrap.style.transform = "translate(" + bx.toFixed(2) + "px," + by.toFixed(2) + "px) rotate(" + br.toFixed(3) + "deg)";
  }, { at: 0, dur: d });

  // 退场
  const OUT = SLATE.clamp(d * 0.06, 0.25, 0.6);
  tl.tween(wrap, { opacity: [1, 0] }, { at: Math.max(0, d - OUT - 0.05), dur: OUT, ease: "inCubic" });
  tl.set(stage, { visibility: "hidden" }, Math.max(0, d - 0.02));
  return tl;
};
