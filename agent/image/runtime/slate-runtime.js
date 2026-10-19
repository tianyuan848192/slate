/* Slate 场景运行时：由 slate-render / slate-qa 在场景脚本之前注入。
 *
 * 场景约定：页面定义全局函数 render(t)，t 是本镜内的秒数；画面必须只由 t 决定（纯函数）。
 * 运行时提供 window.SLATE：尺寸、时长、字幕、安全框和常用工具函数；字幕层由运行时自动绘制。
 */
(() => {
  const cfg = window.__SLATE_CONFIG || {};
  const W = cfg.width || 1920, H = cfg.height || 1080;
  const short = Math.min(W, H);
  const safe = { x: Math.round(W * 0.05), y: Math.round(H * 0.05), w: Math.round(W * 0.9), h: Math.round(H * 0.9) };
  const captionsOn = cfg.subtitles !== false && Array.isArray(cfg.captions) && cfg.captions.length > 0;
  // 字幕区：横屏在底部 16%，竖屏抬高一些，避开平台按钮
  const capH = Math.round(H * (W >= H ? 0.16 : 0.14));
  const capY = W >= H ? H - capH - Math.round(H * 0.03) : Math.round(H * 0.70);
  const captionZone = { x: safe.x, y: capY, w: safe.w, h: capH };

  const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
  const lerp = (a, b, p) => a + (b - a) * p;
  const ease = {
    linear: p => p,
    in: p => p * p * p,
    out: p => 1 - Math.pow(1 - p, 3),
    inOut: p => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2),
    back: p => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2); },
    elastic: p => (p === 0 || p === 1 ? p : Math.pow(2, -10 * p) * Math.sin((p * 10 - 0.75) * (2 * Math.PI / 3)) + 1),
  };
  /** t 在 [a, b] 区间内的进度，带缓动；区间外分别为 0 和 1 */
  const seg = (t, a, b, fn = ease.out) => fn(clamp((t - a) / Math.max(1e-6, b - a)));
  /** 第 i 个元素的入场进度：从 start 开始，每个间隔 gap 秒，持续 dur 秒 */
  const stagger = (t, i, start, gap, dur = 0.6, fn = ease.out) => seg(t, start + i * gap, start + i * gap + dur, fn);
  /** 打字机效果：按进度返回前若干个字 */
  const typewriter = (text, p) => Array.from(text).slice(0, Math.round(clamp(p) * Array.from(text).length)).join("");
  /** 数字滚动 */
  const countUp = (to, p, digits = 0, from = 0) => lerp(from, to, clamp(p)).toFixed(digits);
  /** 让 SVG path/line/polyline 按进度"画出来"；路径形状会变时传 recompute=true 重新计算长度 */
  const draw = (el, p, recompute = false) => {
    if (recompute || el.__len === undefined) el.__len = el.getTotalLength ? el.getTotalLength() : 0;
    const L = el.__len;
    el.style.strokeDasharray = `${L} ${L}`;
    el.style.strokeDashoffset = String(L * (1 - clamp(p)));
  };
  const NS = "http://www.w3.org/2000/svg";
  /** 创建 SVG 元素：svg('circle', {cx: 10}, parent) */
  const svg = (tag, attrs = {}, parent) => {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  };
  /** 确定性伪随机（同一个 seed 永远得到同一串数），不要用 Math.random */
  const rng = seed => { let s = (seed >>> 0) || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; };

  // ---- 动画工具（用法和常见的视频动画框架相近：多段插值、弹簧、分段时间轴、转场） ----

  /** 多段插值：interpolate(t, [0, 1, 2], [0, 100, 50], {easing, extrapolate: 'clamp'|'extend'}) */
  const interpolate = (x, input, output, opts = {}) => {
    const fn = opts.easing || ease.linear, clampIt = (opts.extrapolate || "clamp") === "clamp";
    if (x <= input[0] && clampIt) return output[0];
    if (x >= input[input.length - 1] && clampIt) return output[output.length - 1];
    let i = 1;
    while (i < input.length - 1 && x > input[i]) i++;
    const a = input[i - 1], b = input[i], p = (x - a) / Math.max(1e-9, b - a);
    return lerp(output[i - 1], output[i], fn(clampIt ? clamp(p) : p));
  };
  /** 弹簧：从 start 秒开始，由 from 弹到 to。用阻尼振动的解析解计算，完全由 t 决定。
   *  stiffness 越大越快，damping 越小越弹（默认 100 / 10 / 1 会有轻微回弹）；overshoot=false 时不超过终点 */
  const spring = (t, o = {}) => {
    const { from = 0, to = 1, start = 0, stiffness = 100, damping = 10, mass = 1, overshoot = true } = o;
    const x = t - start;
    if (x <= 0) return from;
    const w0 = Math.sqrt(stiffness / mass), zeta = damping / (2 * Math.sqrt(stiffness * mass));
    let y;
    if (zeta < 1) {
      const wd = w0 * Math.sqrt(1 - zeta * zeta);
      y = 1 - Math.exp(-zeta * w0 * x) * (Math.cos(wd * x) + (zeta * w0 / wd) * Math.sin(wd * x));
    } else if (zeta === 1) {
      y = 1 - Math.exp(-w0 * x) * (1 + w0 * x);
    } else {
      const r1 = -w0 * (zeta - Math.sqrt(zeta * zeta - 1)), r2 = -w0 * (zeta + Math.sqrt(zeta * zeta - 1));
      y = 1 - (r2 * Math.exp(r1 * x) - r1 * Math.exp(r2 * x)) / (r2 - r1);
    }
    if (!overshoot) y = Math.min(1, y);
    return from + (to - from) * y;
  };
  /** 平滑噪声（-1～1），用于抖动、漂浮、闪烁：noise(seed, t * 频率) */
  const hashN = n => { let s = (n * 374761393 + 668265263) >>> 0; s = Math.imul(s ^ (s >>> 13), 1274126177) >>> 0; return ((s ^ (s >>> 16)) >>> 0) / 4294967296 * 2 - 1; };
  const noise = (seed, x) => { const i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f); return lerp(hashN(seed * 1013 + i), hashN(seed * 1013 + i + 1), u); };
  /** 分段时间轴：把一镜拆成几段，返回当前段 {index, t（段内秒数）, p（段内进度）, d（段长）}。
   *  segments 是每段时长，例如 [2, 3, 2.5]；也可以用 local(t, start) 直接得到某段内的时间 */
  const sequence = (t, segments) => {
    let s = 0;
    for (let i = 0; i < segments.length; i++) {
      if (t < s + segments[i] || i === segments.length - 1) return { index: i, t: t - s, p: clamp((t - s) / segments[i]), d: segments[i], start: s };
      s += segments[i];
    }
  };
  const local = (t, start) => t - start;
  /** 转场：在 at 秒处、用 dur 秒从 a 切到 b（两个 DOM 元素）。kind：fade | slide | wipe | zoom | blur | flip
   *  dir：left | right | up | down（slide、wipe 用）。返回 0～1 的转场进度 */
  const transition = (t, a, b, o = {}) => {
    const { at = 0, dur = 0.6, kind = "fade", dir = "left", easing = ease.inOut } = o;
    const p = easing(clamp((t - at) / dur));
    const set = (el, css) => { if (el) Object.assign(el.style, css); };
    const vec = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] }[dir] || [-1, 0];
    const none = { opacity: "", transform: "", clipPath: "", filter: "", visibility: "" };
    set(a, { ...none, visibility: p >= 1 ? "hidden" : "visible" });
    set(b, { ...none, visibility: p <= 0 ? "hidden" : "visible" });
    if (kind === "fade") { set(a, { opacity: 1 - p }); set(b, { opacity: p }); }
    else if (kind === "slide") {
      set(a, { transform: `translate(${vec[0] * p * W}px, ${vec[1] * p * H}px)` });
      set(b, { transform: `translate(${-vec[0] * (1 - p) * W}px, ${-vec[1] * (1 - p) * H}px)` });
    } else if (kind === "wipe") {
      const r = ((1 - p) * 100).toFixed(2);
      set(b, { clipPath: { left: `inset(0 0 0 ${r}%)`, right: `inset(0 ${r}% 0 0)`, up: `inset(${r}% 0 0 0)`, down: `inset(0 0 ${r}% 0)` }[dir] });
    } else if (kind === "zoom") {
      set(a, { opacity: 1 - p, transform: `scale(${1 + 0.15 * p})` }); set(b, { opacity: p, transform: `scale(${0.85 + 0.15 * p})` });
    } else if (kind === "blur") {
      set(a, { opacity: 1 - p, filter: `blur(${(p * short * 0.02).toFixed(1)}px)` }); set(b, { opacity: p, filter: `blur(${((1 - p) * short * 0.02).toFixed(1)}px)` });
    } else if (kind === "flip") {
      set(a, { transform: `perspective(${short * 2}px) rotateY(${p * 180}deg)`, visibility: p < 0.5 ? "visible" : "hidden" });
      set(b, { transform: `perspective(${short * 2}px) rotateY(${(p - 1) * 180}deg)`, visibility: p >= 0.5 ? "visible" : "hidden" });
    }
    return p;
  };

  /** 缓动按名字取：通用的 Penner 叫法 inQuad、outCubic、inOutSine、outBack(1.7)、outElastic(1, 0.3)、outBounce、steps(5)，
   *  也认 SLATE.ease 里的 linear、in、out、inOut、back、elastic；传函数就原样用 */
  const powE = n => ({ in: p => Math.pow(p, n), out: p => 1 - Math.pow(1 - p, n), inOut: p => (p < 0.5 ? Math.pow(2 * p, n) / 2 : 1 - Math.pow(2 - 2 * p, n) / 2) });
  const bounceOut = p => {
    const n = 7.5625, d = 2.75;
    if (p < 1 / d) return n * p * p;
    if (p < 2 / d) return n * (p -= 1.5 / d) * p + 0.75;
    if (p < 2.5 / d) return n * (p -= 2.25 / d) * p + 0.9375;
    return n * (p -= 2.625 / d) * p + 0.984375;
  };
  const familyOf = (name, args) => {
    if (name === "Back") {
      const c1 = args[0] ?? 1.70158, c2 = c1 * 1.525, c3 = c1 + 1;
      return { in: p => c3 * p * p * p - c1 * p * p, out: p => 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2),
               inOut: p => (p < 0.5 ? (Math.pow(2 * p, 2) * ((c2 + 1) * 2 * p - c2)) / 2 : (Math.pow(2 * p - 2, 2) * ((c2 + 1) * (p * 2 - 2) + c2) + 2) / 2) };
    }
    if (name === "Elastic") {
      const a = Math.max(1, args[0] ?? 1), per = args[1] ?? 0.3, s = per / (2 * Math.PI) * Math.asin(1 / a);
      const out = p => (p === 0 || p === 1 ? p : a * Math.pow(2, -10 * p) * Math.sin((p - s) * (2 * Math.PI) / per) + 1);
      return { out, in: p => 1 - out(1 - p), inOut: p => (p < 0.5 ? (1 - out(1 - 2 * p)) / 2 : (1 + out(2 * p - 1)) / 2) };
    }
    if (name === "Bounce") return { out: bounceOut, in: p => 1 - bounceOut(1 - p), inOut: p => (p < 0.5 ? (1 - bounceOut(1 - 2 * p)) / 2 : (1 + bounceOut(2 * p - 1)) / 2) };
    return {
      Quad: powE(2), Cubic: powE(3), Quart: powE(4), Quint: powE(5),
      Sine: { in: p => 1 - Math.cos(p * Math.PI / 2), out: p => Math.sin(p * Math.PI / 2), inOut: p => -(Math.cos(Math.PI * p) - 1) / 2 },
      Expo: { in: p => (p === 0 ? 0 : Math.pow(2, 10 * p - 10)), out: p => (p === 1 ? 1 : 1 - Math.pow(2, -10 * p)),
              inOut: p => (p === 0 || p === 1 ? p : p < 0.5 ? Math.pow(2, 20 * p - 10) / 2 : (2 - Math.pow(2, -20 * p + 10)) / 2) },
      Circ: { in: p => 1 - Math.sqrt(1 - p * p), out: p => Math.sqrt(1 - Math.pow(p - 1, 2)),
              inOut: p => (p < 0.5 ? (1 - Math.sqrt(1 - 4 * p * p)) / 2 : (Math.sqrt(1 - Math.pow(-2 * p + 2, 2)) + 1) / 2) },
    }[name];
  };
  const easeCache = {};
  const easing = e => {
    if (typeof e === "function") return e;
    if (e == null) return ease.out;
    const key = String(e).replace(/\s/g, "");
    if (easeCache[key]) return easeCache[key];
    let fn = ease[key];
    const st = /^steps\((\d+)\)$/.exec(key);
    if (st) { const n = Math.max(1, +st[1]); fn = p => (p >= 1 ? 1 : Math.floor(p * n) / n); }
    const m = /^(inOut|in|out)(Quad|Cubic|Quart|Quint|Sine|Expo|Circ|Back|Elastic|Bounce)(?:\(([^)]*)\))?$/.exec(key);
    if (m) fn = familyOf(m[2], (m[3] || "").split(",").filter(Boolean).map(Number))[m[1]];
    if (!fn) throw new Error(`不认识的缓动：${e}`);
    return (easeCache[key] = fn);
  };

  // ---- 时间线 ----
  const TRANSFORM = ["x", "y", "z", "xPercent", "yPercent", "rotate", "rotateX", "rotateY", "skewX", "skewY", "scale", "scaleX", "scaleY"];
  const UNITLESS = new Set(["opacity", "zIndex", "fontWeight", "lineHeight", "flexGrow", "flexShrink", "order", "scale", "scaleX", "scaleY"]);
  const parseColor = v => {
    if (typeof v !== "string") return null;
    const s = v.trim();
    let m = /^#([0-9a-f]{3,8})$/i.exec(s);
    if (m) {
      let h = m[1];
      if (h.length <= 4) h = h.split("").map(c => c + c).join("");
      return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)).concat(h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1);
    }
    m = /^rgba?\(([^)]+)\)$/i.exec(s);
    if (m) { const p = m[1].split(/[\s,/]+/).filter(Boolean).map(parseFloat); return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1]; }
    return null;
  };
  const parseNum = v => {
    if (typeof v === "number") return { n: v, u: "" };
    const m = /^(-?\d*\.?\d+(?:e-?\d+)?)([a-z%]*)$/i.exec(String(v).trim());
    return m ? { n: +m[1], u: m[2] } : null;
  };
  const NUM_RE = /(-?\d*\.?\d+(?:e-?\d+)?)/;
  /** 两个值之间取 p 处：数字、带单位的数字、颜色可以补间；别的（比如 display）在补间开始后直接切到终值 */
  const mix = (a, b, p) => {
    if (typeof a === "number" && typeof b === "number") return a + (b - a) * p;
    const ca = parseColor(a), cb = parseColor(b);
    if (ca && cb) { const c = ca.map((x, i) => x + (cb[i] - x) * p); return `rgba(${Math.round(c[0])}, ${Math.round(c[1])}, ${Math.round(c[2])}, ${+c[3].toFixed(3)})`; }
    const na = parseNum(a), nb = parseNum(b);
    if (na && nb) return `${+(na.n + (nb.n - na.n) * p).toFixed(4)}${nb.u || na.u}`;
    // 含多个数字的字符串（inset(0 100% 0 0)、blur(8px)、阴影）：其余部分一样时，逐个数字补间
    if (typeof a === "string" && typeof b === "string") {
      const ra = a.split(NUM_RE), rb = b.split(NUM_RE);
      if (ra.length === rb.length && ra.length > 1 && ra.every((x, i) => i % 2 === 1 || x === rb[i]))
        return ra.map((x, i) => (i % 2 ? String(+(+x + (+rb[i] - +x) * p).toFixed(4)) : x)).join("");
    }
    return p > 0 ? b : a;
  };
  const targetsOf = target => {
    if (typeof target === "string") return Array.from(document.querySelectorAll(target));
    if (target == null) return [];
    if (target.nodeType || !(Symbol.iterator in Object(target))) return [target];
    return Array.from(target);
  };
  /** 错开：第 i 个目标（共 n 个）相对第一个晚多少秒 */
  const offsetOf = (i, n, o) => {
    const from = o.from ?? "start";
    const pos = from === "start" ? 0 : from === "end" ? n - 1 : from === "center" || from === "edges" ? (n - 1) / 2 : +from;
    let d = Math.abs(i - pos);
    const maxD = Math.max(...Array.from({ length: n }, (_, k) => Math.abs(k - pos))) || 1;
    if (from === "edges") d = maxD - d;
    if (from === "random") { const r = rng(o.seed || 7); const order = Array.from({ length: n }, (_, k) => [r(), k]).sort((x, y) => x[0] - y[0]).map(x => x[1]); d = order.indexOf(i); }
    const each = o.amount != null ? o.amount / (from === "random" ? Math.max(1, n - 1) : maxD) : (o.each || 0);
    return d * each;
  };
  /** 一段补间在 t 时刻的进度（0～1，含重复和往返）；end 是结束时刻，无限重复时为 Infinity */
  const progressOf = (s, t) => {
    const u = t - s.start;
    if (u < 0) return 0;
    if (s.dur <= 0) return 1;
    if (t >= s.end) return s.yoyo && s.repeat % 2 === 1 ? 0 : 1;  // 结束后直接给终点，避免 0.94 - 0.44 这类浮点误差停在 0.9999
    const cycle = s.dur + s.repeatDelay;
    let k = Math.floor(u / cycle), w;
    if (s.repeat >= 0 && k > s.repeat) { k = s.repeat; w = s.dur; } else w = Math.min(u - k * cycle, s.dur);
    const p = w / s.dur;
    return s.yoyo && k % 2 === 1 ? 1 - p : p;
  };

  /** 时间线：按时间点编排补间。在初始化时把动作都排好，render(t) 里调用一次 tl.at(t)，所有元素就设到 t 时刻的状态。
   *  tl.tween(目标, 属性, {at, dur, ease, each, from, amount, repeat, yoyo, repeatDelay})
   *    目标：元素、元素数组或选择器字符串；多个目标时用 each（相邻间隔秒数）或 amount（总跨度）依次错开，
   *          from 指定从哪头开始：start | end | center | edges | random | 序号
   *    属性：x、y、z（px）、xPercent、yPercent（%）、rotate、rotateX、rotateY、skewX、skewY（度）、scale、scaleX、scaleY 组合成 transform；
   *          opacity、颜色、宽高等 CSS 属性（驼峰写法，数字默认 px）；"--变量"；attr: {SVG 或 HTML 属性}；text: 逐字打出的文字。
   *          值写 终值、[起值, 终值] 或 {from: 起值}（从起值回到原状态）；也可以是函数 (i, el, n) => 值，给每个目标不同的值
   *  tl.set(目标, 属性, at)：在 at 秒直接设成某状态
   *  tl.call(fn, {at, dur, ease})：每帧调用 fn(进度, t)，进度在 at 之前是 0、at+dur 之后是 1，适合数字滚动、画布重绘
   *  tl.add(子时间线, at)：把另一条时间线放到 at 秒处
   *  一个属性的起值：写了就用写的；没写就接着这个元素上一段补间的终值；再没有就用原状态
   *  （transform 各项的原状态是 0 和缩放 1，不读 CSS 里的 transform；其他属性读第一次 at() 之前的计算样式） */
  const timeline = () => {
    const tracks = new Map();  // 元素 → Map(属性 → [补间段])
    const calls = [], children = [];
    let seq = 0, bases = null, end = 0;
    const segment = (el, key, val, o, start, i, n) => {
      if (typeof val === "function") val = val(i, el, n);
      let from, to, mode = "to";
      if (Array.isArray(val)) { [from, to] = val; mode = "fromTo"; }
      else if (val && typeof val === "object" && "from" in val) { from = val.from; mode = "from"; }
      else to = val;
      const s = { start, dur: Math.max(0, o.dur ?? 0.5), ease: easing(o.ease), from, to, mode, seq: seq++,
                  repeat: o.repeat ?? 0, yoyo: !!o.yoyo, repeatDelay: o.repeatDelay || 0 };
      s.end = s.repeat < 0 ? Infinity : s.start + (s.repeat + 1) * s.dur + s.repeat * s.repeatDelay;
      if (Number.isFinite(s.end)) end = Math.max(end, s.end);
      if (!tracks.has(el)) tracks.set(el, new Map());
      const m = tracks.get(el);
      if (!m.has(key)) m.set(key, []);
      m.get(key).push(s);
      m.get(key).sort((a, b) => a.start - b.start || a.seq - b.seq);
      if (bases) bases.get(el)?.has(key) || captureBase(el, key);
    };
    const baseOf = (el, key) => {
      if (TRANSFORM.includes(key)) return key.startsWith("scale") ? 1 : 0;
      if (key === "text") return el.textContent;
      if (key.startsWith("attr:")) return el.getAttribute(key.slice(5));
      if (key.startsWith("--")) return getComputedStyle(el).getPropertyValue(key).trim();
      const v = getComputedStyle(el)[key];
      const n = parseNum(v);
      return n && (n.u === "" || n.u === "px") ? n.n : v;
    };
    const captureBase = (el, key) => {
      if (!bases.has(el)) bases.set(el, new Map());
      bases.get(el).set(key, baseOf(el, key));
    };
    const valueAt = (el, key, segs, t) => {
      let cur = bases.get(el).get(key);
      for (let i = 0; i < segs.length; i++) {
        const s = segs[i];
        const from = s.from !== undefined ? s.from : cur;
        const to = s.mode === "from" ? cur : s.to;
        if (t < s.start) return i === 0 && s.mode !== "to" ? from : cur;
        if (t < s.end) return mix(from, to, s.ease(progressOf(s, t)));
        cur = progressOf(s, s.end) >= 1 ? to : from;
      }
      return cur;
    };
    const apply = (el, values) => {
      let tf = null;
      for (const [key, v] of values) {
        if (TRANSFORM.includes(key)) { (tf = tf || {})[key] = v; continue; }
        if (v == null) {  // 原状态里没有这个值（比如原来没有这个属性）：恢复成没有
          if (key.startsWith("attr:")) el.removeAttribute(key.slice(5));
          else if (key.startsWith("--")) el.style.removeProperty(key);
          else if (key !== "text") el.style[key] = "";
          continue;
        }
        if (key === "text") { el.textContent = typeof v === "number" ? String(v) : v; continue; }
        if (key.startsWith("attr:")) { el.setAttribute(key.slice(5), v); continue; }
        if (key.startsWith("--")) { el.style.setProperty(key, String(v)); continue; }
        el.style[key] = typeof v === "number" && !UNITLESS.has(key) ? `${v}px` : String(v);
      }
      if (tf) {
        const g = k => (tf[k] !== undefined ? +tf[k] : k.startsWith("scale") ? 1 : 0);
        const parts = [];
        if (g("xPercent") || g("yPercent")) parts.push(`translate(${g("xPercent")}%, ${g("yPercent")}%)`);
        if (g("x") || g("y") || g("z")) parts.push(`translate3d(${g("x")}px, ${g("y")}px, ${g("z")}px)`);
        if (g("rotate")) parts.push(`rotate(${g("rotate")}deg)`);
        if (g("rotateX")) parts.push(`rotateX(${g("rotateX")}deg)`);
        if (g("rotateY")) parts.push(`rotateY(${g("rotateY")}deg)`);
        if (g("skewX") || g("skewY")) parts.push(`skew(${g("skewX")}deg, ${g("skewY")}deg)`);
        const sx = g("scale") * g("scaleX"), sy = g("scale") * g("scaleY");
        if (sx !== 1 || sy !== 1) parts.push(`scale(${sx}, ${sy})`);
        el.style.transform = parts.join(" ");
      }
    };
    const typed = (from, to, p) => { const a = Array.from(String(to)); return a.slice(0, Math.round(clamp(p) * a.length)).join(""); };
    const tl = {
      tween(target, props, o = {}) {
        const els = targetsOf(target), n = els.length, at = o.at ?? 0;
        els.forEach((el, i) => {
          const start = at + (n > 1 ? offsetOf(i, n, o) : 0);
          for (const [k, v] of Object.entries(props)) {
            if (k === "attr") for (const [ak, av] of Object.entries(v)) segment(el, "attr:" + ak, av, o, start, i, n);
            else segment(el, k, v, o, start, i, n);
          }
        });
        return tl;
      },
      set(target, props, at = 0) { return tl.tween(target, props, { at, dur: 0 }); },
      call(fn, o = {}) {
        const s = { fn, start: o.at ?? 0, dur: Math.max(0, o.dur ?? 0), ease: easing(o.ease ?? "linear"), repeat: o.repeat ?? 0, yoyo: !!o.yoyo, repeatDelay: o.repeatDelay || 0 };
        s.end = s.repeat < 0 ? Infinity : s.start + (s.repeat + 1) * s.dur + s.repeat * s.repeatDelay;
        if (Number.isFinite(s.end)) end = Math.max(end, s.end);
        calls.push(s);
        return tl;
      },
      add(child, at = 0) { children.push({ child, at }); end = Math.max(end, at + (child.duration || 0)); return tl; },
      get duration() { return end; },
      at(t) {
        if (!bases) {  // 第一次调用：先记下所有元素的原状态，再开始改
          bases = new Map();
          for (const [el, m] of tracks) for (const key of m.keys()) captureBase(el, key);
        }
        for (const [el, m] of tracks) {
          const values = [];
          for (const [key, segs] of m) {
            if (key === "text") {
              const s = segs.filter(x => x.start <= t).pop();
              values.push([key, s ? (s.dur > 0 ? typed(s.from, s.to, s.ease(progressOf(s, t))) : s.to) : bases.get(el).get(key)]);
            } else values.push([key, valueAt(el, key, segs, t)]);
          }
          apply(el, values);
        }
        for (const { child, at } of children) child.at(t - at);
        for (const s of calls) s.fn(s.ease(progressOf(s, t)), t);
        return tl;
      },
    };
    return tl;
  };

  const SLATE = {
    width: W, height: H, short, u: short / 100, fps: cfg.fps || 30, duration: cfg.duration || 5, scene: cfg.scene || "00",
    ratio: cfg.ratio || "16:9", safe, captionZone, captionsOn, captions: cfg.captions || [],
    clamp, lerp, ease, seg, stagger, typewriter, countUp, draw, svg, rng,
    interpolate, spring, noise, sequence, local, transition, easing, timeline,
    /** 场景可以把需要等待的 Promise 放进来（比如自己加载的图片），渲染前会全部等完 */
    waits: [],
  };
  window.SLATE = SLATE;
  // three.js 等库创建对象时会用 Math.random 生成内部 id：换成固定种子的伪随机，每次加载结果都一样。
  // render(t) 里调用它，各分片拿到的随机数就对不上；运行时会记下次数，slate-qa 会报出来
  const seeded = rng(20261013);
  let inRender = false;
  SLATE.randomInRender = 0;
  Math.random = () => { if (inRender) SLATE.randomInRender++; return seeded(); };

  const style = document.createElement("style");
  style.textContent = `
    html, body { margin: 0; padding: 0; width: ${W}px; height: ${H}px; overflow: hidden; }
    *, *::before, *::after { animation: none !important; transition: none !important; }
    .slate-caption-layer { position: fixed; left: ${captionZone.x}px; top: ${captionZone.y}px; width: ${captionZone.w}px;
      height: ${captionZone.h}px; display: flex; align-items: center; justify-content: center; pointer-events: none; z-index: 2147483000; }
    .slate-caption { max-width: 92%; padding: ${Math.round(short * 0.012)}px ${Math.round(short * 0.028)}px; border-radius: ${Math.round(short * 0.01)}px;
      background: var(--slate-caption-bg, rgba(22, 33, 62, .86)); color: var(--slate-caption-color, #fff);
      font: var(--slate-caption-weight, 500) ${Math.round(short * 0.04)}px/1.35 var(--slate-caption-font, "Noto Sans CJK SC", "Noto Sans SC", "PingFang SC", sans-serif);
      text-align: center; letter-spacing: .02em; }
    .slate-caption:empty { display: none; }`;
  // 注入时文档可能还没有根节点：等它出现再插入样式
  const addStyle = () => { const root = document.head || document.documentElement; if (!root) return false; root.appendChild(style); return true; };
  if (!addStyle()) { const mo = new MutationObserver(() => { if (addStyle()) mo.disconnect(); }); mo.observe(document, { childList: true, subtree: true }); }

  /** 全片统一的字幕样式：场景加载完以后再插入，带 !important，盖过场景和风格自己设置的字幕样式 */
  const applyCaptionStyle = () => {
    const cs = cfg.captionStyle;
    if (!cs || document.getElementById("slate-caption-style")) return;
    const rule = [cs.bg && `background: ${cs.bg} !important;`, cs.color && `color: ${cs.color} !important;`,
                  cs.font && `font-family: ${cs.font} !important;`, cs.weight && `font-weight: ${cs.weight} !important;`].filter(Boolean).join(" ");
    const el = document.createElement("style");
    el.id = "slate-caption-style";
    el.textContent = `.slate-caption { ${rule} }`;
    (document.head || document.documentElement).appendChild(el);
  };

  let capEl = null;
  const ensureCaption = () => {
    if (!captionsOn || capEl) return;
    const layer = document.createElement("div");
    layer.className = "slate-caption-layer";
    layer.setAttribute("data-slate", "caption");
    capEl = document.createElement("div");
    capEl.className = "slate-caption";
    layer.appendChild(capEl);
    document.body.appendChild(layer);
  };
  const captionAt = t => {
    for (const c of SLATE.captions) if (t >= c.start && t < c.end) return c.text;
    return "";
  };

  /** 渲染第 t 秒：先调场景的 render(t)，再更新字幕 */
  window.__slateFrame = t => {
    if (typeof window.render !== "function") throw new Error("场景没有定义全局函数 render(t)");
    inRender = true;
    try { window.render(t); } finally { inRender = false; }
    if (captionsOn) { ensureCaption(); const s = captionAt(t); if (capEl.textContent !== s) capEl.textContent = s; }
  };

  // 初始化阶段的错误：模块加载失败、顶层 await 抛错。等 READY 时一旦出现就立刻报出来，不用干等 90 秒
  const loadErrors = [];
  window.addEventListener("error", e => {
    const el = e.target;
    if (el && el !== window && (el.src || el.href)) loadErrors.push(`加载失败：${el.src || el.href}`);
    else if (e.message) loadErrors.push(e.message);
  }, true);
  window.addEventListener("unhandledrejection", e => loadErrors.push(String((e.reason && e.reason.message) || e.reason)));

  /** 等页面、字体、图片和 SLATE.waits 都就绪 */
  window.__slateReady = async () => {
    if (document.readyState === "loading") await new Promise(r => document.addEventListener("DOMContentLoaded", r, { once: true }));
    // 模块脚本（type="module"）在 DOMContentLoaded 之后可能还在 await 加载资源：等页面自己设 window.READY = true
    const modulePage = window.READY === false || !!document.querySelector('script[type="module"]');
    if (modulePage) {
      const t0 = performance.now();
      while (window.READY !== true) {
        if (loadErrors.length) throw new Error("页面初始化出错：" + loadErrors[0]);
        if (performance.now() - t0 > 90000) throw new Error("页面 90 秒内没有设置 window.READY = true");
        await new Promise(r => setTimeout(r, 50));
      }
    }
    ensureCaption();
    // 先在几个时间点各画一次：后面才出现的文字也会触发字体加载，从中间开始渲染的分片第一帧就能用对字体。
    // 模块页面（影片风格）自己用 document.fonts.load 加载字体，而且 3D 画一帧可能要十几秒，不做这一步
    if (!modulePage && typeof window.render === "function")
      for (const k of [0, 0.25, 0.5, 0.75, 0.999]) { try { window.render(SLATE.duration * k); void document.body.offsetHeight; } catch (e) { /* 正式渲染时会再报 */ } }
    const imgs = Array.from(document.images).map(img => (img.complete ? null : img.decode().catch(() => null)));
    // 没切片的字体整个先加载（画布里的字不会自动触发加载）；按字符范围切片的字体只加载用到的那几片
    const whole = f => /^U\+0+-10FFFF$/i.test(String(f.unicodeRange || "U+0-10FFFF").replace(/\s/g, ""));
    const faces = document.fonts ? Array.from(document.fonts).filter(whole).map(f => f.load().catch(() => null)) : [];
    await Promise.all([document.fonts ? document.fonts.ready : null, ...faces, ...imgs, ...SLATE.waits]);
    SLATE.randomInRender = 0;
    applyCaptionStyle();
    window.__slateFrame(0);
    return { width: W, height: H, hasRender: typeof window.render === "function" };
  };

  const opacityOf = el => {
    let o = 1;
    for (let e = el; e && e.nodeType === 1; e = e.parentElement || e.parentNode) {
      const cs = getComputedStyle(e);
      if (cs.display === "none" || cs.visibility === "hidden") return 0;
      o *= parseFloat(cs.opacity || "1");
    }
    return o;
  };
  const textOf = el => {
    if (el instanceof SVGTextElement) return el.textContent.trim();
    let s = "";
    for (const n of el.childNodes) if (n.nodeType === 3) s += n.textContent;
    return s.trim();
  };

  /** 自检：返回当前帧里可见文字的位置，以及越出安全框、压到字幕区、互相重叠、被截断的问题 */
  window.__slateQA = () => {
    const items = [];
    for (const el of document.querySelectorAll("body *")) {
      if (el.closest("[data-slate=caption]") || el.closest("[data-qa=ignore]")) continue;  // 字幕层和装饰副本（光晕、色差）不参与自检
      const text = textOf(el);
      if (!text) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      const op = opacityOf(el);
      if (op < 0.2) continue;
      // 中文字体的排版框比字形高很多：重叠判断只用中间 75% 的高度，避免大字旁的标签被误报
      items.push({ el, text: text.slice(0, 40), x: r.left, y: r.top, w: r.width, h: r.height, op, cy: r.top + r.height * 0.125, ch: r.height * 0.75 });
    }
    const issues = [];
    const tol = 2;
    for (const it of items) {
      if (it.x < safe.x - tol || it.y < safe.y - tol || it.x + it.w > safe.x + safe.w + tol || it.y + it.h > safe.y + safe.h + tol)
        issues.push({ kind: "outside_safe", text: it.text, box: [it.x, it.y, it.w, it.h].map(Math.round) });
      if (captionsOn) {
        const z = captionZone;
        const ix = Math.max(0, Math.min(it.x + it.w, z.x + z.w) - Math.max(it.x, z.x));
        const iy = Math.max(0, Math.min(it.y + it.h, z.y + z.h) - Math.max(it.y, z.y));
        if (ix * iy > 0.15 * it.w * it.h) issues.push({ kind: "under_caption", text: it.text, box: [it.x, it.y, it.w, it.h].map(Math.round) });
      }
      const el = it.el;
      if (!(el instanceof SVGElement)) {
        const cs = getComputedStyle(el);
        if ((cs.overflow !== "visible" || cs.textOverflow === "ellipsis") && (el.scrollWidth > el.clientWidth + 2 || el.scrollHeight > el.clientHeight + 2))
          issues.push({ kind: "clipped", text: it.text });
      }
    }
    for (let i = 0; i < items.length; i++)
      for (let j = i + 1; j < items.length; j++) {
        const a = items[i], b = items[j];
        if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
        const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
        const iy = Math.max(0, Math.min(a.cy + a.ch, b.cy + b.ch) - Math.max(a.cy, b.cy));
        if (ix * iy > 0.2 * Math.min(a.w * a.ch, b.w * b.ch)) issues.push({ kind: "overlap", text: `${a.text} / ${b.text}` });
      }
    if (SLATE.randomInRender > 0)
      issues.push({ kind: "random_in_render", text: `render(t) 里调用了 Math.random，分片渲染时画面会对不上。请改用 SLATE.rng(种子) 或 /core/lib.js 的 mulberry；如果是 three.js 在 render 里新建对象，把对象移到初始化时创建` });
    return { texts: items.map(({ el, cy, ch, ...rest }) => ({ ...rest, x: Math.round(rest.x), y: Math.round(rest.y), w: Math.round(rest.w), h: Math.round(rest.h) })), issues };
  };
})();
