/* 编辑图解组件（依赖 SLATE 运行时）：原理讲解的通用画面——流程、对比、时间线、架构关系、简单数据图、定义卡和总结卡。
 *
 * 约定（和其他官方风格一致）：
 *   - 所有组件在创建时一次性生成元素；render(t) 里只根据 t 设置状态，每帧都要调用（不调用就保持上一次的值）。
 *   - draw(p)：p 为 0～1 的入场进度。set(t, times)：按绝对时间编排的组件（流程、关系图、对比表）。
 *   - prime(q)：幽灵态。整张图先以 14% 的浓度出现（像铅笔稿），之后 draw / set 再逐个"上墨"。
 *   - focus(f)：强调，用唯一的强调色；dim(d)：压到约 55%，让别的元素当主角。
 * 坐标单位是画布像素，尺寸都写成 SLATE.u（短边的 1%）的倍数。先调用 ED.stage()，再创建其他组件。
 *
 *   const st = ED.stage();                                   // 纸面 + 内容层 world（跟镜头）+ 贴屏层 hud（不跟镜头）
 *   const h = ED.heading(st.world, { kicker: '原理 · 检索增强生成', text: '先查资料，再作答' });
 *   const A = ED.area(h);                                    // 标题下沿到字幕区上沿之间的内容区 {x, y, w, h, cx, cy}
 *   const f = ED.flow(st.world, { ...A, steps: [{ title: '提问' }, { title: '检索' }, { title: '生成' }] });
 *   function render(t) { st.set(t); h.draw(SLATE.seg(t, 0, 0.9)); f.draw(SLATE.seg(t, 0.4, 1)); f.set(t, [1.2, 2.4, 3.6]); }
 *
 * 组件一览（参数见各函数注释）：
 *   版面：stage、frame、area、heading、text、tag、source、legend、icon、layer、swap
 *   图解：node、link、zone、flow、graph、compare、timeline、callout、bracket
 *   数据：bars、line、ring、number
 *   卡片：define（概念定义卡）、recap（收尾总结卡）
 */
