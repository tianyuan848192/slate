/* 改编自 Apache-2.0 许可的开源素材，动画和写法有改动。许可证原文见 /opt/slate/licenses/kit/LICENSE */
KIT.shots["bar-chart-race"] = function (root, o = {}) {
  const content = Object.assign({
    title: "各平台流媒体订阅用户数",          // 主标题
    subtitle: "按公布的订阅用户数排名",          // 副标题
    periodCaption: "年份",                       // 右上角小标签
    periods: ["2019", "2020", "2021", "2022", "2023", "2024"], // 时期
    series: [                                    // 数据系列
      { name: "北风视频", values: [4200, 5800, 7100, 9600, 11800, 13100] },
      { name: "钴蓝 TV", values: [3000, 4600, 6800, 9200, 12600, 16800] },
      { name: "渡口影院", values: [5500, 6200, 6600, 7000, 7400, 7900] },
      { name: "马洛剧场", values: [1800, 3300, 5200, 6100, 8800, 10400] },
      { name: "紫菀视频", values: [2500, 2800, 4400, 5800, 6300, 7200] },
      { name: "佩尔播放", values: [1200, 2000, 3900, 4700, 5500, 9000] },
      { name: "羽笔影视", values: [800, 1100, 1500, 2400, 4000, 6600] },
      { name: "邓莫尔台", values: [3500, 3700, 3800, 4000, 4200, 4400] }
    ],
    barCount: 6,          // 同时显示的条数
    periodDuration: 2,    // 每个时期秒数
    valuePrefix: "",      // 数值前缀
    valueSuffix: " 万",   // 数值后缀
    valueDecimals: 0,     // 小数位
    source: "示例数据"    // 数据来源
  }, o.content);
  const theme = Object.assign({
    "--kit-accent": "#c8452d",
    "--kit-bg": "#f5f3ef",
    "--kit-ink": "#1f1d1b",
    "--kit-muted": "#6b6560",
    "--kit-font": "\"Inter\", \"Noto Sans CJK SC\", sans-serif"
  }, o.theme);
  const { k, d } = KIT.fit(12, o.dur);

  if (!document.querySelector('link[data-kit-font="inter"]')) {
    const l = document.createElement("link");
    l.rel = "stylesheet"; l.href = "/assets/fonts/lib/inter.css"; l.setAttribute("data-kit-font", "inter");
    document.head.appendChild(l);
  }
  SLATE.waits = SLATE.waits || [];
  SLATE.waits.push(document.fonts.load('700 46px "Inter"'), document.fonts.load('600 26px "Inter"'),
    document.fonts.load('400 19px "Inter"'), document.fonts.load('700 46px "Noto Sans CJK SC"'));

  KIT.css("bar-chart-race", `
.kit-bar-chart-race{font-family:var(--kit-font);color:var(--kit-ink);overflow:hidden}
.kit-bar-chart-race *{margin:0;padding:0;box-sizing:border-box}
.kit-bar-chart-race .bcr-bg{position:absolute;inset:0;background-color:var(--kit-bg)}
.kit-bar-chart-race .bcr-head{position:absolute;top:58px;left:96px;width:1728px;display:flex;align-items:flex-start;justify-content:space-between}
.kit-bar-chart-race .bcr-title{font-size:46px;font-weight:700;letter-spacing:-0.015em;line-height:1.1}
.kit-bar-chart-race .bcr-subtitle{margin-top:10px;font-size:19px;font-weight:400;color:var(--kit-muted)}
.kit-bar-chart-race .bcr-head-right{display:flex;flex-direction:column;align-items:flex-end}
.kit-bar-chart-race .bcr-period-caption{font-size:15px;font-weight:600;letter-spacing:0.18em;text-transform:uppercase;color:var(--kit-muted)}
.kit-bar-chart-race .bcr-period{margin-top:4px;font-size:72px;font-weight:700;line-height:1;font-variant-numeric:tabular-nums;letter-spacing:-0.02em}
.kit-bar-chart-race .bcr-plot{position:absolute;left:0;top:222px;width:1920px;height:588px;overflow:hidden}
.kit-bar-chart-race .bcr-row{position:absolute;left:0;top:0;width:1920px}
.kit-bar-chart-race .bcr-name{position:absolute;left:96px;width:272px;top:50%;transform:translateY(-50%);text-align:right;font-size:26px;font-weight:600;line-height:1.7;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;background-color:var(--kit-bg)}
.kit-bar-chart-race .bcr-bar{position:absolute;left:400px;top:50%;transform:translateY(-50%);border-radius:3px;background-color:var(--kit-ink)}
.kit-bar-chart-race .bcr-value{position:absolute;left:404px;top:50%;padding:0 12px;font-size:26px;font-weight:600;line-height:1.7;font-variant-numeric:tabular-nums;white-space:nowrap;background-color:var(--kit-bg)}
.kit-bar-chart-race .bcr-axis{position:absolute;inset:0;z-index:5000;pointer-events:none}
.kit-bar-chart-race .bcr-tick-line{position:absolute;top:218px;left:0;width:1px;height:596px;background-color:rgba(31,29,27,0.11)}
.kit-bar-chart-race .bcr-tick-line.bcr-tick-zero{background-color:rgba(31,29,27,0.5)}
.kit-bar-chart-race .bcr-tick-label{position:absolute;top:186px;left:0;font-size:17px;font-weight:500;font-variant-numeric:tabular-nums;color:var(--kit-muted);white-space:nowrap}
.kit-bar-chart-race .bcr-source{position:absolute;left:96px;top:820px;font-size:16px;line-height:1.2;color:var(--kit-muted)}
`);

  const stage = KIT.stage(root, 1920, 1080);
  stage.classList.add("kit-bar-chart-race");
  KIT.theme(stage, theme);
  stage.innerHTML = `
<div class="bcr-bg"></div>
<div class="bcr-head">
  <div><h1 class="bcr-title"></h1><p class="bcr-subtitle"></p></div>
  <div class="bcr-head-right"><span class="bcr-period-caption"></span><span class="bcr-period"></span></div>
</div>
<div class="bcr-plot"></div>
<div class="bcr-axis"></div>
<p class="bcr-source"></p>`;
  const q = s => stage.querySelector(s);
  q(".bcr-title").textContent = content.title;
  q(".bcr-subtitle").textContent = content.subtitle;
  q(".bcr-period-caption").textContent = content.periodCaption;
  q(".bcr-source").textContent = content.source;
  const periodEl = q(".bcr-period");
  const plot = q(".bcr-plot");
  const axis = q(".bcr-axis");

  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  let PERIODS = Array.isArray(content.periods) ? content.periods.map(String)
    : String(content.periods).split(",").map(s => s.trim()).filter(Boolean);
  if (!PERIODS.length) PERIODS = ["1"];
  const T = PERIODS.length;
  let SERIES = [];
  if (Array.isArray(content.series)) {
    SERIES = content.series.map(s => ({ label: String(s.name), values: (s.values || []).map(Number).filter(Number.isFinite) }));
  } else {
    String(content.series).split(/[\n;]+/).forEach(line => {
      line = line.trim(); const sp = line.indexOf(":"); if (sp < 0) return;
      const label = line.slice(0, sp).trim(); if (!label) return;
      const values = line.slice(sp + 1).split(",").map(s => parseFloat(s.trim())).filter(Number.isFinite);
      SERIES.push({ label, values });
    });
  }
  SERIES = SERIES.filter(s => s.values.length).map(s => {
    const v = s.values.slice(0, T); while (v.length < T) v.push(v[v.length - 1]);
    return { label: s.label, values: v };
  });
  const N = SERIES.length;
  const BAR_COUNT = Math.round(clamp(Number(content.barCount) || 6, 1, 24));
  const PD = clamp(Number(content.periodDuration) || 2, 0.1, 30) * k;
  const DEC = Math.round(clamp(Number(content.valueDecimals) || 0, 0, 6));
  const PREFIX = content.valuePrefix || "", SUFFIX = content.valueSuffix || "";

  const KF = 10, KF_DUR = PD / KF;
  const KF_COUNT = T > 1 ? (T - 1) * KF + 1 : 1;
  const RACE = T > 1 ? (T - 1) * PD : 0;
  function valueAt(t, s) {
    if (T < 2) return s.values[0];
    const u = t / PD; const i = clamp(Math.floor(u), 0, T - 2); const f = clamp(u - i, 0, 1);
    return s.values[i] + (s.values[i + 1] - s.values[i]) * f;
  }
  const RANKS = [];
  for (let m = 0; m < KF_COUNT; m++) {
    const tm = m * KF_DUR;
    const order = SERIES.map((s, j) => ({ j, v: valueAt(tm, s) }));
    order.sort((a, b) => b.v - a.v || a.j - b.j);
    const row = new Array(N); order.forEach((e, r) => { row[e.j] = r; });
    RANKS.push(row);
  }
  const smooth = x => x * x * (3 - 2 * x);
  function rankPosAt(t, j) {
    if (KF_COUNT < 2) return RANKS[0][j];
    const m = t / KF_DUR; const m0 = clamp(Math.floor(m), 0, KF_COUNT - 2);
    const e = smooth(clamp(m - m0, 0, 1));
    const a = RANKS[m0][j], b = RANKS[m0 + 1][j];
    return a + (b - a) * e;
  }
  const fmt = v => PREFIX + v.toLocaleString("en-US", { minimumFractionDigits: DEC, maximumFractionDigits: DEC }) + SUFFIX;
  function niceStep(x) {
    const e = Math.pow(10, Math.floor(Math.log10(x))); const f = x / e;
    return e * (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10);
  }

  const TRACK_X = 400, TRACK_W = 1180, PLOT_H = 588;
  const PITCH = PLOT_H / BAR_COUNT;
  const BAR_H = Math.max(12, PITCH * 0.62);
  const TICK_POOL = 12;

  const rows = SERIES.map(s => {
    const row = document.createElement("div"); row.className = "bcr-row"; row.style.height = PITCH + "px";
    const name = document.createElement("div"); name.className = "bcr-name"; name.textContent = s.label;
    const bar = document.createElement("div"); bar.className = "bcr-bar"; bar.style.height = BAR_H + "px";
    const value = document.createElement("div"); value.className = "bcr-value";
    row.append(name, bar, value); plot.appendChild(row);
    return { row, bar, value };
  });
  const ticks = [];
  for (let i = 0; i < TICK_POOL; i++) {
    const line = document.createElement("div"); line.className = "bcr-tick-line" + (i === 0 ? " bcr-tick-zero" : "");
    const label = document.createElement("div"); label.className = "bcr-tick-label";
    axis.append(line, label); ticks.push({ line, label });
  }

  function draw(t) {
    if (!N) return;
    const values = SERIES.map(s => valueAt(t, s));
    const byValue = values.map((v, i) => i).sort((a, b) => values[b] - values[a] || a - b);
    const zRank = new Array(N); byValue.forEach((j, r) => { zRank[j] = r; });
    const leader = byValue[0];
    const scaleMax = Math.max(values[leader] * 1.06, 1e-6);
    const step = niceStep(scaleMax / 4);
    for (let i = 0; i < TICK_POOL; i++) {
      const tv = i * step; const vis = tv <= scaleMax;
      const tx = TRACK_X + (tv / scaleMax) * TRACK_W;
      ticks[i].line.style.transform = `translateX(${tx.toFixed(2)}px)`;
      ticks[i].line.style.opacity = vis ? "1" : "0";
      ticks[i].label.style.transform = `translateX(${tx.toFixed(2)}px) translateX(-50%)`;
      ticks[i].label.style.opacity = vis ? "1" : "0";
      ticks[i].label.textContent = vis ? fmt(tv) : "";
    }
    for (let j = 0; j < N; j++) {
      const rp = rankPosAt(t, j);
      const w = (values[j] / scaleMax) * TRACK_W;
      const el = rows[j];
      el.row.style.transform = `translateY(${(rp * PITCH).toFixed(2)}px)`;
      el.row.style.opacity = clamp(BAR_COUNT - rp, 0, 1).toFixed(3);
      el.row.style.zIndex = String(1000 - zRank[j]);
      el.bar.style.width = w.toFixed(2) + "px";
      el.bar.style.backgroundColor = j === leader ? "var(--kit-accent)" : "var(--kit-ink)";
      el.value.style.transform = `translate(${w.toFixed(2)}px, -50%)`;
      el.value.textContent = fmt(values[j]);
    }
    periodEl.textContent = PERIODS[clamp(Math.floor(t / PD), 0, T - 1)];
  }

  const tl = SLATE.timeline();
  draw(0);
  tl.call((p) => draw(p * RACE), { at: 0, dur: Math.max(RACE, 0.001), ease: "linear" });
  tl.call(() => {}, { at: 0, dur: d });
  return tl;
};
