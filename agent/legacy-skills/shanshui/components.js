/* 水墨山水组件（依赖 SLATE 运行时）：文旅、茶酒、节气、诗词、国学类片子
 *
 * 约定：所有组件在创建时一次性生成元素（山、雾、纸纹这些重的层在创建时离屏画好），render(t) 里只改变换、透明度和少量路径。
 *   draw(p)：p 为 0～1 的入场进度；play(t, start)：按绝对时间推进的组件（诗句逐字）。
 *   环境动作（雾的漂移和浓淡、水纹、船的起伏和涟漪）由 st.set(t) 统一驱动，不用自己调。
 * 坐标单位是画布像素，尺寸都写成 SLATE.u（短边的 1%）的倍数。
 * 必须先创建 SS.stage（它决定调板），再创建其他组件；创建顺序就是叠放顺序（先远后近）。
 *
 *   const st = SS.stage({ palette: 'shuimo', pan: [U * 10, -U * 10], enter: 'bloom' });
 *   const hills = SS.mountains(st, { layers: 5, seed: 7 });                 // 远山层叠 + 层间云雾
 *   const ti = SS.vtitle(st.hud, { x: W * 0.78, y: H * 0.2, text: '高山云雾' });
 *   const se = SS.seal(st.hud, { x: W * 0.72, y: ti.bottom, text: '山岚' });
 *   function render(t) { st.set(t); hills.draw(SLATE.seg(t, 0, 2)); ti.draw(SLATE.seg(t, 0.8, 2.6, SLATE.ease.linear)); se.draw(SLATE.seg(t, 2.8, 3.1)); }
 *
 * 组件一览（参数见各函数注释）：
 *   舞台与转场：stage、inkBloom
 *   景物（Canvas 预渲染）：mountains、mist、water、moon
 *   笔墨（SVG）：stroke、inkSweep、plum、boat、birds
 *   文字与印：heading、label、vtitle、verse、inscription、seal、marker
 */
