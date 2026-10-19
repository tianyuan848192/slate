/* 改编自 Apache-2.0 许可的开源素材，动画和写法有改动。许可证原文见 /opt/slate/licenses/kit/LICENSE */
/** 数字计数：淡入上浮、正弦缓动滚动到终值、落定时轻微放大回弹，停留期微浮。参数：at, dur, start, end, prefix, suffix, color, glow, exit(none|fade|up), rise, locale */
(function () {
  KIT.css("kit-count-up", `
    .kit-cu{display:inline-flex;align-items:baseline;justify-content:center;white-space:nowrap;
      font-variant-numeric:tabular-nums;font-feature-settings:"tnum" 1;line-height:1;letter-spacing:-0.045em;}
    .kit-cu-affix{position:relative;flex:0 0 auto;font-size:0.55em;letter-spacing:-0.02em;
      color:color-mix(in srgb, var(--kit-cu-accent, currentColor) 72%, #f8fafc);}
    .kit-cu-prefix{margin-right:0.14em}.kit-cu-suffix{margin-left:0.14em}
    .kit-cu-affix:empty{display:none}
    .kit-cu-value{display:inline-block;min-width:1ch}
    .kit-cu.kit-cu-glow{text-shadow:0 0.12em 0.36em color-mix(in srgb, var(--kit-cu-accent, currentColor) 24%, transparent);}
  `);

  function sineInOut(p) { return -(Math.cos(Math.PI * p) - 1) / 2; }
  function affixLift(text) {
    if (/^[$€£¥₹₩]$/.test(text)) return "-0.31em";
    if (/^[+−±×=~<>-]+$/.test(text)) return "-0.36em";
    return "";
  }

  KIT.motions = KIT.motions || {};
  KIT.motions.countUp = function (tl, target, o = {}) {
    const els = KIT.els(target);
    const at = o.at ?? 0, dur = o.dur ?? 3;
    const u = SLATE.u;
    const exit = o.exit === "fade" || o.exit === "up" ? o.exit : "none";
    const locale = o.locale || "en-US";
    const fmt = v => Math.round(v).toLocaleString(locale);

    // 入场/退场固定，停留段弹性；总时长不足时一起压缩
    const IN_BASE = 2.05, OUT_BASE = exit === "none" ? 0 : 0.45;
    const s = dur < IN_BASE + OUT_BASE ? dur / (IN_BASE + OUT_BASE) : 1;
    const IN = IN_BASE * s, OUT = OUT_BASE * s;
    const COUNT = 1.72 * s, PULSE = 0.165 * s, ARRIVAL = 0.38 * s;
    const HOLD = Math.max(0, dur - IN - OUT);
    const rise = o.rise ?? 0.92 * u;
    const drift = 0.23 * u;
    const lastFrame = Math.max(1, Math.round(COUNT * 30));

    els.forEach(el => {
      const ds = el.dataset;
      const txtNum = parseFloat(String(el.textContent || "").replace(/[^0-9.\-]/g, ""));
      const start = Number.isFinite(+ds.start) && ds.start !== undefined ? +ds.start : (o.start ?? 0);
      const end = ds.end !== undefined && Number.isFinite(+ds.end) ? +ds.end
        : (o.end ?? (Number.isFinite(txtNum) ? txtNum : 100));
      const prefix = o.prefix == null ? "" : String(o.prefix);
      const suffix = o.suffix == null ? "%" : String(o.suffix);

      let valueEl;
      if (!el.dataset.kitSplit) {
        el.dataset.kitSplit = "count";
        el.textContent = "";
        const pre = document.createElement("span");
        pre.className = "kit-cu-affix kit-cu-prefix"; pre.textContent = prefix; pre.style.top = affixLift(prefix);
        valueEl = document.createElement("span");
        valueEl.className = "kit-cu-value";
        const suf = document.createElement("span");
        suf.className = "kit-cu-affix kit-cu-suffix"; suf.textContent = suffix; suf.style.top = affixLift(suffix);
        el.append(pre, valueEl, suf);
      } else {
        valueEl = el.querySelector(".kit-cu-value") || el;
      }
      el.classList.add("kit-cu");
      const color = o.color || "#71f5a7";
      el.style.setProperty("--kit-cu-accent", color);
      el.style.color = color;
      el.style.transformOrigin = "50% 58%";
      if (o.glow) el.classList.add("kit-cu-glow");
      el.setAttribute("aria-label", prefix + fmt(end) + suffix);

      // 预先算好每一帧显示的整数
      const rows = [];
      for (let f = 0; f <= lastFrame; f++) rows.push(fmt(start + (end - start) * sineInOut(f / lastFrame)));
      valueEl.textContent = rows[0];
      tl.call(p => {
        const i = Math.min(lastFrame, Math.floor(p * lastFrame + 1e-6));
        if (valueEl.textContent !== rows[i]) valueEl.textContent = rows[i];
      }, { at, dur: COUNT, ease: "linear" });
    });

    // 入场
    tl.tween(els, { opacity: [0, 1] }, { at, dur: ARRIVAL, ease: "outCubic" });
    tl.tween(els, { y: [rise, 0], scale: [0.98, 1] }, { at, dur: ARRIVAL, ease: "outQuart" });
    // 落定脉冲
    tl.tween(els, { scale: 1.07 }, { at: at + COUNT, dur: PULSE, ease: "outQuart" });
    tl.tween(els, { scale: 1 }, { at: at + COUNT + PULSE, dur: PULSE, ease: "outCubic" });
    // 停留期微浮，最后 0.25s 静止
    const driftDur = Math.max(0, HOLD - 0.25);
    if (driftDur > 0) {
      tl.tween(els, { y: -drift }, { at: at + IN, dur: driftDur / 2, ease: "inOutSine", yoyo: true, repeat: 1 });
    }
    // 退场
    const outAt = at + IN + HOLD;
    if (exit === "up") {
      tl.tween(els, { y: [0, -rise] }, { at: outAt, dur: OUT, ease: "inCubic" });
      tl.tween(els, { opacity: 0, scale: 0.985 }, { at: outAt, dur: OUT, ease: "inCubic" });
    } else if (exit === "fade") {
      tl.tween(els, { opacity: 0 }, { at: outAt, dur: OUT, ease: "inCubic" });
    }
    return tl;
  };
})();
