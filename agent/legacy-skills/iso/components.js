/* 等距架构图组件（依赖 SLATE 运行时）
 *
 * 所有模块画在同一个 30° 等距投影的"世界"里：a 轴朝右下，b 轴朝左下，h 轴朝上；1 个世界单位 = k 像素（k 用 SLATE.u 的倍数）。
 * 组件在创建时一次性生成 SVG 元素，render(t) 里只根据 t 调用：
 *   draw(p)          入场进度，p 为 0～1（0 = 还没出现，1 = 完整）
 *   light(lit, any)  高亮状态，一般交给 ISO.spotlight 统一调用
 *   set(t, on) / at(p)  粒子流和数据包
 *
 *   const svg  = document.querySelector('svg.iso-canvas');
 *   const w    = ISO.world(svg, {x: W * 0.3, y: H * 0.45, k: U * 2.8});     // 世界原点 (0,0,0) 在屏幕上的位置
 *   const grid = ISO.grid(w, {a0: -10, a1: 30, b0: -20, b1: 10});           // 地面网格（可选）
 *   const pf   = ISO.platform(w, {a: 6, b: -14, w: 20, d: 20, label: '云端 · 私有网络'});
 *   const gw   = ISO.block(w, {a: 9, b: -2.5, w: 5, d: 5, h: 3, z: pf.top, icon: 'shield'});
 *   const db   = ISO.block(w, {a: 20, b: -13, w: 5, d: 5, h: 4, z: pf.top, shape: 'cyl', color: 'navy'});
 *   const p1   = ISO.pipe(w, {path: [[14, 0], [20, 0], [20, -8]], z: pf.top});   // 管线：只走 a / b 方向的折线，端点放在模块边上
 *   const f1   = ISO.flow(w, p1, {reverse: true});                       // 管线上流动的虚线粒子
 *   const pk   = ISO.packet(w, p1);                                      // 沿管线移动的数据包
 *   const lb   = ISO.label(w, {at: gw, text: 'API 网关', sub: '鉴权 · 限流'});
 *   const spot = ISO.spotlight({gw, lb, p1, db}, [[1.5, 3, ['gw', 'lb']], [3, 4.5, ['p1', 'db']]]);
 *   function render(t) {
 *     pf.draw(seg(t, 0, .6)); gw.draw(seg(t, .3, .9)); p1.draw(seg(t, .8, 1.3)); lb.draw(seg(t, 1, 1.5));
 *     pk.at(seg(t, 3, 3.8, ease.inOut)); f1.set(t, seg(t, 5, 5.3)); spot.set(t);
 *   }
 *
 * 遮挡顺序：地面（网格、平台）→ 阴影和光圈 → 管线 → 粒子流和数据包 → 模块 → 标签。
 * 模块之间按 a + b 自动排序（越靠前的越后画），一般不用操心创建顺序。
 */
