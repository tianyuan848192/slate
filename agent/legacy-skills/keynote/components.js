/* 发布会大字组件（依赖 SLATE 运行时）
 *
 * 一镜分成几"屏"，每屏一句话，屏与屏之间按节拍硬切。组件在创建时一次性生成 DOM 元素，
 * 返回带 set(lt) 的对象：lt 是"这一屏开始后的秒数"（小于 0 表示这一屏还没到）。
 * 坐标和字号都是像素，按 SLATE.u（短边的 1%）或 SLATE.height 的比例算。
 *
 *   const root = document.getElementById('stage');
 *   const s1 = KN.screen(root), s2 = KN.screen(root);
 *   const h  = KN.headline(s1, {text: '快一倍', x, y, size: U * 24, accent: '一倍', mode: 'rise'});   // 逐字升起；mode: 'wipe' 遮罩擦出
 *   const b  = KN.bar(s1, {x, y, w: U * 12, delay: 0.5});                                            // 强调条
 *   const sb = KN.sub(s1, {text: '全新 S3 芯片', x, y, delay: 0.7});                                  // 副标题
 *   const n  = KN.number(s2, {to: 100, suffix: '%', x: W / 2, y, align: 'center', accent: 'suffix'}); // 数字滚动，默认字号 = 画面高度的 34%
 *   const c  = KN.card(s3, {x, y, w, h, label: '产品图'});                                            // 产品占位卡；有图时传 src: '/input/xx.png'
 *   const cut = KN.cuts([s1, s2, s3], [0, KN.beats(3), KN.beats(9)]);                                // 每屏开始的时刻，对齐节拍
 *   function render(t) {
 *     cut.set(t);                       // 只显示当前这一屏，并给它一点缓慢推近
 *     h.set(cut.local(t, 0)); b.set(cut.local(t, 0)); sb.set(cut.local(t, 0));
 *     n.set(cut.local(t, 1)); c.set(cut.local(t, 2));
 *   }
 */
