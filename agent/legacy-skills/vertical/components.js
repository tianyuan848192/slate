/* 竖屏快剪组件（依赖 SLATE 运行时，按 9:16 设计）
 *
 * 一镜分成几"屏"，1～2 秒一切。组件在创建时一次性生成 DOM 元素，返回带 set(lt) 的对象：
 * lt 是"这一屏开始后的秒数"（小于 0 表示还没到）；跨屏的组件（进度条、声波）直接传 t。
 * 坐标和字号都是像素，按 SLATE.u（短边的 1%）的倍数算。
 *
 * 竖屏的字幕区由运行时放在画面约 70%～84% 的高度，再往下是平台的按钮和文案区。
 * 主要内容放在 VT.zone 里（画面 8%～67% 的高度），不要放进字幕区和它下面。
 *
 *   const root = document.getElementById('stage');
 *   const s1 = VT.screen(root), s2 = VT.screen(root);
 *   const hook = VT.hook(s1, {lines: ['地铁里', '吵到崩溃？'], mark: '崩溃', y: H * 0.24});     // 钩子大字：一行一行砸进来
 *   const tag  = VT.sticker(s1, {text: '85 分贝', x, y, rot: 6, bg: VT.C.coral});             // 贴纸标签
 *   const card = VT.card(s2, {icon: 'mute', value: '-45dB', label: '深度降噪', bg: VT.C.indigo}); // 快切卡片
 *   const prod = VT.badge(s3, {icon: 'headphones', y: H * 0.33});                               // 产品徽章（产品占位，或传 src 放产品图）
 *   const cta  = VT.cta(s3, {text: '立即抢购', y: H * 0.5});                                  // 行动号召按钮（会呼吸、有点击波纹）
 *   const bar  = VT.progress(root, {marks: [0, 1.2, 3]});                                      // 顶部分段进度条
 *   const wave = VT.wave(root, {y: H * 0.5, h: U * 20});                                       // 声波：amp 从 1 降到 0 就"安静"了
 *   const cut  = VT.cuts([s1, s2, s3], [0, 1.2, 3], {style: 'punch'});                       // 硬切 + 每屏开头 0.2 秒的冲击
 *   function render(t) { cut.set(t); hook.set(cut.local(t, 0)); card.set(cut.local(t, 1)); cta.set(cut.local(t, 2)); bar.set(t); wave.set(t, 1); }
 */
