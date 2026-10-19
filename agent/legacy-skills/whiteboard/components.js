/* 白板手绘讲解组件（依赖 SLATE 运行时）
 *
 * 所有组件都在创建时一次性生成 SVG 元素，返回 {draw(p)}：p 为 0～1 的进度（0 = 还没画，1 = 画完）。
 * 坐标单位是画布像素（与 SLATE.width/height 一致）；尺寸建议按 SLATE.short 的比例计算。
 *
 *   const c = document.querySelector('svg.wb-canvas');
 *   const a = WB.box(c, {x, y, w, h, label: '向量库'});
 *   const b = WB.arrow(c, {x1, y1, x2, y2});
 *   const q = WB.bubble(c, {x, y, w, h, text: '报销额度是多少？'});
 *   const i = WB.icon(c, 'search', {x, y, size});
 *   const tx = WB.text(c, {x, y, text: '先检索', size, color, anchor: 'start'|'middle'|'end', weight});
 *   const o = WB.circle(c, {x, y, w, h});          // 红色圈出重点
 *   const u = WB.underline(c, {x, y, w});          // 红色下划线
 *   const x = WB.cross(c, {x, y, size});           // 红色打叉
 *   function render(t) { a.draw(SLATE.seg(t, 0.2, 1.2)); b.draw(SLATE.seg(t, 1.0, 1.6)); ... }
 */