(() => {
  const S = window.SLATE;
  const U = S.u, W = S.width, H = S.height;
  const clamp = S.clamp, lerp = S.lerp, ease = S.ease;
  const el = (tag, attrs, into) => S.svg(tag, attrs, into);
  let uid = 0;
  const id = p => `ss${p}${++uid}`;
  const sm = (a, b, x) => { const q = clamp((x - a) / (b - a)); return q * q * (3 - 2 * q); };
  const hex = c => [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16));
  const mix = (c1, c2, p) => { const a = hex(c1), b = hex(c2), q = clamp(p); return '#' + a.map((v, i) => Math.round(v + (b[i] - v) * q).toString(16).padStart(2, '0')).join(''); };
  const rgba = (c, a) => { const [r, g, b] = hex(c); return `rgba(${r}, ${g}, ${b}, ${a})`; };
  const f2 = v => (Math.round(v * 100) / 100).toString();
  const isWide = ch => /[⺀-鿿豈-﫿＀-￯　-〿]/.test(ch);

  const FONT = {
    brush: '"Ma Shan Zheng", "Noto Serif SC", "Noto Sans CJK SC", serif',
    serif: '"Noto Serif SC", "Noto Sans CJK SC", serif',
    sans: '"Noto Sans CJK SC", "Noto Sans SC", sans-serif',
  };
  // 字体在 style.css 里用 @font-face 声明；这里主动加载并让渲染等它们就绪（组件布局按 em 计算，不依赖测量）
  if (document.fonts && document.fonts.load) {
    S.waits.push(document.fonts.load(`${Math.round(U * 8)}px "Ma Shan Zheng"`, '山水').catch(() => null));
    S.waits.push(document.fonts.load(`600 ${Math.round(U * 4)}px "Noto Serif SC"`, '山水').catch(() => null));
  }

  // ---- 调板（色彩逻辑：墨分五色；朱砂只给印章；彩色只上在山体上，文字永远是墨色） ----
  const PALETTES = {
    // 水墨：纯墨加一点花青冷调，远山偏冷偏淡
    shuimo: { paper: '#F2ECDE', edge: '#D9CDB3', ink: '#1E1C1A', ink0: '#0F0D0C', ink2: '#4A4640', muted: '#77746E',
      ridge: ['#3A3E44', '#1E1C1A'], body: ['#6F8AA0', '#1E1C1A'], level: [0.36, 0.95], mist: '#F2ECDE', seal: '#B02E22', moon: '#FBF8F0' },
    // 青绿：山脊用墨，山体上石青（远）到石绿（近）
    qinglv: { paper: '#F3EDDD', edge: '#D8CCAE', ink: '#1F2A27', ink0: '#101614', ink2: '#3E4A45', muted: '#6F7C76',
      ridge: ['#425A66', '#1F2A27'], body: ['#5A86B0', '#3F8F6E'], level: [0.42, 0.95], mist: '#F3EDDD', seal: '#B02E22', moon: '#FBF8F0' },
    // 朱金：暖纸，赭石山体，金色只给日轮和一处点睛
    zhujin: { paper: '#F1E5CC', edge: '#D6BF94', ink: '#2A1F18', ink0: '#160F0B', ink2: '#4E3D30', muted: '#80705F',
      ridge: ['#6A4A33', '#2A1F18'], body: ['#D8B05A', '#A85F31'], level: [0.38, 0.92], mist: '#F1E5CC', seal: '#B02E22', moon: '#E7B653', gold: '#C9A13B' },
  };
  let P = PALETTES.shuimo;

  // ---- 确定性噪声 ----
  const h2 = (x, y, s) => {
    let n = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul((s | 0) + 7, 1442695041);
    n = Math.imul(n ^ (n >>> 13), 1274126177); n ^= n >>> 16;
    return (n >>> 0) / 4294967296;
  };
  /** 二维平滑噪声，-1～1 */
  const noise2 = (x, y, s = 0) => {
    const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    const a = h2(xi, yi, s), b = h2(xi + 1, yi, s), c = h2(xi, yi + 1, s), d = h2(xi + 1, yi + 1, s);
    return (a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v) * 2 - 1;
  };
  const fbm2 = (x, y, s = 0, oct = 3) => { let a = 0, f = 1, amp = 0.5, n = 0; for (let i = 0; i < oct; i++) { a += amp * noise2(x * f, y * f, s + i * 31); n += amp; f *= 2.03; amp *= 0.5; } return a / n; };
  const n1 = (s, x) => S.noise(s, x);

  const canvas = (w, h) => { const c = document.createElement('canvas'); c.width = Math.max(1, Math.ceil(w)); c.height = Math.max(1, Math.ceil(h)); return c; };
  const div = cls => { const d = document.createElement('div'); d.className = cls; return d; };

  // ---------------------------------------------------------------------------------------------
  /** 纸底：纯色（景物层的遮挡用同一个纸色，接缝才看不出来） */
  function paperCanvas() {
    const cv = canvas(W, H), ctx = cv.getContext('2d');
    ctx.fillStyle = P.paper; ctx.fillRect(0, 0, W, H);
    return cv;
  }

  /** 纸纹（压在所有景物上面、文字下面）：上下深浅、云状斑驳、纤维、杂点、暗角；绢底再加经纬。创建时画一次 */
  function textureCanvas(kind, vignette) {
    const cv = canvas(W, H), ctx = cv.getContext('2d'), silk = kind === 'silk';
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, rgba('#FFFFFF', silk ? 0.22 : 0.10));
    g.addColorStop(1, rgba(P.edge, silk ? 0.38 : 0.2));
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    const sw = Math.ceil(W / 10), sh = Math.ceil(H / 10), small = canvas(sw, sh), sx = small.getContext('2d'), img = sx.createImageData(sw, sh);
    const [er, eg, eb] = hex(P.edge);
    for (let j = 0; j < sh; j++) for (let i = 0; i < sw; i++) {
      const v = fbm2(i / 14, j / 14, 5, 4), k = (j * sw + i) * 4;
      img.data[k] = er; img.data[k + 1] = eg; img.data[k + 2] = eb; img.data[k + 3] = Math.round(clamp(0.5 + v * 1.1) * 70);
    }
    sx.putImageData(img, 0, 0);
    ctx.globalAlpha = silk ? 0.35 : 0.5; ctx.imageSmoothingEnabled = true; ctx.drawImage(small, 0, 0, W, H); ctx.globalAlpha = 1;
    const rnd = S.rng(29), area = (W * H) / (1920 * 1080);
    if (silk) {
      ctx.lineWidth = Math.max(0.6, U * 0.05);
      for (let y = 0; y < H; y += U * 0.32) { ctx.strokeStyle = rgba(P.edge, 0.10 + rnd() * 0.08); ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y + (rnd() - 0.5) * U * 0.2); ctx.stroke(); }
      for (let x = 0; x < W; x += U * 0.32) { ctx.strokeStyle = rgba('#FFFFFF', 0.10 + rnd() * 0.08); ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x + (rnd() - 0.5) * U * 0.2, H); ctx.stroke(); }
    }
    const nf = Math.round((silk ? 700 : 2400) * area);
    for (let i = 0; i < nf; i++) {
      const x = rnd() * W, y = rnd() * H, len = U * (0.4 + rnd() * 2.2), a = rnd() * Math.PI * 2, bend = (rnd() - 0.5) * len * 0.8;
      const dark = rnd() < 0.5;
      ctx.strokeStyle = dark ? rgba(P.edge, 0.10 + rnd() * 0.2) : rgba(mix(P.paper, '#FFFFFF', 0.6), 0.16 + rnd() * 0.26);
      ctx.lineWidth = U * (0.03 + rnd() * 0.06);
      ctx.beginPath(); ctx.moveTo(x, y);
      ctx.quadraticCurveTo(x + Math.cos(a) * len / 2 - Math.sin(a) * bend, y + Math.sin(a) * len / 2 + Math.cos(a) * bend, x + Math.cos(a) * len, y + Math.sin(a) * len);
      ctx.stroke();
    }
    const nd = Math.round(700 * area);
    for (let i = 0; i < nd; i++) {
      ctx.fillStyle = rgba(P.edge, 0.15 + rnd() * 0.3);
      ctx.beginPath(); ctx.arc(rnd() * W, rnd() * H, U * (0.04 + rnd() * 0.12), 0, 6.2832); ctx.fill();
    }
    if (vignette) {
      const vg = ctx.createRadialGradient(W / 2, H * 0.46, Math.min(W, H) * 0.35, W / 2, H / 2, Math.hypot(W, H) * 0.6);
      vg.addColorStop(0, rgba(P.edge, 0)); vg.addColorStop(1, rgba(P.edge, 0.55));
      ctx.fillStyle = vg; ctx.fillRect(0, 0, W, H);
    }
    return cv;
  }

  // ---------------------------------------------------------------------------------------------
  /** 舞台：宣纸底 + 景物层（按景深视差）+ 内容 svg + 转场层。
   *  opts: palette: 'shuimo' | 'qinglv' | 'zhujin'（水墨 / 青绿 / 朱金，默认水墨）
   *        paper: 'xuan' | 'silk'（宣纸 / 绢，默认宣纸）、vignette（暗角，默认 true）
   *        镜头（手卷）：pan: [起, 止]（镜头 x，单位像素；从正到负 = 画卷向右展开、画面从右往左看）、lift: [起, 止]（镜头 y）、
   *              zoom: [起, 止]（推近，默认 [1, 1]，建议不超过 1.06）、move: [开始秒, 结束秒]（镜头运动区间，默认整镜，inOut 缓动）
   *        enter: 'bloom'（墨晕扩散显出画面）| 'wash'（满屏墨色退去，接上一镜的 ink 结尾）| 'fade' | 'none'；enterDur（默认 1.3 秒）、
   *               bloomAt: [x, y]（墨晕起点，0～1 的比例，默认画面中心）
   *        exit: 'ink'（墨色晕开盖满画面）| 'fade'（淡回白纸，只留纸）| 'none'；exitDur（默认 1 秒）、exitAt: [x, y]（墨从哪里晕开，默认同 bloomAt）
   *  返回 { root, world, hud, set(t), project(x, y, depth), margin(depth), addLayer, tick, paper, cam }：
   *    world：跟随镜头（景深 1）的内容；hud：固定在屏幕上（标题、题款、印章、地名题签）。
   *  render(t) 第一行调用 st.set(t)。 */
  function stage(opts = {}) {
    const o = { palette: 'shuimo', paper: 'xuan', vignette: true, pan: [0, 0], lift: [0, 0], zoom: [1, 1], move: [0, S.duration],
      enter: 'none', enterDur: 1.3, bloomAt: [0.5, 0.5], exit: 'none', exitDur: 1, ...opts };
    P = PALETTES[o.palette] || PALETTES.shuimo;
    document.documentElement.style.background = P.paper;
    document.body.style.background = P.paper;
    document.documentElement.style.setProperty('--ss-paper', P.paper);
    document.documentElement.style.setProperty('--ss-ink', P.ink);
    const root = div('ss-root');
    const paper = paperCanvas();
    paper.className = 'ss-paper';
    const texture = textureCanvas(o.paper, o.vignette);
    texture.className = 'ss-grain';
    const back = div('ss-back');
    const svg = el('svg', { class: 'ss-svg', width: W, height: H, viewBox: `0 0 ${W} ${H}` });
    const defs = el('defs', {}, svg);
    const world = el('g', {}, svg), hud = el('g', {}, svg);
    const fx = div('ss-fx');
    root.appendChild(paper); root.appendChild(back);
    root.appendChild(texture);
    root.appendChild(svg); root.appendChild(fx);
    document.body.insertBefore(root, document.body.firstChild);
    svg.__ssDefs = defs;

    const layers = [], tickers = [];
    const cam = { x: o.pan[0], y: o.lift[0], z: o.zoom[0], t: 0 };
    const panMax = Math.max(Math.abs(o.pan[0]), Math.abs(o.pan[1])), liftMax = Math.max(Math.abs(o.lift[0]), Math.abs(o.lift[1]));
    const zMin = Math.min(o.zoom[0], o.zoom[1], 1);
    /** 景深为 depth 的层需要在画面外多画多少（左右、上下各留） */
    const margin = (depth = 1) => {
      const s = 1 + (zMin - 1) * depth;
      return { x: Math.ceil(panMax * depth + (W / 2) * (1 / s - 1) + U * 3), y: Math.ceil(liftMax * depth + (H / 2) * (1 / s - 1) + U * 3) };
    };
    const camAt = t => {
      const q = ease.inOut(clamp((t - o.move[0]) / Math.max(1e-6, o.move[1] - o.move[0])));
      return { x: lerp(o.pan[0], o.pan[1], q), y: lerp(o.lift[0], o.lift[1], q), z: lerp(o.zoom[0], o.zoom[1], q) };
    };
    const place = L => {
      const s = 1 + (cam.z - 1) * L.depth;
      const tx = -cam.x * L.depth + L.ox + (L.dx ? L.dx(cam.t) : 0), ty = -cam.y * L.depth + L.oy;
      L.el.style.transform = `scale(${s.toFixed(5)}) translate(${tx.toFixed(2)}px, ${ty.toFixed(2)}px)`;
    };
    /** 加一层景物：elem 放在屏幕坐标 (x, y)、尺寸 w×h（镜头在起点时），按 depth 视差移动。返回 L，L.offset(ox, oy) 叠加自身位移 */
    const addLayer = (elem, { x, y, w, h, depth = 1, dx = null }) => {
      elem.classList.add('ss-layer');
      Object.assign(elem.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px`, transformOrigin: `${W / 2 - x}px ${H / 2 - y}px` });
      back.appendChild(elem);
      const L = { el: elem, x, y, w, h, depth, dx, ox: 0, oy: 0 };
      L.offset = (ox, oy) => { L.ox = ox; L.oy = oy; place(L); };
      layers.push(L);
      place(L);
      return L;
    };
    /** 世界坐标 → 屏幕坐标（镜头的唯一换算）；depth 和景物层一致时，标注会贴着景物走 */
    const project = (x, y, depth = 1) => {
      const s = 1 + (cam.z - 1) * depth;
      return [(x - cam.x * depth - W / 2) * s + W / 2, (y - cam.y * depth - H / 2) * s + H / 2, s];
    };
    const st = { root, paper, texture, back, svg, defs, world, hud, fx, cam, opts: o, margin, addLayer, project, layers,
      tick: fn => tickers.push(fn) };

    const D = S.duration;
    const enterFx = o.enter === 'bloom' ? inkBloom(st, { mode: 'reveal', x: o.bloomAt[0] * W, y: o.bloomAt[1] * H, seed: 17 })
      : o.enter === 'wash' ? inkBloom(st, { mode: 'wash', x: o.bloomAt[0] * W, y: o.bloomAt[1] * H, seed: 23 }) : null;
    const exitFx = o.exit === 'ink' ? inkBloom(st, { mode: 'cover', x: (o.exitAt || o.bloomAt)[0] * W, y: (o.exitAt || o.bloomAt)[1] * H, seed: 31 }) : null;

    st.set = t => {
      Object.assign(cam, camAt(t)); cam.t = t;
      for (const L of layers) place(L);
      world.setAttribute('transform', `translate(${f2(W / 2)} ${f2(H / 2)}) scale(${cam.z.toFixed(5)}) translate(${f2(-W / 2 - cam.x)} ${f2(-H / 2 - cam.y)})`);
      for (const fn of tickers) fn(t);
      // 转场
      let vis = 1;
      if (o.enter === 'fade') vis *= ease.out(clamp(t / o.enterDur));
      if (o.exit === 'fade') vis *= 1 - ease.in(clamp((t - (D - o.exitDur)) / o.exitDur));
      back.style.opacity = vis.toFixed(4); svg.style.opacity = vis.toFixed(4);
      if (enterFx) enterFx.set(ease.out(clamp(t / o.enterDur)));
      if (exitFx) exitFx.set(ease.inOut(clamp((t - (D - o.exitDur)) / o.exitDur)));
    };
    return st;
  }

  /** 墨晕转场：噪声径向场 + 潮线（外缘更深的一圈）。opts mode: 'cover'（墨盖满画面）| 'reveal'（画面从白纸里晕开显出）| 'wash'（满屏墨退去）
   *  x, y（起点，像素）, seed, res（计算分辨率，默认 0.3）。返回 { set(p) }；stage 的 enter/exit 已经用它，镜内换景也可以单独用 */
  function inkBloom(st, o = {}) {
    const mode = o.mode || 'cover', sc = o.res || 0.3, seed = o.seed ?? 11;
    const w = Math.ceil(W * sc), h = Math.ceil(H * sc), N = w * h;
    const cx = o.x ?? W / 2, cy = o.y ?? H / 2;
    const field = new Float32Array(N);
    let mn = 1e9, mx = -1e9;
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      const X = (i + 0.5) / sc, Y = (j + 0.5) / sc, r = Math.hypot(X - cx, Y - cy) / (U * 100);
      const v = r * (1 + 0.34 * fbm2(X / (U * 15), Y / (U * 15), seed, 3)) + 0.06 * noise2(X / (U * 5), Y / (U * 5), seed + 4) + 0.03 * noise2(X / (U * 1.8), Y / (U * 1.8), seed + 5);
      field[j * w + i] = v; if (v < mn) mn = v; if (v > mx) mx = v;
    }
    for (let k = 0; k < N; k++) field[k] = (field[k] - mn) / (mx - mn);
    const tex = new Float32Array(N);   // 墨色浓淡（不随时间变）
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) tex[j * w + i] = fbm2(i / (w * 0.06), j / (w * 0.06), seed + 9, 3) * 0.5 + 0.5;
    const lo = canvas(w, h), lx = lo.getContext('2d'), img = lx.createImageData(w, h), d = img.data;
    const rimLo = mode === 'reveal' ? canvas(w, h) : null, rimImg = rimLo ? rimLo.getContext('2d').createImageData(w, h) : null;
    const full = mode === 'reveal' ? canvas(W, H) : null;
    const shown = full || lo;
    shown.className = 'ss-fxc';
    Object.assign(shown.style, { width: `${W}px`, height: `${H}px`, display: 'none' });
    st.fx.appendChild(shown);
    const [ir, ig, ib] = hex(mix(P.ink, P.paper, 0.06)), [kr, kg, kb] = hex(P.ink0);
    const soft = 0.014, rim = 0.045;
    let last = null;
    return {
      set(p) {
        p = clamp(p);
        if (p === last) return;
        last = p;
        const hide = (mode === 'cover' && p <= 0) || (mode !== 'cover' && p >= 1);
        shown.style.display = hide ? 'none' : 'block';
        if (hide) return;
        const front = lerp(-soft, 1 + rim * 1.5, p);
        for (let k = 0, q = 0; k < N; k++, q += 4) {
          const x = front - field[k];
          const a = x <= 0 ? 0 : x >= soft ? 1 : sm(0, soft, x);
          const e = x > 0 ? Math.exp(-x / rim) : 0;
          let alpha, c = e;
          if (mode === 'cover') { alpha = a * Math.min(1, lerp(0.7, 1, p * p) + 0.35 * e) * (1 - (1 - p) * 0.22 * tex[k]); c = Math.min(1, e * 1.4); }
          else if (mode === 'wash') alpha = (1 - a) + a * e * 0.55 * (1 - p);
          else alpha = 1 - a;
          if (mode === 'reveal') {
            d[q] = 255; d[q + 1] = 255; d[q + 2] = 255; d[q + 3] = alpha * 255;
            const rd = rimImg.data, ra = a * e * 0.42 * (1 - p * 0.6);
            rd[q] = kr; rd[q + 1] = kg; rd[q + 2] = kb; rd[q + 3] = ra * 255;
          } else {
            d[q] = ir + (kr - ir) * c; d[q + 1] = ig + (kg - ig) * c; d[q + 2] = ib + (kb - ib) * c; d[q + 3] = alpha * 255;
          }
        }
        lx.putImageData(img, 0, 0);
        if (full) {
          rimLo.getContext('2d').putImageData(rimImg, 0, 0);
          const fc = full.getContext('2d');
          fc.globalCompositeOperation = 'source-over'; fc.clearRect(0, 0, W, H);
          fc.drawImage(st.paper, 0, 0); fc.drawImage(st.texture, 0, 0);
          fc.globalCompositeOperation = 'destination-in'; fc.drawImage(lo, 0, 0, W, H);
          fc.globalCompositeOperation = 'source-over'; fc.drawImage(rimLo, 0, 0, W, H);
        }
      },
    };
  }

  // ---------------------------------------------------------------------------------------------
  /** 山脊线：kind 'range'（连绵山脉、尖峰）| 'karst'（喀斯特孤峰）| 'hills'（缓丘、茶山）。返回 X → 山脊 y */
  function ridgeFn(kind, seed, base, amp) {
    if (kind === 'karst') {
      const rnd = S.rng(seed * 7919 + 13), peaks = [];
      for (let x = -W * 0.8; x < W * 1.8;) {
        const w = U * (5 + rnd() * 8), hg = amp * (0.25 + Math.pow(rnd(), 0.7) * 0.75), lean = (rnd() - 0.5) * 0.6;
        peaks.push([x, w, hg, lean]);
        x += w * (1.1 + rnd() * 1.8);
      }
      return X => {
        let h = amp * 0.05 * (n1(seed, X / (U * 30)) * 0.5 + 0.5);
        for (const [c, w, hg, ln] of peaks) {
          let dx = (X - c) / w;
          dx *= dx < 0 ? 1 + ln : 1 - ln;
          if (dx > -1 && dx < 1) { const ax = Math.abs(dx), v = Math.pow(1 - 0.81 * ax * ax, 0.6) * (1 - sm(0.72, 1, ax)) * hg; if (v > h) h = v; }
        }
        return base - h + amp * 0.025 * n1(seed + 9, X / (U * 2.4));
      };
    }
    if (kind === 'hills') return X => { const a1 = n1(seed, X / (U * 42)) * 0.5 + 0.5; return base - amp * (0.62 * a1 * a1 * (3 - 2 * a1) + 0.3 * (n1(seed + 1, X / (U * 17)) * 0.5 + 0.5) + 0.08 * (n1(seed + 2, X / (U * 6)) * 0.5 + 0.5)); };
    return X => {
      const q = X / (U * 46), r1 = 1 - Math.abs(n1(seed, q));
      return base - amp * (0.6 * Math.pow(r1, 1.7) + 0.28 * (n1(seed + 1, q * 0.43) * 0.5 + 0.5) + 0.1 * (n1(seed + 2, q * 4.1) * 0.5 + 0.5) + 0.02 * n1(seed + 3, q * 17));
    };
  }

  /** 逐像素画一层山：山脊一道深墨（潮线，粗细和浓淡随笔意起伏），往下按指数淡开；顺坡的噪声做皴擦，低频噪声做墨色浓淡，
   *  山体里断续加一道褶皱；阴阳面按坡向深浅 */
  function paintLayer(o) {
    const { x0, y0, wc, hc, res, ridge, fold, fall, edgeW, alpha, seed, foldK, body: bodyK, base: bl, amp } = o;
    const cw = Math.ceil(wc * res), ch = Math.ceil(hc * res), cv = canvas(cw, ch), ctx = cv.getContext('2d');
    const img = ctx.createImageData(cw, ch), D = img.data;
    const [rr, rg, rb] = hex(o.ridgeC), [br, bg, bb] = hex(o.bodyC), [pr, pg, pb] = hex(P.mist);
    const R = new Float32Array(cw), R2 = new Float32Array(cw), SH = new Float32Array(cw), SL = new Float32Array(cw), HK = new Float32Array(cw);
    const EW = new Float32Array(cw), ES = new Float32Array(cw), FK = new Float32Array(cw);
    for (let i = 0; i < cw; i++) {
      const X = x0 + (i + 0.5) / res;
      R[i] = ridge(X) - y0; R2[i] = fold(X) - y0;
      const sl = (ridge(X + U * 0.8) - ridge(X - U * 0.8)) / (U * 1.6);
      SL[i] = clamp(sl, -1.6, 1.6); SH[i] = 1 + 0.35 * Math.tanh(sl * 1.6);
      EW[i] = edgeW * (0.55 + 0.9 * (n1(seed + 21, X / (U * 9)) * 0.5 + 0.5));
      ES[i] = 0.55 + 0.45 * sm(-0.6, 0.6, n1(seed + 22, X / (U * 4)));
      FK[i] = foldK * sm(-0.25, 0.45, n1(seed + 8, X / (U * 22)));
      HK[i] = 0.55 + 0.75 * clamp((bl - R[i]) / (amp || 1), 0, 1.4);   // 山越高墨越浓，谷里淡
    }
    const lim = fall * 4.5;
    for (let i = 0; i < cw; i++) {
      const X = x0 + (i + 0.5) / res, r = R[i], r2 = R2[i], sh = SH[i] * HK[i], sl = SL[i], ew = EW[i], es = ES[i], fk = FK[i];
      const j0 = Math.max(0, Math.floor((r - 2) * res)), j1 = Math.min(ch, Math.ceil((r + lim) * res));
      for (let j = j0; j < j1; j++) {
        const Y = (j + 0.5) / res, d = Y - r, aa = clamp(d * res + 0.5);
        if (aa <= 0) continue;
        const yy = Y + y0, edge = Math.exp(-d / ew), bd = Math.exp(-d / fall);
        const streak = fbm2((X - sl * 0.7 * d) / (U * 1.3), yy / (U * 9), seed, 2) * 0.5 + 0.5;
        const wash = fbm2(X / (U * 9), yy / (U * 5), seed + 3, 3) * 0.5 + 0.5;
        const tex = clamp(0.42 + 0.36 * streak + 0.5 * (wash - 0.5), 0.05, 1.2);
        const d2 = Y - r2;
        const fl = d2 > 0 && fk > 0.01 ? fk * (0.6 * Math.exp(-d2 / (ew * 1.6)) + 0.4 * Math.exp(-d2 / (fall * 0.4))) : 0;
        const gr = 1 + (h2(i, j, seed) - 0.5) * 0.16;
        const dens = (0.5 * es * edge + bd * tex * sh * bodyK * (0.7 + 0.6 * wash) + fl * tex) * gr;
        const a = clamp(dens) * alpha * aa, ce = clamp(edge * 1.25 * es + fl * 0.5), k = (j * cw + i) * 4;
        // 纸色遮挡：近山挡住远山，往下化进雾里
        const occ = aa * (1 - sm(fall * 1.1, fall * 3.4, d + (wash - 0.5) * fall * 1.4)), oa = a + occ * (1 - a);
        if (oa <= 0) continue;
        const wi = a / oa, wp = 1 - wi;
        D[k] = (br + (rr - br) * ce) * wi + pr * wp; D[k + 1] = (bg + (rg - bg) * ce) * wi + pg * wp; D[k + 2] = (bb + (rb - bb) * ce) * wi + pb * wp; D[k + 3] = oa * 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return cv;
  }

  /** 点苔和远树：只点在近处几层的高处 */
  function decorate(cv, res, x0, y0, rf, amp, k, seed, color, alpha) {
    const ctx = cv.getContext('2d'), rnd = S.rng(seed * 31 + 7), wc = cv.width / res;
    ctx.save(); ctx.scale(res, res); ctx.translate(-x0, -y0);
    ctx.fillStyle = color; ctx.strokeStyle = color; ctx.lineCap = 'round';
    const count = Math.round(wc / (U * 2.6));
    for (let i = 0; i < count; i++) {
      const X = x0 + rnd() * wc, Y = rf(X), peak = (rf(X - U * 7) + rf(X + U * 7)) / 2 - Y, roll = rnd();
      if (peak < amp * 0.05 && roll > 0.2) continue;
      if (rnd() < 0.72) {
        const rr = U * (0.16 + rnd() * 0.22) * lerp(0.7, 1.15, k);
        ctx.globalAlpha = alpha * (0.5 + rnd() * 0.45);
        ctx.beginPath(); ctx.ellipse(X, Y + rr * 0.3, rr * 1.5, rr * 0.7, (rnd() - 0.5) * 0.5, 0, 6.2832); ctx.fill();
      } else {
        const th = U * (0.5 + rnd() * 0.8) * lerp(0.6, 1.0, k);
        ctx.globalAlpha = alpha * 0.7; ctx.lineWidth = U * 0.09;
        ctx.beginPath(); ctx.moveTo(X, Y + U * 0.3); ctx.lineTo(X + (rnd() - 0.5) * U * 0.3, Y - th); ctx.stroke();
        for (let q = 0; q < 6; q++) { ctx.beginPath(); ctx.ellipse(X + (rnd() - 0.5) * U * 0.7, Y - th * (0.45 + rnd() * 0.6), U * (0.14 + rnd() * 0.14), U * (0.08 + rnd() * 0.08), 0, 0, 6.2832); ctx.fill(); }
      }
    }
    ctx.restore();
  }

  /** 远山层叠：layers 层，由远到近墨色由淡到浓（墨分五色），层与层之间自动加一道云雾。
   *  opts layers（默认 5）, kind: 'range' | 'karst' | 'hills', seed,
   *       from / to（最远一层、最近一层的山脚位置，占画高比例，默认 0.36 / 0.86）, height（山高倍数，默认 1）,
   *       depth: [远, 近]（视差景深，默认 [0.2, 1]）, mist（层间云雾，默认 true）, mistDensity（0～1，默认 0.85）,
   *       peak: { x（0～1）, layer（第几层，默认 1）, h（相对山高，默认 1.5）, w（半宽，u，默认 18） }（加一座主峰，构图用，放在题字的对侧）,
   *       fall（山体往下淡开的长度倍数，默认 1）, body（山体墨量，默认 0.9）, dots（点苔远树，默认 true）, res（计算分辨率，默认 0.5）
   *  返回 { layers, mists, depths, draw(p)（由远到近依次显出）, ridgeY(i, x)（第 i 层在世界坐标 x 处的山脊 y）, peakNear(i, x, range)（附近最高的山顶 [x, y]） }。
   *  每层都在创建时画好，render 里只做位移和透明度。层数越多越慢，一般 3～5 层。 */
  function mountains(st, o = {}) {
    const n = Math.max(1, o.layers || 5), kind = o.kind || 'range', seed = o.seed ?? 3, res = o.res || 0.5;
    const yA = o.from ?? 0.36, yB = o.to ?? 0.86, hK = o.height ?? 1, dep = o.depth || [0.2, 1];
    const out = { layers: [], mists: [], ridges: [], depths: [] };
    for (let i = 0; i < n; i++) {
      const k = n === 1 ? 1 : i / (n - 1), depth = lerp(dep[0], dep[1], k), base = lerp(yA, yB, k) * H, s = seed + i * 101;
      const amp = H * lerp(0.15, 0.24, k) * hK * (0.8 + 0.4 * S.rng(s)()) * (kind === 'karst' ? 1.45 : kind === 'hills' ? 0.75 : 1);
      const fall = amp * (kind === 'karst' ? 0.6 : kind === 'hills' ? 0.7 : 0.4) * (o.fall ?? 1);
      const rf0 = ridgeFn(kind, s, base, amp), pk = o.peak && (o.peak.layer ?? 1) === i ? o.peak : null;
      const rf = !pk ? rf0 : X => {
        const dx = (X - pk.x * W) / (U * (pk.w || 18));
        if (dx <= -1 || dx >= 1) return rf0(X);
        const ax = Math.abs(dx), crag = 1 - Math.abs(n1(s + 4, X / (U * 5))) * 0.22 - Math.abs(n1(s + 6, X / (U * 1.6))) * 0.06;
        return Math.min(rf0(X), base - amp * (pk.h || 1.5) * Math.pow(1 - Math.pow(ax, 1.5), 1.7) * crag);
      };
      const ff = X => rf(X) + amp * (0.22 + 0.28 * (n1(s + 5, X / (U * 16)) * 0.5 + 0.5)) * (kind === 'hills' ? 0.6 : 1);
      const m = st.margin(depth), x0 = -m.x, wc = W + 2 * m.x;
      const yTop = Math.floor(base - amp * Math.max(1.12, pk ? (pk.h || 1.5) * 1.05 : 0) - U * 3), yBot = Math.ceil(Math.min(H + m.y, base + fall * 4.5));
      const level = lerp(P.level[0], P.level[1], Math.pow(k, 0.85));
      const ridgeC = mix(P.ridge[0], P.ridge[1], k), bodyC = mix(P.body[0], P.body[1], k);
      const cv = paintLayer({ x0, y0: yTop, wc, hc: yBot - yTop, res, ridge: rf, fold: ff, fall, edgeW: U * lerp(0.9, 0.38, k),
        ridgeC, bodyC, alpha: level, seed: s, foldK: lerp(0.3, 0.55, k), body: o.body ?? 0.9, base: base - yTop, amp });
      if (o.dots !== false && k > 0.45) decorate(cv, res, x0, yTop, rf, amp, k, s, ridgeC, level);
      out.layers.push(st.addLayer(cv, { x: x0, y: yTop, w: wc, h: yBot - yTop, depth }));
      out.ridges.push(rf); out.depths.push(depth);
      if (o.mist !== false && i < n - 1)
        out.mists.push(mist(st, { y: base + fall * 0.15, h: fall * 1.3 + U * 5, depth, density: o.mistDensity ?? 0.85, seed: s + 7 }));
    }
    out.ridgeY = (i, x) => out.ridges[i](x);
    /** 第 i 层在世界坐标 x 附近（±range）最高的山顶，返回 [x, y]，用来钉题签、放亭子 */
    out.peakNear = (i, x, range = U * 12) => { let bx = x, by = 1e9; for (let d = -range; d <= range; d += U * 0.4) { const y = out.ridges[i](x + d); if (y < by) { by = y; bx = x + d; } } return [bx, by]; };
    out.draw = p => {
      out.layers.forEach((L, i) => { const q = ease.out(clamp(p * 1.6 - i * 0.6 / n)); L.el.style.opacity = q.toFixed(4); L.offset(0, (1 - q) * U * 1.5); });
      out.mists.forEach((m, i) => m.draw(clamp(p * 1.6 - i * 0.6 / n + 0.2)));
    };
    return out;
  }

  /** 云雾带：纸色的横向雾，缓慢漂移，只改变浓淡（"雾只变密度"）。
   *  opts y（雾带中心）, h（厚度）, depth（景深，和它压住的那层山一致）, density（0～1）, seed, drift（每秒漂移像素，默认 ±0.8u）
   *  返回 { draw(p) }：p 控制显出；漂移和呼吸由 st.set(t) 驱动。每帧都调用 draw（不调用时一直显示） */
  function mist(st, o = {}) {
    const depth = o.depth ?? 0.6, seed = o.seed ?? 5, hh = o.h || U * 12, yc = o.y ?? H * 0.6, dens = o.density ?? 0.8;
    const drift = o.drift ?? U * 0.8 * (seed % 2 ? 1 : -1);
    const m = st.margin(depth), extra = Math.abs(drift) * S.duration + U * 4;
    const x0 = -m.x - extra / 2, wc = W + 2 * m.x + extra, hc = hh * 2.2, y0 = yc - hc / 2, res = 0.2;
    const cw = Math.ceil(wc * res), ch = Math.ceil(hc * res), cv = canvas(cw, ch), ctx = cv.getContext('2d'), img = ctx.createImageData(cw, ch);
    const [mr, mg, mb] = hex(P.mist);
    for (let j = 0; j < ch; j++) for (let i = 0; i < cw; i++) {
      const X = x0 + (i + 0.5) / res, Y = (j + 0.5) / res, v = Math.exp(-Math.pow((Y - hc / 2) / (hh * 0.5), 2));
      const nz = fbm2(X / (U * 24), Y / (U * 4.5), seed, 3);
      const a = v * sm(-0.5, 0.5, nz + (v - 0.5) * 0.7), k = (j * cw + i) * 4;
      img.data[k] = mr; img.data[k + 1] = mg; img.data[k + 2] = mb; img.data[k + 3] = a * 255;
    }
    ctx.putImageData(img, 0, 0);
    const L = st.addLayer(cv, { x: x0, y: y0, w: wc, h: hc, depth, dx: t => drift * (t - S.duration / 2) });
    let vis = 1;
    const apply = () => { L.el.style.opacity = (vis * dens * (0.8 + 0.2 * n1(seed + 3, st.cam.t * 0.35))).toFixed(4); };
    st.tick(apply);
    return { L, draw(p) { vis = ease.out(clamp(p)); apply(); } };
  }

  /** 水面：水线以下铺回纸色（山脚落在水上），近山倒影（逐行错开做波纹），再加几笔水纹缓慢漂移。
   *  opts y（水线，默认 0.74H）, mountains（mountains 的返回值，用来做倒影）, layer（倒影取第几层，默认最近一层）,
   *       reflect（倒影浓度，默认 0.32）, lines（水纹笔数，默认 40）, seed
   *  返回 { y, draw(p) } */
  function water(st, o = {}) {
    const y = o.y ?? H * 0.74, seed = o.seed ?? 41, rnd = S.rng(seed);
    const top0 = Math.floor(y - U * 2.5), ch0 = H - top0;
    const cover = canvas(W, ch0), cx = cover.getContext('2d');
    cx.drawImage(st.paper, 0, top0, W, ch0, 0, 0, W, ch0);
    const gm = cx.createLinearGradient(0, 0, 0, U * 3);
    gm.addColorStop(0, 'rgba(0,0,0,0)'); gm.addColorStop(1, 'rgba(0,0,0,1)');
    cx.globalCompositeOperation = 'destination-in'; cx.fillStyle = gm; cx.fillRect(0, 0, W, ch0);
    st.addLayer(cover, { x: 0, y: top0, w: W, h: ch0, depth: 0 });
    let refl = null;
    if (o.mountains) {
      const src = o.mountains.layers[o.layer ?? o.mountains.layers.length - 1], sc = src.el.width / src.w;
      const rh = Math.ceil(Math.min(H - y + U * 4, (y - src.y) * 0.9)), rc = canvas(src.el.width, rh * sc), rx = rc.getContext('2d');
      const rows = Math.floor(rh * sc), srow0 = (y - src.y) * sc;
      for (let r = 0; r < rows; r++) {
        const sr = Math.floor(srow0 - r - 1);
        if (sr < 0) break;
        const depthK = r / rows, off = (Math.sin(r * 0.9 + seed) * 0.6 + n1(seed, r * 0.15)) * U * 0.45 * sc * (0.25 + depthK);
        rx.globalAlpha = (o.reflect ?? 0.32) * Math.pow(1 - depthK, 1.3);
        rx.drawImage(src.el, 0, sr, src.el.width, 1, off, r, src.el.width, 1);
      }
      refl = st.addLayer(rc, { x: src.x, y, w: src.w, h: rh, depth: src.depth });
    }
    const m = st.margin(1), lw = W + 2 * m.x + U * 10, lc = canvas(lw, H - y), lx = lc.getContext('2d');
    lx.strokeStyle = P.ink; lx.lineCap = 'round';
    const nl = o.lines ?? 40;
    for (let i = 0; i < nl; i++) {
      const yy = Math.pow(rnd(), 0.8) * (H - y - U * 2) + U * 1.2, len = U * (2 + rnd() * 9) * (0.6 + yy / (H - y)), x = rnd() * lw;
      lx.globalAlpha = 0.10 + rnd() * 0.22; lx.lineWidth = U * (0.08 + rnd() * 0.14);
      lx.beginPath(); lx.moveTo(x, yy); lx.quadraticCurveTo(x + len / 2, yy - U * (0.1 + rnd() * 0.25), x + len, yy + U * 0.05); lx.stroke();
    }
    const lines = st.addLayer(lc, { x: -m.x - U * 5, y, w: lw, h: H - y, depth: 1, dx: t => U * 0.35 * t });
    return { y, draw(p) { const q = ease.out(clamp(p)).toFixed(4); if (refl) refl.el.style.opacity = q; lines.el.style.opacity = q; } };
  }

  /** 月或日：烘云托月（月轮留白，周围一圈淡墨）；朱金调板下是一轮淡金日。opts x, y, r（默认 5u）, depth（默认 0.1）, kind: 'moon' | 'sun'
   *  draw(p)：缓缓升起并显出 */
  function moon(st, o = {}) {
    const r = o.r || U * 5, depth = o.depth ?? 0.1, sun = (o.kind || (P === PALETTES.zhujin ? 'sun' : 'moon')) === 'sun';
    const size = Math.ceil(r * 5.6), c = size / 2, cv = canvas(size, size), ctx = cv.getContext('2d');
    const halo = ctx.createRadialGradient(c, c, r * 0.96, c, c, size / 2);
    if (sun) { halo.addColorStop(0, rgba(P.moon, 0.32)); halo.addColorStop(0.4, rgba(P.moon, 0.10)); halo.addColorStop(1, rgba(P.moon, 0)); }
    else { halo.addColorStop(0, rgba(P.ink, 0.13)); halo.addColorStop(0.25, rgba(P.ink, 0.05)); halo.addColorStop(1, rgba(P.ink, 0)); }
    ctx.fillStyle = halo; ctx.fillRect(0, 0, size, size);
    const disc = ctx.createRadialGradient(c - r * 0.3, c - r * 0.3, 0, c, c, r);
    disc.addColorStop(0, sun ? mix(P.moon, '#FFFFFF', 0.25) : '#FFFFFF'); disc.addColorStop(1, sun ? P.moon : P.moon);
    ctx.globalAlpha = sun ? 0.85 : 1; ctx.fillStyle = disc; ctx.beginPath(); ctx.arc(c, c, r, 0, 6.2832); ctx.fill();
    const x = o.x ?? W * 0.25, y = o.y ?? H * 0.25;
    const L = st.addLayer(cv, { x: x - c, y: y - c, w: size, h: size, depth });
    return { L, draw(p) { const q = ease.out(clamp(p)); L.el.style.opacity = q.toFixed(4); L.offset(0, (1 - q) * U * 5); } };
  }

  // ---------------------------------------------------------------------------------------------
  const defsOf = g => { const svg = g.ownerSVGElement || g; if (!svg.__ssDefs) svg.__ssDefs = el('defs', {}, svg); return svg.__ssDefs; };
  const softGrad = g => {
    const svg = g.ownerSVGElement || g;
    if (svg.__ssSoft) return svg.__ssSoft;
    const rg = el('radialGradient', { id: id('sg') }, defsOf(g));
    el('stop', { offset: 0, 'stop-color': '#fff', 'stop-opacity': 1 }, rg);
    el('stop', { offset: 0.62, 'stop-color': '#fff', 'stop-opacity': 1 }, rg);
    el('stop', { offset: 1, 'stop-color': '#fff', 'stop-opacity': 0 }, rg);
    svg.__ssSoft = rg.id;
    return rg.id;
  };
  const PUNCT = /[，。、；：！？,.;:!?\s·・《》〈〉「」『』“”"'（）()—…-]/;
  const vchars = s => Array.from(String(s)).filter(c => !PUNCT.test(c));   // 竖排去掉标点

  /** 一组单字：每个字的填充是一个以字心为圆心的径向渐变，半径从 0 长到盖住整个字，墨色从中心晕开；外加一圈淡墨洇边。
   *  （不用 SVG mask：mask 在局部重绘时边缘像素会和整帧重绘不一致）返回每个字的 set(q) */
  function inkChars(g, items, size, font, color, weight) {
    const defs = defsOf(g);
    return items.map(({ x, y, ch }) => {
      const gr = el('radialGradient', { id: id('cg'), gradientUnits: 'userSpaceOnUse', cx: f2(x), cy: f2(y), r: 0 }, defs);
      el('stop', { offset: 0, 'stop-color': color, 'stop-opacity': 1 }, gr);
      el('stop', { offset: 0.6, 'stop-color': color, 'stop-opacity': 1 }, gr);
      el('stop', { offset: 1, 'stop-color': color, 'stop-opacity': 0 }, gr);
      const cg = el('g', { opacity: 0 }, g);
      // 书法字形常常超出字框：垫一块几乎透明的方块，让重绘范围盖住整个字（否则局部重绘会留下残影）
      el('rect', { x: f2(x - size * 0.9), y: f2(y - size * 0.9), width: f2(size * 1.8), height: f2(size * 1.8), fill: '#000', 'fill-opacity': 0.002 }, cg);
      const base = { x, y, 'font-size': size, 'font-family': font, 'font-weight': weight || 400, 'text-anchor': 'middle', 'dominant-baseline': 'central' };
      const bleed = el('text', { ...base, fill: 'none', stroke: `url(#${gr.id})`, 'stroke-width': f2(size * 0.035), 'stroke-linejoin': 'round', 'stroke-opacity': 0, 'data-qa': 'ignore' }, cg);
      bleed.textContent = ch;
      const t = el('text', { ...base, fill: `url(#${gr.id})` }, cg);
      t.textContent = ch;
      return {
        set(q) {
          const k = ease.out(clamp(q)), done = q >= 1;
          cg.setAttribute('opacity', q > 0 ? 1 : 0);
          gr.setAttribute('r', f2(size * 1.25 * k));
          t.setAttribute('fill', done ? color : `url(#${gr.id})`);
          bleed.setAttribute('stroke', done ? color : `url(#${gr.id})`);
          bleed.setAttribute('stroke-opacity', f2(0.32 * k * (1 - 0.85 * k) + 0.04 * k));
          const sc = 1.05 - 0.05 * k;
          cg.setAttribute('transform', `translate(${f2(x)} ${f2(y)}) scale(${sc.toFixed(4)}) translate(${f2(-x)} ${f2(-y)})`);
        },
      };
    });
  }

  /** 横排说明文字（宋体）：opts x, y（基线）, text, size（默认 3.6u）, color（默认 ink2）, anchor, weight, font: 'serif' | 'brush' | 'sans', spacing（字距，em）
   *  draw(p) 淡入上浮；set(text) 改文字 */
  function label(into, o) {
    const size = o.size || U * 3.6;
    const e = el('text', { x: o.x, y: o.y, 'font-size': size, 'font-weight': o.weight || (o.font === 'brush' ? 400 : 600), fill: o.color || P.ink2,
      'font-family': o.font === 'brush' ? FONT.brush : o.font === 'sans' ? FONT.sans : FONT.serif, 'text-anchor': o.anchor || 'start', 'letter-spacing': f2((o.spacing ?? 0.08) * size) }, into);
    e.textContent = o.text;
    const api = { el: e,
      draw(p) { const k = ease.out(clamp(p)); e.setAttribute('opacity', f2(k)); e.setAttribute('transform', `translate(0 ${f2((1 - k) * U * 1)})`); },
      set(text) { if (e.textContent !== text) e.textContent = text; } };
    api.draw(0);
    return api;
  }

  /** 页面标题（横排宋体，逐字墨色晕开）：自动放在安全区左上角（或居中、靠右）。
   *  opts text, size（默认 6u）, sub（副标题）, align: 'left' | 'center' | 'right', font: 'serif' | 'brush', rule（标题下一笔淡墨，默认 true）
   *  返回 { bottom（标题区下沿 y，内容从这里往下排）, draw(p) } */
  function heading(into, o) {
    const size = o.size || U * 6, align = o.align || 'left', brush = o.font === 'brush', font = brush ? FONT.brush : FONT.serif;
    const x = align === 'center' ? W / 2 : align === 'right' ? S.safe.x + S.safe.w - U * 3 : S.safe.x + U * 3;
    const anchor = { left: 'start', center: 'middle', right: 'end' }[align] || 'start';
    const y = S.safe.y + U * 1.5 + size * 1.05;
    const g = el('g', {}, into), chars = Array.from(o.text), spc = o.spacing ?? 0.12;
    const base = { x, y, 'font-size': size, 'font-family': font, 'font-weight': brush ? 400 : 600, 'text-anchor': anchor, 'letter-spacing': f2(size * spc) };
    const bleed = el('text', { ...base, fill: 'none', stroke: P.ink, 'stroke-width': f2(size * 0.05), 'stroke-linejoin': 'round', 'data-qa': 'ignore' }, g);
    const main = el('text', { ...base, fill: o.color || P.ink }, g);
    const tb = chars.map(ch => { const s = el('tspan', {}, bleed); s.textContent = ch; return s; });
    const tm = chars.map(ch => { const s = el('tspan', {}, main); s.textContent = ch; return s; });
    const tw = chars.reduce((a, ch) => a + (isWide(ch) ? 1 : 0.55), 0) * size + (chars.length - 1) * size * spc;
    const x0 = anchor === 'start' ? x : anchor === 'middle' ? x - tw / 2 : x - tw;
    const ruleY = y + size * 0.42;
    const rule = o.rule !== false ? stroke(g, { pts: [[x0, ruleY + U * 0.2], [x0 + tw * 0.45, ruleY - U * 0.15], [x0 + Math.min(tw, U * 30) * 1.0, ruleY + U * 0.1]], w: U * 0.55, dry: 0.7, opacity: 0.55, seed: 3, taper: [0.04, 0.5] }) : null;
    const subY = ruleY + U * 1.2 + (o.subSize || U * 3.6) * 1.05;
    const sub = o.sub ? label(g, { x, y: subY, text: o.sub, size: o.subSize || U * 3.6, anchor, color: P.ink2 }) : null;
    const api = {
      g, bottom: sub ? subY + U * 1.8 : ruleY + U * 2, left: x0, right: x0 + tw,
      draw(p) {
        const n = chars.length, step = 0.35, cd = 1 / (1 + (n - 1) * step);
        chars.forEach((_, i) => {
          const q = clamp((p * 1.15 - i * step * cd) / cd), k = ease.out(q);
          tm[i].setAttribute('fill-opacity', f2(k));
          tb[i].setAttribute('stroke-opacity', f2(0.28 * k * (1 - 0.7 * k) + 0.05 * k));
        });
        if (rule) rule.draw(ease.inOut(clamp(p * 1.4 - 0.35)));
        if (sub) sub.draw(clamp(p * 1.6 - 0.6));
      },
    };
    api.draw(0);
    return api;
  }

  /** 竖排书法大字（默认马善政毛笔楷书）：自上而下逐字墨晕显出。去掉标点。
   *  opts x（这一列的中心）, y（第一个字的上沿）, text（建议 2～6 字）, size（默认 10u）, lead（字距倍数，默认 1.16）, font: 'brush' | 'serif', color
   *  返回 { x, y, w, h, left, right, bottom, draw(p) }：p 从 0 到 1 写完整列，建议用线性进度 seg(t, a, b, ease.linear)，每字 0.25～0.4 秒 */
  function vtitle(into, o) {
    const size = o.size || U * 10, lead = o.lead || 1.16, font = o.font === 'serif' ? FONT.serif : FONT.brush;
    const chars = vchars(o.text), x = o.x, y = o.y;
    const g = el('g', {}, into);
    const cs = inkChars(g, chars.map((ch, i) => ({ x, y: y + size * (0.5 + i * lead), ch })), size, font, o.color || P.ink, o.font === 'serif' ? 600 : 400);
    const h = size * (lead * (chars.length - 1) + 1);
    const api = { g, x, y, w: size, h, left: x - size / 2, right: x + size / 2, bottom: y + h,
      draw(p) { const n = cs.length, step = 0.55, cd = 1 / (1 + (n - 1) * step); cs.forEach((c, i) => c.set((p - i * step * cd) / cd)); } };
    api.draw(0);
    return api;
  }

  /** 竖排诗句：从右列起读，每字间隔 step（默认 0.42 秒），换列多停 pause（默认 0.3 秒），去掉标点。
   *  opts lines（数组或用 \n 分列）, x（最右一列的中心）, y（上沿）, size（默认 7.5u）, lead（默认 1.18）, colGap（列距，默认 1.6 倍字号）,
   *       step, pause, charDur（单字晕开时长，默认 0.6 秒）, font: 'brush' | 'serif', color
   *  返回 { duration（整首写完需要的秒数）, left, right, bottom, play(t, start), draw(p) }：用 play(t, 开始秒) 按真实节奏逐字写出 */
  function verse(into, o) {
    const size = o.size || U * 7.5, lead = o.lead || 1.18, gap = o.colGap || size * 1.6, font = o.font === 'serif' ? FONT.serif : FONT.brush;
    const step = o.step ?? 0.42, pause = o.pause ?? 0.3, cd = o.charDur ?? 0.6;
    const cols = (Array.isArray(o.lines) ? o.lines : String(o.lines).split('\n')).map(vchars).filter(c => c.length);
    const items = [], times = [];
    let k = 0;
    cols.forEach((col, ci) => col.forEach((ch, i) => { items.push({ x: o.x - ci * gap, y: o.y + size * (0.5 + i * lead), ch }); times.push(k * step + ci * pause); k++; }));
    const g = el('g', {}, into);
    const cs = inkChars(g, items, size, font, o.color || P.ink, o.font === 'serif' ? 600 : 400);
    const maxLen = Math.max(...cols.map(c => c.length)), h = size * (lead * (maxLen - 1) + 1);
    const duration = (times[times.length - 1] || 0) + cd;
    const api = { g, duration, left: o.x - (cols.length - 1) * gap - size / 2, right: o.x + size / 2, top: o.y, bottom: o.y + h, h,
      play(t, start = 0) { const lt = t - start; cs.forEach((c, i) => c.set((lt - times[i]) / cd)); },
      draw(p) { api.play(clamp(p) * duration, 0); } };
    api.draw(0);
    return api;
  }

  /** 题款：竖排小字（宋体），可多列（\n 分列，从右往左）。opts x（最右一列中心）, y（上沿）, text, size（默认 3.6u）, lead（默认 1.22）, color
   *  返回 { left, right, bottom, draw(p) }；印章另建（SS.seal），一般压在题款末尾下方：y = ins.bottom + 印高的一半 + 1u */
  function inscription(into, o) {
    const size = o.size || U * 3.6, lead = o.lead || 1.22, gap = o.colGap || size * 1.6;
    const cols = (Array.isArray(o.text) ? o.text : String(o.text).split('\n')).map(vchars).filter(c => c.length);
    const g = el('g', {}, into), els = [];
    cols.forEach((col, ci) => col.forEach((ch, i) => {
      const e = el('text', { x: o.x - ci * gap, y: o.y + size * (0.5 + i * lead), 'font-size': size, 'font-family': o.font === 'brush' ? FONT.brush : FONT.serif,
        'font-weight': o.font === 'brush' ? 400 : 600, fill: o.color || P.ink2, 'text-anchor': 'middle', 'dominant-baseline': 'central' }, g);
      e.textContent = ch; els.push(e);
    }));
    const maxLen = Math.max(...cols.map(c => c.length));
    const api = { g, left: o.x - (cols.length - 1) * gap - size / 2, right: o.x + size / 2, bottom: o.y + size * (lead * (maxLen - 1) + 1),
      draw(p) { const n = els.length; els.forEach((e, i) => { const k = ease.out(clamp(p * (1 + n * 0.15) - i * 0.15)); e.setAttribute('opacity', f2(k)); }); } };
    api.draw(0);
    return api;
  }

  /** 印章（朱砂，全片唯一的红）：opts x, y（中心）, text（1、2、4 字最好；4 字按右列先读排）, size（印高，默认 6u）,
   *       kind: 'bai'（白文：红底白字，默认）| 'zhu'（朱文：红字红边）, rot（旋转角度，默认随 seed 在 ±2° 内）, seed
   *  draw(p)：钤印，从 1.5 倍压到 1 倍，建议 0.3～0.4 秒：seal.draw(seg(t, a, a + 0.35)) */
  function seal(into, o) {
    const size = o.size || U * 6, kind = o.kind || 'bai', chars = Array.from(o.text || '山水').slice(0, 4), n = chars.length;
    const color = o.color || P.seal, seed = o.seed ?? 7, rnd = S.rng(seed * 97 + 3);
    const h = size, w = n === 2 ? size * 0.64 : size, rot = o.rot ?? (rnd() - 0.5) * 4;
    const cells = n === 1 ? [[0, 0, 0.7]] : n === 2 ? [[0, -0.24, 0.44], [0, 0.24, 0.44]]
      : n === 3 ? [[0.24, -0.24, 0.42], [0.24, 0.24, 0.42], [-0.24, 0, 0.42]] : [[0.24, -0.24, 0.42], [0.24, 0.24, 0.42], [-0.24, -0.24, 0.42], [-0.24, 0.24, 0.42]];
    const g = el('g', { opacity: 0 }, into);
    // 不规则的印边
    const rough = (inset, amp) => {
      const pts = [], x0 = -w / 2 + inset, y0 = -h / 2 + inset, x1 = w / 2 - inset, y1 = h / 2 - inset, k = 7;
      const edge = (ax, ay, bx, by) => { for (let i = 0; i < k; i++) { const q = i / k; pts.push([lerp(ax, bx, q) + (rnd() - 0.5) * amp, lerp(ay, by, q) + (rnd() - 0.5) * amp]); } };
      edge(x0, y0, x1, y0); edge(x1, y0, x1, y1); edge(x1, y1, x0, y1); edge(x0, y1, x0, y0);
      return 'M ' + pts.map(q => q.map(f2).join(' ')).join(' L ') + ' Z';
    };
    const glyph = (into2, fill) => cells.slice(0, n).forEach(([cx, cy, fs], i) => {
      const t = el('text', { x: f2(cx * w * (n === 2 ? 0 : 1)), y: f2(cy * h), 'font-size': f2(fs * h), 'font-family': FONT.serif, 'font-weight': 600, fill,
        'text-anchor': 'middle', 'dominant-baseline': 'central' }, into2);
      t.textContent = chars[i];
    });
    // 白文：红底 + 纸色的字；朱文：红边 + 红字。最后撒一些纸色小点，像没吃上印泥（不用 mask，见 inkChars 的说明）
    if (kind === 'bai') {
      el('path', { d: rough(0, U * 0.22), fill: color }, g);
      glyph(g, P.paper);
    } else {
      el('path', { d: rough(U * 0.2, U * 0.18), fill: 'none', stroke: color, 'stroke-width': f2(size * 0.07), 'stroke-linejoin': 'round' }, g);
      glyph(g, color);
    }
    for (let i = 0; i < 16; i++) el('circle', { cx: f2((rnd() - 0.5) * w * 0.98), cy: f2((rnd() - 0.5) * h * 0.98), r: f2(U * (0.08 + rnd() * 0.2)), fill: P.paper }, g);
    const api = { g, w, h,
      draw(p) {
        const k = ease.out(clamp(p)), s = lerp(1.5, 1, k);
        g.setAttribute('opacity', f2(clamp(p * 3)));
        g.setAttribute('transform', `translate(${f2(o.x)} ${f2(o.y)}) rotate(${f2(rot)}) scale(${s.toFixed(4)})`);
      } };
    api.draw(0);
    return api;
  }

  /** 地名题签：竖条小签 + 细引线，钉在某层景物的世界坐标上，跟着镜头走；靠近安全区边缘时自动淡出（不会出框）。
   *  opts x, y（引线落点的世界坐标，比如某座山的山顶）, depth（和那层山一致）, text（2～5 字）, size（默认 3.6u）, leader（引线长，默认 5u）
   *  draw(p)：必须在 st.set(t) 之后调用 */
  function marker(st, o) {
    const size = o.size || U * 3.6, depth = o.depth ?? 1, chars = vchars(o.text), lead = 1.18, padX = size * 0.42, padY = size * 0.5;
    const sw = size + padX * 2, sh = size * (lead * (chars.length - 1) + 1) + padY * 2, ll = o.leader ?? U * 5;
    const g = el('g', { opacity: 0 }, o.into || st.hud);
    el('circle', { cx: 0, cy: 0, r: f2(U * 0.35), fill: P.ink }, g);
    el('line', { x1: 0, y1: 0, x2: 0, y2: f2(-ll), stroke: P.ink, 'stroke-width': f2(U * 0.14) }, g);
    const bx = -sw / 2, by = -ll - sh;
    el('rect', { x: f2(bx), y: f2(by), width: f2(sw), height: f2(sh), fill: rgba(mix(P.paper, '#FFFFFF', 0.4), 0.94), stroke: P.ink, 'stroke-width': f2(U * 0.13) }, g);
    el('rect', { x: f2(bx + U * 0.4), y: f2(by + U * 0.4), width: f2(sw - U * 0.8), height: f2(sh - U * 0.8), fill: 'none', stroke: P.ink, 'stroke-opacity': 0.45, 'stroke-width': f2(U * 0.06) }, g);
    chars.forEach((ch, i) => {
      const e = el('text', { x: 0, y: f2(by + padY + size * (0.5 + i * lead)), 'font-size': size, 'font-family': FONT.serif, 'font-weight': 600, fill: P.ink,
        'text-anchor': 'middle', 'dominant-baseline': 'central' }, g);
      e.textContent = ch;
    });
    const sf = S.safe;
    const api = { g, w: sw, h: sh + ll,
      draw(p) {
        const [sx, sy] = st.project(o.x, o.y, depth);
        const room = Math.min(sx - sw / 2 - sf.x, sf.x + sf.w - sx - sw / 2, sy - ll - sh - sf.y, sf.y + sf.h - sy);
        const fade = clamp(room / (U * 4));
        g.setAttribute('opacity', f2(ease.out(clamp(p)) * fade));
        g.setAttribute('transform', `translate(${f2(sx)} ${f2(sy + (1 - ease.out(clamp(p))) * U * 1.2)})`);
      } };
    return api;
  }

  // ---------------------------------------------------------------------------------------------
  /** Catmull-Rom 样条采样：按 step 像素取点 */
  function sampleSpline(pts, step) {
    const out = [], at = i => pts[Math.max(0, Math.min(pts.length - 1, i))];
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
      const n = Math.max(2, Math.ceil(Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) / step));
      for (let k = 0; k < n; k++) {
        const t = k / n, t2 = t * t, t3 = t2 * t;
        const c = j => 0.5 * (2 * p1[j] + (-p0[j] + p2[j]) * t + (2 * p0[j] - 5 * p1[j] + 4 * p2[j] - p3[j]) * t2 + (-p0[j] + 3 * p1[j] - 3 * p2[j] + p3[j]) * t3);
        out.push([c(0), c(1)]);
      }
    }
    out.push(pts[pts.length - 1].slice());
    return out;
  }

  /** 毛笔笔触：沿控制点生长，起笔略顿、行笔有轻微起伏、收锋变细；越往后越干，出现飞白（纸色的丝）。
   *  opts pts:[[x, y], ...]（控制点，至少 2 个）, w（最粗处宽度，默认 1.2u）, dry（0～1，飞白程度，默认 0.35）,
   *       taper: [起笔长度, 收锋长度]（占全长比例，默认 [0.06, 0.3]）, color, opacity（默认 0.92）, wet（洇边浓度，默认 0.12）, seed
   *  draw(p)：p 从 0 到 1 画完；返回 { g, length, draw } */
  function stroke(into, o) {
    const w = o.w || U * 1.2, color = o.color || P.ink, seed = o.seed ?? 1, dry = o.dry ?? 0.35, taper = o.taper || [0.06, 0.3];
    const sp = sampleSpline(o.pts, Math.max(1, U * 0.3)), N = sp.length, cum = [0];
    for (let i = 1; i < N; i++) cum.push(cum[i - 1] + Math.hypot(sp[i][0] - sp[i - 1][0], sp[i][1] - sp[i - 1][1]));
    const len = cum[N - 1] || 1;
    const Lp = [], Rp = [], Wd = [], Nx = [], Ny = [];
    for (let i = 0; i < N; i++) {
      const s = cum[i] / len, a = sp[Math.max(0, i - 1)], b = sp[Math.min(N - 1, i + 1)];
      let tx = b[0] - a[0], ty = b[1] - a[1]; const tl = Math.hypot(tx, ty) || 1; tx /= tl; ty /= tl;
      const head = sm(0, taper[0] + 1e-3, s), bulb = 1 + 0.18 * Math.exp(-Math.pow((s - taper[0]) / (taper[0] * 0.8 + 0.02), 2));
      const tail = Math.max(0.03, 1 - Math.pow(sm(1 - taper[1], 1, s), 1.2)), wob = 1 + 0.12 * n1(seed, s * 5);
      const ww = w * Math.max(0.02, (0.3 + 0.7 * head) * bulb * tail * wob);
      const jl = 1 + 0.08 * n1(seed + 11, cum[i] / (U * 0.6)), jr = 1 + 0.08 * n1(seed + 13, cum[i] / (U * 0.6));
      const nx = -ty, ny = tx;
      Lp.push([sp[i][0] + nx * ww / 2 * jl, sp[i][1] + ny * ww / 2 * jl]); Rp.push([sp[i][0] - nx * ww / 2 * jr, sp[i][1] - ny * ww / 2 * jr]);
      Wd.push(ww); Nx.push(nx); Ny.push(ny);
    }
    // 飞白：若干条顺着笔势的纸色细丝，越到笔尾越多
    const lanes = [], B = 11, lr = S.rng(seed * 17 + 3);
    for (let b = 0; b < B && dry > 0; b++) {
      const u = ((b + 0.5) / B - 0.5) * 0.9, edgeBias = 0.2 + 0.8 * Math.abs(u) / 0.45, segs = [];
      const freq = U * (1.2 + lr() * 2.5), lw = 0.25 + lr() * 0.75;
      let cur = null;
      for (let i = 0; i < N; i++) {
        const s = cum[i] / len, thr = 1 - dry * 1.7 * edgeBias * sm(0.18, 1, s);
        const on = n1(seed + 50 + b * 7, cum[i] / freq) > thr;
        if (on && !cur) { cur = [i, i]; segs.push(cur); } else if (on) cur[1] = i; else cur = null;
      }
      lanes.push({ u, segs, lw });
    }
    const g = el('g', {}, into);
    const wet = el('path', { fill: 'none', stroke: color, 'stroke-opacity': o.wet ?? 0.12, 'stroke-width': f2(w * 0.32), 'stroke-linejoin': 'round' }, g);
    const body = el('path', { fill: color, 'fill-opacity': o.opacity ?? 0.92 }, g);
    const gapEls = [0.28, 0.6].map(k => el('path', { fill: 'none', stroke: o.paper || P.paper, 'stroke-opacity': 0.8, 'stroke-width': f2(Math.max(0.5, w / B * k)), 'stroke-linecap': 'butt' }, g));
    const pt = q => `${f2(q[0])} ${f2(q[1])}`;
    const api = { g, length: len,
      draw(p) {
        p = clamp(p);
        if (p <= 0) { body.setAttribute('d', ''); wet.setAttribute('d', ''); gapEls.forEach(e => e.setAttribute('d', '')); return; }
        const kf = p * (N - 1), k = Math.floor(kf), fr = kf - k;
        const L = Lp.slice(0, k + 1), R = Rp.slice(0, k + 1);
        if (k < N - 1 && fr > 0) { L.push([lerp(Lp[k][0], Lp[k + 1][0], fr), lerp(Lp[k][1], Lp[k + 1][1], fr)]); R.push([lerp(Rp[k][0], Rp[k + 1][0], fr), lerp(Rp[k][1], Rp[k + 1][1], fr)]); }
        const d = 'M ' + L.map(pt).join(' L ') + ' L ' + R.reverse().map(pt).join(' L ') + ' Z';
        body.setAttribute('d', d); wet.setAttribute('d', d);
        const gd = ['', ''];
        for (const ln of lanes) for (const [a, b] of ln.segs) {
          if (a > k) continue;
          const e = Math.min(b, k);
          if (e <= a) continue;
          gd[ln.lw < 0.55 ? 0 : 1] += 'M ' + Array.from({ length: e - a + 1 }, (_, j) => { const i = a + j, off = ln.u * Wd[i]; return pt([sp[i][0] + Nx[i] * off, sp[i][1] + Ny[i] * off]); }).join(' L ') + ' ';
        }
        gapEls.forEach((el2, i) => el2.setAttribute('d', gd[i]));
      } };
    api.draw(0);
    return api;
  }

  /** 横扫一笔浓墨（压在标题、行动号召下面当底）：由几十根"笔毛"组成，边缘参差，笔尾散开、出现飞白；飞白只在后 35%，不会切到压在上面的字。
   *  opts x, y（笔画中线的起点）, w（长度）, h（粗细，默认 7u）, dry（飞白程度，默认 0.6）, color, opacity（默认 0.92）, seed, bend（弯度，默认 0.06）
   *  draw(p)：从左往右扫出。字压在上面时，用纸色（SS.C.paper），放在笔画前 65% 的范围内 */
  function inkSweep(into, o) {
    const w = o.w || U * 30, h = o.h || U * 7, x = o.x, y = o.y, seed = o.seed ?? 9, dry = o.dry ?? 0.6, bend = o.bend ?? 0.06, rnd = S.rng(seed * 53 + 1);
    const color = o.color || P.ink, op = o.opacity ?? 0.92;
    const sp = sampleSpline([[x, y + h * bend], [x + w * 0.35, y - h * bend * 0.6], [x + w * 0.7, y + h * bend * 0.4], [x + w, y - h * bend * 1.2]], Math.max(1, U * 0.4));
    const N = sp.length, Nx = [], Ny = [];
    for (let i = 0; i < N; i++) {
      const a = sp[Math.max(0, i - 1)], b = sp[Math.min(N - 1, i + 1)], tl = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      Nx.push(-(b[1] - a[1]) / tl); Ny.push((b[0] - a[0]) / tl);
    }
    const g = el('g', {}, into), B = 40;
    const hairs = Array.from({ length: B }, (_, k) => {
      const u = (k + 0.5) / B - 0.5, au = Math.abs(u) * 2;
      const s0 = 0.004 + rnd() * 0.012 + au * au * au * 0.05, s1 = 1 - Math.pow(au, 1.3) * 0.38 - rnd() * 0.16;
      const hw = h / B * (1.4 + rnd() * 1.2), wob = rnd() * 9;
      const segs = [];
      let cur = null;
      for (let i = 0; i < N; i++) {
        const s = i / (N - 1);
        if (s < s0 || s > s1) { cur = null; continue; }
        const gap = s > 0.65 && n1(seed + k * 13, s * (18 + wob)) > 1 - dry * 1.4 * sm(0.65, 1, s) * (0.6 + au * 0.6);
        if (gap) { cur = null; continue; }
        if (!cur) { cur = [i, i]; segs.push(cur); } else cur[1] = i;
      }
      const path = el('path', { fill: 'none', stroke: color, 'stroke-opacity': f2(op * (0.82 + rnd() * 0.18)), 'stroke-width': f2(hw), 'stroke-linecap': 'butt', 'stroke-linejoin': 'round' }, g);
      const off = i => (u * (0.92 + 0.08 * n1(seed + 5, i * 0.05)) + 0.035 * au * n1(seed + 31 + k, i * 0.09)) * h * (1 - 0.2 * sm(0.6, 1, i / (N - 1)));
      return { path, segs, off };
    });
    const pt = (i, off) => `${f2(sp[i][0] + Nx[i] * off)} ${f2(sp[i][1] + Ny[i] * off)}`;
    const api = { g, length: w,
      draw(p) {
        const k = Math.floor(clamp(p) * (N - 1));
        for (const hr of hairs) {
          let d = '';
          if (p > 0) for (const [a, b] of hr.segs) {
            if (a > k) continue;
            const e = Math.min(b, k);
            if (e <= a) continue;
            d += 'M ' + Array.from({ length: e - a + 1 }, (_, j) => pt(a + j, hr.off(a + j))).join(' L ') + ' ';
          }
          hr.path.setAttribute('d', d);
        }
      } };
    api.draw(0);
    return api;
  }

  /** 墨梅一枝：折枝（梅枝转折有力）+ 小枝 + 圈花和花苞，按枝干 → 小枝 → 开花的顺序长出来。
   *  opts x, y（枝根，可以放在画面外让枝从边上伸进来）, angle（生长方向，度，0 = 向右，-90 = 向上）, len（主枝长，默认 40u）,
   *       w（主枝粗，默认 1.8u）, bloom（花的大小倍数，默认 1）, seed
   *  draw(p)：p 0～0.75 长枝，之后陆续开花 */
  function plum(into, o) {
    const rnd = S.rng((o.seed ?? 5) * 131 + 1), L0 = o.len || U * 40, W0 = o.w || U * 1.8;
    const g = el('g', {}, into), gb = el('g', {}, g), gf = el('g', {}, g);
    const branches = [], flowers = [];
    const grow = (x, y, ang, len, w, level, t0, dur) => {
      const segs = 3 + Math.floor(rnd() * 2), pts = [[x, y]];
      let a = ang, cx = x, cy = y;
      for (let s = 0; s < segs; s++) { a += (s % 2 ? 1 : -1) * (0.2 + rnd() * 0.3); const sl = len / segs * (0.75 + rnd() * 0.5); cx += Math.cos(a) * sl; cy += Math.sin(a) * sl; pts.push([cx, cy]); }
      branches.push({ st: stroke(gb, { pts, w, dry: level === 0 ? 0.45 : 0.25, taper: [0.02, level === 0 ? 0.3 : 0.55], seed: Math.floor(rnd() * 997), opacity: 0.94, wet: 0.1 }), t0, t1: t0 + dur });
      if (level < 2) {
        const nc = level === 0 ? 3 : 2;
        for (let c = 0; c < nc; c++) {
          const at = 1 + Math.floor(rnd() * (segs - 1)), side = (c % 2 ? 1 : -1) * (0.55 + rnd() * 0.45);
          grow(pts[at][0], pts[at][1], ang + side, len * (0.36 + rnd() * 0.22), w * 0.52, level + 1, t0 + dur * at / segs, dur * 0.7);
        }
      }
      const nf = level === 0 ? 1 : 2;
      for (let f = 0; f < nf; f++) {
        const at = f === nf - 1 ? segs : 1 + Math.floor(rnd() * segs);
        flowers.push({ x: pts[at][0] + (rnd() - 0.5) * U * 1.4, y: pts[at][1] + (rnd() - 0.5) * U * 1.4, r: U * (1.2 + rnd() * 0.7) * (o.bloom ?? 1), bud: rnd() < 0.3, t: t0 + dur * at / segs, rot: rnd() * 72 });
      }
    };
    grow(o.x, o.y, (o.angle ?? -20) * Math.PI / 180, L0, W0, 0, 0, 0.45);
    const end = Math.max(...branches.map(b => b.t1), ...flowers.map(f => f.t + 0.15));
    const fl = flowers.map(f => {
      const fg = el('g', { opacity: 0 }, gf);
      if (f.bud) el('circle', { cx: 0, cy: 0, r: f2(f.r * 0.38), fill: P.ink, 'fill-opacity': 0.85 }, fg);
      else {
        for (let i = 0; i < 5; i++) {
          const a = (f.rot + i * 72) * Math.PI / 180;
          el('circle', { cx: f2(Math.cos(a) * f.r * 0.5), cy: f2(Math.sin(a) * f.r * 0.5), r: f2(f.r * 0.5), fill: P.paper, 'fill-opacity': 0.75, stroke: P.ink, 'stroke-opacity': 0.55, 'stroke-width': f2(U * 0.09) }, fg);
        }
        el('circle', { cx: 0, cy: 0, r: f2(f.r * 0.16), fill: P.ink, 'fill-opacity': 0.75 }, fg);
        for (let i = 0; i < 6; i++) {
          const a = (f.rot + 30 + i * 60) * Math.PI / 180, rr = f.r * (0.3 + 0.08 * (i % 2));
          el('circle', { cx: f2(Math.cos(a) * rr), cy: f2(Math.sin(a) * rr), r: f2(U * 0.1), fill: P.ink }, fg);
        }
      }
      return { ...f, fg, t: f.t / end };
    });
    branches.forEach(b => { b.t0 /= end; b.t1 /= end; });
    const api = { g,
      draw(p) {
        for (const b of branches) b.st.draw(ease.inOut(clamp((p - b.t0) / (b.t1 - b.t0))));
        for (const f of fl) {
          const q = ease.out(clamp((p - f.t) / 0.12));
          f.fg.setAttribute('opacity', f2(q));
          f.fg.setAttribute('transform', `translate(${f2(f.x)} ${f2(f.y)}) scale(${f2(0.4 + 0.6 * q)})`);
        }
      } };
    api.draw(0);
    return api;
  }

  /** 孤舟：小船 + 撑篙的蓑笠人（剪影）+ 一圈圈散开的涟漪；船身随水轻轻起伏（由 st.set 驱动）。
   *  opts x, y（船底水线）, size（船长，默认 8u）, dir（1 向右 / -1 向左）, speed（每秒前进像素，默认 0）, into（默认 st.world）
   *  draw(p)：显出 */
  function boat(st, o) {
    const s = o.size || U * 8, dir = o.dir ?? 1, sp = o.speed || 0;
    const g = el('g', { opacity: 0 }, o.into || st.world), rip = el('g', {}, g), body = el('g', {}, g);
    const rings = [0, 1, 2].map(() => el('ellipse', { cx: 0, cy: 0, rx: 1, ry: 1, fill: 'none', stroke: P.ink, 'stroke-width': f2(U * 0.1) }, rip));
    const shape = el('g', { transform: `scale(${dir} 1)` }, body);
    const refl = el('g', { transform: `scale(${dir} -0.55)`, opacity: 0.16 }, body);
    const draw1 = into2 => {
      el('path', { d: `M ${-s * 0.55} ${-s * 0.08} Q ${-s * 0.1} ${s * 0.1} ${s * 0.55} ${-s * 0.11} Q ${s * 0.1} ${s * 0.02} ${-s * 0.55} ${-s * 0.08} Z`, fill: P.ink }, into2);
      el('path', { d: `M ${-s * 0.2} ${-s * 0.04} Q ${-s * 0.04} ${-s * 0.3} ${s * 0.18} ${-s * 0.05} Z`, fill: P.ink, 'fill-opacity': 0.82 }, into2);
      el('path', { d: `M ${-s * 0.38} ${-s * 0.05} L ${-s * 0.33} ${-s * 0.3} L ${-s * 0.27} ${-s * 0.05} Z`, fill: P.ink }, into2);
      el('path', { d: `M ${-s * 0.43} ${-s * 0.29} L ${-s * 0.33} ${-s * 0.39} L ${-s * 0.22} ${-s * 0.29} Z`, fill: P.ink }, into2);
      el('line', { x1: -s * 0.24, y1: -s * 0.24, x2: s * 0.45, y2: s * 0.16, stroke: P.ink, 'stroke-width': f2(U * 0.12), 'stroke-linecap': 'round' }, into2);
    };
    draw1(shape); draw1(refl);
    let vis = 0;
    const apply = () => {
      const t = st.cam.t, x = o.x + sp * t * dir;
      g.setAttribute('opacity', f2(vis));
      g.setAttribute('transform', `translate(${f2(x)} ${f2(o.y)})`);
      body.setAttribute('transform', `translate(0 ${f2(Math.sin(t * 1.4) * s * 0.012)}) rotate(${f2(Math.sin(t * 1.1 + 0.6) * 1.2)})`);
      rings.forEach((r, i) => {
        const ph = ((t / 3.2 + i / 3) % 1 + 1) % 1, rx = s * (0.5 + 1.3 * ph);
        r.setAttribute('rx', f2(rx)); r.setAttribute('ry', f2(rx * 0.14)); r.setAttribute('stroke-opacity', f2((1 - ph) * 0.32));
      });
    };
    st.tick(apply);
    return { g, draw(p) { vis = ease.out(clamp(p)); apply(); } };
  }

  /** 飞鸟：一行小鸟沿直线飞过，翅膀扇动。opts n（默认 5）, from:[x, y], to:[x, y], size（默认 1.4u）, spread（队形散开，默认 7u）, flaps（全程扇动次数，默认 12）, seed
   *  draw(p)：p 是飞行进度（0 起飞，1 到达），建议用线性进度跨 4～7 秒 */
  function birds(into, o) {
    const n = o.n || 5, size = o.size || U * 1.4, spread = o.spread ?? U * 7, flaps = o.flaps ?? 12, rnd = S.rng((o.seed ?? 3) * 71 + 5);
    const g = el('g', {}, into);
    const bs = Array.from({ length: n }, () => ({ ox: (rnd() - 0.5) * spread * 2, oy: (rnd() - 0.5) * spread, lag: rnd() * 0.12, ph: rnd(), sc: 0.75 + rnd() * 0.5,
      path: el('path', { fill: 'none', stroke: P.ink, 'stroke-width': f2(U * 0.2), 'stroke-linecap': 'butt', 'stroke-linejoin': 'round' }, g) }));
    const api = { g,
      draw(p) {
        for (const b of bs) {
          const q = clamp((p - b.lag) / 0.88), sz = size * b.sc;
          const x = lerp(o.from[0], o.to[0], q) + b.ox, y = lerp(o.from[1], o.to[1], q) + b.oy + Math.sin(q * 7 + b.ph * 6) * U * 0.6;
          const tip = -sz * 0.5 * Math.sin(2 * Math.PI * (q * flaps + b.ph));
          b.path.setAttribute('d', `M ${f2(x - sz)} ${f2(y + tip)} Q ${f2(x - sz * 0.45)} ${f2(y - sz * 0.3 + tip * 0.3)} ${f2(x)} ${f2(y)} Q ${f2(x + sz * 0.45)} ${f2(y - sz * 0.3 + tip * 0.3)} ${f2(x + sz)} ${f2(y + tip)}`);
          b.path.setAttribute('opacity', f2(p > 0 ? sm(0, 0.06, q) * (1 - sm(0.94, 1, q)) : 0));
        }
      } };
    api.draw(0);
    return api;
  }

  window.SS = {
    get C() { return P; }, PALETTES, FONT, U, mix, rgba, noise2, fbm2,
    stage, inkBloom, mountains, mist, water, moon, stroke, inkSweep, plum, boat, birds,
    heading, label, vtitle, verse, inscription, seal, marker,
  };
})();
