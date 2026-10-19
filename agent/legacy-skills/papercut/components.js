/* 窗花剪纸组件（依赖 SLATE 运行时）：节庆营销、民俗讲解、节日问候
 *
 * 约定（和其他官方风格一致）：
 *   - 组件在创建时一次性生成元素：纸片在加载时烘焙成贴图（纸纹、刀口、阴线、纸影都在这一步做好）；
 *     render(t) 里只根据 t 摆放它们。
 *   - draw(p)：p 为 0～1 的入场进度；set(t, …)：需要绝对时间的组件（折剪展、飘落）。
 *     摇曳、闪烁这类环境动效读 st.t（st.set(t) 时记下），所以仍然只由 t 决定。
 *   - 纸片画在 st.ctx（canvas），按 render 里的调用顺序从后往前叠；文字是 SVG，永远在纸片之上。
 *   - 尺寸都写成 SLATE.u 的倍数。纸片入场用 PC.seg（按 12fps 步进，像一格一格摆出来的），
 *     镜头、光、飘落物用 SLATE.seg（逐帧平滑）。
 *
 *   const st = PC.stage({ ground: 'indigo', enter: 'cut' });     // 地纸 + 镜头 + 转场纸
 *   const h = PC.heading(st, { text: '年味到家' });
 *   const fl = PC.flower(st, { x: W / 2, y: H * 0.42, r: 18 * U, seed: 3 });
 *   function render(t) { st.set(t); fl.draw(PC.seg(t, 0.4, 2.4), { glow: SLATE.seg(t, 2.6, 3.2) }); h.draw(PC.seg(t, 2.8, 3.6)); }
 *
 * 组件一览（参数见各函数注释）：
 *   舞台与排版：stage、heading、text、area、steps、source、tag
 *   纸片：piece（任意形状）、shape（形状工具）、flower（团花）、foldcut（折→剪→展）、lantern（灯笼）、
 *        banner（横批）、couplet（春联）、fu（福字斗方）、seal（印章）、badge（圆形卖点章）、frame（窗格边框）、
 *        tile（纹样卡）、hills（远山）、scraps（飘落的纸屑）
 *   工具：seg、step、C（色板）、ground（地纸族）
 */
