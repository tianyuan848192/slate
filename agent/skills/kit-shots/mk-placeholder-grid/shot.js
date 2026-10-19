/* 改编自 Apache-2.0 许可的开源素材，动画和写法有改动。许可证原文见 /opt/slate/licenses/kit/LICENSE */
KIT.shots["mk-placeholder-grid"] = function (root, o = {}) {
  const content = Object.assign({
    layout: "1+2",      // 版式："2up" | "3up" | "4up" | "3x2" | "1+2"（左侧大图 + 右侧两格）
    margin: 120,         // 外边距 px
    gap: 40,             // 格间距 px
    radius: 40,          // 圆角半径 px
    // 每格一项：src 图片地址（null 为渐变占位），label 占位文字（默认序号），insideScale 格内缩放
    cells: [
      { src: null, insideScale: 1 },
      { src: null, insideScale: 1 },
      { src: null, insideScale: 1 }
    ],
    kenBurns: true,      // 格内画面缓慢收拢
    stagger: 0.15,       // 入场错开间隔（秒）
    animationIn: true,   // 播放入场
    animationOut: true   // 播放退场
  }, o.content);
  const theme = Object.assign({
    "--kit-font": "\"Inter\", \"Noto Sans CJK SC\", -apple-system, sans-serif",
    "--kit-paper": "#ffffff",
    "--kit-blob-1": "#ff7ac8",
    "--kit-blob-1-soft": "#ffd3ec",
    "--kit-blob-2": "#45d6c8",
    "--kit-blob-2-soft": "#d9fff8",
    "--kit-accent-dark": "#7d5cff",
    "--kit-accent-dark-soft": "#cabdff",
    "--kit-well-warm": "#ffb86b",
    "--kit-well-warm-soft": "#ffe3c2",
    "--kit-well-sky": "#5cb8ff",
    "--kit-well-sky-soft": "#cfe9ff",
    "--kit-well-rose": "#ff8f8f",
    "--kit-well-rose-soft": "#ffd6d6",
    "--kit-well-num": "rgba(255, 255, 255, 0.9)",
    "--kit-shadow": "0 24px 64px rgba(0, 0, 0, 0.16)"
  }, o.theme);
  const { k, d } = KIT.fit(8, o.dur);

  if (!document.querySelector('link[data-kit-font="inter"]')) {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "/assets/fonts/lib/inter.css";
    link.setAttribute("data-kit-font", "inter");
    document.head.appendChild(link);
  }
  SLATE.waits = SLATE.waits || [];
  SLATE.waits.push(document.fonts.load('600 88px "Inter"').catch(() => {}));

  KIT.css("mk-placeholder-grid", `
    .kit-mk-placeholder-grid { overflow: hidden; }
    .kit-mk-placeholder-grid .pg-grid { position: absolute; inset: 0; }
    .kit-mk-placeholder-grid .pg-cell {
      position: absolute; overflow: hidden;
      background: var(--kit-paper); box-shadow: var(--kit-shadow);
    }
    .kit-mk-placeholder-grid .pg-media {
      position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; display: block;
    }
    .kit-mk-placeholder-grid .pg-well {
      position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
    }
    .kit-mk-placeholder-grid .pg-num {
      font-family: var(--kit-font); font-weight: 600; font-size: 88px;
      letter-spacing: -0.02em; color: var(--kit-well-num); white-space: nowrap;
    }
  `);

  const stage = KIT.stage(root, 1920, 1080);
  stage.classList.add("kit-mk-placeholder-grid");
  KIT.theme(stage, theme);
  stage.innerHTML = `<div class="pg-grid"></div>`;
  const grid = stage.querySelector(".pg-grid");

  const FILLS = [
    "linear-gradient(135deg, var(--kit-blob-1) 0%, var(--kit-blob-1-soft) 100%)",
    "linear-gradient(135deg, var(--kit-blob-2) 0%, var(--kit-blob-2-soft) 100%)",
    "linear-gradient(135deg, var(--kit-accent-dark) 0%, var(--kit-accent-dark-soft) 100%)",
    "linear-gradient(135deg, var(--kit-well-warm) 0%, var(--kit-well-warm-soft) 100%)",
    "linear-gradient(135deg, var(--kit-well-sky) 0%, var(--kit-well-sky-soft) 100%)",
    "linear-gradient(135deg, var(--kit-well-rose) 0%, var(--kit-well-rose-soft) 100%)"
  ];
  const W = 1920, H = 1080;
  function rects(layout, m, g) {
    const iw = W - 2 * m, ih = H - 2 * m;
    function gridOf(cols, rows) {
      const cw = (iw - (cols - 1) * g) / cols, ch = (ih - (rows - 1) * g) / rows, out = [];
      for (let r = 0; r < rows; r++)
        for (let c = 0; c < cols; c++)
          out.push({ x: m + c * (cw + g), y: m + r * (ch + g), w: cw, h: ch });
      return out;
    }
    if (layout === "2up") return gridOf(2, 1);
    if (layout === "3up") return gridOf(3, 1);
    if (layout === "4up") return gridOf(2, 2);
    if (layout === "3x2") return gridOf(3, 2);
    const w1 = Math.round((iw - g) * 0.58), w2 = iw - g - w1, h2 = (ih - g) / 2;
    return [
      { x: m, y: m, w: w1, h: ih },
      { x: m + w1 + g, y: m, w: w2, h: h2 },
      { x: m + w1 + g, y: m + h2 + g, w: w2, h: h2 }
    ];
  }

  const R = rects(content.layout, content.margin, content.gap);
  const cells = [], medias = [], bases = [];
  R.forEach((r, i) => {
    const conf = (content.cells && content.cells[i]) || {};
    const cell = document.createElement("div");
    cell.className = "pg-cell";
    Object.assign(cell.style, {
      left: r.x + "px", top: r.y + "px", width: r.w + "px", height: r.h + "px",
      borderRadius: content.radius + "px"
    });
    let inner;
    if (conf.src) {
      inner = document.createElement("img");
      inner.className = "pg-media";
      inner.src = conf.src;
      SLATE.waits.push(inner.decode ? inner.decode().catch(() => {}) : Promise.resolve());
    } else {
      inner = document.createElement("div");
      inner.className = "pg-well";
      inner.style.background = FILLS[i % FILLS.length];
      const num = document.createElement("span");
      num.className = "pg-num";
      num.textContent = conf.label != null ? String(conf.label) : String(i + 1);
      inner.appendChild(num);
    }
    cell.appendChild(inner);
    grid.appendChild(cell);
    cells.push(cell);
    medias.push(inner);
    bases.push(conf.insideScale || 1);
  });

  const tl = SLATE.timeline();
  cells.forEach((cell, i) => {
    const t0 = ((content.animationIn ? 0.3 : 0) + i * content.stagger) * k;
    const base = bases[i];
    tl.set(medias[i], { scale: base }, 0);
    if (content.animationIn) {
      tl.tween(cell, { opacity: [0, 1], scale: [0.92, 1], y: [28, 0] }, { at: t0, dur: 0.65 * k, ease: "outQuart" });
    }
    if (content.kenBurns) {
      tl.tween(medias[i], { scale: [base * 1.06, base] }, { at: t0, dur: Math.max(0.1, d - t0 - 0.6), ease: "outSine" });
    }
  });
  if (content.animationOut) {
    tl.tween(grid, { opacity: 0, y: -20 }, { at: Math.max(0, d - 0.5), dur: 0.4, ease: "inCubic" });
  }
  tl.set(grid, { visibility: "visible" }, 0);
  tl.set(grid, { visibility: "hidden" }, Math.max(0, d - 0.02));
  return tl;
};