(() => {
  const S = window.SLATE;
  const U = S.u;
  const C = { ink: '#2B2B2B', blue: '#1F3A93', red: '#D64545', yellow: '#F2B33D', muted: '#9AA0A6', bg: '#FBFAF7' };
  let seed = 7;
  const jitter = () => { const r = S.rng(seed++); return (amp) => (r() - 0.5) * 2 * amp; };

  /** 手绘折线：在每段之间加一点抖动，返回 path 的 d */
  function rough(points, amp = U * 0.25, closed = false) {
    const j = jitter();
    const pts = points.map(([x, y]) => [x + j(amp), y + j(amp)]);
    let d = `M ${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
    for (let i = 1; i < pts.length; i++) {
      const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
      const mx = (x0 + x1) / 2 + j(amp), my = (y0 + y1) / 2 + j(amp);
      d += ` Q ${mx.toFixed(1)} ${my.toFixed(1)} ${x1.toFixed(1)} ${y1.toFixed(1)}`;
    }
    if (closed) d += ' Z';
    return d;
  }
  const stroke = (parent, d, color = C.blue, width = U * 0.5, fill = 'none') =>
    S.svg('path', { d, fill, stroke: color, 'stroke-width': width, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, parent);
  const group = parent => S.svg('g', {}, parent);
  /** 把多条线按顺序画出来：总进度 p 平均分给每一条 */
  const drawAll = (paths, p) => {
    const n = paths.length;
    paths.forEach((el, i) => S.draw(el, S.clamp(p * n - i)));
  };
  const fade = (el, p) => { el.setAttribute('opacity', S.clamp(p)); };

  function text(parent, { x, y, text, size = U * 4, color = C.ink, anchor = 'start', weight = 500 }) {
    const el = S.svg('text', { x, y, 'font-size': size, 'font-weight': weight, fill: color, 'text-anchor': anchor, 'dominant-baseline': 'middle' }, parent);
    el.textContent = text;
    return {
      el,
      draw(p) {
        el.textContent = S.typewriter(text, S.clamp(p * 1.15));
        el.setAttribute('opacity', p > 0 ? 1 : 0);
      },
    };
  }

  function box(parent, { x, y, w, h, label = '', color = C.blue, size = U * 3.6, fill = null }) {
    const g = group(parent);
    const pts = [[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y + U * 0.3]];
    const bg = fill ? S.svg('rect', { x, y, width: w, height: h, rx: U * 0.6, fill, opacity: 0 }, g) : null;
    const path = stroke(g, rough(pts), color);
    const lab = label ? text(g, { x: x + w / 2, y: y + h / 2, text: label, size, anchor: 'middle' }) : null;
    return {
      g,
      draw(p) {
        S.draw(path, S.clamp(p / 0.7));
        if (bg) fade(bg, S.clamp((p - 0.5) / 0.3) * 0.9);
        if (lab) lab.draw(S.clamp((p - 0.6) / 0.4));
      },
    };
  }

  function arrow(parent, { x1, y1, x2, y2, color = C.ink, width = U * 0.45 }) {
    const g = group(parent);
    const shaft = stroke(g, rough([[x1, y1], [(x1 + x2) / 2, (y1 + y2) / 2], [x2, y2]], U * 0.15), color, width);
    const a = Math.atan2(y2 - y1, x2 - x1), L = U * 2.2;
    const head = stroke(g, rough([[x2 - L * Math.cos(a - 0.45), y2 - L * Math.sin(a - 0.45)], [x2, y2], [x2 - L * Math.cos(a + 0.45), y2 - L * Math.sin(a + 0.45)]], U * 0.1), color, width);
    return { g, draw(p) { S.draw(shaft, S.clamp(p / 0.75)); S.draw(head, S.clamp((p - 0.75) / 0.25)); } };
  }

  function bubble(parent, { x, y, w, h, text: tx = '', color = C.blue, size = U * 4 }) {
    const g = group(parent);
    const r = Math.min(w, h) * 0.18;
    const pts = [[x + r, y], [x + w - r, y], [x + w, y + r], [x + w, y + h - r], [x + w - r, y + h], [x + w * 0.32, y + h],
                 [x + w * 0.18, y + h + h * 0.28], [x + w * 0.2, y + h], [x + r, y + h], [x, y + h - r], [x, y + r], [x + r, y]];
    const path = stroke(g, rough(pts, U * 0.2), color);
    const lab = tx ? text(g, { x: x + w / 2, y: y + h / 2, text: tx, size, anchor: 'middle', color, weight: 700 }) : null;
    return { g, draw(p) { S.draw(path, S.clamp(p / 0.65)); if (lab) lab.draw(S.clamp((p - 0.55) / 0.45)); } };
  }

  /** 图标：按 size 缩放的一组手绘线条 */
  const ICONS = {
    doc: s => [[[0.2, 0], [0.65, 0], [0.85, 0.2], [0.85, 1], [0.2, 1], [0.2, 0]], [[0.33, 0.4], [0.72, 0.4]], [[0.33, 0.58], [0.72, 0.58]], [[0.33, 0.76], [0.6, 0.76]]],
    docs: s => [[[0.1, 0.12], [0.1, 1], [0.7, 1]], [[0.25, 0], [0.7, 0], [0.9, 0.18], [0.9, 0.86], [0.25, 0.86], [0.25, 0]], [[0.37, 0.36], [0.77, 0.36]], [[0.37, 0.56], [0.77, 0.56]]],
    search: s => [circlePts(0.42, 0.42, 0.3), [[0.64, 0.64], [0.95, 0.95]]],
    db: s => [ellipsePts(0.5, 0.15, 0.38, 0.12), [[0.12, 0.15], [0.12, 0.85]], [[0.88, 0.15], [0.88, 0.85]], halfEllipse(0.5, 0.5, 0.38, 0.12), halfEllipse(0.5, 0.85, 0.38, 0.12)],
    user: s => [circlePts(0.5, 0.3, 0.2), [[0.12, 1], [0.18, 0.72], [0.5, 0.6], [0.82, 0.72], [0.88, 1]]],
    bulb: s => [circlePts(0.5, 0.38, 0.3), [[0.38, 0.72], [0.38, 0.88], [0.62, 0.88], [0.62, 0.72]], [[0.42, 0.98], [0.58, 0.98]]],
    check: s => [[[0.1, 0.55], [0.4, 0.85], [0.92, 0.18]]],
    cross: s => [[[0.15, 0.15], [0.85, 0.85]], [[0.85, 0.15], [0.15, 0.85]]],
    gear: s => [circlePts(0.5, 0.5, 0.18), gearPts()],
    cloud: s => [[[0.2, 0.8], [0.06, 0.66], [0.14, 0.46], [0.32, 0.42], [0.42, 0.22], [0.64, 0.22], [0.74, 0.42], [0.9, 0.48], [0.94, 0.68], [0.8, 0.8], [0.2, 0.8]]],
    chip: s => [[[0.22, 0.22], [0.78, 0.22], [0.78, 0.78], [0.22, 0.78], [0.22, 0.22]], [[0.35, 0.02], [0.35, 0.22]], [[0.65, 0.02], [0.65, 0.22]], [[0.35, 0.78], [0.35, 0.98]], [[0.65, 0.78], [0.65, 0.98]], [[0.02, 0.35], [0.22, 0.35]], [[0.02, 0.65], [0.22, 0.65]], [[0.78, 0.35], [0.98, 0.35]], [[0.78, 0.65], [0.98, 0.65]]],
    chart: s => [[[0.05, 0.95], [0.95, 0.95]], [[0.2, 0.95], [0.2, 0.6]], [[0.45, 0.95], [0.45, 0.35]], [[0.7, 0.95], [0.7, 0.15]], [[0.1, 0.55], [0.4, 0.3], [0.6, 0.38], [0.92, 0.08]]],
  };
  function circlePts(cx, cy, r, n = 14) { return Array.from({ length: n + 1 }, (_, i) => [cx + r * Math.cos(i / n * 2 * Math.PI - 1.2), cy + r * Math.sin(i / n * 2 * Math.PI - 1.2)]); }
  function ellipsePts(cx, cy, rx, ry, n = 16) { return Array.from({ length: n + 1 }, (_, i) => [cx + rx * Math.cos(i / n * 2 * Math.PI), cy + ry * Math.sin(i / n * 2 * Math.PI)]); }
  function halfEllipse(cx, cy, rx, ry, n = 10) { return Array.from({ length: n + 1 }, (_, i) => [cx - rx + (2 * rx) * i / n, cy + ry * Math.sin(Math.PI * i / n)]); }
  function gearPts() { const out = []; for (let i = 0; i <= 16; i++) { const a = i / 16 * 2 * Math.PI, r = i % 2 ? 0.42 : 0.32; out.push([0.5 + r * Math.cos(a), 0.5 + r * Math.sin(a)]); } return out; }

  function icon(parent, name, { x, y, size = U * 10, color = C.blue }) {
    const g = group(parent);
    const lines = (ICONS[name] || ICONS.doc)().map(pts => stroke(g, rough(pts.map(([u, v]) => [x + u * size, y + v * size]), U * 0.12), color));
    return { g, draw(p) { drawAll(lines, p); } };
  }

  function circle(parent, { x, y, w, h, color = C.red }) {
    const pts = ellipsePts(x + w / 2, y + h / 2, w / 2 + U, h / 2 + U, 18).concat([[x + w / 2 + w * 0.55, y + h / 2 - h * 0.1]]);
    const path = stroke(parent, rough(pts, U * 0.3), color, U * 0.55);
    return { draw(p) { S.draw(path, p); } };
  }

  function underline(parent, { x, y, w, color = C.red }) {
    const path = stroke(parent, rough([[x, y], [x + w * 0.5, y + U * 0.3], [x + w, y - U * 0.2]], U * 0.15), color, U * 0.55);
    return { draw(p) { S.draw(path, p); } };
  }

  function cross(parent, { x, y, size = U * 8, color = C.red }) {
    const a = stroke(parent, rough([[x, y], [x + size, y + size]], U * 0.2), color, U * 0.7);
    const b = stroke(parent, rough([[x + size, y], [x, y + size]], U * 0.2), color, U * 0.7);
    return { draw(p) { S.draw(a, S.clamp(p * 2)); S.draw(b, S.clamp(p * 2 - 1)); } };
  }

  window.WB = { C, U, rough, text, box, arrow, bubble, icon, circle, underline, cross };
})();