(() => {
  const S = window.SLATE;
  const U = S.u, W = S.width, H = S.height;
  const { clamp, lerp, ease } = S;
  const TAU = Math.PI * 2;
  const el = (tag, attrs, parent) => S.svg(tag, attrs, parent);
  let uid = 0;
  const id = p => `pc${p}${++uid}`;

  // ---------------------------------------------------------------------------------------------
  // 色板：中国红分档（主体、远处、背面、深一档），金箔只给全片一个时刻
  const C = {
    red: '#D2201F', far: '#7E1424', back: '#DE3B30', deep: '#A8161B', lit: '#EE3A26',
    gold: '#D9A93F', goldHi: '#F7DC8C', goldLo: '#9A6A1C',
    cream: '#F8EDD5', ink: '#22150E', ink2: '#6A5242',
    seal: '#C4281E', lamp: '#FFB255', light: '#FFE4AE',
  };
  // 地纸族：地和主体必须是不同纸族（红纸贴在米纸、靛蓝夜纸或青碧纸上）
  const GROUND = {
    rice: { base: '#F2E7D2', mott: ['#E5D3B2', '#FBF4E6'], fiber: ['#D6C09A', '#FFFAF0'], speck: '#B09772', vig: 'rgba(120, 78, 40, 0.18)',
      text: '#2A1B12', text2: '#6A5242', title: '#C81E1D', far: ['#EBC4B0', '#E2AC97'], shadow: '#4a2410', shadowA: 0.36,
      line: 'rgba(70, 40, 22, 0.6)', night: false },
    indigo: { base: '#1B2546', mott: ['#26335E', '#121A35'], fiber: ['#34467C', '#0E152E'], speck: '#51649A', vig: 'rgba(3, 5, 14, 0.5)',
      text: '#F8EDD5', text2: '#C5CADD', title: '#F8EDD5', far: ['#2D3D6C', '#25335C'], shadow: '#02040c', shadowA: 0.55,
      line: 'rgba(238, 220, 196, 0.55)', night: true },
    jade: { base: '#1E3A34', mott: ['#284A41', '#152D28'], fiber: ['#385B51', '#10241F'], speck: '#55796C', vig: 'rgba(3, 12, 9, 0.45)',
      text: '#F4EBD6', text2: '#C2D2C8', title: '#F4EBD6', far: ['#2B4C44', '#24433B'], shadow: '#020a07', shadowA: 0.5,
      line: 'rgba(236, 226, 202, 0.5)', night: true },
  };
  const F = {
    brush: '"Ma Shan Zheng", "Noto Sans CJK SC", "Noto Sans SC", serif',
    sans: '"Noto Sans CJK SC", "Noto Sans SC", "PingFang SC", sans-serif',
  };
  document.documentElement.style.setProperty('--pc-u', U + 'px');
  // 书法字体：渲染前等它加载完（文字排版在第一次 draw 时才测量，那时字体已经就绪）
  if (document.fonts && document.fonts.load) S.waits.push(document.fonts.load(`${Math.round(U * 8)}px "Ma Shan Zheng"`, '福春年').catch(() => null));

  const hex = c => [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16));
  const mix = (c1, c2, p) => { const a = hex(c1), b = hex(c2), q = clamp(p); return '#' + a.map((v, i) => Math.round(v + (b[i] - v) * q).toString(16).padStart(2, '0')).join(''); };
  const rgba = (c, a) => { const [r, g, b] = hex(c); return `rgba(${r}, ${g}, ${b}, ${a})`; };

  /** 时间按 12fps 取整（纸片、关节的"一格一格"感）；镜头和光不要用它 */
  const step = (t, fps = 12) => Math.floor(t * fps + 1e-4) / fps;
  /** 和 SLATE.seg 一样，但时间先按 12fps 取整。纸片入场、展开、贴字都用它 */
  const seg = (t, a, b, fn = ease.out) => S.seg(step(t), a, b, fn);

  // ---------------------------------------------------------------------------------------------
  // 几何：形状 = 多边形数组（每个多边形是 [[x, y], …]），在局部坐标里生成，最后转成 Path2D
  const polyArea = pts => { let a = 0; for (let i = 0, n = pts.length; i < n; i++) { const p = pts[i], q = pts[(i + 1) % n]; a += p[0] * q[1] - q[0] * p[1]; } return a / 2; };
  /** 多边形数组 → Path2D。闭合多边形统一成同一绕向，这样重叠部分按"并集"填充 */
  const toPath = (polys, close = true) => {
    const path = new Path2D();
    for (let poly of polys) {
      if (!poly || poly.length < 2) continue;
      if (close && polyArea(poly) < 0) poly = poly.slice().reverse();
      path.moveTo(poly[0][0], poly[0][1]);
      for (let i = 1; i < poly.length; i++) path.lineTo(poly[i][0], poly[i][1]);
      if (close) path.closePath();
    }
    return path;
  };
  const bboxOf = polys => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const poly of polys) for (const [x, y] of poly) { if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; }
    return { x0, y0, x1, y1 };
  };
  /** 平移、旋转、缩放一个多边形：先缩放（s, sy），再旋转 a，再平移到 (x, y) */
  const tr = (pts, x = 0, y = 0, a = 0, s = 1, sy = s) => {
    const c = Math.cos(a), si = Math.sin(a);
    return pts.map(([px, py]) => [x + px * s * c - py * sy * si, y + px * s * si + py * sy * c]);
  };
  /** 绕原点复制 n 份（每份旋转 TAU/n），offset 是第一份的角度 */
  const ring = (polys, n, offset = 0) => {
    const out = [];
    for (let k = 0; k < n; k++) for (const p of polys) out.push(tr(p, 0, 0, offset + k * TAU / n));
    return out;
  };
  /** 在边上插点，让后面的抖动沿着边起伏 */
  const densify = (pts, maxLen, closed = true) => {
    const out = [], n = pts.length;
    for (let i = 0; i < (closed ? n : n - 1); i++) {
      const a = pts[i], b = pts[(i + 1) % n], L = Math.hypot(b[0] - a[0], b[1] - a[1]), k = Math.max(1, Math.ceil(L / maxLen));
      for (let j = 0; j < k; j++) out.push([lerp(a[0], b[0], j / k), lerp(a[1], b[1], j / k)]);
    }
    if (!closed) out.push(pts[n - 1]);
    return out;
  };
  /** 手剪的刀口：沿弧长加一点低频抖动 */
  const wobble = (pts, amp, seed = 1) => {
    if (!amp) return pts;
    let s = 0;
    return pts.map((p, i) => {
      if (i) s += Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]);
      const k = s / (U * 2.6);
      return [p[0] + S.noise(seed, k) * amp, p[1] + S.noise(seed + 31, k) * amp];
    });
  };
  const centroid = pts => { let x = 0, y = 0; for (const p of pts) { x += p[0]; y += p[1]; } return [x / pts.length, y / pts.length]; };

  /** 基本形（都以原点为中心或根部），配合 PC.tr 摆放 */
  const SH = {
    circle: (r, n) => { n = n || Math.max(14, Math.min(120, Math.round(r / U * 5 + 12))); return Array.from({ length: n }, (_, i) => [Math.cos(i / n * TAU) * r, Math.sin(i / n * TAU) * r]); },
    ellipse: (rx, ry, n = 56) => Array.from({ length: n }, (_, i) => [Math.cos(i / n * TAU) * rx, Math.sin(i / n * TAU) * ry]),
    /** 超椭圆（灯笼、鼓形）：e 越大越方 */
    blob: (rx, ry, e = 2.6, n = 72) => Array.from({ length: n }, (_, i) => { const a = i / n * TAU, c = Math.cos(a), s = Math.sin(a); return [Math.sign(c) * Math.pow(Math.abs(c), 2 / e) * rx, Math.sign(s) * Math.pow(Math.abs(s), 2 / e) * ry]; }),
    rect: (w, h) => [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]],
    /** 圆角矩形 */
    rrect: (w, h, r) => {
      r = Math.min(r, w / 2, h / 2); const out = [];
      const cs = [[w / 2 - r, -h / 2 + r, -Math.PI / 2], [w / 2 - r, h / 2 - r, 0], [-w / 2 + r, h / 2 - r, Math.PI / 2], [-w / 2 + r, -h / 2 + r, Math.PI]];
      for (const [cx, cy, a0] of cs) for (let i = 0; i <= 6; i++) { const a = a0 + i / 6 * Math.PI / 2; out.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]); }
      return out;
    },
    diamond: (w, h) => [[0, -h / 2], [w / 2, 0], [0, h / 2], [-w / 2, 0]],
    /** 水滴花瓣：根部在原点，尖朝 +x；fat 越小越靠根部饱满 */
    petal: (len, wid, fat = 0.6, n = 18) => {
      const up = [], dn = [];
      for (let i = 0; i <= n; i++) { const u = i / n, hw = wid / 2 * Math.pow(Math.sin(Math.PI * Math.pow(u, fat)), 0.8); up.push([u * len, -hw]); dn.push([u * len, hw]); }
      return up.concat(dn.reverse().slice(1, -1));
    },
    /** 柳叶（两头尖）：中心在原点，沿 x 轴 */
    lens: (len, wid, n = 16) => {
      const up = [], dn = [];
      for (let i = 0; i <= n; i++) { const u = i / n, hw = wid / 2 * Math.sin(Math.PI * u); up.push([(u - 0.5) * len, -hw]); dn.push([(u - 0.5) * len, hw]); }
      return up.concat(dn.reverse().slice(1, -1));
    },
    /** 月牙：外圆半径 r，内圆向 +x 偏 d（d 就是最厚处），两个角朝 +x */
    crescent: (r, d, n = 26) => {
      const b = Math.acos(clamp(d / (2 * r), -1, 1)), g = Math.atan2(r * Math.sin(b), d / 2), pts = [];
      for (let i = 0; i <= n; i++) { const a = b + (TAU - 2 * b) * i / n; pts.push([Math.cos(a) * r, Math.sin(a) * r]); }
      for (let i = 1; i < n; i++) { const p = (g - Math.PI) - 2 * g * i / n; pts.push([d + Math.cos(p) * r, Math.sin(p) * r]); }
      return pts;
    },
    /** 锯齿的一个齿：底边在 y 轴上（宽 w），尖朝 +x（高 h） */
    tooth: (w, h) => [[0, -w / 2], [h, 0], [0, w / 2]],
  };

  // ---------------------------------------------------------------------------------------------
  // 纹样（返回 { holes, slits, paper }：孔、缝、在孔里补回去的纸条），尺寸 s 是纹样大致的宽度
  const motifs = {
    /** 如意云头：三瓣加一个尖（尖朝 +x），两侧小瓣里卷一道纸须（纸须从孔外起笔，不会成孤岛） */
    cloud(s) {
      const holes = [tr(SH.circle(s * 0.30), -s * 0.12, 0), tr(SH.circle(s * 0.22), s * 0.1, -s * 0.3), tr(SH.circle(s * 0.22), s * 0.1, s * 0.3),
        [[s * 0.0, -s * 0.36], [s * 0.56, 0], [s * 0.0, s * 0.36]]];
      const curl = (cx, cy, rr, a0, dir) => { const pts = []; for (let i = 0; i <= 30; i++) { const u = i / 30, a = a0 + dir * u * TAU * 0.92, rad = rr * (1.12 - 0.78 * u); pts.push([cx + Math.cos(a) * rad, cy + Math.sin(a) * rad]); } return pts; };
      const w = s * 0.055;
      return { holes, slits: [], paper: [{ pts: curl(s * 0.1, -s * 0.3, s * 0.22, -Math.PI / 2 - 0.5, 1), w }, { pts: curl(s * 0.1, s * 0.3, s * 0.22, Math.PI / 2 + 0.5, -1), w },
        { pts: curl(-s * 0.12, 0, s * 0.3, Math.PI, 1), w }] };
    },
    /** 古钱：外圆内方；四个弧形孔之间留连桥 */
    coin(s) {
      const r = s / 2, a = r * 0.34, holes = [], th = Math.PI / 4 - 0.11, ia = a + r * 0.12, b = ia * Math.tan(th) * 0.92;
      for (let k = 0; k < 4; k++) {
        const pts = [];
        for (let i = 0; i <= 18; i++) { const ang = -th + 2 * th * i / 18; pts.push([Math.cos(ang) * r, Math.sin(ang) * r]); }
        pts.push([ia, b], [ia, -b]);
        holes.push(tr(pts, 0, 0, k * Math.PI / 2));
      }
      holes.push(SH.rect(a * 1.25, a * 1.25));
      return { holes, slits: [], paper: [] };
    },
    /** 回纹：方形回旋的缝（缝不会切出孤岛） */
    fret(s) {
      const d = s / 7.5, w = d * 0.42, pts = [[-s / 2, s / 2]];
      let x = -s / 2, y = s / 2, dir = 0, len = s, k = 0;
      const dirs = [[0, -1], [1, 0], [0, 1], [-1, 0]];
      while (len > d * 0.9 && k < 40) { x += dirs[dir][0] * len; y += dirs[dir][1] * len; pts.push([x, y]); dir = (dir + 1) % 4; k++; if (k >= 3 && k % 2 === 1) len -= d; }
      return { holes: [], slits: [{ pts, w }], paper: [] };
    },
    /** 五瓣梅：五个圆孔围着纸做的花心，花心里点五粒蕊 */
    plum(s) {
      const r = s / 2, holes = [];
      for (let k = 0; k < 5; k++) { const a = -Math.PI / 2 + k * TAU / 5; holes.push(tr(SH.circle(r * 0.25), Math.cos(a) * r * 0.55, Math.sin(a) * r * 0.55)); }
      for (let k = 0; k < 5; k++) { const a = -Math.PI / 2 + (k + 0.5) * TAU / 5; holes.push(tr(SH.circle(r * 0.045), Math.cos(a) * r * 0.17, Math.sin(a) * r * 0.17)); }
      holes.push(SH.circle(r * 0.05));
      return { holes, slits: [], paper: [] };
    },
    /** 小团花（八瓣）：用作纹样卡、角花 */
    rosette(s) { const f = roundFlower(s / 2, 7, { outline: false }); return { holes: f.holes, slits: f.slits, paper: f.paper }; },
  };
  const merge = (...ms) => ({ holes: ms.flatMap(m => m.holes || []), slits: ms.flatMap(m => m.slits || []), paper: ms.flatMap(m => m.paper || []) });
  const moveMotif = (m, x, y, a = 0, s = 1) => ({
    holes: (m.holes || []).map(p => tr(p, x, y, a, s)),
    slits: (m.slits || []).map(q => ({ pts: tr(q.pts, x, y, a, s), w: q.w * s })),
    paper: (m.paper || []).map(q => ({ pts: tr(q.pts, x, y, a, s), w: q.w * s })),
  });

  // ---------------------------------------------------------------------------------------------
  // 纸纹贴图：一次生成，供纸片（source-atop 叠在纸上）和 SVG 文字（pattern）共用
  const canvas = (w, h) => { const c = document.createElement('canvas'); c.width = Math.max(1, Math.ceil(w)); c.height = Math.max(1, Math.ceil(h)); return c; };
  let grainCv = null;
  function grain() {
    if (grainCv) return grainCv;
    const n = 192, c = canvas(n, n), x = c.getContext('2d', { willReadFrequently: true });
    const im = x.createImageData(n, n), r = S.rng(9001);
    for (let i = 0; i < n * n; i++) {
      const light = r() > 0.55, v = light ? 255 : 0;
      im.data[i * 4] = im.data[i * 4 + 1] = im.data[i * 4 + 2] = v;
      im.data[i * 4 + 3] = Math.round(Math.pow(r(), 3) * (light ? 40 : 52));
    }
    x.putImageData(im, 0, 0);
    x.lineCap = 'round';
    for (let i = 0; i < 60; i++) {
      const cx = r() * n, cy = r() * n, L = 8 + r() * 26, a = r() * TAU, bend = (r() - 0.5) * L * 0.6, light = r() > 0.5;
      x.strokeStyle = light ? 'rgba(255,255,255,0.16)' : 'rgba(0,0,0,0.12)'; x.lineWidth = 0.6 + r() * 0.9;
      for (const dx of [-n, 0, n]) for (const dy of [-n, 0, n]) {
        x.beginPath(); x.moveTo(cx + dx, cy + dy);
        x.quadraticCurveTo(cx + dx + Math.cos(a) * L / 2 - Math.sin(a) * bend, cy + dy + Math.sin(a) * L / 2 + Math.cos(a) * bend, cx + dx + Math.cos(a) * L, cy + dy + Math.sin(a) * L);
        x.stroke();
      }
    }
    grainCv = c;
    return c;
  }
  /** 整张纸（地纸、转场纸）：底色 + 染色不匀 + 纤维 + 细点 + 暗角。固定种子，一次生成 */
  function bakeSheet(gw, gh, g, seed) {
    const c = canvas(gw, gh), x = c.getContext('2d'), r = S.rng(seed * 131 + 7), k = (gw * gh) / (W * H);
    x.fillStyle = g.base; x.fillRect(0, 0, gw, gh);
    for (let i = 0; i < 80 * k; i++) {
      const cx = r() * gw, cy = r() * gh, rad = (8 + r() * 28) * U, col = g.mott[i % 2];
      const rg = x.createRadialGradient(cx, cy, 0, cx, cy, rad);
      rg.addColorStop(0, rgba(col, 0.1 + r() * 0.14)); rg.addColorStop(1, rgba(col, 0));
      x.fillStyle = rg; x.fillRect(cx - rad, cy - rad, rad * 2, rad * 2);
    }
    x.lineCap = 'round';
    for (let i = 0; i < 2400 * k; i++) {
      const cx = r() * gw, cy = r() * gh, L = (0.8 + r() * 3.6) * U, a = r() * TAU, bend = (r() - 0.5) * L * 0.7;
      x.strokeStyle = rgba(g.fiber[i % 2], 0.1 + r() * 0.22); x.lineWidth = (0.05 + r() * 0.12) * U;
      x.beginPath(); x.moveTo(cx, cy);
      x.quadraticCurveTo(cx + Math.cos(a) * L / 2 - Math.sin(a) * bend, cy + Math.sin(a) * L / 2 + Math.cos(a) * bend, cx + Math.cos(a) * L, cy + Math.sin(a) * L);
      x.stroke();
    }
    for (let i = 0; i < 600 * k; i++) { x.fillStyle = rgba(g.speck, 0.15 + r() * 0.4); x.beginPath(); x.arc(r() * gw, r() * gh, (0.04 + r() * 0.12) * U, 0, TAU); x.fill(); }
    x.globalAlpha = 0.8; x.fillStyle = x.createPattern(grain(), 'repeat'); x.fillRect(0, 0, gw, gh); x.globalAlpha = 1;
    if (g.vig) {
      const vg = x.createRadialGradient(gw / 2, gh / 2, Math.min(gw, gh) * 0.32, gw / 2, gh / 2, Math.max(gw, gh) * 0.72);
      vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, g.vig);
      x.fillStyle = vg; x.fillRect(0, 0, gw, gh);
    }
    return c;
  }

  // ---------------------------------------------------------------------------------------------
  // 纸片贴图：def = { outline, holes, slits, paper, inset, tone, back, wob, seed, k, pad }
  //   outline：外轮廓（多边形数组，并集）；holes：镂空；slits：剪开的缝 [{pts, w}]；paper：补回去的纸条 [{pts, w}]
  //   inset：{ d, w, dash }——沿外轮廓往里 d 处剪一道宽 w 的阴线，dash 留出连桥（[实, 空]）
  function bake(def) {
    const k = def.k || 1.5, wob = def.wob ?? U * 0.06, seed = def.seed || 1;
    const outlinePolys = def.outline.map((p, i) => wobble(densify(p, U * 0.8), wob, seed + i));
    const holePolys = (def.holes || []).map((p, i) => wobble(p, wob * 0.5, seed + 100 + i));
    const bb = bboxOf(outlinePolys), pad = def.pad ?? U * 2.6, fr = def.frame;
    // frame：沿用另一张贴图的像素网格（两张图要逐像素叠在一起时用）
    const x0 = fr ? fr.x0 : bb.x0 - pad, y0 = fr ? fr.y0 : bb.y0 - pad;
    const cw = fr ? fr.cw : Math.ceil((bb.x1 - bb.x0 + pad * 2) * k), ch = fr ? fr.ch : Math.ceil((bb.y1 - bb.y0 + pad * 2) * k);
    const spr = { k, x0, y0, w: cw / k, h: ch / k, cw, ch, tone: def.tone || C.red, back: def.back || null, seed, cache: {},
      outline: toPath(outlinePolys), holes: toPath(holePolys), holePolys, cx: (bb.x0 + bb.x1) / 2, cy: (bb.y0 + bb.y1) / 2, bb };
    const local = x => x.setTransform(k, 0, 0, k, -x0 * k, -y0 * k);
    // 剪好的纸（白色遮罩）
    const mask = canvas(cw, ch), m = mask.getContext('2d', { willReadFrequently: true });
    local(m);
    m.fillStyle = '#fff'; m.fill(spr.outline);
    if (def.inset) {
      const { d, w: sw, dash } = def.inset;
      m.save(); m.clip(spr.outline);
      m.globalCompositeOperation = 'destination-out';
      m.lineWidth = 2 * (d + sw); m.lineJoin = 'round'; if (dash) m.setLineDash(dash); m.stroke(spr.outline); m.setLineDash([]);
      m.globalCompositeOperation = 'source-over';
      m.lineWidth = 2 * d; m.strokeStyle = '#fff'; m.stroke(spr.outline);
      m.restore();
    }
    m.globalCompositeOperation = 'destination-out';
    if (holePolys.length) m.fill(spr.holes);
    m.lineCap = 'round'; m.lineJoin = 'round';
    for (const s of def.slits || []) { m.lineWidth = s.w; m.stroke(toPath([s.pts], false)); }
    m.globalCompositeOperation = 'source-over';
    if ((def.paper || []).length) {
      m.save(); m.clip(spr.outline); m.strokeStyle = '#fff';
      for (const s of def.paper) { m.lineWidth = s.w; m.stroke(toPath([s.pts], false)); }
      m.restore();
    }
    spr.mask = mask;
    // 只有外轮廓（不带孔）：背光、投影用
    const sil = canvas(cw, ch), sx = sil.getContext('2d', { willReadFrequently: true });
    local(sx); sx.fillStyle = '#fff'; sx.fill(spr.outline);
    spr.sil = sil;
    return spr;
  }
  const colorize = (src, color) => { const c = canvas(src.width, src.height), x = c.getContext('2d'); x.drawImage(src, 0, 0); x.globalCompositeOperation = 'source-in'; x.fillStyle = color; x.fillRect(0, 0, c.width, c.height); return c; };
  /** 三遍盒式模糊（只处理 alpha），结果和浏览器、GPU 无关 */
  function blurAlpha(src, r) {
    const w = src.width, h = src.height, x = src.getContext('2d', { willReadFrequently: true }), d = x.getImageData(0, 0, w, h).data;
    let a = new Float32Array(w * h), b = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) a[i] = d[i * 4 + 3];
    const rad = Math.max(1, Math.round(r)), inv = 1 / (2 * rad + 1);
    for (let pass = 0; pass < 3; pass++) {
      for (let yy = 0; yy < h; yy++) {
        const o = yy * w; let acc = 0;
        for (let xx = -rad; xx <= rad; xx++) acc += a[o + clamp(xx, 0, w - 1)];
        for (let xx = 0; xx < w; xx++) { b[o + xx] = acc * inv; acc += a[o + Math.min(xx + rad + 1, w - 1)] - a[o + Math.max(xx - rad, 0)]; }
      }
      for (let xx = 0; xx < w; xx++) {
        let acc = 0;
        for (let yy = -rad; yy <= rad; yy++) acc += b[clamp(yy, 0, h - 1) * w + xx];
        for (let yy = 0; yy < h; yy++) { a[yy * w + xx] = acc * inv; acc += b[Math.min(yy + rad + 1, h - 1) * w + xx] - b[Math.max(yy - rad, 0) * w + xx]; }
      }
    }
    const c = canvas(w, h), y = c.getContext('2d', { willReadFrequently: true }), im = y.createImageData(w, h);
    for (let i = 0; i < w * h; i++) { im.data[i * 4] = im.data[i * 4 + 1] = im.data[i * 4 + 2] = 255; im.data[i * 4 + 3] = a[i]; }
    y.putImageData(im, 0, 0);
    return c;
  }
  /** 贴图的各种版本（懒生成并缓存）：
   *  tone:<色>（带刀口亮暗边和纸纹）、flat:<色>（纯色，用来压暗/提亮）、shadow:<色>（模糊纸影）、
   *  light（背光：只有外轮廓的亮纸）、holes（从孔里透出来的光，带一点晕） */
  function V(spr, key) {
    if (spr.cache[key]) return spr.cache[key];
    const [kind, color] = key.split(':');
    let out;
    if (kind === 'tone') {
      out = canvas(spr.cw, spr.ch);
      const x = out.getContext('2d'), e = Math.max(1, U * 0.07 * spr.k);
      x.drawImage(colorize(spr.mask, mix(color, '#ffffff', 0.3)), -e, -e);
      x.drawImage(colorize(spr.mask, mix(color, '#000000', 0.5)), e, e);
      x.drawImage(colorize(spr.mask, color), 0, 0);
      x.globalCompositeOperation = 'source-atop';
      const r = S.rng(spr.seed * 17 + 3);
      for (let i = 0; i < 7; i++) {
        const cx = r() * spr.cw, cy = r() * spr.ch, rad = (0.25 + r() * 0.5) * Math.max(spr.cw, spr.ch);
        const rg = x.createRadialGradient(cx, cy, 0, cx, cy, rad);
        rg.addColorStop(0, i % 2 ? 'rgba(255,240,220,0.07)' : 'rgba(40,0,0,0.09)'); rg.addColorStop(1, 'rgba(0,0,0,0)');
        x.fillStyle = rg; x.fillRect(0, 0, spr.cw, spr.ch);
      }
      x.fillStyle = x.createPattern(grain(), 'repeat'); x.fillRect(0, 0, spr.cw, spr.ch);
    } else if (kind === 'flat') out = colorize(spr.mask, color);
    else if (kind === 'shadow') { spr.cache.blur = spr.cache.blur || blurAlpha(spr.mask, U * 0.5 * spr.k); out = colorize(spr.cache.blur, color); }
    else if (kind === 'light') out = colorize(spr.sil, C.light);
    else if (kind === 'holes') {
      const hm = canvas(spr.cw, spr.ch), x = hm.getContext('2d', { willReadFrequently: true });
      x.drawImage(spr.sil, 0, 0); x.globalCompositeOperation = 'destination-out'; x.drawImage(spr.mask, 0, 0);
      out = colorize(blurAlpha(hm, U * 0.45 * spr.k), C.lamp);
    } else if (kind === 'bloom') { spr.cache.blur = spr.cache.blur || blurAlpha(spr.mask, U * 0.5 * spr.k); out = colorize(spr.cache.blur, C.lamp); }
    spr.cache[key] = out;
    return out;
  }
  const img = (x, spr, cv) => x.drawImage(cv, spr.x0, spr.y0, spr.w, spr.h);

  // ---------------------------------------------------------------------------------------------
  // 入场姿态：p 是 0～1 的进度（建议用 PC.seg 取得，按 12fps 步进）。返回 null 表示还没出现
  //   paste（默认，签名入场）：悬空 → 落到纸上 → 轻轻一抖；pop：转着弹出来（卖点章）；
  //   rise：从下面升起（远山）；stamp：印章盖下；none：直接出现
  function enterState(kind, p, o = {}) {
    if (p <= 0) return null;
    p = clamp(p);
    if (kind === 'none') return { dx: 0, dy: 0, r: 0, s: 1, alpha: 1, lift: 0 };
    if (kind === 'rise') { const k = ease.out(p); return { dx: 0, dy: (1 - k) * (o.rise ?? U * 14), r: 0, s: 1, alpha: clamp(p * 3), lift: 0 }; }
    if (kind === 'pop') {
      const s = p < 0.7 ? lerp(0.55, 1.08, ease.out(p / 0.7)) : lerp(1.08, 1, (p - 0.7) / 0.3);
      return { dx: 0, dy: 0, r: (1 - ease.out(p)) * -0.6, s, alpha: clamp(p * 4), lift: 1 - p };
    }
    if (kind === 'stamp') {
      const s = p < 0.55 ? lerp(1.6, 0.97, ease.in(p / 0.55)) : lerp(0.97, 1, ease.out((p - 0.55) / 0.45));
      return { dx: 0, dy: 0, r: 0, s, alpha: clamp(p * 2.5), lift: clamp(1 - p / 0.55) };
    }
    const k = ease.out(clamp(p / 0.78)), settle = p > 0.78 ? Math.sin((p - 0.78) / 0.22 * Math.PI) : 0;
    return { dx: 0, dy: -(1 - k) * (o.drop ?? U * 5) + settle * U * 0.18, r: (1 - k) * (o.tilt ?? 0.05), s: 1 + 0.035 * (1 - k), alpha: clamp(p * 4), lift: 1 - k };
  }

  /** 把一张纸片贴图画到 st.ctx。tf = { x, y, r, s, depth }；o = { alpha, lift, shadow, glow, tone, dim, sheen, clip } */
  function paint(st, spr, tf, o = {}) {
    const x = st.ctx, a = o.alpha ?? 1, lift = clamp(o.lift || 0), g = clamp(o.glow || 0), tone = o.tone || spr.tone;
    if (a <= 0.001) return;
    const t2 = { ...tf, s: (tf.s ?? 1) * (1 + 0.03 * lift) };
    if (o.shadow !== false) {
      x.save();
      st.at(x, t2, U * (0.25 + 1.2 * lift), U * (0.35 + 1.6 * lift));
      if (o.clip) o.clip(x);
      x.globalAlpha = a * st.G.shadowA * (1 - 0.5 * lift) * (1 - 0.8 * g);
      img(x, spr, V(spr, 'shadow:' + st.G.shadow));
      x.restore();
    }
    x.save();
    st.at(x, t2);
    if (o.clip) o.clip(x);
    if (g > 0) {
      // 背光：纸后面一圈光晕；外轮廓里铺一层亮纸（孔里就透出光），再盖上红纸
      x.globalCompositeOperation = 'lighter';
      x.save(); x.translate(spr.cx, spr.cy); x.scale(1.06, 1.06); x.translate(-spr.cx, -spr.cy);
      x.globalAlpha = a * g * 0.55; img(x, spr, V(spr, 'bloom')); x.restore();
      x.globalCompositeOperation = 'source-over';
      x.globalAlpha = a * g; img(x, spr, V(spr, 'light'));
    }
    x.globalAlpha = a; img(x, spr, V(spr, 'tone:' + tone));
    if (g > 0) {
      x.globalAlpha = a * g * 0.4; img(x, spr, V(spr, 'tone:' + C.lit));
      x.globalCompositeOperation = 'lighter';
      x.globalAlpha = a * g * 0.85; img(x, spr, V(spr, 'holes'));
      x.globalCompositeOperation = 'source-over';
    }
    if (o.dim) { x.globalAlpha = a * clamp(o.dim) * 0.75; img(x, spr, V(spr, 'flat:' + (st.G.night ? '#05070f' : '#2a1208'))); }
    if (o.sheen != null && o.sheen > 0 && o.sheen < 1) {
      // 金箔反光：一道亮带扫过纸面（只在纸上，不出界）
      const sc = st.scratch(spr.cw, spr.ch), sx = sc.getContext('2d');
      sx.setTransform(1, 0, 0, 1, 0, 0); sx.clearRect(0, 0, sc.width, sc.height);
      sx.drawImage(spr.mask, 0, 0); sx.globalCompositeOperation = 'source-in';
      const bx = lerp(-0.3, 1.3, o.sheen) * spr.cw, lg = sx.createLinearGradient(bx - spr.cw * 0.18, 0, bx + spr.cw * 0.18, spr.ch * 0.3);
      lg.addColorStop(0, 'rgba(255,250,225,0)'); lg.addColorStop(0.5, 'rgba(255,250,225,0.75)'); lg.addColorStop(1, 'rgba(255,250,225,0)');
      sx.fillStyle = lg; sx.fillRect(0, 0, spr.cw, spr.ch); sx.globalCompositeOperation = 'source-over';
      x.globalAlpha = a; x.drawImage(sc, 0, 0, spr.cw, spr.ch, spr.x0, spr.y0, spr.w, spr.h);
    }
    x.restore();
  }
  /** SVG 元素跟着纸片动：返回 transform 字符串（以纸片中心 (x, y) 为原点） */
  const svgTf = (x, y, e) => e ? `translate(${x + e.dx} ${y + e.dy}) rotate(${e.r * 180 / Math.PI}) scale(${e.s}) translate(${-x} ${-y})` : '';

  // ---------------------------------------------------------------------------------------------
  /** 舞台：地纸 canvas（纸片也画在这里）+ 文字 svg + 转场纸 canvas。
   *  opts: ground: 'rice'（米纸，白天）| 'indigo'（靛蓝夜纸）| 'jade'（青碧纸，非节庆）
   *        zoom: [起, 止]（镜头缓推，默认 [1, 1.03]）、pan: [dx, dy]（像素）、seed（纸纹种子）
   *        enter: 'none' | 'peel'（揭开盖着的纸）| 'cut'（剪开中缝、两扇纸向两边拉开）
   *        exit: 'none' | 'peel'（一张纸盖上来）| 'cut'（两扇纸合上）——相邻两镜用同一种 kind 和 sheet 色，就能无缝接上
   *        sheet: 转场纸的颜色（默认中国红）；kicks: [秒, …]（重物落定时的轻震，全片不超过 3 处）
   *  返回 { ctx, svg, world, hud, G, set(t), at(ctx, tf), cover(q, kind), dim(a, spot), pool(x, y, r, a) }
   *  内容文字放 world（跟随镜头），出处、角标放 hud（固定在屏幕上）。render(t) 第一行调用 st.set(t)。 */
  function stage(opts = {}) {
    const o = { ground: 'rice', zoom: [1, 1.03], pan: [0, 0], enter: 'none', exit: 'none', sheet: C.red, kicks: [], seed: 11, ...opts };
    const G = { ...(GROUND[o.ground] || GROUND.rice), name: o.ground };
    document.documentElement.style.setProperty('--pc-bg', G.base);
    document.documentElement.style.background = G.base;
    document.body.style.background = G.base;
    const root = document.createElement('div'); root.className = 'pc-root';
    const cv = canvas(W, H); cv.className = 'pc-cv';
    const svg = el('svg', { class: 'pc-svg', width: W, height: H, viewBox: `0 0 ${W} ${H}` });
    const fx = canvas(W, H); fx.className = 'pc-cv';
    root.appendChild(cv); root.appendChild(svg); root.appendChild(fx);
    document.body.insertBefore(root, document.body.firstChild);
    const ctx = cv.getContext('2d'), fctx = fx.getContext('2d');
    const defs = el('defs', {}, svg), world = el('g', {}, svg), hud = el('g', {}, svg);
    const gw = Math.ceil(W * 1.2), gh = Math.ceil(H * 1.2), groundCv = bakeSheet(gw, gh, G, o.seed);
    const sheetCv = {};
    const sheetOf = color => sheetCv[color] || (sheetCv[color] = bakeSheet(W, H, { base: color, mott: [mix(color, '#000000', 0.25), mix(color, '#ffffff', 0.12)], fiber: [mix(color, '#000000', 0.3), mix(color, '#ffffff', 0.25)], speck: mix(color, '#000000', 0.4), vig: 'rgba(40, 0, 0, 0.22)' }, o.seed + 5));
    let cam = { z: 1, x: 0, y: 0 };
    const scratches = {};
    const st = { ctx, svg, world, hud, defs, G, C, t: 0, opts: o };
    /** 深度 d 的镜头矩阵：d=0 是主纸面，d=1 是地纸（视差减半），负数更近 */
    const mat = d => { const f = 1 / (1 + d), z = 1 + (cam.z - 1) * f; return [z, W / 2 + cam.x * f - W / 2 * z, H / 2 + cam.y * f - H / 2 * z]; };
    st.at = (x, tf = {}, dx = 0, dy = 0) => {
      const m = mat(tf.depth || 0);
      x.setTransform(m[0], 0, 0, m[0], m[1], m[2]);
      x.translate((tf.x || 0) + dx, (tf.y || 0) + dy);
      if (tf.r) x.rotate(tf.r);
      const s = tf.s ?? 1, sy = tf.sy ?? s;
      if (s !== 1 || sy !== 1) x.scale(s, sy);
    };
    st.scratch = (w, h) => { const k = `${w}x${h}`; return scratches[k] || (scratches[k] = canvas(w, h)); };
    // 文字的纸影：不用 SVG 滤镜（滤镜的模糊在不同渲染顺序下会差 1 个色阶），改成两层错开的影子副本
    //   贴平：偏 (0.18u, 0.26u) 和 (0.34u, 0.48u)；悬空：偏得更远、更淡
    st.shadowOf = lifted => lifted ? [[U * 0.5, U * 0.75, 0.2], [U * 0.85, U * 1.2, 0.1]] : [[U * 0.16, U * 0.24, 0.42], [U * 0.32, U * 0.46, 0.18]];
    // 文字用的纸纹填充：色块 + 纸纹贴图（data: 地址，等它解码完才开始渲染）
    const fills = {};
    st.paperFill = color => {
      if (fills[color]) return fills[color];
      const pid = id('pf'), n = 192, pt = el('pattern', { id: pid, patternUnits: 'userSpaceOnUse', width: n, height: n }, defs);
      el('rect', { width: n, height: n, fill: color }, pt);
      const im = el('image', { width: n, height: n, opacity: 0.8 }, pt);
      S.waits.push(new Promise(res => { im.addEventListener('load', res, { once: true }); im.addEventListener('error', res, { once: true }); }));
      im.setAttribute('href', grain().toDataURL());
      return (fills[color] = `url(#${pid})`);
    };

    // ---- 转场纸 ----
    const D = Math.hypot(W, H);
    const half = (pts, px, py, ux, uy, s, keepGreater) => {
      // Sutherland–Hodgman：保留 (p - P)·u >= s（或 < s）的一侧
      const f = p => ((p[0] - px) * ux + (p[1] - py) * uy - s) * (keepGreater ? 1 : -1), out = [];
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i], b = pts[(i + 1) % pts.length], fa = f(a), fb = f(b);
        if (fa >= 0) out.push(a);
        if ((fa >= 0) !== (fb >= 0)) { const q = fa / (fa - fb); out.push([lerp(a[0], b[0], q), lerp(a[1], b[1], q)]); }
      }
      return out;
    };
    const fillPoly = (x, pts) => { x.beginPath(); pts.forEach((p, i) => (i ? x.lineTo(p[0], p[1]) : x.moveTo(p[0], p[1]))); x.closePath(); };
    /** 揭纸：一张纸从右下角往左上角揭起来；c=1 全盖住，c=0 全揭开 */
    function peel(c, color) {
      if (c <= 0) return;
      const tex = sheetOf(color);
      if (c >= 1) { fctx.drawImage(tex, 0, 0); return; }
      const ux = -W / D, uy = -H / D, px = W, py = H, band = D * 0.17, s = (1 - c) * (D + band);
      const rect = [[0, 0], [W, 0], [W, H], [0, H]];
      const covered = half(rect, px, py, ux, uy, s, true);
      // 被揭开一侧，沿折线投下的软影
      const sx0 = px + ux * s, sy0 = py + uy * s, sg = fctx.createLinearGradient(sx0, sy0, sx0 - ux * D * 0.07, sy0 - uy * D * 0.07);
      sg.addColorStop(0, 'rgba(20, 5, 0, 0.32)'); sg.addColorStop(1, 'rgba(20, 5, 0, 0)');
      fctx.save(); fillPoly(fctx, half(rect, px, py, ux, uy, s, false)); fctx.fillStyle = sg; fctx.fill(); fctx.restore();
      if (covered.length > 2) { fctx.save(); fillPoly(fctx, covered); fctx.clip(); fctx.drawImage(tex, 0, 0); fctx.restore(); }
      // 翻起来的纸背：折线后面 band 宽的一条，镜像到盖着的一侧
      const strip = half(half(rect, px, py, ux, uy, s, false), px, py, ux, uy, s - band, true);
      if (strip.length > 2) {
        const flap = strip.map(([qx, qy]) => { const dd = (qx - px) * ux + (qy - py) * uy; return [qx + 2 * (s - dd) * ux, qy + 2 * (s - dd) * uy]; });
        const fs = fctx.createLinearGradient(sx0 + ux * band, sy0 + uy * band, sx0 + ux * band * 1.25, sy0 + uy * band * 1.25);
        fs.addColorStop(0, 'rgba(20, 5, 0, 0.3)'); fs.addColorStop(1, 'rgba(20, 5, 0, 0)');
        fctx.save(); if (covered.length > 2) { fillPoly(fctx, covered); fctx.clip(); fctx.fillStyle = fs; fctx.fillRect(0, 0, W, H); } fctx.restore();
        const bg = fctx.createLinearGradient(sx0, sy0, sx0 + ux * band, sy0 + uy * band);
        bg.addColorStop(0, mix(color, '#ffffff', 0.42)); bg.addColorStop(0.55, mix(color, '#ffffff', 0.2)); bg.addColorStop(1, mix(color, '#000000', 0.12));
        fctx.save(); fillPoly(fctx, flap); fctx.fillStyle = bg; fctx.fill();
        fctx.globalAlpha = 0.5; fctx.clip(); fctx.fillStyle = fctx.createPattern(grain(), 'repeat'); fctx.fillRect(0, 0, W, H); fctx.restore();
      }
    }
    /** 剪开：中缝是一道锯齿，两扇纸向左右拉开；c=1 合拢，c=0 全开。snip（0～1）：先沿中缝从上往下剪 */
    const zig = (() => { const n = 10, amp = U * 2.2, pts = []; for (let i = 0; i <= n * 2; i++) pts.push([W / 2 + (i % 2 ? amp : -amp), H * i / (n * 2)]); return pts; })();
    function doors(c, color, snip = 1) {
      if (c <= 0) return;
      const tex = sheetOf(color), open = (1 - c) * (W / 2 + U * 6);
      const leftP = [[0, -2], ...zig.map(p => [p[0], p[1]]), [0, H + 2]], rightP = [[W, -2], ...zig.map(p => [p[0], p[1]]), [W, H + 2]];
      for (const [poly, dir] of [[leftP, -1], [rightP, 1]]) {
        fctx.save();
        fctx.translate(dir * open, 0);
        fillPoly(fctx, poly);
        if (c < 1) { fctx.shadowColor = 'rgba(20, 5, 0, 0.4)'; fctx.shadowBlur = U * 1.6; fctx.shadowOffsetX = U * 0.3; fctx.shadowOffsetY = U * 0.5; fctx.fillStyle = color; fctx.fill(); fctx.shadowColor = 'rgba(0,0,0,0)'; }
        fctx.clip(); fctx.drawImage(tex, 0, 0);
        fctx.restore();
      }
      if (c >= 1 && snip > 0 && snip < 1) {
        // 正在剪：已经剪过的那段缝里透出画面；剪刀在缝的尖端
        const L = snip * zig.length, n = Math.floor(L), pts = zig.slice(0, n + 1);
        if (n < zig.length - 1) { const a = zig[n], b = zig[n + 1], q = L - n; pts.push([lerp(a[0], b[0], q), lerp(a[1], b[1], q)]); }
        fctx.save(); fctx.globalCompositeOperation = 'destination-out'; fctx.lineWidth = U * 0.35; fctx.lineJoin = 'round';
        fctx.beginPath(); pts.forEach((p, i) => (i ? fctx.lineTo(p[0], p[1]) : fctx.moveTo(p[0], p[1]))); fctx.stroke(); fctx.restore();
        const tip = pts[pts.length - 1];
        drawScissors(fctx, tip[0], tip[1], Math.PI / 2, (Math.floor(st.t * 8) % 2) ? 1 : 0.2, U * 9);
      }
    }
    const drawCover = (kind, c, color, snip) => { if (kind === 'peel') peel(c, color); else if (kind === 'cut') doors(c, color, snip); };

    st.set = t => {
      st.t = t;
      const q = ease.inOut(clamp(t / Math.max(0.01, S.duration)));
      let z = lerp(o.zoom[0], o.zoom[1], q), px = o.pan[0] * q, py = o.pan[1] * q;
      // 重物落定的轻震：只持续约 0.4 秒，按 12fps 抖
      for (const k of o.kicks) { const d = step(t) - k; if (d >= 0 && d < 0.5) { const e = Math.exp(-d * 9) * U * 0.6; px += S.noise(41, d * 24 + k * 7) * e; py += S.noise(43, d * 24 + k * 7) * e; } }
      cam = { z, x: px, y: py };
      ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = G.base; ctx.fillRect(0, 0, W, H);
      st.at(ctx, { depth: 1 });
      ctx.drawImage(groundCv, -(gw - W) / 2, -(gh - H) / 2);
      world.setAttribute('transform', `translate(${W / 2 + px} ${H / 2 + py}) scale(${z}) translate(${-W / 2} ${-H / 2})`);
      // 转场纸
      fctx.setTransform(1, 0, 0, 1, 0, 0); fctx.globalAlpha = 1; fctx.globalCompositeOperation = 'source-over';
      fctx.clearRect(0, 0, W, H);
      let full = false;
      const Dur = S.duration;
      if (o.enter === 'peel') { const c = 1 - ease.inOut(clamp(t / 0.55)); drawCover('peel', c, o.sheet); full = full || c >= 1; }
      if (o.enter === 'cut') { const snip = clamp(t / 0.22), c = 1 - ease.inOut(clamp((t - 0.22) / 0.42)); drawCover('cut', c, o.sheet, snip); full = full || (c >= 1 && snip >= 1); }
      if (o.exit === 'peel' || o.exit === 'cut') { const c = ease.inOut(clamp((t - (Dur - 0.52)) / 0.46)); drawCover(o.exit, c, o.sheet, 1); full = full || c >= 1; }
      svg.style.visibility = full ? 'hidden' : 'visible';
    };
    /** 镜头内换画面：q 从 0 到 1 盖上，从 1 到 2 揭开（kind: 'peel' | 'cut'）。在 st.set(t) 之后调用 */
    st.cover = (q, kind = 'peel', color = o.sheet) => {
      const c = q <= 1 ? clamp(q) : 1 - clamp(q - 1);
      fctx.setTransform(1, 0, 0, 1, 0, 0);
      drawCover(kind, c, color, 1);
      if (c >= 1) svg.style.visibility = 'hidden';
    };
    /** 熄灯：把已经画上的纸片压暗（之后再画的纸片不受影响，用来做"只留一处背光"）。spot = { x, y, r } 留一圈亮 */
    st.dim = (a, spot) => {
      if (a <= 0) return;
      ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0);
      const col = G.night ? '3, 4, 12' : '40, 18, 6';
      if (spot) {
        const rg = ctx.createRadialGradient(spot.x, spot.y, spot.r * 0.55, spot.x, spot.y, spot.r * 1.6);
        rg.addColorStop(0, `rgba(${col}, 0)`); rg.addColorStop(1, `rgba(${col}, ${a})`);
        ctx.fillStyle = rg;
      } else ctx.fillStyle = `rgba(${col}, ${a})`;
      ctx.fillRect(0, 0, W, H); ctx.restore();
    };
    /** 地上的一摊暖光（灯笼、背光纸片下面）：叠加混合 */
    st.pool = (x, y, r, a = 0.5, depth = 0) => {
      if (a <= 0) return;
      ctx.save(); st.at(ctx, { x, y, depth }); ctx.scale(1, 0.55);
      const rg = ctx.createRadialGradient(0, 0, 0, 0, 0, r);
      rg.addColorStop(0, rgba(C.lamp, 0.4 * a)); rg.addColorStop(1, rgba(C.lamp, 0));
      ctx.globalCompositeOperation = 'lighter'; ctx.fillStyle = rg; ctx.fillRect(-r, -r, r * 2, r * 2); ctx.restore();
    };
    return st;
  }

  // ---------------------------------------------------------------------------------------------
  // 纹样生成：所有圈层的数量都是 8 的倍数、每个纹样左右对称，所以整朵花关于 kπ/8 的每条线都镜像对称，
  // 折叠和展开时，每一折的两半能严丝合缝地重合
  /** 圆形团花（D8）：半径 R；seed 换花样。返回 { outline, holes, slits, paper } */
  function roundFlower(R, seed = 1, o = {}) {
    const r = S.rng(seed * 7 + 3), holes = [], slits = [], paper = [];
    const outline = [];
    if (o.outline !== false) {
      const pts = [], m = 16;
      for (let i = 0; i < 640; i++) { const a = i / 640 * TAU, s = Math.abs(Math.sin(m * a / 2)); const rr = R * (0.9 + 0.1 * Math.pow(s, 0.5)); pts.push([Math.cos(a) * rr, Math.sin(a) * rr]); }
      outline.push(pts);
    }
    const lobeType = r() < 0.5 ? 'crescent' : 'drop', bandType = r() < 0.6 ? 'teeth' : 'diamond', fat = 0.45 + r() * 0.3, smallType = r() < 0.5 ? 'petal' : 'dot';
    // 外圈：每个花边里一道月牙（或水滴）+ 尖角处一个小圆点
    for (let k = 0; k < 16; k++) {
      const a = (k + 0.5) * TAU / 16;
      if (lobeType === 'crescent') holes.push(tr(SH.crescent(R * 0.075, R * 0.045), Math.cos(a) * R * 0.795, Math.sin(a) * R * 0.795, a + Math.PI));
      else holes.push(tr(SH.petal(R * 0.15, R * 0.075, 0.5), Math.cos(a) * R * 0.86, Math.sin(a) * R * 0.86, a + Math.PI));
      const b = k * TAU / 16;
      holes.push(tr(SH.circle(R * 0.017, 10), Math.cos(b) * R * 0.83, Math.sin(b) * R * 0.83));
    }
    // 锯齿带
    for (let k = 0; k < 32; k++) {
      const a = (k + 0.5) * TAU / 32;
      if (bandType === 'teeth') holes.push(tr(SH.tooth(R * 0.07, R * 0.12), Math.cos(a) * R * 0.6, Math.sin(a) * R * 0.6, a));
      else holes.push(tr(SH.diamond(R * 0.1, R * 0.05), Math.cos(a) * R * 0.66, Math.sin(a) * R * 0.66, a));
    }
    // 断开的圆缝（留 16 道连桥）
    for (let k = 0; k < 16; k++) {
      const a0 = k * TAU / 16 + 0.06, a1 = (k + 1) * TAU / 16 - 0.06, pts = [];
      for (let i = 0; i <= 8; i++) { const a = lerp(a0, a1, i / 8); pts.push([Math.cos(a) * R * 0.565, Math.sin(a) * R * 0.565]); }
      slits.push({ pts, w: R * 0.014 });
    }
    // 花瓣圈：8 片大瓣（瓣里补一道纸叶脉）+ 8 片小瓣
    for (let k = 0; k < 8; k++) {
      const a = k * TAU / 8;
      holes.push(tr(SH.petal(R * 0.31, R * 0.15, fat), Math.cos(a) * R * 0.21, Math.sin(a) * R * 0.21, a));
      paper.push({ pts: [[Math.cos(a) * R * 0.19, Math.sin(a) * R * 0.19], [Math.cos(a) * R * 0.43, Math.sin(a) * R * 0.43]], w: R * 0.022 });
      const b = (k + 0.5) * TAU / 8;
      if (smallType === 'petal') holes.push(tr(SH.petal(R * 0.2, R * 0.07, 0.6), Math.cos(b) * R * 0.3, Math.sin(b) * R * 0.3, b));
      else holes.push(tr(SH.circle(R * 0.035), Math.cos(b) * R * 0.42, Math.sin(b) * R * 0.42));
    }
    // 内圈小圆点 + 花心八瓣
    for (let k = 0; k < 16; k++) { const a = (k + 0.5) * TAU / 16; holes.push(tr(SH.circle(R * 0.018, 10), Math.cos(a) * R * 0.155, Math.sin(a) * R * 0.155)); }
    for (let k = 0; k < 8; k++) { const a = k * TAU / 8; holes.push(tr(SH.petal(R * 0.085, R * 0.04, 0.5), Math.cos(a) * R * 0.035, Math.sin(a) * R * 0.035, a)); }
    return { outline, holes, slits, paper };
  }

  /** 方形窗花（D4）：半边长 a；四边锯齿口、断开的回字缝、四角如意云、四边水滴、中间一朵团花 */
  function squareFlower(a, seed = 1) {
    const r = S.rng(seed * 31 + 5), holes = [], slits = [], paper = [];
    const N = 13 + 2 * Math.floor(r() * 3), td = a * 0.045, edge = [];
    for (let i = 0; i < N; i++) { const x0 = -a + 2 * a * i / N, x1 = -a + 2 * a * (i + 1) / N; edge.push([x0, -a], [(x0 + x1) / 2, -a + td]); }
    const outline = [[0, 1, 2, 3].flatMap(k => tr(edge, 0, 0, k * Math.PI / 2))];
    // 回字缝：每边两段，角上和正中留连桥
    const b = a * 0.86, gc = a * 0.07, gm = a * 0.05;
    for (let k = 0; k < 4; k++) {
      slits.push({ pts: tr([[-b + gc, -b], [-gm, -b]], 0, 0, k * Math.PI / 2), w: a * 0.016 });
      slits.push({ pts: tr([[gm, -b], [b - gc, -b]], 0, 0, k * Math.PI / 2), w: a * 0.016 });
    }
    const corner = r() < 0.6 ? 'cloud' : 'fan', mid = r() < 0.5 ? 'drop' : 'crescent';
    for (let k = 0; k < 4; k++) {
      const ang = Math.PI / 4 + k * Math.PI / 2, cx = Math.cos(ang) * a * 0.64 * Math.SQRT2, cy = Math.sin(ang) * a * 0.64 * Math.SQRT2;
      if (corner === 'cloud') { const m = moveMotif(motifs.cloud(a * 0.34), cx, cy, ang + Math.PI); holes.push(...m.holes); paper.push(...m.paper); }
      else for (const d of [-0.42, 0, 0.42]) holes.push(tr(SH.petal(a * 0.26, a * 0.08, 0.55), Math.cos(ang) * a * 1.08, Math.sin(ang) * a * 1.08, ang + Math.PI + d));
      const m2 = k * Math.PI / 2;
      if (mid === 'drop') holes.push(tr(SH.petal(a * 0.22, a * 0.1, 0.55), Math.cos(m2) * a * 0.79, Math.sin(m2) * a * 0.79, m2 + Math.PI));
      else holes.push(tr(SH.crescent(a * 0.09, a * 0.05), Math.cos(m2) * a * 0.7, Math.sin(m2) * a * 0.7, m2));
      for (const s of [-1, 1]) holes.push(tr(SH.circle(a * 0.022, 10), Math.cos(m2) * a * 0.74 - Math.sin(m2) * a * 0.14 * s, Math.sin(m2) * a * 0.74 + Math.cos(m2) * a * 0.14 * s));
      holes.push(tr(SH.diamond(a * 0.09, a * 0.05), Math.cos(ang) * a * 0.64, Math.sin(ang) * a * 0.64, ang));
    }
    // 中间团花
    for (let k = 0; k < 24; k++) { const ang = (k + 0.5) * TAU / 24; holes.push(tr(SH.tooth(a * 0.06, a * 0.1), Math.cos(ang) * a * 0.4, Math.sin(ang) * a * 0.4, ang)); }
    for (let k = 0; k < 8; k++) {
      const a0 = k * TAU / 8 + 0.07, a1 = (k + 1) * TAU / 8 - 0.07, pts = [];
      for (let i = 0; i <= 10; i++) { const ang = lerp(a0, a1, i / 10); pts.push([Math.cos(ang) * a * 0.54, Math.sin(ang) * a * 0.54]); }
      slits.push({ pts, w: a * 0.014 });
    }
    const fat = 0.45 + r() * 0.25;
    for (let k = 0; k < 8; k++) {
      const ang = k * TAU / 8;
      holes.push(tr(SH.petal(a * 0.26, a * 0.11, fat), Math.cos(ang) * a * 0.1, Math.sin(ang) * a * 0.1, ang));
      paper.push({ pts: [[Math.cos(ang) * a * 0.09, Math.sin(ang) * a * 0.09], [Math.cos(ang) * a * 0.28, Math.sin(ang) * a * 0.28]], w: a * 0.016 });
      const b2 = (k + 0.5) * TAU / 8;
      holes.push(tr(SH.circle(a * 0.024, 10), Math.cos(b2) * a * 0.3, Math.sin(b2) * a * 0.3));
    }
    for (let k = 0; k < 8; k++) { const ang = k * TAU / 8; holes.push(tr(SH.petal(a * 0.05, a * 0.026, 0.5), Math.cos(ang) * a * 0.018, Math.sin(ang) * a * 0.018, ang)); }
    return { outline, holes, slits, paper };
  }

  /** 剪刀：(x, y) 是刀口剪到的位置，ang 是前进方向，open 0～1 是张开程度，size 是全长 */
  function drawScissors(x, cx, cy, ang, open, size) {
    const s = size, d = 0.06 + 0.2 * clamp(open);
    x.save(); x.translate(cx, cy); x.rotate(ang); x.translate(-s * 0.22, 0);
    const body = (side, shadow) => {
      x.save(); x.rotate(side * d);
      x.beginPath(); x.moveTo(-s * 0.02, -side * s * 0.03); x.lineTo(s * 0.62, -side * s * 0.004); x.lineTo(s * 0.6, side * s * 0.008); x.lineTo(0, side * s * 0.03); x.closePath();
      x.fillStyle = shadow || '#BDB8B1'; x.fill();
      if (!shadow) { x.strokeStyle = '#EFEBE4'; x.lineWidth = s * 0.006; x.beginPath(); x.moveTo(s * 0.04, -side * s * 0.012); x.lineTo(s * 0.55, -side * s * 0.003); x.stroke(); }
      x.beginPath(); x.moveTo(0, side * s * 0.02); x.lineTo(-s * 0.17, side * s * 0.1);
      x.strokeStyle = shadow || '#2A201C'; x.lineWidth = s * 0.035; x.lineCap = 'round'; x.stroke();
      x.beginPath(); x.ellipse(-s * 0.27, side * s * 0.12, s * 0.1, s * 0.07, side * 0.25, 0, TAU);
      x.lineWidth = s * 0.04; x.stroke();
      x.restore();
    };
    x.save(); x.translate(U * 0.5, U * 0.7); body(1, 'rgba(10,4,0,0.28)'); body(-1, 'rgba(10,4,0,0.28)'); x.restore();
    body(1); body(-1);
    x.beginPath(); x.arc(0, 0, s * 0.022, 0, TAU); x.fillStyle = '#8F8780'; x.fill();
    x.restore();
  }

  // 扇形（团花折叠用）：从原点出发、角度 a0～a1、半径 rr 的扇形 Path2D
  const sectorPath = (a0, a1, rr) => { const p = new Path2D(); p.moveTo(0, 0); const n = Math.max(6, Math.ceil((a1 - a0) / 0.05)); for (let i = 0; i <= n; i++) { const a = lerp(a0, a1, i / n); p.lineTo(Math.cos(a) * rr, Math.sin(a) * rr); } p.closePath(); return p; };
  /** 一片"折过去的纸"：沿过原点、角度为 la 的折线，把 clip 区域按 c 压扁（c=1 平铺原位，c=-1 完全翻到另一面） */
  function flapDraw(st, spr, tf, la, c, clip, o = {}) {
    const x = st.ctx, cc = Math.abs(c) < 0.02 ? 0.02 * Math.sign(c || 1) : c, lift = Math.sqrt(1 - Math.min(1, c * c));
    const tone = c >= 0 ? (o.tone || spr.tone) : (o.back || spr.back || C.back);
    const apply = (dx, dy) => { st.at(x, tf, dx, dy); x.rotate(la); x.scale(1, cc); x.rotate(-la); x.clip(clip); };
    x.save(); apply(U * (0.25 + 1.4 * lift), U * (0.35 + 1.8 * lift)); x.globalAlpha = (o.alpha ?? 1) * st.G.shadowA * (1 - 0.4 * lift); img(x, spr, V(spr, 'shadow:' + st.G.shadow)); x.restore();
    x.save(); apply(0, 0); x.globalAlpha = o.alpha ?? 1; img(x, spr, V(spr, 'tone:' + tone));
    const dark = (1 - Math.abs(c)) * 0.5; if (dark > 0.01) { x.globalAlpha = dark * (o.alpha ?? 1); img(x, spr, V(spr, 'flat:#1a0503')); }
    x.restore();
  }

  // ---------------------------------------------------------------------------------------------
  /** 团花：圆形八瓣窗花，入场是"一折一折展开"（从 1/16 的楔形展开 4 次）。
   *  opts: x, y, r（半径，默认 18u）, seed（换花样）, tone（默认中国红）, depth, rot（起始角度，默认让楔形朝上）
   *  draw(p, { glow, spin, dim, alpha, scale })：p 0～1：前 12% 楔形贴下来，12%～88% 展开四次，最后一下暖闪；
   *    glow 0～1 背光点灯（孔里透光、外面一圈光晕）；spin 额外旋转（弧度）。p 请用 PC.seg（12fps 步进） */
  function flower(st, o = {}) {
    const R = o.r || U * 18, x0 = o.x ?? W / 2, y0 = o.y ?? H / 2, seed = o.seed || 1;
    const pat = roundFlower(R, seed);
    const spr = bake({ ...pat, tone: o.tone || C.red, back: C.back, wob: U * 0.05, seed, k: o.k || 1.5 });
    const rot0 = o.rot ?? (-Math.PI / 2 - Math.PI / 16);
    const sectors = [0, 1, 2, 3, 4].map(j => sectorPath(-0.002, Math.PI / 8 * Math.pow(2, j) + 0.002, R * 1.25));
    const flaps = [0, 1, 2, 3].map(j => sectorPath(Math.PI / 8 * Math.pow(2, j) - 0.002, Math.PI / 8 * Math.pow(2, j + 1) + 0.002, R * 1.25));
    return {
      spr, r: R, x: x0, y: y0,
      draw(p, d = {}) {
        if (p <= 0) return;
        const tf = { x: x0, y: y0, r: rot0 + (d.spin || 0), s: d.scale ?? 1, depth: o.depth || 0 };
        const a = d.alpha ?? 1;
        if (p < 0.12) {
          const e = enterState('paste', p / 0.12);
          for (let i = 3; i >= 1; i--) paint(st, spr, { ...tf, x: x0 + U * 0.12 * i, y: y0 + e.dy + U * 0.16 * i }, { alpha: a, tone: C.deep, clip: c => c.clip(sectors[0]), shadow: i === 3 });
          paint(st, spr, { ...tf, y: y0 + e.dy, r: tf.r + e.r }, { alpha: a * e.alpha, lift: e.lift, clip: c => c.clip(sectors[0]), shadow: false });
          return;
        }
        if (p < 0.88) {
          const u = (p - 0.12) / 0.76 * 4, j = Math.min(3, Math.floor(u)), f = ease.out(clamp((u - j) / 0.8));
          const layers = Math.min(3, 4 - j);
          for (let i = layers; i >= 1; i--) paint(st, spr, { ...tf, x: x0 + U * 0.1 * i, y: y0 + U * 0.13 * i }, { alpha: a, tone: C.deep, clip: c => c.clip(sectors[j]), shadow: i === layers });
          paint(st, spr, tf, { alpha: a, clip: c => c.clip(sectors[j]), shadow: false });
          flapDraw(st, spr, tf, Math.PI / 8 * Math.pow(2, j), -Math.cos(Math.PI * f), flaps[j], { alpha: a });
          return;
        }
        const q = clamp((p - 0.88) / 0.12), pop = 1 + 0.035 * Math.sin(q * Math.PI);
        paint(st, spr, { ...tf, s: tf.s * pop }, { alpha: a, glow: d.glow, dim: d.dim });
        if (q < 1 && !(d.glow > 0)) { const xx = st.ctx; xx.save(); st.at(xx, { ...tf, s: tf.s * pop }); xx.globalCompositeOperation = 'lighter'; xx.globalAlpha = 0.2 * (1 - q); img(xx, spr, V(spr, 'flat:#ff9a3c')); xx.restore(); }
      },
    };
  }

  /** 折→剪→展（讲剪纸原理的招牌镜头）：一张方纸对折三次成 1/8 的三角，剪刀沿着走一圈剪出纹样，再一折一折展开成方形窗花。
   *  opts: x, y（纸的中心）, size（展开后的边长，默认 40u）, seed（换花样）, tone
   *  set(t, { fold: [起, 止], cut: [起, 止], unfold: [起, 止] })：三个阶段的时间（秒）。建议折 1.5 秒、剪 1.8 秒以上、展 1.3 秒。
   *  剪的时候每剪开一个孔，就掉下一片和孔形状一样的纸屑；三折以后纸会放大居中，方便看清剪的过程。 */
  function foldcut(st, o = {}) {
    const a = (o.size || U * 40) / 2, x0 = o.x ?? W / 2, y0 = o.y ?? H / 2, seed = o.seed || 2;
    const pat = squareFlower(a, seed);
    const k = o.k || 2;
    const cut = bake({ ...pat, tone: o.tone || C.red, back: C.back, wob: U * 0.04, seed, k, pad: U * 3 });
    const plain = bake({ outline: [SH.rect(a * 2, a * 2)], tone: o.tone || C.red, back: C.back, wob: U * 0.04, seed, k, frame: cut });
    const A = a * 1.5;
    const P = pts => toPath([pts]);
    const regions = [P([[-A, -A], [A, -A], [A, A], [-A, A]]), P([[-A, 0], [A, 0], [A, A], [-A, A]]), P([[0, 0], [A, 0], [A, A], [0, A]]), P([[0, 0], [A, 0], [A, A]])];
    const flapRegions = [P([[-A, -A], [A, -A], [A, 0], [-A, 0]]), P([[-A, 0], [0, 0], [0, A], [-A, A]]), P([[0, 0], [A, A], [0, A]])];
    const lines = [0, Math.PI / 2, Math.PI / 4];
    // 每一级折叠后的取景（放大、居中）
    const views = [{ s: 1, cx: 0, cy: 0 }, { s: 1.05, cx: 0, cy: a * 0.5 }, { s: 1.6, cx: a * 0.5, cy: a * 0.5 }, { s: 1.72, cx: a * 0.58, cy: a * 0.4 }];
    const viewAt = F => { const i = Math.min(2, Math.floor(F)), q = ease.inOut(clamp(F - i)); const A0 = views[i], B = views[i + 1]; return { s: lerp(A0.s, B.s, q), cx: lerp(A0.cx, B.cx, q), cy: lerp(A0.cy, B.cy, q) }; };
    // 剪的路线：先沿外边剪出锯齿口，再按就近原则逐个剪孔
    const inWedge = ([px, py]) => py >= -a * 0.03 && py <= px + a * 0.03 && px >= -a * 0.03;
    const stops = cut.holePolys.map(poly => ({ poly, c: centroid(poly) })).filter(h => inWedge(h.c)).map(h => ({ ...h, rad: Math.max(...h.poly.map(p => Math.hypot(p[0] - h.c[0], p[1] - h.c[1]))) + a * 0.03 }));
    const route = [[a * 1.12, a * 0.02]];
    for (let i = 0; i <= 10; i++) route.push([a * 0.985, a * 0.02 + i / 10 * a * 0.94]);
    const edgeN = route.length;
    let cur = route[route.length - 1];
    const left = stops.slice(), order = [];
    while (left.length) { let bi = 0, bd = Infinity; left.forEach((h, i) => { const dd = Math.hypot(h.c[0] - cur[0], h.c[1] - cur[1]); if (dd < bd) { bd = dd; bi = i; } }); const h = left.splice(bi, 1)[0]; order.push(h); route.push(h.c); cur = h.c; }
    route.push([a * 1.2, a * 0.35]);
    const cum = [0]; for (let i = 1; i < route.length; i++) cum.push(cum[i - 1] + Math.hypot(route[i][0] - route[i - 1][0], route[i][1] - route[i - 1][1]));
    const L = cum[cum.length - 1];
    order.forEach((h, i) => { h.at = cum[edgeN + i] / L; });
    const edgeAt = i => cum[i] / L;
    const pointAt = q => { const d = clamp(q) * L; let i = 1; while (i < cum.length - 1 && cum[i] < d) i++; const u = (d - cum[i - 1]) / Math.max(1e-6, cum[i] - cum[i - 1]); return { p: [lerp(route[i - 1][0], route[i][0], u), lerp(route[i - 1][1], route[i][1], u)], ang: Math.atan2(route[i][1] - route[i - 1][1], route[i][0] - route[i - 1][0]) }; };
    const outsideCut = (() => { const p = new Path2D(); p.rect(-A, -A, A * 2, A * 2); p.addPath(cut.outline); return p; })();
    const mixed = canvas(cut.cw, cut.ch), mx = mixed.getContext('2d'), mixedDeep = canvas(cut.cw, cut.ch), md = mixedDeep.getContext('2d');
    const mixedSpr = { ...cut, cache: {} };
    function compose(q) {
      // 剪到一半的纸：没剪过的地方是素纸，剪过的地方换成剪好的纸
      const mk = new Path2D();
      for (let i = 0; i < edgeN; i++) if (edgeAt(i) <= q) { const [px, py] = route[i]; mk.moveTo(px + a * 0.09, py); mk.arc(px, py, a * 0.09, 0, TAU); }
      if (q > 0) { const tip = pointAt(Math.min(q, edgeAt(edgeN - 1))).p; mk.moveTo(tip[0] + a * 0.09, tip[1]); mk.arc(tip[0], tip[1], a * 0.09, 0, TAU); }
      for (const h of order) if (h.at <= q) { mk.moveTo(h.c[0] + h.rad, h.c[1]); mk.arc(h.c[0], h.c[1], h.rad, 0, TAU); }
      mx.setTransform(1, 0, 0, 1, 0, 0); mx.globalCompositeOperation = 'source-over'; mx.clearRect(0, 0, cut.cw, cut.ch);
      mx.drawImage(V(plain, 'tone:' + plain.tone), 0, 0);
      mx.setTransform(cut.k, 0, 0, cut.k, -cut.x0 * cut.k, -cut.y0 * cut.k);
      mx.globalCompositeOperation = 'destination-out'; mx.fill(mk);
      mx.globalCompositeOperation = 'source-over';
      mx.save(); mx.clip(mk); mx.setTransform(1, 0, 0, 1, 0, 0); mx.drawImage(V(cut, 'tone:' + cut.tone), 0, 0); mx.restore();
      // 叠在下面的几层纸也是剪到一半的样子（不然锯齿口里会露出没剪的纸）
      md.setTransform(1, 0, 0, 1, 0, 0); md.globalCompositeOperation = 'source-over'; md.clearRect(0, 0, cut.cw, cut.ch);
      md.drawImage(mixed, 0, 0); md.globalCompositeOperation = 'source-atop'; md.globalAlpha = 0.55; md.fillStyle = C.far; md.fillRect(0, 0, cut.cw, cut.ch); md.globalAlpha = 1;
      mixedSpr.cache = { ['tone:' + cut.tone]: mixed, ['tone:' + C.deep]: mixedDeep, ['shadow:' + st.G.shadow]: V(plain, 'shadow:' + st.G.shadow), 'flat:#1a0503': V(plain, 'flat:#1a0503'), ['tone:' + C.back]: V(plain, 'tone:' + C.back) };
      return mixedSpr;
    }
    const offcut = (h, tf, tau) => {
      // 掉下来的纸屑：形状就是这个孔
      if (tau < 0 || tau > 1.6) return;
      const x = st.ctx, [sx, sy] = [tf.x + (h.c[0] - tf.cx) * tf.s, tf.y + (h.c[1] - tf.cy) * tf.s];
      const fall = U * 34 * tau * tau + U * 3 * tau, sway = Math.sin(tau * 7 + h.c[0]) * U * 1.5;
      x.save(); st.at(x, { x: sx + sway, y: sy + fall }); x.rotate(tau * 3 * (h.c[1] > h.c[0] * 0.5 ? 1 : -1)); x.scale(tf.s * Math.cos(tau * 5), tf.s);
      x.translate(-h.c[0], -h.c[1]);
      x.globalAlpha = clamp(1.6 - tau); x.fillStyle = Math.cos(tau * 5) > 0 ? C.red : C.back; x.fill(toPath([h.poly])); x.restore();
    };
    return {
      size: a * 2,
      set(t, tl = {}) {
        const fo = tl.fold || [0.5, 2], cu = tl.cut || [2.4, 4.4], un = tl.unfold || [4.8, 6.2];
        const fd = (fo[1] - fo[0]) / 3, ud = (un[1] - un[0]) / 3, ts = step(t);
        let level = 0, flap = null, F = 0;
        for (let j = 0; j < 3; j++) { const q = clamp((ts - fo[0] - j * fd) / (fd * 0.75)); if (q >= 1) { level = j + 1; F = j + 1; } else if (q > 0) { flap = { j, c: Math.cos(Math.PI * ease.inOut(q)) }; F = j + ease.inOut(q); break; } }
        if (ts >= un[0]) {
          for (let j = 0; j < 3; j++) { const q = clamp((ts - un[0] - j * ud) / (ud * 0.75)), jj = 2 - j; if (q >= 1) { level = jj; F = jj; flap = null; } else if (q > 0) { level = jj + 1; flap = { j: jj, c: -Math.cos(Math.PI * ease.out(q)) }; F = jj + 1 - ease.out(q); break; } }
        }
        const v = viewAt(F), tf = { x: x0, y: y0, s: v.s, cx: v.cx, cy: v.cy };
        const tfDraw = { x: x0 - v.cx * v.s, y: y0 - v.cy * v.s, s: v.s, depth: o.depth || 0 };
        const cq = clamp((t - cu[0]) / (cu[1] - cu[0]));
        const sp = ts < cu[0] ? plain : ts >= cu[1] ? cut : compose(cq);
        const baseLevel = flap ? flap.j : level;
        const layers = Math.min(3, baseLevel);
        for (let i = layers; i >= 1; i--) paint(st, sp, { ...tfDraw, x: tfDraw.x + U * 0.1 * i, y: tfDraw.y + U * 0.13 * i }, { tone: C.deep, clip: c => c.clip(regions[baseLevel]), shadow: i === layers });
        const unfoldDone = ts >= un[1] - 1e-6;
        const done = clamp((t - un[1]) / 0.35), pop = unfoldDone ? 1 + 0.03 * Math.sin(done * Math.PI) : 1;
        if (flap) {
          paint(st, sp, tfDraw, { clip: c => c.clip(regions[flap.j + 1]), shadow: layers === 0 });
          flapDraw(st, sp, tfDraw, lines[flap.j], flap.c, flapRegions[flap.j]);
        } else {
          paint(st, sp, { ...tfDraw, s: tfDraw.s * pop, x: x0 - v.cx * v.s * pop, y: y0 - v.cy * v.s * pop }, { clip: c => c.clip(regions[level]), shadow: layers === 0 });
          if (unfoldDone && done < 1) { const xx = st.ctx; xx.save(); st.at(xx, { ...tfDraw, s: tfDraw.s * pop }); xx.clip(regions[0]); xx.globalCompositeOperation = 'lighter'; xx.globalAlpha = 0.16 * (1 - done); img(xx, sp, V(sp, 'flat:#ff9a3c')); xx.restore(); }
        }
        // 纸屑和剪刀
        if (t >= cu[0]) for (const h of order) offcut(h, tf, t - (cu[0] + h.at * (cu[1] - cu[0])));
        const inA = clamp((t - (cu[0] - 0.35)) / 0.35), outA = clamp((t - cu[1]) / 0.4);
        if (inA > 0 && outA < 1) {
          const { p: lp, ang } = pointAt(cq);
          let sx = tfDraw.x + lp[0] * v.s, sy = tfDraw.y + lp[1] * v.s;
          sx += (1 - ease.out(inA)) * U * 30 + ease.in(outA) * U * 34; sy -= (1 - ease.out(inA)) * U * 8;
          const xx = st.ctx; xx.save(); st.at(xx, {});
          drawScissors(xx, sx, sy, ang, (cq > 0 && cq < 1) ? ((Math.floor(t * 8) % 2) ? 1 : 0.15) : 0.6, U * 16);
          xx.restore();
        }
      },
    };
  }

  // ---------------------------------------------------------------------------------------------
  /** 任意形状的纸片（礼盒、鱼、山、云……用 PC.shape 的基本形拼出来）。
   *  opts: x, y（纸片原点在画面上的位置）, shape（外轮廓：多边形数组，局部坐标，原点为中心）,
   *        holes（镂空，多边形数组）, slits（缝 [{pts, w}]）, paper（补回的纸条 [{pts, w}]）,
   *        motif（纹样对象 {holes, slits, paper}，见 PC.motif）, inset（阴线 {d, w, dash}，true 用默认值）,
   *        tone（纸色，默认中国红；金箔 PC.C.gold 全片只用一次）, enter（'paste'|'pop'|'rise'|'stamp'|'none'）,
   *        depth（0 主纸面，正数更远：视差更小）, rot, scale, shadow（默认 true）, wobble（刀口抖动幅度）
   *  draw(p, { dx, dy, rot, scale, alpha, lift, glow, dim, sheen })：p 入场进度；sheen 0～1 金箔反光扫过 */
  function piece(st, o) {
    const m = o.motif || {};
    const inset = o.inset === true ? { d: U * 0.55, w: U * 0.22, dash: [U * 5, U * 0.6] } : o.inset;
    const spr = bake({ outline: o.shape, holes: [...(o.holes || []), ...(m.holes || [])], slits: [...(o.slits || []), ...(m.slits || [])],
      paper: [...(o.paper || []), ...(m.paper || [])], inset, tone: o.tone || C.red, back: o.back, wob: o.wobble ?? U * 0.06, seed: o.seed || 1 });
    const bx = o.x || 0, by = o.y || 0;
    return {
      spr,
      draw(p = 1, d = {}) {
        const e = enterState(o.enter || 'paste', p, o);
        if (!e) return;
        paint(st, spr, { x: bx + e.dx + (d.dx || 0), y: by + e.dy + (d.dy || 0), r: (o.rot || 0) + e.r + (d.rot || 0), s: (o.scale || 1) * e.s * (d.scale ?? 1), depth: o.depth || 0 },
          { alpha: e.alpha * (d.alpha ?? 1), lift: Math.max(e.lift, d.lift || 0), glow: d.glow, dim: d.dim, sheen: d.sheen, shadow: o.shadow });
        return e;
      },
    };
  }

  /** 灯笼：鼓形红纸 + 竖向镂空肋 + 深红上下盖 + 流苏，挂在一根线上，按 12fps 轻轻摇。
   *  opts: x, y（灯身中心）, r（灯身半宽，默认 5u）, anchor（线的顶端 y，默认画面上沿外）, seed, tone, depth, sway（摆幅，弧度）,
   *        pool（点亮时在这个 y 处的地面上铺一摊暖光；灯笼挂在半空时不要设）
   *  draw(p, { glow, dim })：p 是从上面垂下来的进度（带一点回弹）；glow 0～1 点亮（孔里透光、地上一摊暖光） */
  function lantern(st, o = {}) {
    const r = o.r || U * 5, ry = r * 0.82, x0 = o.x ?? W / 2, y0 = o.y ?? H * 0.3, top = o.anchor ?? -U * 2, seed = o.seed || 1;
    const ribs = [];
    for (const xr of [-0.62, -0.31, 0, 0.31, 0.62]) {
      const hgt = 2 * ry * Math.pow(1 - Math.pow(Math.abs(xr), 2.6), 1 / 2.6) * 0.8;
      ribs.push(tr(SH.lens(hgt, r * (xr === 0 ? 0.1 : 0.075)), xr * r, 0, Math.PI / 2));
    }
    const body = bake({ outline: [SH.blob(r, ry, 2.6)], holes: ribs, inset: { d: r * 0.07, w: r * 0.03, dash: [r * 0.9, r * 0.12] }, tone: o.tone || C.red, wob: U * 0.04, seed });
    const capPolys = [tr(SH.rrect(r * 0.9, r * 0.22, r * 0.05), 0, -ry - r * 0.04), tr(SH.rrect(r * 0.9, r * 0.22, r * 0.05), 0, ry + r * 0.04)];
    const capHoles = [-0.25, 0, 0.25].flatMap(xx => [tr(SH.circle(r * 0.035, 10), xx * r, -ry - r * 0.04), tr(SH.circle(r * 0.035, 10), xx * r, ry + r * 0.04)]);
    const caps = bake({ outline: capPolys, holes: capHoles, tone: C.deep, wob: U * 0.03, seed: seed + 1 });
    const fr = [], ft = ry + r * 0.42, fb = ry + r * 1.5, n = 7;
    fr.push([-r * 0.16, ft]); fr.push([r * 0.16, ft]);
    for (let i = n; i >= 0; i--) { const xx = lerp(-r * 0.3, r * 0.3, i / n); fr.push([xx, fb - (i % 2 ? 0 : r * 0.14)]); }
    const tassel = bake({ outline: [fr, tr(SH.diamond(r * 0.32, r * 0.3), 0, ry + r * 0.3)], slits: [-0.14, 0, 0.14].map(xx => ({ pts: [[xx * r, ft + r * 0.15], [xx * r * 1.6, fb - r * 0.25]], w: r * 0.035 })), tone: o.tone || C.red, wob: U * 0.03, seed: seed + 2 });
    const amp = o.sway ?? 0.035;
    return {
      draw(p = 1, d = {}) {
        if (p <= 0) return;
        const e = ease.back(clamp(p)), drop = (1 - e) * (y0 - top + ry * 2);
        const ang = amp * S.noise(seed * 3 + 1, step(st.t) * 0.9) + (1 - clamp(p)) * 0.1;
        const yy = y0 - drop, len = yy - top, g = d.glow || 0, x = st.ctx;
        // 线
        x.save(); st.at(x, { x: x0, y: top, r: ang, depth: o.depth || 0 });
        x.strokeStyle = st.G.line; x.lineWidth = U * 0.16; x.beginPath(); x.moveTo(0, 0); x.lineTo(0, len - ry - r * 0.12); x.stroke(); x.restore();
        const tf = { x: x0 + Math.sin(ang) * len, y: top + Math.cos(ang) * len, r: ang, depth: o.depth || 0 };
        if (g > 0 && o.pool) st.pool(x0, o.pool, r * 5, g * 0.7, o.depth || 0);
        paint(st, tassel, tf, { glow: g * 0.3, dim: d.dim });
        paint(st, body, tf, { glow: g, dim: d.dim });
        paint(st, caps, tf, { dim: d.dim });
        if (g > 0) {
          x.save(); st.at(x, tf); x.globalCompositeOperation = 'lighter';
          const rg = x.createRadialGradient(0, 0, 0, 0, 0, r * 2.6);
          rg.addColorStop(0, rgba(C.lamp, 0.32 * g)); rg.addColorStop(1, rgba(C.lamp, 0));
          x.fillStyle = rg; x.fillRect(-r * 3, -r * 3, r * 6, r * 6); x.restore();
        }
      },
    };
  }

  /** 远山（地纸同族的浅一档或深一档）：顶上一排锯齿（草），山体里一行行月牙（水纹、鳞纹）。
   *  opts: y（山脊平均高度）, amp（起伏，默认 7% 画高）, tone（默认地纸族的远景色，far: 0 或 1 选一档）, depth（默认 0.6）, seed, teeth（默认 true）
   *  draw(p)：p 从下往上升起（用 PC.seg） */
  function hills(st, o = {}) {
    const y0 = o.y ?? H * 0.74, amp = o.amp ?? H * 0.07, seed = o.seed || 3, tone = o.tone || st.G.far[o.far || 0];
    const xa = -W * 0.18, xb = W * 1.18, ridge = [], stepX = U * 1.1;
    for (let xx = xa, i = 0; xx <= xb; xx += stepX, i++) {
      const yr = y0 - amp * (0.5 + 0.5 * S.noise(seed, xx / (W * 0.16))) - amp * 0.35 * S.noise(seed + 9, xx / (W * 0.06));
      ridge.push([xx, yr - (o.teeth === false ? 0 : (i % 2 ? U * 0.9 : 0))]);
    }
    const poly = [...ridge, [xb, H * 1.15], [xa, H * 1.15]];
    const holes = [], r = S.rng(seed * 11);
    for (let row = 0; row < 12; row++) for (let col = 0; col < 70; col++) {
      const cx = xa + (col + (row % 2) * 0.5) * U * 3.6, cy = y0 - amp * 0.4 + U * 3 + row * U * 2.6;
      const yr = y0 - amp * (0.5 + 0.5 * S.noise(seed, cx / (W * 0.16))) - amp * 0.35 * S.noise(seed + 9, cx / (W * 0.06));
      if (cx > xb - U * 2 || cy < yr + U * 3 || cy > H * 1.05 || r() < 0.35) continue;
      holes.push(tr(SH.crescent(U * 0.9, U * 0.38), cx, cy, -Math.PI / 2));
    }
    const spr = bake({ outline: [poly], holes, tone, wob: U * 0.05, seed, k: 1, pad: U * 2 });
    return {
      draw(p = 1, d = {}) { const e = enterState('rise', p, { rise: amp * 2.4 }); if (!e) return; paint(st, spr, { x: 0, y: e.dy, depth: o.depth ?? 0.6 }, { alpha: e.alpha, dim: d.dim }); },
    };
  }

  /** 纸屑：飘雪（loop，一直下）或撒落（burst，从 at 秒开始从一点散开落下）。纸屑翻面时换成背面色。
   *  opts: n（数量）, mode: 'snow'|'burst', tones（颜色数组）, size（默认 0.9u）, seed, depth,
   *        snow: area {x, y, w, h}、speed（默认 6u/秒）；burst: x, y（撒出点）, at（开始时间）, spread（默认 30u）
   *  draw(a)：a 是整体不透明度（默认 1），位置由 st.t 决定 */
  function scraps(st, o = {}) {
    const n = o.n || 40, r = S.rng((o.seed || 5) * 97), size = o.size || U * 0.9;
    const tones = o.tones || (st.G.night ? [C.cream, C.red] : [C.red, C.deep]);
    const ar = o.area || { x: -W * 0.05, y: -H * 0.1, w: W * 1.1, h: H * 1.2 };
    const items = Array.from({ length: n }, (_, i) => ({ x: r(), y: r(), v: 0.6 + r() * 0.8, f: 0.6 + r() * 1.4, ph: r() * TAU, sp: (r() - 0.5) * 4, fl: 2 + r() * 4,
      sz: size * (0.6 + r() * 0.8), kind: Math.floor(r() * 3), tone: tones[i % tones.length], vx: (r() - 0.5) * 2, vy: -0.4 - r() * 1.2 }));
    const shapes = [SH.rect(1, 1), SH.diamond(1.2, 1.6), [[0, -0.7], [0.7, 0.5], [-0.7, 0.5]]];
    return {
      draw(alpha = 1) {
        const t = st.t, x = st.ctx;
        if (alpha <= 0) return;
        x.save();
        for (const it of items) {
          let px, py, al = alpha;
          if ((o.mode || 'snow') === 'snow') {
            px = ar.x + it.x * ar.w + Math.sin(t * it.f + it.ph) * U * 2;
            py = ar.y + (((it.y * ar.h + t * (o.speed ?? U * 6) * it.v) % ar.h) + ar.h) % ar.h;
          } else {
            const tau = t - (o.at || 0); if (tau < 0) continue;
            const sp = o.spread ?? U * 30;
            px = (o.x ?? W / 2) + it.vx * sp * (1 - Math.exp(-tau * 1.6)) + Math.sin(tau * it.f * 3 + it.ph) * U * 1.2;
            py = (o.y ?? H * 0.3) + it.vy * sp * (1 - Math.exp(-tau * 2.2)) + U * 9 * tau * tau * it.v;
            al *= clamp(2.6 - tau * 0.8);
            if (py > H + U * 4) continue;
          }
          const flip = Math.cos(t * it.fl + it.ph);
          st.at(x, { x: px, y: py, r: t * it.sp + it.ph, s: it.sz, sy: it.sz * (0.25 + 0.75 * Math.abs(flip)), depth: o.depth || 0 });
          x.globalAlpha = al; x.fillStyle = flip >= 0 ? it.tone : mix(it.tone, '#ffffff', 0.25);
          x.beginPath(); shapes[it.kind].forEach((pt, i) => (i ? x.lineTo(pt[0], pt[1]) : x.moveTo(pt[0], pt[1]))); x.closePath(); x.fill();
        }
        x.restore();
      },
    };
  }

  // ---------------------------------------------------------------------------------------------
  // 文字（SVG）：书法字用马善政楷书，正文用思源黑体
  const T = (parent, o) => {
    const e = el('text', { x: o.x, y: o.y, 'font-size': o.size, 'font-family': o.font === 'sans' ? F.sans : F.brush, 'font-weight': o.weight || 400,
      fill: o.fill, 'text-anchor': o.anchor || 'middle', 'letter-spacing': o.spacing || 0 }, parent);
    if (o.filter) e.setAttribute('filter', o.filter);
    e.textContent = o.text;
    return e;
  };
  /** 金箔字的填充：上亮下暗的竖向渐变 */
  function goldFill(st) {
    if (st.__gold) return st.__gold;
    const gid = id('gd'), lg = el('linearGradient', { id: gid, x1: 0, y1: 0, x2: 0, y2: 1 }, st.defs);
    [[0, C.goldHi], [0.45, C.gold], [1, C.goldLo]].forEach(([of, c]) => el('stop', { offset: of, 'stop-color': c }, lg));
    return (st.__gold = `url(#${gid})`);
  }
  /** 金箔反光：一条亮带的渐变（每个元素一份），set(q) 让它从左扫到右 */
  function sheenFill(st, x0, w) {
    const gid = id('sh'), lg = el('linearGradient', { id: gid, gradientUnits: 'userSpaceOnUse', x1: x0 - w, y1: 0, x2: x0, y2: w * 0.4 }, st.defs);
    [[0, 0], [0.5, 0.9], [1, 0]].forEach(([of, a]) => el('stop', { offset: of, 'stop-color': '#FFF8DC', 'stop-opacity': a }, lg));
    return { url: `url(#${gid})`, set(q) { lg.setAttribute('gradientTransform', `translate(${lerp(-0.1, 2.2, clamp(q)) * w} 0)`); } };
  }
  const colorOf = (st, c, fallback) => (c === 'gold' ? goldFill(st) : c === 'paper' ? st.paperFill(fallback) : (c || fallback));

  /** 横批：横向红纸条，两端燕尾，沿边一道断开的阴线，字写在纸上（默认墨色书法）。
   *  opts: x, y（中心）, w（默认 44u）, h（默认 9.5u）, text, size（默认 0.6h）, color（'gold' 金字 | 颜色，默认墨色）, tone（纸色）
   *  draw(p, { dim })：贴上去（悬空 → 落下）。返回 { top, bottom } */
  function banner(st, o) {
    const w = o.w || U * 44, h = o.h || U * 9.5, x0 = o.x ?? W / 2, y0 = o.y ?? S.safe.y + h * 0.7, n = h * 0.3;
    const outline = [[[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2 - n, 0], [w / 2, h / 2], [-w / 2, h / 2], [-w / 2 + n, 0]]];
    const holes = [-1, 1].flatMap(s => [tr(SH.diamond(h * 0.2, h * 0.2), s * (w / 2 - n - h * 0.42), 0)]);
    const spr = bake({ outline, holes, inset: { d: h * 0.1, w: h * 0.03, dash: [h * 1.8, h * 0.14] }, tone: o.tone || C.red, wob: U * 0.05, seed: o.seed || 4 });
    const size = o.size || h * 0.6, g = el('g', { opacity: 0 }, st.world);
    T(g, { x: x0, y: y0 + size * 0.38, size, text: o.text, fill: colorOf(st, o.color, C.ink), spacing: size * 0.22 });
    return {
      top: y0 - h / 2, bottom: y0 + h / 2,
      draw(p, d = {}) {
        const e = enterState('paste', p, { drop: U * 3 });
        g.setAttribute('opacity', e ? e.alpha : 0);
        g.setAttribute('transform', svgTf(x0, y0, e));
        if (!e) return;
        paint(st, spr, { x: x0 + e.dx, y: y0 + e.dy, r: e.r, s: e.s }, { alpha: e.alpha, lift: e.lift, dim: d.dim });
      },
    };
  }

  /** 春联：竖向红纸条，字从上往下一个个露出来（纸像卷轴一样往下展开）。
   *  opts: x（中心）, y（上沿）, text（7 字左右）, w（默认 8.5u）, size（默认 0.64w）, color（默认墨色）, tone
   *  draw(p, { dim })：p 是展开进度（用 PC.seg）。返回 { h, bottom } */
  function couplet(st, o) {
    const chars = Array.from(o.text), n = chars.length, w = o.w || U * 8.5, size = o.size || w * 0.64, pitch = size * 1.12;
    const h = o.h || n * pitch + w * 0.6, x0 = o.x, yTop = o.y ?? S.safe.y + U * 4, cy = yTop + h / 2;
    const spr = bake({ outline: [SH.rect(w, h)], holes: [tr(SH.diamond(w * 0.2, w * 0.2), 0, -h / 2 + w * 0.17), tr(SH.diamond(w * 0.2, w * 0.2), 0, h / 2 - w * 0.17)],
      inset: { d: w * 0.08, w: w * 0.025, dash: [w * 2.2, w * 0.14] }, tone: o.tone || C.red, wob: U * 0.05, seed: o.seed || 6 });
    const g = el('g', {}, st.world), fill = colorOf(st, o.color, C.ink);
    const y0c = yTop + (h - n * pitch) / 2;
    const nodes = chars.map((ch, i) => T(g, { x: x0, y: y0c + pitch * (i + 0.5) + size * 0.38, size, text: ch, fill }));
    return {
      h, bottom: yTop + h,
      draw(p, d = {}) {
        const f = ease.out(clamp(p)), edge = -h / 2 + f * h;
        nodes.forEach((e, i) => e.setAttribute('opacity', p > 0 && y0c + pitch * (i + 0.72) - yTop <= f * h ? 1 : 0));
        if (p <= 0) return;
        paint(st, spr, { x: x0, y: cy }, { dim: d.dim, clip: c => { c.beginPath(); c.rect(-w, -h / 2 - U * 2, w * 2, f * h + U * 2); c.clip(); } });
        if (f < 1) {
          // 还没展开的部分卷成一根纸轴
          const x = st.ctx; x.save(); st.at(x, { x: x0, y: cy + edge });
          const lg = x.createLinearGradient(0, -w * 0.13, 0, w * 0.13);
          lg.addColorStop(0, C.deep); lg.addColorStop(0.45, mix(C.red, '#ffffff', 0.15)); lg.addColorStop(1, C.far);
          x.fillStyle = lg; x.fillRect(-w / 2 - U * 0.3, -w * 0.13, w + U * 0.6, w * 0.26); x.restore();
        }
      },
    };
  }

  /** 福字斗方：菱形红纸，四边锯齿口、四角如意云，正中一个书法字（默认金箔"福"——金箔全片只用一次）。
   *  opts: x, y, size（菱形宽，默认 34u）, char（默认 '福'）, color（'gold' | 墨色等）, tone
   *  draw(p, { glow, sheen, dim })：p 贴上去（落得重一点）；sheen 0～1 金光扫过字面 */
  function fu(st, o = {}) {
    const s = o.size || U * 34, a = s / (2 * Math.SQRT2), x0 = o.x ?? W / 2, y0 = o.y ?? H * 0.45;
    const N = 11, td = a * 0.05, edge = [];
    for (let i = 0; i < N; i++) { const xa = -a + 2 * a * i / N, xb = -a + 2 * a * (i + 1) / N; edge.push([xa, -a], [(xa + xb) / 2, -a + td]); }
    const outline = [[0, 1, 2, 3].flatMap(k => tr(edge, 0, 0, k * Math.PI / 2 + Math.PI / 4))];
    const holes = [], slits = [], paper = [], b = a * 0.84;
    for (let k = 0; k < 4; k++) {
      const rot = k * Math.PI / 2 + Math.PI / 4;
      slits.push({ pts: tr([[-b + a * 0.3, -b], [b - a * 0.3, -b]], 0, 0, rot), w: a * 0.018 });
      const ang = k * Math.PI / 2, m = moveMotif(motifs.cloud(a * 0.3), Math.cos(ang) * a * 1.02, Math.sin(ang) * a * 1.02, ang + Math.PI);
      holes.push(...m.holes); paper.push(...m.paper);
    }
    const spr = bake({ outline, holes, slits, paper, tone: o.tone || C.red, wob: U * 0.05, seed: o.seed || 8 });
    const size = o.charSize || a * 1.3, g = el('g', { opacity: 0 }, st.world);
    const ch = o.char || '福', fill = colorOf(st, o.color || 'gold', C.ink);
    T(g, { x: x0, y: y0 + size * 0.38, size, text: ch, fill });
    const sh = sheenFill(st, x0 - size / 2, size), shine = T(el('g', { 'data-qa': 'ignore' }, g), { x: x0, y: y0 + size * 0.38, size, text: ch, fill: sh.url });
    return {
      draw(p, d = {}) {
        const e = enterState('paste', p, { drop: U * 7, tilt: 0.08 });
        g.setAttribute('opacity', e ? e.alpha : 0);
        g.setAttribute('transform', svgTf(x0, y0, e));
        sh.set(d.sheen ?? 0); shine.setAttribute('opacity', d.sheen > 0 && d.sheen < 1 ? 1 : 0);
        if (!e) return;
        paint(st, spr, { x: x0 + e.dx, y: y0 + e.dy, r: e.r, s: e.s }, { alpha: e.alpha, lift: e.lift, glow: d.glow, dim: d.dim });
      },
    };
  }

  /** 印章：朱红方印，边缘斑驳，字是白文（露出纸色）。opts: x, y, size（默认 7u）, text（1、2 或 4 个字；4 字按右列先读）
   *  draw(p)：盖下去（1.6 倍 → 1 倍） */
  function seal(st, o = {}) {
    const s = o.size || U * 7, x0 = o.x ?? W / 2, y0 = o.y ?? H / 2, chars = Array.from(o.text || '吉祥'), r = S.rng(o.seed || 13);
    const holes = [];
    for (let i = 0; i < 26; i++) { const side = Math.floor(r() * 4), u = r() - 0.5, depth = r() * s * 0.05; const p = [[u * s, -s / 2 + depth], [s / 2 - depth, u * s], [u * s, s / 2 - depth], [-s / 2 + depth, u * s]][side]; holes.push(tr(SH.circle(s * (0.01 + r() * 0.02), 8), p[0], p[1])); }
    const spr = bake({ outline: [SH.rrect(s, s, s * 0.06)], holes, tone: C.seal, wob: U * 0.1, seed: o.seed || 13 });
    const g = el('g', { opacity: 0 }, st.world), fill = st.G.night ? C.cream : st.G.base;
    const n = chars.length, cs = n === 1 ? s * 0.68 : s * 0.42;
    const cells = n === 1 ? [[0, 0]] : n === 2 ? [[0, -0.23], [0, 0.23]] : [[0.23, -0.23], [0.23, 0.23], [-0.23, -0.23], [-0.23, 0.23]];
    chars.slice(0, cells.length).forEach((c, i) => T(g, { x: x0 + cells[i][0] * s, y: y0 + cells[i][1] * s + cs * 0.38, size: cs, text: c, fill }));
    return {
      draw(p, d = {}) {
        const e = enterState('stamp', p);
        g.setAttribute('opacity', e ? e.alpha : 0);
        g.setAttribute('transform', svgTf(x0, y0, e));
        if (!e) return;
        paint(st, spr, { x: x0, y: y0, s: e.s, r: o.rot || 0 }, { alpha: e.alpha, shadow: false, dim: d.dim });
      },
    };
  }

  /** 圆形卖点章：花边圆纸 + 一圈小孔，中间写卖点（"限时 8 折""新品"）。opts: x, y, r（默认 9u）, text, sub, tone, color
   *  draw(p)：转着弹出来 */
  function badge(st, o) {
    const r = o.r || U * 9, x0 = o.x ?? W / 2, y0 = o.y ?? H / 2, pts = [];
    for (let i = 0; i < 480; i++) { const a = i / 480 * TAU, s = Math.abs(Math.sin(8 * a)); const rr = r * (0.92 + 0.08 * Math.pow(s, 0.5)); pts.push([Math.cos(a) * rr, Math.sin(a) * rr]); }
    const holes = [], slits = [];
    for (let k = 0; k < 16; k++) { const a = (k + 0.5) * TAU / 16; holes.push(tr(SH.circle(r * 0.035, 10), Math.cos(a) * r * 0.83, Math.sin(a) * r * 0.83)); }
    for (let k = 0; k < 16; k++) { const a0 = k * TAU / 16 + 0.05, a1 = (k + 1) * TAU / 16 - 0.05, q = []; for (let i = 0; i <= 6; i++) { const a = lerp(a0, a1, i / 6); q.push([Math.cos(a) * r * 0.74, Math.sin(a) * r * 0.74]); } slits.push({ pts: q, w: r * 0.018 }); }
    const spr = bake({ outline: [pts], holes, slits, tone: o.tone || C.red, wob: U * 0.04, seed: o.seed || 9 });
    const g = el('g', { opacity: 0 }, st.world), fill = colorOf(st, o.color, C.cream);
    const ms = o.size || r * (Array.from(o.text).length > 2 ? 0.46 : 0.62), ss = Math.max(U * 2.6, r * 0.2);
    if (o.sub) { T(g, { x: x0, y: y0 - r * 0.2, size: ss, text: o.sub, fill, font: 'sans', weight: 700, spacing: ss * 0.1 }); T(g, { x: x0, y: y0 + r * 0.06 + ms * 0.5, size: ms, text: o.text, fill }); }
    else T(g, { x: x0, y: y0 + ms * 0.38, size: ms, text: o.text, fill });
    return {
      draw(p, d = {}) {
        const e = enterState('pop', p);
        g.setAttribute('opacity', e ? e.alpha : 0);
        g.setAttribute('transform', svgTf(x0, y0, e));
        if (!e) return;
        paint(st, spr, { x: x0, y: y0, r: e.r, s: e.s }, { alpha: e.alpha, lift: e.lift, dim: d.dim });
      },
    };
  }

  /** 窗格边框：红纸框，内沿一圈锯齿，框上一排菱形和圆点孔，四角四瓣花。框里露出地纸，放产品和文案。
   *  opts: x, y（中心）, w, h, band（框宽，默认 3.6u）, tone
   *  返回 { inner: {x, y, w, h}（窗口区域，左上角坐标）, draw(p, { dim }) } */
  function frame(st, o) {
    const w = o.w, h = o.h, b = o.band || U * 3.6, x0 = o.x ?? W / 2, y0 = o.y ?? H / 2, iw = w - b * 2, ih = h - b * 2, td = b * 0.3;
    const hole = [];
    const side = (len, nTeeth) => { const pts = []; for (let i = 0; i < nTeeth; i++) { pts.push([-len / 2 + len * i / nTeeth, 0]); pts.push([-len / 2 + len * (i + 0.5) / nTeeth, td]); } return pts; };
    const nx = Math.max(6, Math.round(iw / (U * 1.8))), ny = Math.max(4, Math.round(ih / (U * 1.8)));
    hole.push(...side(iw, nx).map(([px, py]) => [px, -ih / 2 + py]));
    hole.push(...side(ih, ny).map(([px, py]) => [iw / 2 - py, px]));
    hole.push(...side(iw, nx).map(([px, py]) => [-px, ih / 2 - py]));
    hole.push(...side(ih, ny).map(([px, py]) => [-iw / 2 + py, -px]));
    const holes = [hole];
    for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const cx = sx * (w / 2 - b / 2), cy = sy * (h / 2 - b / 2);
      for (let k = 0; k < 4; k++) holes.push(tr(SH.petal(b * 0.36, b * 0.2, 0.55), cx, cy, k * Math.PI / 2 + Math.PI / 4));
    }
    const dotRow = (x1, y1, x2, y2) => { const L = Math.hypot(x2 - x1, y2 - y1), n = Math.max(2, Math.floor(L / (U * 3.2))); for (let i = 1; i < n; i++) { const q = i / n, px = lerp(x1, x2, q), py = lerp(y1, y2, q); holes.push(i % 2 ? tr(SH.diamond(b * 0.32, b * 0.2), px, py, Math.atan2(y2 - y1, x2 - x1)) : tr(SH.circle(b * 0.06, 10), px, py)); } };
    const ex = w / 2 - b / 2, ey = h / 2 - b / 2;
    dotRow(-ex + b, -ey, ex - b, -ey); dotRow(-ex + b, ey, ex - b, ey); dotRow(-ex, -ey + b, -ex, ey - b); dotRow(ex, -ey + b, ex, ey - b);
    const spr = bake({ outline: [SH.rect(w, h)], holes, inset: { d: b * 0.12, w: b * 0.045, dash: [U * 6, U * 0.6] }, tone: o.tone || C.red, wob: U * 0.05, seed: o.seed || 10 });
    return {
      inner: { x: x0 - iw / 2 + td, y: y0 - ih / 2 + td, w: iw - td * 2, h: ih - td * 2 },
      draw(p, d = {}) { const e = enterState('paste', p, { drop: U * 3, tilt: 0.015 }); if (!e) return; paint(st, spr, { x: x0 + e.dx, y: y0 + e.dy, r: e.r, s: e.s }, { alpha: e.alpha, lift: e.lift, dim: d.dim }); },
    };
  }

  /** 纹样卡：一张方红纸，正中剪一个纹样，下面写名字和寓意。
   *  opts: x, y（纸的中心）, size（默认 20u）, motif（'cloud'|'coin'|'fret'|'plum'|'rosette'）, name, meaning, tone
   *  draw(p, { focus, dim })：focus 0～1 抬起来（被点名的那张），dim 0～1 压暗（其余几张）。返回 { bottom } */
  function tile(st, o) {
    const s = o.size || U * 20, x0 = o.x, y0 = o.y;
    const m = moveMotif(motifs[o.motif || 'cloud'](s * (o.motif === 'fret' ? 0.5 : 0.62)), 0, o.motif === 'cloud' ? -s * 0.06 : 0, o.motif === 'cloud' ? Math.PI / 2 : 0);
    const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => tr(SH.tooth(s * 0.07, s * 0.07), sx * s * 0.39, sy * s * 0.39, Math.atan2(-sy, -sx)));
    const spr = bake({ outline: [SH.rect(s, s)], holes: [...m.holes, ...corners], slits: m.slits, paper: m.paper, inset: { d: s * 0.06, w: s * 0.016, dash: [s * 0.55, s * 0.05] }, tone: o.tone || C.red, wob: U * 0.05, seed: o.seed || 12 });
    const G = st.G, g = el('g', { opacity: 0 }, st.world);
    const ns = o.nameSize || Math.max(U * 4, s * 0.24), ms = o.meaningSize || U * 3.6;
    const nameY = y0 + s / 2 + U * 1.8 + ns * 0.88;
    const nm = o.name ? T(g, { x: x0, y: nameY, size: ns, text: o.name, fill: G.night ? C.cream : C.deep }) : null;
    const mean = o.meaning ? T(g, { x: x0, y: nameY + ns * 0.12 + U * 1 + ms * 1.16, size: ms, text: o.meaning, fill: G.text2, font: 'sans', weight: 500 }) : null;
    return {
      bottom: o.meaning ? nameY + ns * 0.12 + U * 1 + ms * 1.45 : nameY + ns * 0.12,
      draw(p, d = {}) {
        const e = enterState('paste', p, { drop: U * 4 });
        g.setAttribute('opacity', e ? e.alpha * (1 - 0.6 * (d.dim || 0)) : 0);
        const f = clamp(d.focus || 0);
        if (nm) nm.setAttribute('fill', f > 0.5 ? (G.night ? C.goldHi : C.red) : (G.night ? C.cream : C.deep));
        if (!e) return;
        paint(st, spr, { x: x0 + e.dx, y: y0 + e.dy - f * U * 1.2, r: e.r, s: e.s * (1 + 0.05 * f) }, { alpha: e.alpha, lift: Math.max(e.lift, f * 0.6), dim: (d.dim || 0) * 0.7 });
      },
    };
  }

  // ---------------------------------------------------------------------------------------------
  /** 页面标题：书法字，一个字一个字像剪好的纸字贴上去（先悬空、再落定，按 12fps 步进）。
   *  opts: text, sub（副标题，黑体）, size（默认 7u）, align: 'center'（默认）| 'left', color（默认按地纸：米纸上红字，夜纸上米色字）, paper（纸纹，默认 true）
   *        x、y：不填时自动放在安全区上沿以内（页面标题）；填了就当作版面里的大字（y 是基线，left 时 x 是左沿）
   *  返回 { bottom（标题区下沿 y，内容从这里往下排）, draw(p) } */
  function heading(st, o) {
    const size = o.size || U * 7, center = (o.align || 'center') === 'center', G = st.G;
    // 书法字框：基线以上 0.88em、以下 0.12em；上沿多留 2.5u，镜头推近 5% 也不会出安全区
    const x = o.x ?? (center ? W / 2 : S.safe.x + U * 3), base = o.y ?? S.safe.y + U * 2.5 + size * 0.88;
    const color = o.color || G.title, fill = o.paper === false ? color : st.paperFill(color);
    const g = el('g', {}, st.world), chars = Array.from(o.text), r = S.rng(o.seed || 21);
    const jit = chars.map(() => ({ a: (r() - 0.5) * 5, y: (r() - 0.5) * U * 0.35 }));
    const mkChar = (ch, f, extra) => { const e = el('text', { 'font-family': F.brush, 'font-size': size, fill: f, 'text-anchor': 'middle', y: base, opacity: 0, ...extra }, g); e.textContent = ch; return e; };
    const nodes = chars.map(ch => ({ sh: [0, 1].map(() => mkChar(ch, G.shadow, { 'data-qa': 'ignore' })), e: mkChar(ch, fill, {}) }));
    const ss = o.subSize || U * 3.2;
    const subBase = base + size * 0.12 + U * 1.4 + ss * 1.16;
    const sub = o.sub ? text(st, { x, y: subBase, text: o.sub, size: ss, anchor: center ? 'middle' : 'start', color: G.text2, weight: 500 }) : null;
    let xs = null;
    const layout = () => {
      const m = el('text', { 'font-family': F.brush, 'font-size': size }, g); m.textContent = o.text;
      const ws = chars.map((_, i) => m.getSubStringLength(i, 1)), gap = size * (o.spacing ?? 0.04);
      const total = ws.reduce((s, v) => s + v, 0) + gap * (chars.length - 1);
      let cx = center ? x - total / 2 : x;
      xs = ws.map(v => { const c = cx + v / 2; cx += v + gap; return c; });
      m.remove();
    };
    return {
      bottom: sub ? subBase + ss * 0.3 + U * 1.2 : base + size * 0.12 + U * 1.5,
      draw(p) {
        if (!xs) layout();
        const n = chars.length;
        nodes.forEach((nd, i) => {
          const q = clamp(p * (1 + (n - 1) * 0.28) - i * 0.28);
          const lifted = q > 0 && q < 0.5, cy = base - size * 0.38, yy = base + jit[i].y - (lifted ? U * 0.6 : 0), rot = `rotate(${jit[i].a * (lifted ? 2.2 : 1)} ${xs[i]} ${cy})`;
          const sh = st.shadowOf(lifted);
          [nd.e, ...nd.sh].forEach((e, k) => {
            e.setAttribute('x', xs[i]); e.setAttribute('y', yy);
            e.setAttribute('transform', k ? `translate(${sh[k - 1][0]} ${sh[k - 1][1]}) ${rot}` : rot);
            e.setAttribute('opacity', q > 0 ? (k ? sh[k - 1][2] * st.G.shadowA * 2 : 1) : 0);
          });
        });
        if (sub) sub.draw(clamp(p * 1.6 - 0.6));
      },
    };
  }

  /** 普通文字：opts x, y（基线）, text 或 lines:[…], size（默认 3.6u）, font: 'sans'（默认）| 'brush', weight, color, anchor（默认 middle）,
   *  layer: 'world'（默认）| 'hud', shadow（纸影，书法大字建议开）。draw(p) 落定显出；set(text) 改字 */
  function text(st, o) {
    const size = o.size || U * 3.6, parent = o.layer === 'hud' ? st.hud : st.world;
    const g = el('g', { opacity: 0 }, parent);
    const mk = (fill, extra) => {
      const e = T(g, { x: o.x, y: o.y, size, text: o.lines ? '' : o.text, fill, font: o.font || 'sans', weight: o.weight || (o.font === 'brush' ? 400 : 500), anchor: o.anchor || 'middle', spacing: o.spacing });
      for (const k in extra) e.setAttribute(k, extra[k]);
      if (o.lines) o.lines.forEach((ln, i) => { const t = el('tspan', { x: o.x, dy: i ? size * (o.leading || 1.5) : 0 }, e); t.textContent = ln; });
      return e;
    };
    if (o.shadow) st.shadowOf(false).forEach(([dx, dy, a]) => mk(st.G.shadow, { 'data-qa': 'ignore', transform: `translate(${dx} ${dy})`, opacity: a * st.G.shadowA * 2 }));
    const e = mk(colorOf(st, o.color, st.G.text), {});
    return {
      el: e,
      draw(p) { const k = ease.out(clamp(p)); g.setAttribute('opacity', p > 0 ? clamp(p * 2.5) : 0); g.setAttribute('transform', `translate(0 ${-(1 - k) * U * 0.8})`); },
      set(s) { if (e.textContent !== s) e.textContent = s; },
    };
  }

  /** 内容区：标题下沿到字幕区上沿之间（没有字幕时到安全区下沿）。返回 { x, y, w, h, cx, cy } */
  function contentArea(h, pad = U * 2.5) {
    const y0 = (h ? h.bottom : S.safe.y) + pad, y1 = (S.captionsOn ? S.captionZone.y : S.safe.y + S.safe.h) - pad;
    return { x: S.safe.x, y: y0, w: S.safe.w, h: y1 - y0, cx: S.safe.x + S.safe.w / 2, cy: (y0 + y1) / 2 };
  }

  /** 步骤列表（讲解用）：红纸菱形里写"一 二 三"，右边一句短话。opts: x（左沿）, y（第一行中线）, items:[…], gap（行距，默认 10u）, size（默认 4u）, marks
   *  draw(p, { active })：p 从 0 到行数，第 i 行在 p 经过 i 时贴出（可以把几段 PC.seg 相加，让每行跟着旁白出现）；
   *    active 是正在讲的那一行（其余压到 45%），-1 或不填表示都正常 */
  function steps(st, o) {
    const size = o.size || U * 4, gap = o.gap || U * 10, ms = size * 2, marks = o.marks || ['一', '二', '三', '四', '五', '六'];
    const mk = bake({ outline: [SH.diamond(ms, ms)], inset: { d: ms * 0.06, w: ms * 0.025, dash: [ms * 0.5, ms * 0.06] }, tone: C.red, wob: U * 0.03, seed: 15 });
    const rows = o.items.map((it, i) => {
      const y = o.y + i * gap, g = el('g', { opacity: 0 }, st.world);
      T(g, { x: o.x + ms / 2, y: y + size * 0.36, size: size * 0.95, text: marks[i], fill: C.cream });
      const lb = T(g, { x: o.x + ms + U * 2, y: y + size * 0.4, size, text: it, fill: st.G.text, font: 'sans', weight: 600, anchor: 'start' });
      return { y, g, lb };
    });
    return {
      draw(p, d = {}) {
        const act = d.active ?? -1;
        rows.forEach((r, i) => {
          const q = clamp(p - i), e = enterState('paste', q, { drop: U * 2 });
          const on = act < 0 || act === i, dimv = on ? 1 : 0.45;
          r.g.setAttribute('opacity', e ? e.alpha * dimv : 0);
          r.lb.setAttribute('fill', act === i ? st.G.title : st.G.text);
          if (e) paint(st, mk, { x: o.x + ms / 2 + e.dx, y: r.y + e.dy, r: e.r, s: e.s * (act === i ? 1.08 : 1) }, { alpha: e.alpha * (on ? 1 : 0.55), lift: e.lift });
        });
      },
    };
  }

  /** 出处脚注（民俗说法、数据都要标）：默认在右下角、字幕区以上。opts text, x, y, anchor；draw(p) */
  function source(st, o) {
    const x = o.x ?? S.safe.x + S.safe.w, y = o.y ?? (S.captionsOn ? S.captionZone.y - U * 1.2 : S.safe.y + S.safe.h);
    return text(st, { x, y, text: o.text, size: o.size || U * 2, anchor: o.anchor || 'end', color: st.G.text2, weight: 500, layer: 'hud' });
  }
  /** 角标（"示例品牌""示例数据"）：小红纸签，固定在屏幕左上角。opts text, x, y；draw(p) */
  function tag(st, o) {
    const size = o.size || U * 2, x = o.x ?? S.safe.x, y = o.y ?? S.safe.y, g = el('g', { opacity: 0 }, st.hud);
    const shp = el('polygon', { fill: st.G.shadow, opacity: st.G.shadowA * 0.8, transform: `translate(${U * 0.16} ${U * 0.24})` }, g);
    const poly = el('polygon', { fill: C.red }, g);
    const t = T(g, { x: x + size * 1.1, y: y + size * 1.22, size, text: o.text, fill: C.cream, font: 'sans', weight: 700, anchor: 'start', spacing: size * 0.08 });
    let laid = false;
    return {
      draw(p) {
        if (!laid) { const w = t.getComputedTextLength() + size * 2.2, h = size * 1.7, n = size * 0.45; const pts = `${x},${y} ${x + w},${y} ${x + w - n},${y + h / 2} ${x + w},${y + h} ${x},${y + h}`; poly.setAttribute('points', pts); shp.setAttribute('points', pts); laid = true; }
        g.setAttribute('opacity', p > 0 ? clamp(p * 3) : 0);
      },
    };
  }

  window.PC = {
    C, ground: GROUND, F, U, seg, step, mix, rgba,
    shape: SH, tr, ring, merge, motif: (name, s, x = 0, y = 0, a = 0) => moveMotif(motifs[name](s), x, y, a), patterns: { round: roundFlower, square: squareFlower },
    enter: enterState, stage, heading, text, area: contentArea, steps, source, tag,
    piece, flower, foldcut, lantern, hills, scraps, banner, couplet, fu, seal, badge, frame, tile,
  };
})();
