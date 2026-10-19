/* 极简线条组件（依赖 SLATE 运行时）
 *
 * 全片只有一根线：它从画面左边外面进来，在中间变成图形，再从右边出去。
 * 每个形状（LN.shape）都是一串从左到右的点，创建时按弧长重采样成同样多的点，
 * 所以任意两个形状之间都能平滑插值（morph）。组件在创建时一次性生成 SVG 元素，render(t) 里只根据 t 设置状态。
 *
 *   const c = document.querySelector('svg.ln-canvas');
 *   const flat = LN.shape('flat', {y: H * 0.6});                          // 一条水平线
 *   const wave = LN.shape('wave', {y: H * 0.6, amp: U * 1.5});            // 轻轻起伏
 *   const bulb = LN.shape('bulb', {cx: W / 2, y: H * 0.6, size: U * 13}); // 灯泡：线从基线升起，画出灯泡再落回基线
 *   const ln   = LN.line(c, {shape: flat});                                // 线宽默认 0.32u
 *   const dot  = LN.dot(c);                                                // 跟着线走的小圆点（琥珀色）
 *   const tt   = LN.title(document.body, {text: '灵感，从一根线开始', x: W / 2, y: H * 0.7});
 *   function render(t) {
 *     ln.morph(flat, bulb, SLATE.seg(t, 2, 3.8, SLATE.ease.inOut));      // 先定形状
 *     ln.draw(SLATE.seg(t, 0, 1.5));                                      // 再定画出来多少
 *     dot.at(ln, 0.5);                                                    // 圆点停在线的一半处，跟着线变形
 *     tt.draw(SLATE.seg(t, 4.5, 5.5));
 *   }
 *
 * 形状：flat、wave、circle、bulb、check、heart、mountain，或者 LN.shape({d: 'SVG 路径'}, {cx, y, size})，
 * 路径写在 100×100 的方框里，要从左往右一笔画完，它的起点和终点会用水平线接到画面两边。
 */
