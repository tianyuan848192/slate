/* 数据叙事组件（依赖 SLATE 运行时）
 *
 * 所有组件都在创建时一次性生成 SVG 元素，返回 {draw(p)}：p 为 0～1 的进度（0 = 还没出现，1 = 完整）；
 * 图表另有 focus(i, p)：把第 i 项高亮（琥珀色），其余降暗，p 为高亮的进度。
 * 坐标单位是画布像素；尺寸按 SLATE.u 的倍数算。数据只用用户给的或有出处的数字。
 *
 *   const c = document.querySelector('svg.ds-canvas');
 *   const data = [{label: 'Q1', value: 2.1}, {label: 'Q2', value: 2.6}];
 *   const bars = DS.bars(c, {x, y, w, h, data, digits: 1});          // 柱状图：x, y, w, h 是绘图区（不含刻度和类目文字）
 *   const ln   = DS.line(c, {x, y, w, h, data, digits: 1});          // 折线图
 *   const pie  = DS.donut(c, {cx, cy, r, data, center: {value: '62%', label: '复购率'}, legend: {x, y}});   // 环形图
 *   const st   = DS.stat(c, {x, y, value: 4.6, digits: 1, unit: '亿元', label: '第四季度营收', delta: '创历史新高'});  // 大数字卡
 *   const cmp  = DS.compare(c, {from: bars.top(0), to: bars.top(3), text: '2.2 倍'});   // 对比高亮：两根柱子之间的连线和标注
 *   const src  = DS.source(c, {text: '来源：国家统计局 2025 年数据'});                    // 出处脚注，默认在右下角、字幕区以上
 *   function render(t) {
 *     bars.draw(SLATE.seg(t, 0.4, 2.8, SLATE.ease.linear)); bars.focus(3, SLATE.seg(t, 3, 3.5));
 *     cmp.draw(SLATE.seg(t, 3.4, 4.2)); st.draw(SLATE.seg(t, 4, 5)); src.draw(SLATE.seg(t, 0.5, 1));
 *   }
 */
