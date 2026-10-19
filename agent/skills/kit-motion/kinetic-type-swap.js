/* 改编自 Apache-2.0 许可的开源素材，动画和写法有改动。许可证原文见 /opt/slate/licenses/kit/LICENSE */
/** 句中换词滚动：整句保持不动，句中一个遮罩词槽（宽度取最宽的候选词）上下滚过几个候选词，最后定在末词并轻轻呼吸。
 *  参数：at 开始时间、dur 总时长（默认 4）、options 候选词（数组或逗号分隔字符串，默认读 data-options 或元素文字）、
 *  cues 换词时刻（相对 at 的秒数）、color 词槽颜色、exit 退场（none/fade/up）、fadeTarget 开场淡入的元素（默认父元素，传 false 就不淡入）。 */
(function () {
  KIT.motions = KIT.motions || {};
  KIT.css("kit-kinetic-type-swap", `
    .kit-swap-slot{display:inline-grid;overflow:hidden;vertical-align:bottom;padding:0.06em 0.04em;
      color:var(--kit-swap-accent,var(--kit-accent,#71f5a7));
      text-shadow:0 0 0.35em color-mix(in srgb, var(--kit-swap-accent,var(--kit-accent,#71f5a7)) 28%, transparent);}
    .kit-swap-word{grid-area:1/1;width:max-content;justify-self:center;white-space:nowrap;}
  `);

  function list(v) {
    if (v == null) return [];
    if (Array.isArray(v)) return v.map(s => String(s).trim()).filter(Boolean);
    return String(v).split(/[,，]/).map(s => s.trim()).filter(Boolean);
  }

  KIT.motions.kineticTypeSwap = function (tl, target, o = {}) {
    const els = KIT.els(target);
    const at = o.at ?? 0, dur = o.dur ?? 4;
    const exit = o.exit === "fade" || o.exit === "up" ? o.exit : "none";
    const IN_BASE = 2.25, OUT_BASE = exit === "none" ? 0 : 0.45;
    const total = IN_BASE + OUT_BASE;
    const k = dur < total ? dur / total : 1;
    const IN = IN_BASE * k, OUT = OUT_BASE * k;
    const ARRIVAL = 0.3 * k, SWAP_START = 0.48 * k, ROLL = 0.46 * k, SETTLE = 0.18 * k;
    const cues = list(o.cues).map(Number).filter(n => Number.isFinite(n) && n >= 0).sort((a, b) => a - b);
    const u = SLATE.u;

    els.forEach(el => {
      let words;
      if (el.dataset.kitSplit) {
        words = Array.from(el.querySelectorAll(":scope > .kit-swap-word"));
      } else {
        let opts = list(o.options);
        if (!opts.length) opts = list(el.dataset.options);
        if (!opts.length) opts = [el.textContent.trim() || "…"];
        el.textContent = "";
        el.classList.add("kit-swap-slot");
        words = opts.map(t => {
          const w = document.createElement("span");
          w.className = "kit-swap-word";
          w.textContent = t;
          el.appendChild(w);
          return w;
        });
        el.dataset.kitSplit = "swap";
        el.setAttribute("aria-label", opts[opts.length - 1]);
      }
      if (o.color) el.style.setProperty("--kit-swap-accent", o.color);
      words.forEach((w, i) => { w.style.opacity = i === 0 ? "1" : "0"; });

      let fadeEl = null;
      if (o.fadeTarget !== false) fadeEl = o.fadeTarget ? KIT.els(o.fadeTarget)[0] : el.parentElement;

      // 排换词时刻
      const swapCount = words.length - 1;
      const swaps = [];
      let roll = ROLL;
      if (swapCount > 0) {
        if (cues.length) {
          const last = cues[cues.length - 1];
          const gap = cues.length >= 2 ? Math.max(0.05, (last - cues[0]) / (cues.length - 1)) : ROLL;
          const latest = Math.max(0, dur - OUT - ROLL - SETTLE);
          for (let i = 0; i < swapCount; i++) {
            const c = i < cues.length ? cues[i] : last + (i - (cues.length - 1)) * gap;
            swaps.push(Math.min(latest, Math.max(0, c)));
          }
          let minGap = Infinity;
          for (let i = 1; i < swaps.length; i++) minGap = Math.min(minGap, swaps[i] - swaps[i - 1]);
          if (Number.isFinite(minGap)) roll = Math.min(ROLL, Math.max(0.04, minGap * 0.72));
        } else {
          const lastStart = Math.max(SWAP_START, IN - SETTLE - ROLL);
          const step = swapCount === 1 ? 0 : (lastStart - SWAP_START) / (swapCount - 1);
          roll = swapCount <= 2 ? ROLL : Math.min(ROLL, Math.max(0.04, step * 0.72));
          for (let i = 1; i <= swapCount; i++) swaps.push(swapCount === 1 ? lastStart : SWAP_START + (i - 1) * step);
        }
      }
      const swapsEnd = swaps.length ? swaps[swaps.length - 1] + roll + SETTLE : IN;
      const HOLD_START = Math.min(Math.max(0, dur - OUT), Math.max(IN, swapsEnd));
      const HOLD = Math.max(0, dur - HOLD_START - OUT);
      const OUT_START = HOLD_START + HOLD;

      if (fadeEl) tl.tween(fadeEl, { opacity: [0, 1] }, { at, dur: ARRIVAL, ease: "outCubic" });

      swaps.forEach((s, si) => {
        const wi = si + 1;
        const half = roll * 0.55;
        const inStart = s + roll - half;
        const ease = wi === words.length - 1 ? "outBack(1.7)" : "outQuint";
        tl.tween(words[wi - 1], { yPercent: -112 }, { at: at + s, dur: half, ease: "inQuint" });
        tl.set(words[wi - 1], { opacity: 0 }, at + s + half);
        tl.set(words[wi], { opacity: 1 }, at + inStart);
        tl.tween(words[wi], { yPercent: [112, 0] }, { at: at + inStart, dur: half, ease });
      });

      // 停留阶段的轻呼吸（奇数次重复，结束时回到 1）
      const fin = words[words.length - 1];
      const pulseHalf = Math.min(0.5, HOLD / 2);
      if (pulseHalf > 0) {
        const maxRep = Math.floor(HOLD / pulseHalf) - 1;
        const rep = maxRep % 2 === 1 ? maxRep : maxRep - 1;
        if (rep >= 1) {
          tl.tween(fin, { opacity: [1, 0.9] }, { at: at + HOLD_START, dur: pulseHalf, ease: "inOutSine", yoyo: true, repeat: rep });
        }
      }

      const outEl = fadeEl || el;
      if (exit === "fade") {
        tl.tween(outEl, { opacity: 0 }, { at: at + OUT_START, dur: OUT, ease: "inCubic" });
      } else if (exit === "up") {
        tl.tween(outEl, { opacity: 0, y: -2 * u }, { at: at + OUT_START, dur: OUT, ease: "inCubic" });
      }
    });
    return tl;
  };
})();