(() => {
  const S = window.SLATE;
  const U = S.u;
  const C = { bg: '#EEF2F8', ink: '#1F2A44', navy: '#2D4C8F', blue: '#4A6CBD', amber: '#E3A732', amberLight: '#F7CD6A',
              muted: '#7A879E', grid: '#C9D3E4', white: '#FFFFFF', dimBg: '#F3F6FB' };
  /** 三个面的颜色：光源在左上，顶面最亮，左面（朝左下）次之，右面（朝右下）最暗 */
  const TINTS = {
    blue:  { top: '#B5C8EE', left: '#6F8FD6', right: '#4A6CBD', edge: '#2D4C8F', mark: '#2D4C8F' },
    navy:  { top: '#7F98D8', left: '#3F5EA8', right: '#2D4C8F', edge: '#1D3268', mark: '#FFFFFF' },
    gray:  { top: '#F4F6FA', left: '#CDD5E2', right: '#B2BDD0', edge: '#7A879E', mark: '#4A5A78' },
    white: { top: '#FFFFFF', left: '#DCE3EF', right: '#C7D1E2', edge: '#A7B4CB', mark: '#2D4C8F' },
    amber: { top: '#F7CD6A', left: '#E3A732', right: '#C88A1C', edge: '#8A5E0F', mark: '#5C3D06' },
    pipe:  { top: '#DDE6F6', left: '#BDCBE6', right: '#A4B5D8', edge: '#7F93BD', mark: '#2D4C8F' },
  };
  const DIM = 0.4;                       // 没被点亮的模块降到 40% 不透明度
  const C30 = Math.cos(Math.PI / 6);
  const SQ2 = Math.SQRT1_2;
  let uid = 0;

  const pts = list => list.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const dPath = list => list.map(([x, y], i) => `${i ? 'L' : 'M'} ${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
  const hex = c => [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16));
  /** 两个 #RRGGBB 颜色按 p 混合 */
  const mix = (c1, c2, p) => {
    const a = hex(c1), b = hex(c2), q = S.clamp(p);
    return '#' + a.map((v, i) => Math.round(v + (b[i] - v) * q).toString(16).padStart(2, '0')).join('');
  };
  /** 高亮时的不透明度：有模块被点亮（any）而自己没被点亮（lit）时降到 DIM */
  const dimOf = (lit, any) => 1 - (1 - DIM) * S.clamp(any) * (1 - S.clamp(lit));

  /** 世界：负责投影，并按遮挡顺序准备好图层 */
  function world(svg, { x = S.width / 2, y = S.height / 2, k = U * 2.6 } = {}) {
    const defs = S.svg('defs', {}, svg);
    const L = {};
    for (const n of ['ground', 'decal', 'pipe', 'flow', 'block', 'label']) L[n] = S.svg('g', { 'data-layer': n }, svg);
    /** 世界坐标 → 屏幕像素 */
    const p = (a, b, h = 0) => [x + (a - b) * C30 * k, y + (a + b) * 0.5 * k - h * k];
    return { svg, defs, L, k, x, y, p };
  }

  /** 长方体三个可见面的屏幕坐标：footprint (a, b) 到 (a + w, b + d)，从高度 z 到 z + h */
  function faces(wo, a, b, w, d, z, h) {
    const P = wo.p;
    return {
      top: [P(a, b, z + h), P(a + w, b, z + h), P(a + w, b + d, z + h), P(a, b + d, z + h)],
      left: [P(a, b + d, z), P(a + w, b + d, z), P(a + w, b + d, z + h), P(a, b + d, z + h)],
      right: [P(a + w, b, z), P(a + w, b + d, z), P(a + w, b + d, z + h), P(a + w, b, z + h)],
    };
  }
  function faceEls(parent, T, edge = true) {
    const st = edge ? { stroke: T.edge, 'stroke-opacity': 0.55, 'stroke-width': U * 0.12, 'stroke-linejoin': 'round' } : {};
    return {
      left: S.svg('polygon', { fill: T.left, ...st }, parent),
      right: S.svg('polygon', { fill: T.right, ...st }, parent),
      top: S.svg('polygon', { fill: T.top, ...st }, parent),
    };
  }
  function setFaces(els, f) { for (const n in els) els[n].setAttribute('points', pts(f[n])); }
  function insertByDepth(layer, g, depth) {
    g.__depth = depth;
    const next = Array.from(layer.children).find(c => c.__depth > depth);
    layer.insertBefore(g, next || null);
  }

  /** 顶面图标：在 [-1, 1] 的方格里定义的折线，贴到等距顶面上 */
  const ring = (cx, cy, r, n = 28, a0 = 0, a1 = Math.PI * 2) =>
    Array.from({ length: n + 1 }, (_, i) => { const a = a0 + (a1 - a0) * i / n; return [cx + r * Math.cos(a), cy + r * Math.sin(a)]; });
  const GLYPHS = {
    user: () => [ring(0, -0.32, 0.3), ring(0, 0.78, 0.62, 18, Math.PI * 1.08, Math.PI * 1.92)],
    shield: () => [[[0, -0.86], [0.68, -0.58], [0.6, 0.12], [0, 0.86], [-0.6, 0.12], [-0.68, -0.58], [0, -0.86]], [[-0.3, 0], [-0.06, 0.26], [0.34, -0.24]]],
    gear: () => [ring(0, 0, 0.26, 20), Array.from({ length: 33 }, (_, i) => { const a = i / 32 * Math.PI * 2, r = (i % 4 < 2) ? 0.82 : 0.6; return [r * Math.cos(a), r * Math.sin(a)]; })],
    bolt: () => [[[0.18, -0.9], [-0.46, 0.12], [0.02, 0.12], [-0.18, 0.9], [0.46, -0.12], [-0.02, -0.12], [0.18, -0.9]]],
    queue: () => [[[-0.7, -0.45], [0.7, -0.45]], [[-0.7, 0], [0.7, 0]], [[-0.7, 0.45], [0.3, 0.45]]],
    api: () => [[[-0.32, -0.5], [-0.82, 0], [-0.32, 0.5]], [[0.32, -0.5], [0.82, 0], [0.32, 0.5]], [[0.14, -0.66], [-0.14, 0.66]]],
    lock: () => [[[-0.55, -0.05], [0.55, -0.05], [0.55, 0.8], [-0.55, 0.8], [-0.55, -0.05]], ring(0, -0.05, 0.36, 14, Math.PI, Math.PI * 2)],
    cloud: () => [[[-0.7, 0.45], ...ring(-0.42, 0.12, 0.33, 10, Math.PI * 0.75, Math.PI * 1.5), ...ring(0.05, -0.12, 0.45, 12, Math.PI * 1.15, Math.PI * 1.95), ...ring(0.5, 0.15, 0.3, 10, Math.PI * 1.5, Math.PI * 2.5), [-0.7, 0.45]]],
    chart: () => [[[-0.75, 0.75], [0.75, 0.75]], [[-0.45, 0.75], [-0.45, 0.2]], [[0, 0.75], [0, -0.25]], [[0.45, 0.75], [0.45, -0.7]]],
  };
  /** 图标坐标 → 世界坐标：图标的 x 朝屏幕右，y 朝屏幕下（像平放在顶面上） */
  const glyphToWorld = (ca, cb, s) => ([x, y]) => [ca + s * (x + y) * SQ2, cb + s * (y - x) * SQ2];

  /** 地面网格：四周渐隐 */
  function grid(wo, { a0 = -10, a1 = 30, b0 = -20, b1 = 10, step = 2, z = 0, color = C.grid } = {}) {
    const id = `iso-grid-${++uid}`;
    const ca = (a0 + a1) / 2, cb = (b0 + b1) / 2, [cx, cy] = wo.p(ca, cb, z);
    const rx = ((a1 - a0) + (b1 - b0)) * 0.5 * C30 * wo.k, ry = rx * 0.62;
    const grad = S.svg('radialGradient', { id: id + 'g', cx, cy, r: rx, gradientUnits: 'userSpaceOnUse', gradientTransform: `translate(${cx} ${cy}) scale(1 ${(ry / rx).toFixed(3)}) translate(${-cx} ${-cy})` }, wo.defs);
    S.svg('stop', { offset: 0, 'stop-color': '#fff', 'stop-opacity': 1 }, grad);
    S.svg('stop', { offset: 0.55, 'stop-color': '#fff', 'stop-opacity': 0.7 }, grad);
    S.svg('stop', { offset: 1, 'stop-color': '#fff', 'stop-opacity': 0 }, grad);
    const mask = S.svg('mask', { id: id + 'm', maskUnits: 'userSpaceOnUse', x: 0, y: 0, width: S.width, height: S.height }, wo.defs);
    S.svg('rect', { x: 0, y: 0, width: S.width, height: S.height, fill: `url(#${id}g)` }, mask);
    const g = S.svg('g', { mask: `url(#${id}m)`, opacity: 0 }, wo.L.ground);
    let d = '';
    for (let a = Math.ceil(a0 / step) * step; a <= a1; a += step) d += dPath([wo.p(a, b0, z), wo.p(a, b1, z)]) + ' ';
    for (let b = Math.ceil(b0 / step) * step; b <= b1; b += step) d += dPath([wo.p(a0, b, z), wo.p(a1, b, z)]) + ' ';
    S.svg('path', { d, stroke: color, 'stroke-width': U * 0.09, fill: 'none' }, g);
    return { g, draw(p) { g.setAttribute('opacity', S.clamp(p)); } };
  }

  /** 平台：一块低矮的底座（比如"云端"、"用户端"），模块放在它上面（z = 平台.top）。
   *  label 印在顶面靠前的一条边上：side 为 'left'（左前边，沿 a 轴）或 'right'（右前边，沿 b 轴），注意别被模块挡住 */
  function platform(wo, { a, b, w, d, h = 0.6, z = 0, color = 'white', label = '', side = 'left', size = U * 2 }) {
    const T = TINTS[color] || TINTS.white;
    const g = S.svg('g', { opacity: 0 }, wo.L.ground);
    const shadow = S.svg('polygon', { fill: C.navy, opacity: 0.07 }, g);
    const els = faceEls(g, T);
    const inset = S.svg('polygon', { fill: 'none', stroke: C.navy, 'stroke-opacity': 0.18, 'stroke-width': U * 0.12, 'stroke-dasharray': `${U * 0.8} ${U * 0.6}` }, g);
    setFaces(els, faces(wo, a, b, w, d, z, h));
    shadow.setAttribute('points', pts([wo.p(a + 1.2, b, z), wo.p(a + w + 1.2, b, z), wo.p(a + w + 1.2, b + d, z), wo.p(a + 1.2, b + d, z)]));
    const m = 0.8;
    inset.setAttribute('points', pts([wo.p(a + m, b + m, z + h), wo.p(a + w - m, b + m, z + h), wo.p(a + w - m, b + d - m, z + h), wo.p(a + m, b + d - m, z + h)]));
    let tx = null;
    if (label) {
      // 文字"印"在顶面上：左前边时文字沿 +a 方向，右前边时沿 -b 方向
      const e = 0.45;
      const [x0, y0] = side === 'right' ? wo.p(a + w - e, b + d - 1, z + h) : wo.p(a + 1, b + d - e, z + h);
      const mtx = side === 'right' ? `${C30} -0.5 ${C30} 0.5` : `${C30} 0.5 ${-C30} 0.5`;
      tx = S.svg('text', { 'font-size': size, 'font-weight': 700, fill: C.navy, 'fill-opacity': 0.5, 'letter-spacing': size * 0.12,
        transform: `matrix(${mtx} ${x0.toFixed(1)} ${y0.toFixed(1)})` }, g);
      tx.textContent = label;
    }
    return {
      g, top: z + h,
      draw(p) {
        const e = S.ease.out(S.clamp(p));
        g.setAttribute('opacity', S.clamp(p * 2));
        g.setAttribute('transform', `translate(0 ${((1 - e) * U * 3).toFixed(2)})`);
      },
    };
  }

  /** 模块：立方体（shape: 'box'）或圆柱（shape: 'cyl'，适合数据库、存储）。
   *  icon：顶面图标（user、shield、gear、bolt、queue、api、lock、cloud、chart）；slots：左面的机架槽数（服务器的样子） */
  function block(wo, { a, b, w = 5, d = 5, h = 3, z = 0, color = 'blue', shape = 'box', icon = null, slots = 0 }) {
    const T = TINTS[color] || TINTS.blue;
    const k = wo.k;
    const shadow = S.svg('polygon', { fill: C.navy, opacity: 0 }, wo.L.decal);
    const halo = S.svg('polygon', { fill: C.amber, 'fill-opacity': 0.16, stroke: C.amber, 'stroke-width': U * 0.22, 'stroke-linejoin': 'round', opacity: 0 }, wo.L.decal);
    const g = S.svg('g', { opacity: 0 }, null);
    insertByDepth(wo.L.block, g, a + b + (w + d) / 2);
    const ca = a + w / 2, cb = b + d / 2;
    // 降暗用"往底色混"而不是半透明：模块保持不透明，后面的管线不会透出来
    const paints = [];
    const el = (tag, attrs, colors, parent = g) => {
      const e = S.svg(tag, attrs, parent);
      for (const attr in colors) paints.push([e, attr, colors[attr]]);
      return e;
    };
    const edge = { 'stroke-opacity': 0.55, 'stroke-width': U * 0.12, 'stroke-linejoin': 'round' };
    let faceE, body, topE, rings = [], glow, bevel;
    if (shape === 'cyl') {
      const gid = `iso-cyl-${++uid}`;
      const lg = S.svg('linearGradient', { id: gid, x1: 0, y1: 0, x2: 1, y2: 0 }, wo.defs);
      el('stop', { offset: 0 }, { 'stop-color': T.left }, lg);
      el('stop', { offset: 0.45 }, { 'stop-color': mix(T.left, T.right, 0.35) }, lg);
      el('stop', { offset: 1 }, { 'stop-color': T.right }, lg);
      body = el('path', { fill: `url(#${gid})`, ...edge }, { stroke: T.edge });
      for (let i = 0; i < 2; i++) rings.push(el('path', { fill: 'none', 'stroke-opacity': 0.75, 'stroke-width': U * 0.22 }, { stroke: T.top }));
      topE = el('ellipse', edge, { fill: T.top, stroke: T.edge });
      glow = S.svg('ellipse', { fill: 'none', stroke: C.amber, 'stroke-width': U * 0.3, opacity: 0 }, g);
    } else {
      faceE = { left: el('polygon', edge, { fill: T.left, stroke: T.edge }), right: el('polygon', edge, { fill: T.right, stroke: T.edge }),
                top: el('polygon', edge, { fill: T.top, stroke: T.edge }) };
      bevel = S.svg('polyline', { fill: 'none', stroke: '#fff', 'stroke-opacity': 0.7, 'stroke-width': U * 0.14, 'stroke-linejoin': 'round' }, g);
      glow = S.svg('polygon', { fill: 'none', stroke: C.amber, 'stroke-width': U * 0.3, 'stroke-linejoin': 'round', opacity: 0 }, g);
    }
    const slotEls = Array.from({ length: slots }, () => el('polyline', { fill: 'none', 'stroke-opacity': 0.75, 'stroke-width': U * 0.26, 'stroke-linecap': 'round' }, { stroke: T.right }));
    const leds = Array.from({ length: slots }, () => S.svg('ellipse', { rx: U * 0.32, ry: U * 0.4 }, g));
    const glyphPts = icon && GLYPHS[icon] ? GLYPHS[icon]() : [];
    const glyph = glyphPts.map(() => el('polyline', { fill: 'none', 'stroke-width': U * 0.32, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, { stroke: T.mark }));
    const st = { p: 0, lit: 0, any: 0 };

    function geometry(hh) {
      const top = z + hh;
      if (shape === 'cyl') {
        const r = Math.min(w, d) / 2, rx = r * k * Math.SQRT2 * C30, ry = r * k * Math.SQRT2 * 0.5;
        const [cx, yb] = wo.p(ca, cb, z), yt = yb - hh * k;
        body.setAttribute('d', `M ${cx - rx} ${yt} L ${cx - rx} ${yb} A ${rx} ${ry} 0 0 0 ${cx + rx} ${yb} L ${cx + rx} ${yt} A ${rx} ${ry} 0 0 1 ${cx - rx} ${yt} Z`);
        rings.forEach((e, i) => { const y = yt + (yb - yt) * (i + 1) / 3; e.setAttribute('d', `M ${cx - rx} ${y} A ${rx} ${ry} 0 0 0 ${cx + rx} ${y}`); });
        for (const e of [topE, glow]) { e.setAttribute('cx', cx); e.setAttribute('cy', yt); e.setAttribute('rx', rx); e.setAttribute('ry', ry); }
      } else {
        const f = faces(wo, a, b, w, d, z, hh);
        setFaces(faceE, f);
        bevel.setAttribute('points', pts([f.top[3], f.top[2], f.top[1]]));
        glow.setAttribute('points', pts(f.top));
        slotEls.forEach((e, i) => {
          const zz = z + hh * (i + 1) / (slots + 1);
          e.setAttribute('points', pts([wo.p(a + w * 0.12, b + d, zz), wo.p(a + w * 0.7, b + d, zz)]));
          const [lx, ly] = wo.p(a + w * 0.84, b + d, zz);
          leds[i].setAttribute('cx', lx); leds[i].setAttribute('cy', ly);
        });
      }
      const map = glyphToWorld(ca, cb, Math.min(w, d) * 0.3);
      glyph.forEach((e, i) => e.setAttribute('points', pts(glyphPts[i].map(q => { const [ga, gb] = map(q); return wo.p(ga, gb, top); }))));
      const sh = hh * 0.55;
      shadow.setAttribute('points', pts([wo.p(a, b, z), wo.p(a + w + sh, b, z), wo.p(a + w + sh, b + d, z), wo.p(a, b + d, z)]));
      const m = 0.9;
      halo.setAttribute('points', pts([wo.p(a - m, b - m, z), wo.p(a + w + m, b - m, z), wo.p(a + w + m, b + d + m, z), wo.p(a - m, b + d + m, z)]));
    }
    function apply() {
      const vis = S.clamp(st.p * 3), fade = 1 - dimOf(st.lit, st.any);   // fade：0 = 原色，0.6 = 降到 40%
      g.setAttribute('opacity', vis.toFixed(3));
      g.setAttribute('transform', `translate(0 ${(-st.lit * k * 0.5).toFixed(2)})`);
      for (const [e, attr, c] of paints) e.setAttribute(attr, mix(c, C.dimBg, fade));
      bevel && bevel.setAttribute('stroke-opacity', (0.7 * (1 - fade)).toFixed(3));
      shadow.setAttribute('opacity', (0.1 * vis * (1 - fade)).toFixed(3));
      halo.setAttribute('opacity', (st.lit * vis).toFixed(3));
      glow.setAttribute('opacity', (st.lit * vis).toFixed(3));
      leds.forEach(e => e.setAttribute('fill', mix(mix(T.top, C.amber, st.lit), C.dimBg, fade)));
    }
    geometry(h);
    return {
      g, top: [ca, cb, z + h],
      /** 入场：从底座上长出来（带一点回弹） */
      draw(p) { st.p = S.clamp(p); geometry(h * Math.max(0.02, S.ease.back(st.p))); apply(); },
      light(lit, any) { st.lit = lit; st.any = any; apply(); },
    };
  }

  /** 管线：平放的方管，路径是只走 a / b 方向的折线 [[a, b], ...]；端点放在模块的边上 */
  function pipe(wo, { path, z = 0, width = 1.2, height = 0.35, color = 'pipe' }) {
    const T = TINTS[color] || TINTS.pipe;
    const g = S.svg('g', { opacity: 0 }, wo.L.pipe);
    const segs = path.slice(1).map((q, i) => ({ p0: path[i], p1: q, len: Math.hypot(q[0] - path[i][0], q[1] - path[i][1]), els: faceEls(g, T, false) }));
    // 管线顶面中间的静态虚线：表示"这里有一条通路"，数据流动时上面再叠琥珀色粒子
    const idle = S.svg('path', { d: dPath(path.map(([a, b]) => wo.p(a, b, z + height))), fill: 'none', stroke: T.mark, 'stroke-opacity': 0.35,
      'stroke-width': U * 0.22, 'stroke-dasharray': `${U * 0.7} ${U * 0.7}`, 'stroke-linecap': 'round' }, g);
    const total = segs.reduce((s, x) => s + x.len, 0);
    const hw = width / 2;
    const st = { p: 0, lit: 0, any: 0 };
    function apply() { g.setAttribute('opacity', (S.clamp(st.p * 4) * dimOf(st.lit, st.any)).toFixed(3)); }
    const self = {
      g, total, z: z + height,
      /** 中心线上第 s 个世界单位处的世界坐标（s 从 0 到 total） */
      pointAt(s) {
        let rest = S.clamp(s, 0, total);
        for (const sg of segs) {
          if (rest <= sg.len || sg === segs[segs.length - 1]) {
            const q = sg.len ? rest / sg.len : 0;
            return [sg.p0[0] + (sg.p1[0] - sg.p0[0]) * q, sg.p0[1] + (sg.p1[1] - sg.p0[1]) * q];
          }
          rest -= sg.len;
        }
        return path[path.length - 1];
      },
      /** 中心线（屏幕坐标），给粒子流和数据包用 */
      centerD() { return dPath(path.map(([a, b]) => wo.p(a, b, z + height))); },
      /** 按路径方向"铺"出来 */
      draw(p) {
        st.p = S.clamp(p);
        let left = st.p * total;
        for (const sg of segs) {
          const v = S.clamp(left, 0, sg.len); left -= sg.len;
          for (const n in sg.els) sg.els[n].setAttribute('visibility', v > 0 ? 'visible' : 'hidden');
          // 拐角处沿走向多铺半个管宽，让相邻两段接上；两头不多铺，正好停在模块边上
          const [a0, b0] = sg.p0, da = Math.sign(sg.p1[0] - a0), db = Math.sign(sg.p1[1] - b0);
          const i = segs.indexOf(sg), e0 = i > 0 ? hw : 0, e1 = i < segs.length - 1 && v >= sg.len ? hw : 0;
          const ends = (c0, dir) => { const c1 = c0 + dir * v; return dir > 0 ? [c0 - e0, c1 + e1] : dir < 0 ? [c1 - e1, c0 + e0] : [c0 - hw, c0 + hw]; };
          const [amin, amax] = ends(a0, da), [bmin, bmax] = ends(b0, db);
          setFaces(sg.els, faces(wo, amin, bmin, amax - amin, bmax - bmin, z, height));
        }
        idle.setAttribute('opacity', S.clamp((st.p - 0.85) / 0.15).toFixed(3));
        apply();
      },
      light(lit, any) { st.lit = lit; st.any = any; apply(); },
    };
    return self;
  }

  /** 粒子流：管线顶面上一串移动的虚线；reverse 为 true 时从终点流向起点 */
  function flow(wo, pp, { reverse = false, speed = U * 7, dash = U * 1.1, gap = U * 1.5, width = U * 0.55, color = C.amber } = {}) {
    const el = S.svg('path', { d: pp.centerD(), fill: 'none', stroke: color, 'stroke-width': width, 'stroke-linecap': 'round',
      'stroke-dasharray': `${dash} ${gap}`, opacity: 0 }, wo.L.flow);
    return {
      el,
      /** t：当前秒数（决定粒子位置）；on：0～1，粒子流的显隐 */
      set(t, on = 1) {
        el.setAttribute('opacity', S.clamp(on).toFixed(3));
        el.setAttribute('stroke-dashoffset', ((reverse ? 1 : -1) * t * speed).toFixed(2));
      },
    };
  }

  /** 数据包：沿管线移动的小方块，后面拖一段光尾 */
  function packet(wo, pp, { size = 1.4, color = 'amber', trail = U * 12 } = {}) {
    const T = TINTS[color] || TINTS.amber;
    const tail = S.svg('path', { d: pp.centerD(), fill: 'none', stroke: C.amber, 'stroke-width': U * 0.7, 'stroke-linecap': 'round', opacity: 0 }, wo.L.flow);
    const g = S.svg('g', { opacity: 0 }, wo.L.flow);
    const glow = S.svg('ellipse', { fill: C.amber, opacity: 0.3 }, g);
    const els = faceEls(g, T);
    const Lpx = pp.total * wo.k;   // a、b 方向的单位长度投影后都是 k 像素
    return {
      g,
      /** p：0～1，从起点到终点；0 和 1 时隐藏 */
      at(p) {
        const on = p > 0 && p < 1 ? Math.min(1, p * 12, (1 - p) * 12) : 0;
        g.setAttribute('opacity', on.toFixed(3));
        tail.setAttribute('opacity', (on * 0.55).toFixed(3));
        p = S.clamp(p);
        const [a, b] = pp.pointAt(p * pp.total), s = size;
        setFaces(els, faces(wo, a - s / 2, b - s / 2, s, s, pp.z, s));
        const [gx, gy] = wo.p(a, b, pp.z);
        glow.setAttribute('cx', gx); glow.setAttribute('cy', gy); glow.setAttribute('rx', s * wo.k * 1.6); glow.setAttribute('ry', s * wo.k * 0.95);
        const head = p * Lpx, len = Math.min(trail, head);
        tail.setAttribute('stroke-dasharray', `${len.toFixed(1)} ${(Lpx * 2).toFixed(1)}`);
        tail.setAttribute('stroke-dashoffset', (-(head - len)).toFixed(1));
      },
    };
  }

  /** 标签：从锚点（模块顶面中心或世界坐标 [a, b, h]）引一根竖线，挂一块名牌。
   *  lift：名牌离锚点的距离；below 为 true 时名牌挂在锚点下方；tone：'light'（白底，点亮时变深蓝）| 'accent'（琥珀底，用于结果、状态） */
  function label(wo, { at, text, sub = '', lift = U * 6, dx = 0, below = false, size = U * 2.6, tone = 'light' }) {
    const anchor = Array.isArray(at) ? at : at.top;
    const [ax, ay] = wo.p(anchor[0], anchor[1], anchor[2]);
    const g = S.svg('g', { opacity: 0 }, wo.L.label);
    const accent = tone === 'accent';
    const tx = ax + dx, by = below ? ay + lift : ay - lift, elbow = below ? by - U * 1.2 : by + U * 1.2;
    const lead = S.svg('path', { d: dPath(dx ? [[ax, ay], [ax, elbow], [tx, elbow], [tx, by]] : [[ax, ay], [tx, by]]),
      fill: 'none', stroke: C.navy, 'stroke-width': U * 0.16, 'stroke-dasharray': 'none' }, g);
    const dot = S.svg('circle', { cx: ax, cy: ay, r: U * 0.45, fill: C.navy }, g);
    const tag = S.svg('g', {}, g);
    const shadow = S.svg('rect', { fill: C.navy, opacity: 0.12 }, tag);
    const box = S.svg('rect', { fill: accent ? C.amber : C.white, stroke: accent ? C.amber : C.navy, 'stroke-opacity': accent ? 1 : 0.25, 'stroke-width': U * 0.1 }, tag);
    const t1 = S.svg('text', { 'font-size': size, 'font-weight': 700, fill: accent ? C.ink : C.navy, 'text-anchor': 'middle' }, tag);
    t1.textContent = text;
    const t2 = sub ? S.svg('text', { 'font-size': size * 0.72, 'font-weight': 500, fill: accent ? C.ink : C.muted, 'text-anchor': 'middle' }, tag) : null;
    if (t2) t2.textContent = sub;
    const est = (s, fs) => Array.from(s).reduce((n, ch) => n + (ch.charCodeAt(0) > 0x2e80 ? fs : fs * 0.58), 0);
    const w1 = t1.getComputedTextLength() || est(text, size), w2 = t2 ? (t2.getComputedTextLength() || est(sub, size * 0.72)) : 0;
    const padX = U * 1.4, padY = U * 0.9, gapY = U * 0.4;
    const bw = Math.max(w1, w2) + padX * 2, bh = size * 1.1 + (t2 ? size * 0.72 * 1.1 + gapY : 0) + padY * 2;
    const bx = tx - bw / 2, byTop = below ? by : by - bh;
    for (const [el, off] of [[box, 0], [shadow, U * 0.5]]) {
      el.setAttribute('x', bx + off * 0.3); el.setAttribute('y', byTop + off); el.setAttribute('width', bw); el.setAttribute('height', bh);
      el.setAttribute('rx', U * 0.8);
    }
    t1.setAttribute('x', tx); t1.setAttribute('y', byTop + padY + size * 0.88);
    if (t2) { t2.setAttribute('x', tx); t2.setAttribute('y', byTop + padY + size * 1.1 + gapY + size * 0.72 * 0.88); }
    const st = { p: 0, lit: 0, any: 0 };
    function apply() {
      const e = S.ease.out(S.clamp((st.p - 0.35) / 0.65));
      g.setAttribute('opacity', ((st.p > 0 ? 1 : 0) * dimOf(st.lit, st.any)).toFixed(3));
      g.setAttribute('transform', `translate(0 ${(-st.lit * wo.k * 0.5).toFixed(2)})`);
      S.draw(lead, S.clamp(st.p / 0.4));
      dot.setAttribute('opacity', S.clamp(st.p * 5));
      tag.setAttribute('opacity', e.toFixed(3));
      tag.setAttribute('transform', `translate(0 ${((1 - e) * U * 1.2 * (below ? -1 : 1)).toFixed(2)})`);
      if (!accent) {
        box.setAttribute('fill', mix(C.white, C.navy, st.lit));
        t1.setAttribute('fill', mix(C.navy, C.white, st.lit));
        if (t2) t2.setAttribute('fill', mix(C.muted, '#D3DEF7', st.lit));
      }
      const lc = mix(C.navy, C.amber, st.lit);
      lead.setAttribute('stroke', lc); dot.setAttribute('fill', lc);
    }
    return {
      g, box: [bx, byTop, bw, bh],
      draw(p) { st.p = S.clamp(p); apply(); },
      light(lit, any) { st.lit = lit; st.any = any; apply(); },
    };
  }

  /** 高亮：一次只点亮一组（模块、管线、标签），其余降到 40%。
   *  items：{名字: 带 light(lit, any) 的组件}；plan：[[开始秒, 结束秒, 名字或名字数组], ...]；相邻两段会平滑交接 */
  function spotlight(items, plan, { fade = 0.3 } = {}) {
    const win = (t, s, e) => S.ease.inOut(Math.min(S.clamp((t - s + fade / 2) / fade), S.clamp((e - t + fade / 2) / fade)));
    // "有模块被点亮"用合并后的区间算，相邻两段交接时其余模块不会闪回 100%
    const spans = plan.map(([s, e]) => [s, e]).sort((x, y) => x[0] - y[0]).reduce((acc, [s, e]) => {
      const last = acc[acc.length - 1];
      if (last && s <= last[1] + 1e-6) last[1] = Math.max(last[1], e); else acc.push([s, e]);
      return acc;
    }, []);
    return {
      set(t) {
        const any = Math.max(0, ...spans.map(([s, e]) => win(t, s, e)));
        for (const name in items) {
          let lit = 0;
          for (const [s, e, who] of plan) if ((Array.isArray(who) ? who : [who]).includes(name)) lit = Math.max(lit, win(t, s, e));
          items[name].light(lit, any);
        }
        return any;
      },
    };
  }

  window.ISO = { C, U, TINTS, DIM, mix, world, grid, platform, block, pipe, flow, packet, label, spotlight };
})();
