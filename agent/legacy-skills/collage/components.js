/* 纸媒拼贴组件（依赖 SLATE 运行时）：时事解读、"一张图看懂"、数据剪报、时间线、辟谣类讲解片
 *
 * 约定：所有组件在创建时一次性生成元素；render(t) 里只根据 t 设置状态。
 *   draw(p)：p 为 0～1 的入场进度；set(t, …)：需要绝对时间的组件（印章、翻页日历）。
 *   一拍二：纸片、文字的动作用 T = CL.step(t)（按帧率的一半步进，30fps 下每 2 帧换一格，像定格动画）；
 *          镜头、颗粒、印章冲击用原始的 t（每帧都动）。
 * 坐标单位是画布像素，尺寸都写成 SLATE.u（短边的 1%）的倍数。
 * 颜色：几种中性纸色 + 一种墨色（ink）+ 一个强调色（red：印章、圈注、重点）；黄色只做荧光笔，面积很小。
 * 需要量文字宽度的组件（标题、纸条、印章、批注……）在第一次 draw/set 时才排版：那时字体已经加载完。
 *
 *   const st = CL.stage({ paper: 'cream', push: 0.04 });             // 纸面 + 颗粒 + 镜头 + 转场
 *   const h = CL.heading(st.world, { kicker: '一张图看懂', text: '台风是怎么转起来的' });
 *   const box = st.area({ top: h.bottom });                         // 标题和字幕区之间、镜头推近后仍在安全区里的区域
 *   const card = CL.tornCard(st.world, { x: box.x, y: box.y, w: box.w * 0.5, h: box.h, tone: 'white', rotate: -2 });
 *   function render(t) { const T = CL.step(t); st.set(t); h.draw(SLATE.seg(T, 0.2, 1.2)); card.draw(SLATE.seg(T, 0.8, 1.4)); }
 *
 * 组件一览（参数见各函数注释）：
 *   舞台与工具：stage、step、track、textWidth（量文字宽度，不受镜头缩放影响）
 *   文字：heading、text、note（手写批注）、strip（金句纸条）、badge（序号）、sourceTag、watermark
 *   纸片与素材：tornCard、piece（任意形状的剪纸）、cutout（照片 / 占位图）、halftone、tape
 *   标注：stamp、circle、underline、highlight、arrow、strike、redact
 *   信息：counter、bars、dateFlip、pin、thread、board（证据墙连线）、mapScrap、mapPin
 */