(() => {
  const S = window.SLATE;
  const U = S.u;
  const C = { bg: '#0E1220', ink: '#FFFFFF', accent: '#F4B400', muted: '#8A93AA', line: '#262C40', card: '#161B2C' };
  const BPM = 120;   // 默认按 tech 配乐（120 BPM，一拍 0.5 秒）

  /** 创建元素；parent 可以是 DOM 元素，也可以是 KN.screen 返回的对象 */
  const el = (tag, cls, parent, css = {}) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    Object.assign(e.style, css);
    if (parent) (parent.el || parent).appendChild(e);
    return e;
  };
  const px = v => `${v.toFixed(2)}px`;
  /** 对齐：left 时 x 是左边，center 时 x 是中线，right 时 x 是右边 */
  const alignX = align => (align === 'center' ? '-50%' : align === 'right' ? '-100%' : '0');

  /** n 拍对应的秒数 */
  const beats = (n, bpm = BPM) => n * 60 / bpm;

  /** 一屏：铺满画面的图层。push 是整屏在这一屏时长内缓慢推近的幅度（0.03 = 放大 3%） */
  function screen(root, { push = 0.03 } = {}) {
    const e = el('div', 'kn-screen', root);
    e.style.display = 'none';
    return {
      el: e, push,
      set(lt, dur) {
        const p = S.clamp(lt / Math.max(0.1, dur));
        e.style.transform = `scale(${(1 + push * p).toFixed(4)})`;
      },
    };
  }

  /** 硬切：starts 是每屏开始的秒数（递增）。set(t) 只显示当前这一屏 */
  function cuts(screens, starts) {
    const idx = t => { let i = 0; for (let k = 0; k < starts.length; k++) if (t >= starts[k]) i = k; return i; };
    return {
      set(t) {
        const i = idx(t);
        screens.forEach((s, k) => {
          s.el.style.display = k === i ? 'block' : 'none';
          const end = k + 1 < starts.length ? starts[k + 1] : S.duration;
          s.set(t - starts[k], end - starts[k]);   // 每屏都按 t 设好状态，隐藏的屏也一样
        });
        return i;
      },
      /** 第 i 屏的屏内时间 */
      local(t, i) { return t - starts[i]; },
      index: idx,
    };
  }

  /** 大字：一行，逐字升起（rise）或遮罩擦出（wipe）。accent 是要用强调色的那几个字（只用一处） */
  function headline(parent, { text, x, y, size = U * 18, align = 'left', accent = '', mode = 'rise', weight = 900, color = C.ink, delay = 0, dur = 0.45, gap = 0.06 }) {
    const box = el('div', 'kn-line', parent, { left: px(x), top: px(y), fontSize: px(size), fontWeight: weight, color, transform: `translateX(${alignX(align)})` });
    const chars = Array.from(text);
    const ai = accent ? text.indexOf(accent) : -1;
    const inner = [];
    chars.forEach((ch, i) => {
      const isAcc = ai >= 0 && i >= ai && i < ai + Array.from(accent).length;
      if (mode === 'rise') {
        const mask = el('span', 'kn-mask', box);
        const c = el('span', 'kn-char', mask, { color: isAcc ? C.accent : '' });
        c.textContent = ch;
        inner.push(c);
      } else {
        const c = el('span', 'kn-char', box, { color: isAcc ? C.accent : '' });
        c.textContent = ch;
      }
    });
    const wiper = mode === 'wipe' ? el('span', 'kn-wiper', box, { width: px(U * 0.7), marginLeft: px(-U * 0.7), background: C.accent }) : null;
    return {
      el: box,
      set(lt) {
        const t = lt - delay;
        box.style.visibility = t >= 0 ? 'visible' : 'hidden';
        if (mode === 'rise') {
          inner.forEach((c, i) => {
            const p = S.seg(t, i * gap, i * gap + dur, S.ease.out);
            c.style.transform = `translateY(${((1 - p) * 105).toFixed(2)}%)`;
            c.style.opacity = S.clamp(p * 1.6).toFixed(3);
          });
        } else {
          const p = S.seg(t, 0, dur + 0.1, S.ease.inOut);
          box.style.clipPath = `inset(-10% ${((1 - p) * 100).toFixed(2)}% -10% 0)`;
          wiper.style.left = `${(p * 100).toFixed(2)}%`;
          wiper.style.opacity = (p > 0 && p < 1 ? 1 : 0);
        }
      },
    };
  }

  /** 数字：默认像里程表一样逐位滚动（roll: true），最后停在 to。
   *  size 默认取画面高度的 34%（放不下时按宽度缩小）；digits 是小数位数；accent: 'suffix' | 'number' | 'prefix' | null */
  function number(parent, { to, from = 0, digits = 0, prefix = '', suffix = '', x, y, size = null, align = 'center', accent = 'suffix',
                            roll = true, delay = 0, dur = 1.1, color = C.ink }) {
    const scale = 10 ** digits;
    const n = Math.max(String(Math.round(Math.max(Math.abs(from), Math.abs(to)) * scale)).length, digits + 1);   // 列数
    const chars = Array.from(prefix + suffix).length + n + (digits ? 0.4 : 0);
    const fs = size || Math.min(S.height * 0.34, S.width * 0.86 / (chars * 0.62));
    const box = el('div', 'kn-number', parent, { left: px(x), top: px(y), fontSize: px(fs), color, transform: `translateX(${alignX(align)})` });
    const part = (txt, key) => { const e = el('span', 'kn-affix', box, { color: accent === key ? C.accent : '' }); e.textContent = txt; return e; };
    if (prefix) part(prefix, 'prefix');
    const numBox = el('span', 'kn-digits', box, { color: accent === 'number' ? C.accent : '' });
    if (suffix) part(suffix, 'suffix');
    // 量出最宽的数字，作为每一列的宽度
    const probe = el('span', '', numBox);
    let wmax = 0;
    for (let d = 0; d < 10; d++) { probe.textContent = String(d); wmax = Math.max(wmax, probe.getBoundingClientRect().width); }
    probe.remove();
    const colW = `${((wmax || fs * 0.6) / fs).toFixed(3)}em`;
    const cols = [];
    const plain = roll ? el('span', '', null) : el('span', '', numBox);
    if (roll) {
      for (let i = n - 1; i >= 0; i--) {   // i：从个位（0）往高位数的列号
        const col = el('span', 'kn-col', numBox, { width: colW });
        cols.push({ i, col, cur: el('span', 'kn-glyph kn-cur', col), next: el('span', 'kn-glyph kn-next', col) });
        if (digits && i === digits) el('span', 'kn-dot', numBox).textContent = '.';
      }
    }
    return {
      el: box, size: fs,
      set(lt) {
        const t = lt - delay;
        box.style.visibility = t >= 0 ? 'visible' : 'hidden';
        const p = S.seg(t, 0, dur, S.ease.out);
        if (!roll) { plain.textContent = S.countUp(to, p, digits, from); return; }
        const v = Math.max(0, S.lerp(from, to, p) * scale);   // 当成整数来滚
        for (const { i, col, cur, next } of cols) {
          const base = 10 ** i;
          // 里程表：个位连续转动；高位只在低位从 9 翻到 0 的那一下跟着进一格
          const pos = i === 0 ? v % 10 : Math.floor(v / base) % 10 + Math.max(0, (v % base) - (base - 1));
          const d = Math.floor(pos + 1e-9) % 10, f = S.clamp(pos - Math.floor(pos + 1e-9));
          cur.textContent = String(d); next.textContent = String((d + 1) % 10);
          // 滚筒式翻动：当前数字往上压扁，下一个数字从下面撑开；两个字都留在这一列的方框里
          cur.style.transform = `scaleY(${(1 - f).toFixed(4)})`; cur.style.opacity = (1 - f).toFixed(3);
          next.style.transform = `scaleY(${f.toFixed(4)})`; next.style.opacity = f.toFixed(3);
          // 高位还没有数时整列收起（不显示前导 0）；小数点前的个位和小数位始终显示
          const lead = i > digits ? S.clamp(v - (base - 1)) : 1;
          col.style.display = lead > 0 ? '' : 'none';
          col.style.opacity = lead.toFixed(3);
        }
      },
    };
  }

  /** 副标题：小一号的灰字，轻轻上浮出现 */
  function sub(parent, { text, x, y, size = U * 3.4, align = 'left', color = C.muted, weight = 500, delay = 0, dur = 0.4 }) {
    const e = el('div', 'kn-sub', parent, { left: px(x), top: px(y), fontSize: px(size), color, fontWeight: weight });
    e.textContent = text;
    return {
      el: e,
      set(lt) {
        const p = S.seg(lt - delay, 0, dur);
        e.style.opacity = p.toFixed(3);
        e.style.transform = `translate(${alignX(align)}, ${((1 - p) * U * 1.2).toFixed(2)}px)`;
      },
    };
  }

  /** 强调条：从左往右长出来的一条强调色短横 */
  function bar(parent, { x, y, w = U * 12, h = U * 0.9, align = 'left', color = C.accent, delay = 0, dur = 0.35 }) {
    const e = el('div', 'kn-bar', parent, { left: px(x), top: px(y), width: px(w), height: px(h), background: color,
      transformOrigin: align === 'right' ? 'right center' : align === 'center' ? 'center' : 'left center' });
    const shift = align === 'center' ? -w / 2 : align === 'right' ? -w : 0;
    return {
      el: e,
      set(lt) {
        const p = S.seg(lt - delay, 0, dur, S.ease.inOut);
        e.style.transform = `translateX(${px(shift)}) scaleX(${p.toFixed(4)})`;
      },
    };
  }

  /** 产品占位卡：深色圆角卡片 + 轮廓光；有产品图时传 src（比如 '/input/product.png'），没有时显示占位线稿和 label */
  function card(parent, { x, y, w, h, src = '', label = '产品图', delay = 0, dur = 0.6, drift = 0.04 }) {
    const e = el('div', 'kn-card', parent, { left: px(x), top: px(y), width: px(w), height: px(h), borderRadius: px(U * 2.4) });
    el('div', 'kn-card-glow', e);
    if (src) {
      const img = el('img', 'kn-card-img', e);
      img.src = src;
      img.alt = '';
    } else {
      // 占位线稿：一台笔记本的轮廓
      const NS = 'http://www.w3.org/2000/svg';
      const s = document.createElementNS(NS, 'svg');
      s.setAttribute('viewBox', '0 0 160 100');
      s.setAttribute('class', 'kn-card-art');
      e.appendChild(s);
      S.svg('rect', { x: 34, y: 18, width: 92, height: 58, rx: 4, fill: 'none', stroke: '#A9B4CF', 'stroke-width': 1.4 }, s);
      S.svg('rect', { x: 39, y: 23, width: 82, height: 48, rx: 1.5, fill: '#1E2438', stroke: 'none' }, s);
      S.svg('path', { d: 'M 22 80 L 138 80 L 132 86 Q 131 87 129 87 L 31 87 Q 29 87 28 86 Z', fill: 'none', stroke: '#A9B4CF', 'stroke-width': 1.4, 'stroke-linejoin': 'round' }, s);
      S.svg('path', { d: 'M 70 80 L 90 80', stroke: '#A9B4CF', 'stroke-width': 1.4 }, s);
      S.svg('path', { d: 'M 46 64 Q 80 40 114 30', fill: 'none', stroke: C.accent, 'stroke-width': 1.2, 'stroke-opacity': 0.85, 'stroke-linecap': 'round' }, s);
      const lb = el('div', 'kn-card-label', e, { fontSize: px(U * 1.8), bottom: px(U * 2), left: px(U * 2.4) });
      lb.textContent = label;
    }
    return {
      el: e,
      set(lt) {
        const t = lt - delay, p = S.seg(t, 0, dur);
        e.style.opacity = p.toFixed(3);
        const sc = 0.94 + 0.06 * p + drift * S.clamp((t - dur) / 4);   // 入场后继续缓慢推近
        e.style.transform = `translateY(${((1 - p) * U * 3).toFixed(2)}px) scale(${sc.toFixed(4)})`;
      },
    };
  }

  window.KN = { C, U, BPM, beats, screen, cuts, headline, number, sub, bar, card };
})();