(() => {
  const S = window.SLATE;
  const U = S.u;
  const C = { bg: '#E9EAED', ink: '#16213E', accent: '#F4B400', muted: '#7C8496' };
  const N = 720;                 // 每个形状的点数
  const PAD = U * 6;             // 线从画面外面进来、出去
  let uid = 0;

  /** 把一串点按弧长重采样成 n 个点 */
  function resample(pts, n = N) {
    const acc = [0];
    for (let i = 1; i < pts.length; i++) acc.push(acc[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    const L = acc[acc.length - 1], out = [];
    let j = 1;
    for (let k = 0; k < n; k++) {
      const s = (L * k) / (n - 1);
      while (j < pts.length - 1 && acc[j] < s) j++;
      const seg = acc[j] - acc[j - 1] || 1, q = (s - acc[j - 1]) / seg;
      out.push([pts[j - 1][0] + (pts[j][0] - pts[j - 1][0]) * q, pts[j - 1][1] + (pts[j][1] - pts[j - 1][1]) * q]);
    }
    return out;
  }
  const arc = (cx, cy, r, a0, a1, n = 48) => Array.from({ length: n + 1 }, (_, i) => { const a = a0 + (a1 - a0) * i / n; return [cx + r * Math.cos(a), cy + r * Math.sin(a)]; });
  const deg = d => (d * Math.PI) / 180;
  /** 两端接上水平线：从画面左边外面到图形起点，从图形终点到画面右边外面 */
  const withLeads = (body, y0, y1) => [[-PAD, y0], ...body, [S.width + PAD, y1]];

  /** 预设图形。坐标都按 size（图形的半径级尺寸）缩放，y 是基线的高度 */
  const PRESETS = {
    flat: ({ y }) => [[-PAD, y], [S.width + PAD, y]],
    wave: ({ y, amp = U * 1.5, len = U * 26, phase = 0 }) => {
      const pts = [];
      for (let x = -PAD; x <= S.width + PAD; x += U * 0.5) {
        const env = Math.sin(Math.PI * S.clamp((x + PAD) / (S.width + PAD * 2)));   // 中间起伏大、两头平
        pts.push([x, y + amp * env * Math.sin(((x / len) * Math.PI * 2) + phase)]);
      }
      return pts;
    },
    circle: ({ cx = S.width / 2, y, size = U * 12 }) => {
      // 线从基线升起绕一整圈，再回到基线（圆的最低点落在基线上）
      const r = size, cy = y - r;
      return withLeads(arc(cx, cy, r, deg(90), deg(90 - 360), 96), y, y);
    },
    bulb: ({ cx = S.width / 2, y, size = U * 12 }) => {
      // 灯泡：球心在基线上方 1.85 倍 size 处；左侧升起 → 灯头 → 灯颈 → 玻璃球 → 灯颈 → 螺纹 → 落回基线
      const R = size, gy = y - R * 1.85, P = (u, v) => [cx + u * R, gy + v * R];
      const body = [
        P(-0.2, 1.85), P(-0.4, 1.64), P(-0.4, 1.24), P(-0.47, 1.08), P(-0.57, 0.84),
        ...arc(0, 0, 1, deg(125), deg(415), 80).map(([u, v]) => P(u, v)),
        P(0.47, 1.08), P(0.4, 1.24), P(-0.4, 1.37), P(0.4, 1.5), P(0.4, 1.64), P(0.2, 1.85),
      ];
      return withLeads(body, y, y);
    },
    check: ({ cx = S.width / 2, y, size = U * 10 }) => {
      // 对勾（像根号）：沿基线进来，向下一顿，再长长地挑上去，从高处出画
      const R = size;
      return withLeads([[cx - R * 1.1, y], [cx - R * 0.45, y + R * 0.6], [cx + R * 0.95, y - R * 1.0]], y, y - R * 1.0);
    },
    heart: ({ cx = S.width / 2, y, size = U * 10 }) => {
      const R = size, pts = [];
      for (let i = 0; i <= 120; i++) {   // 心形线，从底尖出发绕一圈回到底尖
        const a = Math.PI + (i / 120) * Math.PI * 2;
        const hx = 16 * Math.sin(a) ** 3, hy = 13 * Math.cos(a) - 5 * Math.cos(2 * a) - 2 * Math.cos(3 * a) - Math.cos(4 * a);
        pts.push([cx + (hx / 17) * R, y - R * 1.02 - (hy / 17) * R]);
      }
      return withLeads(pts, y, y);
    },
    mountain: ({ cx = S.width / 2, y, size = U * 12 }) => {
      const R = size;
      return [[-PAD, y], [cx - R * 2.2, y], [cx - R * 0.9, y - R * 0.9], [cx - R * 0.45, y - R * 0.5], [cx + R * 0.35, y - R * 1.6], [cx + R * 1.4, y - R * 0.2], [cx + R * 2.2, y], [S.width + PAD, y]];
    },
  };
  /** 自定义路径：d 写在 100×100 的方框里（从左往右一笔画完），放到以 cx 为中心、宽高为 2*size 的位置，底边落在基线 y 上 */
  function fromPath(d, { cx = S.width / 2, y, size = U * 12 }) {
    const NS = 'http://www.w3.org/2000/svg';
    const host = document.createElementNS(NS, 'svg');
    host.setAttribute('width', 0); host.setAttribute('height', 0);
    host.style.position = 'absolute';
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', d);
    host.appendChild(p);
    (document.body || document.documentElement).appendChild(host);
    const L = p.getTotalLength(), pts = [];
    for (let i = 0; i <= 400; i++) { const q = p.getPointAtLength((L * i) / 400); pts.push([cx + (q.x - 50) / 50 * size, y - size * 2 + (q.y / 100) * size * 2]); }
    host.remove();
    return withLeads(pts, pts[0][1], pts[pts.length - 1][1]);
  }

  /** 形状：返回重采样好的点数组（可以直接传给 line.morph） */
  function shape(name, opts = {}) {
    const pts = typeof name === 'object' && name.d ? fromPath(name.d, opts) : (PRESETS[name] || PRESETS.flat)(opts);
    return resample(pts);
  }

  /** 两个形状之间插值 */
  const lerpShape = (a, b, p) => a.map(([x, y], i) => [x + (b[i][0] - x) * p, y + (b[i][1] - y) * p]);

  /** 那一根线。width 建议 0.25u～0.4u */
  function line(parent, { shape: init = null, width = U * 0.32, color = C.ink } = {}) {
    const el = S.svg('path', { fill: 'none', stroke: color, 'stroke-width': width, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, parent);
    let pts = init || shape('flat', { y: S.height * 0.6 });
    let acc = [];
    const update = () => {
      acc = [0];
      for (let i = 1; i < pts.length; i++) acc.push(acc[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
      el.setAttribute('d', pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(''));
    };
    update();
    const self = {
      el,
      /** 设成形状 a 和 b 之间进度 p 的样子（p 自己加缓动） */
      morph(a, b = a, p = 0) { pts = lerpShape(a, b, S.clamp(p)); update(); return self; },
      /** 在三个形状之间过渡：p 从 0 到 1 依次经过 a → b → c（中点是 b） */
      morph3(a, b, c, p) { const q = S.clamp(p); return q < 0.5 ? self.morph(a, b, S.ease.inOut(q * 2)) : self.morph(b, c, S.ease.inOut(q * 2 - 1)); },
      /** 从左往右画出来多少（0～1） */
      draw(p) {
        const L = acc[acc.length - 1];
        el.setAttribute('stroke-dasharray', `${(L * S.clamp(p)).toFixed(1)} ${(L + 10).toFixed(1)}`);
        el.setAttribute('stroke-dashoffset', '0');
        return self;
      },
      /** 弧长比例 s（0～1）处的点 */
      pointAt(s) {
        const L = acc[acc.length - 1], target = L * S.clamp(s);
        let lo = 0, hi = acc.length - 1;
        while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (acc[mid] < target) lo = mid; else hi = mid; }
        const q = (target - acc[lo]) / ((acc[hi] - acc[lo]) || 1);
        return [pts[lo][0] + (pts[hi][0] - pts[lo][0]) * q, pts[lo][1] + (pts[hi][1] - pts[lo][1]) * q];
      },
      /** 屏幕上横坐标为 x 的那一点对应的弧长比例（取第一个经过 x 的点），用来让圆点停在画面里某个位置 */
      sAtX(x) {
        for (let i = 1; i < pts.length; i++) if (pts[i][0] >= x) return acc[i] / acc[acc.length - 1];
        return 1;
      },
    };
    return self;
  }

  /** 跟着线走的小圆点（琥珀色，带一圈底色描边）。glow(p) 让它变成一团柔和的光 */
  function dot(parent, { r = U * 0.9, color = C.accent, glowR = U * 9 } = {}) {
    const id = `ln-glow-${++uid}`;
    const defs = S.svg('defs', {}, parent);
    const grad = S.svg('radialGradient', { id }, defs);
    S.svg('stop', { offset: 0, 'stop-color': color, 'stop-opacity': 0.55 }, grad);
    S.svg('stop', { offset: 0.45, 'stop-color': color, 'stop-opacity': 0.18 }, grad);
    S.svg('stop', { offset: 1, 'stop-color': color, 'stop-opacity': 0 }, grad);
    const halo = S.svg('circle', { r: 0, fill: `url(#${id})` }, parent);
    const el = S.svg('circle', { r, fill: color, stroke: C.bg, 'stroke-width': U * 0.35 }, parent);
    const st = { x: 0, y: 0, r, g: 0, op: 1 };
    const apply = () => {
      for (const e of [el, halo]) { e.setAttribute('cx', st.x.toFixed(1)); e.setAttribute('cy', st.y.toFixed(1)); }
      el.setAttribute('r', st.r.toFixed(2));
      el.setAttribute('opacity', st.op.toFixed(3));
      halo.setAttribute('r', (glowR * S.ease.out(st.g)).toFixed(2));
      halo.setAttribute('opacity', (S.clamp(st.g * 2) * st.op).toFixed(3));
    };
    const self = {
      el,
      /** 放在线 ln 的弧长比例 s 处 */
      at(ln, s) { [st.x, st.y] = ln.pointAt(s); apply(); return self; },
      /** 放在屏幕坐标 (x, y) */
      moveTo(x, y) { st.x = x; st.y = y; apply(); return self; },
      /** 从 a 点移到 b 点，p 为进度 */
      between(a, b, p) { const q = S.ease.inOut(S.clamp(p)); return self.moveTo(a[0] + (b[0] - a[0]) * q, a[1] + (b[1] - a[1]) * q); },
      size(scale) { st.r = r * scale; apply(); return self; },
      show(op) { st.op = S.clamp(op); apply(); return self; },
      /** 发光：p 从 0 到 1，光晕慢慢展开 */
      glow(p) { st.g = S.clamp(p); apply(); return self; },
    };
    apply();
    return self;
  }

  /** 细字标题：细字重、字距宽；出现时字距从更宽慢慢收拢，同时淡入 */
  function title(parent, { text, x, y, size = U * 3.4, align = 'center', weight = 300, color = C.ink, spacing = 0.32 }) {
    const e = document.createElement('div');
    e.className = 'ln-title';
    Object.assign(e.style, { left: `${x}px`, top: `${y}px`, fontSize: `${size}px`, fontWeight: weight, color });
    e.textContent = text;
    (parent.el || parent).appendChild(e);
    const tx = align === 'center' ? '-50%' : align === 'right' ? '-100%' : '0';
    return {
      el: e,
      draw(p) {
        const q = S.ease.out(S.clamp(p));
        e.style.opacity = q.toFixed(3);
        e.style.letterSpacing = `${(spacing + 0.25 * (1 - q)).toFixed(3)}em`;
        // 字距加在每个字的右边，居中时往左挪半个字距，让文字真正居中
        e.style.transform = `translateX(${tx}) translateX(${align === 'center' ? (spacing + 0.25 * (1 - q)) * size / 2 : 0}px)`;
      },
    };
  }

  window.LN = { C, U, N, shape, resample, line, dot, title, presets: Object.keys(PRESETS) };
})();
