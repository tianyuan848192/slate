/* 改编自 Apache-2.0 许可的开源素材，动画和写法有改动。许可证原文见 /opt/slate/licenses/kit/LICENSE */
/** 数字滚轮：把数字每一位做成竖向滚轮，从 0 错开滚到目标位。参数：at 开始秒，dur 整体时长，value 数字文本，spin 额外圈数(single/double/triple)，spacing 列距(tight/standard/wide)，tone 颜色(inherit/ink/paper/accent)，each 错开间隔，ease 缓动。 */
KIT.motions = KIT.motions || {};
KIT.motions.numberWheel = function (tl, target, o = {}) {
  const els = KIT.els(target);
  const at = o.at ?? 0;
  const spins = { single: 0, double: 1, triple: 2 };
  const gaps = { tight: "0em", standard: "0.02em", wide: "0.14em" };
  const tones = {
    inherit: "inherit",
    ink: "#18181b",
    paper: "#fafafa",
    accent: "var(--brand, var(--kit-accent, #34d399))",
  };
  const cycles = typeof o.spin === "number" ? Math.max(0, Math.round(o.spin)) : (spins[o.spin] ?? 0);
  const gap = o.spacing == null ? gaps.standard : (gaps[o.spacing] ?? o.spacing);
  const tone = o.tone == null ? tones.inherit : (tones[o.tone] ?? o.tone);
  const ease = o.ease ?? "outQuart";
  const each0 = o.each ?? 0.06;
  const col0 = 1.2;

  KIT.css("kit-number-wheel", `
    .kit-wheel{display:inline-flex;align-items:flex-start;font-variant-numeric:tabular-nums;line-height:1em;vertical-align:top}
    .kit-wheel-digit{display:inline-block;height:1em;overflow:hidden}
    .kit-wheel-strip{display:grid}
    .kit-wheel-strip>span,.kit-wheel-sym{display:block;height:1em;line-height:1em}
  `);

  const strips = [];
  els.forEach((el) => {
    if (el.dataset.kitWheel !== "1") {
      const value = String(o.value ?? el.dataset.value ?? el.textContent.trim() ?? "0") || "0";
      el.classList.add("kit-wheel");
      el.style.gap = gap;
      if (tone !== "inherit") el.style.color = tone;
      el.setAttribute("aria-label", value);
      el.textContent = "";
      for (const ch of value) {
        if (!/\d/.test(ch)) {
          const s = document.createElement("span");
          s.className = "kit-wheel-sym";
          s.textContent = ch;
          el.appendChild(s);
          continue;
        }
        const stops = cycles * 10 + Number(ch);
        const frame = document.createElement("span");
        frame.className = "kit-wheel-digit";
        const strip = document.createElement("span");
        strip.className = "kit-wheel-strip";
        strip.dataset.stops = String(stops);
        for (let i = 0; i <= stops; i++) {
          const step = document.createElement("span");
          step.textContent = String(i % 10);
          if (i < stops) step.setAttribute("data-qa", "ignore");
          step.style.visibility = i === 0 ? "visible" : "hidden";
          strip.appendChild(step);
        }
        frame.appendChild(strip);
        el.appendChild(frame);
      }
      el.dataset.kitWheel = "1";
    }
    strips.push(...el.querySelectorAll(".kit-wheel-strip"));
  });

  const n = strips.length;
  if (!n) return tl;
  const base = col0 + each0 * (n - 1);
  const dur = o.dur ?? base;
  const k = dur / base;

  strips.forEach((strip, i) => {
    const stops = Number(strip.dataset.stops) || 0;
    const steps = Array.from(strip.children);
    tl.call((p) => {
      const pos = SLATE.clamp(p, 0, 1) * stops;
      strip.style.transform = `translateY(${-pos}em)`;
      const lo = Math.floor(pos), hi = Math.ceil(pos);
      steps.forEach((s, j) => {
        s.style.visibility = j >= lo && j <= hi ? "visible" : "hidden";
      });
    }, { at: at + i * each0 * k, dur: col0 * k, ease });
  });
  return tl;
};
