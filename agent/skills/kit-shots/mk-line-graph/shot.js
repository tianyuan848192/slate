/* 改编自 Apache-2.0 许可的开源素材，动画和写法有改动。许可证原文见 /opt/slate/licenses/kit/LICENSE */
KIT.shots["mk-line-graph"] = function (root, o = {}) {
  const content = Object.assign({
    // 数据系列（1～2 条）：name 图例名称，values 数值，color 留空则用主题色
    series: [
      { name: "播放量", color: null, values: [12, 26, 22, 38, 44, 58] },
      { name: "新增用户", color: null, values: [8, 14, 18, 16, 28, 36] }
    ],
    // 横轴标签
    xLabels: ["1月", "2月", "3月", "4月", "5月", "6月"],
    // 是否显示数值
    showValues: true
  }, o.content);
  const theme = Object.assign({
    "--kit-font": "\"Inter\", \"Noto Sans CJK SC\", sans-serif",
    "--kit-ink": "#1d1d1f",
    "--kit-ink-dim": "#6e6e73",
    "--kit-accent": "#0071e3",
    "--kit-accent-2": "#45d6c8",
    "--kit-paper": "#ffffff",
    "--kit-axis": "rgba(29, 29, 31, 0.22)"
  }, o.theme);
  const { k, d, exitAt } = KIT.fit(7, o.dur);

  if (!document.querySelector('link[data-kit-font="inter"]')) {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "/assets/fonts/lib/inter.css";
    link.setAttribute("data-kit-font", "inter");
    document.head.appendChild(link);
  }
  SLATE.waits = SLATE.waits || [];
  SLATE.waits.push(Promise.all([
    document.fonts.load('400 26px "Inter"'),
    document.fonts.load('500 30px "Inter"'),
    document.fonts.load('600 30px "Inter"'),
    document.fonts.load('500 30px "Noto Sans CJK SC"')
  ]).catch(() => {}));

  KIT.css("mk-line-graph", `
    .kit-mk-line-graph { font-family: var(--kit-font); overflow: hidden; }
    .kit-mk-line-graph .lg-svg { position: absolute; left: 0; top: 0; width: 1920px; height: 1080px; overflow: visible; }
    .kit-mk-line-graph .lg-labels { position: absolute; left: 0; top: 0; width: 1920px; height: 1080px; }
    .kit-mk-line-graph .lg-line { fill: none; stroke-width: 5; stroke-linecap: round; stroke-linejoin: round; }
    .kit-mk-line-graph .lg-dot { stroke-width: 4; fill: var(--kit-paper); transform-box: fill-box; transform-origin: 50% 50%; }
    .kit-mk-line-graph .lg-axis { stroke: var(--kit-axis); stroke-width: 2; }
    .kit-mk-line-graph .lg-pos { position: absolute; width: 0; height: 0; }
    .kit-mk-line-graph .lg-value { position: absolute; left: 0; top: 0; }
    .kit-mk-line-graph .lg-value > span { display: block; margin-left: -50%; }
    .kit-mk-line-graph .lg-center { position: absolute; left: 0; top: 0; display: flex; justify-content: center; width: 400px; margin-left: -200px; }
    .kit-mk-line-graph .lg-value-t { font-weight: 600; font-size: 30px; letter-spacing: -0.01em; color: var(--kit-ink); font-variant-numeric: tabular-nums; line-height: 38px; white-space: nowrap; }
    .kit-mk-line-graph .lg-xlabel-t { font-weight: 400; font-size: 26px; color: var(--kit-ink-dim); white-space: nowrap; }
    .kit-mk-line-graph .lg-legend { position: absolute; display: flex; gap: 40px; }
    .kit-mk-line-graph .lg-legend-item { display: flex; align-items: center; gap: 12px; font-weight: 500; font-size: 30px; color: var(--kit-ink-dim); white-space: nowrap; }
    .kit-mk-line-graph .lg-legend-dot { width: 14px; height: 14px; border-radius: 50%; }
  `);

  const stage = KIT.stage(root, 1920, 1080);
  stage.classList.add("kit-mk-line-graph");
  KIT.theme(stage, theme);

  const NS = "http://www.w3.org/2000/svg";
  const A = { x: 160, y: 200, w: 980, h: 500 };
  const series = (content.series || []).slice(0, 2);
  const defColors = ["var(--kit-accent)", "var(--kit-accent-2)"];
  series.forEach((s, si) => { s._color = s.color || defColors[si]; });

  let max = 0;
  series.forEach(s => s.values.forEach(v => { if (v > max) max = v; }));
  max = (max || 1) * 1.15;
  const n = series[0].values.length;
  const px = i => A.x + (n > 1 ? i / (n - 1) : 0.5) * A.w;
  const py = v => A.y + A.h - (v / max) * A.h;

  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("class", "lg-svg");
  svg.setAttribute("viewBox", "0 0 1920 1080");
  const labels = document.createElement("div");
  labels.className = "lg-labels";
  stage.appendChild(svg);
  stage.appendChild(labels);

  const axis = document.createElementNS(NS, "line");
  axis.setAttribute("class", "lg-axis");
  axis.setAttribute("x1", A.x - 20);
  axis.setAttribute("y1", A.y + A.h);
  axis.setAttribute("x2", A.x + A.w + 20);
  axis.setAttribute("y2", A.y + A.h);
  axis.style.opacity = 0;
  svg.appendChild(axis);

  const paths = [], dotEls = [], valEls = [], lens = [];
  series.forEach((s, si) => {
    const pts = s.values.map((v, i) => [px(i), py(v)]);
    let len = 0;
    for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    len = Math.ceil(len) + 2;
    lens.push(len);
    const path = document.createElementNS(NS, "path");
    path.setAttribute("class", "lg-line");
    path.setAttribute("d", pts.map((p, i) => (i === 0 ? "M" : "L") + p[0] + " " + p[1]).join(" "));
    path.style.stroke = s._color;
    path.style.strokeDasharray = len + "px";
    path.style.strokeDashoffset = len + "px";
    svg.appendChild(path);
    paths.push(path);

    dotEls.push([]); valEls.push([]);
    s.values.forEach((v, i) => {
      const dot = document.createElementNS(NS, "circle");
      dot.setAttribute("class", "lg-dot");
      dot.setAttribute("cx", px(i));
      dot.setAttribute("cy", py(v));
      dot.setAttribute("r", 9);
      dot.style.stroke = s._color;
      dot.style.transform = "scale(0)";
      svg.appendChild(dot);
      dotEls[si].push(dot);

      if (content.showValues) {
        const below = si > 0, GAP = 22;
        const pos = document.createElement("div");
        pos.className = "lg-pos";
        pos.style.left = px(i) + "px";
        pos.style.top = (py(v) + (below ? GAP : -(GAP + 38))) + "px";
        const c = document.createElement("div");
        c.className = "lg-center";
        const t = document.createElement("div");
        t.className = "lg-value-t";
        t.textContent = v;
        t.style.opacity = 0;
        c.appendChild(t); pos.appendChild(c); labels.appendChild(pos);
        valEls[si].push(t);
      }
    });
  });

  const xls = [];
  (content.xLabels || []).slice(0, n).forEach((txt, i) => {
    const pos = document.createElement("div");
    pos.className = "lg-pos";
    pos.style.left = px(i) + "px";
    pos.style.top = (A.y + A.h + 24) + "px";
    const c = document.createElement("div");
    c.className = "lg-center";
    const t = document.createElement("div");
    t.className = "lg-xlabel-t";
    t.textContent = txt;
    t.style.opacity = 0;
    c.appendChild(t); pos.appendChild(c); labels.appendChild(pos);
    xls.push(t);
  });

  const legend = document.createElement("div");
  legend.className = "lg-legend";
  legend.style.left = A.x + "px";
  legend.style.top = (A.y + A.h + 90) + "px";
  legend.style.opacity = 0;
  series.forEach(s => {
    const item = document.createElement("div");
    item.className = "lg-legend-item";
    const dot = document.createElement("span");
    dot.className = "lg-legend-dot";
    dot.style.background = s._color;
    item.appendChild(dot);
    item.appendChild(document.createTextNode(s.name));
    legend.appendChild(item);
  });
  labels.appendChild(legend);

  const tl = SLATE.timeline();
  const DRAW = 1.3 * k;

  tl.tween(axis, { opacity: [0, 1] }, { at: 0.2 * k, dur: 0.5, ease: "outCubic" });
  xls.forEach((xl, i) => {
    tl.tween(xl, { opacity: [0, 1], y: [10, 0] }, { at: (0.25 + i * 0.05) * k, dur: 0.4, ease: "outCubic" });
  });

  series.forEach((s, si) => {
    const t0 = (0.5 + si * 0.35) * k;
    tl.tween(paths[si], { strokeDashoffset: [lens[si], 0] }, { at: t0, dur: DRAW, ease: "inOutCubic" });
    s.values.forEach((v, i) => {
      const td = t0 + (n > 1 ? i / (n - 1) : 0) * DRAW * 0.92;
      tl.tween(dotEls[si][i], { scale: [0, 1] }, { at: td, dur: 0.35, ease: "outBack(1.2)" });
      if (valEls[si][i]) {
        tl.tween(valEls[si][i], { opacity: [0, 1], y: [8, 0] }, { at: td + 0.06, dur: 0.35, ease: "outCubic" });
      }
    });
  });

  tl.tween(legend, { opacity: [0, 1] }, { at: 2.3 * k, dur: 0.5, ease: "outCubic" });

  tl.tween([svg, labels], { opacity: [1, 0], y: [0, -20] }, { at: exitAt(0.5), dur: 0.4, ease: "inCubic" });

  return tl;
};
