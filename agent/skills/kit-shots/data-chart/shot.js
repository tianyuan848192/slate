/* 改编自 Apache-2.0 许可的开源素材，动画和写法有改动。许可证原文见 /opt/slate/licenses/kit/LICENSE */
KIT.shots = KIT.shots || {};
KIT.shots["data-chart"] = function (root, o = {}) {
  const content = Object.assign({
    headline: "月度营收与转化率对比",        // 主标题
    subtitle: "2024年1–6月，营收单位：万元",  // 副标题
    barName: "营收",                       // 柱状图例
    lineName: "转化率",                    // 折线图例
    labels: ["1月", "2月", "3月", "4月", "5月", "6月"], // 横轴
    bars: [8, 12, 15, 11, 18, 22],         // 柱状数值
    line: [2.1, 2.8, 3.2, 2.9, 3.8, 4.2],  // 折线数值
    barMax: 25,                            // 柱状纵轴上限
    lineMax: 5,                            // 折线纵轴上限
    barPrefix: "¥",                        // 柱状数值前缀
    barSuffix: "万",                       // 柱状数值后缀
    lineSuffix: "%",                       // 折线数值后缀
    lineDecimals: 1,                       // 折线小数位
    source: "数据来源：内部分析平台"        // 来源
  }, o.content);
  const theme = Object.assign({
    "--kit-bg": "#faf9f6",
    "--kit-ink": "#333333",
    "--kit-muted": "#666666",
    "--kit-faint": "#999999",
    "--kit-bar": "#5c5c5c",
    "--kit-accent": "#326fa8",
    "--kit-grid": "#e8e8e8",
    "--kit-serif": "\"Newsreader\", \"Noto Serif SC\", serif",
    "--kit-font": "\"Archivo\", \"Noto Sans CJK SC\", sans-serif"
  }, o.theme);
  const { k } = KIT.fit(15, o.dur);

  ["/assets/fonts/lib/newsreader.css", "/assets/fonts/lib/archivo.css", "/assets/fonts/lib/noto-serif-sc.css"].forEach(href => {
    if (!document.querySelector('link[href="' + href + '"]')) {
      const l = document.createElement("link");
      l.rel = "stylesheet"; l.href = href;
      document.head.appendChild(l);
    }
  });
  SLATE.waits = SLATE.waits || [];
  SLATE.waits.push(
    document.fonts.load('700 48px "Newsreader"'),
    document.fonts.load('700 48px "Noto Serif SC"'),
    document.fonts.load('400 16px "Archivo"'),
    document.fonts.load('600 14px "Archivo"')
  );

  KIT.css("data-chart", `
.kit-data-chart{background:var(--kit-bg);color:var(--kit-ink);font-family:var(--kit-font);overflow:hidden}
.kit-data-chart .dc-wrap{position:relative;width:1920px;height:1080px;background:var(--kit-bg);overflow:hidden}
.kit-data-chart .dc-header{position:absolute;left:171px;top:64px;width:1577px}
.kit-data-chart .dc-headline{font-family:var(--kit-serif);font-weight:700;font-size:48px;line-height:1.2;margin:0;white-space:nowrap;clip-path:inset(0 100% 0 0)}
.kit-data-chart .dc-subtitle{font-size:18px;line-height:1.25;color:var(--kit-muted);margin:9px 0 18px 0;white-space:nowrap;clip-path:inset(0 100% 0 0)}
.kit-data-chart .dc-key{display:flex;gap:28px;opacity:0}
.kit-data-chart .dc-key-item{display:flex;align-items:center;gap:9px}
.kit-data-chart .dc-key-box{width:12px;height:12px;background:var(--kit-bar)}
.kit-data-chart .dc-key-line{width:18px;height:2px;background:var(--kit-accent)}
.kit-data-chart .dc-key-text{font-size:15px;color:var(--kit-muted)}
.kit-data-chart .dc-svg{position:absolute;left:171px;top:180px;width:1577px;height:690px;overflow:visible}
.kit-data-chart .dc-source{position:absolute;left:171px;top:818px;font-size:13px;color:var(--kit-faint);opacity:0;white-space:nowrap}
.kit-data-chart .dc-grid{stroke:var(--kit-grid);stroke-width:0.5px;opacity:0}
.kit-data-chart .dc-axis{font-size:14px;fill:var(--kit-muted);text-anchor:middle;font-family:var(--kit-font)}
.kit-data-chart .dc-bar{fill:var(--kit-bar)}
.kit-data-chart .dc-bar-label{font-size:14px;fill:var(--kit-ink);text-anchor:middle;opacity:0;font-family:var(--kit-font)}
.kit-data-chart .dc-line-label{font-size:14px;fill:var(--kit-accent);font-weight:600;text-anchor:middle;opacity:0;font-family:var(--kit-font)}
.kit-data-chart .dc-path{fill:none;stroke:var(--kit-accent);stroke-width:1.5}
.kit-data-chart .dc-dot{fill:var(--kit-accent)}
`);

  const stage = KIT.stage(root, 1920, 1080);
  stage.classList.add("kit-data-chart");
  KIT.theme(stage, theme);

  const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const n = content.labels.length;
  const chartWidth = 1400, chartHeight = 500, startX = 100, startY = 600;
  const barWidth = Math.min(80, (chartWidth / n) * 0.55);
  const spacing = (chartWidth - barWidth * n) / (n + 1);
  const getBarY = v => startY - (v / content.barMax) * chartHeight;
  const getLineY = v => startY - (v / content.lineMax) * chartHeight;
  const getX = i => startX + spacing + i * (barWidth + spacing) + barWidth / 2;

  let grid = "", axis = "", bars = "", barLabels = "", lineLabels = "";
  for (let i = 1; i <= 5; i++) {
    const y = startY - i * (chartHeight / 5);
    grid += `<line class="dc-grid" x1="${startX}" y1="${y}" x2="${startX + chartWidth}" y2="${y}"/>`;
  }
  const pts = [];
  content.labels.forEach((lab, i) => {
    const x = getX(i);
    axis += `<text class="dc-axis" x="${x}" y="${startY + 30}">${esc(lab)}</text>`;
    bars += `<rect class="dc-bar" x="${x - barWidth / 2}" y="${startY}" width="${barWidth}" height="0"/>`;
    barLabels += `<text class="dc-bar-label" x="${x}" y="${getBarY(content.bars[i]) - 10}">${esc(content.barPrefix + content.bars[i] + content.barSuffix)}</text>`;
    const ly = getLineY(content.line[i]);
    pts.push([x, ly]);
    lineLabels += `<text class="dc-line-label" x="${x}" y="${ly - 15}">${(0).toFixed(content.lineDecimals) + esc(content.lineSuffix)}</text>`;
  });
  const d = "M " + pts.map(p => p[0] + "," + p[1]).join(" L ");
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);

  stage.innerHTML = `
<div class="dc-wrap">
  <div class="dc-header">
    <h1 class="dc-headline">${esc(content.headline)}</h1>
    <p class="dc-subtitle">${esc(content.subtitle)}</p>
    <div class="dc-key">
      <div class="dc-key-item"><div class="dc-key-box"></div><span class="dc-key-text">${esc(content.barName)}</span></div>
      <div class="dc-key-item"><div class="dc-key-line"></div><span class="dc-key-text">${esc(content.lineName)}</span></div>
    </div>
  </div>
  <svg class="dc-svg" viewBox="0 0 1600 700" preserveAspectRatio="xMidYMid meet">
    <g>${grid}</g>
    <g>${axis}</g>
    <g>${bars}</g>
    <g>${barLabels}</g>
    <g>
      <path class="dc-path" d="${d}" style="stroke-dasharray:${len};stroke-dashoffset:${len}"/>
      <circle class="dc-dot" r="5" cx="${pts[0][0]}" cy="${pts[0][1]}" style="opacity:0"/>
    </g>
    <g>${lineLabels}</g>
    <line x1="100" y1="600" x2="1500" y2="600" stroke="black" stroke-width="1"/>
  </svg>
  <div class="dc-source">${esc(content.source)}</div>
</div>`;

  const q = s => stage.querySelector(s);
  const qa = s => Array.from(stage.querySelectorAll(s));
  const tl = SLATE.timeline();

  tl.tween(q(".dc-headline"), { clipPath: ["inset(0 100% 0 0)", "inset(0 0% 0 0)"] }, { at: 0, dur: 1.2 * k, ease: "inOutQuad" });
  tl.tween(q(".dc-subtitle"), { clipPath: ["inset(0 100% 0 0)", "inset(0 0% 0 0)"] }, { at: 0.2 * k, dur: 1.2 * k, ease: "inOutQuad" });
  tl.tween(q(".dc-key"), { opacity: [0, 1] }, { at: 1.0 * k, dur: 0.4 * k, ease: "outCubic" });
  tl.tween(qa(".dc-grid"), { opacity: [0, 1] }, { at: 0.5 * k, dur: 0.5 * k, each: 0.25 * k, ease: "outCubic" });

  const barEls = qa(".dc-bar"), barLabelEls = qa(".dc-bar-label");
  barEls.forEach((bar, i) => {
    const h = (content.bars[i] / content.barMax) * chartHeight;
    const st = (1.5 + i * 0.5) * k;
    tl.tween(bar, { attr: { height: [0, h], y: [startY, startY - h] } }, { at: st, dur: 0.8 * k, ease: "outCubic" });
    tl.tween(barLabelEls[i], { opacity: [0, 1] }, { at: st + 0.8 * k, dur: 0.3 * k, ease: "outCubic" });
  });

  const lineStart = (1.5 + (n - 1) * 0.5 + 0.5) * k;
  const lineDur = 3 * k;
  tl.tween(q(".dc-path"), { strokeDashoffset: [len, 0] }, { at: lineStart, dur: lineDur, ease: "linear" });

  const dot = q(".dc-dot");
  tl.set(dot, { opacity: 1 }, lineStart);
  tl.call(p => {
    const s = p * (n - 1);
    const i = Math.min(n - 2, Math.floor(s));
    const f = n > 1 ? s - i : 0;
    const a = pts[Math.max(0, i)], b = pts[Math.min(n - 1, i + 1)];
    dot.setAttribute("cx", SLATE.lerp(a[0], b[0], f));
    dot.setAttribute("cy", SLATE.lerp(a[1], b[1], f));
  }, { at: lineStart, dur: lineDur, ease: "linear" });

  const lineLabelEls = qa(".dc-line-label");
  let lastEnd = 0;
  lineLabelEls.forEach((el, i) => {
    const at = lineStart + (n > 1 ? i / (n - 1) : 0) * lineDur + 0.2 * k;
    tl.tween(el, { opacity: [0, 1] }, { at, dur: 0.1 * k, ease: "outCubic" });
    const target = content.line[i];
    tl.call(p => {
      el.textContent = (target * p).toFixed(content.lineDecimals) + content.lineSuffix;
    }, { at, dur: 0.8 * k, ease: "outCubic" });
    lastEnd = Math.max(lastEnd, at + 0.8 * k);
  });

  tl.tween(q(".dc-source"), { opacity: [0, 1] }, { at: lastEnd + 0.5 * k, dur: 0.5 * k, ease: "outCubic" });

  return tl;
};
