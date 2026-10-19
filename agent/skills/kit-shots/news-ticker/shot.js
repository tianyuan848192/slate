/* 改编自 Apache-2.0 许可的开源素材，动画和写法有改动。许可证原文见 /opt/slate/licenses/kit/LICENSE */
KIT.shots["news-ticker"] = function (root, o = {}) {
  const content = Object.assign({
    live: "直播",                 // 左上红色标签主字
    desk: "全球新闻台",           // 红色标签下方小字
    headlineBefore: "AI 视频工具从", // 标题前半
    headlineAccent: "原型",       // 标题红色高亮词
    headlineAfter: "走向量产",     // 标题后半
    time: "09:41 UTC",            // 右上角时间
    label: "突发",                // 滚动条左侧标签
    items: [                      // 滚动条目，metric 为末尾数据块（可空）
      { text: "创作团队上线周期缩短", metric: "38%" },
      { text: "渲染队列清空用时不到", metric: "2 分钟" },
      { text: "新素材组件在产品演示中持续走红" },
      { text: "工作室剪辑师纷纷采用网页优先的动效系统" }
    ]
  }, o.content);
  const theme = Object.assign({
    "--kit-accent": "#e11d2e",
    "--kit-accent-dark": "#9f1220",
    "--kit-highlight": "#ff4455",
    "--kit-label-bg": "#5f0712",
    "--kit-metric-bg": "#063344",
    "--kit-metric-fg": "#c8f8ff",
    "--kit-font": "\"Inter\", \"Noto Sans CJK SC\", sans-serif"
  }, o.theme);
  const { k, d, exitAt } = KIT.fit(7, o.dur);

  if (!document.querySelector('link[data-kit-font="inter"]')) {
    const l = document.createElement("link");
    l.rel = "stylesheet"; l.href = "/assets/fonts/lib/inter.css"; l.dataset.kitFont = "inter";
    document.head.appendChild(l);
    SLATE.waits = SLATE.waits || [];
    SLATE.waits.push(new Promise(r => { l.onload = r; l.onerror = r; }).then(() => Promise.all([
      document.fonts.load('900 48px "Inter"'), document.fonts.load('700 18px "Inter"'), document.fonts.load('600 31px "Inter"')
    ])).catch(() => {}));
  }

  KIT.css("news-ticker", `
  .kit-news-ticker{color:#f8fafc;font-family:var(--kit-font);overflow:hidden}
  .kit-news-ticker *{box-sizing:border-box;margin:0;padding:0}
  .kit-news-ticker .nt-shell{position:absolute;left:96px;right:96px;bottom:240px;height:216px;filter:drop-shadow(0 28px 44px rgba(0,0,0,.32))}
  .kit-news-ticker .nt-panel{position:absolute;inset:0;overflow:hidden;border:1px solid rgba(255,255,255,.18);border-radius:28px;
    background:linear-gradient(180deg,rgba(21,31,48,.96),rgba(7,13,24,.98)),linear-gradient(90deg,rgba(201,31,45,.72),transparent 38%)}
  .kit-news-ticker .nt-panel::before{position:absolute;inset:0;content:"";opacity:.72;pointer-events:none;
    background:radial-gradient(circle at 14% 0%,rgba(255,255,255,.2),transparent 26%),linear-gradient(110deg,transparent 0 42%,rgba(255,255,255,.06) 42% 43%,transparent 43% 100%)}
  .kit-news-ticker .nt-top-row{position:absolute;left:0;right:0;top:0;height:126px;display:flex;align-items:stretch}
  .kit-news-ticker .nt-brand{width:294px;display:flex;align-items:center;justify-content:center;gap:16px;
    background:linear-gradient(135deg,var(--kit-accent),var(--kit-accent-dark));box-shadow:inset -1px 0 0 rgba(255,255,255,.16)}
  .kit-news-ticker .nt-live-dot{width:18px;height:18px;border-radius:999px;background:#fff;box-shadow:0px 0px 0px 0px rgba(255,255,255,.55)}
  .kit-news-ticker .nt-brand-text{display:flex;flex-direction:column;gap:6px;text-transform:uppercase}
  .kit-news-ticker .nt-live{font-size:24px;font-weight:900;line-height:1;letter-spacing:.16em}
  .kit-news-ticker .nt-desk{font-size:15px;font-weight:700;line-height:1;letter-spacing:.22em;color:#fff}
  .kit-news-ticker .nt-headline-wrap{position:relative;flex:1;display:flex;align-items:center;padding:0 250px 0 44px;overflow:hidden}
  .kit-news-ticker .nt-headline{position:relative;z-index:1;font-size:48px;font-weight:900;line-height:1.1;white-space:nowrap;color:#fff;text-shadow:0 2px 14px rgba(0,0,0,.34)}
  .kit-news-ticker .nt-accent{color:var(--kit-highlight)}
  .kit-news-ticker .nt-time{position:absolute;top:25px;right:38px;padding:10px 16px;border:1px solid rgba(255,255,255,.18);border-radius:999px;
    background:rgba(255,255,255,.08);color:rgba(255,255,255,.74);font-size:18px;font-weight:700;line-height:1;letter-spacing:.08em;font-variant-numeric:tabular-nums}
  .kit-news-ticker .nt-bottom-row{position:absolute;left:0;right:0;bottom:0;height:90px;display:flex;align-items:center;border-top:1px solid rgba(255,255,255,.11);background:rgba(2,6,13,.58)}
  .kit-news-ticker .nt-label{position:relative;z-index:4;width:294px;height:100%;display:flex;align-items:center;justify-content:center;border-right:1px solid rgba(255,255,255,.14);
    background:var(--kit-label-bg);color:#fff;font-size:26px;font-weight:900;line-height:1;letter-spacing:.14em;text-transform:uppercase}
  .kit-news-ticker .nt-ticker-window{position:relative;flex:1;height:100%;overflow:hidden;background:#050b15}
  .kit-news-ticker .nt-ticker-window::before,.kit-news-ticker .nt-ticker-window::after{position:absolute;top:0;bottom:0;z-index:2;width:90px;content:"";pointer-events:none}
  .kit-news-ticker .nt-ticker-window::before{left:0;background:linear-gradient(90deg,#050b15,transparent)}
  .kit-news-ticker .nt-ticker-window::after{right:0;background:linear-gradient(270deg,#050b15,transparent)}
  .kit-news-ticker .nt-ticker-track{position:absolute;left:34px;top:0;height:100%;display:flex;align-items:center;gap:34px;white-space:nowrap;will-change:transform}
  .kit-news-ticker .nt-item{display:inline-flex;align-items:center;gap:14px;padding:13px 18px;border:1px solid rgba(255,255,255,.08);border-radius:999px;
    background:#08111f;color:#fff;font-size:31px;font-weight:600;line-height:1}
  .kit-news-ticker .nt-txt{white-space:pre}
  .kit-news-ticker .nt-sep{width:9px;height:9px;border-radius:999px;background:var(--kit-accent);box-shadow:0 0 22px rgba(225,29,46,.75)}
  .kit-news-ticker .nt-metric{padding:4px 8px;border-radius:8px;background:var(--kit-metric-bg);color:var(--kit-metric-fg);font-weight:800;font-variant-numeric:tabular-nums;white-space:pre}
  .kit-news-ticker .nt-flash{position:absolute;top:0;bottom:0;left:-260px;z-index:3;width:210px;background:linear-gradient(90deg,transparent,rgba(255,255,255,.18),transparent)}
  `);

  const stage = KIT.stage(root, 1920, 1080);
  stage.classList.add("kit-news-ticker");
  KIT.theme(stage, theme);
  const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const chars = s => Array.from(String(s == null ? "" : s)).map(c => `<span class="nt-ch">${esc(c)}</span>`).join("");

  // 滚动：保持原速度，按时长计算需要的距离并重复条目
  const SPEED = 2380 / 6.05;
  const tickStart = 0.62 * k;
  const tickDur = Math.max(0.5, d - tickStart);
  const startX = 1260, endX = startX - SPEED * tickDur;
  const items = (content.items || []).length ? content.items : [{ text: "" }];
  const estW = it => (String(it.text).length * 31 + (it.metric ? String(it.metric).length * 20 + 40 : 0) + 120);
  const cycle = items.reduce((s, it) => s + estW(it), 0);
  const need = (startX - endX) + 1500;
  const reps = Math.max(2, Math.ceil(need / Math.max(200, cycle)) + 1);
  let itemsHTML = "";
  for (let r = 0; r < reps; r++) for (const it of items) {
    itemsHTML += `<span class="nt-item"><span class="nt-sep"></span><span class="nt-txt">${chars(it.text)}</span>${it.metric ? `<span class="nt-metric">${chars(it.metric)}</span>` : ""}</span>`;
  }

  stage.innerHTML = `
  <section class="nt-shell">
    <div class="nt-panel">
      <div class="nt-flash"></div>
      <div class="nt-top-row">
        <div class="nt-brand">
          <div class="nt-live-dot"></div>
          <div class="nt-brand-text"><div class="nt-live">${esc(content.live)}</div><div class="nt-desk">${esc(content.desk)}</div></div>
        </div>
        <div class="nt-headline-wrap">
          <h1 class="nt-headline">${esc(content.headlineBefore)}<span class="nt-accent">${esc(content.headlineAccent)}</span>${esc(content.headlineAfter)}</h1>
          <div class="nt-time">${esc(content.time)}</div>
        </div>
      </div>
      <div class="nt-bottom-row">
        <div class="nt-label">${esc(content.label)}</div>
        <div class="nt-ticker-window"><div class="nt-ticker-track">${itemsHTML}</div></div>
      </div>
    </div>
  </section>`;

  const q = s => stage.querySelector(s);
  const shell = q(".nt-shell"), brand = q(".nt-brand"), headline = q(".nt-headline"), label = q(".nt-label"),
    track = q(".nt-ticker-track"), dot = q(".nt-live-dot"), flash = q(".nt-flash"), time = q(".nt-time"),
    win = q(".nt-ticker-window");
  const chEls = Array.from(stage.querySelectorAll(".nt-ch"));

  // 字符在轨道里的位置（布局坐标，不受 transform 影响）；首次渲染时测量（字体已加载）
  let metrics = null;
  const measure = () => {
    const tr = track.getBoundingClientRect();
    const sc = tr.width / Math.max(1, track.offsetWidth) || 1;
    metrics = chEls.map(el => { const r = el.getBoundingClientRect(); return { l: (r.left - tr.left) / sc, w: r.width / sc }; });
    metrics.base = track.offsetLeft;
    metrics.winW = win.clientWidth;
  };

  const tl = SLATE.timeline();
  const exitStart = exitAt(0.38);

  tl.set(flash, { skewX: -16 }, 0);
  tl.tween(shell, { y: [260, 0], opacity: [0, 1] }, { at: 0, dur: 0.52 * k, ease: "outQuint" });
  tl.tween(brand, { x: [-80, 0], opacity: [0, 1] }, { at: 0.08 * k, dur: 0.42 * k, ease: "outQuart" });
  tl.tween(headline, { y: [26, 0], opacity: [0, 1], clipPath: ["inset(0% 100% 0% 0%)", "inset(0% 0% 0% 0%)"] }, { at: 0.18 * k, dur: 0.62 * k, ease: "outQuart" });
  tl.tween(time, { y: [-10, 0], opacity: [0, 1] }, { at: 0.5 * k, dur: 0.32 * k, ease: "outCubic" });
  tl.tween(label, { y: [18, 0], opacity: [0, 1] }, { at: 0.55 * k, dur: 0.28 * k, ease: "outCubic" });
  tl.tween(flash, { x: [0, 2040] }, { at: 0.34 * k, dur: 0.86 * k, ease: "inOutCubic" });
  tl.tween(track, { x: [startX, endX] }, { at: tickStart, dur: tickDur, ease: "linear" });

  // 只显示完全落在滚动窗口内的字符（边缘处在渐隐遮罩下切换，肉眼几乎看不出）
  tl.call((p, t) => {
    if (!metrics) measure();
    const x = SLATE.lerp(startX, endX, SLATE.clamp((t - tickStart) / tickDur, 0, 1));
    const off = metrics.base + x, W = metrics.winW;
    for (let i = 0; i < chEls.length; i++) {
      const m = metrics[i], L = off + m.l;
      const vis = L >= 2 && L + m.w <= W - 2;
      const v = vis ? "visible" : "hidden";
      if (chEls[i].style.visibility !== v) chEls[i].style.visibility = v;
    }
  }, { at: 0, dur: d });

  const pulseAt = 0.58 * k, pulseDur = 0.42;
  const passes = Math.max(2, 2 * Math.floor(Math.max(0, exitStart - pulseAt) / (pulseDur * 2)));
  tl.tween(dot, { scale: [1, 1.32], boxShadow: ["0px 0px 0px 0px rgba(255,255,255,0.55)", "0px 0px 0px 18px rgba(255,255,255,0)"] },
    { at: pulseAt, dur: pulseDur, ease: "inOutSine", repeat: passes - 1, yoyo: true });

  const flash2 = Math.min(3.42 * k, Math.max(1.3 * k, exitStart - 1.2));
  tl.tween(flash, { x: [2040, 4080] }, { at: flash2, dur: 0.72 * k, ease: "inOutCubic" });

  tl.tween(shell, { y: [0, 170], opacity: [1, 0] }, { at: exitStart, dur: 0.34, ease: "inQuart" });
  return tl;
};
