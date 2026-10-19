/* 改编自 Apache-2.0 许可的开源素材，动画和写法有改动。许可证原文见 /opt/slate/licenses/kit/LICENSE */
KIT.shots["mk-specs-list"] = function (root, o = {}) {
  const content = Object.assign({
    // 清单行：label 项目名，value 说明（可空）
    rows: [
      { label: "设计", value: "极简，线条利落" },
      { label: "字体", value: "思源黑体 中粗" },
      { label: "动效", value: "克制，不回弹" },
      { label: "色彩", value: "底色加一种强调色" },
      { label: "形状", value: "胶囊与圆角卡片" }
    ],
    scheme: "light", // light：深色字；dark：白字（叠在素材上）
    underline: true,  // 每行下方强调色扫线
    lineWidth: 660,   // 扫线宽度 px
    scrim: 0,         // 左侧暗色遮罩 0~1
    x: 160,           // 列左边缘 px
    rowGap: 44,       // 行间距 px
    stagger: 0.18     // 行入场间隔 秒
  }, o.content);
  const theme = Object.assign({
    "--kit-font": "\"Inter\", \"Noto Sans CJK SC\", -apple-system, sans-serif",
    "--kit-ink": "#1d1d1f",
    "--kit-ink-dim": "#6e6e73",
    "--kit-ink-dark": "#f5f5f7",
    "--kit-ink-dim-dark": "#a1a1a6",
    "--kit-accent": "#0071e3",
    "--kit-accent-dark": "#7d5cff",
    "--kit-hairline": "2px"
  }, o.theme);
  const { k, d, exitAt } = KIT.fit(8, o.dur);

  if (!document.querySelector('link[data-kit-font="inter"]')) {
    const l = document.createElement("link");
    l.rel = "stylesheet"; l.href = "/assets/fonts/lib/inter.css"; l.dataset.kitFont = "inter";
    document.head.appendChild(l);
  }
  SLATE.waits = SLATE.waits || [];
  SLATE.waits.push(document.fonts.load('600 46px "Inter"'), document.fonts.load('400 40px "Inter"'),
    document.fonts.load('600 46px "Noto Sans CJK SC"'), document.fonts.load('400 40px "Noto Sans CJK SC"'));

  KIT.css("mk-specs-list", `
.kit-mk-specs-list{position:absolute;overflow:hidden;background:transparent}
.kit-mk-specs-list *{box-sizing:border-box;margin:0;padding:0}
.kit-mk-specs-list .sl-scrim{position:absolute;inset:0;background:linear-gradient(90deg,rgba(0,0,0,.55) 0%,rgba(0,0,0,0) 62%);opacity:0}
.kit-mk-specs-list .sl-col{position:absolute;display:flex;flex-direction:column}
.kit-mk-specs-list .sl-row{font-family:var(--kit-font);line-height:1;opacity:0}
.kit-mk-specs-list .sl-text{display:flex;align-items:baseline;gap:18px;white-space:nowrap}
.kit-mk-specs-list .sl-label{font-weight:600;font-size:46px;letter-spacing:-0.015em;color:var(--kit-ink)}
.kit-mk-specs-list .sl-value{font-weight:400;font-size:40px;letter-spacing:-0.01em;color:var(--kit-ink-dim)}
.kit-mk-specs-list .sl-line{position:relative;margin-top:22px;height:var(--kit-hairline);background:rgba(0,0,0,.1);border-radius:2px;overflow:hidden}
.kit-mk-specs-list .sl-fill{position:absolute;inset:0;background:var(--kit-accent);transform-origin:left center}
.kit-mk-specs-list.sl-dark .sl-label{color:var(--kit-ink-dark)}
.kit-mk-specs-list.sl-dark .sl-value{color:var(--kit-ink-dim-dark)}
.kit-mk-specs-list.sl-dark .sl-line{background:rgba(255,255,255,.18)}
.kit-mk-specs-list.sl-dark .sl-fill{background:var(--kit-accent-dark)}
`);

  const stage = KIT.stage(root, 1920, 1080);
  stage.classList.add("kit-mk-specs-list");
  if (content.scheme === "dark") stage.classList.add("sl-dark");
  KIT.theme(stage, theme);

  const scrim = document.createElement("div");
  scrim.className = "sl-scrim";
  scrim.style.opacity = String(content.scrim || 0);
  stage.appendChild(scrim);
  const col = document.createElement("div");
  col.className = "sl-col";
  stage.appendChild(col);

  const rows = [], fills = [];
  content.rows.forEach((r, i) => {
    const row = document.createElement("div");
    row.className = "sl-row";
    if (i > 0) row.style.marginTop = content.rowGap + "px";
    const text = document.createElement("div");
    text.className = "sl-text";
    const label = document.createElement("span");
    label.className = "sl-label";
    label.textContent = r.label;
    text.appendChild(label);
    if (r.value) {
      const v = document.createElement("span");
      v.className = "sl-value";
      v.textContent = r.value;
      text.appendChild(v);
    }
    row.appendChild(text);
    if (content.underline) {
      const line = document.createElement("div");
      line.className = "sl-line";
      line.style.width = content.lineWidth + "px";
      const fill = document.createElement("div");
      fill.className = "sl-fill";
      line.appendChild(fill);
      row.appendChild(line);
      fills[i] = fill;
    }
    col.appendChild(row);
    rows.push(row);
  });

  // 垂直居中，并保证底边不进入字幕区（不低于 78%）
  const n = content.rows.length;
  const colH = n * (46 + 22 + (content.underline ? 2 : 0)) + (n - 1) * content.rowGap;
  let top = Math.round((1080 - colH) / 2);
  top = Math.max(54, Math.min(top, Math.round(1080 * 0.78) - colH));
  col.style.left = content.x + "px";
  col.style.top = top + "px";

  const tl = SLATE.timeline();
  rows.forEach((row, i) => {
    const t0 = (0.3 + i * content.stagger) * k;
    tl.tween(row, { opacity: [0, 1], x: [-36, 0] }, { at: t0, dur: 0.7 * k, ease: "outQuart" });
    if (fills[i]) tl.tween(fills[i], { scaleX: [0, 1] }, { at: t0 + 0.15 * k, dur: 0.8 * k, ease: "inOutCubic" });
  });

  const ex = exitAt(0.5);
  tl.tween(col, { opacity: [1, 0], y: [0, -20] }, { at: ex, dur: 0.4, ease: "inCubic" });
  tl.tween(scrim, { opacity: 0 }, { at: ex, dur: 0.4, ease: "inCubic" });
  tl.set(stage, { visibility: "visible" }, 0);
  tl.set(stage, { visibility: "hidden" }, Math.max(0, d - 0.02));
  return tl;
};
