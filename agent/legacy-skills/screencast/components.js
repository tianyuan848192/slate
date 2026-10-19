/* 界面秀组件（依赖 SLATE 运行时）：产品演示、软件功能走查、SaaS 功能发布
 *
 * 约定：所有组件在创建时一次性生成元素；render(t) 里只根据 t 设置状态。用到的方法每一帧都要调用（不调用就停在上一帧的状态）。
 *   draw(p)：p 为 0～1 的入场进度（用 SC.pop 弹簧时会略超过 1，组件能处理）；set(t, …)：需要绝对时间或要跟随镜头的组件。
 * 坐标：画布像素，尺寸写成 SLATE.u 的倍数。外框里的界面用外框 body 的局部坐标（左上角为 0, 0）。
 * 图层：st.world 跟镜头推拉（外框和界面）；st.hud 固定在屏幕上（标题、章节、角标、按键）。
 *       聚光灯、标注气泡、光标由组件自己放进镜头上方的图层，用 st.toScreen 跟随镜头，字号不随推近变大。
 * 布局不变量：界面元素的位置和尺寸在创建时就定死（不随打字、流式文字改变），要隐藏就用透明度或 visibility，
 *       不要用 display:none。光标、镜头、标注按元素在世界里的位置定位，布局一变就会对不上。
 *
 *   const st = SC.stage({ wall: 'mist' });
 *   const fr = SC.frame(st.world, { kind: 'browser', ...SC.fit({ aspect: 16 / 10 }), url: 'app.example.com' });
 *   const btn = SC.button(fr, { x: 40 * U, y: 20 * U, label: '生成' });
 *   const cur = SC.cursor(st, { keys: [{ t: 0.8, at: [x, y] }, { t: 1.6, at: btn, click: true }] });
 *   st.camera([{ t: 1.3, at: btn, zoom: 1.6 }, { t: 4, zoom: 1 }]);
 *   function render(t) { st.set(t); fr.draw(SC.pop(t, 0.1)); btn.press(SC.pulse(t, cur.clicks[0])); cur.set(t); }
 *
 * 组件一览（参数见各函数注释）：
 *   舞台与镜头：stage（壁纸、图层、镜头 st.camera、运动模糊）、area、fit、box
 *   外框：frame（browser 浏览器 / app 应用窗口 / phone 手机）、shot（用户截图）、compare（前后对比）、group（分组容器）、swap（换页）
 *   界面骨架：sidebar、header、button、field、toggle、card、kpi、chart、table、checklist、stream、toast、chip、avatar、skel、icon
 *   叠加层：heading、text、points、mark（"示意"角标）、tag、chapter（步骤条）、keys（按键提示）、speed（快进标签）、logo、
 *           cursor（光标 / 触点）、spotlight（聚光灯）、callout（标注气泡）
 *   时间工具：pop（弹簧入场）、pulse（按下脉冲）、E（缓动）、D（三档时长）、tf（生成 transform，静止时为 none）
 * 确定性：stage 每帧让所有图层整块重画；transform 静止时去掉；界面文字用 HTML（SVG 文字在镜头缩放下和渲染顺序有关）。
 */
