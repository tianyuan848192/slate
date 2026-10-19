/* 瑞士网格组件（依赖 SLATE 运行时）：产品发布、卖点、规格参数、促销、品牌落版、竖屏短广告
 *
 * 约定
 *   - 所有组件在创建时一次性生成元素；render(t) 里只根据 t 设置状态，同一个 t 永远得到同一帧。
 *   - draw(p)：入场。p 是 0～1 的线性进度，用 SW.lin(t, 开始秒, 结束秒) 得到；组件内部统一套签名缓动 SW.E。
 *     out(p)：向上退出裁切框；cut(p)：刀切删除（信号色细线划过，元素塌缩成中线后消失）；strike(p)：划掉但保留（原价）。
 *   - 坐标是画布像素，尺寸写成 SLATE.u 的倍数。排版用网格 G = st.G：G.x(栏) 栏左边，G.w(栏数) 跨栏宽，
 *     G.y(行) 行上边，G.h(行数) 跨行高；G.top / G.bottom 是版心上下沿（下沿已经让开字幕区）。
 *   - 颜色按角色取，不直接写色值：SW.roles(tone) 返回 fg 正文、sub 注释、rule 细线、accent 信号色块、accentText 信号色文字。
 *     tone 是元素所在底色：'page'（默认浅灰）、'paper'（白）、'ink'（黑）、'signal'（信号色）。放在色块上的元素要传同样的 tone。
 *   - 文字里用 [方括号] 包住的部分显示成信号色，例如 text: '听见[安静]'。
 *
 *   const st = SW.stage({ grid: 'build' });                  // 舞台：底色 + 网格线 + 镜头 + hud
 *   const G = st.G;
 *   const hd = SW.heading(st.world, { index: '02', kicker: '卖点', text: '三个数字' });
 *   const n = SW.numeral(st.world, { x: G.x(0), y: hd.bottom, value: '48', unit: 'dB' });
 *   function render(t) { st.set(t); hd.draw(SW.lin(t, 0.2, 1)); n.draw(SW.lin(t, 0.8, 2)); }
 *
 * 组件一览（参数见各函数前的注释）：
 *   舞台与网格：stage、grid、layer、wipe
 *   页眉页脚（放 st.hud）：folio、footnote
 *   文字：heading、title、text、note、numeral
 *   线和块：rule、block
 *   版块：list（卖点）、specs（规格表）、product（产品图框）、price（价格卡）、cta（行动号召）、lockup（Logo 落版）
 */