(() => {
  const S = window.SLATE;
  const U = S.u;
  const C = {
    bg: '#13294B', ink: '#FFFFFF', ink2: '#AFC0DD', muted: '#7F93B8', axis: '#8FA6CC', grid: 'rgba(175, 192, 221, 0.14)',
    bar: '#4F86E0', accent: '#F4B400', panel: 'rgba(255, 255, 255, 0.045)', panelLine: 'rgba(175, 192, 221, 0.18)',
    // 分类配色（环形图等多个系列）：按固定顺序取色，已按深色底 #13294B 校验过区分度和对比度
    series: ['#4F86E0', '#D86A7C', '#2B9C8C', '#A07BE0', '#B28A2E'],
  };
  const DIM = 0.35;
  let uid = 0;

  const hex = c => [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16));
  const mix = (c1, c2, p) => {
    const a = hex(c1), b = hex(c2), q = S.clamp(p);
    return '#' + a.map((v, i) => Math.round(v + (b[i] - v) * q).toString(16).padStart(2, '0')).join('');
  };
  const fmt = (v, digits, prefix = '', suffix = '') => prefix + Number(v).toFixed(digits) + suffix;
  /** 好看的刻度：0 到 max 之间 3～5 个整齐的数 */
  function niceTicks(max, n = 4) {
    const raw = max / n, mag = 10 ** Math.floor(Math.log10(raw)), f = raw / mag;
    const step = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * mag;
    const out = [];
    for (let v = step; v <= max + 1e-9; v += step) out.push(+v.toFixed(6));
    return out;
  }
  const text = (parent, attrs, str) => { const e = S.svg('text', attrs, parent); e.textContent = str; return e; };

  /** 坐标轴：基线 + 水平网格线 + 左侧刻度（细、浅，不抢数据的风头） */
  function axes(parent, { x, y, w, h, max, ticks, digits = 0, unit = '' }) {
    const g = S.svg('g', { opacity: 0 }, parent);
    const ys = v => y + h - (v / max) * h;
    for (const v of ticks) {
      S.svg('line', { x1: x, x2: x + w, y1: ys(v), y2: ys(v), stroke: C.grid, 'stroke-width': Math.max(1, U * 0.1) }, g);
      text(g, { x: x - U * 1.2, y: ys(v), 'font-size': U * 1.7, fill: C.muted, 'text-anchor': 'end', 'dominant-baseline': 'middle' }, fmt(v, Number.isInteger(v) ? 0 : digits) + unit);
    }
    const base = S.svg('line', { x1: x, x2: x + w, y1: y + h, y2: y + h, stroke: C.axis, 'stroke-width': U * 0.16 }, g);
    return { g, base, ys, draw(p) { g.setAttribute('opacity', S.clamp(p).toFixed(3)); S.draw(base, p); } };
  }

  /** 顶部圆角、底部直角的柱子 */
  const barPath = (x, yb, w, hh, r) => {
    if (hh <= 0.01) return `M ${x} ${yb} L ${x + w} ${yb} Z`;
    const rr = Math.min(r, hh, w / 2);
    return `M ${x} ${yb} L ${x} ${yb - hh + rr} Q ${x} ${yb - hh} ${x + rr} ${yb - hh} L ${x + w - rr} ${yb - hh} Q ${x + w} ${yb - hh} ${x + w} ${yb - hh + rr} L ${x + w} ${yb} Z`;
  };

  /** 柱状图：一个系列，从同一条基线往上长。数值标在柱顶，类目标在基线下方 */
  function bars(parent, { x, y, w, h, data, max = null, ticks = null, digits = 0, unit = '', prefix = '', color = C.bar, barWidth = null, labelSize = U * 2.8 }) {
    const vmax = max || Math.max(...data.map(d => d.value)) * 1.12;
    const tk = ticks || niceTicks(vmax);
    const ax = axes(parent, { x, y, w, h, max: vmax, ticks: tk, digits });
    const g = S.svg('g', {}, parent);
    const n = data.length, slot = w / n;
    const bw = barWidth || Math.min(slot * 0.52, U * 12);
    const items = data.map((d, i) => {
      const bx = x + slot * i + (slot - bw) / 2, hh = (d.value / vmax) * h;
      const bar = S.svg('path', { fill: color }, g);
      const val = text(g, { x: bx + bw / 2, 'font-size': labelSize, 'font-weight': 700, fill: C.ink, 'text-anchor': 'middle', opacity: 0 }, '');
      const cat = text(g, { x: bx + bw / 2, y: y + h + U * 3.6, 'font-size': U * 2.2, fill: C.ink2, 'text-anchor': 'middle', opacity: 0 }, d.label);
      return { d, bx, hh, bar, val, cat, p: 0 };
    });
    const st = { focus: -1, fp: 0 };
    function apply(it, i) {
      const e = S.ease.out(it.p), hh = it.hh * e, yb = y + h;
      it.bar.setAttribute('d', barPath(it.bx, yb, bw, hh, U * 0.6));
      const isF = i === st.focus, fp = isF ? st.fp : 0, dim = st.focus >= 0 && !isF ? st.fp : 0;
      it.bar.setAttribute('fill', mix(color, C.accent, fp));
      it.bar.setAttribute('opacity', (1 - (1 - DIM) * dim).toFixed(3));
      it.val.textContent = fmt(it.d.value * e, digits, prefix, unit);
      it.val.setAttribute('y', yb - hh - U * 1.4);
      it.val.setAttribute('opacity', (S.clamp(it.p * 3) * (1 - 0.6 * dim)).toFixed(3));
      it.val.setAttribute('font-size', (labelSize * (1 + 0.25 * fp)).toFixed(2));
      it.cat.setAttribute('opacity', (S.clamp(it.p * 4) * (1 - 0.5 * dim)).toFixed(3));
      it.cat.setAttribute('fill', mix(C.ink2, C.ink, fp));
    }
    return {
      g,
      /** 第 i 根柱子长满时柱顶数值上方的点，给 DS.compare 用 */
      top(i) { const it = items[i]; return [it.bx + bw / 2, y + h - it.hh - labelSize * 1.9]; },
      /** 只画坐标轴 */
      axis(p) { ax.draw(p); },
      /** 只长第 i 根柱子 */
      bar(i, p) { items[i].p = S.clamp(p); apply(items[i], i); },
      /** 整张图：先出坐标轴，柱子从左到右依次长出来 */
      draw(p) {
        ax.draw(S.clamp(p / 0.15));
        const dur = Math.min(0.5, 0.9 / Math.max(1, n * 0.6)), step = n > 1 ? (0.9 - dur) / (n - 1) : 0;
        items.forEach((it, i) => { it.p = S.clamp((p - 0.1 - i * step) / dur); apply(it, i); });
      },
      /** 对比高亮：第 i 根变成琥珀色，其余降到 35% */
      focus(i, p) { st.focus = i; st.fp = S.clamp(p); items.forEach(apply); },
    };
  }

  /** 折线图：一个系列。线按进度画出来，下面铺一层很淡的面积，终点标数值 */
  function line(parent, { x, y, w, h, data, min = 0, max = null, ticks = null, digits = 0, unit = '', prefix = '', color = C.bar, labelEvery = 0 }) {
    const vmax = max || Math.max(...data.map(d => d.value)) * 1.12;
    const tk = ticks || niceTicks(vmax - min).map(v => v + min);
    const ax = axes(parent, { x, y, w, h, max: vmax - min, ticks: tk.map(v => v - min), digits });
    // 刻度文字按真实数值显示
    Array.from(ax.g.querySelectorAll('text')).forEach((el, i) => { el.textContent = fmt(tk[i], Number.isInteger(tk[i]) ? 0 : digits) + unit; });
    const n = data.length;
    const px = i => x + (n > 1 ? (w * i) / (n - 1) : w / 2), py = v => y + h - ((v - min) / (vmax - min)) * h;
    const pts = data.map((d, i) => [px(i), py(d.value)]);
    const id = `ds-line-${++uid}`;
    const defs = S.svg('defs', {}, parent);
    const grad = S.svg('linearGradient', { id: id + 'g', x1: 0, y1: 0, x2: 0, y2: 1 }, defs);
    S.svg('stop', { offset: 0, 'stop-color': color, 'stop-opacity': 0.22 }, grad);
    S.svg('stop', { offset: 1, 'stop-color': color, 'stop-opacity': 0.02 }, grad);
    const clip = S.svg('clipPath', { id: id + 'c' }, defs);
    const clipRect = S.svg('rect', { x: x - U, y: y - U * 10, width: 0, height: h + U * 20 }, clip);
    const g = S.svg('g', {}, parent);
    const d = pts.map(([a, b], i) => `${i ? 'L' : 'M'} ${a.toFixed(1)} ${b.toFixed(1)}`).join(' ');
    const area = S.svg('path', { d: `${d} L ${pts[n - 1][0]} ${y + h} L ${pts[0][0]} ${y + h} Z`, fill: `url(#${id}g)`, 'clip-path': `url(#${id}c)` }, g);
    const path = S.svg('path', { d, fill: 'none', stroke: color, 'stroke-width': U * 0.45, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, g);
    const dots = pts.map(([a, b]) => S.svg('circle', { cx: a, cy: b, r: 0, fill: color, stroke: C.bg, 'stroke-width': U * 0.3 }, g));
    const cats = data.map((dd, i) => (labelEvery ? i % labelEvery === 0 || i === n - 1 : i === 0 || i === n - 1)
      ? text(g, { x: px(i), y: y + h + U * 3.6, 'font-size': U * 2.2, fill: C.ink2, 'text-anchor': 'middle', opacity: 0 }, dd.label) : null);
    const endVal = text(g, { x: pts[n - 1][0], y: pts[n - 1][1] - U * 2.4, 'font-size': U * 2.8, 'font-weight': 700, fill: C.ink, 'text-anchor': 'middle', opacity: 0 }, fmt(data[n - 1].value, digits, prefix, unit));
    const ring = S.svg('circle', { r: U * 1.6, fill: 'none', stroke: C.accent, 'stroke-width': U * 0.35, opacity: 0 }, g);
    const call = text(g, { 'font-size': U * 3.2, 'font-weight': 700, fill: C.ink, 'text-anchor': 'middle', opacity: 0 }, '');
    const st = { p: 0, focus: -1, fp: 0 };
    function apply() {
      const p = st.p;
      ax.draw(S.clamp(p / 0.15));
      const q = S.clamp((p - 0.1) / 0.85);
      S.draw(path, q);
      clipRect.setAttribute('width', (w * q + U * 2).toFixed(1));
      dots.forEach((el, i) => { const at = n > 1 ? i / (n - 1) : 0; el.setAttribute('r', (U * 0.75 * S.ease.back(S.clamp((q - at) * 8 + 0.0001))).toFixed(2)); });
      cats.forEach((el, i) => el && el.setAttribute('opacity', S.clamp((q - (n > 1 ? i / (n - 1) : 0)) * 6 + 1).toFixed(3)));
      endVal.setAttribute('opacity', S.clamp((p - 0.9) / 0.1).toFixed(3));
      const dimmed = st.focus >= 0 ? st.fp : 0;
      path.setAttribute('opacity', (1 - 0.45 * dimmed).toFixed(3));
      if (st.focus >= 0) {
        const [fx, fy] = pts[st.focus];
        ring.setAttribute('cx', fx); ring.setAttribute('cy', fy);
        ring.setAttribute('opacity', st.fp.toFixed(3));
        ring.setAttribute('r', (U * (2.6 - st.fp)).toFixed(2));
        dots[st.focus].setAttribute('fill', mix(color, C.accent, st.fp));
        call.textContent = fmt(data[st.focus].value, digits, prefix, unit);
        call.setAttribute('x', fx); call.setAttribute('y', fy - U * 3.2);
        call.setAttribute('opacity', st.fp.toFixed(3));
        if (st.focus === n - 1) endVal.setAttribute('opacity', '0');
      }
    }
    return {
      g, point: i => pts[i],
      draw(p) { st.p = S.clamp(p); apply(); },
      /** 圈出第 i 个点并标出数值 */
      focus(i, p) { st.focus = i; st.fp = S.clamp(p); apply(); },
    };
  }

  /** 环形图：部分占整体。各段之间留一道细缝；legend 给出图例的位置 {x, y}（每项带数值） */
  function donut(parent, { cx, cy, r = U * 16, thick = U * 4.5, data, colors = C.series, center = null, legend = null, digits = 0, unit = '%' }) {
    const g = S.svg('g', {}, parent);
    const total = data.reduce((s, d) => s + d.value, 0);
    const L = 2 * Math.PI * r, gap = U * 0.35;
    S.svg('circle', { cx, cy, r, fill: 'none', stroke: 'rgba(175, 192, 221, 0.08)', 'stroke-width': thick }, g);
    let acc = 0;
    const segs = data.map((d, i) => {
      const len = (d.value / total) * L, start = acc; acc += len;
      const el = S.svg('circle', { cx, cy, r, fill: 'none', stroke: colors[i % colors.length], 'stroke-width': thick,
        transform: `rotate(-90 ${cx} ${cy})` }, g);
      return { d, el, len, start };
    });
    const cv = center ? text(g, { x: cx, y: cy - U * 0.4, 'font-size': r * 0.42, 'font-weight': 700, fill: C.ink, 'text-anchor': 'middle', 'dominant-baseline': 'middle', opacity: 0 }, center.value) : null;
    const cl = center && center.label ? text(g, { x: cx, y: cy + r * 0.32, 'font-size': U * 2, fill: C.ink2, 'text-anchor': 'middle', 'dominant-baseline': 'middle', opacity: 0 }, center.label) : null;
    const leg = legend ? data.map((d, i) => {
      const lg = S.svg('g', { opacity: 0 }, g), ly = legend.y + i * U * 5;
      S.svg('rect', { x: legend.x, y: ly - U * 0.9, width: U * 1.8, height: U * 1.8, rx: U * 0.4, fill: colors[i % colors.length] }, lg);
      text(lg, { x: legend.x + U * 3, y: ly, 'font-size': U * 2.3, fill: C.ink2, 'dominant-baseline': 'middle' }, d.label);
      text(lg, { x: legend.x + U * 3 + (legend.w || U * 20), y: ly, 'font-size': U * 2.3, 'font-weight': 700, fill: C.ink, 'text-anchor': 'end', 'dominant-baseline': 'middle' },
        fmt((d.value / total) * 100, digits) + unit);
      return lg;
    }) : [];
    const st = { p: 0, focus: -1, fp: 0 };
    function apply() {
      const sweep = S.ease.inOut(S.clamp(st.p / 0.8)) * L;
      segs.forEach((s, i) => {
        const shown = S.clamp(sweep - s.start, 0, s.len), vis = Math.max(0, shown - gap);
        s.el.setAttribute('stroke-dasharray', `${vis.toFixed(2)} ${(L - vis).toFixed(2)}`);
        s.el.setAttribute('stroke-dashoffset', (-s.start).toFixed(2));
        s.el.setAttribute('visibility', vis > 0 ? 'visible' : 'hidden');
        const isF = i === st.focus, dim = st.focus >= 0 && !isF ? st.fp : 0;
        s.el.setAttribute('opacity', (1 - (1 - DIM) * dim).toFixed(3));
        s.el.setAttribute('stroke-width', (thick + (isF ? U * 1.4 * st.fp : 0)).toFixed(2));
      });
      const tail = S.clamp((st.p - 0.75) / 0.25);
      if (cv) cv.setAttribute('opacity', tail.toFixed(3));
      if (cl) cl.setAttribute('opacity', tail.toFixed(3));
      leg.forEach((lg, i) => {
        const dim = st.focus >= 0 && i !== st.focus ? st.fp : 0;
        lg.setAttribute('opacity', (S.clamp((st.p - 0.3 - i * 0.1) / 0.25) * (1 - 0.6 * dim)).toFixed(3));
      });
    }
    return {
      g,
      draw(p) { st.p = S.clamp(p); apply(); },
      /** 第 i 段加粗，其余降暗 */
      focus(i, p) { st.focus = i; st.fp = S.clamp(p); apply(); },
    };
  }

  /** 大数字卡：标签 + 放大的数字（数字滚动）+ 单位 + 变化标签。card: true 时带一块浅色底板和左侧琥珀竖条 */
  function stat(parent, { x, y, value, digits = 0, prefix = '', unit = '', label = '', delta = '', size = U * 13, card = true, w = U * 46 }) {
    const g = S.svg('g', { opacity: 0 }, parent);
    const h = size * 1.95 + (delta ? U * 6 : 0);
    const nb = y + U * 5.4 + size * 1.16;   // 数字的基线：给上方标签留出字体的上沿，避免两段文字的框重叠
    if (card) {
      S.svg('rect', { x, y, width: w, height: h, rx: U * 1.6, fill: C.panel, stroke: C.panelLine, 'stroke-width': Math.max(1, U * 0.1) }, g);
      S.svg('rect', { x, y: y + U * 2.4, width: U * 0.6, height: h - U * 4.8, rx: U * 0.3, fill: C.accent }, g);
    }
    const px0 = x + U * 4;
    const lab = text(g, { x: px0, y: y + U * 4.6, 'font-size': U * 2.4, fill: C.ink2, 'font-weight': 500 }, label);
    const num = text(g, { x: px0, y: nb, 'font-size': size, 'font-weight': 700, fill: C.ink, 'letter-spacing': -size * 0.02 }, '');
    const tsp = S.svg('tspan', { 'font-size': size * 0.32, fill: C.ink2, 'font-weight': 500, dx: U * 1 }, null);
    const pill = delta ? S.svg('g', {}, g) : null;
    let pillW = 0;
    if (pill) {
      const pt = text(pill, { x: px0 + U * 1.6, y: y + h - U * 3.6, 'font-size': U * 2.2, 'font-weight': 700, fill: C.bg, 'dominant-baseline': 'middle' }, delta);
      pillW = (pt.getComputedTextLength() || Array.from(delta).length * U * 2.2) + U * 3.2;
      const bg = S.svg('rect', { x: px0, y: y + h - U * 5.6, width: pillW, height: U * 4, rx: U * 2, fill: C.accent }, null);
      pill.insertBefore(bg, pt);
    }
    return {
      g, h,
      draw(p) {
        p = S.clamp(p);
        g.setAttribute('opacity', S.clamp(p * 4).toFixed(3));
        lab.setAttribute('opacity', S.clamp(p * 3).toFixed(3));
        const q = S.seg(p, 0.1, 0.8);
        num.textContent = prefix + S.countUp(value, q, digits);
        if (unit) { tsp.textContent = unit; num.appendChild(tsp); }
        const sc = 1.06 - 0.06 * S.ease.out(q);
        num.setAttribute('transform', `translate(${px0} ${nb}) scale(${sc.toFixed(4)}) translate(${-px0} ${-nb})`);
        if (pill) {
          const pp = S.seg(p, 0.75, 1, S.ease.back);
          pill.setAttribute('opacity', S.clamp(pp * 2).toFixed(3));
          pill.setAttribute('transform', `translate(0 ${((1 - pp) * U * 1.5).toFixed(2)})`);
        }
      },
    };
  }

  /** 对比高亮：从 from 点升起，横跨到 to 点再落下（带箭头），中间挂一个琥珀色标注 */
  function compare(parent, { from, to, text: label, lift = U * 5 }) {
    const g = S.svg('g', {}, parent);
    const ly = Math.min(from[1], to[1]) - lift;
    const path = S.svg('path', { d: `M ${from[0]} ${from[1]} L ${from[0]} ${ly} L ${to[0]} ${ly} L ${to[0]} ${to[1]}`, fill: 'none', stroke: C.accent, 'stroke-width': U * 0.3, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }, g);
    const a = U * 1.3;
    const head = S.svg('path', { d: `M ${to[0] - a} ${to[1] - a * 1.2} L ${to[0]} ${to[1]} L ${to[0] + a} ${to[1] - a * 1.2}`, fill: 'none', stroke: C.accent, 'stroke-width': U * 0.3, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', opacity: 0 }, g);
    const pill = S.svg('g', { opacity: 0 }, g);
    const mx = (from[0] + to[0]) / 2;
    const bg = S.svg('rect', { y: ly - U * 2.4, height: U * 4.8, rx: U * 2.4, fill: C.accent }, pill);
    const tx = text(pill, { x: mx, y: ly, 'font-size': U * 2.6, 'font-weight': 700, fill: C.bg, 'text-anchor': 'middle', 'dominant-baseline': 'middle' }, label);
    const tw = (tx.getComputedTextLength() || Array.from(label).length * U * 2.6) + U * 3.6;
    bg.setAttribute('x', mx - tw / 2); bg.setAttribute('width', tw);
    return {
      g,
      draw(p) {
        p = S.clamp(p);
        S.draw(path, S.clamp(p / 0.7));
        head.setAttribute('opacity', S.clamp((p - 0.65) / 0.1).toFixed(3));
        const pp = S.seg(p, 0.55, 1, S.ease.back);
        pill.setAttribute('opacity', S.clamp(pp * 2).toFixed(3));
        pill.setAttribute('transform', `translate(${mx} ${ly}) scale(${(0.8 + 0.2 * pp).toFixed(4)}) translate(${-mx} ${-ly})`);
      },
    };
  }

  /** 出处脚注：画面角落的一行小字。corner：'br'（右下，默认）| 'bl' | 'tr' | 'tl'；下方两个角会自动让开字幕区 */
  function source(parent, { text: str, corner = 'br', size = U * 1.7 }) {
    const right = corner[1] === 'r', bottom = corner[0] === 'b';
    const sf = S.safe, z = S.captionZone;
    const x = right ? sf.x + sf.w : sf.x;
    const y = bottom ? (S.captionsOn ? z.y - U * 1.6 : sf.y + sf.h - U * 0.6) : sf.y + size;
    const el = text(parent, { x, y, 'font-size': size, fill: C.muted, 'text-anchor': right ? 'end' : 'start', opacity: 0, 'letter-spacing': size * 0.04 }, str);
    return { el, draw(p) { el.setAttribute('opacity', S.clamp(p).toFixed(3)); } };
  }

  window.DS = { C, U, mix, niceTicks, bars, line, donut, stat, compare, source };
})();