(() => {
  const S = window.SLATE;
  const U = S.u, W = S.width, H = S.height;
  const clamp = S.clamp, lerp = S.lerp;
  const docEl = document.documentElement;
  docEl.style.setProperty('--u', U + 'px');

  const C = {
    accent: '#3F62F0', ink: '#111827', ink2: '#465065', muted: '#8891A5',
    success: '#13A06B', warn: '#D9881A', danger: '#E0484E', info: '#2F86D6',
    font: '"Noto Sans CJK SC", "Noto Sans SC", sans-serif',
  };
  const hex = c => { const s = c.replace('#', ''); const f = s.length === 3 ? s.split('').map(x => x + x).join('') : s; return [0, 2, 4].map(i => parseInt(f.slice(i, i + 2), 16)); };
  const rgba = (c, a) => { const [r, g, b] = hex(c); return `rgba(${r}, ${g}, ${b}, ${a})`; };
  const mix = (c1, c2, p) => { const a = hex(c1), b = hex(c2), q = clamp(p); return '#' + a.map((v, i) => Math.round(v + (b[i] - v) * q).toString(16).padStart(2, '0')).join(''); };
  /** 换强调色（整片只用一种，通常取产品品牌色）。要在创建其他组件之前调用，SC.stage({ accent }) 会自动调用 */
  function setAccent(c) {
    C.accent = c;
    docEl.style.setProperty('--sc-accent', c);
    docEl.style.setProperty('--sc-accent-soft', rgba(c, 0.1));
    docEl.style.setProperty('--sc-accent-ring', rgba(c, 0.24));
    docEl.style.setProperty('--sc-accent-deep', mix(c, '#0b1020', 0.18));
  }
  setAccent(C.accent);
  const TONE = { accent: () => C.accent, success: () => C.success, warn: () => C.warn, danger: () => C.danger, info: () => C.info, muted: () => '#7A8396' };
  const toneColor = t => (TONE[t] || TONE.accent)();

  // ---- 元素工具 ----
  const NOPX = new Set(['opacity', 'zIndex', 'fontWeight', 'flex', 'flexGrow', 'flexShrink', 'lineHeight', 'order']);
  const css = (e, o) => { for (const k in o) { const v = o[k]; if (v == null) continue; e.style[k] = typeof v === 'number' && !NOPX.has(k) ? `${+v.toFixed(2)}px` : v; } return e; };
  const h = (tag, cls, style, parent, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (style) css(e, style);
    if (text != null) e.textContent = text;
    if (parent) parent.appendChild(e);
    return e;
  };
  /** 父容器：可以传元素，也可以传组件对象（外框、卡片取 body，舞台取 world） */
  const host = p => (p && (p.body || p.world || p.el)) || p;
  const elOf = x => (x && x.el) || x;
  const f2 = v => +(+v).toFixed(2);
  /** transform 字符串。同一个元素如果在"带缩放"和"只有小数位移"两种变换之间来回切换，Chrome 的像素对齐会和渲染历史有关
   *  （新开页面和顺序渲染差 1 像素）。所以：没有缩放时位移取整像素，位移为 0 时返回 'none'；有缩放时照常输出 */
  const tf = (x, y, sc = 1, unit = 'px') => {
    if (Math.abs(sc - 1) >= 5e-5) return `translate(${f2(x)}${unit}, ${f2(y)}${unit}) scale(${sc.toFixed(4)})`;
    const rx = unit === 'px' ? Math.round(x) : f2(x), ry = unit === 'px' ? Math.round(y) : f2(y);
    return rx === 0 && ry === 0 ? 'none' : `translate(${rx}${unit}, ${ry}${unit})`;
  };
  let uid = 0;
  const nid = p => `sc${p}${++uid}`;
  const fmt = (v, d = 0) => Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });

  // ---- 缓动和时间 ----
  /** 三次贝塞尔缓动（同 CSS cubic-bezier），端点精确返回 0 和 1 */
  function bezier(x1, y1, x2, y2) {
    const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx, cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
    const X = s => ((ax * s + bx) * s + cx) * s, Y = s => ((ay * s + by) * s + cy) * s, dX = s => (3 * ax * s + 2 * bx) * s + cx;
    return p => {
      if (p <= 0) return 0;
      if (p >= 1) return 1;
      let s = p;
      for (let i = 0; i < 8; i++) { const e = X(s) - p; if (Math.abs(e) < 1e-6) break; const d = dX(s); if (Math.abs(d) < 1e-6) break; s -= e / d; }
      if (!(s >= 0 && s <= 1) || Math.abs(X(s) - p) > 1e-4) {
        let a = 0, b = 1; s = p;
        for (let i = 0; i < 40; i++) { const x = X(s); if (Math.abs(x - p) < 1e-6) break; if (x < p) a = s; else b = s; s = (a + b) / 2; }
      }
      return Y(s);
    };
  }
  /** 风格的缓动：glide 是签名缓动（入场），move 用于画面内移动和镜头，cursor 是光标（起步快、落点慢），exit 用于退场 */
  const E = { glide: bezier(0.22, 1, 0.36, 1), move: bezier(0.65, 0, 0.35, 1), cursor: bezier(0.3, 0.1, 0.12, 1), exit: bezier(0.55, 0, 0.8, 0.25), bezier };
  /** 三档时长（秒）：fast 按下、切换；base 入场；slow 镜头 */
  const D = { fast: 0.25, base: 0.6, slow: 0.9 };
  /** 弹簧入场进度：从 start 秒开始，0 → 1，阻尼比约 0.78，过冲约 2%，0.5 秒内落定 */
  const pop = (t, start, o = {}) => S.spring(t, { start, stiffness: o.stiffness ?? 150, damping: o.damping ?? 19 });
  /** 按下脉冲：在 at 秒处 0 → 1 → 0，持续 dur 秒（默认 0.25），用于按钮按下、点击反馈。at 为空时返回 0 */
  const pulse = (t, at, dur = 0.25) => (at == null ? 0 : Math.sin(Math.PI * clamp((t - at) / dur)));

  // ---- 构图 ----
  const capTop = () => (S.captionsOn ? S.captionZone.y : S.safe.y + S.safe.h);
  /** 内容区：安全区内、字幕区以上。opts top/bottom/left/right 可覆盖（例如 top: heading.bottom） */
  function area(o = {}) {
    const y0 = o.top ?? S.safe.y + U * 2, y1 = o.bottom ?? capTop() - U * 2.5;
    const x0 = o.left ?? S.safe.x + U * 2, x1 = o.right ?? S.safe.x + S.safe.w - U * 2;
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }
  /** 在内容区里放一个给定宽高比的矩形，居中（或按 cx、cy 放）。opts 同 area，另有 aspect（默认 16/10）、scale（占内容区比例，默认 1）、maxW、maxH
   *  返回 { x, y, w, h }，可以直接展开给 SC.frame */
  function fit(o = {}) {
    const a = area(o), asp = o.aspect || 16 / 10, k = o.scale ?? 1;
    let w = Math.min(a.w * k, o.maxW ?? 1e9), hh = w / asp;
    const mh = Math.min(a.h * k, o.maxH ?? 1e9);
    if (hh > mh) { hh = mh; w = hh * asp; }
    const cx = o.cx ?? a.x + a.w / 2, cy = o.cy ?? a.y + a.h / 2;
    return { x: Math.round(cx - w / 2), y: Math.round(cy - hh / 2), w: Math.round(w), h: Math.round(hh) };
  }

  // ---- 世界坐标（镜头、光标、标注都用它） ----
  let curStage = null;
  const boxCache = new Map();
  /** 元素在世界（st.world）里的矩形 { x, y, w, h }。按布局计算，不受入场动画和镜头的 transform 影响；结果会缓存 */
  function box(target) {
    const el = elOf(target);
    if (boxCache.has(el)) return boxCache.get(el);
    const world = curStage && curStage.world;
    let x = 0, y = 0, e = el;
    while (e && e !== world) {
      x += e.offsetLeft; y += e.offsetTop;
      const p = e.offsetParent;
      if (!p || p === world) break;
      x += p.clientLeft; y += p.clientTop;
      e = p;
    }
    const r = { x, y, w: el.offsetWidth, h: el.offsetHeight };
    boxCache.set(el, r);
    return r;
  }
  /** 目标 → 世界矩形。at 可以是：元素或组件对象（取整个矩形）、[x, y]、{ x, y, w, h }、{ el, fx, fy }（元素里的某一点，0～1）、
   *  以上几种组成的数组（取并集，例如 [输入框, 结果卡片]），或者返回以上任意一种的函数（例如 shot.region(...)）。点的 w、h 为 0 */
  function rectOf(at) {
    if (typeof at === 'function') return rectOf(at());
    if (Array.isArray(at) && at.length && typeof at[0] !== 'number') {
      const rs = at.map(rectOf), x0 = Math.min(...rs.map(r => r.x)), y0 = Math.min(...rs.map(r => r.y));
      return { x: x0, y: y0, w: Math.max(...rs.map(r => r.x + r.w)) - x0, h: Math.max(...rs.map(r => r.y + r.h)) - y0 };
    }
    if (Array.isArray(at)) return { x: at[0], y: at[1], w: 0, h: 0 };
    if (at && at.el && (at.fx != null || at.fy != null)) { const b = box(at.el); return { x: b.x + b.w * (at.fx ?? 0.5), y: b.y + b.h * (at.fy ?? 0.5), w: 0, h: 0 }; }
    if (at && at.w != null && at.x != null && !(at instanceof Element)) return at;
    if (at && (at instanceof Element || at.el)) return box(at);
    if (at && at.x != null) return { x: at.x, y: at.y, w: 0, h: 0 };
    throw new Error('SC：不认识的目标 at，要用元素、组件、[x, y] 或 {x, y, w, h}');
  }
  const centerOf = r => [r.x + r.w / 2, r.y + r.h / 2];

  // ---- 图标（自绘线性图标，24×24） ----
  const ICONS = {
    home: 'M4 10.5 12 4l8 6.5V20a1 1 0 0 1-1 1h-4.5v-6h-5v6H5a1 1 0 0 1-1-1z',
    chart: 'M4 20h16M7 16v-4M12 16V8M17 16v-6',
    table: 'M4 5h16v14H4zM4 10h16M10 10v9',
    users: 'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM2.5 20c.8-3.4 3.4-5.5 6.5-5.5s5.7 2.1 6.5 5.5M16 4.5a3.3 3.3 0 0 1 0 6.4M18 14.6c1.8.7 3 2.6 3.5 5.4',
    settings: 'M4 7h9M17 7h3M4 17h3M11 17h9M15 9.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM9 19.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z',
    bell: 'M6 16v-5a6 6 0 0 1 12 0v5l1.5 2h-15zM10 20.5a2.2 2.2 0 0 0 4 0',
    search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM16 16l4.5 4.5',
    plus: 'M12 5v14M5 12h14',
    check: 'M5 12.5l4.5 4.5L19 7.5',
    spark: 'M12 3c.6 5 4 8.4 9 9-5 .6-8.4 4-9 9-.6-5-4-8.4-9-9 5-.6 8.4-4 9-9z',
    doc: 'M7 3h7l5 5v13H7zM14 3v5h5M10 13h6M10 17h6',
    folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
    calendar: 'M4 6h16v14H4zM4 10h16M8 3v4M16 3v4',
    download: 'M12 4v11M7 10.5l5 5 5-5M5 20h14',
    upload: 'M12 16V5M7 9.5l5-5 5 5M5 20h14',
    filter: 'M4 5h16l-6 7.5V19l-4 1.5v-8z',
    lock: 'M6 11h12v9H6zM8.5 11V8a3.5 3.5 0 0 1 7 0v3',
    arrow: 'M5 12h14M13 6l6 6-6 6',
    chevron: 'M9 6l6 6-6 6',
    back: 'M15 6l-6 6 6 6',
    down: 'M6 9l6 6 6-6',
    inbox: 'M4 13l2.5-8h11l2.5 8v6H4zM4 13h5l1 2.5h4l1-2.5h5',
    bolt: 'M13 3L5 13.5h6L10 21l8-10.5h-6z',
    card: 'M3 6h18v12H3zM3 10h18',
    clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3.5 2',
    share: 'M8.6 13.5l6.8 4M15.4 6.5l-6.8 4M18 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 22a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
    more: 'M5 12h.01M12 12h.01M19 12h.01',
    reload: 'M19 12a7 7 0 1 1-2.05-4.95M19 4v4h-4',
    grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
    mail: 'M3 6h18v12H3zM3 7l9 6.5L21 7',
    star: 'M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.8z',
    x: 'M6 6l12 12M18 6L6 18',
    link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  };
  /** 图标：name 见上表；size 像素；color 默认跟随文字色；filled 为 true 时填充（spark、star 适合） */
  function icon(name, size, color, o = {}) {
    const s = S.svg('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', class: 'sc-ico' });
    const c = color || 'currentColor';
    S.svg('path', o.filled ? { d: ICONS[name] || ICONS.doc, fill: c } :
      { d: ICONS[name] || ICONS.doc, stroke: c, 'stroke-width': o.sw ?? 1.9, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', fill: 'none' }, s);
    return s;
  }
  /** 示意品牌标记（抽象几何，不对应任何真实品牌）。用户上传了 Logo 时改用 <img src="/input/…"> */
  function logoSvg(size) {
    const s = S.svg('svg', { width: size, height: size, viewBox: '0 0 32 32', class: 'sc-ico' });
    const gid = nid('lg');
    const lg = S.svg('linearGradient', { id: gid, x1: 0, y1: 0, x2: 1, y2: 1 }, S.svg('defs', {}, s));
    S.svg('stop', { offset: 0, 'stop-color': mix(C.accent, '#ffffff', 0.18) }, lg);
    S.svg('stop', { offset: 1, 'stop-color': mix(C.accent, '#0b1020', 0.22) }, lg);
    S.svg('rect', { x: 0, y: 0, width: 32, height: 32, rx: 9, fill: `url(#${gid})` }, s);
    S.svg('rect', { x: 8.5, y: 13, width: 5, height: 11, rx: 2.5, fill: '#fff' }, s);
    S.svg('rect', { x: 15.5, y: 8, width: 5, height: 16, rx: 2.5, fill: '#fff', 'fill-opacity': 0.82 }, s);
    S.svg('circle', { cx: 24.6, cy: 21.6, r: 2.5, fill: '#fff' }, s);
    return s;
  }

  // ---------------------------------------------------------------------------------------------
  // 壁纸：柔和渐变 + 几团低饱和光晕 + 静态颗粒（颗粒防止渐变在视频压缩后出现色带）。'A' 表示用强调色
  const WALLS = {
    mist: { dark: false, base: ['#F5F7FB', '#E5E9F1'], glows: [[0.88, 0.06, 0.62, 'A', 0.16], [0.05, 0.95, 0.62, '#FFD8C4', 0.5], [0.03, 0.1, 0.5, '#D2E4FF', 0.62], [0.62, 1.04, 0.5, '#D5EFE6', 0.42]] },
    dawn: { dark: false, base: ['#FCF8F2', '#F1E9DF'], glows: [[0.9, 0.08, 0.6, '#FFCDB1', 0.5], [0.06, 0.92, 0.62, '#FADFCC', 0.55], [0.1, 0.06, 0.45, 'A', 0.07], [0.6, 1.0, 0.5, '#F4E3C3', 0.42]] },
    night: { dark: true, base: ['#141B2A', '#090D16'], glows: [[0.86, 0.04, 0.66, 'A', 0.32], [0.08, 0.98, 0.6, '#1C6B85', 0.22], [0.45, 0.55, 0.7, '#1B243A', 0.45]] },
  };
  // 壁纸用 CSS 渐变画在一个普通 div 上（不用 canvas）：加速 canvas 会成为合成层，压在它上面的镜头层也会被提升为合成层，
  // 合成层的缩放由浏览器按启发式决定何时重画，像素结果会和渲染顺序有关
  let grainUrl = null;
  function grain() {
    if (grainUrl) return grainUrl;
    const tile = document.createElement('canvas');
    tile.width = tile.height = 128;
    const tc = tile.getContext('2d'), img = tc.createImageData(128, 128), rnd = S.rng(9001);
    for (let i = 0; i < img.data.length; i += 4) { const v = rnd() < 0.5 ? 0 : 255; img.data[i] = img.data[i + 1] = img.data[i + 2] = v; img.data[i + 3] = Math.round(4 + rnd() * 7); }
    tc.putImageData(img, 0, 0);
    grainUrl = tile.toDataURL('image/png');
    return grainUrl;
  }
  function paintWall(el, kind, mx, my) {
    const spec = typeof kind === 'object' ? { dark: false, glows: [], ...kind } : (WALLS[kind] || WALLS.mist);
    const R = Math.max(W, H), layers = [`url(${grain()})`];
    for (const [gx, gy, gr, gc, ga] of spec.glows) {
      const col = gc === 'A' ? C.accent : gc;
      layers.push(`radial-gradient(circle ${f2(gr * R)}px at ${f2(mx + gx * W)}px ${f2(my + gy * H)}px, ${rgba(col, ga)} 0%, ${rgba(col, +(ga * 0.42).toFixed(3))} 50%, ${rgba(col, 0)} 100%)`);
    }
    layers.push(`linear-gradient(155deg, ${spec.base[0]}, ${spec.base[1]})`);
    el.style.backgroundImage = layers.join(', ');
    el.style.backgroundRepeat = 'repeat, ' + layers.slice(1).map(() => 'no-repeat').join(', ');
    el.style.backgroundSize = '128px 128px, ' + layers.slice(1).map(() => '100% 100%').join(', ');
    return spec;
  }

  /** 舞台：壁纸 + 镜头层 + 叠加层。每镜先创建它，render(t) 第一行调用 st.set(t)。
   *  opts: wall: 'mist'（冷白，默认）| 'dawn'（暖白）| 'night'（深色，配深色界面）| { base: [色1, 色2], glows: [[x, y, 半径, 色, 透明度]…], dark }
   *        accent（强调色，默认靛蓝 #3F62F0；整片统一）、blur（镜头快速平移时的单轴运动模糊，默认 true）、
   *        drift（镜头停住后每秒继续缓推的比例，默认 0.005，设 0 关闭）、parallax（壁纸视差，默认 0.12）
   *  返回 st：
   *    st.world（外框放这里，跟镜头动）、st.hud（标题、章节、角标，固定在屏幕上）；
   *    st.camera(keys) 设置镜头，keys 是 [{ t, at, zoom, dur, ease, dx, dy, margin, max }]：
   *      - t 秒开始移动，dur 秒（默认 0.9）到位；at 是目标（同 SC.box 的写法），会被放到内容区中心（安全区顶部到字幕区之间）；
   *      - zoom：数字，或 'fit'（把目标矩形放大到占满内容区约 75%，上限 max，默认 2.2）；{ zoom: 1 } 不带 at 表示回到全景；
   *      - 两个镜头动作之间至少隔开 dur，推近 1.4～2.2 倍要在点击前 0.3～0.5 秒开始；
   *      - 第二个参数 { top, bound }：top 是画面顶部常驻的步骤条、标题的下沿，镜头会把目标放在它和字幕区之间；
   *        bound（通常传外框）让推近后的画面不露出窗口以外，目标靠窗口边缘时会偏离中心，但满屏都是界面。
   *    st.toScreen([x, y], t) / st.toScreenRect(rect, t)：世界坐标 → 屏幕坐标；st.zoom(t)：当前缩放 */
  function stage(o = {}) {
    o = { wall: 'mist', blur: true, drift: 0.005, parallax: 0.12, ...o };
    if (o.accent) setAccent(o.accent);
    boxCache.clear();
    const root = h('div', 'sc-root');
    document.body.insertBefore(root, document.body.firstChild);
    const mx = Math.round(W * 0.08), my = Math.round(H * 0.08);
    const cv = h('div', 'sc-bg', { width: W + mx * 2, height: H + my * 2 }, root);
    const spec = paintWall(cv, o.wall, mx, my);
    if (spec.dark) root.classList.add('sc-dark');
    docEl.style.background = document.body.style.background = spec.base[1];
    // 整层重画：每一帧都让每个图层整块失效重画（透明背景图换位置，看不见）。浏览器默认只局部重画变化的区域，
    // 局部重画的边界会切过旁边元素的抗锯齿边缘，像素结果就和渲染顺序有关了
    const inv = h('div', 'sc-layer sc-inv', null, root);
    const world = h('div', 'sc-layer sc-world', null, root);
    const lens = h('div', 'sc-layer sc-hud', null, root);   // 聚光灯
    const over = h('div', 'sc-layer sc-hud', null, root);   // 标注气泡、对比标签
    const ptr = h('div', 'sc-layer sc-hud', null, root);    // 光标、点击涟漪
    const hud = h('div', 'sc-layer sc-hud', null, root);    // 标题、章节、角标、按键
    const fs = S.svg('svg', { width: 0, height: 0, style: 'position:absolute;left:0;top:0' }, root);
    const fid = nid('mb');
    const flt = S.svg('filter', { id: fid, filterUnits: 'userSpaceOnUse', x: -W, y: -H, width: W * 3, height: H * 3, 'color-interpolation-filters': 'sRGB' }, S.svg('defs', {}, fs));
    const gb = S.svg('feGaussianBlur', { stdDeviation: '0 0' }, flt);
    const F = [W / 2, (S.safe.y + capTop()) / 2];
    const S0 = { x: F[0], y: F[1], z: 1 };
    let keys = [], camTop, camBound;

    const target = (k, from) => {
      if (!k.at) { const z = k.zoom ?? 1; return z === 1 ? { ...S0 } : { x: from.x, y: from.y, z }; }
      const r = rectOf(k.at);
      let z = k.zoom ?? 'fit';
      if (z === 'fit') {
        const a = area({ top: camTop }), m = 1 + (k.margin ?? 0.35);
        z = clamp(Math.min(a.w / Math.max(1, r.w * m), a.h / Math.max(1, r.h * m)), 1, k.max ?? 2.2);
      }
      let x = r.x + r.w / 2 + (k.dx || 0), y = r.y + r.h / 2 + (k.dy || 0);
      // bound：推近到窗口比屏幕还大时，不让画面露出窗口以外（像录屏软件那样始终满屏是界面）
      if (camBound) {
        const b = rectOf(camBound), xl = b.x + F[0] / z, xr = b.x + b.w - (W - F[0]) / z, yt = b.y + F[1] / z, yb = b.y + b.h - (H - F[1]) / z;
        if (xl <= xr) x = clamp(x, xl, xr);
        if (yt <= yb) y = clamp(y, yt, yb);
      }
      return { x, y, z };
    };
    const blend = (a, b, p) => ({ x: lerp(a.x, b.x, p), y: lerp(a.y, b.y, p), z: Math.exp(lerp(Math.log(a.z), Math.log(b.z), p)) });
    const drifted = (s, dt) => (dt > 0 && o.drift ? { x: s.x, y: s.y, z: s.z * (1 + o.drift * dt) } : s);
    let memoT = NaN, memoS = S0;
    function state(t) {
      if (t === memoT) return memoS;
      let from = S0, key = null, tgt = S0;
      const at = time => {
        if (!key) return drifted(S0, time);
        const q = clamp((time - key.t) / key.dur);
        return drifted(blend(from, tgt, (key.ease || E.move)(q)), time - key.t - key.dur);
      };
      for (const k of keys) {
        if (t < k.t) break;
        const cur = at(k.t);
        from = cur; key = k; tgt = target(k, cur);
      }
      memoT = t; memoS = at(t);
      return memoS;
    }
    const toScreen = (pt, t) => { const s = state(t); return [F[0] + (pt[0] - s.x) * s.z, F[1] + (pt[1] - s.y) * s.z]; };
    const toScreenRect = (r, t) => { const s = state(t); return { x: F[0] + (r.x - s.x) * s.z, y: F[1] + (r.y - s.y) * s.z, w: r.w * s.z, h: r.h * s.z }; };

    const st = {
      root, world, hud, over, ptr, lens, dark: spec.dark, focus: F,
      camera(list, co = {}) {
        if (co.top != null) { camTop = co.top; F[1] = (co.top + capTop()) / 2; S0.y = F[1]; }
        camBound = co.bound;
        keys = list.map(k => ({ ...k, dur: k.dur ?? D.slow })).sort((a, b) => a.t - b.t); memoT = NaN; return st;
      },
      state, toScreen, toScreenRect, zoom: t => state(t).z,
      set(t) {
        const s = state(t);
        // 缩放为 1 时只剩平移，交给 tf（取整像素 / none），原因见 tf 的注释
        world.style.transform = Math.abs(s.z - 1) < 5e-5 ? tf(F[0] - s.x, F[1] - s.y)
          : `translate(${f2(F[0])}px, ${f2(F[1])}px) scale(${s.z.toFixed(5)}) translate(${f2(-s.x)}px, ${f2(-s.y)}px)`;
        const k = o.parallax, zb = 1 + (s.z - 1) * k, bx = F[0] + (s.x - F[0]) * k, by = F[1] + (s.y - F[1]) * k;
        cv.style.transform = Math.abs(zb - 1) < 5e-5 ? tf(F[0] - bx - mx, F[1] - by - my)
          : `translate(${f2(F[0])}px, ${f2(F[1])}px) scale(${zb.toFixed(5)}) translate(${f2(-bx - mx)}px, ${f2(-by - my)}px)`;
        let blur = 0, vx = 0, vy = 0;
        if (o.blur && t > 0) {
          const s0 = state(Math.max(0, t - 1 / 30)), s1 = state(t);
          vx = (s1.x - s0.x) * s1.z * 30; vy = (s1.y - s0.y) * s1.z * 30;
          const sp = Math.hypot(vx, vy);
          blur = clamp((sp - W * 0.8) / (W * 1.6)) * U * 1.4 / s1.z;
          if (blur > 0.05 * U) gb.setAttribute('stdDeviation', `${f2(blur * Math.abs(vx) / sp)} ${f2(blur * Math.abs(vy) / sp)}`);
        }
        world.style.filter = blur > 0.05 * U ? `url(#${fid})` : 'none';
        const tick = `${Math.round(t * 1000) % 8192}px 0px`;
        [inv, lens, over, ptr, hud].forEach(e => { e.style.backgroundPosition = tick; });
        memoT = NaN; state(t);
      },
    };
    curStage = st;
    return st;
  }

  // ---------------------------------------------------------------------------------------------
  /** 外框：浏览器、应用窗口或手机。opts: kind: 'browser'（默认）| 'app' | 'phone'；x, y, w, h（可以直接展开 SC.fit(...)）；
   *        url（浏览器地址栏，默认 app.example.com）、title（应用窗口标题）、time（手机状态栏时间，默认 10:08）、theme: 'light' | 'dark'、
   *        qa（默认 false：外框里的界面和截图一样，不参与 slate-qa 的文字检查；要读的字放到叠加层）
   *  返回 { el, body, bw, bh, x, y, w, h, draw(p, out) }：界面元素放进 body（或者直接把外框对象当父容器传给其他组件），
   *        body 的局部坐标从 (0, 0) 到 (bw, bh)。draw(p) 从下方升起、0.92 → 1 放大；out(0～1) 收起退场。 */
  function frame(parent, o) {
    const kind = o.kind || 'browser', P = host(parent);
    const el = h('div', `sc-a sc-frame sc-${kind}`, { left: o.x, top: o.y, width: o.w, height: o.h }, P);
    el.dataset.theme = o.theme || 'light';
    if (o.qa !== true) el.dataset.qa = 'ignore';
    const dots = bar => { const d = h('div', 'sc-dots', null, bar); for (let i = 0; i < 3; i++) h('i', null, null, d); };
    let inner = el, bw = o.w, top0 = 0, bh = o.h;
    if (kind === 'browser') {
      const barH = U * 4.4, bar = h('div', 'sc-bar', { height: barH }, el);
      dots(bar);
      const nav = h('div', 'sc-navbtns', null, bar);
      nav.append(icon('back', U * 1.7), icon('chevron', U * 1.7), icon('reload', U * 1.6));
      const url = h('div', 'sc-url', null, bar);
      url.append(icon('lock', U * 1.3));
      h('span', null, null, url, o.url || 'app.example.com');
      const r = h('div', 'sc-bar-r', null, bar);
      r.append(icon('share', U * 1.6), icon('more', U * 1.8, null, { sw: 3 }));
      top0 = barH; bh = o.h - barH;
    } else if (kind === 'app') {
      const barH = U * 3.8, bar = h('div', 'sc-bar', { height: barH }, el);
      dots(bar);
      if (o.title) h('div', 'sc-wtitle', null, bar, o.title);
      top0 = barH; bh = o.h - barH;
    } else if (kind === 'phone') {
      const bz = o.bezel ?? U * 1.05, sw = o.w - bz * 2, sh = o.h - bz * 2, rr = o.radius ?? U * 5.8;
      el.style.borderRadius = rr + 'px';
      [[-1, 0.2, 0.06], [-1, 0.29, 0.1], [1, 0.25, 0.12]].forEach(([side, y, len]) =>
        h('div', 'sc-phone-btn', { left: side < 0 ? -U * 0.35 : o.w - U * 0.1, top: o.h * y, height: o.h * len }, el));
      inner = h('div', 'sc-screen', { left: bz, top: bz, width: sw, height: sh, borderRadius: rr - bz }, el);
      const stH = U * 4.6, stb = h('div', 'sc-status', { height: stH }, inner);
      h('span', null, null, stb, o.time || '10:08');
      const sr = h('div', 'sc-status-r', null, stb);
      const sig = S.svg('svg', { width: U * 1.9, height: U * 1.2, viewBox: '0 0 19 12' }, sr);
      [0, 1, 2, 3].forEach(i => S.svg('rect', { x: i * 5, y: 9 - i * 3, width: 3.4, height: 3 + i * 3, rx: 1, fill: 'currentColor' }, sig));
      const wifi = S.svg('svg', { width: U * 1.7, height: U * 1.25, viewBox: '0 0 17 12.5' }, sr);
      S.svg('path', { d: 'M1 4.6a11 11 0 0 1 15 0M3.6 7.4a7.3 7.3 0 0 1 9.8 0M6.3 10a3.4 3.4 0 0 1 4.4 0', stroke: 'currentColor', 'stroke-width': 1.7, fill: 'none', 'stroke-linecap': 'round' }, wifi);
      const bat = S.svg('svg', { width: U * 2.6, height: U * 1.25, viewBox: '0 0 26 12.5' }, sr);
      S.svg('rect', { x: 0.8, y: 0.8, width: 21.5, height: 10.9, rx: 3.2, stroke: 'currentColor', 'stroke-opacity': 0.45, 'stroke-width': 1.2, fill: 'none' }, bat);
      S.svg('rect', { x: 2.6, y: 2.6, width: 15.5, height: 7.3, rx: 1.8, fill: 'currentColor' }, bat);
      S.svg('rect', { x: 23.4, y: 4.2, width: 1.8, height: 4, rx: 0.9, fill: 'currentColor', 'fill-opacity': 0.45 }, bat);
      h('div', 'sc-punch', null, inner);
      const homeH = U * 2.4;
      bw = sw; top0 = stH; bh = sh - stH - homeH;
      h('div', 'sc-homebar', null, inner);
    }
    const body = h('div', 'sc-body', { left: 0, top: top0, width: bw, height: bh }, inner);
    if (kind === 'phone') { body.style.background = 'transparent'; inner.insertBefore(body, inner.querySelector('.sc-homebar')); }
    const api = {
      el, body, bw, bh, x: o.x, y: o.y, w: o.w, h: o.h, kind,
      draw(p, out = 0) {
        const q = clamp(out);
        el.style.opacity = f2(clamp(p * 2.2) * (1 - q));
        el.style.visibility = p <= 0 || q >= 1 ? 'hidden' : 'visible';
        el.style.transform = tf(0, (1 - p) * U * 15 - E.exit(q) * U * 3, (0.92 + 0.08 * p) * (1 - 0.06 * E.exit(q)));
      },
    };
    return api;
  }

  /** 用户截图：把 /input/文件名 装进外框（或任意容器）。opts: src、fit: 'width'（默认，宽度铺满、从顶部开始，下面裁掉）| 'contain' | 'cover'，
   *        x, y, w, h（默认铺满父容器，父容器是外框时取 bw、bh）、align: 'top' | 'center'
   *  返回 { el, img, region(fx, fy, fw, fh), point(fx, fy), maxZoom(), scroll(p) }：
   *    region 用截图里的比例坐标（0～1，相对整张图）圈出一块，返回给镜头、聚光灯、标注、光标用的目标（先用 slate-look 看图找到按钮大约在哪）；
   *    maxZoom()：推近超过这个倍数截图会发糊（原图像素 ÷ 显示像素）；scroll(p)：长截图向下滚动（滚动时不要同时用 region 定位）。 */
  function shot(parent, o) {
    const P = host(parent), pw = o.w ?? parent.bw ?? P.clientWidth, ph = o.h ?? parent.bh ?? P.clientHeight;
    const wrap = h('div', 'sc-a sc-shot', { left: o.x ?? 0, top: o.y ?? 0, width: pw, height: ph, overflow: 'hidden' }, P);
    const img = h('img', null, { width: pw }, wrap);
    img.alt = '';
    img.src = o.src;
    let lay = null;
    // 解码完成后立即排版（在第一帧之前），之后布局不再变化
    S.waits.push(img.decode().then(() => layout()).catch(() => null));
    const layout = () => {
      if (lay) return lay;
      const nw = img.naturalWidth || 16, nh = img.naturalHeight || 10, mode = o.fit || 'width';
      let w = pw, hh = pw * nh / nw;
      if (mode === 'contain' && hh > ph) { hh = ph; w = ph * nw / nh; }
      if (mode === 'cover' && hh < ph) { hh = ph; w = ph * nw / nh; }
      const x = (pw - w) / 2, y = (o.align === 'center' || mode !== 'width') ? (ph - hh) / 2 : 0;
      lay = { x, y, w, h: hh, nw, nh };
      css(img, { left: x, top: y, width: w, height: hh });
      return lay;
    };
    let sy = 0;
    const api = {
      el: wrap, img,
      region: (fx, fy, fw = 0, fh = 0) => () => { const L = layout(), b = box(wrap); return { x: b.x + L.x + fx * L.w, y: b.y + L.y + fy * L.h + sy, w: fw * L.w, h: fh * L.h }; },
      point: (fx, fy) => () => { const L = layout(), b = box(wrap); return [b.x + L.x + fx * L.w, b.y + L.y + fy * L.h + sy]; },
      maxZoom: () => { const L = layout(); return L.nw / L.w; },
      scroll(p) { const L = layout(); sy = -Math.max(0, L.h - ph) * E.move(clamp(p)); img.style.transform = tf(0, sy); },
      draw() { layout(); },
    };
    if (img.complete && img.naturalWidth) layout();
    return api;
  }

  /** 前后对比：两层内容叠在一起，分隔线从左往右扫过，左边露出"之后"。opts: x, y, w, h（默认铺满父容器）、labels: ['旧版', '新版']
   *  返回 { el, a（之前）, b（之后）, set(t, p, show) }：往 a、b 里放截图或界面（例如 SC.shot(cmp.a, …)，父容器可以直接传 cmp.a）。
   *  p 0 → 1 分隔线扫过；show（默认 1）控制分隔线和标签整体显隐，推近前把它降到 0。标签放在叠加层、跟随镜头，参与自检。 */
  function compare(parent, o = {}) {
    const P = host(parent), w = o.w ?? parent.bw ?? P.clientWidth, hh = o.h ?? parent.bh ?? P.clientHeight;
    const el = h('div', 'sc-a sc-compare', { left: o.x ?? 0, top: o.y ?? 0, width: w, height: hh }, P);
    const pane = () => h('div', 'sc-a sc-cmp-pane', { left: 0, top: 0, width: w, height: hh }, el);
    const a = pane(), b = pane();
    const lw = U * 0.3, line = h('div', 'sc-a sc-cmp-line', { top: 0, height: hh, width: lw }, el);
    const knob = h('div', 'sc-a sc-cmp-knob', { top: hh / 2 - U * 2.3 }, el);
    knob.append(icon('back', U * 1.6), icon('chevron', U * 1.6));
    const labels = o.labels || ['之前', '之后'];
    const st = curStage;
    const la = h('div', 'sc-a sc-tag', null, st.over, labels[0]);
    const lb = h('div', 'sc-a sc-tag accent', null, st.over, labels[1]);
    return {
      el, a: { body: a, bw: w, bh: hh, el: a }, b: { body: b, bw: w, bh: hh, el: b },
      set(t, p, show = 1) {
        const k = E.move(clamp(p)), x = k * w;
        b.style.clipPath = `inset(0 ${f2(w - x)}px 0 0)`;
        const lineOn = clamp(Math.min(p * 12, (1 - p) * 12)) * clamp(show);
        line.style.left = f2(x - lw / 2) + 'px'; line.style.opacity = f2(lineOn);
        knob.style.left = f2(x - U * 2.3) + 'px'; knob.style.opacity = f2(lineOn);
        const r = st.toScreenRect(box(el), t), pad = U * 1.6;
        // "之前"标签在右上角，分隔线扫到它时才淡出；"之后"标签在左上角，分隔线扫过它之后才出现
        const ka = (w - pad - la.offsetWidth) / w, kb = (pad + lb.offsetWidth) / w;
        const sa = clamp(show) * (1 - clamp((k - ka + 0.02) / 0.06)), sb = clamp(show) * clamp((k - kb) / 0.06);
        css(la, { left: r.x + r.w - pad - la.offsetWidth, top: r.y + pad, opacity: f2(sa), visibility: sa > 0.01 ? 'visible' : 'hidden' });
        css(lb, { left: r.x + pad, top: r.y + pad, opacity: f2(sb), visibility: sb > 0.01 ? 'visible' : 'hidden' });
      },
    };
  }

  // ---------------------------------------------------------------------------------------------
  // 界面骨架（放在外框 body 里，坐标是 body 的局部坐标）

  /** 侧栏：opts w（默认 19u）、brand（产品名，默认"示例工作台"）、items: [{ icon, label, badge }]、active（初始选中项）、foot（底部用户名）
   *  返回 { el, items（每项的元素，可当光标目标）, w, select(i, p) }：select 把高亮从初始项移到第 i 项 */
  function sidebar(parent, o = {}) {
    const P = host(parent), w = o.w ?? U * 19, rowH = o.rowH ?? U * 4.3, y0 = o.top ?? U * 7.6;
    const el = h('div', 'sc-a sc-side', { left: 0, top: 0, width: w, height: '100%' }, P);
    const brand = h('div', 'sc-a sc-brand', { left: U * 2, top: U * 2.2 }, el);
    brand.append(logoSvg(U * 2.8));
    h('span', null, null, brand, o.brand || '示例工作台');
    const iw = w - U * 2.4, ih = rowH - U * 0.6;
    const hi = h('div', 'sc-a sc-side-hi', { left: U * 1.2, width: iw, height: ih }, el);
    const items = (o.items || []).map((it, i) => {
      const r = h('div', 'sc-a sc-side-item', { left: U * 1.2, top: y0 + i * rowH, width: iw, height: ih }, el);
      r.append(icon(it.icon || 'doc', U * 1.9));
      h('span', null, null, r, it.label);
      if (it.badge != null) h('b', 'sc-side-badge', null, r, String(it.badge));
      return r;
    });
    if (o.foot) {
      const ft = h('div', 'sc-a sc-side-foot', { left: U * 2, bottom: U * 2 }, el);
      avatar(ft, { text: Array.from(o.foot)[0], size: U * 2.8, i: 2 });
      h('span', null, null, ft, o.foot);
    }
    const a0 = o.active ?? 0;
    const api = {
      el, items, w,
      select(i, p) {
        const k = E.move(clamp(p)), on = k < 0.5 ? a0 : i;
        hi.style.top = f2(y0 + lerp(a0, i, k) * rowH) + 'px';
        items.forEach((r, j) => r.classList.toggle('on', j === on));
      },
    };
    api.select(a0, 1);
    return api;
  }

  /** 页面标题栏：opts x, y, w, h（默认 6u）, title, sub, actions: [{ label, kind, icon }]；返回 { el, btns }（btns 是 SC.button 对象） */
  function header(parent, o) {
    const P = host(parent);
    const el = h('div', 'sc-a sc-header', { left: o.x, top: o.y, width: o.w, height: o.h ?? U * 6 }, P);
    const tx = h('div', null, null, el);
    h('div', 'sc-h1', null, tx, o.title);
    if (o.sub) h('div', 'sc-h1-sub', null, tx, o.sub);
    const acts = h('div', 'sc-header-act', null, el);
    const btns = (o.actions || []).map(a => button(acts, a));
    return { el, btns };
  }

  /** 按钮：opts x, y（不给就跟随父容器排版）, w, h, label, icon, kind: 'primary' | 'secondary' | 'ghost' | 'danger', size（字号，默认 1.55u）
   *  返回 { el, press(p), hover(p), draw(p) }：press 用 SC.pulse(t, 点击时刻)；hover 鼠标停留时的浮起和描边 */
  function button(parent, o) {
    const P = host(parent), kind = o.kind || 'primary';
    const el = h('div', `sc-btn sc-btn-${kind}` + (o.x != null ? ' sc-a' : ''), null, P);
    if (o.x != null) css(el, { left: o.x, top: o.y });
    if (o.w) css(el, { width: o.w });
    if (o.size) css(el, { fontSize: o.size, height: o.h ?? o.size * 2.5, padding: `0 ${f2(o.size * 1.25)}px`, borderRadius: o.size * 0.62 });
    else if (o.h) css(el, { height: o.h });
    if (o.icon) el.append(icon(o.icon, (o.size || U * 1.55) * 1.2));
    if (o.label) h('span', null, null, el, o.label);
    const shine = h('i', 'sc-sheen', { left: '-60%', opacity: 0 }, el);
    const s = { p: 0, hv: 0, d: 1, sh: -1 };
    const apply = () => {
      el.style.transform = tf(0, -s.hv * U * 0.25 + (1 - s.d) * U * 1.5, 1 - 0.05 * s.p + 0.015 * s.hv);
      el.style.filter = s.p > 0.001 ? `brightness(${(1 - 0.12 * s.p).toFixed(3)})` : 'none';
      el.style.outline = s.hv > 0.01 ? `${f2(U * 0.4 * s.hv)}px solid ${rgba(C.accent, 0.2)}` : 'none';
      el.style.opacity = f2(clamp(s.d * 2));
      shine.style.opacity = s.sh > 0 && s.sh < 1 ? 1 : 0;
      shine.style.left = `${f2(lerp(-60, 130, clamp(s.sh)))}%`;
    };
    apply();
    return {
      el,
      press(p) { s.p = clamp(p); apply(); },
      hover(p) { s.hv = clamp(p); apply(); },
      draw(p) { s.d = p; apply(); },
      /** 扫光：q 从 0 到 1 时一道光带扫过按钮 */
      sheen(q) { s.sh = q; apply(); },
    };
  }

  /** 输入框：opts x, y, w, h（默认 4.6u）, placeholder, icon, label（框上方的字段名）, size（字号）
   *  返回 { el, type(text, p, t), focus(p) }：type 打字（p 是打字进度，SLATE.seg(t, 开始, 结束, linear)；t 用来让光标闪烁）；focus 聚焦描边 */
  function field(parent, o) {
    const P = host(parent), fh = o.h ?? U * 4.6;
    if (o.label) h('div', 'sc-a sc-label', { left: o.x, top: o.y - U * 2.6 }, P, o.label);
    const el = h('div', 'sc-a sc-field', { left: o.x, top: o.y, width: o.w, height: fh }, P);
    if (o.size) el.style.fontSize = o.size + 'px';
    if (o.icon) el.append(icon(o.icon, U * 2, o.icon === 'spark' ? C.accent : null, { filled: o.icon === 'spark' }));
    const inn = h('div', 'sc-field-in', null, el);
    const ph = h('span', 'sc-field-ph', null, inn, o.placeholder || '');
    const tx = h('span', null, null, inn, '');
    const caret = h('i', 'sc-caret', null, inn);
    if (o.value) tx.textContent = o.value;
    const s = { f: 0 };
    const api = {
      el,
      type(text, p, t = 0) {
        const str = S.typewriter(text, p);
        if (tx.textContent !== str) tx.textContent = str;
        ph.style.opacity = str ? 0 : 1;
        const typing = p > 0 && p < 1;
        caret.style.opacity = s.f > 0.5 && (typing || Math.floor(t * 1.8) % 2 === 0) ? 1 : 0;
      },
      focus(p) {
        s.f = clamp(p);
        el.style.boxShadow = s.f > 0.01 ? `inset 0 0 0 ${f2(1 + U * 0.1 * s.f)}px ${mix('#DCE0E7', C.accent, s.f)}, 0 0 0 ${f2(U * 0.4 * s.f)}px ${rgba(C.accent, 0.16 * s.f)}` : 'inset 0 0 0 1px var(--ui-border)';
        if (s.f <= 0.5) caret.style.opacity = 0;
      },
    };
    api.focus(0);
    return api;
  }

  /** 开关：opts x, y, size（高度，默认 2.5u）；set(p) 0 = 关，1 = 开 */
  function toggle(parent, o) {
    const P = host(parent), k = (o.size ?? U * 2.5) / (U * 2.5);
    const el = h('div', 'sc-a sc-toggle', { left: o.x, top: o.y, width: U * 4.4 * k, height: U * 2.5 * k, borderRadius: U * 1.25 * k }, P);
    const knob = h('i', null, { width: U * 2 * k, height: U * 2 * k, left: U * 0.25 * k, top: U * 0.25 * k }, el);
    const off = el.closest('[data-theme=dark]') ? '#343C4B' : '#D3D8E1';
    return {
      el,
      set(p) { const q = E.move(clamp(p)); knob.style.transform = tf(q * U * 1.9 * k, 0); el.style.background = mix(off, C.accent, q); },
    };
  }

  /** 状态标签：opts text, tone: 'accent' | 'success' | 'warn' | 'danger' | 'info' | 'muted', x, y（可选）；返回元素 */
  function chip(parent, o) {
    const c = toneColor(o.tone);
    const e = h('span', 'sc-chip' + (o.x != null ? ' sc-a' : ''), null, parent ? host(parent) : null, o.text);
    e.style.setProperty('--c', c);   // 底色和字色在 style.css 里按浅色 / 深色界面分别混色
    if (o.x != null) css(e, { left: o.x, top: o.y });
    return e;
  }

  /** 头像：opts x, y（可选）, size, text（一个字）, i（配色序号）；返回元素 */
  const AV = [['#E6ECFF', '#3F5BD6'], ['#FDEBE4', '#C2562F'], ['#E3F4EC', '#23885C'], ['#F4ECFB', '#7E4CB8'], ['#FFF3DC', '#A26B0C'], ['#E5F2F8', '#2A7898']];
  function avatar(parent, o) {
    const [bg, fg] = AV[(o.i ?? 0) % AV.length], s = o.size ?? U * 2.8;
    const e = h('div', 'sc-av' + (o.x != null ? ' sc-a' : ''), { width: s, height: s, fontSize: s * 0.44, background: bg, color: fg }, host(parent), o.text);
    if (o.x != null) css(e, { left: o.x, top: o.y });
    return e;
  }

  /** 占位条（示意界面里不重要的文字）：opts x, y, w, lines（默认 3）, h（条高，默认 1.1u）, gap, seed；返回元素 */
  function skel(parent, o) {
    const P = host(parent), n = o.lines ?? 3, bh = o.h ?? U * 1.1, gap = o.gap ?? U * 1.1, r = S.rng(o.seed ?? 7);
    const e = h('div', 'sc-a sc-skel', { left: o.x, top: o.y, width: o.w }, P);
    for (let i = 0; i < n; i++) h('i', null, { height: bh, width: `${Math.round(i === n - 1 ? 45 + r() * 20 : 75 + r() * 25)}%`, marginBottom: i < n - 1 ? gap : 0 }, e);
    return e;
  }

  /** 卡片：opts x, y, w, h, title, sub, pad（默认 1.8u）；返回 { el, body（同 el）, pad, top（标题下方的 y）, draw(p) }：draw 上浮淡入 */
  function card(parent, o) {
    const P = host(parent), pad = o.pad ?? U * 1.8;
    const el = h('div', 'sc-a sc-card', { left: o.x, top: o.y, width: o.w, height: o.h }, P);
    let y = pad;
    if (o.title) { h('div', 'sc-a sc-card-t', { left: pad, top: pad - U * 0.2 }, el, o.title); y += U * 2.6; }
    if (o.sub) { h('div', 'sc-a sc-card-s', { right: pad, top: pad }, el, o.sub); }
    return {
      el, body: el, pad, top: y + U * 0.6, w: o.w, h: o.h,
      draw(p) { el.style.opacity = f2(clamp(p * 1.8)); el.style.transform = tf(0, (1 - p) * U * 2); },
    };
  }

  /** 指标卡：opts x, y, w, h, label, value, digits, unit, prefix, delta（如 '↑ 12.4%'）, down（下降用红色）, spark（迷你折线数据）
   *  draw(p)：卡片浮现、数字滚动、迷你折线画出 */
  function kpi(parent, o) {
    const c = card(parent, { x: o.x, y: o.y, w: o.w, h: o.h }), pad = U * 1.8;
    h('div', 'sc-a sc-kpi-l', { left: pad, top: pad - U * 0.2 }, c.el, o.label);
    const v = h('div', 'sc-a sc-kpi-v', { left: pad, top: pad + U * 2.1 }, c.el);
    const num = h('span', null, null, v, '');
    if (o.unit) h('span', 'sc-kpi-u', null, v, o.unit);
    if (o.delta) chip(c.el, { text: o.delta, tone: o.down ? 'danger' : 'success', x: pad, y: o.h - pad - U * 2.3 });
    let line = null, areaP = null, clip = null, sw = 0;
    if (o.spark) {
      sw = o.w * 0.44; const sh = o.h * 0.34, sx = o.w - pad - sw, sy = o.h - pad - sh;
      const svg = S.svg('svg', { class: 'sc-a', width: sw, height: sh, viewBox: `0 0 ${sw} ${sh}`, style: `left:${sx}px;top:${sy}px;overflow:visible` }, c.el);
      const mn = Math.min(...o.spark), mxv = Math.max(...o.spark);
      const pts = o.spark.map((d, i) => [i / (o.spark.length - 1) * sw, sh - (d - mn) / Math.max(1e-9, mxv - mn) * sh * 0.9 - sh * 0.05]);
      const gid = nid('kg'), cid = nid('kc'), defs = S.svg('defs', {}, svg);
      const lg = S.svg('linearGradient', { id: gid, x1: 0, y1: 0, x2: 0, y2: 1 }, defs);
      S.svg('stop', { offset: 0, 'stop-color': C.accent, 'stop-opacity': 0.22 }, lg);
      S.svg('stop', { offset: 1, 'stop-color': C.accent, 'stop-opacity': 0 }, lg);
      clip = S.svg('rect', { x: -2, y: -U, width: 0, height: sh + U * 2 }, S.svg('clipPath', { id: cid }, defs));
      const d = monoPath(pts);
      areaP = S.svg('path', { d: `${d} L ${sw} ${sh} L 0 ${sh} Z`, fill: `url(#${gid})`, 'clip-path': `url(#${cid})` }, svg);
      line = S.svg('path', { d, fill: 'none', stroke: C.accent, 'stroke-width': U * 0.28, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'clip-path': `url(#${cid})` }, svg);
    }
    return {
      el: c.el,
      draw(p) {
        c.draw(p);
        const k = E.glide(clamp(p * 1.3 - 0.15));
        num.textContent = (o.prefix || '') + fmt(lerp(o.from ?? 0, o.value, k), o.digits ?? 0);
        if (clip) clip.setAttribute('width', f2((sw + 4) * E.move(clamp(p * 1.4 - 0.3))));
      },
    };
  }

  /** 单调三次曲线（经过每个点，不过冲，适合数据） */
  function monoPath(P) {
    const n = P.length;
    if (n < 2) return '';
    const dx = [], m = [], tg = [];
    for (let i = 0; i < n - 1; i++) { dx[i] = P[i + 1][0] - P[i][0]; m[i] = (P[i + 1][1] - P[i][1]) / dx[i]; }
    tg[0] = m[0]; tg[n - 1] = m[n - 2];
    for (let i = 1; i < n - 1; i++) tg[i] = m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2;
    for (let i = 0; i < n - 1; i++) {
      if (m[i] === 0) { tg[i] = tg[i + 1] = 0; continue; }
      const a = tg[i] / m[i], b = tg[i + 1] / m[i], s2 = a * a + b * b;
      if (s2 > 9) { const k = 3 / Math.sqrt(s2); tg[i] = k * a * m[i]; tg[i + 1] = k * b * m[i]; }
    }
    let d = `M ${f2(P[0][0])} ${f2(P[0][1])}`;
    for (let i = 0; i < n - 1; i++) {
      const t3 = dx[i] / 3;
      d += ` C ${f2(P[i][0] + t3)} ${f2(P[i][1] + tg[i] * t3)} ${f2(P[i + 1][0] - t3)} ${f2(P[i + 1][1] - tg[i + 1] * t3)} ${f2(P[i + 1][0])} ${f2(P[i + 1][1])}`;
    }
    return d;
  }
  const niceMax = v => { const e = Math.pow(10, Math.floor(Math.log10(Math.max(1e-9, v)))), f = v / e; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * e; };

  /** 图表：opts x, y, w, h, kind: 'area'（默认）| 'line' | 'bar', data, labels（横轴）, max（默认自动取整）, ticks（纵轴格数，默认 4）,
   *        unit（提示框里的单位）, every（每隔几个标签显示一个）, hi（柱状图里用强调色的那根，其余浅色）, tick（纵轴数字格式函数）
   *  返回 { el, draw(p), mark(i, p), point(i) }：draw 折线从左往右画出、柱子依次长出；mark 在第 i 个点显示竖线和提示框；
   *        point(i) 返回第 i 个点的世界坐标目标（给镜头、标注用） */
  function chart(parent, o) {
    const P = host(parent), kind = o.kind || 'area', n = o.data.length;
    const el = h('div', 'sc-a sc-chart', { left: o.x, top: o.y, width: o.w, height: o.h }, P);
    const dark = !!el.closest('[data-theme=dark]');
    const svg = S.svg('svg', { width: o.w, height: o.h, viewBox: `0 0 ${o.w} ${o.h}` }, el);
    const padL = o.axis === false ? U * 0.4 : U * 4.4, padB = o.labels ? U * 3 : U * 0.6, padT = U * 1.2, padR = U * 0.8;
    const iw = o.w - padL - padR, ih = o.h - padT - padB;
    const max = o.max ?? niceMax(Math.max(...o.data) * 1.08), ticks = o.ticks ?? 4;
    const gridC = dark ? '#262D3A' : '#ECEFF4', labC = dark ? '#7C8599' : '#8C95A8';
    // 坐标轴文字用 HTML：SVG 文字在镜头缩放时会按排版时的缩放缓存字形，渲染结果和渲染顺序有关，破坏确定性
    const txt = (x, y, s, anchor) => {
      const e = h('div', 'sc-a', { fontSize: U * 1.3, color: labC, whiteSpace: 'nowrap', lineHeight: 1, top: y - U * 1.0 }, el, s);
      const w = e.offsetWidth;
      e.style.left = f2(anchor === 'end' ? x - w : anchor === 'middle' ? x - w / 2 : x) + 'px';
      return e;
    };
    for (let k = 0; k <= ticks; k++) {
      const y = padT + ih * (1 - k / ticks);
      S.svg('line', { x1: padL, x2: padL + iw, y1: y, y2: y, stroke: gridC, 'stroke-width': 1, 'stroke-dasharray': k ? '4 5' : 'none' }, svg);
      if (o.axis !== false) txt(padL - U * 1, y + U * 0.45, o.tick ? o.tick(max * k / ticks) : fmt(max * k / ticks), 'end');
    }
    const X = i => (kind === 'bar' ? padL + iw * (i + 0.5) / n : padL + iw * i / Math.max(1, n - 1));
    const Y = v => padT + ih * (1 - clamp(v / max));
    if (o.labels) o.labels.forEach((l, i) => { if (i % (o.every || 1) === 0) txt(X(i), o.h - U * 0.7, l, 'middle'); });
    const pts = o.data.map((v, i) => [X(i), Y(v)]);
    let reveal = null, head = null, bars = [], lineEl = null;
    if (kind === 'bar') {
      const bw = iw / n * 0.56, soft = mix(C.accent, dark ? '#161B25' : '#FFFFFF', 0.6);
      bars = o.data.map((v, i) => S.svg('path', { fill: o.hi == null || o.hi === i ? C.accent : soft }, svg));
      bars.forEach((b, i) => { b.__x = X(i) - bw / 2; b.__w = bw; b.__h = ih * clamp(o.data[i] / max); });
    } else {
      const gid = nid('cg'), cid = nid('cc'), defs = S.svg('defs', {}, svg);
      const lg = S.svg('linearGradient', { id: gid, x1: 0, y1: 0, x2: 0, y2: 1 }, defs);
      S.svg('stop', { offset: 0, 'stop-color': C.accent, 'stop-opacity': dark ? 0.32 : 0.2 }, lg);
      S.svg('stop', { offset: 1, 'stop-color': C.accent, 'stop-opacity': 0 }, lg);
      reveal = S.svg('rect', { x: 0, y: 0, width: 0, height: o.h }, S.svg('clipPath', { id: cid }, defs));
      const d = monoPath(pts);
      if (kind === 'area') S.svg('path', { d: `${d} L ${f2(padL + iw)} ${f2(padT + ih)} L ${f2(padL)} ${f2(padT + ih)} Z`, fill: `url(#${gid})`, 'clip-path': `url(#${cid})` }, svg);
      lineEl = S.svg('path', { d, fill: 'none', stroke: C.accent, 'stroke-width': U * 0.32, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'clip-path': `url(#${cid})` }, svg);
      head = S.svg('circle', { r: U * 0.6, fill: C.accent, stroke: dark ? '#161B25' : '#fff', 'stroke-width': U * 0.3, opacity: 0 }, svg);
    }
    // 提示框
    const guide = S.svg('line', { y1: padT, y2: padT + ih, stroke: dark ? '#4A5367' : '#C3CAD6', 'stroke-width': 1.2, 'stroke-dasharray': '4 4', opacity: 0 }, svg);
    const ring = S.svg('circle', { r: U * 0.75, fill: C.accent, stroke: dark ? '#161B25' : '#fff', 'stroke-width': U * 0.35, opacity: 0 }, svg);
    const tip = h('div', 'sc-tip', { opacity: 0 }, el);
    const tipL = h('span', null, null, tip), tipV = h('b', null, null, tip);
    const yAt = x => { // 折线上横坐标为 x 的点（用路径长度二分查找）
      const L = lineEl.getTotalLength();
      let a = 0, b = L;
      for (let k = 0; k < 22; k++) { const m = (a + b) / 2; if (lineEl.getPointAtLength(m).x < x) a = m; else b = m; }
      return lineEl.getPointAtLength((a + b) / 2).y;
    };
    return {
      el,
      draw(p) {
        if (kind === 'bar') {
          bars.forEach((b, i) => {
            const q = E.glide(clamp(p * 1.6 - i * (0.6 / Math.max(1, n - 1))));
            const hh = b.__h * q, r = Math.min(U * 0.5, b.__w / 2, hh), x = b.__x, w = b.__w, y = padT + ih - hh;
            b.setAttribute('d', hh < 0.5 ? '' : `M ${f2(x)} ${f2(padT + ih)} V ${f2(y + r)} Q ${f2(x)} ${f2(y)} ${f2(x + r)} ${f2(y)} H ${f2(x + w - r)} Q ${f2(x + w)} ${f2(y)} ${f2(x + w)} ${f2(y + r)} V ${f2(padT + ih)} Z`);
          });
        } else {
          const k = E.move(clamp(p)), xr = padL + iw * k;
          reveal.setAttribute('width', f2(xr + U * 0.4));
          head.setAttribute('opacity', k > 0.01 && k < 0.995 ? 1 : 0);
          const on = k > 0.01 && k < 0.995;
          head.setAttribute('cx', on ? f2(xr) : 0); head.setAttribute('cy', on ? f2(yAt(xr)) : 0);
        }
      },
      mark(i, p) {
        const q = E.glide(clamp(p)), [x, y] = pts[i];
        guide.setAttribute('x1', x); guide.setAttribute('x2', x); guide.setAttribute('opacity', f2(q));
        ring.setAttribute('cx', x); ring.setAttribute('cy', y); ring.setAttribute('opacity', kind === 'bar' ? 0 : f2(q));
        ring.setAttribute('r', f2(U * 0.75 * (0.5 + 0.5 * q)));
        tipL.textContent = o.labels ? o.labels[i] : '';
        tipV.textContent = fmt(o.data[i], o.digits ?? 0) + (o.unit || '');
        const tw = tip.offsetWidth, th = tip.offsetHeight;
        css(tip, { left: clamp(x - tw / 2, 0, o.w - tw), top: Math.max(0, y - th - U * 1.6) + (1 - q) * U, opacity: f2(q) });
      },
      point(i) { return () => { const b = box(el); return { x: b.x + pts[i][0], y: b.y + pts[i][1], w: 0, h: 0 }; }; },
    };
  }

  /** 表格：opts x, y, w, cols: [{ label, w（占比，合计 1）, align: 'left' | 'right' }], rows: [[单元格…]], rowH（默认 4.8u）, headH（默认 3.8u）
   *  单元格可以是：文字；{ chip, tone }；{ avatar, text, i }；{ bar: 0～1, text }；{ strong }；{ muted }
   *  返回 { el, rows（行元素）, cell(i, j), draw(p), hi(i, p) }：draw 逐行出现；hi 高亮第 i 行 */
  function table(parent, o) {
    const P = host(parent), rowH = o.rowH ?? U * 4.8, headH = o.headH ?? U * 3.8;
    const el = h('div', 'sc-a sc-table', { left: o.x, top: o.y, width: o.w }, P);
    const tds = (row, cells, isHead) => o.cols.map((c, j) => {
      const td = h('div', 'sc-td' + (c.align === 'right' ? ' r' : ''), { width: o.w * c.w }, row);
      const v = cells[j];
      if (isHead || typeof v === 'string' || typeof v === 'number') td.textContent = isHead ? c.label : String(v);
      else if (v && v.chip) td.append(chip(null, { text: v.chip, tone: v.tone }));
      else if (v && v.avatar) { avatar(td, { text: v.avatar, size: U * 2.6, i: v.i ?? j }); h('span', null, null, td, v.text); }
      else if (v && v.bar != null) { const pg = h('div', 'sc-prog', null, td); h('i', null, { width: `${Math.round(clamp(v.bar) * 100)}%` }, pg); if (v.text) h('span', null, { color: 'var(--ui-ink2)' }, td, v.text); }
      else if (v && v.strong != null) h('b', null, null, td, String(v.strong));
      else if (v && v.muted != null) h('span', null, { color: 'var(--ui-muted)' }, td, String(v.muted));
      return td;
    });
    const head = h('div', 'sc-tr sc-th', { height: headH }, el);
    tds(head, [], true);
    const rows = o.rows.map(cells => {
      const r = h('div', 'sc-tr', { height: rowH }, el);
      const hi = h('div', 'sc-tr-hi', null, r);
      const cs = tds(r, cells, false);
      return { r, hi, cs };
    });
    return {
      el, rows: rows.map(x => x.r),
      cell: (i, j) => rows[i].cs[j],
      draw(p) {
        head.style.opacity = f2(clamp(p * 4));
        rows.forEach((x, i) => { const q = E.glide(clamp(p * 1.8 - i * (0.8 / Math.max(1, rows.length)))); x.r.style.opacity = f2(q); x.r.style.transform = tf(0, (1 - q) * U * 1.2); });
      },
      hi(i, p) { rows.forEach((x, j) => { x.hi.style.opacity = f2(j === i ? clamp(p) : 0); }); },
    };
  }

  /** 清单：opts x, y, w, items: [文字], gap（行距，默认 4.4u）；返回 { el, rows, draw(p), check(i, p) }：check 打勾（圆圈填色、对勾画出） */
  function checklist(parent, o) {
    const P = host(parent), gap = o.gap ?? U * 4.4, s = U * 2.4;
    const rows = o.items.map((text, i) => {
      const r = h('div', 'sc-ck-row', { left: o.x, top: o.y + i * gap, width: o.w }, P);
      const bx = h('div', 'sc-ck-box', null, r);
      const svg = S.svg('svg', { width: s, height: s, viewBox: '0 0 24 24' }, bx);
      const ck = S.svg('path', { d: 'M6.5 12.5l3.7 3.7 7.3-7.6', stroke: '#fff', 'stroke-width': 2.6, fill: 'none', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, svg);
      const tx = h('span', null, null, r, text);
      return { r, bx, ck, tx };
    });
    return {
      el: rows.map(x => x.r), rows: rows.map(x => x.r),
      draw(p) { rows.forEach((x, i) => { const q = E.glide(clamp(p * 1.6 - i * 0.2)); x.r.style.opacity = f2(q); x.r.style.transform = tf((1 - q) * U * 1.5, 0); }); },
      check(i, p) {
        const x = rows[i], q = clamp(p);
        x.bx.style.background = q > 0 ? rgba(C.accent, clamp(q * 3)) : 'transparent';
        x.bx.style.boxShadow = q > 0 ? 'none' : `inset 0 0 0 ${f2(U * 0.18)}px var(--ui-border)`;
        x.bx.style.transform = tf(0, 0, 1 + 0.18 * Math.sin(Math.PI * clamp(q * 1.5)));
        S.draw(x.ck, clamp(q * 1.6 - 0.4));
        x.tx.style.color = q > 0.5 ? 'var(--ui-muted)' : 'var(--ui-ink)';
      },
    };
  }

  /** 流式文字（AI 回答、生成结果逐字出现，最新的几个字带淡入）：opts x, y, w, text, size（默认 1.6u）, color
   *  set(p)：p 0 → 1 文字流出。所有字在创建时就排好版，流出过程中布局不变 */
  function stream(parent, o) {
    const P = host(parent);
    const el = h('div', 'sc-a sc-stream', { left: o.x, top: o.y, width: o.w }, P);
    if (o.size) el.style.fontSize = o.size + 'px';
    if (o.color) el.style.color = o.color;
    const spans = Array.from(o.text).map(ch => h('span', null, { opacity: 0 }, el, ch));
    const fade = 6;
    return {
      el,
      set(p) { const head = clamp(p) * (spans.length + fade); spans.forEach((s, i) => { s.style.opacity = f2(clamp((head - i) / fade)); }); },
    };
  }

  /** 通知：opts x, y, w, title, text, icon（默认 check）, tone（默认 success）, from: 'top' | 'bottom'
   *  set(t, at, until)：at 秒弹出（弹簧），until 秒收起（可选） */
  function toast(parent, o) {
    const P = host(parent);
    const el = h('div', 'sc-a sc-toast', { left: o.x, top: o.y, width: o.w, opacity: 0 }, P);
    const ic = h('div', 'sc-toast-i', { background: toneColor(o.tone || 'success') }, el);
    ic.append(icon(o.icon || 'check', U * 2, '#fff', { sw: 2.6 }));
    const tx = h('div', null, null, el);
    h('div', 'sc-toast-t', null, tx, o.title);
    if (o.text) h('div', 'sc-toast-s', null, tx, o.text);
    const dir = o.from === 'bottom' ? 1 : -1;
    return {
      el,
      set(t, at, until) {
        const p = pop(t, at), q = until != null ? E.exit(clamp((t - until) / 0.35)) : 0;
        el.style.opacity = f2(clamp(p * 3) * (1 - q));
        el.style.visibility = p <= 0 || q >= 1 ? 'hidden' : 'visible';
        el.style.transform = tf(0, dir * ((1 - p) * U * 3 + q * U * 2), 0.96 + 0.04 * p);
      },
    };
  }

  /** 分组容器：在父容器里开一块绝对定位的区域（页面、表单栏、预览区……），之后可以直接当父容器传给其他组件。
   *  opts x, y, w, h（默认铺满父容器）, cls；返回 { el, body, bw, bh } */
  function group(parent, o = {}) {
    const P = host(parent), w = o.w ?? parent.bw ?? P.clientWidth, hh = o.h ?? parent.bh ?? P.clientHeight;
    const el = h('div', 'sc-a' + (o.cls ? ' ' + o.cls : ''), { left: o.x ?? 0, top: o.y ?? 0, width: w, height: hh }, P);
    return { el, body: el, bw: w, bh: hh };
  }

  /** 界面切换（同一个外框里换页面）：a 淡出左移，b 从右侧滑入。p 0 → 1。隐藏用 visibility，布局不变 */
  function swap(a, b, p, o = {}) {
    const k = E.move(clamp(p)), dx = o.dx ?? U * 6, A = elOf(a), B = elOf(b);
    css(A, { opacity: f2(1 - k), transform: tf(-k * dx * 0.5, 0), visibility: k >= 1 ? 'hidden' : 'visible' });
    css(B, { opacity: f2(k), transform: tf((1 - k) * dx, 0), visibility: k <= 0 ? 'hidden' : 'visible' });
  }

  // ---------------------------------------------------------------------------------------------
  // 叠加层（放 st.hud；这些字都参与 slate-qa 自检）

  const rise = (e, p, dy = U * 1.4) => { const q = clamp(p); e.style.opacity = f2(E.glide(clamp(q * 1.4))); e.style.transform = tf(0, (1 - E.glide(q)) * dy); };

  /** 页面标题：默认居中放在安全区顶部。opts text（不超过 8 个字）, kicker（上方小标签，如"新功能"）, sub（副标题）, align: 'center' | 'left',
   *        size（默认 5.4u）, x, y, w（自定义位置，例如左字右图时放在左栏）
   *  返回 { el, bottom（标题区下沿，内容从这里往下排）, draw(p), out(q) }：draw 逐行从遮罩里升起；镜头推近前用 out 收起 */
  function heading(parent, o) {
    const P = host(parent), align = o.align || 'center';
    const x = o.x ?? S.safe.x + U * 2, y = o.y ?? S.safe.y + U * 1.2, w = o.w ?? S.safe.w - U * 4;
    const el = h('div', `sc-a sc-heading ${align}`, { left: x, top: y, width: w }, P);
    const parts = [];
    if (o.kicker) { const m = h('div', 'sc-mask', null, el), k = h('div', 'sc-kicker', null, m); h('i', null, null, k); h('span', null, null, k, o.kicker); parts.push(k); m.style.marginBottom = f2(U * 0.6) + 'px'; }
    const mt = h('div', 'sc-mask', null, el);
    parts.push(h('div', 'sc-head-t', o.size ? { fontSize: o.size } : null, mt, o.text));
    if (o.sub) { const ms = h('div', 'sc-mask', null, el); parts.push(h('div', 'sc-head-s', null, ms, o.sub)); }
    // 标题框收紧到文字宽度：叠加层元素的框互不重叠，局部重画时不会切到旁边的元素（否则抗锯齿会随渲染顺序变化）
    el.style.width = 'max-content';
    const cw = Math.min(el.offsetWidth, w);
    css(el, { width: cw, left: align === 'center' ? x + (w - cw) / 2 : x });
    const s = { p: 0, q: 0 };
    const apply = () => {
      parts.forEach((e, i) => { const k = E.glide(clamp(s.p * 1.5 - i * 0.22)); e.style.transform = tf(0, (1 - k) * 105, 1, '%'); e.style.opacity = f2(clamp(k * 1.6)); });
      el.style.opacity = f2(1 - E.exit(clamp(s.q)));
      el.style.visibility = s.q >= 1 ? 'hidden' : 'visible';
      el.style.transform = tf(0, -E.exit(clamp(s.q)) * U * 2);
    };
    apply();
    return { el, bottom: y + el.offsetHeight + U * 2.5, draw(p) { s.p = p; apply(); }, out(q) { s.q = q; apply(); } };
  }

  /** 普通文字：opts x, y, w, text, size（默认 2.8u）, weight, color, align；返回 { el, draw(p), out(q) } */
  function text(parent, o) {
    const e = h('div', 'sc-a sc-text', { left: o.x, top: o.y, width: o.w, fontSize: o.size ?? U * 2.8, fontWeight: o.weight ?? 500, textAlign: o.align || 'left' }, host(parent), o.text);
    if (o.color) e.style.color = o.color;
    if (o.nowrap !== false) e.style.whiteSpace = 'nowrap';
    let p0 = 0, q0 = 0;
    const apply = () => { rise(e, p0); e.style.opacity = f2(+e.style.opacity * (1 - clamp(q0))); };
    apply();
    return { el: e, bottom: o.y + e.offsetHeight, draw(p) { p0 = p; apply(); }, out(q) { q0 = q; apply(); } };
  }

  /** 卖点清单（叠加层，大字）：opts x, y, w, items: [文字], size（默认 2.8u）, icon（默认 check）
   *  返回 { el, rows, bottom, draw(i, p) }：每条单独入场，和旁白点名对齐 */
  function points(parent, o) {
    const el = h('div', 'sc-a sc-points', { left: o.x, top: o.y, width: o.w }, host(parent));
    const rows = o.items.map(it => {
      const r = h('div', 'sc-pt', o.size ? { fontSize: o.size } : null, el);
      const ic = h('div', 'sc-pt-i', null, r);
      ic.append(icon(o.icon || 'check', U * 2, null, { sw: 2.4 }));
      h('span', null, null, r, it);
      return r;
    });
    rows.forEach(r => rise(r, 0));
    return { el, rows, bottom: o.y + el.offsetHeight, draw(i, p) { rise(rows[i], p, U * 1.8); } };
  }

  const corner = (e, c, dx = 0, dy = 0) => {
    const w = e.offsetWidth, hh = e.offsetHeight, sx = S.safe.x, sy = S.safe.y, R = S.safe.x + S.safe.w;
    const B = capTop() - (S.captionsOn ? U * 1.5 : 0);
    css(e, { left: Math.round(c[1] === 'r' ? R - w - dx : sx + dx), top: Math.round(c[0] === 'b' ? B - hh - dy : sy + dy) });
  };
  /** "示意"角标：没有用户截图、界面是组件搭的示意稿时必须加。opts text（默认"示意界面"）, corner: 'tr'（默认）| 'tl' | 'br' | 'bl'
   *  返回 { el, bottom, draw(p) }：放在顶部角上时，外框从 bottom 往下排（SC.fit({ top: tag.bottom })），不要压在窗口上 */
  function mark(parent, o = {}) {
    const e = h('div', 'sc-a sc-mark', null, host(parent));
    // 小图标：四个角标记出"画面是示意稿"（不用 CSS 虚线圆，它的抗锯齿和渲染顺序有关）
    const ic = S.svg('svg', { width: U * 1.5, height: U * 1.5, viewBox: '0 0 16 16', class: 'sc-ico' }, e);
    S.svg('path', { d: 'M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4', stroke: 'currentColor', 'stroke-width': 1.8, fill: 'none', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, ic);
    h('span', null, null, e, o.text || '示意界面');
    corner(e, o.corner || 'tr', U * 0.5, U * 0.5);
    return { el: e, bottom: e.offsetTop + e.offsetHeight + U * 1.2, draw(p) { e.style.opacity = f2(E.glide(clamp(p))); } };
  }

  /** 深色小标签（叠加层）：opts x, y, text, accent（用强调色底）, corner（不给 x, y 时贴角）；draw(p) */
  function tag(parent, o) {
    const e = h('div', 'sc-a sc-tag' + (o.accent ? ' accent' : ''), null, host(parent));
    if (o.icon) e.append(icon(o.icon, U * 2, '#fff', { filled: o.icon === 'spark' }));
    h('span', null, null, e, o.text);
    if (o.x != null) css(e, { left: o.x, top: o.y }); else corner(e, o.corner || 'tl', U * 0.5, U * 0.5);
    return { el: e, draw(p) { e.style.opacity = f2(E.glide(clamp(p * 1.5))); e.style.transform = tf(0, 0, 0.9 + 0.1 * E.glide(clamp(p))); } };
  }

  /** 快进标签（"▶▶ 4×"，表示时间压缩）：opts text（默认 '4×'）, x, y 或 corner；draw(p) */
  function speed(parent, o = {}) {
    const e = h('div', 'sc-a sc-tag accent', null, host(parent));
    const s = S.svg('svg', { width: U * 2.4, height: U * 1.6, viewBox: '0 0 24 16' }, e);
    S.svg('path', { d: 'M1 1.5l9 6.5-9 6.5zM12 1.5l9 6.5-9 6.5z', fill: '#fff' }, s);
    h('span', null, null, e, o.text || '4×');
    if (o.x != null) css(e, { left: o.x, top: o.y }); else corner(e, o.corner || 'tr', U * 0.5, U * 5);
    return { el: e, draw(p) { e.style.opacity = f2(E.glide(clamp(p * 1.5))); e.style.transform = tf((1 - E.glide(clamp(p))) * U * 2, 0); } };
  }

  /** 步骤条（"01 选择模板 — 02 填写信息 — 03 一键发布"），放在画面顶部当标题用。opts items（每项不超过 6 个字）, y, done（全部完成的时刻，可选）
   *  返回 { el, bottom, set(t, times, p) }：times 是每一步开始的秒数；p 是整体入场进度（默认 1） */
  function chapter(parent, o) {
    const el = h('div', 'sc-a sc-steps', { left: S.safe.x, top: o.y ?? S.safe.y + U * 1.2 }, host(parent));
    const inn = h('div', 'sc-steps-in', null, el);
    const nodes = o.items.map((label, i) => {
      let line = null;
      if (i) { const ln = h('div', 'sc-step-line', null, inn); line = h('i', null, null, ln); }
      const st = h('div', 'sc-step', null, inn);
      const n = h('div', 'sc-step-n', null, st);
      const num = h('span', null, null, n, String(i + 1).padStart(2, '0'));
      const svg = S.svg('svg', { width: U * 3.6, height: U * 3.6, viewBox: '0 0 24 24' }, n);
      const ck = S.svg('path', { d: 'M7 12.4l3.3 3.3L17.2 9', stroke: '#fff', 'stroke-width': 2.4, fill: 'none', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, svg);
      const lb = h('span', null, null, st, label);
      return { st, n, num, ck, lb, line };
    });
    // 框收紧到步骤条本身并居中（叠加层元素的框互不重叠）
    el.style.width = 'max-content';
    el.style.left = f2(S.safe.x + (S.safe.w - el.offsetWidth) / 2) + 'px';
    const muted = '#9AA2B3', ring = '#CDD3DE';
    return {
      el, bottom: (o.y ?? S.safe.y + U * 1.2) + el.offsetHeight + U * 2,
      set(t, times, p = 1) {
        el.style.opacity = f2(E.glide(clamp(p * 1.5)));
        el.style.transform = tf(0, (1 - E.glide(clamp(p))) * U * 1.5);
        nodes.forEach((x, i) => {
          const act = clamp((t - times[i]) / 0.3), nxt = i + 1 < times.length ? times[i + 1] : o.done;
          const dn = nxt != null ? clamp((t - nxt) / 0.3) : 0;
          x.n.style.background = mix(isDark() ? '#1A2130' : '#FFFFFF', C.accent, Math.max(dn, act * 0.12));
          x.n.style.boxShadow = `inset 0 0 0 ${f2(U * 0.2)}px ${mix(ring, C.accent, act)}` + (act > 0 && dn < 1 ? `, 0 0 0 ${f2(U * 0.5 * act * (1 - dn))}px ${rgba(C.accent, 0.15)}` : '');
          x.num.style.opacity = f2(1 - dn);
          x.num.style.color = mix(muted, C.accent, act);
          S.draw(x.ck, dn);
          x.lb.style.color = mix(muted, isDark() ? '#F3F5FA' : C.ink, act);
          x.lb.style.opacity = f2(1 - 0.3 * dn);
          if (x.line) { const sx = E.move(clamp((t - times[i] + 0.45) / 0.45)); x.line.style.transform = sx >= 1 ? 'none' : `scaleX(${sx.toFixed(4)})`; }
        });
      },
    };
  }
  const isDark = () => !!(curStage && curStage.dark);

  /** 按键提示（快捷键 HUD，字幕区上方居中）：opts presses: [[时刻, ['Ctrl', 'K'], 停留秒数（默认 1.2）]], y；set(t) */
  function keys(parent, o) {
    const P = host(parent), y = o.y ?? capTop() - U * 8;
    const groups = o.presses.map(([t0, ks, dur]) => {
      const g = h('div', 'sc-a sc-keys', { left: 0, width: W, top: y, opacity: 0 }, P);
      ks.forEach((k, i) => { if (i) h('span', 'sc-key-plus', null, g, '+'); h('span', 'sc-key', null, g, k); });
      return { g, t0, dur: dur ?? 1.2 };
    });
    return {
      set(t) {
        groups.forEach(({ g, t0, dur }) => {
          const p = pop(t, t0), q = E.exit(clamp((t - t0 - dur) / 0.3));
          g.style.opacity = f2(clamp(p * 3) * (1 - q));
          g.style.visibility = p <= 0 || q >= 1 ? 'hidden' : 'visible';
          g.style.transform = tf(0, (1 - p) * U * 2, 0.94 + 0.06 * p);
        });
      },
    };
  }

  /** 产品标记 + 名称（收尾、开场用）：opts x, y（中心点）, size（标记边长，默认 7u）, name, img（用户上传的 Logo，/input/…）
   *  返回 { el, draw(p) }：标记弹出，名称随后升起 */
  function logo(parent, o) {
    const el = h('div', 'sc-a sc-logo', null, host(parent));
    const s = o.size ?? U * 7;
    let m;
    if (o.img) { m = h('img', null, { width: s, height: s, objectFit: 'contain' }, el); m.src = o.img; S.waits.push(m.decode().catch(() => null)); }
    else { m = h('div', null, { width: s, height: s, filter: `drop-shadow(0 ${f2(U * 0.8)}px ${f2(U * 1.6)}px ${rgba(C.accent, 0.35)})` }, el); m.append(logoSvg(s)); }
    const nm = o.name ? h('div', 'sc-logo-n', o.nameSize ? { fontSize: o.nameSize } : null, el, o.name) : null;
    css(el, { left: o.x - el.offsetWidth / 2, top: o.y - el.offsetHeight / 2 });
    return {
      el, bottom: o.y + el.offsetHeight / 2,
      draw(p) {
        const k = clamp(p * 1.6);
        m.style.opacity = f2(clamp(k * 3)); m.style.transform = k >= 1 ? 'none' : `scale(${(0.6 + 0.4 * E.glide(k)).toFixed(4)}) rotate(${f2((1 - E.glide(k)) * -8)}deg)`;
        if (nm) rise(nm, clamp(p * 1.6 - 0.45), U * 1.6);
      },
    };
  }

  // ---------------------------------------------------------------------------------------------
  // 跟随镜头的叠加层：光标、聚光灯、标注

  /** 光标（用户的手）：opts kind: 'arrow'（鼠标，默认）| 'touch'（手机触点）, keys: [{ t, at, click, move, bow, drag }], hide（淡出的时刻）
   *  - keys[0] 是出场位置（t 秒淡入）；之后每个 key 的 t 是"到达"时刻，移动时长按距离自动算（0.45～0.95 秒，可用 move 指定）；
   *  - 路径是带一点弧度的三次贝塞尔（bow 控制弧度，默认 0.12），起步快、落点慢，不走直线；
   *  - click: true 在到达后 0.08 秒按下：光标缩小 14%、持续约 0.15 秒，并在落点放一圈涟漪；
   *  - touch 模式只在点按前后出现（真机录屏"显示触点"的样子），drag: true 表示按住滑动到这个点。
   *  返回 { clicks（每次按下的时刻，给按钮的 press 用）, set(t), pos(t) } */
  function cursor(stg, o) {
    const kind = o.kind || 'arrow', ks = (o.keys || []).slice().sort((a, b) => a.t - b.t);
    const el = h('div', `sc-a sc-cursor sc-cursor-${kind}`, { opacity: 0 }, stg.ptr);
    if (kind === 'arrow') {
      const s = S.svg('svg', { width: U * 2.9, height: U * 3.5, viewBox: '0 0 20 24', style: 'display:block;overflow:visible' }, el);
      S.svg('path', { d: 'M2.2 1.6 L2.2 19.4 L6.9 15.3 L9.9 21.9 L13 20.5 L10.1 14.1 L16.4 14.1 Z', fill: '#121722', stroke: '#fff', 'stroke-width': 1.5, 'stroke-linejoin': 'round' }, s);
    }
    const tip = kind === 'arrow' ? [U * 2.9 * 2.2 / 20, U * 3.5 * 1.6 / 24] : [0, 0];
    const clicks = [], cidx = [];
    ks.forEach((k, i) => { if (k.click) { clicks.push(k.t + (k.delay ?? 0.08)); cidx.push(i); } });
    const rip = clicks.map(() => h('div', 'sc-a sc-ripple', { opacity: 0 }, stg.ptr));
    let P = null;
    const pts = () => P || (P = ks.map(k => centerOf(rectOf(k.at))));
    const seg = i => {
      const k = ks[i], prev = ks[i - 1], a = pts()[i - 1], b = pts()[i];
      const dist = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const room = k.t - (prev.t + (prev.click ? 0.3 : 0.05));
      const md = Math.min(k.move ?? clamp(0.42 + dist / W * 0.75, 0.45, 0.95), Math.max(0.15, room));
      return { a, b, s: k.t - md, md, dist };
    };
    const bez = (a, b, e, bow) => {
      const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1;
      let nx = -dy / L, ny = dx / L;
      if (ny > 0) { nx = -nx; ny = -ny; }
      const c1 = [a[0] + dx * 0.3 + nx * L * bow, a[1] + dy * 0.3 + ny * L * bow], c2 = [a[0] + dx * 0.78 + nx * L * bow * 0.5, a[1] + dy * 0.78 + ny * L * bow * 0.5];
      const u = 1 - e;
      return [u * u * u * a[0] + 3 * u * u * e * c1[0] + 3 * u * e * e * c2[0] + e * e * e * b[0], u * u * u * a[1] + 3 * u * u * e * c1[1] + 3 * u * e * e * c2[1] + e * e * e * b[1]];
    };
    const pos = t => {
      const p = pts();
      if (!ks.length) return [0, 0];
      if (t <= ks[0].t) return p[0];
      for (let i = 1; i < ks.length; i++) {
        if (t > ks[i].t) continue;
        const g = seg(i), q = (t - g.s) / g.md;
        return q <= 0 ? g.a : bez(g.a, g.b, E.cursor(clamp(q)), ks[i].bow ?? 0.12);
      }
      return p[p.length - 1];
    };
    return {
      clicks, pos,
      set(t) {
        if (!ks.length) return;
        const z = stg.zoom(t), zf = Math.pow(z, 0.35), [x, y] = stg.toScreen(pos(t), t);
        const press = Math.max(0, ...clicks.map(c => pulse(t, c, 0.16)));
        let vis;
        if (kind === 'arrow') vis = clamp((t - ks[0].t) / 0.2) * (o.hide != null ? 1 - clamp((t - o.hide) / 0.3) : 1);
        else {
          vis = Math.max(0, ...clicks.map(c => clamp((t - c + 0.3) / 0.15) * (1 - clamp((t - c - 0.25) / 0.2))));
          ks.forEach((k, i) => { if (k.drag && i > 0) { const g = seg(i); vis = Math.max(vis, clamp((t - g.s + 0.2) / 0.15) * (1 - clamp((t - k.t - 0.1) / 0.2))); } });
        }
        el.style.opacity = f2(vis);
        el.style.visibility = vis > 0.001 ? 'visible' : 'hidden';
        const sc = zf * (1 - 0.14 * press) * (kind === 'touch' ? 1 - 0.06 * press : 1);
        el.style.transform = tf(x - tip[0] * sc, y - tip[1] * sc, sc);
        rip.forEach((r, j) => {
          const q = (t - clicks[j]) / 0.55;
          if (q < 0 || q > 1) { css(r, { left: 0, top: 0, width: 0, height: 0, opacity: 0, visibility: 'hidden' }); return; }
          const [rx, ry] = stg.toScreen(pts()[cidx[j]], t), d = U * (1.2 + 5.2 * E.glide(q)) * zf;
          css(r, { left: rx - d / 2, top: ry - d / 2, width: d, height: d, opacity: f2(0.6 * (1 - q)), visibility: 'visible' });
        });
      },
    };
  }

  /** 聚光灯：把目标以外的画面压暗。opts at（目标）, pad（留边，默认 1.2u）, radius（圆角，默认 1.2u，随镜头缩放）, dim（压暗程度，默认 0.55）,
   *  ring（目标描边色，默认白色）；set(t, p) */
  function spotlight(stg, o) {
    const e = h('div', 'sc-a sc-spot', { opacity: 0 }, stg.lens);
    const big = Math.max(W, H) * 2;
    return {
      el: e,
      set(t, p) {
        const k = E.glide(clamp(p));
        if (k <= 0.001) { css(e, { visibility: 'hidden', opacity: 0, left: 0, top: 0, width: 0, height: 0, borderRadius: 0, boxShadow: 'none' }); return; }
        const r = stg.toScreenRect(rectOf(o.at), t), z = stg.zoom(t), pad = (o.pad ?? U * 1.2) * (1 + (1 - k) * 0.6);
        css(e, { visibility: 'visible', opacity: 1, left: r.x - pad, top: r.y - pad, width: r.w + pad * 2, height: r.h + pad * 2, borderRadius: (o.radius ?? U * 1.2) * z + pad * 0.4,
          boxShadow: `0 0 0 ${f2(U * 0.3)}px ${rgba(o.ring || '#ffffff', 0.92 * k)}, 0 0 ${f2(U * 2.6)}px ${f2(big)}px rgba(10, 14, 24, ${(o.dim ?? 0.55) * k})` });
      },
    };
  }

  /** 标注气泡：引线从目标指向一句话。opts at（目标）, text（不超过 10 个字）, side: 'top'（默认）| 'bottom' | 'left' | 'right', gap（气泡离目标的距离，默认 6u）,
   *        num（序号，可选）, tone: 'dark'（默认）| 'light'（聚光灯压暗时用浅色）, edge（引线落点：'edge' 目标边缘，默认；'center' 目标中心）
   *  气泡会自动夹在安全区内、字幕区以上，字号不随镜头推近变大。set(t, p)：圆点弹出 → 引线画出 → 气泡浮现 */
  function callout(stg, o) {
    const side = o.side || 'top', gap = o.gap ?? U * 6;
    const g = h('div', 'sc-a sc-callout', { left: 0, top: 0, width: W, height: H }, stg.over);
    const svg = S.svg('svg', { class: 'sc-lead', width: W, height: H, viewBox: `0 0 ${W} ${H}` }, g);
    const light = o.tone === 'light', lc = light ? '#ffffff' : '#141A26';
    // 引线对齐像素网格（整数线宽、端点落在像素中心）：细线的抗锯齿在不同渲染历史下可能不一致
    const lw = Math.max(2, Math.round(U * 0.24)), off = lw % 2 ? 0.5 : 0, snap = v => Math.round(v) + off;
    const ln = S.svg('line', { stroke: lc, 'stroke-width': lw, 'stroke-linecap': 'butt' }, svg);
    const halo = S.svg('circle', { r: U * 1.6, fill: rgba(C.accent, 0.22) }, svg);
    const dot = S.svg('circle', { r: U * 0.7, fill: C.accent, stroke: '#fff', 'stroke-width': U * 0.3 }, svg);
    const bub = h('div', 'sc-bubble' + (light ? ' light' : ''), null, g);
    if (o.num != null) h('span', 'sc-bnum', null, bub, String(o.num));
    h('span', null, null, bub, o.text);
    const bw = bub.offsetWidth, bh = bub.offsetHeight;
    return {
      el: g,
      set(t, p) {
        g.style.visibility = p > 0 ? 'visible' : 'hidden';
        p = clamp(p);
        const r = stg.toScreenRect(rectOf(o.at), t), cx = r.x + r.w / 2, cy = r.y + r.h / 2, c = o.edge === 'center';
        const ax = side === 'left' ? (c ? cx : r.x) : side === 'right' ? (c ? cx : r.x + r.w) : cx;
        const ay = side === 'top' ? (c ? cy : r.y) : side === 'bottom' ? (c ? cy : r.y + r.h) : cy;
        let bx = side === 'left' ? ax - gap - bw : side === 'right' ? ax + gap : ax - bw / 2;
        let by = side === 'top' ? ay - gap - bh : side === 'bottom' ? ay + gap : ay - bh / 2;
        bx = clamp(bx, S.safe.x + U, S.safe.x + S.safe.w - bw - U);
        by = clamp(by, S.safe.y + U, capTop() - bh - U * 1.5);
        const ex = clamp(ax, bx + U * 1.5, bx + bw - U * 1.5), ey = clamp(ay, by + bh * 0.3, by + bh * 0.7);
        const tx = side === 'left' ? bx + bw : side === 'right' ? bx : ex, ty = side === 'top' ? by + bh : side === 'bottom' ? by : ey;
        const k1 = E.glide(clamp(p * 3)), k2 = E.move(clamp(p * 2.4 - 0.5)), k3 = E.glide(clamp(p * 2 - 0.8));
        dot.setAttribute('cx', f2(ax)); dot.setAttribute('cy', f2(ay)); dot.setAttribute('r', f2(U * 0.7 * k1));
        halo.setAttribute('cx', f2(ax)); halo.setAttribute('cy', f2(ay)); halo.setAttribute('r', f2(U * (1 + 1.2 * k1)));
        halo.setAttribute('opacity', f2(k1 * (0.6 + 0.4 * Math.cos(t * 3.2))));
        ln.setAttribute('x1', snap(ax)); ln.setAttribute('y1', snap(ay));
        ln.setAttribute('x2', snap(lerp(ax, tx, k2))); ln.setAttribute('y2', snap(lerp(ay, ty, k2)));
        ln.setAttribute('opacity', k2 > 0 ? 1 : 0);
        const dy = side === 'bottom' ? -1 : side === 'top' ? 1 : 0, dx = side === 'right' ? -1 : side === 'left' ? 1 : 0;
        bub.style.opacity = f2(k3);
        bub.style.transform = tf(bx + dx * (1 - k3) * U * 1.5, by + dy * (1 - k3) * U * 1.5, 0.94 + 0.06 * k3);
      },
    };
  }

  window.SC = {
    C, U, E, D, rgba, mix, setAccent, bezier, pop, pulse, fmt, tf,
    stage, area, fit, box, rectOf,
    frame, shot, compare,
    group, sidebar, header, button, field, toggle, chip, avatar, skel, card, kpi, chart, table, checklist, stream, toast, swap, icon, monoPath,
    heading, text, points, mark, tag, speed, chapter, keys, logo,
    cursor, spotlight, callout,
  };
})();
