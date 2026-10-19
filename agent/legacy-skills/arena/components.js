/* 霓虹擂台组件（依赖 SLATE 运行时）：科技测评、产品对比、排行榜类片子
 *
 * 约定：所有组件在创建时一次性生成元素；render(t) 里只根据 t 设置状态。
 *   draw(p)：p 为 0～1 的入场进度；set(t, ...)：需要绝对时间的组件（闪烁、粒子、排名赛）。
 * 坐标单位是画布像素，尺寸都写成 SLATE.u（短边的 1%）的倍数。
 * 颜色：选手（系列）颜色按 NA.C.series 的固定顺序分配，整片同一个选手始终同一个颜色；
 *       数值、标签一律用文字色（ink/ink2/muted），颜色只放在标记（条、点、边框）上。
 *
 *   const st = NA.stage({ floor: true, zoom: [1, 1.04] });        // 舞台：背景（渐变、极光、透视网格、粒子）+ 镜头 + 转场
 *   const W = st.world;                                            // 内容都放进 st.world（跟随镜头）
 *   const t1 = NA.title(W, { x, y, text: '大模型擂台', size: 11 * SLATE.u, anchor: 'middle' });
 *   const race = NA.barRace(W, { x, y, w, h, items, frames, unit: '分' });
 *   function render(t) { st.set(t); t1.draw(SLATE.seg(t, 0.2, 1.2)); race.set(t, [[0.8, 0], [4, 1]]); }
 *
 * 组件一览（参数见各函数注释）：stage、heading（页面标题）、title、label、chip、panel、legend、player、versus、
 *   barRace、radar、heatmap、counter、podium、source、watermark。
 */