(() => {
  const S = window.SLATE;
  const U = S.u, W = S.width, H = S.height, PORTRAIT = H > W;
  const clamp = S.clamp, lerp = S.lerp;
  document.documentElement.style.setProperty('--sw-u', U + 'px');

  // ---------------------------------------------------------------------------------------------
  // 颜色与对比度
  const C = {
    page: '#EAE9E5', paper: '#FFFFFF', ink: '#111111', light: '#F4F3EF', grey: '#5F5E5A',
    signal: '#E30613',
    font: '"Inter", "Noto Sans CJK SC", "Noto Sans SC", sans-serif',
  };
  const hex = c => { let s = String(c).replace('#', ''); if (s.length === 3) s = s.split('').map(x => x + x).join(''); return [0, 2, 4].map(i => parseInt(s.slice(i, i + 2), 16)); };
  const rgba = (c, a) => { const [r, g, b] = hex(c); return `rgba(${r}, ${g}, ${b}, ${a})`; };
  const lum = c => { const [r, g, b] = hex(c).map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  /** WCAG 对比度 */
  const contrast = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  /** 在底色 bg 上选黑字还是白字（按 WCAG 对比度） */
  const pickInk = (bg, a = C.ink, b = C.paper) => (contrast(bg, a) >= contrast(bg, b) ? a : b);
  /** 小字号：竖屏在手机上看，注释、页眉、脚注比横屏大一档 */
  const small = (land, port) => U * (PORTRAIT ? port : land);

  /** 换品牌色等：SW.theme({ signal: '#1F3FFF' })。要在创建舞台和组件之前调用（或者直接传给 SW.stage） */
  function theme(o = {}) {
    for (const k of ['signal', 'page', 'paper', 'ink']) if (o[k]) C[k] = o[k];
    const r = document.documentElement.style;
    r.setProperty('--sw-signal', C.signal); r.setProperty('--sw-page', C.page); r.setProperty('--sw-ink', C.ink);
  }

  let stageTone = 'page';
  /** 某种底色上各角色的颜色。accentText 是"信号色文字"：信号色在这个底色上对比度不足 3:1 时自动换成正文色 */
  function roles(tone) {
    const t = tone || stageTone;
    if (t === 'ink') {
      return { tone: t, bg: C.ink, fg: C.light, sub: '#A3A19B', line: rgba(C.light, 0.13), rule: C.light, accent: C.signal,
        accentText: contrast(C.signal, C.ink) >= 3 ? C.signal : C.light, knife: C.signal };
    }
    if (t === 'signal') {
      const on = pickInk(C.signal), other = on === C.paper ? C.ink : C.paper;
      return { tone: t, bg: C.signal, fg: on, sub: rgba(on, 0.86), line: rgba(on, 0.22), rule: on, accent: other,
        accentText: contrast(other, C.signal) >= 3 ? other : on, knife: on };
    }
    const bg = t === 'paper' ? C.paper : C.page;
    return { tone: t, bg, fg: C.ink, sub: C.grey, line: rgba(C.ink, 0.1), rule: C.ink, accent: C.signal,
      accentText: contrast(C.signal, bg) >= 3 ? C.signal : C.ink, knife: contrast(C.signal, bg) >= 2 ? C.signal : C.ink };
  }

  // ---------------------------------------------------------------------------------------------
  // 缓动与时间
  /** 三次贝塞尔缓动（和 CSS cubic-bezier 相同），端点精确返回 0 和 1 */
  function bezier(x1, y1, x2, y2) {
    const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
    const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
    const fx = u => ((ax * u + bx) * u + cx) * u, fy = u => ((ay * u + by) * u + cy) * u, dx = u => (3 * ax * u + 2 * bx) * u + cx;
    return p => {
      if (!(p > 0)) return 0;
      if (p >= 1) return 1;
      let u = p;
      for (let i = 0; i < 8; i++) { const e = fx(u) - p, d = dx(u); if (Math.abs(e) < 1e-7 || Math.abs(d) < 1e-6) break; u -= e / d; }
      if (!(u >= 0 && u <= 1) || Math.abs(fx(u) - p) > 1e-5) {
        let lo = 0, hi = 1; u = p;
        for (let i = 0; i < 50; i++) { const v = fx(u); if (Math.abs(v - p) < 1e-7) break; if (v < p) lo = u; else hi = u; u = (lo + hi) / 2; }
      }
      return fy(u);
    };
  }
  /** 签名缓动 cubic-bezier(.7, 0, .2, 1)：慢起、快切、长落定。全片只用它和线性 */
  const E = bezier(0.7, 0, 0.2, 1);
  /** 三档时长（秒）：s 小元素、m 标题和图框、l 网格和镜头；gap 是错峰间隔 */
  const T = { s: 0.35, m: 0.6, l: 1.0, gap: 0.08 };
  /** 线性进度：t 在 [a, b] 秒之间时从 0 走到 1。传给组件的 draw/out/cut */
  const lin = (t, a, b) => clamp((t - a) / Math.max(1e-6, b - a));
  /** 带签名缓动的进度（自己写动画时用） */
  const at = (t, a, b) => E(lin(t, a, b));
  /** 第 n 拍的秒数（tech 配乐 120 BPM，bright 108 BPM，calm 64 BPM） */
  const beat = (n, bpm = 120) => n * 60 / bpm;

  // ---------------------------------------------------------------------------------------------
  // DOM 工具
  const px = v => `${(+v).toFixed(2)}px`;
  const div = (cls, parentEl, css) => { const e = document.createElement('div'); if (cls) e.className = cls; if (css) Object.assign(e.style, css); if (parentEl) parentEl.appendChild(e); return e; };
  const span = (parentEl, txt, css, cls) => { const e = document.createElement('span'); if (cls) e.className = cls; if (txt != null) e.textContent = txt; if (css) Object.assign(e.style, css); parentEl.appendChild(e); return e; };
  const group = parentEl => div('sw-g', parentEl);
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  /** '听见[安静]' → 纯文字和带信号色 span 的 HTML */
  const marks = s => {
    const str = String(s ?? '');
    return { plain: str.replace(/\[([^\]]*)\]/g, '$1'), html: esc(str).replace(/\[([^\]]*)\]/g, '<span class="sw-hi">$1</span>') };
  };
  const anchorShift = a => (a === 'end' ? 'translateX(-100%)' : a === 'middle' ? 'translateX(-50%)' : '');
  const isLatin = s => /^[\x20-\x7E\u00A0-\u00FF]+$/.test(String(s));

  let curGrid = null;
  const G0 = () => curGrid || (curGrid = grid());

  /** 刀切细线：挂在 host 里（host 要有尺寸）。返回 set(cut, strike) → 塌缩进度 */
  function knifeLine(host, color) {
    const th = Math.max(1.5, U * 0.22);
    const e = div('sw-knife', host, { height: px(th), marginTop: px(-th / 2), background: color, visibility: 'hidden' });
    e.setAttribute('data-qa', 'ignore');
    return {
      el: e,
      set(cut, strike) {
        const c = clamp(cut), s = clamp(strike);
        // 删除：0～0.4 划线，0.3～0.75 塌缩，0.62～1 线从另一头离开；划掉：线划过后停住
        const lineIn = Math.max(E(clamp(c / 0.4)), E(s)), lineOut = c > 0 ? E(clamp((c - 0.62) / 0.38)) : 0;
        const len = Math.max(0, lineIn - lineOut);
        e.style.visibility = len > 0.001 ? 'visible' : 'hidden';
        // 用位置和宽度画线（不用缩放变换：缩放过的元素停下来以后，边缘像素会随渲染历史变化）
        e.style.left = `calc(${(lineOut * 100).toFixed(3)}% + ${(-0.08 + lineOut * 0.16).toFixed(4)}em)`;
        e.style.width = `calc(${(len * 100).toFixed(3)}% + ${(len * 0.16).toFixed(4)}em)`;
        return E(clamp((c - 0.3) / 0.45));
      },
    };
  }

  /** 给"外层排版框 + 裁切框 + 可见内层"装上入场、退场、刀切、划掉。onRise(k) 可以追加内层效果 */
  function rig(box, mask, inner, R, extra) {
    const kn = knifeLine(box, R.knife);
    const st = { p: 0, o: 0, c: 0, s: 0 };
    const upd = () => {
      const k = E(clamp(st.p)), ko = E(clamp(st.o));
      const col = kn.set(st.c, st.s);
      const dy = (1 - k) - ko;   // 1 = 在裁切框下面，0 = 就位，-1 = 升出上沿
      // 刀切塌缩：裁切框的上下沿向中线合拢，内层反向移动保持字不动（不缩放字形、不用 clip-path，渲染结果稳定）
      const cc = (col * 50).toFixed(3);
      mask.style.top = mask.style.bottom = col > 0 ? `calc(${cc}% - 0.16em)` : '';
      inner.style.transform = `translateY(calc(${(dy * 100 - col * 50).toFixed(3)}% + ${(dy * 0.3).toFixed(4)}em))`;
      const shown = st.p > 0 && col < 0.999 && ko < 0.999;
      mask.style.visibility = shown ? 'visible' : 'hidden';
      // 外层框（透明字）只在字可读时参与自检
      box.style.visibility = st.p > 0 && col < 0.5 && ko < 0.5 ? 'visible' : 'hidden';
      if (extra) extra(st);
    };
    upd();
    return {
      draw(p) { st.p = p; upd(); }, out(p) { st.o = p; upd(); }, cut(p) { st.c = p; upd(); }, strike(p) { st.s = p; upd(); },
      state: st, refresh: upd,
    };
  }

  /** 文字核心：opts x, y, text, size, weight, color, lh（行高倍数）, ls（字距 em）, w（宽，配合 wrap 自动换行）, wrap,
   *  anchor: start|middle|end, align（多行对齐）, tone, flow（true 时按文档流排，用于 flex 行）, font, tnum */
  function textCore(parentEl, o) {
    const R = roles(o.tone);
    const size = o.size || U * 3.6;
    const m = marks(o.text);
    const css = { fontSize: px(size), fontWeight: String(o.weight || 500), lineHeight: String(o.lh || 1.3),
      letterSpacing: `${o.ls ?? (isLatin(m.plain) && size >= U * 6 ? -0.02 : 0)}em` };
    if (o.flow) Object.assign(css, { position: 'relative', display: 'inline-block' });
    else Object.assign(css, { left: px(o.x), top: px(o.y) });
    if (o.w) css.width = px(o.w);
    if (o.align) css.textAlign = o.align;
    if (o.font) css.fontFamily = o.font;
    if (o.tnum) css.fontVariantNumeric = 'tabular-nums lining-nums';
    const tf = anchorShift(o.anchor);
    if (tf) css.transform = tf;
    const box = div('sw-t' + (o.wrap ? ' sw-wrap' : ''), parentEl, css);
    box.appendChild(document.createTextNode(m.plain));
    const mask = div('sw-mask', box);
    mask.setAttribute('data-qa', 'ignore');
    const inner = div('sw-in', mask, { color: o.color || R.fg });
    inner.style.setProperty('--sw-signal', o.hi || R.accentText);
    inner.innerHTML = m.html;
    const api = rig(box, mask, inner, R);
    return Object.assign(api, {
      el: box, inner, size,
      color(c) { inner.style.color = c; },
      set(txt) { const mm = marks(txt); if (box.firstChild.nodeValue !== mm.plain) { box.firstChild.nodeValue = mm.plain; inner.innerHTML = mm.html; } },
    });
  }

  // ---------------------------------------------------------------------------------------------
  /** 网格：横屏 12 栏 × 6 行，竖屏 6 栏 × 8 行；左右边距 = max(安全区, 6u)，栏间距 2u；
   *  顶部留 4.5u 的页眉带（folio 放在这里），下沿让开字幕区（竖屏始终让开：下面是字幕和平台按钮）。
   *  opts: cols, rows, margin, gutter, band（页眉带高度）。返回 { cols, rows, cw, rh, left, right, top, bottom, width, height,
   *        x(c), w(n), y(r), h(n), box(c, n, r, m), cx(c, n) }，c、r 从 0 开始，可以是小数 */
  function grid(o = {}) {
    const cols = o.cols || (PORTRAIT ? 6 : 12), rows = o.rows || (PORTRAIT ? 8 : 6);
    const margin = o.margin ?? Math.max(S.safe.x, U * 6), gutter = o.gutter ?? U * 2;
    const topY = S.safe.y + (o.band ?? U * 4.5);
    const bottom = (PORTRAIT || S.captionsOn) ? S.captionZone.y - U * 1.5 : S.safe.y + S.safe.h;
    const left = margin, right = W - margin;
    const cw = (right - left - gutter * (cols - 1)) / cols, rh = (bottom - topY - gutter * (rows - 1)) / rows;
    const x = c => left + c * (cw + gutter), w = n => n * cw + (n - 1) * gutter;
    const y = r => topY + r * (rh + gutter), h = n => n * rh + (n - 1) * gutter;
    return { cols, rows, margin, gutter, cw, rh, left, right, top: topY, bottom, width: right - left, height: bottom - topY,
      band: S.safe.y, portrait: PORTRAIT, x, w, y, h, box: (c, n, r, m) => ({ x: x(c), y: y(r), w: w(n), h: h(m) }), cx: (c, n) => x(c) + w(n) / 2 };
  }

  // ---------------------------------------------------------------------------------------------
  /** 舞台。opts:
   *   tone: 'page'（默认）| 'paper' | 'ink' | 'signal'：整镜底色；
   *   signal: 品牌色（换掉默认瑞士红）；
   *   grid: true（网格线一开始就在）| 'build'（开场生长，gridAt 秒开始，默认 0）| 'cols'（只要竖线）| false（不画）；
   *   gridFrom: [x, y] 网格生长的起点（默认版心左上角），线按离起点的距离依次长出；
   *   cam: 镜头动作 [{ at, dur, s, cx, cy, r }]：在 at 秒用 dur 秒（默认 1）把镜头推到"以 (cx, cy) 为中心、放大 s 倍、旋转 r 度"，
   *        之后停住；不写的字段沿用上一个动作。只在拍点上动，用签名缓动；
   *   cols, rows, margin, gutter：网格参数。
   *  返回 { root, world, hud, G, R, grid: { draw(p), out(p), dim(a) }, set(t) }。grid.draw/out/dim 要在 st.set(t) 之后调用（set 会先按 grid 选项重置网格）。
   *  内容放 world（跟镜头动），页眉、页脚、出处放 hud（固定在屏幕上）。render(t) 第一行调用 st.set(t)。 */
  function stage(o = {}) {
    if (o.signal) theme({ signal: o.signal });
    else theme({});
    stageTone = o.tone || 'page';
    const R = roles(stageTone);
    document.documentElement.style.background = R.bg;
    document.body.style.background = R.bg;
    const root = div('sw-root', null, { background: R.bg, color: R.fg });
    document.body.insertBefore(root, document.body.firstChild);
    const cam = div('sw-world', root);
    const G = grid(o);
    curGrid = G;
    // 网格线（在内容下面，跟镜头动）
    const gsv = S.svg('svg', { class: 'sw-svg', width: W, height: H, viewBox: `0 0 ${W} ${H}` });
    cam.appendChild(gsv);
    const world = div('sw-layer', cam);
    const hud = div('sw-hud', root);
    const mode = o.grid === undefined ? true : o.grid;
    const lines = [];
    if (mode) {
      const [ox, oy] = o.gridFrom || [G.left, G.top];
      const lw = Math.max(1, U * 0.09);
      const add = (x1, y1, x2, y2) => {
        const e = S.svg('line', { x1, y1, x2, y2, stroke: o.gridColor || R.line, 'stroke-width': lw }, gsv);
        const d = Math.hypot((x1 + x2) / 2 - ox, (y1 + y2) / 2 - oy) / Math.hypot(W, H);
        lines.push({ e, d, len: Math.hypot(x2 - x1, y2 - y1) });
      };
      const y1 = G.top, y2 = G.bottom;
      for (let c = 0; c < G.cols; c++) { add(G.x(c), y1, G.x(c), y2); add(G.x(c) + G.cw, y1, G.x(c) + G.cw, y2); }
      if (mode !== 'cols') for (let r = 0; r < G.rows; r++) { add(G.left, G.y(r), G.right, G.y(r)); add(G.left, G.y(r) + G.rh, G.right, G.y(r) + G.rh); }
      lines.forEach(l => l.e.setAttribute('stroke-dasharray', `${l.len} ${l.len}`));
    }
    const maxD = lines.reduce((m, l) => Math.max(m, l.d), 0) || 1;
    let gIn = mode === 'build' ? 0 : 1, gOut = 0, gDim = 1;
    const applyGrid = () => {
      for (const l of lines) {
        const sp = 0.45, rel = l.d / maxD;
        const a = E(clamp((gIn - rel * sp) / (1 - sp))), b = E(clamp((gOut - rel * sp) / (1 - sp)));
        // 线段只显示 [b, a] 这一截：长出来，再从另一头收走
        const vis = Math.max(0, a - b);
        l.e.setAttribute('stroke-dasharray', `0 ${(b * l.len).toFixed(2)} ${(vis * l.len).toFixed(2)} ${(l.len * 2).toFixed(2)}`);
        l.e.setAttribute('visibility', vis > 0.001 ? 'visible' : 'hidden');
      }
      gsv.setAttribute('opacity', gDim);
    };
    const moves = (o.cam || []).slice().sort((a, b) => a.at - b.at);
    const gridApi = {
      draw(p) { gIn = p; applyGrid(); },
      out(p) { gOut = p; applyGrid(); },
      dim(a) { gDim = clamp(a); gsv.setAttribute('opacity', gDim); },
    };
    return {
      root, world, hud, G, R, grid: gridApi, cam,
      set(t) {
        // 每帧让整屏重新栅格化：只重画变化区域时，超大字形（路径渲染）的抗锯齿会和整屏重画略有不同，
        // 同一帧就会因为渲染顺序不同而差几个像素。舞台底色的透明度按帧号变化；html/body 是同一个颜色，叠出来的画面完全不变
        root.style.backgroundColor = rgba(R.bg, 1 - 0.04 * (Math.round(t * S.fps) % 7));
        if (lines.length) {
          gIn = mode === 'build' ? lin(t, o.gridAt || 0, (o.gridAt || 0) + (o.gridDur || T.l * 1.2)) : 1;
          gOut = 0; gDim = 1;
          applyGrid();
        }
        let s = 1, cx = W / 2, cy = H / 2, r = 0;
        for (const m of moves) {
          const k = at(t, m.at, m.at + (m.dur || T.l));
          s = lerp(s, m.s ?? s, k); cx = lerp(cx, m.cx ?? cx, k); cy = lerp(cy, m.cy ?? cy, k); r = lerp(r, m.r ?? r, k);
        }
        cam.style.transform = `translate(${px(W / 2)}, ${px(H / 2)}) rotate(${r.toFixed(3)}deg) scale(${s.toFixed(5)}) translate(${px(-cx)}, ${px(-cy)})`;
      },
    };
  }

  /** 图层：铺满的 div，用来在一镜里换"页"（配合 wipe）。返回 el；el.show(true|false) 每帧都要调用。
   *  用 display 切换：组件内部会显式设置 visibility，只改 visibility 藏不住它们 */
  function layer(parentEl) {
    const e = div('sw-layer', parentEl);
    e.show = on => { e.style.display = on ? 'block' : 'none'; };
    return e;
  }

  /** 色块转场：整屏色块扫过去。opts color（默认信号色）, dir: 'left'|'right'|'up'|'down'（色块前进的方向）。
   *  set(p)：p 从 0 到 0.5 色块盖满画面，0.5 到 1 色块从另一边离开；p ≥ 0.5 时切换下面的图层（返回 true） */
  function wipe(parentEl, o = {}) {
    const e = div('sw-block', parentEl, { left: 0, top: 0, width: px(W), height: px(H), background: o.color || C.signal, visibility: 'hidden', zIndex: 5 });
    const dir = o.dir || 'left';
    return {
      el: e,
      set(p) {
        const a = E(clamp(p / 0.5)), b = E(clamp((p - 0.5) / 0.5));
        e.style.visibility = a > 0 && b < 1 ? 'visible' : 'hidden';
        const lo = (b * 100).toFixed(3), hi = ((1 - a) * 100).toFixed(3);
        // left：从右边进、往左走（显示区间 [1-a, 1-b]）
        e.style.clipPath = { left: `inset(0 ${lo}% 0 ${hi}%)`, right: `inset(0 ${hi}% 0 ${lo}%)`, up: `inset(${hi}% 0 ${lo}% 0)`, down: `inset(${lo}% 0 ${hi}% 0)` }[dir];
        return p >= 0.5;
      },
    };
  }

  // ---------------------------------------------------------------------------------------------
  /** 细线：opts x, y, w（横线）或 h（竖线）, color（默认 rule 色）, weight（默认 0.14u）, from: 'start'|'end'|'center', tone。
   *  draw(p) 沿长度长出；out(p) 从起点一侧收走；color(c) 换颜色 */
  function rule(parentEl, o) {
    const R = roles(o.tone), vert = o.h != null && o.w == null;
    const wt = o.weight || Math.max(1, U * 0.14);
    const e = div('sw-block', parentEl, vert
      ? { left: px(o.x - wt / 2), top: px(o.y), width: px(wt), height: px(o.h) }
      : { left: px(o.x), top: px(o.y - wt / 2), width: px(o.w), height: px(wt) });
    e.style.background = o.color || R.rule;
    const from = o.from || 'start';
    let pi = 0, po = 0;
    const upd = () => {
      const k = E(clamp(pi)), ko = E(clamp(po));
      let a, b;
      if (from === 'end') { a = 1 - k; b = 1 - ko; } else if (from === 'center') { a = 0.5 - 0.5 * k * (1 - ko); b = 0.5 + 0.5 * k * (1 - ko); } else { a = ko; b = k; }
      const s = Math.max(0, b - a);
      e.style.visibility = s > 0.0005 ? 'visible' : 'hidden';
      // 用位置和长度表示长出来的那一截（不用缩放变换，原因同刀切线）
      if (vert) { e.style.top = px(o.y + a * o.h); e.style.height = px(s * o.h); }
      else { e.style.left = px(o.x + a * o.w); e.style.width = px(s * o.w); }
    };
    upd();
    return { el: e, draw(p) { pi = p; upd(); }, out(p) { po = p; upd(); }, cut(p) { po = p; upd(); }, color(c) { e.style.background = c; } };
  }

  /** 色块：opts x, y, w, h, color（默认信号色）, from: 'left'|'right'|'top'|'bottom'（从哪边擦出来）, tone。
   *  draw(p) 擦出；out(p) 继续往前擦掉；cut(p) 刀切塌缩 */
  function block(parentEl, o) {
    const R = roles(o.tone);
    const e = div('sw-block', parentEl, { left: px(o.x), top: px(o.y), width: px(o.w), height: px(o.h), background: o.color || R.accent, visibility: 'hidden' });
    const kn = knifeLine(e, o.knife || (o.color === C.ink ? C.signal : C.ink));
    const from = o.from || 'left';
    let pi = 0, po = 0, pc = 0;
    const upd = () => {
      const k = E(clamp(pi)), ko = E(clamp(po));
      const col = kn.set(pc, 0);
      const hi = (1 - k) * 100, lo = ko * 100, cc = col * 50;
      // [上, 右, 下, 左] 的裁切百分比：擦出/擦掉，再叠加刀切合拢
      const ins = { left: [0, hi, 0, lo], right: [0, lo, 0, hi], top: [lo, 0, hi, 0], bottom: [hi, 0, lo, 0] }[from];
      ins[0] = Math.max(ins[0], cc); ins[2] = Math.max(ins[2], cc);
      e.style.clipPath = `inset(${ins.map(v => v.toFixed(3) + '%').join(' ')})`;
      e.style.visibility = k > ko && col < 0.999 ? 'visible' : 'hidden';
    };
    upd();
    return { el: e, draw(p) { pi = p; upd(); }, out(p) { po = p; upd(); }, cut(p) { pc = p; upd(); }, color(c) { e.style.background = c; } };
  }

  // ---------------------------------------------------------------------------------------------
  /** 一段文字（不带细线）：opts x, y, text, size（默认 3.6u）, weight（500）, color, lh, ls, w + wrap（自动换行）, anchor, align, tone。
   *  draw(p) 从裁切框里升起；out(p)；cut(p)；strike(p)；color(c)；set(text) 换字 */
  function text(parentEl, o) { return textCore(parentEl, o); }

  /** 注释行（瑞士版式的"说明文字"）：上面一条细线，下面一行小字。opts x, y（细线位置）, w（细线宽，也是换行宽）, text,
   *  size（默认 2.4u）, weight（500）, color（默认 sub）, rule（默认 true）, ruleColor, lines（预计行数，用于算 bottom）, tone。
   *  返回 { bottom, draw(p), out(p), cut(p) } */
  function note(parentEl, o) {
    const R = roles(o.tone), size = o.size || small(2.4, 2.8), g = group(parentEl);
    const w = o.w || G0().w(3);
    const r = o.rule !== false ? rule(g, { x: o.x, y: o.y, w, color: o.ruleColor || R.rule, weight: o.ruleWeight || Math.max(1, U * 0.1), tone: o.tone }) : null;
    const ty = o.y + (r ? U * 1.1 : 0);
    const tx = textCore(g, { x: o.x, y: ty, w: o.wrap === false ? undefined : w, wrap: o.wrap !== false, text: o.text, size, weight: o.weight || 500,
      color: o.color || R.sub, lh: o.lh || 1.45, tone: o.tone, ls: o.ls });
    const bottom = ty + size * (o.lh || 1.45) * (o.lines || 1);
    return { el: g, text: tx, rule: r, bottom,
      draw(p) { if (r) r.draw(clamp(p / 0.6)); tx.draw(clamp((p - 0.3) / 0.7)); },
      out(p) { if (r) r.out(p); tx.out(p); }, cut(p) { if (r) r.out(clamp((p - 0.3) / 0.7)); tx.cut(p); } };
  }

  /** 大标题：一行一行从裁切框里升起。opts x, y（第一行上沿）, lines: ['听见', '[安静]本身'], size（默认 11u）, weight（默认 700）,
   *  color, lh（默认 1.16）, ls, anchor, tone, stagger（行间错峰，占进度的比例，默认 0.16）。
   *  返回 { el, lines, bottom（最后一行下沿）, draw(p), out(p), cut(p) }；cut 从上往下依次切 */
  function title(parentEl, o) {
    const R = roles(o.tone), size = o.size || U * 11, lh = o.lh || 1.16, g = group(parentEl);
    const arr = Array.isArray(o.lines) ? o.lines : [o.text];
    const n = arr.length, sg = o.stagger ?? 0.16;
    const ls = arr.map((s, i) => textCore(g, { x: o.x, y: o.y + i * size * lh, text: s, size, weight: o.weight || 700, color: o.color || R.fg,
      lh, ls: o.ls, anchor: o.anchor, tone: o.tone, hi: o.hi }));
    const sub = (p, i) => clamp(p * (1 + sg * (n - 1)) - sg * i);
    return { el: g, lines: ls, size, bottom: o.y + n * size * lh,
      draw(p) { ls.forEach((l, i) => l.draw(sub(p, i))); },
      out(p) { ls.forEach((l, i) => l.out(sub(p, i))); },
      cut(p) { ls.forEach((l, i) => l.cut(sub(p, i))); } };
  }

  /** 页面标题：细线 + 编号 + 小标题 + 标题，齐左放在版心顶部。opts text（标题，可以用 [ ] 标信号色）, kicker（小标题）, index（编号，如 '02'）,
   *  x（默认 G.left）, y（默认 G.top）, w（细线宽，默认整个版心）, size（默认横屏 6u、竖屏 6.6u）, tone。
   *  返回 { bottom（下面的内容从这里往下排）, draw(p), out(p), cut(p) } */
  function heading(parentEl, o) {
    const G = G0(), R = roles(o.tone), g = group(parentEl);
    const x = o.x ?? G.left, y = o.y ?? G.top, w = o.w ?? G.width;
    const size = o.size || U * (PORTRAIT ? 6.6 : 6), ks = small(2.2, 2.6);
    const r = rule(g, { x, y, w, tone: o.tone });
    const ky = y + U * 1.2;
    const idx = o.index ? textCore(g, { x, y: ky, text: o.index, size: ks, weight: 700, color: R.accentText, lh: 1.3, tone: o.tone }) : null;
    const kick = o.kicker ? textCore(g, { x: idx ? x + G.cw + G.gutter : x, y: ky, text: o.kicker, size: ks, weight: 600, color: R.fg, lh: 1.3, tone: o.tone }) : null;
    const hy = ky + ((idx || kick) ? ks * 1.3 + U * 1.6 : U * 0.6);
    const lines = Array.isArray(o.text) ? o.text : [o.text];
    const tt = title(g, { x, y: hy, lines, size, weight: o.weight || 700, lh: 1.2, tone: o.tone, stagger: 0.12 });
    return { el: g, bottom: tt.bottom + U * 2.6, title: tt,
      draw(p) { r.draw(clamp(p / 0.55)); if (idx) idx.draw(clamp((p - 0.12) / 0.5)); if (kick) kick.draw(clamp((p - 0.2) / 0.5)); tt.draw(clamp((p - 0.3) / 0.7)); },
      out(p) { r.out(p); if (idx) idx.out(p); if (kick) kick.out(p); tt.out(p); },
      cut(p) { r.out(clamp((p - 0.4) / 0.6)); if (idx) idx.cut(p); if (kick) kick.cut(p); tt.cut(p); } };
  }

  /** 页眉（放 st.hud）：版心顶部一条发丝线，线下一行小字，按栏位排开（和注释行一样"线在上、字在下"）。
   *  opts items: [[栏, '文字'], ...]（某一项写成 [栏, '01 / 05', 'end'] 就右对齐到版心右沿）, y（默认安全区上沿）, size（1.8u）, rule（默认 true）, tone。
   *  draw(p)；out(p) */
  function folio(parentEl, o) {
    const G = G0(), R = roles(o.tone), size = o.size || small(1.8, 2.2), g = group(parentEl);
    const y = o.y ?? S.safe.y;
    const r = o.rule !== false ? rule(g, { x: G.left, y, w: G.width, weight: Math.max(1, U * 0.09), tone: o.tone }) : null;
    const ts = (o.items || []).map(([c, s, al]) => textCore(g, { x: al === 'end' ? G.right : G.x(c), y: y + U * 0.9, text: s, size, weight: 600, lh: 1.3,
      color: R.fg, anchor: al === 'end' ? 'end' : 'start', ls: isLatin(marks(s).plain) ? 0.04 : 0.02, tone: o.tone }));
    return { el: g,
      draw(p) { if (r) r.draw(clamp(p / 0.7)); ts.forEach((t, i) => t.draw(clamp((p - 0.15 - i * 0.08) / 0.55))); },
      out(p) { if (r) r.out(p); ts.forEach(t => t.out(p)); } };
  }

  /** 脚注（放 st.hud）：版心左下角一行小字，写数据的测得条件、"示例数据"、"价格以实际为准"等。opts text, x, y, anchor, size（1.7u）, tone。draw(p) */
  function footnote(parentEl, o) {
    const G = G0(), R = roles(o.tone), size = o.size || small(1.7, 2.2);
    return textCore(parentEl, { x: o.x ?? (o.anchor === 'end' ? G.right : G.left), y: o.y ?? (G.bottom - size * 1.35), text: o.text, size, weight: 500,
      color: o.color || R.sub, lh: 1.35, anchor: o.anchor, tone: o.tone });
  }

  // ---------------------------------------------------------------------------------------------
  /** 数字翻牌：每一位数字在自己的裁切窗里竖向滚动到目标值，从左到右依次停住。
   *  opts x, y（上沿）, value: '48' | '5.2' | '1,299'（非数字字符原样显示）, from（起始数字，位数相同；默认全 0）,
   *       size（默认 16u）, weight（默认 700）, color, lh（默认 1）, ls（默认 -0.02em）, prefix（如 '¥'，默认抬到大写高度）, preTop（false 放基线上）,
   *       unit（如 'dB'、'小时'）, unitSize（默认 0.3em）, spin（低位多转几圈，默认 0）, stagger（位间错峰，默认 0.07）, anchor, tone。
   *  draw(p)：前 40% 升起，之后滚动到位；out(p)；cut(p)；strike(p)；color(c) */
  function numeral(parentEl, o) {
    const R = roles(o.tone), size = o.size || U * 16, lh = o.lh || 1;
    const value = String(o.value), from = o.from != null ? String(o.from) : value.replace(/\d/g, '0');
    const color = o.color || R.fg;
    const lsv = o.ls ?? -0.02;
    const css = { fontSize: px(size), fontWeight: String(o.weight || 700), lineHeight: String(lh), letterSpacing: `${lsv}em`, fontKerning: 'none' };
    if (o.flow) Object.assign(css, { position: 'relative', display: 'inline-block' }); else Object.assign(css, { left: px(o.x), top: px(o.y) });
    const tf = anchorShift(o.anchor);
    if (tf) css.transform = tf;
    const box = div('sw-num', parentEl, css);
    const ps = o.preSize || 0.42, us = o.unitSize || 0.3;
    const preCss = { fontSize: `${ps}em`, verticalAlign: o.preTop === false ? 'baseline' : `${(0.727 * (1 - ps) / ps).toFixed(3)}em`, marginRight: '0.08em',
      letterSpacing: '0', fontWeight: String(o.preWeight || 600) };
    const unitCss = { fontSize: `${us}em`, marginLeft: o.unitGap || '0.16em', letterSpacing: '0.01em', fontWeight: String(o.unitWeight || 600) };
    if (o.prefix) span(box, o.prefix, preCss);
    // 外层排版框和可见层的结构保持一致（"1" 带同样的边距），两者宽度才相同
    value.split(/(1)/).forEach(part => { if (part === '1') span(box, '1', { margin: '0 0.035em' }); else if (part) box.appendChild(document.createTextNode(part)); });
    if (o.unit) span(box, o.unit, unitCss);
    const mask = div('sw-mask', box);
    mask.setAttribute('data-qa', 'ignore');
    const inner = div('sw-in', mask, { color });
    if (o.prefix) span(inner, o.prefix, preCss);
    const cols = [];
    const digits = Array.from(value).filter(ch => /\d/.test(ch)).length;
    let di = 0;
    Array.from(value).forEach((ch, i) => {
      if (!/\d/.test(ch)) { inner.appendChild(document.createTextNode(ch)); return; }
      const col = span(inner, null, null, 'sw-col');
      // overflow: hidden 的行内块以框底为基线：按 Inter 的字体度量（升部 0.969em、降部 0.241em）把它降回文字基线
      col.style.verticalAlign = `${(-(lh - ((lh - 1.2105) / 2 + 0.96875))).toFixed(4)}em`;
      span(col, ch, null, 'sw-col-sizer');   // 列宽取目标数字本身（比例数字），停住后和普通排版一样
      // 字距放到列外面（负的右边距），列宽正好等于字宽，裁切框不会削掉字形边缘；
      // 分列后字偶距不起作用，"11" 会贴在一起：给 1 两边补一点边距
      const one = ch === '1' ? 0.035 : 0;
      Object.assign(col.style, { letterSpacing: '0', marginLeft: `${one}em`, marginRight: `${(lsv + one).toFixed(4)}em` });
      const strip = span(col, null, null, 'sw-strip');
      const f = /\d/.test(from[i] || '') ? +from[i] : 0, d = +ch;
      const turns = (o.spin || 0) * (digits - 1 - di);
      const travel = ((d - f + 10) % 10) + 10 * turns;
      for (let k = 0; k <= travel; k++) span(strip, String((f + k) % 10), { height: `${lh}em`, lineHeight: String(lh) });
      cols.push({ strip, travel, i: di++ });
    });
    if (o.unit) span(inner, o.unit, unitCss);
    const sg = o.stagger ?? 0.07, n = cols.length;
    const api = rig(box, mask, inner, R, st => {
      const p = clamp(st.p);
      for (const c of cols) {
        const span0 = Math.max(0.2, 0.82 - sg * (n - 1));
        const q = o.roll === false ? 1 : E(clamp((p - 0.18 - c.i * sg) / span0));
        // 位移取整到像素：小数像素的停留位置在"连续变换很多帧之后"和"新页面直接渲染"时栅格化结果不同
        c.strip.style.transform = `translateY(${-Math.round(q * c.travel * lh * size)}px)`;
      }
    });
    api.refresh();
    return Object.assign(api, { el: box, inner, size, color(c) { inner.style.color = c; } });
  }

  // ---------------------------------------------------------------------------------------------
  /** 卖点列表。opts x, y（第一条细线位置）, w, items: [{ no: '01', title: '深度降噪', value: '48', unit: 'dB', note: '一句说明' }],
   *  layout: 'cols'（并排模块，配大数字，默认）| 'rows'（逐行，适合没有数字的卖点）, gap（cols 时模块间距，默认一个栏间距）,
   *  size（数字字号，默认 cols 15u、rows 5u）, titleSize（默认 4.2u）, rowH（rows 时每行高，默认 10u）, tone。
   *  返回 { items: [{ draw(p), cut(p), out(p) }], bottom, draw(p)（全部依次入场）, focus(q)（信号色指针移到第 q 条，q 可以是小数，<0 隐藏） } */
  function list(parentEl, o) {
    const G = G0(), R = roles(o.tone), g = group(parentEl);
    const items = o.items || [], n = items.length, mode = o.layout || 'cols';
    const x = o.x ?? G.left, y = o.y ?? G.top, w = o.w ?? G.width;
    const ts = o.titleSize || U * 4.2;
    const out = [];
    let mw = w, mh = 0, step = 0;
    if (mode === 'cols') {
      const gap = o.gap ?? G.gutter;
      mw = (w - gap * (n - 1)) / n; step = mw + gap;
      const vs = o.size || U * 15;
      items.forEach((it, i) => {
        const mx = x + i * step;
        const r = rule(g, { x: mx, y, w: mw, tone: o.tone });
        const no = textCore(g, { x: mx, y: y + U * 1.3, text: it.no || String(i + 1).padStart(2, '0'), size: U * 2.2, weight: 700, color: R.sub, lh: 1.3, tone: o.tone });
        let yy = y + U * 6;
        const num = it.value != null ? numeral(g, { x: mx, y: yy, value: it.value, unit: it.unit, prefix: it.prefix, size: vs, tone: o.tone, from: it.from }) : null;
        if (num) yy += vs * 1.0 + U * 1.6;
        const tt = textCore(g, { x: mx, y: yy, text: it.title, size: ts, weight: 700, lh: 1.25, tone: o.tone });
        yy += ts * 1.25 + U * 0.9;
        const nt = it.note ? textCore(g, { x: mx, y: yy, w: mw - G.gutter, wrap: true, text: it.note, size: U * 2.6, weight: 500, color: R.sub, lh: 1.5, tone: o.tone }) : null;
        mh = Math.max(mh, yy - y + (nt ? U * 2.6 * 1.5 : 0));
        out.push({ rule: r, no, num, title: tt, note: nt, x: mx, y,
          draw(p) { r.draw(clamp(p / 0.45)); no.draw(clamp((p - 0.08) / 0.4)); if (num) num.draw(clamp((p - 0.12) / 0.88)); tt.draw(clamp((p - 0.3) / 0.45)); if (nt) nt.draw(clamp((p - 0.42) / 0.45)); },
          out(p) { r.out(p); no.out(p); if (num) num.out(p); tt.out(p); if (nt) nt.out(p); },
          cut(p) { r.out(clamp((p - 0.35) / 0.65)); no.cut(p); if (num) num.cut(p); tt.cut(p); if (nt) nt.cut(p); } });
      });
    } else {
      const rh = o.rowH || U * 10; step = rh; mh = rh * n;
      const vs = o.size || U * 5;
      items.forEach((it, i) => {
        const ry = y + i * rh;
        const r = rule(g, { x, y: ry, w, tone: o.tone });
        const mid = h0 => ry + (rh - h0) / 2;   // 每一项在行里垂直居中
        const no = textCore(g, { x, y: mid(U * 2.2 * 1.3), text: it.no || String(i + 1).padStart(2, '0'), size: U * 2.2, weight: 700, color: R.sub, lh: 1.3, tone: o.tone });
        const tx = x + Math.min(G.cw + G.gutter, w * 0.14);
        const tt = textCore(g, { x: tx, y: mid(ts * 1.25), text: it.title, size: ts, weight: 700, lh: 1.25, tone: o.tone });
        const nx = x + w * (o.noteAt ?? 0.5), ns = small(2.6, 2.8);
        const nt = it.note ? textCore(g, { x: nx, y: mid(ns * 1.5), w: (it.value != null ? w * 0.3 : x + w - nx), wrap: true, text: it.note, size: ns, weight: 500, color: R.sub, lh: 1.5, tone: o.tone }) : null;
        const num = it.value != null ? numeral(g, { x: x + w, y: mid(vs), value: it.value, unit: it.unit, prefix: it.prefix, size: vs, anchor: 'end', tone: o.tone, from: it.from }) : null;
        out.push({ rule: r, no, num, title: tt, note: nt, x, y: ry,
          draw(p) { r.draw(clamp(p / 0.5)); no.draw(clamp((p - 0.1) / 0.45)); tt.draw(clamp((p - 0.18) / 0.5)); if (nt) nt.draw(clamp((p - 0.35) / 0.5)); if (num) num.draw(clamp((p - 0.25) / 0.75)); },
          out(p) { r.out(p); no.out(p); tt.out(p); if (nt) nt.out(p); if (num) num.out(p); },
          cut(p) { r.out(clamp((p - 0.35) / 0.65)); no.cut(p); tt.cut(p); if (nt) nt.cut(p); if (num) num.cut(p); } });
      });
    }
    // 信号色指针：压在当前这一条的细线上
    const ptrH = Math.max(2, U * 0.55);
    const ptr = div('sw-block', g, { left: px(x), top: px(y - ptrH / 2), width: px(mw), height: px(ptrH), background: R.accent, visibility: 'hidden' });
    return { el: g, items: out, bottom: y + mh, step,
      draw(p) { out.forEach((it, i) => it.draw(clamp(p * (1 + 0.5 * (n - 1)) - 0.5 * i))); },
      focus(q, grow = 1) {
        // 每帧都要调用（q < 0 隐藏），所有状态都在这里重新设置
        const on = q >= 0 && grow > 0;
        const k = on ? E(clamp(grow)) : 0, off = clamp(on ? q : 0, 0, n - 1) * step;
        ptr.style.visibility = on ? 'visible' : 'hidden';
        ptr.style.left = px(x + (mode === 'cols' ? off : 0));
        ptr.style.top = px(y - ptrH / 2 + (mode === 'cols' ? 0 : off));
        ptr.style.width = px(mw * k);
        out.forEach((it, i) => it.no.color(on && Math.abs(q - i) < 0.5 ? R.accentText : R.sub));
      } };
  }

  /** 规格参数表：每行"细线 + 参数名 + 数值（会翻牌）+ 单位 + 备注"。opts x, y, w, rows: [{ k: '重量', v: '5.2', unit: 'g', note: '单耳', was: '5.8' }],
   *  rowH（默认 8u）, keyW（参数名栏宽，默认 w 的 0.36）, size（数值字号，默认 4.6u）, tone。
   *  v 是纯数字（可带小数点、逗号）时会翻牌；写了 was 时先显示旧值，swap(p) 把旧值刀切掉、换成新值。
   *  返回 { rows: [{ draw(p), swap(p), cut(p) }], bottom, draw(p)（逐行依次入场，最后画收尾线）, focus(i, p)（第 i 行变成信号色，i<0 取消） } */
  function specs(parentEl, o) {
    const G = G0(), R = roles(o.tone), g = group(parentEl);
    const x = o.x ?? G.left, y = o.y ?? G.top, w = o.w ?? G.width;
    const rh = o.rowH || U * 8, kw = w * (o.keyW ?? 0.36), vs = o.size || U * 4.6;
    const numeric = s => /^[\d.,]+$/.test(String(s));
    const mkVal = (v, unit, yy, from) => (numeric(v)
      ? numeral(g, { x: x + kw, y: yy, value: v, unit, size: vs, weight: 600, ls: -0.02, unitSize: 0.48, unitGap: '0.22em', tone: o.tone, from })
      : textCore(g, { x: x + kw, y: yy, text: unit ? `${v} ${unit}` : v, size: vs, weight: 600, lh: 1, tone: o.tone }));
    const rows = (o.rows || []).map((rw, i) => {
      const ry = y + i * rh;
      const r = rule(g, { x, y: ry, w, weight: Math.max(1, U * 0.12), tone: o.tone });
      const k = textCore(g, { x, y: ry + (rh - U * 2.6 * 1.3) / 2, text: rw.k, size: U * 2.6, weight: 500, color: R.sub, lh: 1.3, tone: o.tone });
      const vy = ry + (rh - vs) / 2;
      const was = rw.was != null ? mkVal(rw.was, rw.unit, vy) : null;
      const val = mkVal(rw.v, rw.unit, vy, rw.from);
      const nt = rw.note ? textCore(g, { x: x + w, y: ry + (rh - U * 2.2 * 1.3) / 2, text: rw.note, size: U * 2.2, weight: 500, color: R.sub, lh: 1.3, anchor: 'end', tone: o.tone }) : null;
      const bar = div('sw-block', g, { left: px(x), top: px(ry - U * 0.25), width: '0px', height: px(U * 0.5), background: R.accent, visibility: 'hidden' });
      return { rule: r, key: k, value: val, was, note: nt, bar,
        draw(p) { r.draw(clamp(p / 0.5)); k.draw(clamp((p - 0.12) / 0.45)); (was || val).draw(clamp((p - 0.2) / 0.8)); if (nt) nt.draw(clamp((p - 0.3) / 0.45)); },
        swap(p) { if (!was) return; was.cut(clamp(p / 0.55)); val.draw(clamp((p - 0.45) / 0.55)); },
        cut(p) { r.out(clamp((p - 0.35) / 0.65)); k.cut(p); val.cut(p); if (was) was.cut(p); if (nt) nt.cut(p); } };
    });
    const n = rows.length;
    const end = rule(g, { x, y: y + n * rh, w, weight: Math.max(1, U * 0.12), tone: o.tone });
    return { el: g, rows, bottom: y + n * rh,
      draw(p) { rows.forEach((r, i) => r.draw(clamp(p * (1 + 0.22 * (n - 1)) - 0.22 * i))); end.draw(clamp((p - 0.7) / 0.3)); },
      focus(i, p = 1) {
        rows.forEach((r, j) => {
          const on = j === i && p > 0;
          r.bar.style.visibility = on ? 'visible' : 'hidden';
          r.bar.style.width = px(w * (on ? E(clamp(p)) : 0));
          r.value.color(on && p > 0.4 ? R.accentText : R.fg);
        });
      } };
  }

  // ---------------------------------------------------------------------------------------------
  /** 产品图框：遮罩揭示 + 轻微推近。opts x, y, w, h（框的位置，按网格取）, src（'/input/产品.png'；不传显示占位框）,
   *   mode: 'cutout'（透明底抠图，默认：放在色块上，object-fit: contain）| 'photo'（带背景的照片：铺满裁切，object-fit: cover）,
   *   bg: cutout 底下的色块 'paper'（默认）| 'page' | 'ink' | 'signal' | 'none' | 任意色值,
   *   pad（cutout 留边，占框宽高的比例，默认 0.1）, pos（object-position，默认 '50% 50%'，照片可以用它对准主体）,
   *   over（cutout 冲出色块上沿的比例，默认 0：比如 0.15 表示产品可以高出色块 15%）, mono（照片转黑白，让信号色成为唯一彩色）,
   *   from: 'bottom'（默认）| 'top' | 'left' | 'right'（揭示方向）, zoom: [起, 止]（推近，默认 [1, 1.05]）, label（占位框文字）。
   *  图片在加载时按需要的分辨率一次性转成位图再缩放，所以 PNG、JPG、SVG 都能稳定地逐帧渲染；SVG 文件要写 width 和 height。
   *  返回 { el, img, draw(p)（揭示）, push(q)（推近，q 线性 0～1，通常从揭示开始到镜尾）, cut(p), out(p) } */
  function product(parentEl, o) {
    const R = roles(o.tone), mode = o.mode || 'cutout', over = mode === 'cutout' ? (o.over || 0) : 0;
    const from = o.from || 'bottom', zoom = o.zoom || [1, 1.05];
    const fy = o.y - over * o.h, fh = o.h * (1 + over);
    const frame = div('sw-frame', parentEl, { left: px(o.x), top: px(fy), width: px(o.w), height: px(fh), overflow: 'visible' });
    const bgc = { paper: C.paper, page: C.page, ink: C.ink, signal: C.signal, none: 'transparent' }[o.bg || (mode === 'cutout' ? 'paper' : 'none')] ?? o.bg;
    const plate = div('sw-block', frame, { left: 0, top: px(over * o.h), width: px(o.w), height: px(o.h), background: bgc });
    // 图片的裁切框：揭示和刀切都改它的位置和大小（overflow: hidden），holder 反向偏移让图片本身不动
    const clip = div('sw-frame', frame, { left: 0, top: 0, width: px(o.w), height: px(fh) });
    const holder = div('sw-ph', clip, { left: 0, top: 0, width: px(o.w), height: px(fh) });
    let img = null;
    if (o.src) {
      // 图片在加载时按"最大推近倍数"一次性栅格化成 PNG，再交给普通 <img> 显示，之后只缩放这张位图：
      //   - 直接缩放 SVG 图片，栅格缓存会让同一帧在不同渲染顺序下有细微差异；
      //   - 直接显示 canvas 会被单独合成成一层，叠在它上面的元素的合成方式也会随渲染历史变化。
      const pad = mode === 'photo' ? 0 : (o.pad ?? 0.1);
      const bx = o.w * pad, by = mode === 'photo' || over > 0 ? 0 : o.h * pad;
      const bw = o.w * (1 - 2 * pad), bh = fh - by - (mode === 'photo' ? 0 : o.h * pad);
      const k = Math.min(2, Math.max(zoom[0], zoom[1]) * (mode === 'photo' ? 1.06 : 1) * (o.res || 1));
      const shown = document.createElement('img');
      shown.alt = '';
      Object.assign(shown.style, { position: 'absolute', left: px(bx), top: px(by), width: px(bw), height: px(bh), visibility: 'hidden' });
      if (o.mono) shown.style.filter = 'grayscale(1) contrast(1.06)';
      holder.appendChild(shown);
      img = new Image();
      img.src = o.src;
      const kw = { left: 0, center: 0.5, right: 1, top: 0, bottom: 1 };
      const pos = String(o.pos || (mode === 'cutout' && over > 0 ? '50% 100%' : '50% 50%')).trim().split(/\s+/)
        .map(v => (v in kw ? kw[v] : parseFloat(v) / 100));
      const [fx, fy] = [pos[0] ?? 0.5, pos[1] ?? pos[0] ?? 0.5];
      S.waits.push(img.decode().then(() => {
        const iw = img.naturalWidth || bw, ih = img.naturalHeight || bh;
        const sc = mode === 'photo' ? Math.max(bw / iw, bh / ih) : Math.min(bw / iw, bh / ih);
        const dw = iw * sc, dh = ih * sc;
        const cv = document.createElement('canvas');
        cv.width = Math.ceil(bw * k); cv.height = Math.ceil(bh * k);
        const ctx = cv.getContext('2d');
        ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, (bw - dw) * fx * k, (bh - dh) * fy * k, dw * k, dh * k);
        shown.src = cv.toDataURL('image/png');
        return shown.decode();
      }).then(() => { shown.style.visibility = ''; }).catch(() => { shown.src = o.src; shown.style.objectFit = mode === 'photo' ? 'cover' : 'contain'; shown.style.visibility = ''; }));
    } else {
      // 占位框：对角线 + 说明，提示这里要放产品图
      const sv = S.svg('svg', { class: 'sw-svg', width: o.w, height: o.h, viewBox: `0 0 ${o.w} ${o.h}` });
      sv.style.top = px(over * o.h);
      holder.appendChild(sv);
      const lc = rgba(C.ink, 0.25), lw = Math.max(1, U * 0.1);
      S.svg('line', { x1: 0, y1: 0, x2: o.w, y2: o.h, stroke: lc, 'stroke-width': lw }, sv);
      S.svg('line', { x1: o.w, y1: 0, x2: 0, y2: o.h, stroke: lc, 'stroke-width': lw }, sv);
      const lb = div('sw-t', holder, { left: px(U * 1.6), top: px(over * o.h + o.h - U * 4), fontSize: px(U * 1.8), fontWeight: '600', color: C.grey, visibility: 'visible' });
      lb.textContent = o.label || '产品图';
      lb.setAttribute('data-qa', 'ignore');
    }
    const kn = knifeLine(frame, R.knife);
    kn.el.style.top = px(over * o.h + o.h / 2);
    let pi = 0, po = 0, pc = 0, pq = 0;
    const upd = () => {
      const col = kn.set(pc, 0), ko = E(clamp(po));
      // 色块先擦出，图片稍晚从同一方向升起（cutout）；照片：框和图一起揭示，图片反向微移
      const kb = E(clamp(pi / (mode === 'cutout' ? 0.6 : 1)));
      const ki = E(clamp((pi - (mode === 'cutout' ? 0.25 : 0)) / (mode === 'cutout' ? 0.75 : 1)));
      // 刀切：整个图框向刀线合拢；退场：从下往上收（都是距离框上沿、下沿的像素）
      const kY = over * o.h + o.h / 2;
      const ct = col * kY, cb = Math.max(col * (fh - kY), ko * fh);
      // 底板是纯色块，用 clip-path 擦出
      const rb = 1 - kb, ins = [0, 0, 0, 0];   // 上 右 下 左（像素）
      if (from === 'bottom') ins[0] = rb * o.h; else if (from === 'top') ins[2] = rb * o.h; else if (from === 'left') ins[1] = rb * o.w; else ins[3] = rb * o.w;
      ins[0] = Math.max(ins[0], ct - over * o.h); ins[2] = Math.max(ins[2], cb);
      plate.style.clipPath = `inset(${ins.map(v => px(Math.max(0, v))).join(' ')})`;
      // 图片：裁切框几何
      let x0 = 0, x1 = o.w, y0 = 0, y1 = fh;
      if (mode === 'photo') {
        const ri = 1 - ki;
        if (from === 'bottom') y0 = ri * fh; else if (from === 'top') y1 = fh - ri * fh; else if (from === 'left') x1 = o.w - ri * o.w; else x0 = ri * o.w;
      }
      y0 = Math.max(y0, ct); y1 = Math.min(y1, fh - cb);
      Object.assign(clip.style, { left: px(x0), top: px(y0), width: px(Math.max(0, x1 - x0)), height: px(Math.max(0, y1 - y0)) });
      holder.style.left = px(-x0); holder.style.top = px(-y0);
      const dir = { bottom: [0, 1], top: [0, -1], left: [-1, 0], right: [1, 0] }[from];
      const z = lerp(zoom[0], zoom[1], clamp(pq));
      const mv = mode === 'cutout' ? (1 - ki) * 0.12 : -(1 - ki) * 0.06;   // 比例：cutout 从下方 12% 升起；照片反向 6%
      holder.style.transformOrigin = '50% 60%';
      holder.style.transform = `translate(${(dir[0] * mv * 100).toFixed(3)}%, ${(dir[1] * mv * 100).toFixed(3)}%) scale(${(z * (mode === 'photo' ? 1 + 0.06 * (1 - ki) : 1)).toFixed(5)})`;
      holder.style.visibility = ki > 0 ? 'visible' : 'hidden';
      frame.style.visibility = pi > 0 && col < 0.999 && ko < 0.999 ? 'visible' : 'hidden';
    };
    upd();
    return { el: frame, img, draw(p) { pi = p; upd(); }, push(q) { pq = q; upd(); }, cut(p) { pc = p; upd(); }, out(p) { po = p; upd(); } };
  }

  // ---------------------------------------------------------------------------------------------
  /** 价格卡：标签 + 原价（划掉）+ 到手价（翻牌）+ 说明。opts x, y, w, label（如 '周年庆到手价'）, was（'1299'）, now（'999'）,
   *   currency（默认 '¥'）, suffix（如 '起'）, note（如 '10.24—10.31'）, size（到手价字号，默认 18u）, color（到手价颜色，默认 accentText）, tone。
   *  返回 { bottom, draw(p)（标签和原价）, strike(p)（划掉原价）, reveal(p)（到手价翻牌 + 说明）, cut(p) } */
  function price(parentEl, o) {
    const G = G0(), R = roles(o.tone), g = group(parentEl), size = o.size || U * 18;
    const w = o.w || G.w(4);
    const lb = note(g, { x: o.x, y: o.y, w, text: o.label || '到手价', size: U * 2.6, weight: 600, color: R.fg, tone: o.tone });
    let yy = lb.bottom + U * 1.4;
    const ws = U * 4.2;
    const was = o.was != null ? textCore(g, { x: o.x, y: yy, text: `${o.wasLabel ?? '原价'} ${o.currency ?? '¥'}${o.was}`, size: ws, weight: 500, color: R.sub, lh: 1.15, tone: o.tone }) : null;
    if (was) yy += ws * 1.15 + U * 0.8;
    const now = numeral(g, { x: o.x, y: yy, value: o.now, prefix: o.currency ?? '¥', unit: o.suffix, size, weight: 800, color: o.color || R.accentText, tone: o.tone, from: o.from, unitSize: 0.24 });
    yy += size + U * 1.2;
    const nt = o.note ? textCore(g, { x: o.x, y: yy, text: o.note, size: U * 2.6, weight: 600, color: R.fg, lh: 1.3, tone: o.tone }) : null;
    return { el: g, bottom: yy + (nt ? U * 2.6 * 1.3 : 0), was, now,
      draw(p) { lb.draw(clamp(p / 0.7)); if (was) was.draw(clamp((p - 0.3) / 0.7)); },
      strike(p) { if (was) was.strike(p); },
      reveal(p) { now.draw(p); if (nt) nt.draw(clamp((p - 0.5) / 0.5)); },
      cut(p) { lb.cut(p); if (was) was.cut(p); now.cut(p); if (nt) nt.cut(p); } };
  }

  /** 行动号召：一块实色矩形 + 文字 + 箭头，下面可以加一行小字（网址、搜索词）。opts x, y, w（默认 4 栏）, h（默认 8u）, text, sub,
   *   color（块颜色，默认信号色；放在信号色底上时默认黑色）, tone。
   *  返回 { draw(p), pulse(t, from, bpm)（from 秒以后箭头每两拍向前点一下，停留期保持画面有动静；每帧都调用）, cut(p) } */
  function cta(parentEl, o) {
    const G = G0(), R = roles(o.tone), g = group(parentEl);
    const w = o.w || G.w(4), h = o.h || U * 8;
    const bg = o.color || (R.tone === 'signal' ? C.ink : C.signal), fg = pickInk(bg);
    const b = block(g, { x: o.x, y: o.y, w, h, color: bg, from: 'left' });
    const fs = o.size || h * 0.36;
    const tx = textCore(g, { x: o.x + h * 0.36, y: o.y + (h - fs * 1.25) / 2, text: o.text, size: fs, weight: 700, color: fg, lh: 1.25, tone: bg === C.signal ? 'signal' : 'ink' });
    const aw = h * 0.5, ax = o.x + w - h * 0.36 - aw, ay = o.y + h / 2;
    const sv = S.svg('svg', { class: 'sw-svg', width: W, height: H, viewBox: `0 0 ${W} ${H}` });
    g.appendChild(sv);
    const arrow = S.svg('g', {}, sv);
    const sw = Math.max(1.5, h * 0.06);
    const shaft = S.svg('path', { d: `M ${ax} ${ay} L ${ax + aw} ${ay}`, stroke: fg, 'stroke-width': sw, fill: 'none' }, arrow);
    const head = S.svg('path', { d: `M ${ax + aw - h * 0.17} ${ay - h * 0.17} L ${ax + aw} ${ay} L ${ax + aw - h * 0.17} ${ay + h * 0.17}`, stroke: fg, 'stroke-width': sw, fill: 'none', 'stroke-linejoin': 'miter' }, arrow);
    const sub = o.sub ? textCore(g, { x: o.x, y: o.y + h + U * 1.3, text: o.sub, size: o.subSize || small(2.3, 2.8), weight: 500, color: R.sub, lh: 1.3, tone: o.tone }) : null;
    let pc = 0, nudge = 0, pin = 0;
    const upd = () => {
      S.draw(shaft, clamp((pin - 0.5) / 0.3)); S.draw(head, clamp((pin - 0.7) / 0.3));
      const c = clamp(pc);
      arrow.setAttribute('transform', `translate(${(nudge * U * 1.2).toFixed(2)} 0)`);
      sv.style.visibility = pin > 0.5 && c < 0.4 ? 'visible' : 'hidden';
    };
    return { el: g, bottom: o.y + h + (sub ? U * 1.3 + (o.subSize || small(2.3, 2.8)) * 1.3 : 0),
      draw(p) { pin = p; b.draw(clamp(p / 0.5)); tx.draw(clamp((p - 0.28) / 0.5)); if (sub) sub.draw(clamp((p - 0.5) / 0.5)); upd(); },
      pulse(t, from = 0, bpm = 120) {
        const per = beat(2, bpm), x = t - from, ph = x < 0 ? 0 : (x % per) / per;
        nudge = x < 0 ? 0 : ph < 0.5 ? E(ph / 0.5) : 1 - E((ph - 0.5) / 0.5); upd();
      },
      cut(p) { pc = p; b.cut(p); tx.cut(p); if (sub) sub.cut(p); upd(); } };
  }

  /** Logo 落版：Logo（用户的图片，或者"信号色方块 + 字标"）+ 细线 + 口号 + 网址。
   *  opts x, y（Logo 上沿）, src（'/input/logo.png'；不传就用 text 做字标）, text（字标文字）, h（Logo 高度，默认 9u；字标时是大写字母高度）,
   *   mark（字标左边的信号色方块，默认 true）, tagline, url, w（细线宽，默认 4 栏）, anchor: 'start' | 'middle', plate（Logo 底板：'none' | 'paper' | 'ink'）, tone。
   *  用户 Logo 原样显示：不改色、不拉伸、不加效果；白色 Logo 放在 tone: 'ink' 或 'signal' 的底上。
   *  返回 { bottom, draw(p), cut(p) } */
  function lockup(parentEl, o) {
    const G = G0(), R = roles(o.tone), g = group(parentEl);
    const h = o.h || U * 9, mid = o.anchor === 'middle', w = o.w || G.w(PORTRAIT ? 4 : 4);
    const row = div('sw-g', g, { left: px(o.x), top: px(o.y), display: 'flex', alignItems: 'flex-start', gap: px(h * 0.32), transform: mid ? 'translateX(-50%)' : '' });
    let mark = null, word = null, logo = null, logoMask = null, logoImg = null;
    if (o.src) {
      // 外层占位（决定宽度）→ 裁切框（overflow: hidden，刀切时上下沿合拢）→ 图片（从框底升起）
      logo = div('', row, { position: 'relative', height: px(h), padding: o.plate && o.plate !== 'none' ? px(h * 0.3) : '0',
        background: { paper: C.paper, ink: C.ink }[o.plate] || 'transparent' });
      const sizer = document.createElement('img');
      sizer.src = o.src; sizer.alt = '';
      Object.assign(sizer.style, { display: 'block', height: px(h), width: 'auto', maxWidth: px(o.maxW || G.width), visibility: 'hidden' });
      logo.appendChild(sizer);
      logoMask = div('sw-frame', logo, { left: 0, right: 0, top: 0, bottom: 0 });
      logoImg = document.createElement('img');
      logoImg.src = o.src; logoImg.alt = '';
      const pad = o.plate && o.plate !== 'none' ? px(h * 0.3) : '0px';
      Object.assign(logoImg.style, { position: 'absolute', left: pad, top: pad, height: px(h), width: 'auto', maxWidth: px(o.maxW || G.width) });
      logoMask.appendChild(logoImg);
    } else {
      const fsz = h / 0.727;
      if (o.mark !== false) mark = div('', row, { position: 'relative', width: px(h), height: px(h), background: R.accent, flex: 'none' });
      word = textCore(row, { flow: true, text: o.text || 'BRAND', size: fsz, weight: 800, lh: 1, ls: -0.035, tone: o.tone });
      word.el.style.marginTop = px(-0.137 * fsz);
    }
    const ry = o.y + h + (o.src && o.plate && o.plate !== 'none' ? h * 0.6 : 0) + U * 3;
    const r = rule(g, { x: mid ? o.x - w / 2 : o.x, y: ry, w, tone: o.tone, from: mid ? 'center' : 'start' });
    const ts = o.tagSize || U * 3.8;
    const tg = o.tagline ? textCore(g, { x: o.x, y: ry + U * 1.8, text: o.tagline, size: ts, weight: 700, lh: 1.25, anchor: mid ? 'middle' : 'start', tone: o.tone }) : null;
    const uy = ry + U * 1.8 + (tg ? ts * 1.25 + U * 0.9 : 0);
    const url = o.url ? textCore(g, { x: o.x, y: uy, text: o.url, size: small(2.3, 2.8), weight: 500, color: R.sub, lh: 1.3, anchor: mid ? 'middle' : 'start', tone: o.tone }) : null;
    let pi = 0, pc = 0;
    const upd = () => {
      const km = E(clamp(pi / 0.35)), kl = E(clamp((pi - 0.1) / 0.45)), c = clamp(pc);
      const col = E(clamp((c - 0.3) / 0.45));
      const cc = (col * 50).toFixed(3);
      if (mark) { mark.style.clipPath = `inset(${Math.max((1 - km) * 100, col * 50).toFixed(3)}% 0 ${cc}% 0)`; mark.style.visibility = km > 0 && col < 0.999 ? 'visible' : 'hidden'; }
      if (logo) {
        const lh2 = h * (o.plate && o.plate !== 'none' ? 1.6 : 1);
        logoMask.style.top = logoMask.style.bottom = px(col * lh2 / 2);
        logoImg.style.transform = `translateY(${px((1 - kl) * lh2 - col * lh2 / 2)})`;
        logo.style.visibility = kl > 0 && col < 0.999 ? 'visible' : 'hidden';
        logoMask.style.visibility = logo.style.visibility;
      }
      if (word) { word.draw(clamp((pi - 0.12) / 0.45)); word.cut(c); }
      r.draw(clamp((pi - 0.4) / 0.4)); r.out(clamp((c - 0.3) / 0.7));
      if (tg) { tg.draw(clamp((pi - 0.5) / 0.4)); tg.cut(c); }
      if (url) { url.draw(clamp((pi - 0.62) / 0.38)); url.cut(c); }
    };
    upd();
    return { el: g, bottom: uy + (url ? U * 3 : 0), draw(p) { pi = p; upd(); }, cut(p) { pc = p; upd(); } };
  }

  // 字体：Inter 是网页字体，渲染前要先加载好（运行时会等 SLATE.waits）
  if (document.fonts && document.fonts.load) {
    S.waits.push(Promise.all([document.fonts.load('700 40px "Inter"', '0123456789'), document.fonts.load('500 20px "Inter"', 'ABC')]).catch(() => null));
  }

  window.SW = { C, U, E, T, bezier, lin, at, beat, contrast, pickInk, rgba, theme, roles, grid, stage, layer, wipe,
    rule, block, text, note, title, heading, folio, footnote, numeral, list, specs, product, price, cta, lockup };
})();
