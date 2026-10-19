/* 改编自 Apache-2.0 许可的开源素材，动画和写法有改动。许可证原文见 /opt/slate/licenses/kit/LICENSE */
/** 提示词按人手节奏分块打出，光标确定性闪烁，可先打错末尾再退格改正。参数：at, dur(默认4), text, glyph, cadence(human|uniform), caret(blink|solid), correction, cues, accent, exit(none|fade|up), seed */
(function () {
  KIT.motions = KIT.motions || {};

  KIT.css('kit-typed-prompt', `
    .kit-tp-glyph{display:inline-block;margin-right:0.6em;font-weight:600;color:var(--kit-tp-accent);}
    .kit-tp-text{white-space:pre-wrap;}
    .kit-tp-caret{display:inline-block;width:0.55ch;min-width:0.22em;height:1.05em;margin-left:0.08em;background:var(--kit-tp-accent);vertical-align:text-bottom;}
  `);

  function makeRng(seed) {
    let s = seed >>> 0;
    return function () {
      s = (Math.imul(1664525, s) + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }

  // 建“时刻→文字”表（时刻相对 at）
  function buildRows(text, opt) {
    const rnd = makeRng(opt.seed);
    const uniform = opt.cadence === 'uniform';
    const correction = Array.from(opt.correction || '');
    let words, sep;
    if (/\s/.test(text.trim())) {
      words = text.split(/\s+/).filter(w => w.length > 0);
      sep = ' ';
    } else {
      const chars = Array.from(text.trim());
      sep = '';
      if (correction.length && chars.length) {
        const n = Math.min(correction.length, chars.length);
        words = [chars.slice(0, chars.length - n).join(''), chars.slice(chars.length - n).join('')].filter(w => w.length);
      } else {
        words = chars.length ? [chars.join('')] : [];
      }
    }
    const hasCorrection = correction.length > 0 && words.length > 0;

    function chunksOf(word) {
      const c = Array.from(word);
      if (uniform) return c.map(x => [x]);
      const out = [];
      let i = 0;
      while (i < c.length) {
        const n = 1 + Math.floor(rnd() * 3);
        out.push(c.slice(i, i + n));
        i += n;
      }
      return out;
    }
    function gap(chunk) {
      return uniform ? chunk.length * 0.055 : chunk.length * (0.05 + rnd() * 0.04);
    }

    const rows = [{ t: 0, x: '' }];
    let t = opt.typeStart;
    let acc = [];
    const push = () => rows.push({ t, x: acc.join('') });
    words.forEach((word, wi) => {
      const isLast = wi === words.length - 1;
      const typed = hasCorrection && isLast ? correction.join('') : word;
      if (wi > 0 && sep) acc.push(sep);
      if (opt.cues[wi] != null) t = Math.max(t, opt.cues[wi]);
      else if (wi > 0) t += uniform ? 0.11 : 0.1 + rnd() * 0.1;
      chunksOf(typed).forEach(ch => { t += gap(ch); acc = acc.concat(ch); push(); });
      if (hasCorrection && isLast) {
        t += 0.4; // 发现打错的停顿
        for (let b = 0; b < correction.length; b++) { t += 0.055; acc.pop(); push(); }
        t += 0.22;
        chunksOf(word).forEach(ch => { t += gap(ch); acc = acc.concat(ch); push(); });
      }
    });
    return rows;
  }

  KIT.motions.typedPrompt = function (tl, target, o = {}) {
    const els = KIT.els(target);
    const at = o.at ?? 0, dur = o.dur ?? 4;
    const u = SLATE.u;
    const fit = KIT.fit(4, dur);
    const k = Math.min(1, fit.k);
    const ENTER = 0.5 * k, TYPE_START = 0.35 * k, STILL = 0.3;
    const exit = o.exit === 'fade' || o.exit === 'up' ? o.exit : 'none';
    const OUT = exit === 'none' ? 0 : Math.min(0.45, dur * 0.2);
    const caretMode = o.caret === 'solid' ? 'solid' : 'blink';
    const glyph = o.glyph == null ? '>' : String(o.glyph);
    const cues = (o.cues || []).map(Number).filter(v => isFinite(v) && v >= 0).sort((a, b) => a - b);

    els.forEach((el, idx) => {
      // 只初始化一次结构
      let textEl, caretEl;
      if (el.dataset.kitTyped) {
        textEl = el.querySelector('.kit-tp-text');
        caretEl = el.querySelector('.kit-tp-caret');
      } else {
        const original = o.text != null ? String(o.text) : el.textContent.trim();
        el.dataset.kitTyped = '1';
        el.dataset.kitTypedText = original;
        el.setAttribute('aria-label', original);
        el.textContent = '';
        if (glyph !== '') {
          const g = document.createElement('span');
          g.className = 'kit-tp-glyph';
          g.setAttribute('data-qa', 'ignore');
          g.textContent = glyph;
          el.appendChild(g);
        }
        textEl = document.createElement('span');
        textEl.className = 'kit-tp-text';
        caretEl = document.createElement('span');
        caretEl.className = 'kit-tp-caret';
        caretEl.setAttribute('data-qa', 'ignore');
        el.appendChild(textEl);
        el.appendChild(caretEl);
      }
      el.style.setProperty('--kit-tp-accent', o.accent || 'var(--kit-accent, #7c5cff)');
      const text = o.text != null ? String(o.text) : el.dataset.kitTypedText;

      const rows = buildRows(text, {
        cadence: o.cadence, correction: o.correction ? String(o.correction).trim() : '',
        seed: (o.seed ?? 0x7f4a7c15) + idx * 7919, typeStart: TYPE_START, cues
      });
      // 太长才等比压缩，多余时间变成停留
      const naturalEnd = rows[rows.length - 1].t;
      const maxEnd = Math.max(TYPE_START + 0.2, dur - OUT - STILL);
      if (naturalEnd > maxEnd) {
        const f = (maxEnd - TYPE_START) / (naturalEnd - TYPE_START);
        rows.forEach(r => { if (r.t > TYPE_START) r.t = TYPE_START + (r.t - TYPE_START) * f; });
      }
      const typeEnd = Math.max(rows[rows.length - 1].t, TYPE_START + 0.01);
      const textAt = time => {
        for (let i = rows.length - 1; i >= 0; i--) if (time >= rows[i].t - 0.001) return rows[i].x;
        return '';
      };
      textEl.textContent = '';

      // 入场
      tl.tween(el, 'opacity', [0, 1], { at, dur: ENTER, ease: 'outCubic' });
      tl.tween(el, 'y', [1.8 * u, 0], { at, dur: ENTER, ease: 'outQuart' });

      // 文字：每帧从表里查
      tl.call(p => {
        const s = textAt(p * typeEnd);
        if (textEl.textContent !== s) textEl.textContent = s;
      }, { at, dur: typeEnd, ease: 'linear' });

      // 光标：整数个正弦周期，结束常亮
      if (caretMode === 'blink') {
        const cycles = Math.max(1, Math.round(typeEnd / 0.9));
        tl.call(p => {
          const on = p >= 1 || Math.sin(p * Math.PI * 2 * cycles) >= 0;
          caretEl.style.opacity = on ? '1' : '0';
        }, { at, dur: typeEnd, ease: 'linear' });
      } else {
        caretEl.style.opacity = '1';
      }

      // 停留：轻微漂移后归于静止
      const outStart = dur - OUT;
      const hold = outStart - typeEnd;
      if (hold > 0.9) {
        const half = (hold - STILL) / 2;
        tl.tween(el, 'y', -0.3 * u, { at: at + typeEnd, dur: half, ease: 'inOutSine' });
        tl.tween(el, 'y', 0, { at: at + typeEnd + half, dur: half, ease: 'inOutSine' });
      }

      // 退场
      if (exit !== 'none') {
        tl.tween(el, 'opacity', 0, { at: at + outStart, dur: OUT, ease: 'inCubic' });
        if (exit === 'up') tl.tween(el, 'y', -2.8 * u, { at: at + outStart, dur: OUT, ease: 'inCubic' });
      }
    });
    return tl;
  };
})();