(() => {
  const S = window.SLATE;
  const U = S.u, W = S.width, H = S.height;
  const C = {
    bg0: '#05070f', bg1: '#0b1020', bg2: '#101733',
    ink: '#f4f7ff', ink2: '#b8c2e0', muted: '#7d88a8', dark: '#06121c',
    line: 'rgba(150, 170, 230, 0.16)', panel: 'rgba(14, 20, 44, 0.72)', panelLine: 'rgba(120, 150, 230, 0.32)',
    accent: '#3fe0ff', accent2: '#ff4fd8',
    // 选手配色：在 #0b1020 上校验过（亮度带、色度、色觉障碍区分 ΔE≥8、正常视觉 ΔE≥15、对比度≥3:1），按顺序使用
    series: ['#06a3c4', '#e2457f', '#c38500', '#8670ee', '#1fa35a', '#ef5b2b'],
    // 同色系的亮色，只用于发光光晕，不承担区分作用
    halo: ['#5fe1ff', '#ff86b4', '#ffcf55', '#b9abff', '#63e6a0', '#ff9a6e'],
    gold: '#ffcf5a', silver: '#d7def0', bronze: '#e0a274',
    font: '"Noto Sans CJK SC", "Noto Sans SC", "PingFang SC", sans-serif',
  };
  const NS = 'http://www.w3.org/2000/svg';
  let uid = 0;
  const id = p => `na${p}${++uid}`;
  const el = (tag, attrs, parent) => S.svg(tag, attrs, parent);
  const clamp = S.clamp, lerp = S.lerp, ease = S.ease;
  const hex = c => [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16));
  const mix = (c1, c2, p) => { const a = hex(c1), b = hex(c2), q = clamp(p); return '#' + a.map((v, i) => Math.round(v + (b[i] - v) * q).toString(16).padStart(2, '0')).join(''); };
  const rgba = (c, a) => { const [r, g, b] = hex(c); return `rgba(${r}, ${g}, ${b}, ${a})`; };
  const fmt = (v, d = 0) => Number(v).toFixed(d);
  /** 平滑的确定性噪声：同样的 (seed, x) 永远得到同样的值，范围 -1～1 */
  const hash = n => { let s = (n * 374761393 + 668265263) >>> 0; s = (s ^ (s >>> 13)) * 1274126177 >>> 0; return ((s ^ (s >>> 16)) >>> 0) / 4294967296 * 2 - 1; };
  const noise = (seed, x) => { const i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f); return lerp(hash(seed * 1013 + i), hash(seed * 1013 + i + 1), u); };
  const seriesColor = i => C.series[i % C.series.length];
  /** 皇冠图标：以 (x, y) 为左下角、宽 s；返回 g（用 opacity/transform 控制） */
  const crownIcon = (parent, s, color) => {
    const g = el('g', {}, parent);
    el('path', { d: `M 0 0 L ${s * 0.08} ${-s * 0.62} L ${s * 0.32} ${-s * 0.3} L ${s * 0.5} ${-s * 0.72} L ${s * 0.68} ${-s * 0.3} L ${s * 0.92} ${-s * 0.62} L ${s} 0 Z`, fill: color }, g);
    el('rect', { x: 0, y: s * 0.06, width: s, height: s * 0.14, rx: s * 0.05, fill: color }, g);
    return g;
  };
  const haloColor = i => C.halo[i % C.halo.length];

  /** 每个 svg 根上放一次公用的滤镜和渐变 */
  function defsOf(svg) {
    if (svg.__naDefs) return svg.__naDefs;
    const d = el('defs', {}, svg);
    const blur = (name, sd) => { const f = el('filter', { id: name, x: '-50%', y: '-50%', width: '200%', height: '200%' }, d); el('feGaussianBlur', { stdDeviation: sd }, f); return `url(#${name})`; };
    const out = { d, blurS: blur(id('bs'), U * 0.35), blurM: blur(id('bm'), U * 0.9), blurL: blur(id('bl'), U * 2.2) };
    svg.__naDefs = out;
    return out;
  }
  const rootSvg = node => (node.ownerSVGElement || node);

  // ---------------------------------------------------------------------------------------------
  /** 舞台：铺满画面的背景 canvas + 内容 svg。
   *  opts: floor（透视网格地面，默认 true）、particles（粒子数，默认 70）、aurora（极光，默认 true）、
   *        zoom: [起, 止]（镜头推近，默认 [1, 1.035]）、pan: [dx, dy]（镜头平移，单位像素）、
   *        enter: 'glitch' | 'flash' | 'none'（开场转场，默认 glitch）、exit: 'flash' | 'none'（默认 none）、
   *        tint: 主光色（默认 accent 青色）
   *  返回 { svg, world, hud, fx, set(t) }：内容放 world（跟随镜头推拉），出处、角标放 hud（固定在屏幕上）。
   *  render(t) 里第一行调用 st.set(t)。注意镜头会推近约 3.5%，world 里的内容要离安全区边缘留一点余量。 */
  function stage(opts = {}) {
    const o = { floor: true, particles: 70, aurora: true, zoom: [1, 1.035], pan: [0, -U * 0.6], enter: 'glitch', exit: 'none', tint: C.accent, ...opts };
    document.documentElement.style.background = C.bg0;
    document.body.style.background = C.bg0;
    const root = document.createElement('div');
    root.className = 'na-root';
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H; cv.className = 'na-bg';
    root.appendChild(cv);
    const svg = el('svg', { class: 'na-svg', width: W, height: H, viewBox: `0 0 ${W} ${H}` });
    root.appendChild(svg);
    document.body.insertBefore(root, document.body.firstChild);
    defsOf(svg);
    const world = el('g', {}, svg);          // 跟随镜头的内容
    const hud = el('g', {}, svg);            // 不跟镜头动：角标、出处、图例等贴屏信息
    const fx = el('g', { 'pointer-events': 'none' }, svg);
    const ctx = cv.getContext('2d');
    const rnd = S.rng(4242);
    const parts = Array.from({ length: o.particles }, () => ({ x: rnd(), y: rnd(), r: 0.08 + rnd() * 0.22, v: 0.004 + rnd() * 0.012, f: 0.6 + rnd() * 2.4, ph: rnd() * 6.28, c: rnd() < 0.7 ? o.tint : C.accent2 }));
    const blobs = [[0.18, 0.22, 0.55, o.tint, 0.2], [0.82, 0.18, 0.5, C.accent2, 1.7], [0.55, 0.85, 0.6, '#3b5bff', 3.1]];
    // 转场用的切片
    const slices = Array.from({ length: 9 }, () => el('rect', { x: 0, width: W, height: 0, fill: o.tint, opacity: 0 }, fx));
    const flash = el('rect', { x: 0, y: 0, width: W, height: H, fill: '#ffffff', opacity: 0 }, fx);

    function background(t) {
      const g = ctx.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, C.bg0); g.addColorStop(0.55, C.bg1); g.addColorStop(1, C.bg0);
      ctx.globalAlpha = 1; ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
      if (o.aurora) {
        for (const [bx, by, br, bc, ph] of blobs) {
          const x = (bx + Math.sin(t * 0.25 + ph) * 0.05) * W, y = (by + Math.cos(t * 0.21 + ph) * 0.04) * H, r = br * Math.max(W, H);
          const rg = ctx.createRadialGradient(x, y, 0, x, y, r);
          rg.addColorStop(0, rgba(bc, 0.16)); rg.addColorStop(1, rgba(bc, 0));
          ctx.fillStyle = rg; ctx.fillRect(0, 0, W, H);
        }
      }
      if (o.floor) {
        const hz = H * 0.66, vx = W / 2;
        ctx.save();
        ctx.beginPath(); ctx.rect(0, hz, W, H - hz); ctx.clip();
        ctx.lineWidth = Math.max(1, U * 0.12);
        for (let i = -14; i <= 14; i++) {
          ctx.strokeStyle = rgba(o.tint, 0.22);
          ctx.beginPath(); ctx.moveTo(vx + i * W * 0.012, hz); ctx.lineTo(vx + i * W * 0.11, H); ctx.stroke();
        }
        const n = 12, speed = 0.35;
        for (let k = 0; k < n; k++) {
          const z = ((k + t * speed) % n) / n, y = hz + (H - hz) * Math.pow(z, 2.4);
          ctx.strokeStyle = rgba(o.tint, 0.05 + 0.28 * z);
          ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
        }
        const fade = ctx.createLinearGradient(0, hz, 0, hz + (H - hz) * 0.45);
        fade.addColorStop(0, rgba(C.bg1, 1)); fade.addColorStop(1, rgba(C.bg1, 0));
        ctx.fillStyle = fade; ctx.fillRect(0, hz, W, H - hz);
        ctx.restore();
        // 地平线的光
        const hl = ctx.createLinearGradient(0, 0, W, 0);
        hl.addColorStop(0, rgba(o.tint, 0)); hl.addColorStop(0.5, rgba(o.tint, 0.55)); hl.addColorStop(1, rgba(o.tint, 0));
        ctx.fillStyle = hl; ctx.fillRect(0, hz - U * 0.1, W, U * 0.2);
      }
      for (const p of parts) {
        const y = ((p.y - t * p.v) % 1 + 1) % 1, a = 0.25 + 0.55 * (0.5 + 0.5 * Math.sin(t * p.f + p.ph));
        ctx.globalAlpha = a; ctx.fillStyle = p.c;
        ctx.beginPath(); ctx.arc(p.x * W, y * H, p.r * U, 0, 6.2832); ctx.fill();
      }
      ctx.globalAlpha = 1;
      const vg = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.max(W, H) * 0.75);
      vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,0.55)');
      ctx.fillStyle = vg; ctx.fillRect(0, 0, W, H);
    }

    function transitions(t) {
      const D = S.duration;
      let glitch = 0, fl = 0;
      if (o.enter === 'glitch') { glitch = 1 - clamp(t / 0.45); fl = Math.max(0, 0.55 - t * 2.2); }
      if (o.enter === 'flash') fl = Math.max(0, 0.9 - t * 3);
      if (o.exit === 'flash' && t > D - 0.25) fl = Math.max(fl, (t - (D - 0.25)) / 0.25 * 0.9);
      flash.setAttribute('opacity', fl);
      const r = S.rng(1 + Math.floor(t * 30));
      slices.forEach((s, i) => {
        const on = glitch > 0 && r() < 0.8 * glitch;
        s.setAttribute('opacity', on ? 0.12 + 0.3 * glitch : 0);
        s.setAttribute('y', r() * H); s.setAttribute('height', (0.4 + r() * 3.2) * U);
        s.setAttribute('x', (r() - 0.5) * W * 0.2 * glitch);
        s.setAttribute('fill', i % 2 ? C.accent2 : o.tint);
      });
      const shake = glitch * U * 1.2;
      return [noise(7, t * 40) * shake, noise(9, t * 40) * shake * 0.3];
    }

    return {
      svg, world, hud, fx,
      set(t) {
        background(t);
        const [jx, jy] = transitions(t);
        const q = ease.inOut(clamp(t / Math.max(0.01, S.duration)));
        const z = lerp(o.zoom[0], o.zoom[1], q), px = o.pan[0] * q + jx, py = o.pan[1] * q + jy;
        world.setAttribute('transform', `translate(${W / 2 + px} ${H / 2 + py}) scale(${z}) translate(${-W / 2} ${-H / 2})`);
      },
    };
  }

  // ---------------------------------------------------------------------------------------------
  /** 动感标题：逐字升起 + 色差故障 + 扫光。
   *  opts: x, y（基线中心）, text, size（默认 9u）, weight（默认 900）, color（默认 ink）, anchor: start|middle|end,
   *        glow（光晕，默认 true）, accent（扫光和色差的颜色）
   *  draw(p) 入场；sweep(q) 在 q 从 0 到 1 时扫一道光；out(p) 退场（向上淡出）。 */
  function title(parent, o) {
    const size = o.size || U * 9, color = o.color || C.ink, accent = o.accent || C.accent, anchor = o.anchor || 'start';
    const g = el('g', {}, parent);
    const base = { 'font-size': size, 'font-weight': o.weight || 900, 'font-family': C.font, 'letter-spacing': (o.spacing ?? 0.02) * size };
    const meas = el('text', { ...base, x: 0, y: 0, opacity: 0 }, g);
    meas.textContent = o.text;
    const n = o.text.length;
    const total = meas.getComputedTextLength();
    const x0 = anchor === 'middle' ? o.x - total / 2 : anchor === 'end' ? o.x - total : o.x;
    const xs = Array.from({ length: n }, (_, i) => meas.getStartPositionOfChar(i).x);
    meas.remove();
    const glow = o.glow !== false ? el('g', { filter: defsOf(rootSvg(parent)).blurM, opacity: 0.55, 'data-qa': 'ignore' }, g) : null;
    const split = [el('g', { opacity: 0, 'data-qa': 'ignore' }, g), el('g', { opacity: 0, 'data-qa': 'ignore' }, g)];
    const main = el('g', {}, g);
    const mk = (layer, fill) => Array.from(o.text, (ch, i) => { const e = el('text', { ...base, x: x0 + xs[i], y: o.y, fill }, layer); e.textContent = ch; return e; });
    const chars = mk(main, color), glows = glow ? mk(glow, accent) : [], c1 = mk(split[0], accent), c2 = mk(split[1], C.accent2);
    // 扫光：用文字作裁剪，里面移动一条亮带
    const clip = el('clipPath', { id: id('tc') }, defsOf(rootSvg(parent)).d);
    mk(clip, '#fff');
    const band = el('rect', { x: x0 - size * 2, y: o.y - size * 1.1, width: size * 1.2, height: size * 1.5, fill: '#ffffff', opacity: 0, 'clip-path': `url(#${clip.id})` }, g);
    let lastP = 0;
    const api = {
      g, width: total, left: x0,
      draw(p) {
        lastP = p;
        chars.forEach((e, i) => {
          const q = clamp(p * (1 + n * 0.08) - i * 0.08), k = ease.out(q);
          const dy = (1 - k) * size * 0.45;
          [e, glows[i], c1[i], c2[i]].forEach(x => { if (x) { x.setAttribute('y', o.y + dy); x.setAttribute('opacity', q > 0 ? k : 0); } });
        });
        const gl = Math.max(0, 1 - p) * (p > 0 ? 1 : 0);
        const jx = noise(3, p * 30) * size * 0.08 * gl;
        split[0].setAttribute('opacity', gl * 0.85); split[0].setAttribute('transform', `translate(${jx - size * 0.03 * gl} 0)`);
        split[1].setAttribute('opacity', gl * 0.85); split[1].setAttribute('transform', `translate(${-jx + size * 0.03 * gl} 0)`);
        if (glow) glow.setAttribute('opacity', 0.55 * clamp(p));
      },
      sweep(q) {
        band.setAttribute('opacity', q > 0 && q < 1 ? 0.75 : 0);
        band.setAttribute('x', lerp(x0 - size * 1.5, x0 + total + size * 0.3, ease.inOut(clamp(q))));
      },
      out(p) {
        g.setAttribute('opacity', 1 - clamp(p));
        g.setAttribute('transform', `translate(0 ${-ease.in(clamp(p)) * size * 0.4})`);
      },
    };
    api.draw(0);
    return api;
  }

  /** 页面标题：自动放在安全区左上角（或居中），并给镜头推近留出余量。opts text, size（默认 6.5u）, sub（副标题）, align: 'left'|'center'
   *  返回 { title, sub, bottom（标题区下沿 y，下面的内容从这里往下排）, draw(p), sweep(q) } */
  function heading(parent, o) {
    const size = o.size || U * 6.5, center = o.align === 'center';
    // 中文字体的字框约为字号的 1.5 倍；再给镜头推近留一点余量
    const x = center ? W / 2 : S.safe.x + U * 4, y = S.safe.y + U * 2.5 + size * 1.45;
    const t = title(parent, { x, y, text: o.text, size, anchor: center ? 'middle' : 'start', accent: o.accent });
    const s = o.sub ? label(parent, { x, y: y + U * 4.6, text: o.sub, size: U * 2.6, anchor: center ? 'middle' : 'start', color: C.ink2, weight: 600 }) : null;
    return { title: t, sub: s, bottom: y + (s ? U * 7 : U * 2.5),
      draw(p) { t.draw(p); if (s) s.draw(clamp(p * 1.4 - 0.4)); }, sweep(q) { t.sweep(q); } };
  }

  /** 普通文字（数值、说明）：opts x, y, text, size, color, weight, anchor；draw(p) 淡入上浮，set(text) 改文字 */
  function label(parent, o) {
    const e = el('text', { x: o.x, y: o.y, 'font-size': o.size || U * 3, 'font-weight': o.weight || 500, fill: o.color || C.ink2,
      'font-family': C.font, 'text-anchor': o.anchor || 'start', 'dominant-baseline': o.baseline || 'alphabetic' }, parent);
    e.textContent = o.text;
    return {
      el: e,
      draw(p) { e.setAttribute('opacity', ease.out(clamp(p))); e.setAttribute('transform', `translate(0 ${(1 - ease.out(clamp(p))) * U * 1.2})`); },
      set(text) { if (e.textContent !== text) e.textContent = text; },
    };
  }

  /** 小标签：opts x, y（左上角）, text, color（边框色）, size；draw(p) */
  function chip(parent, o) {
    const size = o.size || U * 2.2, g = el('g', { opacity: 0 }, parent);
    const t = el('text', { x: o.x + size * 0.8, y: o.y + size * 1.15, 'font-size': size, 'font-weight': 700, fill: o.textColor || C.ink, 'font-family': C.font, 'letter-spacing': size * 0.08 }, g);
    t.textContent = o.text;
    const w = t.getComputedTextLength() + size * 1.6, h = size * 1.7;
    const r = el('rect', { x: o.x, y: o.y, width: w, height: h, rx: h / 2, fill: rgba(o.color || C.accent, 0.14), stroke: o.color || C.accent, 'stroke-width': U * 0.15 }, g);
    g.insertBefore(r, t);
    return { g, width: w, height: h, draw(p) { g.setAttribute('opacity', ease.out(clamp(p))); g.setAttribute('transform', `translate(${(1 - ease.out(clamp(p))) * -U * 2} 0)`); } };
  }

  /** HUD 面板：半透明玻璃底 + 四角括号 + 标题标签 + 扫描线。opts x, y, w, h, title, color；set(t, p) */
  function panel(parent, o) {
    const color = o.color || C.accent, g = el('g', { opacity: 0 }, parent), L = U * 2.4;
    const bg = el('rect', { x: o.x, y: o.y, width: o.w, height: o.h, rx: U * 0.8, fill: C.panel, stroke: C.panelLine, 'stroke-width': U * 0.1 }, g);
    const corners = [[o.x, o.y, 1, 1], [o.x + o.w, o.y, -1, 1], [o.x, o.y + o.h, 1, -1], [o.x + o.w, o.y + o.h, -1, -1]]
      .map(([x, y, sx, sy]) => el('path', { d: `M ${x} ${y + sy * L} L ${x} ${y} L ${x + sx * L} ${y}`, fill: 'none', stroke: color, 'stroke-width': U * 0.3, 'stroke-linecap': 'round' }, g));
    const clipId = id('pc');
    el('rect', { x: o.x, y: o.y, width: o.w, height: o.h, rx: U * 0.8 }, el('clipPath', { id: clipId }, defsOf(rootSvg(parent)).d));
    const scan = el('rect', { x: o.x, y: o.y, width: o.w, height: U * 6, fill: `url(#${scanGrad(rootSvg(parent), color)})`, 'clip-path': `url(#${clipId})`, opacity: 0.5 }, g);
    const head = o.title ? chip(g, { x: o.x + U * 1.6, y: o.y - U * 1.9, text: o.title, color }) : null;
    return {
      g,
      set(t, p) {
        const k = ease.out(clamp(p));
        g.setAttribute('opacity', k);
        bg.setAttribute('transform', `translate(0 ${(1 - k) * U * 2})`);
        corners.forEach(c => c.setAttribute('transform', `translate(0 ${(1 - k) * U * 2})`));
        scan.setAttribute('y', o.y + ((t * 0.35) % 1) * (o.h + U * 6) - U * 6);
        if (head) head.draw(clamp(p * 1.5 - 0.3));
      },
    };
  }
  function scanGrad(svg, color) {
    const k = `sg${color}`;
    svg.__naGrads = svg.__naGrads || {};
    if (svg.__naGrads[k]) return svg.__naGrads[k];
    const gid = id('sg');
    const lg = el('linearGradient', { id: gid, x1: 0, y1: 0, x2: 0, y2: 1 }, defsOf(svg).d);
    el('stop', { offset: 0, 'stop-color': color, 'stop-opacity': 0 }, lg);
    el('stop', { offset: 1, 'stop-color': color, 'stop-opacity': 0.22 }, lg);
    svg.__naGrads[k] = gid;
    return gid;
  }

  /** 图例：opts x, y, items:[{name, color}], size, gap, dir: 'row'|'column'；draw(p) 逐个出现。多个系列时必须有图例 */
  function legend(parent, o) {
    const size = o.size || U * 2.3, g = el('g', {}, parent);
    let x = o.x, y = o.y;
    const rows = o.items.map((it, i) => {
      const r = el('g', { opacity: 0 }, g);
      el('rect', { x, y: y - size * 0.75, width: size * 1.6, height: size * 0.55, rx: size * 0.27, fill: it.color || seriesColor(i) }, r);
      const t = el('text', { x: x + size * 2.1, y, 'font-size': size, 'font-weight': 600, fill: C.ink2, 'font-family': C.font }, r);
      t.textContent = it.name;
      if ((o.dir || 'row') === 'row') x += size * 2.1 + t.getComputedTextLength() + (o.gap || size * 1.6); else y += size * 1.7;
      return r;
    });
    return { g, draw(p) { rows.forEach((r, i) => r.setAttribute('opacity', ease.out(clamp(p * rows.length - i)))); } };
  }

  // ---------------------------------------------------------------------------------------------
  /** 选手卡：opts x, y, w, h, name, vendor, color, tag（一句话定位）, stats:[{k, v, p(0～1, 可选)}], mono（头像字，默认取 name 首字）
   *  draw(p) 翻转入场 + 描边；focus(p) 高亮（上浮、外发光）；dim(p) 压暗（让别的选手成为焦点） */
  function player(parent, o) {
    const color = o.color || seriesColor(o.index || 0), halo = o.halo || haloColor(o.index || 0);
    const g = el('g', {}, parent), inner = el('g', {}, g);
    const cx = o.x + o.w / 2, cy = o.y + o.h / 2, rx = U * 1.4;
    const glowR = el('rect', { x: o.x, y: o.y, width: o.w, height: o.h, rx, fill: 'none', stroke: halo, 'stroke-width': U * 1.2, opacity: 0, filter: defsOf(rootSvg(parent)).blurM }, inner);
    el('rect', { x: o.x, y: o.y, width: o.w, height: o.h, rx, fill: C.panel }, inner);
    const per = 2 * (o.w + o.h);
    const border = el('rect', { x: o.x, y: o.y, width: o.w, height: o.h, rx, fill: 'none', stroke: color, 'stroke-width': U * 0.3, 'stroke-dasharray': `${per} ${per}`, 'stroke-dashoffset': per }, inner);
    el('rect', { x: o.x, y: o.y, width: o.w, height: U * 0.8, rx: U * 0.4, fill: color }, inner);
    const mr = Math.min(o.w, o.h) * 0.13, my = o.y + o.h * 0.2;
    el('circle', { cx, cy: my, r: mr, fill: rgba(color, 0.18), stroke: color, 'stroke-width': U * 0.3 }, inner);
    const mono = el('text', { x: cx, y: my, 'font-size': mr * 1.05, 'font-weight': 900, fill: C.ink, 'text-anchor': 'middle', 'dominant-baseline': 'central', 'font-family': C.font }, inner);
    mono.textContent = o.mono || Array.from(o.name)[0];
    const nm = el('text', { x: cx, y: my + mr + U * 4.6, 'font-size': o.nameSize || U * 3.6, 'font-weight': 800, fill: C.ink, 'text-anchor': 'middle', 'font-family': C.font }, inner);
    nm.textContent = o.name;
    const vd = el('text', { x: cx, y: my + mr + U * 7.6, 'font-size': U * 2.1, 'font-weight': 500, fill: C.muted, 'text-anchor': 'middle', 'font-family': C.font }, inner);
    vd.textContent = o.vendor || '';
    let ty = my + mr + U * 11;
    if (o.tag) {
      const tg = el('text', { x: cx, y: ty, 'font-size': U * 2.2, 'font-weight': 600, fill: C.ink2, 'text-anchor': 'middle', 'font-family': C.font }, inner);
      tg.textContent = o.tag; ty += U * 3.6;
    }
    const stats = (o.stats || []).map((s, i) => {
      const y = ty + i * U * 4.2, pad = o.w * 0.12, bw = o.w - pad * 2;
      const k = el('text', { x: o.x + pad, y, 'font-size': U * 1.9, fill: C.muted, 'font-family': C.font }, inner); k.textContent = s.k;
      const v = el('text', { x: o.x + o.w - pad, y, 'font-size': U * 1.9, 'font-weight': 700, fill: C.ink, 'text-anchor': 'end', 'font-family': C.font }, inner); v.textContent = s.v;
      el('rect', { x: o.x + pad, y: y + U * 0.9, width: bw, height: U * 0.5, rx: U * 0.25, fill: C.line }, inner);
      const bar = el('rect', { x: o.x + pad, y: y + U * 0.9, width: 0, height: U * 0.5, rx: U * 0.25, fill: color }, inner);
      return { bar, w: bw * clamp(s.p ?? 0) };
    });
    let state = { p: 0, f: 0, d: 0 };
    const apply = () => {
      const { p, f, d } = state, k = ease.out(clamp(p * 1.4));
      const sx = Math.max(0.02, Math.abs(Math.cos((1 - k) * Math.PI / 2)));
      inner.setAttribute('transform', `translate(${cx} ${cy - f * U * 1.6}) scale(${sx * (1 + f * 0.03)} ${1 + f * 0.03}) translate(${-cx} ${-cy})`);
      g.setAttribute('opacity', (p > 0 ? clamp(p * 3) : 0) * (1 - d * 0.65));
      border.setAttribute('stroke-dashoffset', per * (1 - ease.inOut(clamp(p * 1.3 - 0.1))));
      stats.forEach((s, i) => s.bar.setAttribute('width', s.w * ease.out(clamp(p * 2 - 0.9 - i * 0.12))));
      glowR.setAttribute('opacity', f * 0.85);
    };
    return { g, draw(p) { state.p = p; apply(); }, focus(f) { state.f = clamp(f); apply(); }, dim(d) { state.d = clamp(d); apply(); } };
  }

  /** 正面对决：左右两个选手 + 闪电分割线 + VS。opts a:{name, sub, color}, b:{...}；set(t, p)（闪电需要绝对时间） */
  function versus(parent, o) {
    const g = el('g', { opacity: 0 }, parent);
    const ca = o.a.color || seriesColor(0), cb = o.b.color || seriesColor(1);
    const gl = el('linearGradient', { id: id('va'), x1: 0, y1: 0, x2: 1, y2: 0 }, defsOf(rootSvg(parent)).d);
    el('stop', { offset: 0, 'stop-color': ca, 'stop-opacity': 0.0 }, gl); el('stop', { offset: 1, 'stop-color': ca, 'stop-opacity': 0.32 }, gl);
    const gr = el('linearGradient', { id: id('vb'), x1: 1, y1: 0, x2: 0, y2: 0 }, defsOf(rootSvg(parent)).d);
    el('stop', { offset: 0, 'stop-color': cb, 'stop-opacity': 0.0 }, gr); el('stop', { offset: 1, 'stop-color': cb, 'stop-opacity': 0.32 }, gr);
    const sl = W * 0.08;
    const left = el('polygon', { points: `0,0 ${W / 2 + sl},0 ${W / 2 - sl},${H} 0,${H}`, fill: `url(#${gl.id})` }, g);
    const right = el('polygon', { points: `${W / 2 + sl},0 ${W},0 ${W},${H} ${W / 2 - sl},${H}`, fill: `url(#${gr.id})` }, g);
    const bolt = el('path', { fill: 'none', stroke: '#ffffff', 'stroke-width': U * 0.35, 'stroke-linejoin': 'round' }, g);
    const boltGlow = el('path', { fill: 'none', stroke: C.accent, 'stroke-width': U * 1.6, filter: defsOf(rootSvg(parent)).blurM, opacity: 0.9 }, g);
    const nameA = title(g, { x: W * 0.26, y: H * 0.5, text: o.a.name, size: o.size || U * 7.5, anchor: 'middle', accent: ca });
    const nameB = title(g, { x: W * 0.74, y: H * 0.5, text: o.b.name, size: o.size || U * 7.5, anchor: 'middle', accent: cb });
    const subA = label(g, { x: W * 0.26, y: H * 0.5 + U * 6, text: o.a.sub || '', size: U * 2.6, anchor: 'middle', color: C.ink2 });
    const subB = label(g, { x: W * 0.74, y: H * 0.5 + U * 6, text: o.b.sub || '', size: U * 2.6, anchor: 'middle', color: C.ink2 });
    const vs = title(g, { x: W / 2, y: H * 0.5 + U * 4, text: 'VS', size: U * 16, anchor: 'middle', weight: 900, accent: C.accent2 });
    return {
      g,
      set(t, p) {
        g.setAttribute('opacity', clamp(p * 4));
        const k = ease.out(clamp(p * 1.6));
        left.setAttribute('transform', `translate(${-(1 - k) * W * 0.5} 0)`);
        right.setAttribute('transform', `translate(${(1 - k) * W * 0.5} 0)`);
        const r = S.rng(11 + Math.floor(t * 14)), pts = [];
        for (let i = 0; i <= 12; i++) { const yy = H * i / 12; pts.push(`${lerp(W / 2 + sl, W / 2 - sl, i / 12) + (i % 12 ? (r() - 0.5) * U * 5 : 0)},${yy}`); }
        const d = 'M ' + pts.join(' L ');
        bolt.setAttribute('d', d); boltGlow.setAttribute('d', d);
        const on = clamp(p * 2 - 0.4);
        bolt.setAttribute('opacity', on * (0.7 + 0.3 * r())); boltGlow.setAttribute('opacity', on * 0.8);
        nameA.draw(clamp(p * 1.4 - 0.15)); nameB.draw(clamp(p * 1.4 - 0.3));
        subA.draw(clamp(p * 1.6 - 0.6)); subB.draw(clamp(p * 1.6 - 0.7));
        vs.draw(clamp(p * 2 - 0.55));
        const punch = 1 + 0.25 * Math.max(0, 1 - Math.abs(p * 2 - 0.9) * 6);
        vs.g.setAttribute('transform', `translate(${W / 2} ${H * 0.47}) scale(${punch}) translate(${-W / 2} ${-H * 0.47})`);
      },
    };
  }

  // ---------------------------------------------------------------------------------------------
  /** 排名赛（横向柱状图，切换评测项目时柱子重新排序）。
   *  opts x, y, w, h（整个区域）, items:[{id, name, color}], frames:[{label, values:{id: 数值或 null}, max?, note?}],
   *       unit（单位，如 '分' 或 '%'）, digits（小数位）, max（默认取所有帧的最大值）
   *  values 里是 null 表示"未公布"，排在最后，显示灰色标签，不画柱子（不要编数）。
   *  set(t, timeline)：timeline 是 [[时间, 帧序号], ...]，第一个时间点开始生长，之后每个时间点切到对应帧（0.9 秒过渡）。 */
  function barRace(parent, o) {
    const g = el('g', {}, parent), n = o.items.length, digits = o.digits ?? 0, unit = o.unit || '';
    const head = el('g', {}, g);
    const labelW = o.labelW || o.w * 0.24, valueW = U * 11, trackW = o.w - labelW - valueW;
    const top = o.y + U * 7, rowH = (o.h - U * 7) / n, barH = Math.min(rowH * 0.56, U * 5.2);
    const maxAll = o.max || Math.max(...o.frames.flatMap(f => Object.values(f.values).filter(v => v != null)));
    const frameLbl = el('text', { x: o.x, y: o.y + U * 3.6, 'font-size': U * 3.4, 'font-weight': 800, fill: C.ink, 'font-family': C.font }, head);
    const frameNote = el('text', { x: o.x + o.w, y: o.y + U * 3.6, 'font-size': U * 1.9, 'font-weight': 500, fill: C.muted, 'text-anchor': 'end', 'font-family': C.font }, head);
    el('line', { x1: o.x, x2: o.x + o.w, y1: o.y + U * 5.4, y2: o.y + U * 5.4, stroke: C.line, 'stroke-width': U * 0.12 }, head);
    const rows = o.items.map((it, i) => {
      const color = it.color || seriesColor(i), halo = it.halo || haloColor(i);
      const r = el('g', {}, g);
      const rank = el('text', { x: o.x, y: 0, 'font-size': U * 2.2, 'font-weight': 800, fill: C.muted, 'font-family': C.font, 'dominant-baseline': 'central' }, r);
      el('rect', { x: o.x + U * 4.2, y: -U * 0.9, width: U * 1.8, height: U * 1.8, rx: U * 0.5, fill: color }, r);
      const nm = el('text', { x: o.x + U * 7.4, y: 0, 'font-size': U * 2.8, 'font-weight': 700, fill: C.ink, 'font-family': C.font, 'dominant-baseline': 'central' }, r);
      nm.textContent = it.name;
      el('rect', { x: o.x + labelW, y: -barH / 2, width: trackW, height: barH, rx: U * 0.4, fill: 'rgba(150,170,230,0.06)' }, r);
      const glow = el('rect', { x: o.x + labelW, y: -barH / 2, height: barH, rx: U * 0.4, fill: halo, opacity: 0, filter: defsOf(rootSvg(parent)).blurM }, r);
      const bar = el('path', { fill: color }, r);
      const shine = el('rect', { x: o.x + labelW, y: -barH / 2, height: barH * 0.38, rx: U * 0.3, fill: '#ffffff', opacity: 0.12 }, r);
      const val = el('text', { x: 0, y: 0, 'font-size': U * 2.9, 'font-weight': 800, fill: C.ink, 'font-family': C.font, 'dominant-baseline': 'central' }, r);
      const na = el('text', { x: o.x + labelW + U * 1.2, y: 0, 'font-size': U * 2.1, 'font-weight': 600, fill: C.muted, 'font-family': C.font, 'dominant-baseline': 'central' }, r);
      na.textContent = '未公布';
      const crown = crownIcon(r, U * 2.6, C.gold);
      return { it, r, rank, bar, glow, shine, val, na, crown };
    });
    const order = f => {
      const vals = o.frames[f].values;
      const ids = o.items.map(it => it.id).sort((a, b) => (vals[b] ?? -1e9) - (vals[a] ?? -1e9));
      return Object.fromEntries(ids.map((id_, i) => [id_, i]));
    };
    const orders = o.frames.map((_, i) => order(i));
    const barPath = (x, w, h) => {
      const r = Math.min(U * 0.5, h / 2, w / 2);
      return w <= 0.5 ? '' : `M ${x} ${-h / 2} H ${x + w - r} Q ${x + w} ${-h / 2} ${x + w} ${-h / 2 + r} V ${h / 2 - r} Q ${x + w} ${h / 2} ${x + w - r} ${h / 2} H ${x} Z`;
    };
    return {
      g,
      set(t, timeline) {
        const tl = timeline.length ? timeline : [[0, 0]];
        let fa = tl[0][1], fb = fa, m = 1;
        const grow = ease.out(clamp((t - tl[0][0]) / 1.4));
        for (let k = 1; k < tl.length; k++) {
          if (t >= tl[k][0] - 0.9) { fa = tl[k - 1][1]; fb = tl[k][1]; m = ease.inOut(clamp((t - (tl[k][0] - 0.9)) / 0.9)); }
        }
        if (m >= 1) fa = fb;
        const A = o.frames[fa], B = o.frames[fb];
        const cur = m < 0.5 ? A : B;
        frameLbl.textContent = cur.label; frameNote.textContent = cur.note || '';
        head.setAttribute('opacity', clamp((t - tl[0][0] + 0.4) * 2) * (m > 0 && m < 1 ? Math.abs(m - 0.5) * 2 : 1));
        let leader = null, best = -1e9;
        rows.forEach(row => {
          const id_ = row.it.id, va = A.values[id_], vb = B.values[id_];
          // 前 60%：柱子长度变化；后 60%：名次换位（两段有重叠，动作连贯但不会同时挤成一团）
          const mv = ease.inOut(clamp(m / 0.6)), mp = ease.inOut(clamp((m - 0.4) / 0.6));
          const v = va == null && vb == null ? null : lerp(va ?? 0, vb ?? 0, mv);
          const known = mv < 0.5 ? va != null : vb != null;
          const pos = lerp(orders[fa][id_], orders[fb][id_], mp);
          const y = top + rowH * (pos + 0.5);
          row.r.setAttribute('transform', `translate(0 ${y})`);
          row.r.setAttribute('opacity', clamp((t - tl[0][0]) * 3 - orders[fa][id_] * 0.25));
          row.rank.textContent = String((mp < 0.5 ? orders[fa][id_] : orders[fb][id_]) + 1).padStart(2, '0');
          const w = known && v != null ? trackW * clamp(v / maxAll) * grow : 0;
          row.bar.setAttribute('d', barPath(o.x + labelW, w, barH));
          row.shine.setAttribute('width', Math.max(0, w - U * 0.6));
          row.glow.setAttribute('width', w);
          row.val.setAttribute('x', o.x + labelW + w + U * 1.2);
          row.val.textContent = known && v != null ? fmt(v * (grow < 1 ? grow : 1), digits) + unit : '';
          row.na.setAttribute('opacity', known ? 0 : 1);
          if (known && v != null && v > best) { best = v; leader = row; }
          row.crown.setAttribute('opacity', 0);
        });
        rows.forEach(row => row.glow.setAttribute('opacity', row === leader ? 0.55 * grow : 0));
        if (leader && grow > 0.9) {
          const bb = leader.val.getComputedTextLength ? leader.val.getComputedTextLength() : 0;
          leader.crown.setAttribute('transform', `translate(${parseFloat(leader.val.getAttribute('x')) + bb + U * 1} ${U * 0.9})`);
          leader.crown.setAttribute('opacity', clamp((grow - 0.9) * 10));
        }
      },
    };
  }

  /** 雷达图（多选手多维度能力）。opts cx, cy, r, axes:[维度名], series:[{id, name, color, values:[...]}], max（默认 100）, rings（默认 4）
   *  同时最多高亮 2～3 个选手，其余压暗；被高亮的选手在最强的维度旁直接标名字。
   *  draw(p) 网格和多边形生长；focus(ids, p) 高亮这些选手（ids 为 id 数组，空数组表示全部正常显示） */
  function radar(parent, o) {
    const g = el('g', {}, parent), n = o.axes.length, max = o.max || 100, rings = o.rings || 4;
    const ang = i => -Math.PI / 2 + i * 2 * Math.PI / n;
    const pt = (i, v) => [o.cx + Math.cos(ang(i)) * o.r * v, o.cy + Math.sin(ang(i)) * o.r * v];
    const grid = el('g', {}, g);
    const ringEls = Array.from({ length: rings }, (_, k) => el('polygon', { points: o.axes.map((_, i) => pt(i, (k + 1) / rings).join(',')).join(' '), fill: k === rings - 1 ? 'rgba(63,224,255,0.04)' : 'none', stroke: C.line, 'stroke-width': U * 0.12 }, grid));
    const spokes = o.axes.map((_, i) => el('line', { x1: o.cx, y1: o.cy, x2: pt(i, 1)[0], y2: pt(i, 1)[1], stroke: C.line, 'stroke-width': U * 0.12 }, grid));
    const axisLbl = o.axes.map((a, i) => {
      const [x, y] = pt(i, 1.16), c = Math.cos(ang(i));
      const e = el('text', { x, y, 'font-size': o.labelSize || U * 2.5, 'font-weight': 700, fill: C.ink2, 'font-family': C.font, 'text-anchor': Math.abs(c) < 0.2 ? 'middle' : c > 0 ? 'start' : 'end', 'dominant-baseline': 'central' }, grid);
      e.textContent = a; return e;
    });
    const polys = o.series.map((s, k) => {
      const color = s.color || seriesColor(k);
      const sg = el('g', {}, g);
      const fill = el('polygon', { fill: color, 'fill-opacity': 0.1, stroke: 'none' }, sg);
      const glowL = el('polygon', { fill: 'none', stroke: s.halo || haloColor(k), 'stroke-width': U * 0.9, opacity: 0, filter: defsOf(rootSvg(parent)).blurS }, sg);
      const line = el('polygon', { fill: 'none', stroke: color, 'stroke-width': U * 0.25, 'stroke-linejoin': 'round' }, sg);
      const dots = s.values.map(() => el('circle', { r: U * 0.55, fill: color, stroke: C.bg1, 'stroke-width': U * 0.2 }, sg));
      const bestI = s.values.reduce((bi, v, i) => (v ?? -1) > (s.values[bi] ?? -1) ? i : bi, 0);
      const tag = el('text', { 'font-size': U * 2.3, 'font-weight': 800, fill: C.ink, 'font-family': C.font, opacity: 0 }, sg);
      tag.textContent = s.name;
      return { s, color, sg, fill, glowL, line, dots, bestI, tag, grow: 0, f: 1, hi: 0 };
    });
    const redraw = () => polys.forEach(P => {
      const pts = P.s.values.map((v, i) => pt(i, clamp((v ?? 0) / max) * P.grow));
      const str = pts.map(q => q.join(',')).join(' ');
      [P.fill, P.glowL, P.line].forEach(e => e.setAttribute('points', str));
      P.dots.forEach((d, i) => { d.setAttribute('cx', pts[i][0]); d.setAttribute('cy', pts[i][1]); d.setAttribute('opacity', P.grow > 0.05 ? 1 : 0); });
      P.sg.setAttribute('opacity', P.grow > 0 ? lerp(0.22, 1, P.f) : 0);
      P.line.setAttribute('stroke', mix('#5b6482', P.color, P.f));
      P.fill.setAttribute('fill-opacity', 0.06 + 0.16 * P.hi);
      P.glowL.setAttribute('opacity', 0.8 * P.hi);
      const [bx, by] = pts[P.bestI], c = Math.cos(ang(P.bestI));
      P.tag.setAttribute('x', bx + (c >= 0 ? U * 1.4 : -U * 1.4)); P.tag.setAttribute('y', by - U * 1.6);
      P.tag.setAttribute('text-anchor', c >= 0 ? 'start' : 'end');
      P.tag.setAttribute('opacity', P.hi);
    });
    return {
      g,
      draw(p) {
        const q = clamp(p * 1.6);
        ringEls.forEach((e, k) => e.setAttribute('opacity', ease.out(clamp(q * rings - k))));
        spokes.forEach((e, i) => e.setAttribute('opacity', ease.out(clamp(q * n - i))));
        axisLbl.forEach((e, i) => e.setAttribute('opacity', ease.out(clamp(q * 1.4 - 0.3 - i * 0.04))));
        polys.forEach((P, k) => { P.grow = ease.back(clamp(p * 1.5 - 0.35 - k * 0.1)); });
        redraw();
      },
      focus(ids, p) {
        polys.forEach(P => { const on = !ids.length || ids.includes(P.s.id); P.f = lerp(1, on ? 1 : 0, clamp(p)); P.hi = ids.length && on ? clamp(p) : 0; });
        redraw();
      },
    };
  }

  /** 热力图（选手 × 领域）：单色顺序色阶，越强越亮；每一列最强的格子加金色描边。
   *  opts x, y, w, h, rows:[{id, name, color}], cols:[领域名], values:[[...]]（行 × 列，null 表示未公布）, max, min, digits
   *  draw(p) 格子按对角线波浪点亮；best(p) 标出每列最强 */
  function heatmap(parent, o) {
    const g = el('g', {}, parent), R = o.rows.length, K = o.cols.length, digits = o.digits ?? 0;
    const headW = o.headW || o.w * 0.22, headH = U * 5;
    const cw = (o.w - headW) / K, ch = (o.h - headH) / R, gap = U * 0.25;
    const all = o.values.flat().filter(v => v != null);
    const vmax = o.max ?? Math.max(...all), vmin = o.min ?? Math.min(...all);
    const lo = '#0f2038', hi = '#22d3ee', top = '#b8f6ff';
    const cellColor = q => q < 0.75 ? mix(lo, hi, q / 0.75) : mix(hi, top, (q - 0.75) / 0.25);
    o.cols.forEach((c, j) => { const e = el('text', { x: o.x + headW + cw * (j + 0.5), y: o.y + headH * 0.55, 'font-size': U * 2.2, 'font-weight': 700, fill: C.ink2, 'text-anchor': 'middle', 'font-family': C.font }, g); e.textContent = c; });
    const heads = o.rows.map((r, i) => {
      const hg = el('g', { opacity: 0 }, g), y = o.y + headH + ch * (i + 0.5);
      el('rect', { x: o.x, y: y - U * 0.9, width: U * 1.8, height: U * 1.8, rx: U * 0.5, fill: r.color || seriesColor(i) }, hg);
      const e = el('text', { x: o.x + U * 3, y, 'font-size': U * 2.5, 'font-weight': 700, fill: C.ink, 'font-family': C.font, 'dominant-baseline': 'central' }, hg);
      e.textContent = r.name; return hg;
    });
    const cells = o.values.map((row, i) => row.map((v, j) => {
      const x = o.x + headW + cw * j + gap, y = o.y + headH + ch * i + gap, w = cw - gap * 2, h = ch - gap * 2;
      const q = v == null ? 0 : clamp((v - vmin) / Math.max(1e-9, vmax - vmin));
      const cg = el('g', { opacity: 0 }, g);
      const rect = el('rect', { x, y, width: w, height: h, rx: U * 0.5, fill: v == null ? 'rgba(150,170,230,0.06)' : cellColor(q) }, cg);
      const txt = el('text', { x: x + w / 2, y: y + h / 2, 'font-size': Math.min(U * 2.6, h * 0.42), 'font-weight': 800, fill: v == null ? C.muted : q > 0.55 ? C.dark : C.ink, 'text-anchor': 'middle', 'dominant-baseline': 'central', 'font-family': C.font }, cg);
      txt.textContent = v == null ? '未公布' : fmt(v, digits);
      return { cg, rect, i, j, v, x, y, w, h };
    }));
    const bests = o.cols.map((_, j) => {
      let bi = -1, bv = -1e9;
      o.values.forEach((row, i) => { if (row[j] != null && row[j] > bv) { bv = row[j]; bi = i; } });
      if (bi < 0) return null;
      const c = cells[bi][j];
      const ring = el('rect', { x: c.x - U * 0.2, y: c.y - U * 0.2, width: c.w + U * 0.4, height: c.h + U * 0.4, rx: U * 0.6, fill: 'none', stroke: C.gold, 'stroke-width': U * 0.35, opacity: 0 }, g);
      const crown = crownIcon(g, U * 2, C.gold);
      crown.setAttribute('transform', `translate(${c.x + c.w - U * 2.6} ${c.y + U * 2.2})`);
      crown.setAttribute('opacity', 0);
      return { ring, crown };
    });
    return {
      g,
      draw(p) {
        heads.forEach((h, i) => h.setAttribute('opacity', ease.out(clamp(p * 3 - i * 0.2))));
        cells.flat().forEach(c => {
          const q = ease.out(clamp(p * 2.2 - (c.i + c.j) * 0.08));
          c.cg.setAttribute('opacity', q);
          c.cg.setAttribute('transform', `translate(${c.x + c.w / 2} ${c.y + c.h / 2}) scale(${0.6 + 0.4 * q}) translate(${-c.x - c.w / 2} ${-c.y - c.h / 2})`);
        });
      },
      best(p) { bests.forEach((b, j) => { if (!b) return; const q = ease.out(clamp(p * 2 - j * 0.15)); b.ring.setAttribute('opacity', q); b.crown.setAttribute('opacity', q); }); },
    };
  }

  /** 大数字：opts x, y（基线）, value, digits, unit, prefix, label（上方小字）, sub（下方说明）, size（默认 18u）, anchor, color（下划线颜色）
   *  draw(p)：数字滚动到 value，下划线画出 */
  function counter(parent, o) {
    const g = el('g', {}, parent), size = o.size || U * 18, anchor = o.anchor || 'middle';
    const lbl = o.label ? label(g, { x: o.x, y: o.y - size * 1.12, text: o.label, size: U * 2.8, anchor, color: C.ink2, weight: 700 }) : null;
    const glow = el('text', { x: o.x, y: o.y, 'font-size': size, 'font-weight': 900, fill: o.color || C.accent, 'text-anchor': anchor, 'font-family': C.font, filter: defsOf(rootSvg(parent)).blurL, opacity: 0, 'data-qa': 'ignore' }, g);
    const num = el('text', { x: o.x, y: o.y, 'font-size': size, 'font-weight': 900, fill: C.ink, 'text-anchor': anchor, 'font-family': C.font }, g);
    const unitEl = el('tspan', { 'font-size': size * 0.32, 'font-weight': 800, fill: C.ink2, dx: size * 0.08 }, num);
    const line = el('line', { y1: o.y + size * 0.16, y2: o.y + size * 0.16, stroke: o.color || C.accent, 'stroke-width': U * 0.5, 'stroke-linecap': 'round' }, g);
    const sub = o.sub ? label(g, { x: o.x, y: o.y + size * 0.16 + U * 4.6, text: o.sub, size: U * 2.4, anchor, color: C.muted }) : null;
    return {
      g,
      draw(p) {
        const k = ease.out(clamp(p * 1.3));
        const text = (o.prefix || '') + S.countUp(o.value, k, o.digits || 0, o.from || 0);
        if (num.firstChild && num.firstChild.nodeType === 3) num.firstChild.textContent = text; else num.insertBefore(document.createTextNode(text), unitEl);
        unitEl.textContent = o.unit || '';
        glow.textContent = text;
        num.setAttribute('opacity', p > 0 ? clamp(p * 4) : 0);
        glow.setAttribute('opacity', 0.45 * k);
        const w = num.getComputedTextLength(), x0 = anchor === 'middle' ? o.x - w / 2 : anchor === 'end' ? o.x - w : o.x;
        const lp = ease.inOut(clamp(p * 1.5 - 0.4));
        line.setAttribute('x1', x0); line.setAttribute('x2', x0 + w * lp); line.setAttribute('opacity', lp > 0 ? 1 : 0);
        if (lbl) lbl.draw(clamp(p * 2)); if (sub) sub.draw(clamp(p * 1.6 - 0.6));
      },
    };
  }

  /** 领奖台：opts cx, base（底边 y）, w（总宽）, h（冠军台高）, ranks:[{name, color, score, sub}]（第 1 名在前，3～5 名）
   *  draw(p)：台子按名次倒序升起，冠军出现后放彩带。彩带完全由 p 推算（不记状态），p 的区间建议 2.5～3.5 秒 */
  function podium(parent, o) {
    const g = el('g', {}, parent), n = Math.min(o.ranks.length, 5);
    const slots = n >= 5 ? [3, 1, 0, 2, 4] : n === 4 ? [3, 1, 0, 2] : [1, 0, 2].slice(0, n);
    const colW = o.w / slots.length, heights = [1, 0.74, 0.56, 0.42, 0.34];
    const medal = [C.gold, C.silver, C.bronze, C.ink2, C.ink2];
    const cols = slots.map((rk, col) => {
      const r = o.ranks[rk], x = o.cx - o.w / 2 + colW * col + colW * 0.08, w = colW * 0.84, hh = o.h * heights[rk];
      const cg = el('g', {}, g);
      const glow = el('rect', { x, y: o.base - hh, width: w, height: hh, rx: U * 0.8, fill: r.color || seriesColor(rk), opacity: 0, filter: defsOf(rootSvg(parent)).blurL }, cg);
      const body = el('rect', { x, y: o.base - hh, width: w, height: hh, rx: U * 0.8, fill: C.panel, stroke: r.color || seriesColor(rk), 'stroke-width': U * 0.3 }, cg);
      el('rect', { x, y: o.base - hh, width: w, height: U * 0.9, rx: U * 0.45, fill: r.color || seriesColor(rk) }, cg);
      const num = el('text', { x: x + w / 2, y: o.base - hh + U * 9, 'font-size': U * 7, 'font-weight': 900, fill: medal[rk], 'text-anchor': 'middle', 'font-family': C.font }, cg);
      num.textContent = String(rk + 1);
      const sc = el('text', { x: x + w / 2, y: o.base - hh + U * 13.5, 'font-size': U * 2.6, 'font-weight': 800, fill: C.ink, 'text-anchor': 'middle', 'font-family': C.font }, cg);
      sc.textContent = r.score != null ? String(r.score) : '';
      const nm = el('text', { x: x + w / 2, y: o.base - hh - U * 2.2, 'font-size': rk === 0 ? U * 3.8 : U * 3, 'font-weight': 900, fill: C.ink, 'text-anchor': 'middle', 'font-family': C.font }, cg);
      nm.textContent = r.name;
      const sb = el('text', { x: x + w / 2, y: o.base - hh - U * 7.2, 'font-size': U * 2, 'font-weight': 600, fill: C.muted, 'text-anchor': 'middle', 'font-family': C.font }, cg);
      sb.textContent = r.sub || '';
      return { rk, cg, glow, hh, x, w };
    });
    const rnd = S.rng(77);
    const confetti = Array.from({ length: 60 }, () => ({ e: el('rect', { width: U * 0.7, height: U * 1.3, fill: C.series[Math.floor(rnd() * 6)], opacity: 0 }, g), vx: (rnd() - 0.5) * 2, vy: -0.9 - rnd() * 1.2, sp: (rnd() - 0.5) * 12 }));
    return {
      g,
      draw(p) {
        let champAt = null;
        cols.forEach(c => {
          const order = n - 1 - c.rk;
          const q = ease.back(clamp(p * 2.2 - order * 0.3));
          c.cg.setAttribute('transform', `translate(0 ${(1 - q) * c.hh}) `);
          c.cg.setAttribute('opacity', clamp(q * 3));
          c.glow.setAttribute('opacity', c.rk === 0 ? 0.35 * clamp(p * 2 - 1) : 0);
          if (c.rk === 0) champAt = c;
        });
        const burst = clamp((p - 0.62) / 0.38), T = burst * 1.6;
        confetti.forEach(c => {
          if (!champAt || burst <= 0) { c.e.setAttribute('opacity', 0); return; }
          const x = champAt.x + champAt.w / 2 + c.vx * U * 22 * T, y = o.base - champAt.hh - U * 6 + (c.vy * U * 30 * T + U * 40 * T * T);
          c.e.setAttribute('x', x); c.e.setAttribute('y', y); c.e.setAttribute('opacity', clamp(1.6 - T));
          c.e.setAttribute('transform', `rotate(${c.sp * T * 60} ${x} ${y})`);
        });
      },
    };
  }

  /** 出处脚注（每个数据画面都要有）：opts text, x, y（默认在右下角、字幕区以上）, anchor；draw(p) */
  function source(parent, o) {
    const x = o.x ?? S.safe.x + S.safe.w, y = o.y ?? (S.captionsOn ? S.captionZone.y - U * 1.2 : S.safe.y + S.safe.h);
    return label(parent, { x, y, text: o.text, size: o.size || U * 1.8, anchor: o.anchor || 'end', color: C.muted, weight: 500 });
  }

  /** 角标水印（示例数据、截至日期等）：opts text, x, y；draw(p) */
  function watermark(parent, o) {
    return chip(parent, { x: o.x ?? S.safe.x, y: o.y ?? S.safe.y, text: o.text, color: o.color || C.accent2, size: o.size || U * 1.8 });
  }

  window.NA = { C, U, mix, rgba, noise, stage, title, heading, label, chip, panel, legend, player, versus, barRace, radar, heatmap, counter,
    podium, source, watermark };
})();