(() => {
  const S = window.SLATE;
  const U = S.u;
  const C = { bg: '#1D1F2B', ink: '#FFFFFF', dark: '#14151E', coral: '#F25F5C', yellow: '#FFE066', indigo: '#5B5BD6', muted: '#A6A8BE', shadow: '#0B0C12' };
  // 主要内容区：安全区内、字幕区以上（竖屏下面还有平台的按钮和文案）
  const zoneTop = Math.round(S.height * 0.08);
  const zone = { x: S.safe.x, y: zoneTop, w: S.safe.w, h: Math.round(S.captionZone.y - S.u * 4 - zoneTop) };

  /** 创建元素；parent 可以是 DOM 元素，也可以是 VT.screen 返回的对象 */
  const el = (tag, cls, parent, css = {}) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    Object.assign(e.style, css);
    if (parent) (parent.el || parent).appendChild(e);
    return e;
  };
  const px = v => `${v.toFixed(2)}px`;

  /** 图标：线条粗、圆头，像贴纸上的简笔画。返回一个 <svg> 元素 */
  const ICONS = {
    headphones: '<path d="M14 58 V48 a36 36 0 0 1 72 0 V58"/><rect x="8" y="54" width="20" height="32" rx="8"/><rect x="72" y="54" width="20" height="32" rx="8"/>',
    mute: '<path d="M12 40 H28 L48 22 V78 L28 60 H12 Z"/><path d="M64 38 L86 62 M86 38 L64 62"/>',
    battery: '<rect x="8" y="28" width="76" height="44" rx="8"/><path d="M90 42 V58"/><path d="M20 40 H40 V60 H20 Z" fill="currentColor"/><path d="M48 40 H62 V60 H48 Z" fill="currentColor"/>',
    bolt: '<path d="M56 8 L22 56 H48 L42 92 L78 40 H52 Z"/>',
    cart: '<path d="M8 16 H22 L32 64 H80 L90 30 H28"/><circle cx="38" cy="80" r="6"/><circle cx="74" cy="80" r="6"/>',
    wave: '<path d="M8 50 H22 L30 26 L40 76 L50 16 L60 84 L70 32 L78 50 H92"/>',
    check: '<path d="M18 52 L40 74 L84 26"/>',
  };
  function icon(name, size, color = C.ink, stroke = 8) {
    const NS = 'http://www.w3.org/2000/svg';
    const s = document.createElementNS(NS, 'svg');
    s.setAttribute('viewBox', '0 0 100 100');
    s.setAttribute('width', size); s.setAttribute('height', size);
    s.setAttribute('fill', 'none'); s.setAttribute('stroke', color); s.setAttribute('stroke-width', stroke);
    s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round');
    s.style.color = color;
    s.innerHTML = ICONS[name] || ICONS.check;
    return s;
  }

  /** 弹出：0 → 1 带回弹（back 缓动），用于贴纸和卡片 */
  const pop = (t, dur = 0.28) => S.seg(t, 0, dur, S.ease.back);

  /** 一屏：铺满画面的图层 */
  function screen(root) {
    const e = el('div', 'vt-screen', root);
    e.style.display = 'none';
    return { el: e };
  }

  /** 快切：starts 是每屏开始的秒数。style：'punch'（缩放冲击）| 'whip'（甩镜，从右边甩进来）| 'cut'（纯硬切）；
   *  也可以传数组，给每一屏单独指定 */
  function cuts(screens, starts, { style = 'punch', dur = 0.2 } = {}) {
    const idx = t => { let i = 0; for (let k = 0; k < starts.length; k++) if (t >= starts[k]) i = k; return i; };
    return {
      set(t) {
        const i = idx(t);
        screens.forEach((s, k) => {
          s.el.style.display = k === i ? 'block' : 'none';
          const p = k === 0 ? 1 : S.seg(t - starts[k], 0, dur, S.ease.out);   // 第一屏不做冲击
          const sty = Array.isArray(style) ? style[k] : style;
          if (sty === 'punch') s.el.style.transform = `scale(${(1 + 0.14 * (1 - p)).toFixed(4)})`;
          else if (sty === 'whip') s.el.style.transform = `translateX(${((1 - p) * 38).toFixed(2)}%) skewX(${(-(1 - p) * 14).toFixed(2)}deg)`;
          else s.el.style.transform = 'none';
        });
        return i;
      },
      local(t, i) { return t - starts[i]; },
      index: idx,
    };
  }

  /** 钩子大字：几行大字一行一行"砸"进来。mark 是要压上黄色贴纸底的那几个字（每屏一处） */
  function hook(parent, { lines, mark = '', x = S.width / 2, y = zone.y + zone.h * 0.2, size = U * 15, gap = 0.14, align = 'center', color = C.ink, lineGap = 1.12 }) {
    const box = el('div', 'vt-hook', parent, { left: px(x), top: px(y), fontSize: px(size), color, textAlign: align,
      transform: `translateX(${align === 'center' ? '-50%' : align === 'right' ? '-100%' : '0'})`, lineHeight: lineGap });
    const rows = lines.map((ln, i) => {
      const row = el('div', 'vt-hook-line', box, { transformOrigin: align === 'left' ? 'left center' : align === 'right' ? 'right center' : 'center' });
      const k = mark ? ln.indexOf(mark) : -1;
      if (k >= 0) {
        if (k > 0) el('span', '', row).textContent = ln.slice(0, k);
        el('span', 'vt-mark', row, { background: C.yellow, color: C.dark }).textContent = mark;
        if (k + mark.length < ln.length) el('span', '', row).textContent = ln.slice(k + mark.length);
      } else row.textContent = ln;
      return row;
    });
    return {
      el: box,
      set(lt) {
        rows.forEach((r, i) => {
          const p = S.seg(lt, i * gap, i * gap + 0.22, S.ease.out);
          r.style.opacity = S.clamp(p * 3).toFixed(3);
          r.style.transform = `scale(${(1 + 0.6 * (1 - p)).toFixed(4)}) rotate(${((1 - p) * (i % 2 ? 4 : -4)).toFixed(2)}deg)`;
        });
      },
    };
  }

  /** 贴纸标签：白边、硬阴影、略微倾斜；弹出后轻轻晃动 */
  function sticker(parent, { text, x, y, rot = -4, bg = C.yellow, color = C.dark, size = U * 5, icon: ic = '', delay = 0, wobble = 1.5, anchor = 'center' }) {
    const e = el('div', 'vt-sticker', parent, { left: px(x), top: px(y), fontSize: px(size), background: bg, color });
    if (ic) e.appendChild(icon(ic, size * 1.1, color, 10));
    el('span', '', e).textContent = text;
    const ax = anchor === 'left' ? '0' : anchor === 'right' ? '-100%' : '-50%';
    return {
      el: e,
      set(lt) {
        const t = lt - delay, p = pop(t);
        e.style.opacity = (t >= 0 ? S.clamp(p * 4) : 0).toFixed(3);
        const r = rot + wobble * Math.sin(Math.max(0, t) * 5.5) * S.clamp(t / 0.5);
        e.style.transform = `translate(${ax}, -50%) rotate(${r.toFixed(2)}deg) scale(${Math.max(0, p).toFixed(4)})`;
      },
    };
  }

  /** 快切卡片：一屏一个卖点。大圆角色块 + 图标 + 大数字 + 一行说明 */
  function card(parent, { icon: ic = 'check', value, label = '', bg = C.indigo, x = zone.x + zone.w * 0.04, y = zone.y + zone.h * 0.08, w = zone.w * 0.92, h = zone.h * 0.76, size = U * 19, delay = 0 }) {
    const e = el('div', 'vt-card', parent, { left: px(x), top: px(y), width: px(w), height: px(h), background: bg, borderRadius: px(U * 5) });
    // 图标、数字、说明三行在卡片里竖直居中
    const top = (h - (U * 22 + size * 1.15 + U * 7.8)) / 2;
    const ib = el('div', 'vt-card-icon', e, { width: px(U * 18), height: px(U * 18), top: px(top) });
    ib.appendChild(icon(ic, U * 11, C.dark, 9));
    const v = el('div', 'vt-card-value', e, { fontSize: px(size), top: px(top + U * 22) });
    v.textContent = value;
    const l = el('div', 'vt-card-label', e, { fontSize: px(U * 6.5), top: px(top + U * 22 + size * 1.15) });
    l.textContent = label;
    return {
      el: e,
      set(lt) {
        const t = lt - delay, p = pop(t, 0.3);
        e.style.opacity = (t >= 0 ? S.clamp(p * 4) : 0).toFixed(3);
        e.style.transform = `translateY(${((1 - S.clamp(p)) * U * 8).toFixed(2)}px) rotate(${((1 - S.clamp(p)) * -3).toFixed(2)}deg) scale(${(0.9 + 0.1 * p).toFixed(4)})`;
        const q = S.seg(t, 0.12, 0.4, S.ease.back);
        v.style.transform = `translateX(-50%) scale(${Math.max(0, q).toFixed(4)})`;
        ib.style.transform = `translateX(-50%) rotate(${((1 - S.clamp(q)) * -20).toFixed(2)}deg) scale(${Math.max(0, q).toFixed(4)})`;
        l.style.opacity = S.seg(t, 0.25, 0.45).toFixed(3);
      },
    };
  }

  /** 产品徽章：黄色圆形贴纸里放一个大图标，没有产品图时当产品占位；有图时传 src（比如 '/input/product.png'） */
  function badge(parent, { icon: ic = 'headphones', src = '', x = S.width / 2, y = zone.y + zone.h * 0.4, d = U * 34, bg = C.yellow, delay = 0 }) {
    const e = el('div', 'vt-badge', parent, { left: px(x - d / 2), top: px(y - d / 2), width: px(d), height: px(d), background: bg });
    if (src) { const img = el('img', 'vt-badge-img', e); img.src = src; img.alt = ''; }
    else e.appendChild(icon(ic, d * 0.58, C.dark, 7));
    return {
      el: e,
      set(lt) {
        const t = lt - delay, p = pop(t, 0.34);
        e.style.opacity = (t >= 0 ? S.clamp(p * 4) : 0).toFixed(3);
        const bob = Math.sin(Math.max(0, t) * 3.2) * U * 0.8 * S.clamp(t / 0.4);
        e.style.transform = `translateY(${bob.toFixed(2)}px) rotate(${((1 - S.clamp(p)) * 25).toFixed(2)}deg) scale(${Math.max(0, p).toFixed(4)})`;
      },
    };
  }

  /** 行动号召按钮：黄底大按钮，一直轻轻"呼吸"，每 0.9 秒冒一圈点击波纹 */
  function cta(parent, { text, x = S.width / 2, y = zone.y + zone.h * 0.62, w = zone.w * 0.78, h = U * 15, delay = 0, period = 0.9 }) {
    const wrap = el('div', 'vt-cta-wrap', parent, { left: px(x - w / 2), top: px(y), width: px(w), height: px(h) });
    const ripple = el('div', 'vt-cta-ripple', wrap, { borderRadius: px(h / 2) });
    const btn = el('div', 'vt-cta', wrap, { borderRadius: px(h / 2), fontSize: px(U * 6.5) });
    el('span', '', btn).textContent = text;
    btn.appendChild(icon('cart', U * 6, C.dark, 10));
    return {
      el: wrap,
      set(lt) {
        const t = lt - delay, p = pop(t, 0.32);
        wrap.style.opacity = (t >= 0 ? S.clamp(p * 4) : 0).toFixed(3);
        const breathe = t > 0.35 ? 1 + 0.035 * Math.sin((t - 0.35) * Math.PI * 2 / period) : 1;
        btn.style.transform = `scale(${(Math.max(0, p) * breathe).toFixed(4)})`;
        const r = t > 0.35 ? ((t - 0.35) % period) / period : 0;
        ripple.style.opacity = (t > 0.35 ? 0.55 * (1 - r) : 0).toFixed(3);
        ripple.style.transform = `scale(${(1 + 0.18 * r).toFixed(4)}, ${(1 + 0.5 * r).toFixed(4)})`;
      },
    };
  }

  /** 顶部分段进度条：marks 是每段开始的秒数，最后一段到这一镜结束 */
  function progress(parent, { marks = [0], y = S.height * 0.055, color = C.ink } = {}) {
    const e = el('div', 'vt-progress', parent, { left: px(S.safe.x), top: px(y), width: px(S.safe.w), height: px(U * 0.7), gap: px(U * 0.8) });
    const segs = marks.map((m, i) => {
      const s = el('div', 'vt-progress-seg', e, { borderRadius: px(U * 0.35) });
      const f = el('div', 'vt-progress-fill', s, { background: color });
      return { s, f, a: m, b: i + 1 < marks.length ? marks[i + 1] : S.duration };
    });
    return {
      el: e,
      set(t) { segs.forEach(({ f, a, b }) => { f.style.transform = `scaleX(${S.clamp((t - a) / Math.max(0.01, b - a)).toFixed(4)})`; }); },
    };
  }

  /** 声波：一排竖条上下跳动。set(t, amp)：amp = 1 很吵，amp = 0 变成一条平线 */
  function wave(parent, { x = zone.x + zone.w * 0.04, y = zone.y + zone.h * 0.8, w = zone.w * 0.92, h = U * 18, bars = 26, color = C.coral, seed = 11 } = {}) {
    const e = el('div', 'vt-wave', parent, { left: px(x), top: px(y), width: px(w), height: px(h) });
    const r = S.rng(seed);
    const bw = w / bars;
    const items = Array.from({ length: bars }, (_, i) => {
      const b = el('div', 'vt-wave-bar', e, { left: px(i * bw + bw * 0.22), width: px(bw * 0.56), background: color, borderRadius: px(bw * 0.28) });
      return { b, ph: r() * Math.PI * 2, sp: 9 + r() * 9, base: 0.35 + r() * 0.65 };
    });
    return {
      el: e,
      set(t, amp = 1, on = 1) {
        e.style.opacity = S.clamp(on).toFixed(3);
        items.forEach(({ b, ph, sp, base }, i) => {
          const env = 0.55 + 0.45 * Math.sin(i / bars * Math.PI);                  // 中间高、两边低
          const v = S.clamp(amp) * base * env * (0.45 + 0.55 * Math.abs(Math.sin(t * sp + ph)));
          b.style.height = px(Math.max(U * 0.8, h * v));
        });
      },
    };
  }

  window.VT = { C, U, zone, icon, screen, cuts, hook, sticker, card, badge, cta, progress, wave };
})();
