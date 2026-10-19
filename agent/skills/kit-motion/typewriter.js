/* 改编自 Apache-2.0 许可的开源素材，动画和写法有改动。许可证原文见 /opt/slate/licenses/kit/LICENSE */
/** 打字机：文字逐字出现，光标跟在最后一个字后面，按固定节奏闪烁。参数：at 开始秒数，dur 总时长（默认 2.12），caret 光标样式 line/block/none，tone 颜色 ink/paper/accent，blinkTo 闪烁时的最低透明度 */
(function () {
  KIT.css("kit-typewriter", `
    .kit-tw-caret{display:inline-block;height:1em;vertical-align:-0.14em;border-radius:999px;background:currentColor;pointer-events:none}
  `);
  const cache = new WeakMap();
  function charsOf(el) {
    if (cache.has(el)) return cache.get(el);
    let chars;
    if (el.dataset.kitSplit) {
      chars = Array.from(el.querySelectorAll("span")).filter(s => !s.querySelector("span") && !s.classList.contains("kit-tw-caret"));
    } else {
      chars = KIT.splitChars(el);
      el.dataset.kitSplit = "chars";
    }
    chars = Array.from(chars || []);
    cache.set(el, chars);
    return chars;
  }
  const TONES = { ink: "#18181b", paper: "#fafafa", accent: "var(--brand, #34d399)" };
  const CARETS = { line: 0.075, block: 0.52 };

  KIT.motions = KIT.motions || {};
  KIT.motions.typewriter = function (tl, target, o = {}) {
    const els = KIT.els(target);
    const at = o.at ?? 0, dur = o.dur ?? 2.12;
    const k = dur / 2.12;
    const caretKind = o.caret === "none" || o.caret === "block" ? o.caret : "line";
    const blinkTo = o.blinkTo ?? 0.2;

    els.forEach(el => {
      if (o.tone && TONES[o.tone]) el.style.color = TONES[o.tone];
      const chars = charsOf(el);
      const n = chars.length;
      const show = (c, on) => {
        c.style.visibility = on ? "visible" : "hidden";
        c.style.opacity = on ? "1" : "0";
      };
      chars.forEach(c => show(c, false));

      let caret = null;
      if (caretKind !== "none") {
        caret = document.createElement("span");
        caret.className = "kit-tw-caret";
        caret.setAttribute("data-qa", "ignore");
        caret.setAttribute("aria-hidden", "true");
        const w = CARETS[caretKind], g = 0.1;
        caret.style.width = `max(2px, ${w}em)`;
        caret.style.marginLeft = `${g}em`;
        caret.style.marginRight = `calc(-1 * (max(2px, ${w}em) + ${g}em))`;
        if (n) chars[0].before(caret); else el.appendChild(caret);
      }

      // 打字：阶梯式逐字露出（每个字一档），只由进度 p 决定
      tl.call(p => {
        const count = Math.max(0, Math.min(n, Math.floor(p * n + 1e-6)));
        for (let i = 0; i < n; i++) show(chars[i], i < count);
        if (caret && n) {
          if (count === 0) { if (caret.nextSibling !== chars[0]) chars[0].before(caret); }
          else if (chars[count - 1].nextSibling !== caret) chars[count - 1].after(caret);
        }
      }, { at, dur: 1.2 * k, ease: "linear" });

      // 光标闪烁：0.2 秒后开始，8 个半程（每个 0.24 秒），线性往返
      if (caret) {
        tl.tween(caret, { opacity: [1, blinkTo] }, {
          at: at + 0.2 * k, dur: 0.24 * k, ease: "linear", repeat: 7, yoyo: true
        });
      }
    });
    return tl;
  };
})();