(() => {
  const S = window.SLATE;
  const U = S.u, W = S.width, H = S.height, PORTRAIT = H > W;
  const clamp = S.clamp, lerp = S.lerp;

  // ---- 颜色：暖灰纸 + 墨色灰阶 + 唯一强调色。系列色只在"必须区分 3 个以上对象"时才用 ----
  // series 已用 dataviz 校验器在各自纸色上校验：亮度带、色度、相邻色色觉障碍 ΔE≥8、正常视觉 ΔE≥15、对比度≥3:1；
  // 前三个在"任意两两"模式下也通过（散点、小多图可用前三个）。按顺序分配，跟着对象走，不按名次。
  const LIGHT = {
    paper: '#F0EDE7', card: '#F8F6F2', ink: '#1E2227', ink2: '#474C54', muted: '#666B73',
    mark: '#87837B', hair: '#B4AFA6', rule: '#D6D1C7', accent: '#B83D1B',
    series: ['#B83D1B', '#2F6AA8', '#1E8A62', '#8A4F9E', '#A8801A'],
    grays: ['#474C54', '#87837B', '#B4AFA6', '#D6D1C7'],
    capBg: 'rgba(30, 34, 39, 0.9)', capInk: '#F4F1EB',
  };
  const DARK = {
    paper: '#1F2226', card: '#272A2F', ink: '#ECE8E1', ink2: '#B9B5AE', muted: '#8F8B85',
    mark: '#7E7A74', hair: '#4C4F55', rule: '#33363B', accent: '#E8673F',
    series: ['#E8673F', '#5B93D1', '#3FA57C', '#A979C0', '#B88B2C'],
    grays: ['#B9B5AE', '#7E7A74', '#55585D', '#3A3D42'],
    capBg: 'rgba(12, 14, 17, 0.88)', capInk: '#ECE8E1',
  };
  const SANS = '"Noto Sans CJK SC", "Noto Sans SC", "PingFang SC", sans-serif';
  const SERIF = '"Noto Serif SC", "Noto Serif CJK SC", "Songti SC", serif';
  const C = { ...LIGHT, series: LIGHT.series.slice(), dark: false, sans: SANS, serif: SERIF };
  C.accentSoft = '#EAD9D0';

  /** 运动三常量：签名缓动（入场 enter 四次方减速；出场 exit；画面内移动 move）、三档时长、统一入场（幽灵态 → 上墨 + 上移 0.7u） */
  const ease = { ...S.ease, enter: p => 1 - Math.pow(1 - p, 4), exit: p => p * p * p, move: S.ease.inOut };
  const D = { fast: 0.35, base: 0.6, slow: 1.0 };
  const GHOST = 0.14, DIM = 0.45, RISE = U * 0.7;
  /** 线宽：发丝线不低于 0.15u（视频压缩后再细就会断） */
  const LW = { grid: U * 0.15, hair: U * 0.16, line: U * 0.2, strong: U * 0.32, data: U * 0.42 };

  const el = (tag, attrs, parent) => S.svg(tag, attrs, parent);
  const hex = c => [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16));
  const mix = (c1, c2, p) => { const a = hex(c1), b = hex(c2), q = clamp(p); return '#' + a.map((v, i) => Math.round(v + (b[i] - v) * q).toString(16).padStart(2, '0')).join(''); };
  const rgba = (c, a) => { const [r, g, b] = hex(c); return `rgba(${r}, ${g}, ${b}, ${a})`; };
  /** 数字格式：digits 位小数，sep 为 true 时加千分位 */
  const fmt = (v, d = 0, sep = false) => {
    let s = Math.abs(v).toFixed(d);
    if (sep) { const [a, b] = s.split('.'); s = a.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (b ? '.' + b : ''); }
    return (v < 0 ? '-' : '') + s;
  };
  /** 描线：画到一半时用虚线偏移；画完（或还没开始）就去掉虚线样式，静止帧里不留中间状态（调用方用 opacity 控制 p=0 时隐藏） */
  const drawOn = (e, p) => {
    if (p > 0 && p < 1) { S.draw(e, p); return; }
    if (e.__len === undefined) e.__len = e.getTotalLength ? e.getTotalLength() : 0;
    if (e.hasAttribute('style')) e.removeAttribute('style');
  };
  /** 入场：浓度 k，从下方 dy 处升到原位 */
  const show = (e, k, dy = RISE) => { e.setAttribute('opacity', k); e.setAttribute('transform', `translate(0 ${((1 - k) * dy).toFixed(2)})`); };
  let uid = 0;
  const nid = p => `ed${p}${++uid}`;
  let ROOT = null;
  const defsOf = parent => {
    if (ROOT && ROOT.defs) return ROOT.defs;
    const svg = parent.ownerSVGElement || parent;
    return svg.querySelector('defs') || el('defs', {}, svg);
  };

  // ---- 文字测量和换行：用无衬线体（系统字体，创建时就可用）测量；宋体按同样的宽度估算（汉字都是一个字宽） ----
  const mctx = document.createElement('canvas').getContext('2d');
  const measure = (s, size, weight = 500) => { mctx.font = `${weight} ${size}px ${SANS}`; return mctx.measureText(s).width; };
  const NO_START = '，。、；：！？）》」』”’%…·,.;:!?)]}';
  const NO_END = '（《「『“‘([{';
  /** 按宽度换行（中文逐字、英文按词），遵守避头尾：标点不放行首，左括号不放行尾。'\n' 强制换行 */
  function wrap(text, maxW, size, weight = 500) {
    const out = [];
    for (const para of String(text ?? '').split('\n')) {
      const start = out.length;
      const toks = para.match(/[A-Za-z0-9][A-Za-z0-9.,%+\-/:'’]*\s*|\s+|./gu) || [''];
      let ln = '';
      for (const tk of toks) {
        const next = ln + tk;
        if (ln && maxW && measure(next.trimEnd(), size, weight) > maxW) {
          if (NO_START.includes(tk[0])) { ln = next; continue; }
          let carry = '';
          while (ln.length > 1 && NO_END.includes(ln[ln.length - 1])) { carry = ln[ln.length - 1] + carry; ln = ln.slice(0, -1); }
          out.push(ln.trimEnd());
          ln = (carry + tk).trimStart();
        } else ln = next;
      }
      out.push(ln.trimEnd());
      // 避免孤字：最后一行只剩一个字时，从上一行挪一个字下来
      const k = out.length - 1;
      if (k > start && Array.from(out[k]).length === 1 && Array.from(out[k - 1]).length > 3) {
        const prev = Array.from(out[k - 1]);
        let mv = prev.pop();
        if (NO_START.includes(mv) && prev.length > 3) mv = prev.pop() + mv;
        out[k - 1] = prev.join(''); out[k] = mv + out[k];
      }
    }
    return out;
  }
  /** 标题换行：放不下一行时，优先在"，""："处断开；否则按行数均分，避免末行只剩一两个字 */
  function balance(text, maxW, size) {
    const first = wrap(text, maxW, size, 700);
    if (first.length < 2 || String(text).includes('\n')) return first;
    const s = String(text), marks = [...s.matchAll(/[，：；、！？]/g)].map(m => m.index + 1);
    let best = null;
    for (const k of marks) {
      const a = s.slice(0, k), b = s.slice(k);
      if (measure(a, size, 700) <= maxW && measure(b, size, 700) <= maxW) {
        const d = Math.abs(measure(a, size, 700) - measure(b, size, 700));
        if (!best || d < best.d) best = { d, lines: [a, b] };
      }
    }
    if (best && first.length === 2) return best.lines;
    const total = measure(s, size, 700), n = first.length;
    const even = wrap(s, Math.min(maxW, total / n + size * 1.5), size, 700);
    return even.length === n ? even : first;
  }
  /** 一段文字（可多行）：o x, y（首行基线）, text | lines, size, weight, color, anchor, serif, ls（字距，em）, lh（行距，em）, maxW, mark（这几个字用强调色） */
  function textEl(parent, o) {
    const size = o.size || U * 3.6, weight = o.weight || 500;
    const lines = o.lines || (o.maxW ? wrap(o.text, o.maxW, size, weight >= 600 ? 700 : weight) : String(o.text ?? '').split('\n'));
    const e = el('text', { x: o.x, y: o.y, 'font-size': size, 'font-weight': weight, fill: o.color || C.ink,
      'font-family': o.serif ? SERIF : SANS, 'text-anchor': o.anchor || 'start' }, parent);
    if (o.ls) e.setAttribute('letter-spacing', (o.ls * size).toFixed(2));
    const lh = (o.lh || 1.45) * size;
    lines.forEach((ln, i) => {
      const ts = el('tspan', { x: o.x, dy: i ? lh : 0 }, e);
      const k = o.mark ? ln.indexOf(o.mark) : -1;
      if (k < 0) { ts.textContent = ln; return; }
      if (k > 0) ts.appendChild(document.createTextNode(ln.slice(0, k)));
      const m = el('tspan', { fill: C.accent }, ts); m.textContent = o.mark;
      if (k + o.mark.length < ln.length) ts.appendChild(document.createTextNode(ln.slice(k + o.mark.length)));
    });
    const width = Math.max(0, ...lines.map(l => measure(l, size, weight >= 600 ? 700 : weight)));
    return { el: e, lines, size, lh, width, height: (lines.length - 1) * lh };
  }

  // ---------------------------------------------------------------------------------------------
  /** 版心：左右边距、标题起点、内容下沿和出处位置（横屏、竖屏、有无字幕都已算好）。
   *  竖屏的顶部 7.5% 留给平台的顶栏，底部从 70% 起是字幕和平台按钮。 */
  function frame() {
    const padX = U * (PORTRAIT ? 2 : 3);
    const x = S.safe.x + padX, w = S.safe.w - padX * 2;
    const top = PORTRAIT ? Math.max(S.safe.y, H * 0.075) : S.safe.y + U * 0.6;
    const floor = S.captionsOn ? S.captionZone.y : (PORTRAIT ? H * 0.70 : S.safe.y + S.safe.h);
    return { x, w, top, floor, srcY: floor - U * (S.captionsOn ? 1.6 : 0.8), bottom: floor - U * 5.2, cx: x + w / 2, portrait: PORTRAIT };
  }
  /** 内容区：从标题下沿（h 是 ED.heading 的返回值，可省略）到出处上方。o.gap 标题和内容之间的距离（默认 3u）
   *  返回 { x, y, w, h, cx, cy, portrait }，可以直接展开传给 flow / compare / timeline / bars 等 */
  function area(h, o = {}) {
    const F = frame();
    const y0 = (h ? h.bottom : F.top) + U * (o.gap ?? 3), y1 = F.bottom - U * (o.below ?? 0);
    return { x: F.x, y: y0, w: F.w, h: y1 - y0, cx: F.x + F.w / 2, cy: (y0 + y1) / 2, portrait: PORTRAIT };
  }

  /** 纸面：底色 + 一次性烘焙的纸纹（固定种子，不随时间变化）；grid: 'dots' 加 4u 点阵（架构、关系图用） */
  function paintPaper(ctx, o) {
    ctx.fillStyle = C.paper; ctx.fillRect(0, 0, W, H);
    if (o.grain !== false) {
      const img = ctx.getImageData(0, 0, W, H), d = img.data, r = S.rng(20261012);
      const gx = 30, gy = Math.ceil(gx * H / W) + 1;
      const coarse = Array.from({ length: (gx + 2) * (gy + 2) }, () => r() - 0.5);
      const amp = C.dark ? 5 : 4.5, mot = C.dark ? 5 : 6;
      for (let y = 0; y < H; y++) {
        const fy = y / H * gy, iy = Math.floor(fy), ty = fy - iy;
        for (let x = 0; x < W; x++) {
          const fx = x / W * gx, ix = Math.floor(fx), tx = fx - ix, k = iy * (gx + 2) + ix;
          const m = lerp(lerp(coarse[k], coarse[k + 1], tx), lerp(coarse[k + gx + 2], coarse[k + gx + 3], tx), ty);
          const n = (r() - 0.5) * amp + m * mot, i = (y * W + x) * 4;
          d[i] += n; d[i + 1] += n; d[i + 2] += n;
        }
      }
      ctx.putImageData(img, 0, 0);
    }
    if (o.grid === 'dots') {
      ctx.fillStyle = C.dark ? 'rgba(236, 232, 225, 0.10)' : 'rgba(30, 34, 39, 0.13)';
      const s = U * 4, dot = Math.max(1.5, U * 0.18);
      for (let y = s / 2; y < H; y += s) for (let x = s / 2; x < W; x += s) ctx.fillRect(Math.round(x), Math.round(y), dot, dot);
    }
  }

  /** 舞台：铺满画面的纸面 canvas + 内容 svg。必须最先调用（主题、强调色在这里定下，后面的组件按它取色）。
   *  opts: theme: 'light' | 'dark'（暗色版用于夜间、科技题材，默认 light）、accent（品牌强调色，默认朱红 #B83D1B；
   *        换色时在纸色上的对比度要 ≥4.5:1）、grain（纸纹，默认 true）、grid: null | 'dots'、
   *        push: [起, 止]（整镜缓推，例如 [1, 1.025]；默认不动）、pushAt: [x, y]（缓推的中心）、
   *        camera: [[t, {x, y, z}], ...]（镜头关键帧：画面中心对准世界坐标 (x, y)，z 是缩放；段间用 inOut 缓动）、
   *        stable（默认 true：每帧整层重画，保证分段渲染和顺序渲染逐像素一致；不要关）
   *  返回 { svg, defs, world, hud, fx, set(t) }：内容放 world（跟镜头），角标、出处放 hud（贴屏不动）。render(t) 第一行调用 st.set(t)。 */
  function stage(opts = {}) {
    const o = { theme: 'light', accent: null, grain: true, grid: null, push: null, pushAt: null, camera: null, ...opts };
    const base = o.theme === 'dark' ? DARK : LIGHT;
    Object.assign(C, base, { series: base.series.slice(), dark: o.theme === 'dark' });
    if (o.accent) { C.accent = o.accent; C.series[0] = o.accent; }
    C.accentSoft = mix(C.paper, C.accent, C.dark ? 0.18 : 0.11);
    const rs = document.documentElement.style;
    rs.setProperty('--u', U + 'px');
    rs.setProperty('--ed-paper', C.paper); rs.setProperty('--ed-ink', C.ink); rs.setProperty('--ed-accent', C.accent);
    rs.setProperty('--slate-caption-bg', C.capBg); rs.setProperty('--slate-caption-color', C.capInk);
    rs.background = C.paper; document.body.style.background = C.paper;
    const root = document.createElement('div');
    root.className = 'ed-root' + (C.dark ? ' ed-dark' : '');
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H; cv.className = 'ed-paper';
    root.appendChild(cv);
    const svg = el('svg', { class: 'ed-svg', width: W, height: H, viewBox: `0 0 ${W} ${H}` });
    root.appendChild(svg);
    document.body.insertBefore(root, document.body.firstChild);
    const defs = el('defs', {}, svg);
    const world = el('g', { class: 'ed-world' }, svg), hud = el('g', { class: 'ed-hud' }, svg), fx = el('g', { class: 'ed-fx' }, svg);
    ROOT = { svg, defs, world, hud, fx };
    paintPaper(cv.getContext('2d'), o);
    // 宋体只在用到时才下载：这里先要一次，渲染前等它就绪（不然第一帧会用替代字体）
    if (document.fonts && document.fonts.load) S.waits.push(document.fonts.load(`600 ${Math.round(U * 6)}px "Noto Serif SC"`, '编辑图解').catch(() => null));
    const keys = o.camera, at = o.pushAt || [W / 2, H / 2];
    const camAt = t => {
      if (keys && keys.length) {
        const ts = keys.map(k => k[0]);
        const ch = (n, d) => S.interpolate(t, ts, keys.map(k => k[1][n] ?? d), { easing: ease.move });
        return [ch('x', W / 2), ch('y', H / 2), ch('z', 1)];
      }
      if (o.push) return [at[0], at[1], lerp(o.push[0], o.push[1], ease.move(clamp(t / Math.max(0.01, S.duration))))];
      return [W / 2, H / 2, 1];
    };
    return {
      svg, defs, world, hud, fx, canvas: cv,
      set(t) {
        // 每个新时刻都让整层内容重新光栅化：浏览器只重画变动区域时，斜线和圆的抗锯齿会和整张重画差一两个像素，
        // 分段渲染从中间开始时就对不上。这个滤镜在视觉上是恒等的（色相转 0.00001～0.01 度），只由 t 决定
        if (o.stable !== false) svg.style.filter = `hue-rotate(${((Math.round(t * S.fps) % 997 + 1) * 1e-5).toFixed(5)}deg)`;
        const [x, y, z] = camAt(t);
        world.setAttribute('transform', `translate(${(W / 2).toFixed(2)} ${(H / 2).toFixed(2)}) scale(${z.toFixed(5)}) translate(${(-x).toFixed(2)} ${(-y).toFixed(2)})`);
      },
    };
  }
  /** 空图层（给 swap 用，或者把几样东西编成一组一起淡出） */
  const layer = parent => el('g', {}, parent);

  // ---------------------------------------------------------------------------------------------
  /** 页面标题：强调色短条 → 栏目小字（kicker）→ 宋体大标题（遮罩上升）→ 通栏发丝线。自动放在版心顶部。
   *  opts: text（标题，'\n' 强制换行，超宽自动换行）, kicker（栏目，如 '原理 · 检索增强生成'）, sub（副标题）,
   *        mark（标题里用强调色的几个字，只用一处）, align: 'left' | 'center'（开场、收尾可居中）, size（默认 6.4u）, rule（默认 true）, y（顶边）
   *  返回 { g, bottom（标题区下沿，内容从这里往下排；也可以用 ED.area(h)）, draw(p) } */
  function heading(parent, o) {
    const F = frame(), center = o.align === 'center';
    const size = o.size || U * 6.4, x = center ? W / 2 : F.x, anchor = center ? 'middle' : 'start';
    const g = el('g', {}, parent);
    const top0 = o.y ?? F.top, tabW = U * 3.6, tabH = U * 0.62;
    const tab = el('rect', { x: center ? x - tabW / 2 : x, y: top0, width: tabW, height: tabH, fill: C.accent }, g);
    let y = top0 + tabH, kick = null;
    if (o.kicker) { y += U * 3.7; kick = textEl(g, { x, y, text: o.kicker, size: U * 2.2, weight: 700, color: C.ink2, anchor, ls: 0.12 }); }
    const lines = balance(o.text, o.maxW || F.w * (center ? 0.9 : 0.94), size);
    const defs = defsOf(parent);
    const rows = lines.map((ln, i) => {
      const by = y + size * 1.25 + i * size * 1.3;
      const cid = nid('hc');
      el('rect', { x: 0, y: by - size * 1.2, width: W, height: size * 1.55 }, el('clipPath', { id: cid }, defs));
      const wrapG = el('g', { 'clip-path': `url(#${cid})` }, g);
      const te = textEl(wrapG, { x, y: by, text: ln, size, weight: 600, serif: true, anchor, color: C.ink, mark: o.mark });
      return { el: te.el, by };
    });
    y = rows[rows.length - 1].by;
    let sub = null;
    if (o.sub) { y += U * 4.6; sub = textEl(g, { x, y, text: o.sub, size: U * 2.8, weight: 500, color: C.ink2, anchor, maxW: F.w * 0.9 }); y += sub.height; }
    const ruleY = y + U * 3, rw = center ? Math.min(F.w, U * 24) : F.w, rx0 = center ? x - rw / 2 : x;
    const rule = o.rule === false ? null : el('line', { x1: rx0, x2: rx0, y1: ruleY, y2: ruleY, stroke: C.ink, 'stroke-width': LW.hair }, g);
    return {
      g, bottom: ruleY + U * 0.5, lines,
      draw(p) {
        const tp = ease.enter(clamp(p / 0.35));
        tab.setAttribute('width', tabW * tp);
        if (center) tab.setAttribute('x', x - tabW * tp / 2);
        if (kick) show(kick.el, ease.enter(clamp((p - 0.08) / 0.4)));
        rows.forEach((r, i) => {
          const k = ease.enter(clamp((p - 0.15 - i * 0.12) / 0.5));
          r.el.setAttribute('opacity', k > 0 ? 1 : 0);
          r.el.setAttribute('transform', `translate(0 ${((1 - k) * size * 1.05).toFixed(2)})`);
        });
        if (sub) show(sub.el, ease.enter(clamp((p - 0.45) / 0.45)));
        if (rule) {
          const q = ease.move(clamp((p - 0.3) / 0.7));
          if (center) { rule.setAttribute('x1', x - rw / 2 * q); rule.setAttribute('x2', x + rw / 2 * q); }
          else rule.setAttribute('x2', rx0 + rw * q);
          rule.setAttribute('opacity', q > 0 ? 1 : 0);
        }
      },
    };
  }

  /** 普通文字（说明、旁注）：opts x, y（首行基线）, text, size（默认 3.6u）, weight, color, anchor, serif, maxW（超宽换行）, lh, mark
   *  draw(p) 上墨上升；set(text) 改单行文字；返回值里有 lines、height（首行到末行基线的距离） */
  function text(parent, o) {
    const t = textEl(parent, o);
    return { ...t, draw(p) { show(t.el, ease.enter(clamp(p))); }, set(s) { const ts = t.el.firstChild; if (ts && ts.textContent !== s) ts.textContent = s; } };
  }

  /** 小标签（"示例数据"、截至日期、单位说明）：细框 + 小字。opts text, x, y（顶边）, anchor: 'start' | 'end'（默认 end，放在版心右上角）,
   *  accent（用强调色描边和文字）, size（默认 1.9u）。默认位置在版心右上角，放进 st.hud。draw(p) */
  function tag(parent, o) {
    const F = frame(), size = o.size || U * 1.9, padX = size * 0.7, h = size * 1.75;
    const tw = measure(o.text, size, 700) + size * 0.08 * Array.from(o.text).length, w = tw + padX * 2;
    const anchorEnd = (o.anchor || 'end') === 'end';
    const x0 = (o.x ?? F.x + F.w) - (anchorEnd ? w : 0), y0 = o.y ?? F.top;
    const col = o.accent ? C.accent : C.ink2;
    const g = el('g', {}, parent);
    el('rect', { x: x0, y: y0, width: w, height: h, rx: U * 0.2, fill: C.paper, stroke: col, 'stroke-width': LW.hair }, g);
    textEl(g, { x: x0 + padX, y: y0 + h * 0.5 + size * 0.36, text: o.text, size, weight: 700, color: col, ls: 0.08 });
    return { g, width: w, height: h, draw(p) { show(g, ease.enter(clamp(p)), U * 0.4); } };
  }

  /** 出处（每个数据画面都要有）：版心左下角、字幕区以上的一行小字。opts text, x, y, anchor, size（默认 1.9u）。放进 st.hud。draw(p) */
  function source(parent, o) {
    const F = frame();
    const g = el('g', {}, parent);
    textEl(g, { x: o.x ?? F.x, y: o.y ?? F.srcY, text: o.text, size: o.size || U * 1.9, weight: 500, color: C.muted, anchor: o.anchor || 'start' });
    return { g, draw(p) { show(g, ease.enter(clamp(p)), U * 0.4); } };
  }

  /** 图例（两个以上系列时必须有）：opts x, y（首项基线）, items: [{name, color, type: 'line' | 'box'}], size（默认 2.4u）, dir: 'row' | 'column'。draw(p) 逐项出现 */
  function legend(parent, o) {
    const size = o.size || U * 2.4, g = el('g', {}, parent);
    let x = o.x, y = o.y;
    const rows = o.items.map((it, i) => {
      const r = el('g', {}, g), col = it.color || C.series[i % C.series.length];
      if (it.type === 'box') el('rect', { x, y: y - size * 0.72, width: size * 0.8, height: size * 0.8, rx: U * 0.15, fill: col }, r);
      else el('line', { x1: x, x2: x + size * 1.4, y1: y - size * 0.32, y2: y - size * 0.32, stroke: col, 'stroke-width': it.width || LW.data, 'stroke-linecap': 'round' }, r);
      const off = it.type === 'box' ? size * 1.3 : size * 2;
      textEl(r, { x: x + off, y, text: it.name, size, weight: 500, color: C.ink2 });
      if ((o.dir || 'row') === 'row') x += off + measure(it.name, size) + size * 1.8; else y += size * 1.8;
      return r;
    });
    return { g, draw(p) { rows.forEach((r, i) => show(r, ease.enter(clamp(p * (1 + (rows.length - 1) * 0.5) - i * 0.5)), U * 0.4)); } };
  }

  // ---- 线条图标：24 格网格里的发丝线，圆头圆角 ----
  const ICONS = {
    doc: 'M6 3h8l4 4v14H6z M14 3v4h4 M9 12h6 M9 16h6',
    docs: 'M8 3h7l4 4v11H8z M15 3v4h4 M5 7v14h10',
    search: 'M10.5 4a6.5 6.5 0 1 0 0.01 0z M15.3 15.3L20 20',
    db: 'M5 6c0-1.7 3.1-3 7-3s7 1.3 7 3s-3.1 3-7 3s-7-1.3-7-3z M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6 M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3',
    user: 'M12 4a4 4 0 1 0 0.01 0z M4.5 20.5c0-4.2 3.4-6.5 7.5-6.5s7.5 2.3 7.5 6.5',
    users: 'M9 5a3.5 3.5 0 1 0 0.01 0z M3 19.5c0-3.6 2.7-5.5 6-5.5s6 1.9 6 5.5 M16 5.5a3 3 0 0 1 0 6 M17.5 14.2c2.2.5 3.5 2.2 3.5 4.8',
    spark: 'M12 3l2.1 6.9L21 12l-6.9 2.1L12 21l-2.1-6.9L3 12l6.9-2.1z',
    chat: 'M4 5h16v11H11l-5 4v-4H4z M8 9.5h8 M8 12.5h5',
    cup: 'M5 9h11v5a5 5 0 0 1-5 5h-1a5 5 0 0 1-5-5z M16 10.5h1.5a2.5 2.5 0 0 1 0 5H16 M8.5 3c0 1.5 1 1.5 1 3 M12 3c0 1.5 1 1.5 1 3',
    snow: 'M12 3v18 M4.2 7.5l15.6 9 M4.2 16.5l15.6-9 M9.5 4.6L12 6.6l2.5-2 M9.5 19.4L12 17.4l2.5 2 M4.6 10.4L7.4 10l-.5-2.9 M19.4 13.6L16.6 14l.5 2.9 M4.6 13.6L7.4 14l-.5 2.9 M19.4 10.4L16.6 10l.5-2.9',
    flame: 'M12 3c.8 3.6 5 5.6 5 10.3a5 5 0 0 1-10 0c0-2.6 1.4-4.2 2.4-5.1c.1 2 .9 3.1 2 3.6c-.2-3.2-.4-5.8.6-8.8z',
    clock: 'M12 3a9 9 0 1 0 0.01 0z M12 7v5l3.5 2.2',
    drop: 'M12 3c3 4.4 6 7.4 6 11a6 6 0 0 1-12 0c0-3.6 3-6.6 6-11z',
    globe: 'M12 3a9 9 0 1 0 0.01 0z M3 12h18 M12 3c2.9 3.1 2.9 14.9 0 18 M12 3c-2.9 3.1-2.9 14.9 0 18',
    server: 'M4 4h16v6H4z M4 14h16v6H4z M7.5 7h.01 M7.5 17h.01 M11 7h6 M11 17h6',
    layers: 'M12 4l9 4.5l-9 4.5l-9-4.5z M3 12.5l9 4.5l9-4.5 M3 16.5l9 4.5l9-4.5',
    bolt: 'M13 3L5 13.5h6L10 21l8-10.5h-6z',
    shield: 'M12 3l7 3v6c0 4.5-3 7.5-7 9c-4-1.5-7-4.5-7-9V6z M9 12l2 2l4-4',
    lock: 'M6 11h12v9H6z M8.5 11V8a3.5 3.5 0 0 1 7 0v3',
    check: 'M5 12.5l4.5 4.5L19 7.5',
    cross: 'M6 6l12 12 M18 6L6 18',
    chart: 'M4 20h16 M7 20v-6 M12 20V8 M17 20v-10',
    book: 'M4 5c3-1 5.5-1 8 1c2.5-2 5-2 8-1v14c-3-1-5.5-1-8 1c-2.5-2-5-2-8-1z M12 6v14',
    cloud: 'M7 18a4 4 0 0 1-.6-7.95a5.5 5.5 0 0 1 10.7-1.3A4.5 4.5 0 0 1 17.5 18z',
    route: 'M3 12h5 M8 12l5-5h5 M8 12l5 5h5 M16 4.5L18.5 7L16 9.5 M16 14.5l2.5 2.5l-2.5 2.5',
    coin: 'M12 3a9 9 0 1 0 0.01 0z M8.8 7.5L12 11l3.2-3.5 M12 11v6 M9 12.5h6 M9 15h6',
    gear: 'M12 9a3 3 0 1 0 0.01 0z M12 3v2.5 M12 18.5V21 M3 12h2.5 M18.5 12H21 M5.6 5.6l1.8 1.8 M16.6 16.6l1.8 1.8 M5.6 18.4l1.8-1.8 M16.6 7.4l1.8-1.8',
    leaf: 'M5 19c0-9 6-14 15-14c0 9-5 15-14 15 M5 19l8-8',
    phone: 'M7 3h10v18H7z M11 18h2',
    key: 'M8 10a4 4 0 1 0 0.01 0z M11.5 12H21 M18 12v3 M15 12v2',
    target: 'M12 3a9 9 0 1 0 0.01 0z M12 7.5a4.5 4.5 0 1 0 0.01 0z M12 11.3a.7.7 0 1 0 0.01 0z',
  };
  /** 图标：opts x, y（左上角）, size（默认 4u）, color, width（线宽，默认 0.2u）。名字见 ED.ICONS；返回 { g, path } */
  function icon(parent, name, o = {}) {
    const s = o.size || U * 4, k = s / 24;
    const g = el('g', { transform: `translate(${o.x || 0} ${o.y || 0}) scale(${k})` }, parent);
    const path = el('path', { d: ICONS[name] || ICONS.doc, fill: 'none', stroke: o.color || C.ink2, 'stroke-width': (o.width || LW.line * 1.1) / k,
      'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, g);
    return { g, path };
  }

  // ---------------------------------------------------------------------------------------------
  /** 节点（方框）：opts x, y, w, h（左上角和尺寸）, title, sub（一行说明，自动换行）, icon（图标名）, index（角标，如 '01'）,
   *  kind（处理方式）: 'box' 默认实框 | 'solid' 墨色实底（输出、结论）| 'store' 存储（顶部双线）| 'external' 外部系统（虚线框）|
   *        'optional' 可选（点线框、灰字）| 'accent' 强调色浅底（全片的主角）| 'plain' 无框（只有文字）,
   *  align: 'left'（默认，图标在左）| 'center'（图标在上）, size（标题字号，默认 3.6u）, subSize（默认 2.6u）
   *  draw(p) 上墨；prime(q) 幽灵态；focus(f) 强调色描边 + 左侧色条；dim(d) 压暗。rect 给连线和标注用 */
  function node(parent, o) {
    const kind = o.kind || 'box', x = o.x, y = o.y, w = o.w, h = o.h, r = o.r ?? U * 0.5;
    const g = el('g', {}, parent);
    const solid = kind === 'solid', open = kind === 'external' || kind === 'optional' || kind === 'plain';
    const fill = solid ? C.ink : kind === 'accent' ? C.accentSoft : open ? C.paper : C.card;
    const stroke = kind === 'accent' ? C.accent : kind === 'optional' ? C.mark : C.ink;
    if (kind !== 'plain') {
      const a = { x, y, width: w, height: h, rx: r, fill, stroke, 'stroke-width': LW.hair };
      if (kind === 'external') Object.assign(a, { 'stroke-dasharray': `${U * 0.9} ${U * 0.6}` });
      if (kind === 'optional') Object.assign(a, { 'stroke-dasharray': `${U * 0.05} ${U * 0.75}`, 'stroke-linecap': 'round', 'stroke-width': LW.line });
      el('rect', a, g);
    }
    if (kind === 'store') el('line', { x1: x + r * 0.3, x2: x + w - r * 0.3, y1: y + U * 0.9, y2: y + U * 0.9, stroke: C.ink, 'stroke-width': LW.hair }, g);
    const hl = el('rect', { x, y, width: w, height: h, rx: r, fill: 'none', stroke: C.accent, 'stroke-width': LW.strong, opacity: 0 }, g);
    const bw = U * 0.7;
    const lbar = el('path', { d: `M ${x + r} ${y} H ${x + bw} V ${y + h} H ${x + r} Q ${x} ${y + h} ${x} ${y + h - r} V ${y + r} Q ${x} ${y} ${x + r} ${y} Z`, fill: C.accent, opacity: 0 }, g);
    const tc = solid ? C.paper : kind === 'optional' ? C.ink2 : C.ink, sc = solid ? mix(C.paper, C.ink, 0.3) : C.ink2;
    const center = o.align === 'center';
    let ts = o.size || U * 3.6, ss = o.subSize || U * 2.6;
    const pad = Math.min(U * 2.2, w * 0.09);
    const iconS = o.icon ? (o.iconSize || Math.min(U * 4.4, h * 0.36, w * 0.18)) : 0;
    const tx = center ? x + w / 2 : x + pad + (iconS ? iconS + U * 1.5 : 0);
    const avail = center ? w - pad * 2 : x + w - pad - tx;
    let tl = wrap(o.title, avail, ts, 700), sl = o.sub ? wrap(o.sub, avail, ss, 500) : [];
    // 放不下时字号最多缩到 85%（再小就该加宽节点或删字）
    const fitH = (a, b, t1, s1) => t1 * 0.88 + (a.length - 1) * t1 * 1.3 + t1 * 0.12 + (b.length ? U * 1.1 + s1 * 0.88 + (b.length - 1) * s1 * 1.4 + s1 * 0.12 : 0) + (center && o.icon ? Math.min(U * 4.4, h * 0.36, w * 0.18) + U * 1.3 : 0);
    for (let k = 0; k < 3 && fitH(tl, sl, ts, ss) > h - U * 2; k++) {
      ts *= 0.95; ss *= 0.95;
      tl = wrap(o.title, avail, ts, 700); sl = o.sub ? wrap(o.sub, avail, ss, 500) : [];
    }
    const titleH = ts * 0.88 + (tl.length - 1) * ts * 1.3 + ts * 0.12;
    const subGap = ts * 0.12 + U * 1.1 + ss * 0.88;
    const subH = sl.length ? U * 1.1 + ss * 0.88 + (sl.length - 1) * ss * 1.4 + ss * 0.12 : 0;
    const iconBlock = center && iconS ? iconS + U * 1.3 : 0;
    const blockH = iconBlock + titleH + subH;
    const by0 = y + (h - blockH) / 2;
    let ic = null;
    const icBase = solid ? mix(C.paper, C.ink, 0.15) : C.ink2;
    if (o.icon) ic = icon(g, o.icon, { x: center ? x + w / 2 - iconS / 2 : x + pad, y: center ? by0 : y + h / 2 - iconS / 2, size: iconS, color: icBase });
    const b0 = by0 + iconBlock + ts * 0.88;
    const title = textEl(g, { x: tx, y: b0, lines: tl, size: ts, weight: 700, color: tc, anchor: center ? 'middle' : 'start', lh: 1.3 });
    const sub = sl.length ? textEl(g, { x: tx, y: b0 + (tl.length - 1) * ts * 1.3 + subGap, lines: sl, size: ss, weight: 500, color: sc, anchor: center ? 'middle' : 'start', lh: 1.4 }) : null;
    const idx = o.index ? textEl(g, { x: x + w - U * 1.2, y: y + U * 2.6, text: o.index, size: U * 1.9, weight: 700, color: solid ? sc : C.muted, anchor: 'end', ls: 0.06 }) : null;
    const st = { ghost: 0, ink: 0, f: 0, d: 0 };
    const apply = () => {
      const vis = Math.max(st.ghost * GHOST, st.ink) * (1 - st.d * DIM);
      g.setAttribute('opacity', vis.toFixed(4));
      g.setAttribute('transform', `translate(0 ${((1 - st.ink) * RISE).toFixed(2)})`);
      hl.setAttribute('opacity', st.f); lbar.setAttribute('opacity', st.f);
      if (idx) idx.el.setAttribute('fill', mix(solid ? sc : C.muted, C.accent, st.f));
      if (ic) ic.path.setAttribute('stroke', solid ? icBase : mix(icBase, C.accent, st.f));
    };
    apply();
    return {
      g, title, sub, x, y, w, h, cx: x + w / 2, cy: y + h / 2, rect: { x, y, w, h },
      draw(p) { st.ink = ease.enter(clamp(p)); apply(); },
      prime(q) { st.ghost = clamp(q); apply(); },
      focus(f) { st.f = clamp(f); apply(); },
      dim(d) { st.d = clamp(d); apply(); },
    };
  }

  // ---- 连线 ----
  const rectOf = a => a.rect || a;
  /** 正交走线：auto 时按两框的相对位置选横走（h）或竖走（v）；hv 先横后竖，vh 先竖后横 */
  function routePts(A, B, o) {
    const gap = o.gap ?? U * 0.9, a = rectOf(A), b = rectOf(B);
    const acx = a.x + a.w / 2, acy = a.y + a.h / 2, bcx = b.x + b.w / 2, bcy = b.y + b.h / 2;
    const hGap = Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w)), vGap = Math.max(b.y - (a.y + a.h), a.y - (b.y + b.h));
    let m = o.route || 'auto';
    if (m === 'auto') m = hGap >= vGap ? 'h' : 'v';
    if (m === 'h') {
      const dir = bcx >= acx ? 1 : -1, x1 = dir > 0 ? a.x + a.w + gap : a.x - gap, x2 = dir > 0 ? b.x - gap : b.x + b.w + gap;
      const lo = Math.max(a.y, b.y), hi = Math.min(a.y + a.h, b.y + b.h);
      if (hi - lo > U * 2) { const yy = (acy >= lo && acy <= hi) ? (bcy >= lo && bcy <= hi ? (acy + bcy) / 2 : acy) : (lo + hi) / 2; return [[x1, yy], [x2, yy]]; }
      const xm = o.mid ?? (x1 + x2) / 2;
      return [[x1, acy], [xm, acy], [xm, bcy], [x2, bcy]];
    }
    if (m === 'v') {
      const dir = bcy >= acy ? 1 : -1, y1 = dir > 0 ? a.y + a.h + gap : a.y - gap, y2 = dir > 0 ? b.y - gap : b.y + b.h + gap;
      const lo = Math.max(a.x, b.x), hi = Math.min(a.x + a.w, b.x + b.w);
      if (hi - lo > U * 2) { const xx = (acx >= lo && acx <= hi) ? (bcx >= lo && bcx <= hi ? (acx + bcx) / 2 : acx) : (lo + hi) / 2; return [[xx, y1], [xx, y2]]; }
      const ym = o.mid ?? (y1 + y2) / 2;
      return [[acx, y1], [acx, ym], [bcx, ym], [bcx, y2]];
    }
    if (m === 'hv') {
      const x1 = bcx >= acx ? a.x + a.w + gap : a.x - gap, y2 = bcy >= acy ? b.y - gap : b.y + b.h + gap;
      return [[x1, acy], [bcx, acy], [bcx, y2]];
    }
    const y1 = bcy >= acy ? a.y + a.h + gap : a.y - gap, x2 = bcx >= acx ? b.x - gap : b.x + b.w + gap;
    return [[acx, y1], [acx, bcy], [x2, bcy]];
  }
  /** 折线 → 圆角路径 */
  function roundedPath(pts, r) {
    let d = `M ${pts[0][0].toFixed(2)} ${pts[0][1].toFixed(2)}`;
    for (let i = 1; i < pts.length - 1; i++) {
      const [px, py] = pts[i - 1], [cx, cy] = pts[i], [nx, ny] = pts[i + 1];
      const l1 = Math.hypot(cx - px, cy - py) || 1, l2 = Math.hypot(nx - cx, ny - cy) || 1, rr = Math.min(r, l1 / 2, l2 / 2);
      d += ` L ${(cx - (cx - px) / l1 * rr).toFixed(2)} ${(cy - (cy - py) / l1 * rr).toFixed(2)} Q ${cx.toFixed(2)} ${cy.toFixed(2)} ${(cx + (nx - cx) / l2 * rr).toFixed(2)} ${(cy + (ny - cy) / l2 * rr).toFixed(2)}`;
    }
    const [lx, ly] = pts[pts.length - 1];
    return d + ` L ${lx.toFixed(2)} ${ly.toFixed(2)}`;
  }

  /** 连线（正交折线，圆角拐弯，先描线、箭头后出现）。
   *  opts from, to（node 返回值或 {x, y, w, h}）, route: 'auto' | 'h' | 'v' | 'hv' | 'vh', mid（拐弯处的 x 或 y）,
   *       points（直接给折线点 [[x, y], ...]，忽略 from/to）, label（线上的小字，纸色衬底）, labelAt（0～1，默认 0.5）, labelDx / labelDy（标签偏移，线太短时把字挪到线外）,
   *       dashed（虚线：可选、异步、回流）, arrow: 'end' | 'both' | 'none', gap（离框的距离，默认 0.9u）
   *  draw(p) 描线（最后 20% 出箭头）；prime(q) 幽灵态；focus(f) 变强调色并加粗；pulse(q) 一个强调色圆点沿线走（0～1，区间外隐藏）；
   *  dim(d)；at(q) 返回线上一点 [x, y]（给标注用） */
  function link(parent, o) {
    const pts = o.points ? o.points.map(p => p.slice()) : routePts(o.from, o.to, o);
    const arrow = o.arrow || 'end', aL = U * 1.35, aW = U * 0.62;
    const g = el('g', {}, parent);
    const n = pts.length;
    const dirOf = (p, q) => { const dx = q[0] - p[0], dy = q[1] - p[1], l = Math.hypot(dx, dy) || 1; return [dx / l, dy / l]; };
    const tipE = pts[n - 1].slice(), dE = dirOf(pts[n - 2], pts[n - 1]);
    const tipS = pts[0].slice(), dS = dirOf(pts[1], pts[0]);
    const lp = pts.map(p => p.slice());
    if (arrow !== 'none') { lp[n - 1][0] -= dE[0] * aL * 0.7; lp[n - 1][1] -= dE[1] * aL * 0.7; }
    if (arrow === 'both') { lp[0][0] -= dS[0] * aL * 0.7; lp[0][1] -= dS[1] * aL * 0.7; }
    const d = roundedPath(lp, o.radius ?? U * 1.2);
    const dash = o.dashed ? `${U * 0.9} ${U * 0.7}` : null;
    const ghost = el('path', { d, fill: 'none', stroke: C.ink, 'stroke-width': LW.line, opacity: 0, ...(dash ? { 'stroke-dasharray': dash } : {}) }, g);
    const path = el('path', { d, fill: 'none', stroke: C.ink, 'stroke-width': LW.line, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, g);
    let maskPath = null;
    if (dash) {
      const mid = nid('lm');
      const mask = el('mask', { id: mid, maskUnits: 'userSpaceOnUse', x: 0, y: 0, width: W, height: H }, defsOf(parent));
      maskPath = el('path', { d, fill: 'none', stroke: '#fff', 'stroke-width': U * 1.2, 'stroke-linecap': 'butt' }, mask);
      path.setAttribute('stroke-dasharray', dash);
      path.setAttribute('stroke-linecap', 'butt');
      path.setAttribute('mask', `url(#${mid})`);
    }
    // 箭头三角形直接按缩放算坐标（不用 transform，静止帧的光栅结果更稳定）
    const headD = (tip, dv, k) => { const l = aL * k, w2 = aW * k, f = v => v.toFixed(2);
      return `M ${f(tip[0])} ${f(tip[1])} L ${f(tip[0] - dv[0] * l - dv[1] * w2)} ${f(tip[1] - dv[1] * l + dv[0] * w2)} L ${f(tip[0] - dv[0] * l + dv[1] * w2)} ${f(tip[1] - dv[1] * l - dv[0] * w2)} Z`; };
    const head = (tip, dv) => el('path', { d: headD(tip, dv, 1), fill: C.ink, opacity: 0 }, g);
    const heads = [];
    if (arrow !== 'none') heads.push({ e: head(tipE, dE), tip: tipE, dv: dE });
    if (arrow === 'both') heads.push({ e: head(tipS, dS), tip: tipS, dv: dS });
    const L = path.getTotalLength();
    const dot = el('circle', { r: U * 0.62, fill: C.accent, stroke: C.paper, 'stroke-width': U * 0.25, opacity: 0 }, g);
    let lab = null;
    if (o.label) {
      const lsz = o.labelSize || U * 2.2, q0 = path.getPointAtLength(L * (o.labelAt ?? 0.5)), q = { x: q0.x + (o.labelDx || 0), y: q0.y + (o.labelDy || 0) };
      const lw = measure(o.label, lsz, 500) + lsz * 0.9, lh = lsz * 1.5;
      lab = el('g', { opacity: 0 }, g);
      if (!o.labelDx && !o.labelDy) el('rect', { x: q.x - lw / 2, y: q.y - lh / 2, width: lw, height: lh, rx: U * 0.2, fill: C.paper }, lab);
      textEl(lab, { x: q.x, y: q.y + lsz * 0.36, text: o.label, size: lsz, weight: 500, color: C.ink2, anchor: 'middle' });
    }
    const st = { ghost: 0, p: 0, f: 0, d: 0, pulse: -1 };
    const apply = () => {
      const col = mix(C.ink, C.accent, st.f), wd = lerp(LW.line, LW.strong, st.f);
      g.setAttribute('opacity', (1 - st.d * DIM).toFixed(4));
      ghost.setAttribute('opacity', (st.ghost * GHOST * (st.p >= 1 ? 0 : 1)).toFixed(4));
      drawOn(maskPath || path, st.p);
      path.setAttribute('opacity', st.p > 0 ? 1 : 0);
      path.setAttribute('stroke', col); path.setAttribute('stroke-width', wd);
      const k = ease.enter(clamp((st.p - 0.8) / 0.2));
      heads.forEach(hd => {
        hd.e.setAttribute('opacity', k > 0 ? 1 : 0); hd.e.setAttribute('fill', col);
        hd.e.setAttribute('d', headD(hd.tip, hd.dv, 0.3 + 0.7 * k));
      });
      if (lab) lab.setAttribute('opacity', ease.enter(clamp((st.p - 0.5) / 0.5)).toFixed(4));
      const pv = st.pulse > 0 && st.pulse < 1;
      dot.setAttribute('opacity', pv ? 1 : 0);
      const q = path.getPointAtLength(L * clamp(st.pulse));
      dot.setAttribute('cx', q.x.toFixed(2)); dot.setAttribute('cy', q.y.toFixed(2));
    };
    apply();
    return {
      g, path, length: L, points: pts,
      draw(p) { st.p = clamp(p); apply(); }, prime(q) { st.ghost = clamp(q); apply(); },
      focus(f) { st.f = clamp(f); apply(); }, dim(dd) { st.d = clamp(dd); apply(); },
      pulse(q) { st.pulse = q; apply(); },
      at(q) { const pt = path.getPointAtLength(L * clamp(q)); return [pt.x, pt.y]; },
    };
  }

  /** 分区（安全边界、云上私有网络、某个团队负责的部分）：虚线框 + 压在框线上的小标题。
   *  opts x, y, w, h, label, solid（实线框）, fill（默认很淡的墨色）。draw(p)、prime(q)、focus(f)（标题和框线变强调色） */
  function zone(parent, o) {
    const g = el('g', {}, parent), r = U * 0.8;
    const rect = el('rect', { x: o.x, y: o.y, width: o.w, height: o.h, rx: r, fill: o.fill || rgba(C.ink, C.dark ? 0.035 : 0.025),
      stroke: C.ink2, 'stroke-width': LW.hair, ...(o.solid ? {} : { 'stroke-dasharray': `${U * 0.5} ${U * 0.5}` }) }, g);
    let lab = null, lt = null;
    if (o.label) {
      const ls = U * 2.0, lw = measure(o.label, ls, 700) + ls * 0.12 * Array.from(o.label).length + ls * 1.2;
      lab = el('g', {}, g);
      el('rect', { x: o.x + U * 2, y: o.y - ls * 0.8, width: lw, height: ls * 1.6, fill: C.paper }, lab);
      lt = textEl(lab, { x: o.x + U * 2 + ls * 0.6, y: o.y + ls * 0.36, text: o.label, size: ls, weight: 700, color: C.ink2, ls: 0.12 });
    }
    const st = { ghost: 0, ink: 0, f: 0 };
    const apply = () => {
      g.setAttribute('opacity', Math.max(st.ghost * GHOST, st.ink).toFixed(4));
      rect.setAttribute('stroke', mix(C.ink2, C.accent, st.f));
      if (lt) lt.el.setAttribute('fill', mix(C.ink2, C.accent, st.f));
    };
    apply();
    return { g, rect: { x: o.x, y: o.y, w: o.w, h: o.h },
      draw(p) { st.ink = ease.enter(clamp(p)); apply(); }, prime(q) { st.ghost = clamp(q); apply(); }, focus(f) { st.f = clamp(f); apply(); } };
  }

  // ---------------------------------------------------------------------------------------------
  /** 流程（节点 + 连线，按时间依次点亮）。横屏默认横排，竖屏默认竖排。
   *  opts x, y, w, h（区域，节点在区域里居中）, steps: [{title, sub, icon, kind}], dir: 'auto' | 'row' | 'column',
   *       gap（节点间距）, nodeW, nodeH, index（默认 true，角标 01、02…）, labels（连线上的小字，第 i 条是 i → i+1）, dashed（连线虚线）
   *  draw(p)：整条流程以幽灵态出现（铅笔稿）。
   *  set(t, times, {keepLast = true, release = null, dim = true})：times[i] 是第 i 步点亮的秒数（对齐旁白点名的时刻）。
   *    当前步用强调色，讲过的步骤压到约 55%；连线在下一步点亮前 0.6 秒开始描，强调色圆点在笔头上走；
   *    release 秒起所有步骤恢复正常（末帧是完整的图），keepLast 让最后一步保持强调。
   *  返回 { nodes, links, set, draw }，nodes[i].rect 可以接别的连线和标注 */
  function flow(parent, o) {
    const steps = o.steps, n = steps.length;
    let dir = o.dir || 'auto';
    if (dir === 'auto') dir = PORTRAIT ? 'column' : 'row';
    const g = el('g', {}, parent);
    const gap = o.gap ?? (dir === 'row' ? U * 6 : U * 5);
    let rects;
    if (dir === 'row') {
      const nw = o.nodeW || Math.min(U * 34, (o.w - gap * (n - 1)) / n), nh = o.nodeH || Math.min(o.h, U * 16);
      const x0 = o.x + (o.w - (nw * n + gap * (n - 1))) / 2, y0 = o.y + (o.h - nh) / 2;
      rects = steps.map((_, i) => ({ x: x0 + i * (nw + gap), y: y0, w: nw, h: nh }));
    } else {
      const nw = o.nodeW || Math.min(o.w, U * 66), nh = o.nodeH || Math.min(U * 16, (o.h - gap * (n - 1)) / n);
      const x0 = o.x + (o.w - nw) / 2, y0 = o.y + (o.h - (nh * n + gap * (n - 1))) / 2;
      rects = steps.map((_, i) => ({ x: x0, y: y0 + i * (nh + gap), w: nw, h: nh }));
    }
    const ll = el('g', {}, g), nl = el('g', {}, g);
    const links = rects.slice(1).map((r, i) => link(ll, { from: rects[i], to: r, label: o.labels && o.labels[i], dashed: o.dashed }));
    const nodes = steps.map((s, i) => node(nl, { ...rects[i], index: o.index === false ? null : String(i + 1).padStart(2, '0'), ...s }));
    return {
      g, nodes, links, rects,
      draw(p) {
        nodes.forEach((nd, i) => nd.prime(clamp(p * 1.6 - i * 0.6 / n)));
        links.forEach((lk, i) => lk.prime(clamp(p * 1.6 - (i + 0.5) * 0.6 / n)));
      },
      set(t, times, so = {}) {
        const keep = so.keepLast ?? true, rel = so.release != null ? S.seg(t, so.release, so.release + D.base, ease.move) : 0;
        const dimOn = so.dim !== false;
        nodes.forEach((nd, i) => {
          const t0 = times[i], next = i < n - 1 ? times[i + 1] : null;
          nd.draw(S.seg(t, t0, t0 + D.base, ease.linear));
          let f = S.seg(t, t0, t0 + D.fast, ease.out);
          if (next != null) f *= 1 - S.seg(t, next, next + D.fast, ease.out);
          else if (!keep) f *= 1 - rel;
          nd.focus(f);
          nd.dim(dimOn && next != null ? S.seg(t, next, next + D.base, ease.move) * (1 - rel) : 0);
        });
        links.forEach((lk, i) => {
          const b = times[i + 1] + 0.05, a = b - D.base - 0.05;
          const q = S.seg(t, a, b, ease.move);
          lk.draw(q); lk.pulse(q);
          lk.focus(S.seg(t, a, a + 0.1, ease.linear) * (1 - S.seg(t, b + 0.2, b + 0.2 + D.fast, ease.out)));
          lk.dim(dimOn && i + 2 < n ? S.seg(t, times[i + 2], times[i + 2] + D.base, ease.move) * (1 - rel) : 0);
        });
      },
    };
  }

  /** 关系图 / 架构图：任意拓扑。节点位置用区域内的比例坐标，画幅变了也不乱。
   *  opts x, y, w, h（区域）, nodes: [{id, at: [0～1, 0～1]（节点中心在区域里的位置）, w, h, title, sub, icon, kind, index}],
   *       nodeW, nodeH（默认尺寸）, align（节点默认对齐：'left' 图标在左 | 'center' 图标在上，窄节点用 center）, links: [{from, to, route, label, dashed, arrow, mid}]（id 默认是 'from>to'）,
   *       zones: [{id, ids: [成员节点], label, pad, rect}]（分区框，默认包住成员节点）
   *  draw(p)：整张图以幽灵态出现。
   *  set(t, plan, {release, keepLast = false, dim = true})：plan 是 [[秒, id, id, ...], ...]，按旁白顺序逐步上墨；
   *    每一步的元素在这一步里用强调色，下一步开始后压暗；没写进 plan 的分区跟着第一个成员出现；
   *    release 秒起全部恢复（末帧是完整的图）。连线上墨时有强调色圆点沿线走。
   *  返回 { items: {id: 组件}, node(id), set, draw } */
  function graph(parent, o) {
    const g = el('g', {}, parent), zl = el('g', {}, g), ll = el('g', {}, g), nl = el('g', {}, g);
    const items = {};
    (o.nodes || []).forEach(nd => {
      const w = nd.w || o.nodeW || U * 26, h = nd.h || o.nodeH || U * 12;
      const r = { x: o.x + nd.at[0] * o.w - w / 2, y: o.y + nd.at[1] * o.h - h / 2, w, h };
      items[nd.id] = { type: 'node', c: node(nl, { align: o.align, ...nd, ...r }) };
    });
    (o.zones || []).forEach((z, i) => {
      let r = z.rect;
      if (!r) {
        const rs = z.ids.map(id => items[id].c.rect), pad = z.pad ?? U * 3;
        const x0 = Math.min(...rs.map(q => q.x)) - pad, y0 = Math.min(...rs.map(q => q.y)) - pad - U * 1.2;
        const x1 = Math.max(...rs.map(q => q.x + q.w)) + pad, y1 = Math.max(...rs.map(q => q.y + q.h)) + pad;
        r = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
      }
      items[z.id || 'zone' + i] = { type: 'zone', c: zone(zl, { ...r, label: z.label, solid: z.solid }), members: z.ids || [] };
    });
    (o.links || []).forEach(l => {
      const id = l.id || `${l.from}>${l.to}`;
      items[id] = { type: 'link', c: link(ll, { ...l, from: items[l.from].c, to: items[l.to].c }) };
    });
    const ids = Object.keys(items);
    return {
      g, items, node: id => items[id].c,
      draw(p) {
        const order = ['zone', 'node', 'link'];
        ids.forEach((id, i) => items[id].c.prime(clamp(p * 1.8 - order.indexOf(items[id].type) * 0.3 - (i / ids.length) * 0.2)));
      },
      set(t, plan, so = {}) {
        const rel = so.release != null ? S.seg(t, so.release, so.release + D.base, ease.move) : 0, last = plan.length - 1;
        const first = {}, inStep = {};
        plan.forEach((e, si) => e.slice(1).flat().forEach(id => { if (!(id in first)) first[id] = si; (inStep[id] = inStep[id] || []).push(si); }));
        ids.forEach(id => {
          const it = items[id];
          if (it.type === 'zone' && !(id in first)) {
            const ms = it.members.filter(m => m in first).map(m => first[m]);
            if (ms.length) first[id] = Math.min(...ms);
          }
        });
        ids.forEach(id => {
          const it = items[id], c = it.c, si = first[id];
          if (si == null) { if (c.draw) c.draw(0); if (c.focus) c.focus(0); if (c.dim) c.dim(0); if (c.pulse) c.pulse(-1); return; }
          const t0 = plan[si][0];
          if (it.type === 'link') { const q = S.seg(t, t0, t0 + D.base, ease.move); c.draw(q); c.pulse(q); }
          else c.draw(S.seg(t, t0, t0 + D.base, ease.linear));
          let f = 0;
          (inStep[id] || []).forEach(k => {
            const a = plan[k][0], b = k < last ? plan[k + 1][0] : null;
            let v = S.seg(t, a, a + D.fast, ease.out) * (b != null ? 1 - S.seg(t, b, b + D.fast, ease.out) : 1);
            if (b == null && !so.keepLast) v *= 1 - rel;
            f = Math.max(f, v);
          });
          c.focus(f);
          if (c.dim) {
            const steps = inStep[id] || [si], lastIn = Math.max(...steps);
            const past = so.dim === false || lastIn >= last ? 0 : S.seg(t, plan[lastIn + 1][0], plan[lastIn + 1][0] + D.base, ease.move);
            c.dim(it.type === 'zone' ? 0 : past * (1 - rel));
          }
        });
      },
    };
  }

  // ---------------------------------------------------------------------------------------------
  /** 对比双栏（左右对比、前后对比）：两栏表头 + 中间一列属性名，数值从中间往两边排，条形从中线向外长（蝴蝶式）。
   *  opts x, y, w, h, left: {title, en, icon}, right: {...}, rows: [{label, a, b, va, vb}]（a/b 是两边的文字，
   *       va/vb 是 0～1 的量，给了才画条形）, arrow（前后对比：表头中间画 →）, accent: 'left' | 'right' | null（哪一边的条形用强调色）,
   *       labelW（中间列宽）, headH（表头高，默认 13u）, valueSize（默认横屏 3.8u、竖屏 3.4u）。accent 那一边会垫一张卡片（主角栏）
   *  draw(p) 表头和表头线；row(i, p) 第 i 行；set(t, times) 第 i 行在 times[i] 出现；focus(i, side, f) 强调某一格（side: 'a' | 'b'） */
  function compare(parent, o) {
    const g = el('g', {}, parent), n = o.rows.length;
    const cw = o.labelW ?? Math.min(o.w * 0.2, U * (PORTRAIT ? 15 : 19)), sw = (o.w - cw) / 2;
    const xL = o.x + sw, xR = o.x + sw + cw, cx = o.x + o.w / 2;
    const headH = o.headH ?? U * 13, vs = o.valueSize || U * (PORTRAIT ? 3.4 : 3.8), inset = U * 1.6;
    // 主角栏（accent 指定的一边）垫一张卡片，顶边一道强调色：一眼看出"这一片讲的是哪一边"
    let band = null, bandTop = null;
    if (o.accent === 'left' || o.accent === 'right') {
      const bx = o.accent === 'left' ? o.x : xR, by = o.y - U * 2, bh = o.h + U * 2;
      band = el('rect', { x: bx, y: by, width: sw, height: bh, rx: U * 0.4, fill: C.card, stroke: C.rule, 'stroke-width': LW.grid }, g);
      bandTop = el('rect', { x: bx, y: by, width: sw, height: U * 0.55, fill: C.accent }, g);
    }
    const hs = U * (PORTRAIT ? 4.4 : 4.8);
    const head = (s, hx, sideAccent) => {
      const hg = el('g', {}, g);
      const iconS = s.icon ? hs * 1.05 : 0, tw = measure(s.title, hs, 700), total = iconS + (iconS ? U * 1.4 : 0) + tw;
      const x0 = hx - total / 2, by = o.y + hs * 1.05;
      let ic = null;
      if (s.icon) ic = icon(hg, s.icon, { x: x0, y: by - hs * 0.88, size: iconS, color: sideAccent ? C.accent : C.ink2 });
      textEl(hg, { x: x0 + total - tw / 2, y: by, text: s.title, size: hs, weight: 600, serif: true, anchor: 'middle', color: C.ink });
      if (s.en) textEl(hg, { x: hx, y: by + U * 4.2, text: s.en, size: U * 2.0, weight: 700, color: C.muted, anchor: 'middle', ls: 0.14 });
      return hg;
    };
    const hA = head(o.left, o.x + sw / 2, o.accent === 'left'), hB = head(o.right, xR + sw / 2, o.accent === 'right');
    const ruleY = o.y + headH - U * 1.2;
    const hr = el('line', { x1: o.x, x2: o.x + o.w, y1: ruleY, y2: ruleY, stroke: C.ink, 'stroke-width': LW.hair }, g);
    let arrowEl = null;
    if (o.arrow) arrowEl = link(g, { points: [[xL + U * 1, o.y + hs * 0.7], [xR - U * 1, o.y + hs * 0.7]], arrow: 'end' });
    const rowH = (o.h - headH) / n;
    const rows = o.rows.map((r, i) => {
      const ry = ruleY + i * rowH, mid = ry + rowH / 2, rg = el('g', {}, g);
      const meter = r.va != null || r.vb != null;
      const vy = meter ? mid - U * 0.3 : mid + vs * 0.36;
      const div = i > 0 ? el('line', { x1: o.x, x2: o.x + o.w, y1: ry, y2: ry, stroke: C.rule, 'stroke-width': LW.grid }, rg) : null;
      const lab = textEl(rg, { x: cx, y: mid + U * 0.8, text: r.label, size: U * 2.3, weight: 700, color: C.muted, anchor: 'middle', ls: 0.1, maxW: cw - U * 2, lh: 1.35 });
      if (lab.lines.length > 1) lab.el.setAttribute('y', mid + U * 0.8 - lab.height / 2);
      const ta = textEl(rg, { x: xL - inset, y: vy, text: r.a, size: vs, weight: 700, color: C.ink, anchor: 'end' });
      const tb = textEl(rg, { x: xR + inset, y: vy, text: r.b, size: vs, weight: 700, color: C.ink, anchor: 'start' });
      const len = sw - inset - U * 3, bh = U * 0.9, my = mid + U * 1.5;
      let ba = null, bb = null;
      if (meter) {
        el('line', { x1: xL - inset - len, x2: xL - inset, y1: my + bh / 2, y2: my + bh / 2, stroke: C.rule, 'stroke-width': LW.grid }, rg);
        el('line', { x1: xR + inset, x2: xR + inset + len, y1: my + bh / 2, y2: my + bh / 2, stroke: C.rule, 'stroke-width': LW.grid }, rg);
        ba = el('rect', { x: xL - inset, y: my, width: 0, height: bh, rx: bh / 2, fill: o.accent === 'left' ? C.accent : C.mark }, rg);
        bb = el('rect', { x: xR + inset, y: my, width: 0, height: bh, rx: bh / 2, fill: o.accent === 'right' ? C.accent : C.mark }, rg);
      }
      return { rg, ta, tb, lab, ba, bb, len, va: r.va ?? 0, vb: r.vb ?? 0, fa: 0, fb: 0, p: 0 };
    });
    const applyRow = R => {
      const k = ease.enter(clamp(R.p * 1.4)), kb = ease.enter(clamp((R.p - 0.15) / 0.85));
      R.rg.setAttribute('opacity', R.p > 0 ? 1 : 0);
      show(R.lab.el, k, U * 0.5);
      R.ta.el.setAttribute('opacity', kb); R.ta.el.setAttribute('transform', `translate(${((1 - kb) * U * 1.5).toFixed(2)} 0)`);
      R.tb.el.setAttribute('opacity', kb); R.tb.el.setAttribute('transform', `translate(${(-(1 - kb) * U * 1.5).toFixed(2)} 0)`);
      R.ta.el.setAttribute('fill', mix(C.ink, C.accent, R.fa)); R.tb.el.setAttribute('fill', mix(C.ink, C.accent, R.fb));
      R.lab.el.setAttribute('fill', mix(C.muted, C.ink, Math.max(R.fa, R.fb)));
      if (R.ba) {
        const gk = ease.enter(clamp((R.p - 0.25) / 0.75)), wa = R.len * clamp(R.va) * gk, wb = R.len * clamp(R.vb) * gk;
        R.ba.setAttribute('x', xL - inset - wa); R.ba.setAttribute('width', wa);
        R.bb.setAttribute('width', wb);
        const baseA = o.accent === 'left' ? C.accent : C.mark, baseB = o.accent === 'right' ? C.accent : C.mark;
        R.ba.setAttribute('fill', mix(baseA, C.accent, R.fa)); R.bb.setAttribute('fill', mix(baseB, C.accent, R.fb));
      }
    };
    rows.forEach(applyRow);
    const api = {
      g, rows,
      draw(p) {
        if (band) { const k = ease.enter(clamp(p / 0.5)); band.setAttribute('opacity', k); bandTop.setAttribute('opacity', k); }
        show(hA, ease.enter(clamp(p / 0.6)), U * 0.6); show(hB, ease.enter(clamp((p - 0.15) / 0.6)), U * 0.6);
        const q = ease.move(clamp((p - 0.25) / 0.75));
        hr.setAttribute('x1', cx - o.w / 2 * q); hr.setAttribute('x2', cx + o.w / 2 * q); hr.setAttribute('opacity', q > 0 ? 1 : 0);
        if (arrowEl) arrowEl.draw(clamp((p - 0.4) / 0.6));
      },
      row(i, p) { rows[i].p = clamp(p); applyRow(rows[i]); },
      set(t, times) { times.forEach((t0, i) => api.row(i, S.seg(t, t0, t0 + D.slow, ease.linear))); },
      focus(i, side, f) { const R = rows[i]; if (side === 'a') R.fa = clamp(f); else R.fb = clamp(f); applyRow(R); },
    };
    return api;
  }

  // ---------------------------------------------------------------------------------------------
  /** 时间线：按真实间隔排布（at 是数值，比如年份）。横屏默认横向、标签上下交替；竖屏默认竖向、标签在右。
   *  opts x, y, w, h, items: [{at, date（显示的日期文字，默认 at）, title, sub, major（转折点：强调色实心点）, side: 'above' | 'below'}],
   *       from, to（轴的范围，默认取首尾）, dir: 'auto' | 'h' | 'v', pad（首尾留白）, ticks（每隔几个单位画一个小刻度，默认 1；0 不画）
   *  draw(p)：轴线从头画到尾，笔头经过哪个点，那个事件就出现（p 用 inOut 时，when(i, a, b) 返回第 i 个事件出现的秒数）。
   *  prime(q)：幽灵态（先以 14% 浓度出现整条线）；focus(i, f)：强调一个事件（点变强调色并加一圈环）。太挤时标签自动错开，点仍在真实位置。 */
  function timeline(parent, o) {
    let dir = o.dir || 'auto';
    if (dir === 'auto') dir = PORTRAIT ? 'v' : 'h';
    const items = o.items, n = items.length, g = el('g', {}, parent);
    const from = o.from ?? items[0].at, to = o.to ?? items[n - 1].at, span = Math.max(1e-6, to - from);
    const ds = U * (dir === 'v' ? 4.6 : 4.2), ts = U * (dir === 'v' ? 3.8 : 3.3), ss = U * (dir === 'v' ? 2.8 : 2.5);
    const ghostAxis = el('line', { stroke: C.ink, 'stroke-width': LW.line, opacity: 0 }, g);
    const axis = el('line', { stroke: C.ink, 'stroke-width': LW.line, 'stroke-linecap': 'round' }, g);
    const tip = el('path', { fill: C.ink }, g);
    const tickG = el('g', {}, g);
    const evs = [];
    let pos, A0, A1;
    if (dir === 'h') {
      const ay = o.axisY ?? o.y + o.h * 0.5, pad = o.pad ?? U * 8;
      A0 = o.x; A1 = o.x + o.w;
      pos = v => o.x + pad + (v - from) / span * (o.w - pad * 2);
      axis.setAttribute('y1', ay); axis.setAttribute('y2', ay);
      Object.entries({ x1: A0, x2: A1, y1: ay, y2: ay }).forEach(([k, v]) => ghostAxis.setAttribute(k, v));
      tip.setAttribute('d', `M ${A1} ${ay} l ${-U * 1.3} ${-U * 0.6} v ${U * 1.2} z`);
      const step = o.ticks ?? 1;
      if (step > 0 && span / step <= 80) for (let v = Math.ceil(from / step) * step; v <= to + 1e-9; v += step) {
        const xx = pos(v); el('line', { x1: xx, x2: xx, y1: ay - U * 0.5, y2: ay + U * 0.5, stroke: C.hair, 'stroke-width': LW.grid, 'data-at': v }, tickG);
      }
      const blockW = it => Math.max(measure(String(it.date ?? it.at), ds, 700), measure(it.title || '', ts, 700), measure(it.sub || '', ss, 500));
      const lastEnd = { above: -1e9, below: -1e9 }, lastStem = { above: 0, below: 0 };
      items.forEach((it, i) => {
        const side = it.side || (i % 2 ? 'below' : 'above'), x = pos(it.at), bw = blockW(it);
        let anchor = 'middle', lx = x;
        if (x - bw / 2 < o.x) { anchor = 'start'; lx = Math.max(o.x, x - U * 1.5); }
        else if (x + bw / 2 > o.x + o.w) { anchor = 'end'; lx = Math.min(o.x + o.w, x + U * 1.5); }
        const left = anchor === 'middle' ? lx - bw / 2 : anchor === 'start' ? lx : lx - bw;
        let stem = o.stem ?? U * 6;
        if (left < lastEnd[side] + U * 2) stem = lastStem[side] + U * (side === 'above' ? 9.5 : 10);
        lastEnd[side] = left + bw; lastStem[side] = stem;
        const eg = el('g', {}, g);
        const up = side === 'above';
        const lines = [{ t: String(it.date ?? it.at), s: ds, w: 600, c: it.major ? C.accent : C.ink2, serif: true }, { t: it.title, s: ts, w: 700, c: C.ink }];
        if (it.sub) lines.push({ t: it.sub, s: ss, w: 500, c: C.ink2 });
        const gaps = lines.map(l => l.s * 1.38);
        let ys = [];
        if (up) { let yb = ay - stem - U * 1.0 - lines[lines.length - 1].s * 0.12; for (let k = lines.length - 1; k >= 0; k--) { ys[k] = yb; yb -= gaps[k - 1] || 0; } }
        else { let yb = ay + stem + U * 1.0 + lines[0].s * 0.88; lines.forEach((l, k) => { ys[k] = yb; yb += gaps[k + 1] || 0; }); }
        const tEls = lines.map((l, k) => l.t ? textEl(eg, { x: lx, y: ys[k], text: l.t, size: l.s, weight: l.w, color: l.c, anchor, serif: l.serif }) : null);
        const sEl = el('line', { x1: x, x2: x, y1: up ? ay - U * 1.2 : ay + U * 1.2, y2: up ? ay - stem : ay + stem, stroke: C.hair, 'stroke-width': LW.hair }, eg);
        evs.push({ it, eg, x, y: ay, tEls, sEl, side, frac: (x - A0) / (A1 - A0) });
      });
    } else {
      const ax = o.x + (o.axisX ?? o.w * 0.3), pad = o.pad ?? U * 6;
      A0 = o.y; A1 = o.y + o.h;
      pos = v => o.y + pad + (v - from) / span * (o.h - pad * 2);
      axis.setAttribute('x1', ax); axis.setAttribute('x2', ax);
      Object.entries({ x1: ax, x2: ax, y1: A0, y2: A1 }).forEach(([k, v]) => ghostAxis.setAttribute(k, v));
      tip.setAttribute('d', `M ${ax} ${A1} l ${-U * 0.6} ${-U * 1.3} h ${U * 1.2} z`);
      const step = o.ticks ?? 1;
      if (step > 0 && span / step <= 80) for (let v = Math.ceil(from / step) * step; v <= to + 1e-9; v += step) {
        const yy = pos(v); el('line', { x1: ax - U * 0.5, x2: ax + U * 0.5, y1: yy, y2: yy, stroke: C.hair, 'stroke-width': LW.grid }, tickG);
      }
      const tx = ax + U * 4, avail = o.x + o.w - tx;
      let lastBottom = -1e9;
      items.forEach(it => {
        const y = pos(it.at), eg = el('g', {}, g);
        const tl = wrap(it.title, avail, ts, 700), sl = it.sub ? wrap(it.sub, avail, ss, 500) : [];
        const bh = ts * 0.88 + (tl.length - 1) * ts * 1.3 + (sl.length ? U * 1.2 + ss * 0.88 + (sl.length - 1) * ss * 1.4 : 0) + ss * 0.3;
        let ly = y - ts * 0.5;
        if (ly < lastBottom + U * 2.2) ly = lastBottom + U * 2.2;
        lastBottom = ly + bh;
        const b0 = ly + ts * 0.88;
        const tEls = [
          textEl(eg, { x: ax - U * 3, y: b0, text: String(it.date ?? it.at), size: ds, weight: 600, serif: true, color: it.major ? C.accent : C.ink2, anchor: 'end' }),
          textEl(eg, { x: tx, y: b0, lines: tl, size: ts, weight: 700, color: C.ink, lh: 1.3 }),
          sl.length ? textEl(eg, { x: tx, y: b0 + (tl.length - 1) * ts * 1.3 + ts * 0.12 + U * 1.2 + ss * 0.88, lines: sl, size: ss, weight: 500, color: C.ink2, lh: 1.4 }) : null,
        ];
        const lyc = ly + ts * 0.5, xm = ax + U * 2.2;
        const sEl = el('path', { d: Math.abs(lyc - y) < 1 ? `M ${ax + U * 1.2} ${y} H ${tx - U * 0.8}` : `M ${ax + U * 1.2} ${y} H ${xm} V ${lyc} H ${tx - U * 0.8}`, fill: 'none', stroke: C.hair, 'stroke-width': LW.hair }, eg);
        evs.push({ it, eg, x: ax, y, tEls, sEl, frac: (y - A0) / (A1 - A0) });
      });
    }
    evs.forEach(e => {
      e.ring = el('circle', { cx: e.x, cy: e.y, r: U * 2, fill: 'none', stroke: C.accent, 'stroke-width': LW.hair, opacity: 0 }, g);
      e.dot = el('circle', { cx: e.x, cy: e.y, r: e.it.major ? U * 1.05 : U * 0.8, fill: e.it.major ? C.accent : C.paper, stroke: e.it.major ? C.accent : C.ink, 'stroke-width': LW.line }, g);
      e.f = 0; e.k = 0;
    });
    let ghost = 0;
    const applyEv = e => {
      e.eg.setAttribute('opacity', Math.max(e.k, ghost * GHOST).toFixed(4)); e.eg.setAttribute('transform', dir === 'h' ? `translate(0 ${((1 - e.k) * RISE * (e.side === 'below' ? -1 : 1)).toFixed(2)})` : `translate(${((1 - e.k) * -RISE).toFixed(2)} 0)`);
      const dk = ease.enter(clamp(e.k * 1.6));
      e.dot.setAttribute('opacity', dk > 0 ? 1 : (ghost * GHOST).toFixed(4));
      e.dot.setAttribute('r', ((e.it.major ? U * 1.05 : U * 0.8) * (dk > 0 ? 0.4 + 0.6 * dk : 1) * (1 + 0.25 * e.f)).toFixed(3));
      e.dot.setAttribute('fill', e.it.major ? C.accent : mix(C.paper, C.accent, e.f));
      e.dot.setAttribute('stroke', e.it.major ? C.accent : mix(C.ink, C.accent, e.f));
      e.ring.setAttribute('opacity', e.f); e.ring.setAttribute('r', (U * (1.4 + 0.8 * e.f)).toFixed(3));
      if (e.tEls[0]) e.tEls[0].el.setAttribute('fill', e.it.major ? C.accent : mix(C.ink2, C.accent, e.f));
    };
    const api = {
      g, events: evs,
      /** 幽灵态：整条时间线先以 14% 的浓度出现 */
      prime(q) { ghost = clamp(q); ghostAxis.setAttribute('opacity', (ghost * GHOST).toFixed(4)); evs.forEach(applyEv); },
      draw(p) {
        const hp = clamp(p), head = lerp(A0, A1, hp);
        if (dir === 'h') { axis.setAttribute('x1', A0); axis.setAttribute('x2', head); }
        else { axis.setAttribute('y1', A0); axis.setAttribute('y2', head); }
        axis.setAttribute('opacity', hp > 0 ? 1 : 0);
        tip.setAttribute('opacity', ease.enter(clamp((hp - 0.97) / 0.03)));
        Array.from(tickG.children).forEach(tk => {
          const v = dir === 'h' ? parseFloat(tk.getAttribute('x1')) : parseFloat(tk.getAttribute('y1'));
          tk.setAttribute('opacity', (v - A0) / (A1 - A0) <= hp ? 1 : 0);
        });
        evs.forEach(e => { e.k = ease.enter(clamp((hp - e.frac) / 0.1)); applyEv(e); });
      },
      focus(i, f) { evs[i].f = clamp(f); applyEv(evs[i]); },
      /** 轴线用 seg(t, a, b, ease.inOut) 画时，第 i 个事件出现的秒数 */
      when(i, a, b) { let lo = 0, hi = 1; for (let k = 0; k < 40; k++) { const m = (lo + hi) / 2; if (S.ease.inOut(m) < evs[i].frac) lo = m; else hi = m; } return a + (lo + hi) / 2 * (b - a); },
    };
    return api;
  }

  // ---------------------------------------------------------------------------------------------
  /** 注释引线：锚点小圆点 → 折线（默认先竖后横）→ 一段横线托着文字（文字在横线上方，补充说明在下方）。
   *  opts x, y（锚点）, tx, ty（引线拐到这里，再横着走）, text, sub, side: 'right' | 'left'（文字在拐点的哪一边，默认按 tx 和 x 的关系）,
   *       elbow（默认 true：从锚点竖直走到 ty 再横走，tx 只决定文字起点；false 时从锚点斜线连到 (tx, ty)）,
   *       accent（默认 true：点和线用强调色）, size（默认 2.8u）, w（横线长度，默认按文字宽度）
   *  draw(p)：点先出现，再描线，最后文字上升 */
  function callout(parent, o) {
    const g = el('g', {}, parent), size = o.size || U * 2.8, ss = U * 2.3;
    const right = (o.side || (o.tx >= o.x ? 'right' : 'left')) === 'right';
    const col = o.accent === false ? C.ink : C.accent;
    const tw = Math.max(measure(o.text, size, 700), o.sub ? measure(o.sub, ss, 500) : 0);
    const lw = o.w || tw + U * 1.5, x2 = right ? o.tx + lw : o.tx - lw;
    const elbow = o.elbow !== false;
    const pts = elbow ? [[o.x, o.y], [o.x, o.ty], [x2, o.ty]] : [[o.x, o.y], [o.tx, o.ty], [x2, o.ty]];
    const d = `M ${pts[0][0]} ${pts[0][1]} L ${pts[1][0]} ${pts[1][1]} L ${pts[2][0]} ${pts[2][1]}`;
    const path = el('path', { d, fill: 'none', stroke: col, 'stroke-width': LW.hair, 'stroke-linejoin': 'round' }, g);
    const dot = el('circle', { cx: o.x, cy: o.y, r: U * 0.6, fill: col }, g);
    const halo = el('circle', { cx: o.x, cy: o.y, r: U * 1.6, fill: 'none', stroke: col, 'stroke-width': LW.grid, opacity: 0 }, g);
    const tx0 = right ? o.tx + U * 0.4 : o.tx - U * 0.4, anchor = right ? 'start' : 'end';
    const tg = el('g', {}, g);
    const t1 = textEl(tg, { x: tx0, y: o.ty - U * 1.1, text: o.text, size, weight: 700, color: C.ink, anchor });
    const t2 = o.sub ? textEl(tg, { x: tx0, y: o.ty + U * 0.9 + ss * 0.95, text: o.sub, size: ss, weight: 500, color: C.ink2, anchor }) : null;
    return {
      g, points: pts,
      draw(p) {
        const k = ease.enter(clamp(p / 0.25));
        dot.setAttribute('opacity', k > 0 ? 1 : 0); dot.setAttribute('r', (U * 0.6 * k).toFixed(3));
        halo.setAttribute('opacity', (k * (1 - clamp((p - 0.2) / 0.5)) * 0.9).toFixed(3)); halo.setAttribute('r', (U * (0.8 + 1.6 * clamp(p / 0.6))).toFixed(3));
        drawOn(path, ease.move(clamp((p - 0.1) / 0.5)));
        path.setAttribute('opacity', p > 0.1 ? 1 : 0);
        show(tg, ease.enter(clamp((p - 0.45) / 0.55)), U * 0.6);
      },
    };
  }

  /** 差值括号（两点之间差多少）：竖线 + 两端短横 + 中间一段文字。opts x, y1, y2, text, sub, side: 'right' | 'left', accent（默认 true）
   *  draw(p)：从中点向两端展开，再出文字 */
  function bracket(parent, o) {
    const g = el('g', {}, parent), right = (o.side || 'right') === 'right', s = right ? 1 : -1;
    const col = o.accent === false ? C.ink : C.accent, cap = U * 1.0, mid = (o.y1 + o.y2) / 2, half = Math.abs(o.y2 - o.y1) / 2;
    const ln = el('path', { fill: 'none', stroke: col, 'stroke-width': LW.line, 'stroke-linejoin': 'round' }, g);
    const tg = el('g', {}, g);
    const tx = o.x + s * U * 2.2, size = o.size || U * 3;
    textEl(tg, { x: tx, y: mid + (o.sub ? -U * 0.4 : size * 0.36), text: o.text, size, weight: 700, color: col, anchor: right ? 'start' : 'end' });
    if (o.sub) textEl(tg, { x: tx, y: mid + U * 0.6 + U * 2.3, text: o.sub, size: U * 2.3, weight: 500, color: C.ink2, anchor: right ? 'start' : 'end' });
    return {
      g,
      draw(p) {
        const k = ease.move(clamp(p / 0.6)), hh = half * k;
        ln.setAttribute('d', `M ${o.x - s * cap} ${mid - hh} H ${o.x} V ${mid + hh} H ${o.x - s * cap}`);
        ln.setAttribute('opacity', k > 0 ? 1 : 0);
        show(tg, ease.enter(clamp((p - 0.45) / 0.55)), U * 0.6);
      },
    };
  }

  // ---------------------------------------------------------------------------------------------
  /** 好看的刻度：返回 [0, step, 2step, ...] 直到不小于 max */
  function niceTicks(max, n = 4, min = 0) {
    const raw = (max - min) / n, mag = Math.pow(10, Math.floor(Math.log10(raw || 1)));
    const step = [1, 2, 2.5, 5, 10].map(k => k * mag).find(s => s >= raw) || 10 * mag;
    const out = [];
    for (let v = Math.floor(min / step) * step; v < max + step * 0.999; v += step) out.push(+v.toFixed(10));
    return out;
  }

  /** 柱状图（一个系列，轴从 0 开始）：默认灰色柱，focus 的那根用强调色；数值直接标在柱顶（不另画纵轴）。
   *  opts x, y, w, h（整个区域，含柱顶数值和下方类目）, data: [{label, value}], max（默认取好看的整数）, unit, prefix, digits,
   *       horizontal（横向条形：类目多、名字长或竖屏时用）, barW, labelW（横向时类目列宽）, grid（淡网格线，默认 false）
   *  draw(p)：柱子从基线依次长出（同一时刻最多两根在长），数值跟着滚动。focus(i, f)：第 i 根变强调色。top(i)：柱顶上方一点 [x, y] */
  function bars(parent, o) {
    const data = o.data, n = data.length, digits = o.digits ?? 0, unit = o.unit || '', prefix = o.prefix || '';
    const ticks = niceTicks(Math.max(...data.map(d => d.value)), 4), max = o.max ?? ticks[ticks.length - 1];
    const g = el('g', {}, parent), hz = !!o.horizontal;
    const vSize = o.valueSize || U * 2.9, lSize = o.labelSize || U * 2.5;
    const bs = data.map(() => ({ f: 0, k: 0 }));
    let geo;
    if (!hz) {
      const base = o.y + o.h - U * 6.2, plotTop = o.y + U * 5, slot = o.w / n, bw = Math.min(slot * 0.5, o.barW || U * 13);
      if (o.grid) ticks.slice(1).forEach(v => { const yy = base - (base - plotTop) * v / max; el('line', { x1: o.x, x2: o.x + o.w, y1: yy, y2: yy, stroke: C.rule, 'stroke-width': LW.grid }, g); });
      el('line', { x1: o.x, x2: o.x + o.w, y1: base, y2: base, stroke: C.ink, 'stroke-width': LW.line, class: 'ed-base' }, g);
      geo = data.map((d, i) => {
        const cx = o.x + slot * (i + 0.5);
        const bar = el('path', { fill: C.mark }, g);
        const val = textEl(g, { x: cx, y: base, text: '', size: vSize, weight: 700, color: C.ink, anchor: 'middle' });
        const lab = textEl(g, { x: cx, y: base + U * 1.4 + lSize * 0.88, text: d.label, size: lSize, weight: 500, color: C.ink2, anchor: 'middle', maxW: slot * 0.92, lh: 1.3 });
        return { cx, bar, val, lab, hmax: (base - plotTop) * clamp(d.value / max), base, bw };
      });
    } else {
      const labelW = o.labelW || Math.min(o.w * 0.3, Math.max(...data.map(d => measure(d.label, lSize))) + U * 2.5), valW = U * 12;
      const x0 = o.x + labelW, len = o.w - labelW - valW, rowH = o.h / n, bh = Math.min(rowH * 0.5, o.barW || U * 5);
      el('line', { x1: x0, x2: x0, y1: o.y, y2: o.y + o.h, stroke: C.ink, 'stroke-width': LW.line, class: 'ed-base' }, g);
      geo = data.map((d, i) => {
        const cy = o.y + rowH * (i + 0.5);
        const bar = el('path', { fill: C.mark }, g);
        const val = textEl(g, { x: x0, y: cy + vSize * 0.36, text: '', size: vSize, weight: 700, color: C.ink });
        const lab = textEl(g, { x: x0 - U * 1.4, y: cy + lSize * 0.36, text: d.label, size: lSize, weight: 500, color: C.ink2, anchor: 'end' });
        return { cy, bar, val, lab, lmax: len * clamp(d.value / max), x0, bh };
      });
    }
    const r = U * 0.35;
    const apply = i => {
      const G = geo[i], B = bs[i], d = data[i];
      const col = mix(o.color || C.mark, C.accent, B.f);
      G.bar.setAttribute('fill', col);
      G.lab.el.setAttribute('fill', mix(C.ink2, C.ink, B.f));
      G.lab.el.setAttribute('font-weight', B.f > 0.5 ? 700 : 500);
      const txt = B.k > 0 ? prefix + fmt(d.value * B.k, digits, o.sep) + unit : '';
      G.val.el.firstChild.textContent = txt;
      G.val.el.setAttribute('opacity', clamp(B.k * 3));
      if (!hz) {
        const hh = G.hmax * B.k, x = G.cx - G.bw / 2, rr = Math.min(r, G.bw / 2, hh);
        G.bar.setAttribute('d', hh < 0.5 ? '' : `M ${x} ${G.base} V ${G.base - hh + rr} Q ${x} ${G.base - hh} ${x + rr} ${G.base - hh} H ${x + G.bw - rr} Q ${x + G.bw} ${G.base - hh} ${x + G.bw} ${G.base - hh + rr} V ${G.base} Z`);
        G.val.el.setAttribute('y', (G.base - hh - U * 1.2).toFixed(2));
      } else {
        const ll = G.lmax * B.k, y = G.cy - G.bh / 2, rr = Math.min(r, G.bh / 2, ll);
        G.bar.setAttribute('d', ll < 0.5 ? '' : `M ${G.x0} ${y} H ${G.x0 + ll - rr} Q ${G.x0 + ll} ${y} ${G.x0 + ll} ${y + rr} V ${y + G.bh - rr} Q ${G.x0 + ll} ${y + G.bh} ${G.x0 + ll - rr} ${y + G.bh} H ${G.x0} Z`);
        G.val.el.setAttribute('x', (G.x0 + ll + U * 1.2).toFixed(2)); G.val.el.firstChild.setAttribute('x', (G.x0 + ll + U * 1.2).toFixed(2));
      }
    };
    data.forEach((_, i) => apply(i));
    return {
      g,
      draw(p) {
        g.querySelectorAll('.ed-base').forEach(b => b.setAttribute('opacity', ease.enter(clamp(p * 5))));
        bs.forEach((B, i) => { B.k = ease.enter(clamp(p * (1 + (n - 1) * 0.5) - i * 0.5)); apply(i); });
        geo.forEach(G => show(G.lab.el, ease.enter(clamp(p * 3)), U * 0.4));
      },
      focus(i, f) { bs[i].f = clamp(f); apply(i); },
      top(i) { const G = geo[i]; return hz ? [G.x0 + G.lmax, G.cy] : [G.cx, G.base - G.hmax - U * 5]; },
    };
  }

  /** 折线图（时间序列）：主系列默认强调色、其余灰色；线从左往右画出，笔头带圆点和实时数值，画完在右端标名字和终值。
   *  opts x, y, w, h（整个区域，含刻度）, xs（横轴数值，默认 0,1,2…）, series: [{name, values, color, width, area（线下铺浅色）, runner（笔头实时数值）}],
   *       between: [a, b]（在第 a、b 两个系列之间铺强调色浅底，突出"差距"）,
   *       min（默认 0）, max（默认好看的整数）, yTicks（默认 4）, unit, digits, xTicks（要标的横轴值）, xFormat（横轴文字）, yFormat, endW（右侧标签区宽度）
   *  axes(p)：坐标轴入场（先于 draw）；draw(p)：所有系列同步画出（p 是横轴进度）。mark(i, s, f)：圈出第 s 个系列的第 i 个点并画垂线。
   *  pt(i, s)、ptAt(x, s)：点的屏幕坐标（给标注用） */
  function line(parent, o) {
    const series = o.series, xs = o.xs || series[0].values.map((_, i) => i), digits = o.digits ?? 0, unit = o.unit || '';
    const xmin = o.xmin ?? xs[0], xmax = o.xmax ?? xs[xs.length - 1];
    const ymin = o.min ?? 0, ticks = niceTicks(Math.max(...series.flatMap(s => s.values)), o.yTicks || 4, ymin), ymax = o.max ?? ticks[ticks.length - 1];
    const padL = o.padL ?? U * 7, padB = U * 5, padR = o.endW ?? U * 17, padT = U * 2;
    // 绘图区对齐整像素：竖直、水平的边缘不会出现半透明的抗锯齿列
    const X0 = Math.round(o.x + padL), X1 = Math.round(o.x + o.w - padR), Y0 = Math.round(o.y + padT), Y1 = Math.round(o.y + o.h - padB);
    const px = v => X0 + (v - xmin) / (xmax - xmin) * (X1 - X0), py = v => Y1 - (v - ymin) / (ymax - ymin) * (Y1 - Y0);
    const g = el('g', {}, parent), ax = el('g', {}, g);
    ticks.filter(v => v <= ymax + 1e-9).forEach((v, i, arr) => {
      if (v > ymin) el('line', { x1: X0, x2: X1, y1: py(v), y2: py(v), stroke: C.rule, 'stroke-width': LW.grid }, ax);
      const lab = o.yFormat ? o.yFormat(v) : fmt(v, 0) + (i === arr.length - 1 ? unit : '');
      textEl(ax, { x: X0 - U * 1.2, y: py(v) + U * 0.8, text: lab, size: U * 2.1, weight: 500, color: C.muted, anchor: 'end' });
    });
    el('line', { x1: X0, x2: X1, y1: Y1, y2: Y1, stroke: C.ink, 'stroke-width': LW.line }, ax);
    (o.xTicks || [xmin, xmax]).forEach(v => {
      el('line', { x1: px(v), x2: px(v), y1: Y1, y2: Y1 + U * 0.8, stroke: C.ink, 'stroke-width': LW.hair }, ax);
      textEl(ax, { x: px(v), y: Y1 + U * 3.6, text: o.xFormat ? o.xFormat(v) : String(v), size: U * 2.2, weight: 500, color: C.muted, anchor: 'middle' });
    });
    const S2 = series.map((s, si) => {
      const col = s.color || (si === 0 ? C.accent : C.mark);
      const area = s.area ? el('path', { fill: col, opacity: C.dark ? 0.12 : 0.08 }, g) : null;
      const path = el('path', { fill: 'none', stroke: col, 'stroke-width': s.width || (si === 0 ? LW.data : LW.strong), 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }, g);
      const dot = el('circle', { r: U * 0.8, fill: col, stroke: C.paper, 'stroke-width': U * 0.3 }, g);
      const run = s.runner ? textEl(g, { x: 0, y: 0, text: '', size: U * 2.6, weight: 700, color: C.ink, anchor: 'end' }) : null;
      const eg = el('g', {}, g);
      const ey = py(s.values[s.values.length - 1]);
      return { s, col, area, path, dot, run, eg, ey };
    });
    // 右端标签：太近时上下推开
    const ends = S2.map((q, i) => ({ i, y: q.ey })).sort((a, b) => a.y - b.y);
    for (let k = 1; k < ends.length; k++) if (ends[k].y - ends[k - 1].y < U * 7) ends[k].y = ends[k - 1].y + U * 7;
    ends.forEach(e => {
      const q = S2[e.i], ex = X1 + U * 2;
      textEl(q.eg, { x: ex, y: e.y - U * 0.6, text: q.s.name, size: U * 2.3, weight: 500, color: C.ink2 });
      q.endVal = textEl(q.eg, { x: ex, y: e.y + U * 3.0, text: fmt(q.s.values[q.s.values.length - 1], digits, o.sep) + unit, size: U * 3.0, weight: 700, color: C.ink });
      el('line', { x1: X1 + U * 0.6, x2: ex - U * 0.6, y1: q.ey, y2: e.y + U * 0.6, stroke: q.col, 'stroke-width': LW.hair }, q.eg);
    });
    const valAt = (s, x) => {
      if (x <= xs[0]) return s.values[0];
      for (let i = 1; i < xs.length; i++) if (x <= xs[i]) return lerp(s.values[i - 1], s.values[i], (x - xs[i - 1]) / (xs[i] - xs[i - 1]));
      return s.values[s.values.length - 1];
    };
    const marks = {};
    const gapFill = o.between ? el('path', { fill: C.accent, opacity: C.dark ? 0.16 : 0.1 }, g) : null;
    if (gapFill) g.insertBefore(gapFill, S2[0].area || S2[0].path);
    const api = {
      g, px, py, X0, X1, Y0, Y1,
      /** 坐标轴入场（不调用时坐标轴一直显示） */
      axes(p) { show(ax, ease.enter(clamp(p)), U * 0.5); },
      draw(p) {
        const q = clamp(p), xh = lerp(xmin, xmax, q);
        if (gapFill) {
          const [ia, ib] = o.between, top = [], bot = [];
          xs.forEach((x, i) => { if (x <= xh) { top.push([px(x), py(series[ia].values[i])]); bot.push([px(x), py(series[ib].values[i])]); } });
          if (q > 0) { top.push([px(xh), py(valAt(series[ia], xh))]); bot.push([px(xh), py(valAt(series[ib], xh))]); }
          const pts = top.concat(bot.reverse());
          gapFill.setAttribute('d', pts.length > 3 ? 'M ' + pts.map(p2 => `${p2[0].toFixed(2)} ${p2[1].toFixed(2)}`).join(' L ') + ' Z' : '');
        }
        S2.forEach(Q => {
          const pts = [];
          xs.forEach((x, i) => { if (x <= xh) pts.push([px(x), py(Q.s.values[i])]); });
          if (q > 0) pts.push([px(xh), py(valAt(Q.s, xh))]);
          const d = pts.length > 1 ? 'M ' + pts.map(p2 => `${p2[0].toFixed(2)} ${p2[1].toFixed(2)}`).join(' L ') : '';
          Q.path.setAttribute('d', d);
          if (Q.area) Q.area.setAttribute('d', pts.length > 1 ? d + ` L ${pts[pts.length - 1][0].toFixed(2)} ${Y1} L ${pts[0][0].toFixed(2)} ${Y1} Z` : '');
          const hd = pts[pts.length - 1] || [px(xs[0]), py(Q.s.values[0])];
          Q.dot.setAttribute('opacity', q > 0 ? 1 : 0);
          Q.dot.setAttribute('cx', hd[0].toFixed(2)); Q.dot.setAttribute('cy', hd[1].toFixed(2));
          if (Q.run) {
            const vis = q > 0.02 && q < 1;
            Q.run.el.setAttribute('opacity', vis ? 1 : 0);
            const rt = fmt(valAt(Q.s, xh), digits, o.sep) + unit;
            const rx = Math.max(hd[0] - U * 1.4, X0 + U * 1.5 + measure(rt, U * 2.6, 700));
            Q.run.el.setAttribute('x', rx.toFixed(2)); Q.run.el.setAttribute('y', (hd[1] - U * 1.6).toFixed(2)); Q.run.el.firstChild.setAttribute('x', rx.toFixed(2));
            Q.run.el.firstChild.textContent = rt;
          }
          show(Q.eg, ease.enter(clamp((q - 0.96) / 0.04)), U * 0.5);
        });
      },
      mark(i, si, f) {
        const key = i + ':' + si;
        if (!marks[key]) {
          const mg = el('g', {}, g), x = px(xs[i]), y = py(series[si].values[i]);
          el('line', { x1: x, x2: x, y1: y + U * 1.4, y2: Y1, stroke: C.ink2, 'stroke-width': LW.hair, 'stroke-dasharray': `${U * 0.4} ${U * 0.4}` }, mg);
          el('circle', { cx: x, cy: y, r: U * 1.3, fill: 'none', stroke: C.accent, 'stroke-width': LW.line }, mg);
          marks[key] = mg;
        }
        show(marks[key], ease.enter(clamp(f)), 0);
      },
      pt(i, si = 0) { return [px(xs[i]), py(series[si].values[i])]; },
      ptAt(x, si = 0) { return [px(x), py(valAt(series[si], x))]; },
    };
    return api;
  }

  /** 占比环：一个占比（value 0～1，强调色弧 + 灰色底环），或几部分（parts，第一部分强调色，其余按灰阶）。中间是宋体大数字。
   *  opts cx, cy, r, thick（默认 r 的 15%）, value | parts: [{label, value, note（图例里代替百分比的文字）}], label（中间数字下方的说明）, digits, unit（默认 '%'）,
   *       center（中间显示的数值，默认 value×100 或第一部分的占比）, legend: {x, y}（几部分时的图例位置）
   *  draw(p)：从 12 点方向顺时针扫出，数字跟着滚动 */
  function ring(parent, o) {
    const g = el('g', {}, parent), r = o.r, th = o.thick ?? r * 0.15, digits = o.digits ?? 0, unit = o.unit ?? '%';
    const parts = o.parts || [{ label: o.label, value: o.value }, { label: '', value: 1 - o.value, track: true }];
    const tot = parts.reduce((a, b) => a + b.value, 0) || 1;
    const colors = o.colors || [C.accent, ...C.grays.slice(1)];
    const track = el('circle', { cx: o.cx, cy: o.cy, r, fill: 'none', stroke: C.rule, 'stroke-width': th, opacity: 0 }, g);
    const gapA = o.parts ? U * 0.4 / r : 0;
    let acc = 0;
    const segs = parts.map((pt, i) => {
      const a0 = acc / tot * Math.PI * 2, a1 = (acc + pt.value) / tot * Math.PI * 2; acc += pt.value;
      const e = pt.track ? null : el('path', { fill: 'none', stroke: colors[i] || C.mark, 'stroke-width': th, 'stroke-linecap': 'butt' }, g);
      return { a0, a1, e };
    });
    const arc = (a0, a1) => {
      if (a1 - a0 < 1e-4) return '';
      const p0 = [o.cx + r * Math.sin(a0), o.cy - r * Math.cos(a0)], p1 = [o.cx + r * Math.sin(a1), o.cy - r * Math.cos(a1)];
      return `M ${p0[0].toFixed(2)} ${p0[1].toFixed(2)} A ${r} ${r} 0 ${a1 - a0 > Math.PI ? 1 : 0} 1 ${p1[0].toFixed(2)} ${p1[1].toFixed(2)}`;
    };
    const cval = o.center ?? (parts[0].value / tot * 100);
    const ns = o.size || r * 0.62;
    const num = el('text', { x: o.cx, y: o.cy + (o.label ? ns * 0.18 : ns * 0.34), 'font-size': ns, 'font-weight': 600, fill: C.ink, 'font-family': SERIF, 'text-anchor': 'middle' }, g);
    const numT = document.createTextNode(''); num.appendChild(numT);
    const uEl = el('tspan', { 'font-size': ns * 0.42, 'font-family': SANS, 'font-weight': 700, fill: C.ink2, dx: ns * 0.04 }, num); uEl.textContent = unit;
    const lab = o.label ? textEl(g, { x: o.cx, y: o.cy + ns * 0.18 + U * 4.2, text: o.label, size: U * 2.3, weight: 500, color: C.ink2, anchor: 'middle', maxW: r * 1.5 }) : null;
    let lg = null;
    if (o.legend && o.parts) {
      lg = parts.map((pt, i) => {
        const yy = o.legend.y + i * U * 4.6, rg = el('g', {}, g);
        el('rect', { x: o.legend.x, y: yy - U * 2.0, width: U * 2.0, height: U * 2.0, rx: U * 0.2, fill: colors[i] }, rg);
        textEl(rg, { x: o.legend.x + U * 3.2, y: yy - U * 0.2, text: pt.label, size: U * 2.6, weight: 500, color: C.ink });
        textEl(rg, { x: o.legend.x + U * 3.2 + measure(pt.label, U * 2.6) + U * 1.4, y: yy - U * 0.2, text: pt.note ?? fmt(pt.value / tot * 100, digits) + '%', size: U * 2.6, weight: 700, color: C.ink2 });
        return rg;
      });
    }
    return {
      g,
      draw(p) {
        const sweep = ease.move(clamp(p)) * Math.PI * 2;
        track.setAttribute('opacity', ease.enter(clamp(p * 4)).toFixed(4));
        segs.forEach(sg => { if (sg.e) sg.e.setAttribute('d', arc(sg.a0 + gapA / 2, Math.min(sg.a1 - gapA / 2, sweep))); });
        const k = ease.enter(clamp(p));
        numT.textContent = p > 0 ? fmt(cval * k, digits) : '';
        num.setAttribute('opacity', clamp(p * 4));
        if (lab) show(lab.el, ease.enter(clamp((p - 0.3) / 0.5)), U * 0.5);
        if (lg) lg.forEach((rg, i) => show(rg, ease.enter(clamp(p * 2 - 0.6 - i * 0.25)), U * 0.5));
      },
    };
  }

  /** 大数字：宋体数字滚动到 value 后停住，上面一行小标签（带强调色短条），下面一行说明。
   *  opts x, y（数字基线）, value, from, digits, prefix, unit（小一号跟在后面）, label, sub, size（默认 16u）, anchor（默认 middle）,
   *       accent（数字用强调色）, sep（千分位）。draw(p)：p 的前 80% 滚动，之后停住 */
  function number(parent, o) {
    const g = el('g', {}, parent), size = o.size || U * 16, anchor = o.anchor || 'middle';
    const lab = o.label ? textEl(g, { x: o.x, y: o.y - size * 0.98, text: o.label, size: U * 2.6, weight: 700, color: C.ink2, anchor, ls: 0.1 }) : null;
    let tab = null;
    if (lab) {
      const tx = anchor === 'middle' ? o.x - U * 1.8 : anchor === 'end' ? o.x - U * 3.6 : o.x;
      tab = el('rect', { x: tx, y: o.y - size * 0.98 - U * 4.6, width: U * 3.6, height: U * 0.55, fill: C.accent }, g);
    }
    const num = el('text', { x: o.x, y: o.y, 'font-size': size, 'font-weight': 600, fill: o.accent ? C.accent : C.ink, 'font-family': SERIF, 'text-anchor': anchor }, g);
    const numT = document.createTextNode(''); num.appendChild(numT);
    const uEl = el('tspan', { 'font-size': size * 0.3, 'font-family': SANS, 'font-weight': 700, fill: C.ink2, dx: size * 0.05 }, num);
    uEl.textContent = o.unit || '';
    const sub = o.sub ? textEl(g, { x: o.x, y: o.y + U * 2.6 + U * 2.6, text: o.sub, size: U * 2.6, weight: 500, color: C.ink2, anchor, maxW: o.maxW }) : null;
    return {
      g,
      draw(p) {
        const k = ease.enter(clamp(p / 0.8));
        numT.textContent = (o.prefix || '') + fmt(lerp(o.from || 0, o.value, k), o.digits || 0, o.sep);
        num.setAttribute('opacity', clamp(p * 5));
        if (lab) show(lab.el, ease.enter(clamp(p * 2.5)), U * 0.5);
        if (tab) tab.setAttribute('opacity', ease.enter(clamp(p * 2.5)));
        if (sub) show(sub.el, ease.enter(clamp((p - 0.5) / 0.5)), U * 0.6);
      },
    };
  }

  // ---------------------------------------------------------------------------------------------
  /** 概念定义卡：细框卡片，顶边一道强调色，术语用宋体大字，下面是外文名、定义和要点。
   *  opts x, y, w（h 可省略，按内容算）, kicker（如 '术语 · 经济学'）, term, en（外文名或拼音）, def（定义，一两句）,
   *       points: [要点...]（可选）, termSize（默认 9u）, defSize（默认 3.6u）, panel（默认 true；false 时直接印在纸上）
   *  draw(p)：卡片 → 术语 → 定义；points(p)：要点依次出现（和旁白对齐，单独调用）。返回 { bottom, ... } */
  function define(parent, o) {
    const g = el('g', {}, parent), pad = o.pad ?? U * 4.2, x = o.x, y = o.y, w = o.w;
    const tsz = o.termSize || U * 9, dsz = o.defSize || U * 3.6, psz = o.pointSize || U * 3.0, inner = w - pad * 2;
    let cy = y + pad + U * 0.6;
    const parts = [];
    let kick = null;
    if (o.kicker) { cy += U * 2.2 * 0.88; kick = textEl(g, { x: x + pad, y: cy, text: o.kicker, size: U * 2.2, weight: 700, color: C.accent, ls: 0.14 }); cy += U * 2.6; }
    const termLines = wrap(o.term, inner, tsz, 700);
    cy += tsz * 0.95;
    const term = textEl(g, { x: x + pad, y: cy, lines: termLines, size: tsz, weight: 600, serif: true, color: C.ink, lh: 1.2 });
    cy += term.height;
    let en = null;
    if (o.en) { cy += U * 2.0 + U * 2.4 * 0.88; en = textEl(g, { x: x + pad, y: cy, text: o.en, size: U * 2.4, weight: 500, color: C.muted, ls: 0.12 }); }
    cy += U * 3.2;
    const ruleY = cy;
    const rule = el('line', { x1: x + pad, x2: x + pad, y1: ruleY, y2: ruleY, stroke: C.ink, 'stroke-width': LW.hair }, g);
    cy += U * 2.6 + dsz * 0.88;
    const def = textEl(g, { x: x + pad, y: cy, text: o.def, size: dsz, weight: 500, color: C.ink, maxW: inner, lh: 1.55 });
    cy += def.height + dsz * 0.4;
    const pts = (o.points || []).map((pt, i) => {
      cy += U * (i ? 1.6 : 3.0) + psz * 0.88;
      const pg = el('g', {}, g);
      el('rect', { x: x + pad, y: cy - psz * 0.62, width: U * 0.9, height: U * 0.9, fill: C.accent }, pg);
      const te = textEl(pg, { x: x + pad + U * 2.4, y: cy, text: pt, size: psz, weight: 500, color: C.ink2, maxW: inner - U * 2.4, lh: 1.45 });
      cy += te.height;
      return pg;
    });
    const h = o.h ?? (cy - y + pad);
    const panel = o.panel === false ? null : el('rect', { x, y, width: w, height: h, rx: U * 0.6, fill: C.card, stroke: C.ink, 'stroke-width': LW.hair }, g);
    if (panel) g.insertBefore(panel, g.firstChild);
    const band = el('rect', { x, y, width: 0, height: U * 0.6, fill: C.accent }, g);
    parts.push(kick, term, en);
    return {
      g, bottom: y + h, height: h,
      draw(p) {
        if (panel) { panel.setAttribute('opacity', ease.enter(clamp(p / 0.25))); }
        band.setAttribute('width', w * ease.move(clamp(p / 0.4)));
        if (kick) show(kick.el, ease.enter(clamp((p - 0.1) / 0.3)), U * 0.5);
        show(term.el, ease.enter(clamp((p - 0.18) / 0.35)), U * 1.2);
        if (en) show(en.el, ease.enter(clamp((p - 0.32) / 0.3)), U * 0.5);
        const q = ease.move(clamp((p - 0.4) / 0.35));
        rule.setAttribute('x2', x + pad + inner * q); rule.setAttribute('opacity', q > 0 ? 1 : 0);
        show(def.el, ease.enter(clamp((p - 0.55) / 0.45)), U * 0.7);
      },
      points(p) { pts.forEach((pg, i) => show(pg, ease.enter(clamp(p * (1 + (pts.length - 1) * 0.6) - i * 0.6)), U * 0.6)); },
    };
  }

  /** 收尾总结卡：编号要点列表，编号用宋体强调色，要点之间是发丝线。
   *  opts x, y, w, items: [{title, sub}], rowH（默认按内容算，至少 14u）, titleSize（默认 4.4u）, subSize（默认 2.9u）。draw(p) 逐条出现；focus(i, f) 突出一条，其余压暗 */
  function recap(parent, o) {
    const g = el('g', {}, parent), tsz = o.titleSize || U * 4.4, ssz = o.subSize || U * 2.9, nsz = U * 6.4;
    const numW = U * 11, n = o.items.length;
    let cy = o.y;
    const rows = o.items.map((it, i) => {
      const rg = el('g', {}, g);
      const tl = wrap(it.title, o.w - numW, tsz, 700), sl = it.sub ? wrap(it.sub, o.w - numW, ssz, 500) : [];
      const blockH = tsz * 0.88 + (tl.length - 1) * tsz * 1.3 + (sl.length ? U * 1.3 + ssz * 0.88 + (sl.length - 1) * ssz * 1.4 : 0) + ssz * 0.2;
      const rh = o.rowH ?? Math.max(U * 14, blockH + U * 7);
      const line0 = el('line', { x1: o.x, x2: o.x + o.w, y1: cy, y2: cy, stroke: i ? C.rule : C.ink, 'stroke-width': i ? LW.grid : LW.hair }, rg);
      const b0 = cy + (rh - blockH) / 2 + tsz * 0.88;
      const num = textEl(rg, { x: o.x, y: b0 + U * 0.6, text: String(i + 1).padStart(2, '0'), size: nsz, weight: 600, serif: true, color: C.accent });
      const tt = textEl(rg, { x: o.x + numW, y: b0, lines: tl, size: tsz, weight: 700, color: C.ink, lh: 1.3 });
      if (sl.length) textEl(rg, { x: o.x + numW, y: b0 + (tl.length - 1) * tsz * 1.3 + U * 1.3 + ssz * 0.88 + tsz * 0.12, lines: sl, size: ssz, weight: 500, color: C.ink2, lh: 1.4 });
      cy += rh;
      return { rg, line0, num, tt, f: 0, d: 0, k: 0 };
    });
    const endLine = el('line', { x1: o.x, x2: o.x + o.w, y1: cy, y2: cy, stroke: C.ink, 'stroke-width': LW.hair }, g);
    const apply = R => { R.rg.setAttribute('opacity', (R.k * (1 - R.d * DIM)).toFixed(4)); R.rg.setAttribute('transform', `translate(0 ${((1 - R.k) * RISE).toFixed(2)})`); };
    return {
      g, bottom: cy,
      draw(p) {
        rows.forEach((R, i) => { R.k = ease.enter(clamp(p * (1 + (n - 1) * 0.55) - i * 0.55)); apply(R); });
        const q = ease.move(clamp(p * 1.5 - 0.5));
        endLine.setAttribute('x2', o.x + o.w * q); endLine.setAttribute('opacity', q > 0 ? 1 : 0);
      },
      focus(i, f) { rows.forEach((R, j) => { R.d = j === i ? 0 : clamp(f); apply(R); }); },
    };
  }

  // ---------------------------------------------------------------------------------------------
  /** 镜内换页（签名转场）：一道强调色发丝线从左扫到右，线后面是新画面 b，前面还是旧画面 a。
   *  a、b 用 ED.layer() 建的图层（图层本身不要做位移）。opts at（开始秒数）, dur（默认 0.7）, x, y, w, h（扫过的区域，默认整个画面）, line（默认 true）
   *  返回 { set(t) }，render(t) 里每帧调用 */
  function swap(a, b, o = {}) {
    const x = o.x ?? 0, y = o.y ?? 0, w = o.w ?? W, h = o.h ?? H, at = o.at ?? 0, dur = o.dur ?? 0.7;
    const defs = defsOf(a), ca = nid('sa'), cb = nid('sb');
    const ra = el('rect', { x, y, width: w, height: h }, el('clipPath', { id: ca }, defs));
    const rb = el('rect', { x, y, width: 0, height: h }, el('clipPath', { id: cb }, defs));
    const ln = o.line === false ? null : el('line', { y1: y + U * 2, y2: y + h - U * 2, stroke: C.accent, 'stroke-width': LW.line }, a.parentNode);
    return {
      set(t) {
        const p = ease.move(clamp((t - at) / dur)), bx = x + w * p;
        const vis = (e, on) => { if (on) e.removeAttribute('display'); else e.setAttribute('display', 'none'); };
        vis(a, p < 1); vis(b, p > 0);
        ra.setAttribute('x', bx.toFixed(2)); ra.setAttribute('width', (x + w - bx).toFixed(2));
        rb.setAttribute('width', (bx - x).toFixed(2));
        if (p > 0 && p < 1) { a.setAttribute('clip-path', `url(#${ca})`); b.setAttribute('clip-path', `url(#${cb})`); }
        else { a.removeAttribute('clip-path'); b.removeAttribute('clip-path'); }
        if (ln) { ln.setAttribute('x1', bx.toFixed(2)); ln.setAttribute('x2', bx.toFixed(2)); ln.setAttribute('opacity', p > 0 && p < 1 ? 1 : 0); }
      },
    };
  }

  window.ED = { C, D, U, ease, LW, ICONS, mix, rgba, fmt, wrap, measure, niceTicks,
    stage, frame, area, layer, heading, text, tag, source, legend, icon,
    node, link, zone, flow, graph, compare, timeline, callout, bracket,
    bars, line, ring, number, define, recap, swap };
})();