(() => {
  const S = window.SLATE;
  const U = S.u, W = S.width, H = S.height;
  const clamp = S.clamp, lerp = S.lerp, ease = S.ease;
  const TAU = Math.PI * 2;

  const C = {
    ink: '#14213d', ink2: '#3d4a66', muted: '#6e7486',
    red: '#b8312a', yellow: '#f2c230', white: '#fffdf8',
    paper: '#ede1c8', newsprint: '#e2ddd0', kraft: '#c49a62', dark: '#1a1b1f',
    shadow: '#14213d',
  };
  /** 纸片的颜色：fill 纸面、rim 撕口露出的白芯、text/sub 印在上面的字 */
  const TONE = {
    white: { fill: '#fbf7ee', rim: '#ffffff', text: C.ink, sub: C.ink2 },
    cream: { fill: '#f3e9d4', rim: '#fffcf3', text: C.ink, sub: C.ink2 },
    newsprint: { fill: '#e2ddd0', rim: '#f7f4ec', text: C.ink, sub: C.ink2 },
    kraft: { fill: '#c9a06a', rim: '#ead9bd', text: '#2b1f12', sub: '#4d3a22' },
    ink: { fill: '#1d2b4b', rim: '#f2ece0', text: '#f7f1e5', sub: '#c7cedd' },
    red: { fill: '#b8312a', rim: '#f6ece2', text: '#fff8ee', sub: '#f4d6cf' },
    yellow: { fill: '#f2c230', rim: '#fff8e2', text: '#1b1a16', sub: '#3b3420' },
    charcoal: { fill: '#2a2c32', rim: '#45474e', text: '#f3eee3', sub: '#b9b4aa' },
  };
  /** 底纸：cream 旧报纸（默认）、newsprint 新闻纸、kraft 牛皮纸（案卷）、dark 新闻暗场 */
  const PAPER = {
    cream: { base: '#ede1c8', light: '#fbf3e1', darkc: '#8f7748', fiber: 0.10, speck: '#5a4a2e', stain: 0.05, grain: 15, dark: false },
    newsprint: { base: '#e4dfd2', light: '#f6f3ea', darkc: '#77746a', fiber: 0.08, speck: '#3d3b36', stain: 0.035, grain: 17, dark: false },
    kraft: { base: '#c39a64', light: '#dcb886', darkc: '#6e4f28', fiber: 0.16, speck: '#3b2a14', stain: 0.06, grain: 20, dark: false },
    dark: { base: '#1a1b1f', light: '#2e2f35', darkc: '#0b0b0d', fiber: 0.08, speck: '#5a5b61', stain: 0.03, grain: 16, dark: true },
  };
  /** 字体：serif = Noto Serif SC Black（标题、数字）；sans = Noto Sans CJK SC（正文、标签）；hand = Long Cang（手写批注） */
  const F = {
    serif: '"Noto Serif SC", "Noto Sans CJK SC", serif',
    sans: '"Noto Sans CJK SC", "Noto Sans SC", sans-serif',
    hand: '"Long Cang", "Noto Sans CJK SC", cursive',
  };
  const FONT_SPEC = { serif: '900 40px "Noto Serif SC"', hand: '400 40px "Long Cang"' };
  const loaded = {};
  /** 用到网页字体时登记等待：渲染第一帧之前字体一定已经加载完（加载失败就退回黑体，不报错） */
  const fontOf = k => {
    if (FONT_SPEC[k] && !loaded[k] && document.fonts) { loaded[k] = true; S.waits.push(document.fonts.load(FONT_SPEC[k], '字').catch(() => null)); }
    return F[k] || k;
  };

  let uid = 0;
  const nid = p => `cl${p}${++uid}`;
  let seedN = 101;
  const nextSeed = () => (seedN += 7919) % 1000003;
  const el = (tag, attrs, parent) => S.svg(tag, attrs, parent);
  const hex = c => [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16));
  const mix = (c1, c2, p) => { const a = hex(c1), b = hex(c2), q = clamp(p); return '#' + a.map((v, i) => Math.round(v + (b[i] - v) * q).toString(16).padStart(2, '0')).join(''); };
  const rgba = (c, a) => { const [r, g, b] = hex(c); return `rgba(${r}, ${g}, ${b}, ${a})`; };
  const f1 = v => String(Math.round(v * 10) / 10);
  const P = (pts, close) => 'M ' + pts.map(p => f1(p[0]) + ' ' + f1(p[1])).join(' L ') + (close ? ' Z' : '');
  /** 过一串点的平滑曲线（Catmull-Rom 转三次贝塞尔），手绘线用 */
  const smooth = pts => {
    if (pts.length < 3) return P(pts);
    let d = `M ${f1(pts[0][0])} ${f1(pts[0][1])}`;
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)];
      d += ` C ${f1(p1[0] + (p2[0] - p0[0]) / 6)} ${f1(p1[1] + (p2[1] - p0[1]) / 6)} ${f1(p2[0] - (p3[0] - p1[0]) / 6)} ${f1(p2[1] - (p3[1] - p1[1]) / 6)} ${f1(p2[0])} ${f1(p2[1])}`;
    }
    return d;
  };
  const canvas = (w, h) => { const c = document.createElement('canvas'); c.width = Math.max(1, Math.ceil(w)); c.height = Math.max(1, Math.ceil(h)); return c; };
  const fmt = (v, d = 0) => Number(v).toFixed(d);
  /** 二维确定性噪声（世界坐标取样：同一位置永远同一个值） */
  const h2 = (seed, x, y) => { let s = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(seed | 0, 1442695041); s = Math.imul(s ^ (s >>> 13), 1274126177); s ^= s >>> 16; return (s >>> 0) / 4294967296; };
  const vnoise2 = (seed, x, y) => {
    const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy, ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
    return lerp(lerp(h2(seed, ix, iy), h2(seed, ix + 1, iy), ux), lerp(h2(seed, ix, iy + 1), h2(seed, ix + 1, iy + 1), ux), uy) * 2 - 1;
  };
  const fbm2 = (seed, x, y, oct = 3) => { let s = 0, a = 0.5, f = 1, n = 0; for (let i = 0; i < oct; i++) { s += a * vnoise2(seed + i * 31, x * f, y * f); n += a; a *= 0.5; f *= 2.03; } return s / n; };

  /** 一拍二：把时间按 hz（默认帧率的一半）量化。纸片入场、文字出现用它，镜头不用 */
  const step = (t, hz) => { const f = hz || Math.max(1, S.fps / 2); return Math.floor(t * f + 1e-6) / f; };

  /** 多维关键帧（单调三次插值，不过冲；首尾速度为 0）：track([[t, x, y, z], …])(t) → [x, y, z] */
  function track(keys) {
    const ks = keys.slice().sort((a, b) => a[0] - b[0]), n = ks.length, dim = ks[0].length - 1, ts = ks.map(k => k[0]);
    if (n === 1) return () => ks[0].slice(1);
    const tang = [];
    for (let c = 0; c < dim; c++) {
      const v = ks.map(k => k[c + 1]), dl = [], m = new Array(n).fill(0);
      for (let i = 0; i < n - 1; i++) dl.push((v[i + 1] - v[i]) / Math.max(1e-9, ts[i + 1] - ts[i]));
      for (let i = 1; i < n - 1; i++) {
        if (dl[i - 1] * dl[i] <= 0) continue;
        const h0 = ts[i] - ts[i - 1], h1 = ts[i + 1] - ts[i], w1 = 2 * h1 + h0, w2 = h1 + 2 * h0;
        m[i] = (w1 + w2) / (w1 / dl[i - 1] + w2 / dl[i]);
      }
      tang.push(m);
    }
    return t => {
      if (t <= ts[0]) return ks[0].slice(1);
      if (t >= ts[n - 1]) return ks[n - 1].slice(1);
      let i = 0;
      while (i < n - 2 && t > ts[i + 1]) i++;
      const h = ts[i + 1] - ts[i], s = (t - ts[i]) / h, s2 = s * s, s3 = s2 * s;
      const a = 2 * s3 - 3 * s2 + 1, b = s3 - 2 * s2 + s, c = -2 * s3 + 3 * s2, d = s3 - s2;
      return Array.from({ length: dim }, (_, k) => a * ks[i][k + 1] + b * h * tang[k][i] + c * ks[i + 1][k + 1] + d * h * tang[k][i + 1]);
    };
  }

  /** 每个 svg 根上放一次公用滤镜 */
  function defsOf(svg) {
    if (svg.__cl) return svg.__cl;
    const d = el('defs', {}, svg);
    const blur = sd => { const id = nid('b'); const f = el('filter', { id, x: '-30%', y: '-30%', width: '160%', height: '160%' }, d); el('feGaussianBlur', { stdDeviation: sd }, f); return `url(#${id})`; };
    svg.__cl = { d, soft: blur(U * 0.45), wide: blur(U * 1.1), img: {} };
    return svg.__cl;
  }
  const defs = node => defsOf(node.ownerSVGElement || node);
  const isHud = node => !!(node.closest && node.closest('.cl-hud'));
  /** 量文字宽度：复制到一个不缩放的隐藏 svg 里量。直接量会受当前镜头缩放影响（浏览器按屏幕字号排版），
   *  不同时刻量出来差零点几像素，会让"新开页面渲染"和"顺序渲染"的结果不一致 */
  let meas = null;
  const textW = e => {
    if (!meas) { meas = S.svg('svg', { width: 1, height: 1, 'data-qa': 'ignore', style: 'position:absolute;left:0;top:0;visibility:hidden;overflow:hidden' }); document.body.appendChild(meas); }
    const c = e.cloneNode(true);
    c.removeAttribute('transform'); c.removeAttribute('opacity'); c.removeAttribute('clip-path');
    meas.appendChild(c);
    const w = c.getComputedTextLength();
    c.remove();
    return w;
  };

  let CUR = null;   // 最近创建的舞台：组件用它算"推近后仍安全"的区域
  /** 默认字色跟着"字印在哪张纸上"走：在卡片里用卡片的 text/sub 色，直接印在底纸上就看底纸（暗场用浅色字） */
  const inkOf = (node, kind = 'text') => {
    for (let e = node; e; e = e.parentNode) if (e.__clTone) return e.__clTone[kind];
    const dark = CUR && PAPER[CUR.paper] && PAPER[CUR.paper].dark;
    return dark ? TONE.charcoal[kind] : TONE.white[kind];
  };
  const hudArea = () => {
    const bottom = S.captionsOn ? S.captionZone.y - U * 1.5 : S.safe.y + S.safe.h;
    return { x: S.safe.x + U, y: S.safe.y + U, w: S.safe.w - U * 2, h: bottom - S.safe.y - U * 2 };
  };
  const areaFor = node => (!CUR || isHud(node) ? hudArea() : CUR.area());

  /** 撕边矩形路径：torn 写哪几条边是撕开的（t 上、r 右、b 下、l 左），其余是剪刀剪的直边。
   *  amp 毛边幅度；grow 让撕开的边整体外扩（画白芯用） */
  function tornRect(x, y, w, h, o = {}) {
    const rnd = S.rng(o.seed || 1), amp = o.amp ?? U * 0.35, torn = o.torn ?? 'trbl', grow = o.grow || 0;
    const sides = [['t', [x, y], [x + w, y], [0, -1]], ['r', [x + w, y], [x + w, y + h], [1, 0]], ['b', [x + w, y + h], [x, y + h], [0, 1]], ['l', [x, y + h], [x, y], [-1, 0]]];
    const pts = [];
    sides.forEach(([k, a, b, nr], si) => {
      const isT = torn.includes(k), L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const n = Math.max(2, Math.round(L / (isT ? U * 0.55 : U * 8)));
      for (let i = 0; i < n; i++) {
        const s = i / n;
        let off = isT ? grow + S.noise((o.seed || 1) + si * 17, s * L / (U * 6)) * amp + (rnd() - 0.5) * amp * 1.1 : (rnd() - 0.5) * U * 0.05;
        if (isT && i === 0) off = grow * 0.5;
        pts.push([lerp(a[0], b[0], s) + nr[0] * off, lerp(a[1], b[1], s) + nr[1] * off]);
      }
    });
    return P(pts, true);
  }
  /** 剪刀剪的四边形：四个角各偏一点，像手剪的 */
  function cutRect(x, y, w, h, seed, j = U * 0.25) {
    const r = S.rng(seed), o = () => (r() - 0.5) * 2 * j;
    return P([[x + o(), y + o()], [x + w + o(), y + o()], [x + w + o(), y + h + o()], [x + o(), y + h + o()]], true);
  }

  // ---------------------------------------------------------------------------------------------
  // 纸面：程序生成（确定性噪声），纹理锚定在世界坐标——换镜头范围、换镜头，同一位置的纸纹都一样
  function blotch(x, x0, y0, w, h, cell, seed, K, alpha, freq, oct) {
    const lw = Math.ceil(w / cell) + 2, lh = Math.ceil(h / cell) + 2;
    const lc = canvas(lw, lh), lx = lc.getContext('2d'), id = lx.createImageData(lw, lh);
    const L = hex(K.light), Dk = hex(K.darkc);
    for (let j = 0; j < lh; j++) for (let i = 0; i < lw; i++) {
      const n = fbm2(seed, (x0 + i * cell) * freq, (y0 + j * cell) * freq, oct);
      const c = n > 0 ? L : Dk, k = (j * lw + i) * 4;
      id.data[k] = c[0]; id.data[k + 1] = c[1]; id.data[k + 2] = c[2]; id.data[k + 3] = Math.round(Math.min(1, Math.abs(n) * 1.8) * alpha * 255);
    }
    lx.putImageData(id, 0, 0);
    x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high';
    x.drawImage(lc, 0, 0, lw, lh, -cell / 2, -cell / 2, lw * cell, lh * cell);
  }
  function makePaper(kind, x0, y0, w, h, seed, fold) {
    const K = PAPER[kind] || PAPER.cream, cv = canvas(w, h), x = cv.getContext('2d');
    x.fillStyle = K.base; x.fillRect(0, 0, w, h);
    blotch(x, x0, y0, w, h, 16, seed, K, 0.16, 1 / (U * 16), 3);      // 大块明暗
    blotch(x, x0, y0, w, h, 4, seed + 9, K, 0.07, 1 / (U * 2.2), 2);    // 细的云纹
    // 纤维：按 128px 的世界网格逐格生成
    const cell = 128, rf = rgba(K.darkc, 1), rl = rgba(K.light, 1);
    for (let cj = Math.floor(y0 / cell) - 1; cj <= Math.ceil((y0 + h) / cell); cj++) for (let ci = Math.floor(x0 / cell) - 1; ci <= Math.ceil((x0 + w) / cell); ci++) {
      const r = S.rng(Math.floor(h2(seed, ci, cj) * 4294967295) || 1), nf = 2 + Math.floor(r() * 4);
      for (let k = 0; k < nf; k++) {
        const px = ci * cell + r() * cell - x0, py = cj * cell + r() * cell - y0, len = U * (0.6 + r() * 2.6), a = r() * TAU, bend = (r() - 0.5) * len * 0.6;
        const ex = px + Math.cos(a) * len, ey = py + Math.sin(a) * len;
        x.globalAlpha = K.fiber * (0.35 + r() * 0.65); x.strokeStyle = r() < 0.6 ? rf : rl; x.lineWidth = U * (0.04 + r() * 0.09);
        x.beginPath(); x.moveTo(px, py); x.quadraticCurveTo((px + ex) / 2 - Math.sin(a) * bend, (py + ey) / 2 + Math.cos(a) * bend, ex, ey); x.stroke();
      }
      if (r() < 0.35) {   // 杂质斑点
        x.globalAlpha = 0.18 + r() * 0.3; x.fillStyle = K.speck;
        x.beginPath(); x.arc(ci * cell + r() * cell - x0, cj * cell + r() * cell - y0, U * (0.04 + r() * 0.14), 0, TAU); x.fill();
      }
      if (r() < 0.03) {   // 很淡的水渍圈
        const sx = ci * cell + r() * cell - x0, sy = cj * cell + r() * cell - y0, sr = U * (4 + r() * 6);
        const g = x.createRadialGradient(sx, sy, sr * 0.75, sx, sy, sr);
        g.addColorStop(0, rgba(K.darkc, 0)); g.addColorStop(0.85, rgba(K.darkc, K.stain)); g.addColorStop(1, rgba(K.darkc, 0));
        x.globalAlpha = 1; x.fillStyle = g; x.fillRect(sx - sr, sy - sr, sr * 2, sr * 2);
      }
    }
    // 细颗粒：256px 图块按世界坐标平铺
    const tile = canvas(256, 256), tx = tile.getContext('2d'), td = tx.createImageData(256, 256), tr = S.rng(seed * 7 + 3);
    const L = hex(K.light), Dk = hex(K.darkc);
    for (let i = 0; i < 256 * 256; i++) { const v = tr(), c = v < 0.5 ? Dk : L, k = i * 4; td.data[k] = c[0]; td.data[k + 1] = c[1]; td.data[k + 2] = c[2]; td.data[k + 3] = Math.round(Math.abs(v - 0.5) * 2 * 26); }
    tx.putImageData(td, 0, 0);
    x.globalAlpha = 1; x.save(); x.translate(-(((x0 % 256) + 256) % 256), -(((y0 % 256) + 256) % 256)); x.fillStyle = x.createPattern(tile, 'repeat'); x.fillRect(0, 0, w + 256, h + 256); x.restore();
    if (fold) {   // 对折痕：一道暗线一道亮线
      const crease = (vert, at) => {
        const p = (vert ? at - x0 : at - y0), g = vert ? x.createLinearGradient(p - U, 0, p + U, 0) : x.createLinearGradient(0, p - U, 0, p + U);
        g.addColorStop(0, rgba(K.darkc, 0)); g.addColorStop(0.45, rgba(K.darkc, 0.13)); g.addColorStop(0.55, rgba(K.light, 0.35)); g.addColorStop(1, rgba(K.light, 0));
        x.fillStyle = g; if (vert) x.fillRect(p - U, 0, U * 2, h); else x.fillRect(0, p - U, w, U * 2);
      };
      crease(true, W * 0.5); crease(false, H * 0.5);
    }
    x.globalAlpha = 1;
    return cv;
  }
  function vignette(K) {
    const c = canvas(W, H), x = c.getContext('2d'), R = Math.hypot(W, H) / 2;
    const g = x.createRadialGradient(W / 2, H / 2, R * 0.45, W / 2, H / 2, R * 1.02);
    g.addColorStop(0, rgba(K.darkc, 0)); g.addColorStop(1, rgba(K.darkc, K.dark ? 0.55 : 0.26));
    x.fillStyle = g; x.fillRect(0, 0, W, H);
    return c;
  }
  /** 颗粒图块：浅色纸用"相乘"（白底暗点），暗场用"滤色"（黑底亮点）。每块 96px，放大 2 倍成颗粒 */
  function grainTile(seed, K) {
    const n = 96, sm = canvas(n, n), sx = sm.getContext('2d'), id = sx.createImageData(n, n), r = S.rng(seed);
    for (let i = 0; i < n * n; i++) {
      const v = Math.pow(r(), 5) * K.grain * 1.9, k = i * 4;
      if (K.dark) { id.data[k] = id.data[k + 1] = id.data[k + 2] = Math.round(v); }
      else { id.data[k] = Math.round(255 - v); id.data[k + 1] = Math.round(255 - v * 1.05); id.data[k + 2] = Math.round(255 - v * 1.2); }
      id.data[k + 3] = 255;
    }
    sx.putImageData(id, 0, 0);
    const c = canvas(n * 2, n * 2), x = c.getContext('2d');
    x.imageSmoothingEnabled = false; x.drawImage(sm, 0, 0, n * 2, n * 2);
    return c;
  }
  /** 网点覆盖：amt 0～1；mode 'in' 网点从小长大盖满画面，'out' 从盖满到缩没；dir 是推进方向 */
  function dotWipe(ctx, amt, mode, color, dir = 'right', pitch = U * 3.4) {
    const rmax = pitch * 0.74, spread = 0.45, ca = Math.SQRT1_2, R = Math.hypot(W, H) / 2 + pitch, n = Math.ceil(R / pitch);
    ctx.save(); ctx.fillStyle = color; ctx.beginPath();
    for (let j = -n; j <= n; j++) for (let i = -n; i <= n; i++) {
      const gx = i * pitch, gy = j * pitch, x = W / 2 + (gx - gy) * ca, y = H / 2 + (gx + gy) * ca;
      if (x < -pitch || x > W + pitch || y < -pitch || y > H + pitch) continue;
      let s = dir === 'left' ? 1 - x / W : dir === 'up' ? 1 - y / H : dir === 'down' ? y / H : x / W;
      s = clamp(s + (h2(77, i, j) - 0.5) * 0.08);
      const local = clamp((amt * (1 + spread) - s) / spread);
      const r = mode === 'in' ? rmax * ease.out(local) : rmax * (1 - ease.in(local));
      if (r > 0.4) { ctx.moveTo(x + r, y); ctx.arc(x, y, r, 0, TAU); }
    }
    ctx.fill(); ctx.restore();
  }

  // ---------------------------------------------------------------------------------------------
  /** 舞台：底纸 canvas + 内容 svg（world 跟镜头、hud 贴屏）+ 转场层 + 颗粒层。
   *  opts: paper: 'cream' | 'newsprint' | 'kraft' | 'dark'（一支片只用一种）, seed（纸纹种子，默认 7）, fold（对折痕，默认 false）,
   *        push（整镜慢推幅度，默认 0.04，即 4%）, drift: [dx, dy]（推的同时平移，像素）,
   *        cam: [[t, x, y, zoom], …]（自定义镜头：t 秒时屏幕中心对准世界坐标 (x, y)；给了就忽略 push/drift）,
   *        depth（底纸的视差系数，默认 0.6）, grain（颗粒强度 0～1，默认 1，每 2 帧换一次）,
   *        enter: 'dots' | 'none'（开场网点退去；默认 none）, exit: 'dots' | 'sheet' | 'none'（结尾网点盖满或一张新纸盖过来）,
   *        wipeColor（网点颜色，默认墨色；暗场默认红）, wipeDir（'right' | 'left' | 'up' | 'down'）,
   *        punch: [秒, …]（全画面冲击：轻震 + 白闪 ≤0.42。全片最多 3 处）
   *  返回 { svg, world, back, front, hud, layer(depth), set(t), area(opts), toScreen(x, y, depth), guard(g, box), wipe(t, at, opts) }：
   *    back / world / front 是视差 0.85 / 1 / 1.15 的三层；render(t) 第一行调用 st.set(t)。 */
  function stage(opts = {}) {
    const D = S.duration;
    const o = { paper: 'cream', seed: 7, fold: false, push: 0.04, drift: [0, 0], cam: null, depth: 0.6, grain: 1, enter: 'none', exit: 'none', wipeDir: 'right', punch: [], ...opts };
    const K = PAPER[o.paper] || PAPER.cream;
    document.documentElement.style.background = K.base; document.body.style.background = K.base;
    const root = document.createElement('div');
    root.className = 'cl-root' + (K.dark ? ' cl-dark' : '');
    root.style.background = K.base;
    const bg = canvas(W, H); root.appendChild(bg);
    const svg = el('svg', { class: 'cl-svg', width: W, height: H, viewBox: `0 0 ${W} ${H}` }); root.appendChild(svg);
    const fxc = canvas(W, H); root.appendChild(fxc);
    const gc = canvas(W, H); gc.className = 'cl-grain'; root.appendChild(gc);
    document.body.insertBefore(root, document.body.firstChild);
    defsOf(svg);
    // 每帧整张 svg 重画：浏览器默认只重画"变了的区域"，静止元素和动画元素相邻时，交界处的抗锯齿像素会随渲染历史变化。
    // 这块几乎透明的底板每个 t 的透明度都不同（0.001～0.002，肉眼和像素上都看不出），迫使整屏重画，让每一帧只由 t 决定
    const repaint = el('rect', { x: 0, y: 0, width: W, height: H, fill: '#000', opacity: 0.001, 'pointer-events': 'none' }, svg);
    const worldRoot = el('g', {}, svg), hud = el('g', { class: 'cl-hud' }, svg);
    const layers = [];
    const layer = (depth = 1) => { const g = el('g', {}, worldRoot); layers.push({ g, depth }); return g; };
    const back = layer(0.85), world = layer(1), front = layer(1.15);
    const tr = track(o.cam || [[0, W / 2, H / 2, 1], [D, W / 2 + o.drift[0], H / 2 + o.drift[1], 1 + o.push]]);
    // 底纸要覆盖整条镜头路线（含视差），外加转场用的初始画面
    let ex0 = 0, ey0 = 0, ex1 = W, ey1 = H;
    for (let i = 0; i <= 48; i++) {
      const [cx, cy, z] = tr(D * i / 48), zb = 1 + (z - 1) * o.depth, bx = W / 2 + (cx - W / 2) * o.depth, by = H / 2 + (cy - H / 2) * o.depth;
      ex0 = Math.min(ex0, bx - W / 2 / zb); ex1 = Math.max(ex1, bx + W / 2 / zb); ey0 = Math.min(ey0, by - H / 2 / zb); ey1 = Math.max(ey1, by + H / 2 / zb);
    }
    const snap = 256, pad = U * 4;
    ex0 = Math.floor((ex0 - pad) / snap) * snap; ey0 = Math.floor((ey0 - pad) / snap) * snap;
    ex1 = Math.ceil((ex1 + pad) / snap) * snap; ey1 = Math.ceil((ey1 + pad) / snap) * snap;
    const paper = makePaper(o.paper, ex0, ey0, ex1 - ex0, ey1 - ey0, o.seed, o.fold);
    const vig = vignette(K);
    const bx_ = bg.getContext('2d'), fx = fxc.getContext('2d'), gx = gc.getContext('2d');
    const tiles = [0, 1, 2, 3].map(k => gx.createPattern(grainTile(o.seed * 13 + k * 101, K), 'repeat'));
    const guards = [];
    let cam = [W / 2, H / 2, 1, 0, 0], areaCache = null;
    const xf = (depth, c = cam) => { const zb = 1 + (c[2] - 1) * depth; return [zb, W / 2 - (W / 2 + (c[0] - W / 2) * depth) * zb + c[3], H / 2 - (H / 2 + (c[1] - H / 2) * depth) * zb + c[4]]; };

    function sheet(a) {   // 一张同样的新纸从右边盖过来（下一镜开头就是这张纸）
      const X = W * (1 - a);
      const g = fx.createLinearGradient(X - U * 3, 0, X, 0);
      g.addColorStop(0, rgba(C.shadow, 0)); g.addColorStop(1, rgba(C.shadow, 0.28));
      fx.fillStyle = g; fx.fillRect(X - U * 3, 0, U * 3, H);
      fx.drawImage(paper, -ex0, -ey0, W, H, X, 0, W, H);
      fx.drawImage(vig, X, 0);
    }
    const api = {
      svg, root, world, back, front, hud, layer, paper: o.paper,
      /** 世界坐标 → 屏幕坐标（用当前帧的镜头） */
      toScreen(x, y, depth = 1) { const [z, tx, ty] = xf(depth); return [x * z + tx, y * z + ty]; },
      /** 内容可用区域：整镜推拉之后仍在安全区内、且在字幕区以上。opts.top：从这里往下（例如 heading().bottom + U * 2）
       *  横移很大的镜头（时间线）这个区域会很窄，那时标题和角标放 hud，世界里的文字用 guard */
      area(a = {}) {
        if (!areaCache) {
          const bottom = S.captionsOn ? S.captionZone.y - U * 1.5 : S.safe.y + S.safe.h;
          let x0 = -1e9, y0 = -1e9, x1 = 1e9, y1 = 1e9;
          for (let i = 0; i <= 32; i++) {
            const [cx, cy, z] = tr(D * i / 32);
            x0 = Math.max(x0, cx + (S.safe.x - W / 2) / z); x1 = Math.min(x1, cx + (S.safe.x + S.safe.w - W / 2) / z);
            y0 = Math.max(y0, cy + (S.safe.y - H / 2) / z); y1 = Math.min(y1, cy + (bottom - H / 2) / z);
          }
          const m = U * 1.2;
          areaCache = { x: x0 + m, y: y0 + m, w: x1 - x0 - m * 2, h: y1 - y0 - m * 2 };
        }
        const r = { ...areaCache };
        if (a.top != null && a.top > r.y) { r.h -= a.top - r.y; r.y = a.top; }
        r.cx = r.x + r.w / 2; r.cy = r.y + r.h / 2;
        return r;
      },
      /** 横移时让世界里的文字在碰到安全区边缘之前淡出：box = [x, y, w, h]（世界坐标，含文字的范围）。g 的透明度归 guard 管 */
      guard(g, box, depth = 1) { guards.push({ g, box, depth }); },
      /** 一镜之内的网点转场：at 秒开始、dur 秒（默认 0.44）。前半盖满、后半退去；返回 true 表示已经过了中点（该换成下一组内容）。
       *  必须在 st.set(t) 之后调用 */
      wipe(t, at, w = {}) {
        const dur = w.dur || 0.44, half = dur / 2, color = w.color || o.wipeColor || (K.dark ? C.red : C.ink);
        if (t >= at && t < at + half) dotWipe(fx, ease.in(clamp((t - at) / half)), 'in', color, w.dir || o.wipeDir);
        else if (t >= at + half && t < at + dur) dotWipe(fx, ease.out(clamp((t - at - half) / half)), 'out', color, w.dir || o.wipeDir);
        return t >= at + half;
      },
      set(t) {
        let [cx, cy, z] = tr(t), sx = 0, sy = 0, flash = 0;
        for (const tp of o.punch) {
          const k = t - tp;
          if (k >= 0 && k < 0.24) { const a = U * 0.8 * Math.pow(1 - k / 0.24, 2); sx += S.noise(31, t * 45) * a; sy += S.noise(57, t * 45) * a; z *= 1 + 0.01 * (1 - k / 0.24); }
          if (k >= 0 && k < 0.14) flash = Math.max(flash, 0.42 * (1 - k / 0.14));
        }
        cam = [cx, cy, z, sx, sy];
        repaint.setAttribute('opacity', (0.001 + 0.001 * h2(5, Math.round(t * S.fps * 8), 0)).toFixed(5));
        for (const L of layers) { const [zb, tx, ty] = xf(L.depth); L.g.setAttribute('transform', `matrix(${zb.toFixed(5)} 0 0 ${zb.toFixed(5)} ${tx.toFixed(2)} ${ty.toFixed(2)})`); }
        // 底纸
        const [zb, tx, ty] = xf(o.depth);
        bx_.setTransform(1, 0, 0, 1, 0, 0); bx_.fillStyle = K.base; bx_.fillRect(0, 0, W, H);
        bx_.imageSmoothingEnabled = true; bx_.setTransform(zb, 0, 0, zb, tx, ty); bx_.drawImage(paper, ex0, ey0);
        bx_.setTransform(1, 0, 0, 1, 0, 0); bx_.drawImage(vig, 0, 0);
        // 转场层
        fx.clearRect(0, 0, W, H);
        const last = D - 1 / S.fps, dur = 0.24, dotC = o.wipeColor || (K.dark ? C.red : C.ink);
        if (o.enter === 'dots' && t < dur) dotWipe(fx, ease.out(clamp(t / dur)), 'out', dotC, o.wipeDir);
        if (o.exit === 'dots' && t > last - dur) dotWipe(fx, ease.in(clamp((t - (last - dur)) / dur)), 'in', dotC, o.wipeDir);
        if (o.exit === 'sheet' && t > last - 0.5) sheet(ease.in(clamp((t - (last - 0.5)) / 0.5)));
        if (flash > 0) { fx.fillStyle = `rgba(255, 255, 255, ${flash.toFixed(3)})`; fx.fillRect(0, 0, W, H); }
        // 颗粒：每 2 帧换一块、换一个偏移
        gx.clearRect(0, 0, W, H);
        if (o.grain > 0) {
          const f = Math.floor(t * S.fps / 2 + 1e-6), r = S.rng(9001 + f * 7);
          gx.save(); gx.globalAlpha = clamp(o.grain); gx.translate(-Math.floor(r() * 192), -Math.floor(r() * 192));
          gx.fillStyle = tiles[f % 4]; gx.fillRect(0, 0, W + 192, H + 192); gx.restore();
        }
        // 横移时的文字淡出
        const bottom = S.captionsOn ? S.captionZone.y : S.safe.y + S.safe.h;
        for (const gd of guards) {
          const [a0, b0] = api.toScreen(gd.box[0], gd.box[1], gd.depth), [a1, b1] = api.toScreen(gd.box[0] + gd.box[2], gd.box[1] + gd.box[3], gd.depth);
          const dist = Math.min(a0 - S.safe.x, S.safe.x + S.safe.w - a1, b0 - S.safe.y, bottom - b1);
          gd.g.setAttribute('opacity', clamp((dist - U * 0.6) / (U * 3)).toFixed(3));
        }
      },
    };
    CUR = api;
    return api;
  }

  // ---------------------------------------------------------------------------------------------
  /** 纸片入场（tornCard、piece、cutout、strip 共用）。from：drop 落下（默认）| left | right | top | bottom（从画外滑入）| none。
   *  滑入途中，内容层（字）在碰到安全区边缘之前就淡出，落定后恒为 1，所以飞行中的字不会越界 */
  function entrance(g, sh, inner, getBox, from) {
    return p => {
      const k = ease.out(clamp(p)), q = 1 - k, b = getBox();
      let dx = 0, dy = 0, s = 1, r = 0, lift = 0;
      if (from === 'left') { dx = -(b.x + b.w + U * 8) * q; r = -5 * q; lift = q * 0.5; }
      else if (from === 'right') { dx = (W - b.x + U * 8) * q; r = 5 * q; lift = q * 0.5; }
      else if (from === 'top') { dy = -(b.y + b.h + U * 8) * q; r = 4 * q; lift = q * 0.5; }
      else if (from === 'bottom') { dy = (H - b.y + U * 8) * q; r = -4 * q; lift = q * 0.5; }
      else if (from !== 'none') { s = 1 + 0.09 * q; r = 2.5 * q; lift = q; }
      const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
      g.setAttribute('transform', `translate(${f1(dx)} ${f1(dy)}) rotate(${r.toFixed(2)} ${f1(cx)} ${f1(cy)}) translate(${f1(cx)} ${f1(cy)}) scale(${s.toFixed(4)}) translate(${f1(-cx)} ${f1(-cy)})`);
      g.setAttribute('opacity', p > 0 ? (from === 'drop' || !from ? clamp(p * 6) : 1) : 0);
      if (sh) { sh.setAttribute('transform', `translate(${f1(U * (0.3 + 1.4 * lift))} ${f1(U * (0.5 + 2.2 * lift))})`); sh.setAttribute('opacity', (0.26 - 0.1 * lift).toFixed(3)); }
      if (inner) {
        let op = 1;
        const d = Math.abs(dx) + Math.abs(dy);
        if (d > 0.5) {
          const a = areaFor(g);
          const m = from === 'left' ? b.x - a.x : from === 'right' ? a.x + a.w - (b.x + b.w) : from === 'top' ? b.y - a.y : a.y + a.h - (b.y + b.h);
          op = clamp((Math.max(0, m) - d) / (U * 2));
        }
        inner.setAttribute('opacity', op.toFixed(3));
      }
    };
  }
  const thick = (e, color, size) => { e.setAttribute('stroke', color); e.setAttribute('stroke-width', f1(size * 0.035)); e.setAttribute('stroke-linejoin', 'round'); e.setAttribute('paint-order', 'stroke'); };
  const mkText = (parent, a, s) => { const e = el('text', a, parent); e.textContent = s; return e; };

  // ---------------------------------------------------------------------------------------------
  /** 栏目标签（红底白字；中文没有压缩粗体，用 Noto Sans CJK Black 横向压到 0.9 近似）：opts x, y（基线）, text, size, anchor, fill, color；draw(p) 弹出。宽度在第一次 draw 时量 */
  function kicker(parent, o) {
    const size = o.size || U * 2.5, sp = size * 0.12, g = el('g', { opacity: 0 }, parent);
    const bg = el('path', { fill: o.fill || C.red }, g);
    const tx = mkText(g, { x: 0, y: 0, 'font-size': size, 'font-weight': 900, 'font-family': F.sans, fill: o.color || '#fff8ee', 'letter-spacing': f1(sp) }, o.text);
    let box = null;
    const layout = () => {
      if (box) return;
      const w = (textW(tx) - sp) * 0.9, padX = size * 0.5;
      const x0 = o.anchor === 'middle' ? o.x - w / 2 : o.anchor === 'end' ? o.x - w : o.x + padX;
      tx.setAttribute('transform', `translate(${f1(x0)} ${f1(o.y)}) scale(0.9 1)`);
      box = { x: x0 - padX, y: o.y - size * 0.98, w: w + padX * 2, h: size * 1.3 };
      bg.setAttribute('d', cutRect(box.x, box.y, box.w, box.h, o.seed || 3, U * 0.12));
    };
    return {
      g, get box() { layout(); return box; },
      draw(p) {
        layout();
        const k = ease.out(clamp(p)), cx = box.x + box.w / 2, cy = box.y + box.h / 2, s = 1 + 0.3 * (1 - k);
        g.setAttribute('opacity', p > 0 ? clamp(p * 4) : 0);
        g.setAttribute('transform', `translate(${f1(cx)} ${f1(cy)}) scale(${s.toFixed(3)}) translate(${f1(-cx)} ${f1(-cy)})`);
      },
    };
  }

  /** 页面标题：红色栏目标签（可选）+ 宋体大标题（可用 \n 换行）+ 报纸式双线 + 副标题（可选）。
   *  放在 world 里时自动避开镜头推近；放在 hud 里时固定贴屏（横移的镜头用 hud）。
   *  opts text, kicker, sub, size（默认 6.4u）, align: 'left' | 'center', color
   *  返回 { bottom（标题区下沿 y）, draw(p) }。draw(p)：标签弹出 → 标题从左往右"印"出来 → 双线画出 */
  function heading(parent, o) {
    const box = areaFor(parent), size = o.size || U * 6.4, center = o.align === 'center', ks = U * 2.5;
    const ax = center ? box.x + box.w / 2 : box.x, anchor = center ? 'middle' : 'start';
    const g = el('g', {}, parent);
    let kb = box.y + ks * 1.16, hb = box.y + size * 1.16;
    const kick = o.kicker ? kicker(g, { x: center ? ax : ax - ks * 0.5, y: kb, text: o.kicker, size: ks, anchor }) : null;
    if (kick) hb = kb + ks * 0.32 + U * 1.4 + size * 0.88;
    const lines = String(o.text).split('\n'), lh = size * 1.18;
    const clipId = nid('hc'), clip = el('clipPath', { id: clipId }, defs(parent).d), cr = el('rect', { x: 0, y: hb - size * 1.3, width: 0, height: lh * lines.length + size * 0.6 }, clip);
    const tg = el('g', { 'clip-path': `url(#${clipId})` }, g);
    const tels = lines.map((ln, i) => mkText(tg, { x: ax, y: hb + i * lh, 'font-size': size, 'font-weight': 900, 'font-family': fontOf('serif'), fill: o.color || inkOf(parent), 'text-anchor': anchor, 'letter-spacing': f1(size * 0.01) }, ln));
    const lastB = hb + (lines.length - 1) * lh, r1 = lastB + size * 0.12 + U * 1.1, r2 = r1 + U * 0.75;
    const rule1 = el('line', { y1: r1, y2: r1, stroke: o.color || inkOf(parent), 'stroke-width': U * 0.45 }, g);
    const rule2 = el('line', { y1: r2, y2: r2, stroke: o.color || inkOf(parent), 'stroke-width': U * 0.15 }, g);
    const subSize = U * 3;
    const sub = o.sub ? text(g, { x: ax, y: r2 + U * 1.1 + subSize * 0.88, text: o.sub, size: subSize, color: inkOf(parent, 'sub'), anchor, weight: 500 }) : null;
    let wmax = null;
    const layout = () => { if (wmax == null) wmax = Math.max(...tels.map(textW)); };
    return {
      g, bottom: (sub ? r2 + U * 1.1 + subSize * 1.17 : r2) + U * 1.2, size,
      draw(p) {
        layout();
        if (kick) kick.draw(clamp(p / 0.3));
        const q = ease.inOut(clamp((p - 0.12) / 0.6)), left = center ? ax - wmax / 2 : ax;
        cr.setAttribute('x', f1(left - U)); cr.setAttribute('width', f1((wmax + U * 2) * q));
        tg.setAttribute('opacity', p > 0 ? 1 : 0);
        const r = ease.out(clamp((p - 0.5) / 0.5)), rw = Math.max(wmax, U * 20), rx = center ? ax - rw / 2 * r : ax;
        [rule1, rule2].forEach((e, i) => { e.setAttribute('x1', f1(rx)); e.setAttribute('x2', f1(rx + rw * r * (center ? 1 : 1) * (i ? 0.999 : 1))); e.setAttribute('opacity', r > 0 ? 1 : 0); });
        if (sub) sub.draw(clamp((p - 0.6) / 0.4));
      },
    };
  }

  /** 文字：opts x, y（第一行基线）, text（\n 换行）或 lines, size（默认 3.6u）, font: 'sans' | 'serif' | 'hand', weight, color, anchor, lh（行距倍数）, spacing（字距，em）, rotate
   *  返回 { g, els, bottom, width(), draw(p) 淡入上浮, set(text) 改单行文字 } */
  function text(parent, o) {
    const size = o.size || U * 3.6, font = o.font || 'sans', lh = o.lh || (font === 'serif' ? 1.25 : 1.42);
    const lines = Array.isArray(o.lines) ? o.lines : String(o.text ?? '').split('\n');
    const g = el('g', {}, parent), a = el('g', { opacity: 0 }, g);
    if (o.rotate) g.setAttribute('transform', `rotate(${o.rotate} ${f1(o.x)} ${f1(o.y)})`);
    const weight = o.weight || (font === 'serif' ? 900 : font === 'hand' ? 400 : 500);
    const sp = (o.spacing ?? (font === 'hand' ? -0.03 : 0.02)) * size, color = o.color || inkOf(parent);
    const els = lines.map((ln, i) => {
      const e = mkText(a, { x: o.x, y: o.y + i * size * lh, 'font-size': f1(size), 'font-weight': weight, 'font-family': fontOf(font), fill: color, 'text-anchor': o.anchor || 'start', 'letter-spacing': f1(sp) }, ln);
      if (font === 'hand') thick(e, color, size);
      return e;
    });
    return {
      g, els, el: els[0], size, bottom: o.y + (lines.length - 1) * size * lh + size * 0.29,
      width() { return Math.max(...els.map(textW)); },
      draw(p) { const k = ease.out(clamp(p)); a.setAttribute('opacity', p > 0 ? k.toFixed(3) : 0); a.setAttribute('transform', `translate(0 ${f1((1 - k) * U * 1.2)})`); },
      set(s) { if (els[0].textContent !== s) els[0].textContent = s; },
    };
  }

  /** 手写批注（Long Cang，马克笔红）：opts x, y（基线）, text（\n 换行）, size（默认 4.4u）, color, rotate（默认 -3°）, anchor
   *  draw(p)：从左往右"写"出来（逐行） */
  function note(parent, o) {
    const size = o.size || U * 4.4, color = o.color || C.red, rot = o.rotate ?? -3, lh = size * 1.18;
    const g = el('g', { class: 'cl-ink', transform: `rotate(${rot} ${f1(o.x)} ${f1(o.y)})` }, parent);
    const clipId = nid('nc'), clip = el('clipPath', { id: clipId }, defs(parent).d);
    const body = el('g', { 'clip-path': `url(#${clipId})`, opacity: 0 }, g);
    const lines = String(o.text).split('\n');
    const els = lines.map((ln, i) => { const e = mkText(body, { x: o.x, y: o.y + i * lh, 'font-size': f1(size), 'font-family': fontOf('hand'), fill: color, 'text-anchor': o.anchor || 'start', 'letter-spacing': f1(-0.03 * size) }, ln); thick(e, color, size); return e; });
    const rects = lines.map((_, i) => el('rect', { y: f1(o.y + i * lh - size * 1.25), height: f1(size * 1.7), width: 0 }, clip));
    let ws = null;
    const layout = () => { if (!ws) ws = els.map(textW); };
    return {
      g,
      draw(p) {
        layout();
        const total = ws.reduce((s, w) => s + w, 0), q = clamp(p) * total;
        let acc = 0;
        rects.forEach((r, i) => {
          const w = ws[i], x0 = o.anchor === 'middle' ? o.x - w / 2 : o.anchor === 'end' ? o.x - w : o.x;
          r.setAttribute('x', f1(x0 - size * 0.3)); r.setAttribute('width', f1(clamp((q - acc) / w) * (w + size * 0.6)));
          acc += w;
        });
        body.setAttribute('opacity', p > 0 ? 1 : 0);
      },
    };
  }

  /** 金句纸条：一条剪下来的纸，上面印一句话。opts x, y（文字基线）, text, size（默认 4.4u）, font（默认 serif）, tone（默认 white）,
   *  anchor（默认 start）, rotate（默认 -1°）, from（默认 left）, color, seed
   *  返回 { g, box()（纸条范围，第一次 draw 之后才准）, draw(p) } */
  function strip(parent, o) {
    const size = o.size || U * 4.4, font = o.font || 'serif', tone = TONE[o.tone || 'white'] || TONE.white, seed = o.seed ?? nextSeed();
    const padX = size * 0.55, padY = size * 0.36;
    const g = el('g', { opacity: 0 }, parent), body = el('g', {}, g);
    const sh = el('path', { fill: C.shadow, filter: defs(parent).soft, opacity: 0.26 }, body);
    const face = el('path', { fill: tone.fill }, body);
    const inner = el('g', {}, body);
    inner.__clTone = tone;
    const tx = mkText(inner, { x: o.x, y: o.y, 'font-size': f1(size), 'font-weight': font === 'serif' ? 900 : o.weight || 700, 'font-family': fontOf(font), fill: o.color || tone.text, 'text-anchor': o.anchor || 'start', 'letter-spacing': f1(size * 0.02) }, o.text);
    if (font === 'hand') thick(tx, o.color || tone.text, size);
    let bx = null;
    const layout = () => {
      if (bx) return;
      const w = textW(tx) - size * 0.02, x0 = o.anchor === 'middle' ? o.x - w / 2 : o.anchor === 'end' ? o.x - w : o.x;
      bx = { x: x0 - padX, y: o.y - size * 0.9 - padY, w: w + padX * 2, h: size * 1.04 + padY * 2 };
      const d = cutRect(bx.x, bx.y, bx.w, bx.h, seed, U * 0.28);
      face.setAttribute('d', d); sh.setAttribute('d', d);
      body.setAttribute('transform', `rotate(${o.rotate ?? -1} ${f1(bx.x + bx.w / 2)} ${f1(bx.y + bx.h / 2)})`);
    };
    const ent = entrance(g, sh, inner, () => { layout(); return bx; }, o.from || 'left');
    return { g, box() { layout(); return bx; }, draw(p) { layout(); ent(p); } };
  }

  /** 序号圆章：opts x, y（圆心）, text（如 '1'）, size（默认 3u）, fill（默认红）；draw(p) 弹出 */
  function badge(parent, o) {
    const s = o.size || U * 3, g = el('g', { opacity: 0 }, parent);
    el('circle', { cx: o.x, cy: o.y, r: s * 0.68, fill: o.fill || C.red }, g);
    mkText(g, { x: o.x, y: o.y + s * 0.36, 'font-size': f1(s), 'font-weight': 900, 'font-family': fontOf('serif'), fill: '#fff8ee', 'text-anchor': 'middle' }, o.text);
    return { g, draw(p) { const k = ease.back(clamp(p)); g.setAttribute('opacity', p > 0 ? clamp(p * 4) : 0); g.setAttribute('transform', `translate(${f1(o.x)} ${f1(o.y)}) scale(${(0.4 + 0.6 * k).toFixed(3)}) translate(${f1(-o.x)} ${f1(-o.y)})`); } };
  }

  /** 出处标签（每个数据画面都要有）：白纸条 + 左侧红色竖条。默认在右下角、字幕区以上，放 st.hud。
   *  opts text, x, y（基线）, anchor（默认 end）, size（默认 2.1u）；draw(p) 从右侧滑入 */
  function sourceTag(parent, o) {
    const size = o.size || U * 2.1, anchor = o.anchor || 'end';
    const x = o.x ?? (anchor === 'end' ? S.safe.x + S.safe.w - U * 0.8 : S.safe.x + U * 0.8);
    const y = o.y ?? (S.captionsOn ? S.captionZone.y - U * 1.9 : S.safe.y + S.safe.h - U * 1.6);
    const g = el('g', { opacity: 0 }, parent);
    const sh = el('path', { fill: C.shadow, opacity: 0.18, filter: defs(parent).soft, transform: `translate(${U * 0.2} ${U * 0.3})` }, g);
    const face = el('path', { fill: TONE.white.fill }, g), bar = el('rect', { fill: C.red }, g);
    const tx = mkText(g, { x, y, 'font-size': f1(size), 'font-weight': 500, 'font-family': F.sans, fill: C.ink2, 'text-anchor': anchor }, o.text);
    let done = false;
    const layout = () => {
      if (done) return; done = true;
      const w = textW(tx), x0 = anchor === 'end' ? x - w : anchor === 'middle' ? x - w / 2 : x + U * 1.4;
      if (anchor === 'start') tx.setAttribute('x', f1(x0));
      const b = { x: x0 - U * 1.6, y: y - size * 0.98, w: w + U * 2.4, h: size * 1.38 };
      const d = cutRect(b.x, b.y, b.w, b.h, 11, U * 0.1);
      face.setAttribute('d', d); sh.setAttribute('d', d);
      bar.setAttribute('x', f1(b.x)); bar.setAttribute('y', f1(b.y)); bar.setAttribute('width', f1(U * 0.55)); bar.setAttribute('height', f1(b.h));
    };
    return { g, draw(p) { layout(); const k = ease.out(clamp(p)); g.setAttribute('opacity', p > 0 ? k.toFixed(3) : 0); g.setAttribute('transform', `translate(${f1((1 - k) * U * 3)} 0)`); } };
  }

  /** 角标（"示例数据"、截至日期等）：红框红字，默认右上角，放 st.hud。opts text, x, y（右上角）, size；draw(p) */
  function watermark(parent, o) {
    const size = o.size || U * 2, x = o.x ?? S.safe.x + S.safe.w - U * 0.6, y = o.y ?? S.safe.y + U * 0.6;
    const g = el('g', { opacity: 0, class: 'cl-ink' }, parent);
    const box = el('rect', { fill: 'none', stroke: C.red, 'stroke-width': U * 0.22 }, g);
    const tx = mkText(g, { x: x - size * 0.6, y: y + size * 1.3, 'font-size': f1(size), 'font-weight': 700, 'font-family': F.sans, fill: C.red, 'text-anchor': 'end', 'letter-spacing': f1(size * 0.1) }, o.text);
    let done = false;
    const layout = () => { if (done) return; done = true; const w = textW(tx); box.setAttribute('x', f1(x - w - size * 1.1)); box.setAttribute('y', f1(y)); box.setAttribute('width', f1(w + size * 1.1)); box.setAttribute('height', f1(size * 1.75)); };
    return { g, draw(p) { layout(); g.setAttribute('opacity', p > 0 ? ease.out(clamp(p)).toFixed(3) : 0); } };
  }

  // ---------------------------------------------------------------------------------------------
  /** 撕纸卡：撕开的边露出 0.3～0.6u 的白芯，下面一层软投影。
   *  opts x, y, w, h, tone（white | cream | newsprint | kraft | ink | red | yellow | charcoal，默认 white）, rotate（度）,
   *       torn（哪几条边是撕的，默认 'trbl'；剪报常用 'tb'）, rim（白芯宽，默认 0.6u）, shadow（默认 true）, from（入场方式）, seed
   *  返回 { g, inner（往卡片上放文字、图都放这里，跟着卡片动）, x, y, w, h, cx, cy, tone, draw(p) } */
  function tornCard(parent, o) {
    const tone = TONE[o.tone || 'white'] || TONE.white, seed = o.seed ?? nextSeed(), torn = o.torn ?? 'trbl';
    const { x, y, w, h } = o, cx = x + w / 2, cy = y + h / 2;
    const g = el('g', { opacity: 0 }, parent), body = el('g', { transform: `rotate(${o.rotate || 0} ${f1(cx)} ${f1(cy)})` }, g);
    const rimD = tornRect(x, y, w, h, { seed: seed + 1, torn, amp: U * 0.42, grow: o.rim ?? U * 0.6 });
    const sh = o.shadow === false ? null : el('path', { d: rimD, fill: C.shadow, opacity: 0.26, filter: defs(parent).soft }, body);
    el('path', { d: rimD, fill: tone.rim }, body);
    const face = el('path', { d: tornRect(x, y, w, h, { seed, torn, amp: U * 0.3 }), fill: tone.fill }, body);
    const inner = el('g', {}, body);
    inner.__clTone = tone;
    const ent = entrance(g, sh, inner, () => o, o.from || 'drop');
    return { g, body, face, inner, x, y, w, h, cx, cy, tone, draw: ent };
  }

  /** 任意形状的剪纸（云、浪、箭头、图标……）：opts d（路径）, tone 或 fill, rim（白边宽，默认 0.45u）, shadow, from, box（入场计算用的范围 {x,y,w,h}）
   *  返回 { g, inner, draw(p) } */
  function piece(parent, o) {
    const tone = TONE[o.tone || 'white'] || TONE.white, fill = o.fill || tone.fill, rim = o.rim ?? U * 0.45;
    const g = el('g', { opacity: 0 }, parent), body = el('g', o.rotate ? { transform: `rotate(${o.rotate} ${f1(o.box.x + o.box.w / 2)} ${f1(o.box.y + o.box.h / 2)})` } : {}, g);
    const sh = o.shadow === false ? null : el('path', { d: o.d, fill: C.shadow, opacity: 0.26, filter: defs(parent).soft, stroke: C.shadow, 'stroke-width': rim * 2, 'stroke-linejoin': 'round' }, body);
    if (rim > 0) el('path', { d: o.d, fill: o.rimColor || tone.rim, stroke: o.rimColor || tone.rim, 'stroke-width': rim * 2, 'stroke-linejoin': 'round' }, body);
    const face = el('path', { d: o.d, fill }, body);
    const inner = el('g', {}, body);
    inner.__clTone = tone;
    return { g, face, inner, draw: entrance(g, sh, inner, () => o.box, o.from || 'drop') };
  }

  /** 网点（半调）：在矩形里按 field(u, v)（0～1，u、v 是矩形内 0～1 的坐标）画网点，越大越"深"。
   *  opts x, y, w, h, field, pitch（网距，默认 2.2u；不要小于 2u，编码后会出摩尔纹）, angle（默认 45°）, color, opacity, max（最大半径占网距的比例，默认 0.62）
   *  draw(p)：网点沿对角线由小长大；p 缺省时直接画满 */
  function halftone(parent, o) {
    const pitch = Math.max(U * 2, o.pitch || U * 2.2), ang = (o.angle ?? 45) * Math.PI / 180, ca = Math.cos(ang), sa = Math.sin(ang);
    const g = el('g', { fill: o.color || C.ink, opacity: o.opacity ?? 1 }, parent);
    const cx = o.x + o.w / 2, cy = o.y + o.h / 2, R = Math.hypot(o.w, o.h) / 2 + pitch, n = Math.ceil(R / pitch), dots = [];
    for (let j = -n; j <= n; j++) for (let i = -n; i <= n; i++) {
      const x = cx + i * pitch * ca - j * pitch * sa, y = cy + i * pitch * sa + j * pitch * ca;
      if (x < o.x || x > o.x + o.w || y < o.y || y > o.y + o.h) continue;
      const u = (x - o.x) / o.w, v = (y - o.y) / o.h, r = Math.sqrt(clamp(o.field(u, v))) * pitch * (o.max || 0.62);
      if (r < U * 0.08) continue;
      dots.push({ e: el('circle', { cx: f1(x), cy: f1(y), r: f1(r) }, g), r, s: (u + v) / 2 });
    }
    const api = { g, draw(p) { dots.forEach(d => d.e.setAttribute('r', f1(d.r * ease.out(clamp(p * 1.6 - d.s * 0.6))))); } };
    return api;
  }

  /** 占位插画（示例里代替照片；正式做片用用户上传的图片）。都是几何块 + 网点，画在 (x, y, w, h) 里 */
  const ART = {
    /** 卫星云图：深底上两条白色旋臂 + 台风眼 */
    storm(g, x, y, w, h, seed) {
      const cx = x + w * 0.52, cy = y + h * 0.5, R = Math.min(w, h) * 0.6, bgc = '#1f2b45', lt = '#ece5d6';
      el('rect', { x, y, width: w, height: h, fill: bgc }, g);
      halftone(g, { x, y, w, h, pitch: U * 2.1, color: '#3a4766', field: (u, v) => 0.35 + 0.3 * vnoise2(seed, u * 5, v * 5) });
      for (let k = 0; k < 3; k++) {
        const A = [], B = [];
        for (let i = 0; i <= 44; i++) {
          const s = i / 44, rr = R * (0.16 + 1.0 * s), a = k * TAU / 3 + 0.3 + s * 2.9, wd = R * (0.2 * (1 - s) + 0.025);
          const px = cx + Math.cos(a) * rr, py = cy + Math.sin(a) * rr * 0.9, nx = Math.cos(a), ny = Math.sin(a);
          A.push([px + nx * wd, py + ny * wd]); B.push([px - nx * wd * 0.5, py - ny * wd * 0.5]);
        }
        el('path', { d: smooth(A) + ' L ' + B.reverse().map(q => f1(q[0]) + ' ' + f1(q[1])).join(' L ') + ' Z', fill: lt, opacity: 0.88 }, g);
      }
      el('circle', { cx, cy, r: R * 0.3, fill: lt }, g);
      el('circle', { cx, cy, r: R * 0.13, fill: 'none', stroke: '#c9c0ae', 'stroke-width': R * 0.05 }, g);
      el('circle', { cx, cy, r: R * 0.075, fill: bgc }, g);
    },
    /** 风暴中的海岸：灰暗天空网点、深色海面和浪线、被风吹弯的椰树剪影 */
    sea(g, x, y, w, h, seed) {
      const hz = y + h * 0.58, dk = '#1a2338';
      el('rect', { x, y, width: w, height: h, fill: '#e6dfcf' }, g);
      halftone(g, { x, y, w, h: hz - y, pitch: U * 2.1, color: '#4a5570', field: (u, v) => 0.75 - v * 0.55 + 0.15 * vnoise2(seed, u * 4, v * 3) });
      el('rect', { x, y: hz, width: w, height: y + h - hz, fill: '#2b3a5c' }, g);
      for (let k = 0; k < 6; k++) {
        const yy = hz + (y + h - hz) * (0.12 + k * 0.15), amp = U * (0.3 + k * 0.18), pts = [];
        for (let i = 0; i <= 24; i++) pts.push([x + w * i / 24, yy + Math.sin(i * 1.3 + k * 2.1) * amp]);
        el('path', { d: smooth(pts), fill: 'none', stroke: '#e6dfcf', 'stroke-width': U * (0.25 + k * 0.06), opacity: 0.55 + k * 0.06, 'stroke-linecap': 'round' }, g);
      }
      const bx = x + w * 0.8, by = y + h, topx = x + w * 0.62, topy = y + h * 0.26;
      el('path', { d: `M ${f1(bx)} ${f1(by)} Q ${f1(bx + w * 0.02)} ${f1(y + h * 0.55)} ${f1(topx)} ${f1(topy)}`, fill: 'none', stroke: dk, 'stroke-width': U * 1.3, 'stroke-linecap': 'round' }, g);
      for (let k = 0; k < 7; k++) {
        const a = Math.PI * (0.85 + k * 0.07), L = w * (0.16 + (k % 3) * 0.03), ex = topx + Math.cos(a) * L, ey = topy + Math.sin(a) * L * 0.45 + U * (k - 3) * 0.9;
        el('path', { d: `M ${f1(topx)} ${f1(topy)} Q ${f1((topx + ex) / 2)} ${f1(topy - U * 3 + k * U * 0.4)} ${f1(ex)} ${f1(ey)}`, fill: 'none', stroke: dk, 'stroke-width': U * 0.8, 'stroke-linecap': 'round' }, g);
      }
    },
    /** 城市天际线 */
    city(g, x, y, w, h, seed) {
      const r = S.rng(seed), gy = y + h * 0.86;
      el('rect', { x, y, width: w, height: h, fill: '#e8e1d1' }, g);
      halftone(g, { x, y, w, h: gy - y, pitch: U * 2.1, color: '#56607a', field: (u, v) => 0.15 + v * 0.45 });
      let bx = x;
      while (bx < x + w) {
        const bw = w * (0.07 + r() * 0.08), bh = h * (0.25 + r() * 0.5);
        el('rect', { x: f1(bx), y: f1(gy - bh), width: f1(bw + 1), height: f1(bh), fill: r() < 0.5 ? '#1d2840' : '#2c3854' }, g);
        for (let wy = gy - bh + U * 1.2; wy < gy - U; wy += U * 1.6) for (let wx = bx + U * 0.8; wx < bx + bw - U * 0.8; wx += U * 1.4) if (r() < 0.45) el('rect', { x: f1(wx), y: f1(wy), width: f1(U * 0.5), height: f1(U * 0.7), fill: '#e8dcbc', opacity: 0.8 }, g);
        bx += bw;
      }
      el('rect', { x, y: gy, width: w, height: y + h - gy, fill: '#141c2e' }, g);
    },
    /** 人像剪影（受访者、人物占位） */
    portrait(g, x, y, w, h, seed) {
      el('rect', { x, y, width: w, height: h, fill: '#ddd6c6' }, g);
      halftone(g, { x, y, w, h, pitch: U * 2.1, color: '#5a6278', field: (u, v) => 0.2 + 0.35 * (1 - Math.hypot(u - 0.5, v - 0.4)) + 0.1 * vnoise2(seed, u * 3, v * 3) });
      const cx = x + w / 2, s = Math.min(w, h);
      el('path', { d: `M ${f1(cx - s * 0.42)} ${f1(y + h)} Q ${f1(cx - s * 0.4)} ${f1(y + h * 0.68)} ${f1(cx)} ${f1(y + h * 0.66)} Q ${f1(cx + s * 0.4)} ${f1(y + h * 0.68)} ${f1(cx + s * 0.42)} ${f1(y + h)} Z`, fill: '#1b2540' }, g);
      el('ellipse', { cx, cy: y + h * 0.44, rx: s * 0.17, ry: s * 0.21, fill: '#1b2540' }, g);
    },
    /** 手机充电（辟谣、消费类题材） */
    phone(g, x, y, w, h, seed) {
      el('rect', { x, y, width: w, height: h, fill: '#e3d9c4' }, g);
      halftone(g, { x, y, w, h, pitch: U * 2.1, color: '#8a7a5c', field: (u, v) => 0.12 + 0.2 * v + 0.08 * vnoise2(seed, u * 4, v * 4) });
      const pw = Math.min(w * 0.36, h * 0.5), ph = pw * 1.9, px = x + w / 2 - pw / 2, py = y + h / 2 - ph / 2 - h * 0.04;
      el('path', { d: `M ${f1(x + w / 2)} ${f1(py + ph)} C ${f1(x + w / 2)} ${f1(py + ph + h * 0.12)} ${f1(x + w * 0.85)} ${f1(y + h * 0.82)} ${f1(x + w)} ${f1(y + h * 0.9)}`, fill: 'none', stroke: '#1b2540', 'stroke-width': U * 0.7 }, g);
      el('rect', { x: px, y: py, width: pw, height: ph, rx: pw * 0.16, fill: '#1b2540' }, g);
      el('rect', { x: px + pw * 0.08, y: py + pw * 0.1, width: pw * 0.84, height: ph - pw * 0.2, rx: pw * 0.08, fill: '#efe8d8' }, g);
      const bw = pw * 0.46, bh = bw * 1.7, bxx = px + pw / 2 - bw / 2, byy = py + ph / 2 - bh / 2;
      el('rect', { x: bxx, y: byy, width: bw, height: bh, rx: bw * 0.12, fill: 'none', stroke: '#1b2540', 'stroke-width': U * 0.5 }, g);
      el('rect', { x: bxx + bw * 0.32, y: byy - bw * 0.16, width: bw * 0.36, height: bw * 0.16, fill: '#1b2540' }, g);
      el('rect', { x: bxx + bw * 0.14, y: byy + bh * 0.08, width: bw * 0.72, height: bh * 0.84, fill: '#2b3a5c' }, g);
      el('path', { d: `M ${f1(bxx + bw * 0.58)} ${f1(byy + bh * 0.18)} L ${f1(bxx + bw * 0.3)} ${f1(byy + bh * 0.54)} L ${f1(bxx + bw * 0.52)} ${f1(byy + bh * 0.54)} L ${f1(bxx + bw * 0.42)} ${f1(byy + bh * 0.84)} L ${f1(bxx + bw * 0.72)} ${f1(byy + bh * 0.44)} L ${f1(bxx + bw * 0.5)} ${f1(byy + bh * 0.44)} Z`, fill: '#efe8d8' }, g);
    },
    /** 纯色块（最朴素的占位） */
    block(g, x, y, w, h, seed) {
      el('rect', { x, y, width: w, height: h, fill: '#cfc6b3' }, g);
      halftone(g, { x, y, w, h, pitch: U * 2.2, color: '#8f8570', field: (u, v) => 0.25 + 0.15 * vnoise2(seed, u * 3, v * 3) });
    },
  };

  /** 剪报照片：白边 0.6u（3～6px）+ 剪刀剪的轮廓 + 投影；可加手写图注。
   *  opts x, y, w, h（含白边的外框）, src（用户图片 '/input/xxx.jpg'）或 art（占位：storm | sea | city | portrait | phone | block）,
   *       treatment（src 用：'mono' 黑白 | 'duotone' 墨色双色调（默认）| 'halftone' 网点印刷 | 'none'）, border, caption（图注，写在下白边）,
   *       rotate, from, seed
   *  返回 { g, inner, photo:{x,y,w,h}（图片区域，往上叠圈注用）, draw(p) } */
  function cutout(parent, o) {
    const seed = o.seed ?? nextSeed(), b = o.border ?? U * 0.6, cap = o.caption ? U * 5 : 0;
    const { x, y, w, h } = o, ix = x + b, iy = y + b, iw = w - b * 2, ih = h - b * 2 - cap;
    const g = el('g', { opacity: 0 }, parent), body = el('g', { transform: `rotate(${o.rotate || 0} ${f1(x + w / 2)} ${f1(y + h / 2)})` }, g);
    const outline = cutRect(x, y, w, h, seed, U * 0.18);
    const sh = el('path', { d: outline, fill: C.shadow, opacity: 0.26, filter: defs(parent).soft }, body);
    el('path', { d: outline, fill: TONE.white.rim }, body);
    const clipId = nid('ic'); el('rect', { x: ix, y: iy, width: iw, height: ih }, el('clipPath', { id: clipId }, defs(parent).d));
    const pic = el('g', { 'clip-path': `url(#${clipId})` }, body);
    if (o.src) {
      const tr = o.treatment || 'duotone';
      const im = el('image', { href: o.src, x: ix, y: iy, width: iw, height: ih, preserveAspectRatio: 'xMidYMid slice' }, pic);
      S.waits.push(new Promise(res => { im.addEventListener('load', res, { once: true }); im.addEventListener('error', res, { once: true }); }));
      if (tr === 'mono' || tr === 'duotone') im.setAttribute('filter', imgFilter(parent, tr));
      if (tr === 'halftone') {
        im.setAttribute('opacity', 0);
        const img = new Image(); img.src = o.src;
        S.waits.push(img.decode().catch(() => null));
        pic.insertBefore(el('rect', { x: ix, y: iy, width: iw, height: ih, fill: TONE.white.fill }), im);
        o.__ht = { img, im };
      }
    } else (ART[o.art] || ART.block)(pic, ix, iy, iw, ih, seed);
    const inner = el('g', {}, body);
    if (o.caption) mkText(inner, { x: x + w / 2, y: y + h - cap * 0.36, 'font-size': f1(U * 3), 'font-family': fontOf('hand'), fill: TONE.white.text, 'text-anchor': 'middle' }, o.caption);
    let htDone = !o.__ht;
    const halfImg = () => {   // 网点印刷：把用户图片按网格取亮度，画成墨色网点（第一次 draw 时做，那时图片已加载）
      htDone = true;
      const { img, im } = o.__ht;
      try {
        const sc = Math.max(iw / img.naturalWidth, ih / img.naturalHeight), sw = iw / sc, shh = ih / sc;
        const cw = Math.ceil(iw / U * 2), chh = Math.ceil(ih / U * 2), c = canvas(cw, chh), cx = c.getContext('2d', { willReadFrequently: true });
        cx.drawImage(img, (img.naturalWidth - sw) / 2, (img.naturalHeight - shh) / 2, sw, shh, 0, 0, cw, chh);
        const data = cx.getImageData(0, 0, cw, chh).data;
        halftone(pic, { x: ix, y: iy, w: iw, h: ih, pitch: U * 2, color: C.ink, max: 0.72, field: (u, v) => {
          const k = (Math.min(chh - 1, Math.floor(v * chh)) * cw + Math.min(cw - 1, Math.floor(u * cw))) * 4;
          return 1 - (data[k] * 0.3 + data[k + 1] * 0.59 + data[k + 2] * 0.11) / 255;
        } });
      } catch (e) { im.setAttribute('opacity', 1); im.setAttribute('filter', imgFilter(parent, 'duotone')); }
    };
    const ent = entrance(g, sh, inner, () => o, o.from || 'drop');
    return { g, inner, photo: { x: ix, y: iy, w: iw, h: ih }, draw(p) { if (!htDone) halfImg(); ent(p); } };
  }
  function imgFilter(parent, kind) {
    const dd = defs(parent);
    if (dd.img[kind]) return dd.img[kind];
    const id = nid('if'), f = el('filter', { id, 'color-interpolation-filters': 'sRGB' }, dd.d);
    el('feColorMatrix', { type: 'saturate', values: 0 }, f);
    const ct = el('feComponentTransfer', {}, f), ink = hex('#1b2540'), pap = hex('#efe6d2');
    ['R', 'G', 'B'].forEach((ch, i) => el(`feFunc${ch}`, kind === 'mono' ? { type: 'linear', slope: 1.15, intercept: -0.06 } : { type: 'table', tableValues: `${(ink[i] / 255).toFixed(3)} ${(pap[i] / 255).toFixed(3)}` }, ct));
    return (dd.img[kind] = `url(#${id})`);
  }

  /** 胶带：半透明米色纸胶带，两端手撕锯齿。opts x, y（中心）, w（默认 12u）, h（默认 3.4u）, angle（默认 -6°）, color, seed
   *  draw(p)：拍上去（略大 → 原大） */
  function tape(parent, o) {
    const w = o.w || U * 12, h = o.h || U * 3.4, ang = o.angle ?? -6, r = S.rng(o.seed ?? nextSeed()), pts = [];
    const z = n => Array.from({ length: n + 1 }, (_, i) => i / n);
    z(6).forEach(s => pts.push([-w / 2 + s * w, -h / 2]));
    z(5).forEach((s, i) => pts.push([w / 2 + (i % 2 ? -1 : 1) * U * (0.2 + r() * 0.3), -h / 2 + s * h]));
    z(6).forEach(s => pts.push([w / 2 - s * w, h / 2]));
    z(5).forEach((s, i) => pts.push([-w / 2 + (i % 2 ? 1 : -1) * U * (0.2 + r() * 0.3), h / 2 - s * h]));
    const g = el('g', { opacity: 0 }, parent), body = el('g', {}, g), d = P(pts, true);
    el('path', { d, fill: C.shadow, opacity: 0.12, filter: defs(parent).soft, transform: `translate(${U * 0.15} ${U * 0.25})` }, body);
    el('path', { d, fill: o.color || '#e9d9a6', opacity: 0.88, stroke: '#b9a874', 'stroke-width': U * 0.08, 'stroke-opacity': 0.5 }, body);
    el('line', { x1: -w / 2 + U * 0.6, x2: w / 2 - U * 0.6, y1: -h * 0.18, y2: -h * 0.18, stroke: '#ffffff', 'stroke-width': U * 0.18, opacity: 0.35 }, body);
    return {
      g, draw(p) {
        const k = ease.out(clamp(p)), s = 1 + 0.18 * (1 - k);
        g.setAttribute('opacity', p > 0 ? clamp(p * 4) : 0);
        body.setAttribute('transform', `translate(${f1(o.x)} ${f1(o.y)}) rotate(${ang}) scale(${s.toFixed(3)})`);
      },
    };
  }

  // ---------------------------------------------------------------------------------------------
  /** 印章：双线框（rect）或双圈（round），油墨不均匀（随机缺墨）。印在纸上，没有投影。
   *  opts x, y（中心）, text, sub（框内小字，可选）, shape: 'rect' | 'round', size（主字号，默认 4.6u）, rotate（默认 -8°）, color（默认红）, seed
   *  set(t, at)：at 秒落下——0.09 秒内从 2.6 倍砸到原大，落定那一帧抖一下。用原始的 t，不要用一拍二的 T。
   *  砸下来的途中透明度低于 0.2（不参与版面自检），落定后才算正式文字。要配全画面冲击就在 stage 的 punch 里写 at + 0.09 */
  function stamp(parent, o) {
    const size = o.size || U * 4.6, color = o.color || C.red, shape = o.shape || 'rect', rot = o.rotate ?? -8, seed = o.seed ?? nextSeed();
    const g = el('g', { class: 'cl-ink', opacity: 0 }, parent), pos = el('g', {}, g);
    const maskId = nid('sm'), mask = el('mask', { id: maskId, maskUnits: 'userSpaceOnUse' }, defs(parent).d);
    const ink = el('g', { mask: `url(#${maskId})`, fill: color, stroke: color }, pos);
    const sp = size * 0.14, subSize = size * 0.4;
    const main = mkText(ink, { x: 0, y: o.sub ? size * 0.1 : size * 0.36, 'font-size': f1(size), 'font-weight': 900, 'font-family': F.sans, 'text-anchor': 'middle', 'letter-spacing': f1(sp), stroke: 'none' }, o.text);
    const sub = o.sub ? mkText(ink, { x: 0, y: size * 1.12, 'font-size': f1(subSize), 'font-weight': 700, 'font-family': F.sans, 'text-anchor': 'middle', 'letter-spacing': f1(subSize * 0.2), stroke: 'none' }, o.sub) : null;
    let laid = false;
    const layout = () => {
      if (laid) return; laid = true;
      const tw = textW(main) - sp;
      main.setAttribute('dx', f1(sp / 2));
      let bw, bh;
      if (shape === 'round') {
        const r = Math.max(tw / 2 + size * 0.7, size * 1.25);
        el('circle', { cx: 0, cy: 0, r: f1(r), fill: 'none', 'stroke-width': f1(U * 0.5) }, ink);
        el('circle', { cx: 0, cy: 0, r: f1(r - U * 0.75), fill: 'none', 'stroke-width': f1(U * 0.18) }, ink);
        bw = bh = r * 2;
      } else {
        bw = Math.max(tw + size * 1.2, size * 3); bh = (o.sub ? size * 2.45 : size * 1.5);
        const y0 = o.sub ? -size * 1.1 : -bh / 2;
        el('rect', { x: f1(-bw / 2), y: f1(y0), width: f1(bw), height: f1(bh), rx: f1(U * 0.3), fill: 'none', 'stroke-width': f1(U * 0.5) }, ink);
        el('rect', { x: f1(-bw / 2 + U * 0.65), y: f1(y0 + U * 0.65), width: f1(bw - U * 1.3), height: f1(bh - U * 1.3), fill: 'none', 'stroke-width': f1(U * 0.18) }, ink);
        if (o.sub) ink.insertBefore(el('line', { x1: f1(-bw / 2 + U * 1.6), x2: f1(bw / 2 - U * 1.6), y1: f1(size * 0.5), y2: f1(size * 0.5), 'stroke-width': f1(U * 0.14) }), sub);
      }
      // 缺墨：白底遮罩上撒黑点和几道浅痕
      const r = S.rng(seed), ext = Math.max(bw, bh) * 0.75;
      el('rect', { x: f1(-ext), y: f1(-ext), width: f1(ext * 2), height: f1(ext * 2), fill: '#fff' }, mask);
      const nDots = Math.round(bw * bh / (U * U) * 0.55);
      for (let i = 0; i < nDots; i++) el('circle', { cx: f1((r() - 0.5) * bw * 1.05), cy: f1((r() - 0.5) * bh * 1.05), r: f1(U * (0.05 + Math.pow(r(), 2) * 0.32)), fill: '#000' }, mask);
      for (let i = 0; i < 4; i++) el('rect', { x: f1((r() - 0.5) * bw), y: f1((r() - 0.5) * bh), width: f1(bw * (0.2 + r() * 0.4)), height: f1(U * (0.3 + r() * 0.6)), fill: '#000', opacity: 0.18 + r() * 0.2, transform: `rotate(${f1((r() - 0.5) * 30)})` }, mask);
    };
    return {
      g,
      set(t, at) {
        layout();
        const k = t - at;
        let s = 1, op = 0.92, jx = 0, jy = 0;
        if (k < 0) { s = 2.6; op = 0; }
        else if (k < 0.09) { const q = k / 0.09; s = lerp(2.6, 1, q * q); op = q < 0.75 ? 0.15 : 0.92; }
        else if (k < 0.2) { const a = U * 0.45 * (1 - (k - 0.09) / 0.11); jx = S.noise(seed, k * 60) * a; jy = S.noise(seed + 5, k * 60) * a; s = 1 + 0.02 * (1 - (k - 0.09) / 0.11); }
        g.setAttribute('opacity', op);
        pos.setAttribute('transform', `translate(${f1(o.x + jx)} ${f1(o.y + jy)}) rotate(${rot}) scale(${s.toFixed(3)})`);
      },
    };
  }

  /** 马克笔线条的两笔：主笔 + 一道浅色笔痕，用 SLATE.draw 画出来 */
  function marker(parent, d, o) {
    const g = el('g', { class: 'cl-ink', fill: 'none', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, parent);
    const wdt = o.width || U * 0.62, color = o.color || C.red;
    const a = el('path', { d, stroke: color, 'stroke-width': f1(wdt), opacity: 0.92 }, g);
    const b = el('path', { d, stroke: mix(color, '#ffffff', 0.35), 'stroke-width': f1(wdt * 0.28), opacity: 0.55, transform: `translate(${f1(wdt * 0.12)} ${f1(-wdt * 0.12)})` }, g);
    return { g, a, b, draw(p) { const q = clamp(p); g.setAttribute('opacity', q > 0 ? 1 : 0); S.draw(a, q); S.draw(b, q); } };
  }

  /** 马克笔圈注：把目标框 {x, y, w, h} 手绘圈起来（转 1.1 圈，首尾错开）。opts x, y, w, h, pad, color, width, turns, tilt, seed
   *  draw(p) 画出来（建议 0.5～0.7 秒，用 ease.inOut） */
  function circle(parent, o) {
    const pad = o.pad ?? U * 1.4, cx = o.x + o.w / 2, cy = o.y + o.h / 2, rx = o.w / 2 * 1.15 + pad, ry = o.h / 2 * 1.12 + pad * 0.8, seed = o.seed ?? nextSeed();
    const turns = o.turns || 1.1, a0 = -Math.PI * 0.62, tilt = (o.tilt ?? -3) * Math.PI / 180, pts = [];
    for (let i = 0; i <= 72; i++) {
      const s = i / 72, a = a0 + s * turns * TAU, gr = 1 + 0.07 * s + S.noise(seed, s * 5) * 0.035;
      const ex = Math.cos(a) * rx * gr, ey = Math.sin(a) * ry * gr;
      pts.push([cx + ex * Math.cos(tilt) - ey * Math.sin(tilt), cy + ex * Math.sin(tilt) + ey * Math.cos(tilt)]);
    }
    const m = marker(parent, smooth(pts), o);
    return { g: m.g, draw: p => m.draw(ease.inOut(clamp(p))) };
  }

  /** 手绘下划线：opts x, y, w, color, width, double（再加一道短的）, seed；draw(p) 从左往右 */
  function underline(parent, o) {
    const r = S.rng(o.seed ?? nextSeed()), pts = [];
    for (let i = 0; i <= 10; i++) pts.push([o.x + o.w * i / 10, o.y + (r() - 0.5) * U * 0.35 - i * U * 0.06]);
    const m1 = marker(parent, smooth(pts), o);
    const m2 = o.double ? marker(parent, smooth(pts.slice(1, 9).map(([x, y]) => [x + U * 0.6, y + U * 1.1])), { ...o, width: (o.width || U * 0.62) * 0.8 }) : null;
    return { draw(p) { m1.draw(ease.inOut(clamp(p * (m2 ? 1.5 : 1)))); if (m2) m2.draw(ease.inOut(clamp(p * 1.5 - 0.5))); } };
  }

  /** 荧光笔：在文字后面刷一道黄。要先于文字创建（或放在更下面的图层），才会在字的下面。
   *  opts x, y, w, h（覆盖范围）, color（默认黄）, seed；draw(p) 从左往右刷 */
  function highlight(parent, o) {
    const r = S.rng(o.seed ?? nextSeed()), y = o.y + o.h / 2, pts = [[o.x, y + (r() - 0.5) * U * 0.4], [o.x + o.w * 0.5, y + (r() - 0.5) * U * 0.4], [o.x + o.w, y - U * 0.3 + (r() - 0.5) * U * 0.4]];
    const g = el('g', { class: 'cl-ink' }, parent);
    const pth = el('path', { d: smooth(pts), fill: 'none', stroke: o.color || C.yellow, 'stroke-width': f1(o.h), 'stroke-linecap': 'butt', opacity: 0.8 }, g);
    return { g, draw(p) { const q = ease.inOut(clamp(p)); g.setAttribute('opacity', q > 0 ? 1 : 0); S.draw(pth, q); } };
  }

  /** 手绘箭头：opts from: [x, y], to: [x, y], bend（弯曲，正负表示方向，默认 0.18）, color, width, head（箭头长，默认 2.2u）, seed
   *  draw(p)：先画杆、再画箭头 */
  function arrow(parent, o) {
    const [x1, y1] = o.from, [x2, y2] = o.to, dx = x2 - x1, dy = y2 - y1, L = Math.hypot(dx, dy), bend = o.bend ?? 0.18;
    const mx = (x1 + x2) / 2 - dy * bend, my = (y1 + y2) / 2 + dx * bend, pts = [];
    for (let i = 0; i <= 16; i++) { const s = i / 16, a = (1 - s) * (1 - s), b = 2 * s * (1 - s), c = s * s; pts.push([a * x1 + b * mx + c * x2, a * y1 + b * my + c * y2]); }
    const shaft = marker(parent, smooth(pts), o);
    const ang = Math.atan2(y2 - my, x2 - mx), hl = o.head || Math.min(U * 2.2, L * 0.35);
    const hd = `M ${f1(x2 - Math.cos(ang - 0.5) * hl)} ${f1(y2 - Math.sin(ang - 0.5) * hl)} L ${f1(x2)} ${f1(y2)} L ${f1(x2 - Math.cos(ang + 0.5) * hl)} ${f1(y2 - Math.sin(ang + 0.5) * hl)}`;
    const head = marker(parent, hd, o);
    return { draw(p) { shaft.draw(ease.inOut(clamp(p / 0.75))); head.draw(clamp((p - 0.72) / 0.28)); } };
  }

  /** 划掉：opts x, y, w, h, mode: 'line'（一道横线，默认）| 'cross'（打叉）| 'scribble'（来回乱涂）, color, width, seed；draw(p) */
  function strike(parent, o) {
    const r = S.rng(o.seed ?? nextSeed()), mode = o.mode || 'line', cy = o.y + o.h / 2;
    let paths;
    if (mode === 'cross') paths = [[[o.x, o.y], [o.x + o.w, o.y + o.h]], [[o.x + o.w, o.y], [o.x, o.y + o.h]]].map(s => smooth([s[0], [(s[0][0] + s[1][0]) / 2 + (r() - 0.5) * U, (s[0][1] + s[1][1]) / 2], s[1]]));
    else if (mode === 'scribble') { const pts = []; for (let i = 0; i <= 14; i++) pts.push([o.x + o.w * i / 14 + (r() - 0.5) * U, i % 2 ? o.y + o.h * 0.25 : o.y + o.h * 0.75]); paths = [smooth(pts)]; }
    else paths = [smooth([[o.x - U * 0.6, cy + U * 0.3], [o.x + o.w * 0.5, cy - U * 0.2 + (r() - 0.5) * U * 0.4], [o.x + o.w + U * 0.6, cy - U * 0.5]])];
    const ms = paths.map(d => marker(parent, d, o));
    return { draw(p) { ms.forEach((m, i) => m.draw(ease.inOut(clamp(p * ms.length - i)))); } };
  }

  /** 涂黑：opts x, y, w, h（盖住的范围）, mode: 'lift'（默认：一开始盖着，draw(p) 把黑条揭起甩走，露出下面的字）| 'cover'（draw(p) 从左往右涂黑）,
   *  color（默认近黑）, seed。黑条要在被盖的文字之后创建，才会盖在上面 */
  function redact(parent, o) {
    const r = S.rng(o.seed ?? nextSeed()), mode = o.mode || 'lift', pad = U * 0.4, pts = [];
    const x0 = o.x - pad, x1 = o.x + o.w + pad, y0 = o.y - pad * 0.5, y1 = o.y + o.h + pad * 0.5;
    for (let i = 0; i <= 8; i++) pts.push([x0 + (x1 - x0) * i / 8, y0 + (r() - 0.5) * U * 0.25]);
    for (let i = 0; i <= 4; i++) pts.push([x1 + (r() - 0.3) * U * 0.6, y0 + (y1 - y0) * i / 4]);
    for (let i = 8; i >= 0; i--) pts.push([x0 + (x1 - x0) * i / 8, y1 + (r() - 0.5) * U * 0.25]);
    for (let i = 4; i >= 0; i--) pts.push([x0 - (r() - 0.3) * U * 0.6, y0 + (y1 - y0) * i / 4]);
    const g = el('g', {}, parent), d = P(pts, true);
    const sh = el('path', { d, fill: C.shadow, opacity: 0, filter: defs(parent).soft }, g);
    const bar = el('path', { d, fill: o.color || '#121317' }, g);
    let clip = null;
    if (mode === 'cover') { const id = nid('rc'); clip = el('rect', { x: x0 - U, y: y0 - U, height: y1 - y0 + U * 2, width: 0 }, el('clipPath', { id }, defs(parent).d)); bar.setAttribute('clip-path', `url(#${id})`); }
    return {
      g,
      draw(p) {
        const q = clamp(p);
        if (mode === 'cover') { clip.setAttribute('width', f1((x1 - x0 + U * 2) * ease.inOut(q))); return; }
        const k = ease.in(q), px = x0, py = (y0 + y1) / 2;
        const tf = `translate(${f1(k * U * 16)} ${f1(-k * U * 8)}) rotate(${f1(-k * 14)} ${f1(px)} ${f1(py)})`;
        bar.setAttribute('transform', tf); bar.setAttribute('opacity', q >= 1 ? 0 : (1 - k * k).toFixed(3));
        sh.setAttribute('transform', `translate(${f1(k * U * 2)} ${f1(k * U * 1.5)}) ` + tf); sh.setAttribute('opacity', q > 0 && q < 1 ? (0.3 * Math.sin(Math.PI * q)).toFixed(3) : 0);
      },
    };
  }

  // ---------------------------------------------------------------------------------------------
  /** 大数字（宋体黑）：opts x, y（基线）, value, digits, prefix（如 '约'）, unit（如 '个'）, label（上方小字）, size（默认 16u）, anchor（默认 middle）, color（下划线色，默认红）
   *  draw(p)：数字滚动到 value（用一拍二的 T 算 p，数字会一格一格跳），最后用马克笔划一道下划线 */
  function counter(parent, o) {
    const size = o.size || U * 16, anchor = o.anchor || 'middle', g = el('g', { opacity: 0 }, parent);
    const lbl = o.label ? mkText(g, { x: o.x, y: o.y - size - U * 0.8, 'font-size': f1(U * 3), 'font-weight': 700, 'font-family': F.sans, fill: inkOf(parent, 'sub'), 'text-anchor': anchor }, o.label) : null;
    const num = el('text', { x: o.x, y: o.y, 'font-size': f1(size), 'font-weight': 900, 'font-family': fontOf('serif'), fill: inkOf(parent), 'text-anchor': anchor }, g);
    const pre = o.prefix ? el('tspan', { 'font-size': f1(size * 0.32), 'font-family': F.sans, 'font-weight': 900, dx: f1(-size * 0.02) }, num) : null;
    const val = el('tspan', {}, num);
    const unit = o.unit ? el('tspan', { 'font-size': f1(size * 0.32), 'font-family': F.sans, 'font-weight': 900, dx: f1(size * 0.06) }, num) : null;
    if (pre) pre.textContent = o.prefix + ' ';
    if (unit) unit.textContent = o.unit;
    let ul = null;
    return {
      g,
      draw(p) {
        const k = ease.out(clamp(p * 1.25));
        val.textContent = S.countUp(o.value, k, o.digits || 0, o.from || 0);
        g.setAttribute('opacity', p > 0 ? clamp(p * 5) : 0);
        if (lbl) lbl.setAttribute('opacity', clamp(p * 3));
        if (!ul) {   // 下划线按最终数字的宽度画（第一次 draw 时建，宽度用 textW 量，和时刻无关）
          const keep = val.textContent; val.textContent = S.countUp(o.value, 1, o.digits || 0);
          const w = textW(num), x0 = anchor === 'middle' ? o.x - w / 2 : anchor === 'end' ? o.x - w : o.x;
          val.textContent = keep;
          ul = underline(g, { x: x0, y: o.y + size * 0.16, w, color: o.color || C.red, width: U * 0.7, seed: 41 });
        }
        if (ul) ul.draw(clamp((p - 0.8) / 0.2));
      },
    };
  }

  /** 纸条柱状图：每根柱子是一条上沿撕开的纸，从底线后面推上来。
   *  opts x, y, w, h（整个区域，含上方数值和下方标签）, items: [{label, value}]（value 为 null 显示"未公布"）, max, unit, digits,
   *       tone（默认 ink 深蓝纸）, hiTone（强调色，默认 red）, barW（柱宽占格宽，默认 0.6）, seed
   *  draw(p)：底线画出、柱子依次升起、数值出现；focus(indices, p)：把这几根换成强调色；box(i)：第 i 根（含数值）的范围，给圈注用 */
  function bars(parent, o) {
    const n = o.items.length, g = el('g', {}, parent), digits = o.digits ?? 0, unit = o.unit || '';
    const labH = U * 5.4, valH = U * 5.8, base = o.y + o.h - labH, topY = o.y + valH, maxH = base - topY;
    const max = o.max || Math.max(...o.items.map(it => it.value ?? 0)), slot = o.w / n, bw = Math.min(slot * (o.barW || 0.6), U * 13);
    const tone = TONE[o.tone || 'ink'] || TONE.ink, hi = TONE[o.hiTone || 'red'] || TONE.red, r = S.rng(o.seed ?? 500);
    const clipId = nid('bc');
    el('rect', { x: o.x - U * 4, y: o.y - U * 30, width: o.w + U * 8, height: base - o.y + U * 30 }, el('clipPath', { id: clipId }, defs(parent).d));
    const barsG = el('g', { 'clip-path': `url(#${clipId})` }, g);
    const rows = o.items.map((it, i) => {
      const cx = o.x + slot * (i + 0.5), bh = it.value == null ? 0 : Math.max(U * 1.5, maxH * clamp(it.value / max)), x = cx - bw / 2, y = base - bh, seed = (o.seed ?? 500) + i * 13;
      const bg = el('g', {}, barsG);
      const d = tornRect(x, y, bw, bh + U * 2, { seed, torn: 't', amp: U * 0.35 });
      el('path', { d, fill: C.shadow, opacity: 0.22, filter: defs(parent).soft, transform: `translate(${f1(U * 0.35)} ${f1(U * 0.15)})` }, bg);
      const rim = el('path', { d: tornRect(x, y, bw, bh + U * 2, { seed: seed + 1, torn: 't', amp: U * 0.45, grow: U * 0.5 }), fill: tone.rim }, bg);
      const face = el('path', { d, fill: tone.fill }, bg);
      const val = mkText(g, { x: cx, y: y - U * 1.7, 'font-size': f1(U * 3.4), 'font-weight': 900, 'font-family': fontOf('serif'), fill: inkOf(parent), 'text-anchor': 'middle', opacity: 0 }, it.value == null ? '未公布' : fmt(it.value, digits) + unit);
      if (it.value == null) { val.setAttribute('font-size', f1(U * 2.4)); val.setAttribute('fill', C.muted); val.setAttribute('font-family', F.sans); }
      mkText(g, { x: cx, y: base + U * 4, 'font-size': f1(U * 2.8), 'font-weight': 700, 'font-family': F.sans, fill: inkOf(parent, 'sub'), 'text-anchor': 'middle' }, it.label);
      return { bg, rim, face, val, bh, cx, x, y, rot: (r() - 0.5) * 1.6, hi: 0 };
    });
    const rule = el('line', { x1: o.x, x2: o.x, y1: base, y2: base, stroke: inkOf(parent), 'stroke-width': U * 0.5, 'stroke-linecap': 'round' }, g);
    const ticks = rows.map(rw => el('line', { x1: rw.cx, x2: rw.cx, y1: base, y2: base + U * 0.9, stroke: inkOf(parent), 'stroke-width': U * 0.2, opacity: 0 }, g));
    const recolor = rw => { rw.face.setAttribute('fill', mix(tone.fill, hi.fill, rw.hi)); rw.rim.setAttribute('fill', mix(tone.rim, hi.rim, rw.hi)); };
    return {
      g,
      draw(p) {
        rule.setAttribute('x2', f1(o.x + o.w * ease.out(clamp(p / 0.25)))); rule.setAttribute('opacity', p > 0 ? 1 : 0);
        rows.forEach((rw, i) => {
          const q = ease.out(clamp((p - 0.15 - i * (0.5 / n)) / 0.35));
          rw.bg.setAttribute('transform', `translate(0 ${f1((1 - q) * (rw.bh + U * 3))}) rotate(${rw.rot.toFixed(2)} ${f1(rw.cx)} ${f1(base)})`);
          rw.val.setAttribute('opacity', clamp((q - 0.85) / 0.15).toFixed(3));
          ticks[i].setAttribute('opacity', p > 0.2 ? 1 : 0);
        });
      },
      focus(ids, p) { rows.forEach((rw, i) => { rw.hi = ids.includes(i) ? clamp(p) : 0; recolor(rw); }); },
      box(i) { const rw = rows[i]; return { x: rw.x, y: rw.y - U * 5.4, w: bw, h: rw.bh + U * 5.4 }; },
      base, slot, barW: bw,
    };
  }

  /** 撕页日历：opts x, y（左上角）, w（默认 17u）, h（默认 19u）, values（大字，如 ['1','2','4']）, head / tail（数字左右的小字，如 '第'、'天'）, label（红色页眉）
   *  draw(p)：整本落下；set(t, timeline)：timeline = [[秒, values 下标], …]，到点撕掉一页（0.32 秒）。一页至少停 1.6 秒 */
  function dateFlip(parent, o) {
    const w = o.w || U * 17, h = o.h || U * 19, x = o.x, y = o.y, band = h * 0.24, vs = o.size || h * 0.44;
    const g = el('g', { opacity: 0 }, parent), body = el('g', {}, g);
    const sh = el('rect', { x, y, width: w, height: h, rx: U * 0.5, fill: C.shadow, opacity: 0.26, filter: defs(parent).soft, transform: `translate(${U * 0.4} ${U * 0.7})` }, body);
    for (let k = 2; k >= 1; k--) el('rect', { x, y: y + k * U * 0.35, width: w, height: h, rx: U * 0.5, fill: mix(TONE.white.fill, '#c9c1ae', k * 0.35) }, body);
    const sheet = () => {
      const s = el('g', {}, body);
      el('rect', { x, y: y + band, width: w, height: h - band, fill: TONE.white.fill }, s);
      const cy = y + band + (h - band) * 0.5 + vs * 0.36;
      const v = mkText(s, { x: x + w / 2, y: cy, 'font-size': f1(vs), 'font-weight': 900, 'font-family': fontOf('serif'), fill: C.ink, 'text-anchor': 'middle' }, o.values[0]);
      if (o.head) mkText(s, { x: x + w * 0.13, y: cy, 'font-size': f1(U * 3), 'font-weight': 700, 'font-family': F.sans, fill: C.ink2, 'text-anchor': 'middle' }, o.head);
      if (o.tail) mkText(s, { x: x + w * 0.87, y: cy, 'font-size': f1(U * 3), 'font-weight': 700, 'font-family': F.sans, fill: C.ink2, 'text-anchor': 'middle' }, o.tail);
      return { s, v };
    };
    const under = sheet(), over = sheet();
    over.s.setAttribute('data-qa', 'ignore');   // 正在被撕走的那页是过渡用的副本
    el('rect', { x, y, width: w, height: band, rx: U * 0.5, fill: C.red }, body);
    if (o.label) mkText(body, { x: x + w / 2, y: y + band * 0.68, 'font-size': f1(U * 2.3), 'font-weight': 900, 'font-family': F.sans, fill: '#fff8ee', 'text-anchor': 'middle', 'letter-spacing': f1(U * 0.3) }, o.label);
    [0.12, 0.88].forEach(f => { el('circle', { cx: x + w * f, cy: y + U * 0.1, r: U * 0.8, fill: 'none', stroke: C.ink, 'stroke-width': U * 0.4 }, body); });
    const ent = entrance(g, sh, null, () => ({ x, y, w, h }), 'drop');
    return {
      g, draw: ent,
      set(t, tl) {
        let cur = tl[0][1], prev = cur, k = 1;
        for (let i = 1; i < tl.length; i++) if (t >= tl[i][0]) { prev = tl[i - 1][1]; cur = tl[i][1]; k = clamp((t - tl[i][0]) / 0.32); }
        under.v.textContent = o.values[cur];
        over.v.textContent = o.values[prev];
        const top = y + band, e = ease.in(k);
        over.s.setAttribute('opacity', k < 1 ? (1 - e * e).toFixed(3) : 0);
        over.s.setAttribute('transform', `translate(${f1(e * U * 3)} ${f1(top - e * U * 6)}) rotate(${f1(-e * 14)}) scale(1 ${(1 - e * 0.85).toFixed(3)}) translate(0 ${f1(-top)})`);
      },
    };
  }

  /** 图钉：opts x, y, color（默认红）, size；draw(p) 从上方按下来 */
  function pin(parent, o) {
    const s = o.size || U * 1.3, g = el('g', { opacity: 0 }, parent);
    const sh = el('ellipse', { cx: o.x + s * 0.5, cy: o.y + s * 0.55, rx: s * 0.75, ry: s * 0.5, fill: C.shadow, opacity: 0.3, filter: defs(parent).soft }, g);
    const head = el('g', {}, g);
    el('circle', { cx: o.x, cy: o.y, r: s, fill: o.color || C.red }, head);
    el('circle', { cx: o.x - s * 0.35, cy: o.y - s * 0.35, r: s * 0.32, fill: '#ffffff', opacity: 0.45 }, head);
    return {
      g, draw(p) {
        const k = ease.out(clamp(p)), q = 1 - k;
        g.setAttribute('opacity', p > 0 ? clamp(p * 4) : 0);
        head.setAttribute('transform', `translate(${f1(-q * U * 1.5)} ${f1(-q * U * 4)}) translate(${f1(o.x)} ${f1(o.y)}) scale(${(1 + q * 0.4).toFixed(3)}) translate(${f1(-o.x)} ${f1(-o.y)})`);
        sh.setAttribute('transform', `translate(${f1(q * U * 1.5)} ${f1(q * U)})`);
      },
    };
  }

  /** 红线（证据墙的连线）：opts points: [[x, y], …], color, width（默认 0.32u）, sag（下垂，默认 1.2u）；draw(p) 沿线拉出来 */
  function thread(parent, o) {
    const pts = o.points, sag = o.sag ?? U * 1.2;
    let d = `M ${f1(pts[0][0])} ${f1(pts[0][1])}`;
    for (let i = 1; i < pts.length; i++) { const [a, b] = [pts[i - 1], pts[i]]; d += ` Q ${f1((a[0] + b[0]) / 2)} ${f1((a[1] + b[1]) / 2 + sag)} ${f1(b[0])} ${f1(b[1])}`; }
    const g = el('g', { fill: 'none', 'stroke-linecap': 'round' }, parent);
    const s = el('path', { d, stroke: C.shadow, 'stroke-width': f1((o.width || U * 0.32) * 1.2), opacity: 0.2, transform: `translate(${f1(U * 0.3)} ${f1(U * 0.5)})` }, g);
    const l = el('path', { d, stroke: o.color || C.red, 'stroke-width': f1(o.width || U * 0.32) }, g);
    return { g, draw(p) { const q = clamp(p); g.setAttribute('opacity', q > 0 ? 1 : 0); S.draw(l, q); S.draw(s, q); } };
  }

  /** 证据墙连线：在 nodes 上按图钉，按 links 拉红线。opts nodes: [[x, y], …], links: [[i, j], …], color
   *  draw(p)：图钉依次按下，再逐条拉线 */
  function board(parent, o) {
    const threads = o.links.map(([i, j]) => thread(parent, { points: [o.nodes[i], o.nodes[j]], color: o.color, sag: o.sag }));
    const pins = o.nodes.map(([x, y]) => pin(parent, { x, y, color: o.color }));
    return { pins, threads, draw(p) { pins.forEach((pn, i) => pn.draw(clamp((p - i * 0.3 / pins.length) / 0.25))); threads.forEach((th, i) => th.draw(clamp((p - 0.35 - i * 0.65 / threads.length * 0.6) / 0.4))); } };
  }

  /** 示意地图碎片：一张撕下来的街区图（道路、街区、一条河），不画任何真实的国界、海岸线。
   *  需要真实地图时用用户上传的合规地图（cutout 的 src）。opts 同 tornCard（默认 tone newsprint）；返回 tornCard 的对象 */
  function mapScrap(parent, o) {
    const card = tornCard(parent, { tone: 'newsprint', torn: 'trbl', ...o });
    const r = S.rng((o.seed ?? 900) + 3), { x, y, w, h } = o, gg = el('g', { opacity: 0.9 }, card.inner);
    const rv = [];
    for (let i = 0; i <= 12; i++) rv.push([x + w * i / 12, y + h * (0.62 + 0.14 * Math.sin(i * 0.7 + r() * 0.4))]);
    el('path', { d: smooth(rv), fill: 'none', stroke: '#b7bdc4', 'stroke-width': f1(U * 2.4), 'stroke-linecap': 'round' }, gg);
    const road = (x1, y1, x2, y2, wd) => { el('line', { x1, y1, x2, y2, stroke: '#c9c2b0', 'stroke-width': f1(wd + U * 0.3) }, gg); el('line', { x1, y1, x2, y2, stroke: '#f7f3ea', 'stroke-width': f1(wd) }, gg); };
    for (let i = 1; i < 5; i++) road(x + w * i / 5 + (r() - 0.5) * U * 3, y, x + w * i / 5 + (r() - 0.5) * U * 3, y + h, U * (i === 2 ? 1.2 : 0.6));
    for (let j = 1; j < 4; j++) road(x, y + h * j / 4 + (r() - 0.5) * U * 2, x + w, y + h * j / 4 + (r() - 0.5) * U * 2, U * (j === 1 ? 1 : 0.5));
    road(x, y + h * 0.9, x + w, y + h * 0.15, U * 0.9);
    return card;
  }

  /** 地图标记：水滴形红色图钉 + 旁边的纸条标签。opts x, y（针尖）, label, size（默认 3u）；draw(p) 落下 */
  function mapPin(parent, o) {
    const s = o.size || U * 3, g = el('g', { opacity: 0 }, parent), body = el('g', {}, g);
    el('ellipse', { cx: o.x, cy: o.y, rx: s * 0.35, ry: s * 0.14, fill: C.shadow, opacity: 0.3 }, g);
    el('path', { d: `M ${f1(o.x)} ${f1(o.y)} C ${f1(o.x - s * 0.2)} ${f1(o.y - s * 0.6)} ${f1(o.x - s * 0.55)} ${f1(o.y - s * 0.85)} ${f1(o.x - s * 0.55)} ${f1(o.y - s * 1.2)} A ${f1(s * 0.55)} ${f1(s * 0.55)} 0 1 1 ${f1(o.x + s * 0.55)} ${f1(o.y - s * 1.2)} C ${f1(o.x + s * 0.55)} ${f1(o.y - s * 0.85)} ${f1(o.x + s * 0.2)} ${f1(o.y - s * 0.6)} ${f1(o.x)} ${f1(o.y)} Z`, fill: C.red }, body);
    el('circle', { cx: o.x, cy: o.y - s * 1.2, r: s * 0.22, fill: '#fff8ee' }, body);
    const lab = o.label ? strip(g, { x: o.x + s * 0.9, y: o.y - s * 0.95, text: o.label, size: U * 2.8, font: 'sans', from: 'none', rotate: 0 }) : null;
    return {
      g, draw(p) {
        const k = ease.out(clamp(p / 0.7));
        g.setAttribute('opacity', p > 0 ? 1 : 0);
        body.setAttribute('transform', `translate(0 ${f1(-(1 - k) * U * 8)})`);
        body.setAttribute('opacity', clamp(p * 5));
        if (lab) lab.draw(clamp((p - 0.6) / 0.4));
      },
    };
  }

  window.CL = { C, TONE, PAPER, F, U, mix, rgba, step, track, tornRect, cutRect, textWidth: textW, stage, heading, kicker, text, note, strip, badge, sourceTag, watermark,
    tornCard, piece, halftone, cutout, tape, stamp, circle, underline, highlight, arrow, strike, redact, counter, bars, dateFlip, pin, thread, board,
    mapScrap, mapPin, ART };
})();
