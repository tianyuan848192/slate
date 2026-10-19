/* 改编自 Apache-2.0 许可的开源素材，动画和写法有改动。许可证原文见 /opt/slate/licenses/kit/LICENSE */
/** 圆形光圈揭示：圆形 clip-path 从原点 (x%, y%) 张开，揭开目标元素（后一状态），盖住 before（前一状态，默认压暗去色）；强调色细环贴着光圈边缘走，光圈盖满前消失。参数：at, dur, openAt, x, y, before, register, accent, rim, fadeIn, exit, exitAt */
KIT.motions = KIT.motions || {};
KIT.motions.irisReveal = function (tl, target, o = {}) {
  const els = KIT.els(target);
  const openAtBase = Math.max(0, o.openAt ?? 0.35);
  const native = openAtBase + 1.1;
  const at = o.at ?? 0, dur = o.dur ?? native;
  const k = dur / native;
  const OPEN_AT = at + openAtBase * k;
  const OPEN_DUR = 1.1 * k;
  const OPEN_END = OPEN_AT + OPEN_DUR;
  const ix = SLATE.clamp(o.x ?? 50, 0, 100);
  const iy = SLATE.clamp(o.y ?? 50, 0, 100);
  const accent = o.accent || '#22c55e';
  const befores = o.before ? KIT.els(o.before) : [];
  const register = o.register === 'plain' ? 'plain' : 'color';
  const SVGNS = 'http://www.w3.org/2000/svg';
  const strokeW = Math.max(2, 0.37 * SLATE.u);
  const ease = SLATE.easing('inOutCubic');

  if (register === 'color') befores.forEach(b => { b.style.filter = 'grayscale(1) brightness(0.76)'; });

  els.forEach((el, i) => {
    const before = befores[i] || null;
    el.style.clipPath = `circle(0px at ${ix}% ${iy}%)`;
    el.style.visibility = 'hidden';
    let svg = null, circ = null;
    if (o.rim !== false && el.parentElement) {
      const parent = el.parentElement;
      if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative';
      svg = document.createElementNS(SVGNS, 'svg');
      svg.setAttribute('data-qa', 'ignore');
      svg.setAttribute('aria-hidden', 'true');
      Object.assign(svg.style, { position: 'absolute', overflow: 'visible', pointerEvents: 'none', opacity: '0', zIndex: '50' });
      circ = document.createElementNS(SVGNS, 'circle');
      circ.setAttribute('fill', 'none');
      circ.setAttribute('stroke', accent);
      circ.setAttribute('stroke-width', String(strokeW));
      circ.setAttribute('r', '0');
      svg.appendChild(circ);
      el.after(svg);
    }
    tl.call((p) => {
      const w = el.offsetWidth || SLATE.width, h = el.offsetHeight || SLATE.height;
      const cx = ix / 100 * w, cy = iy / 100 * h;
      const full = Math.hypot(Math.max(cx, w - cx), Math.max(cy, h - cy)) * 1.02 + 2;
      const e = ease(p);
      const r = full * e;
      el.style.clipPath = `circle(${r.toFixed(2)}px at ${ix}% ${iy}%)`;
      // 光圈闭合时后一状态不可见；完全张开后前一状态被完全盖住，直接隐藏
      el.style.visibility = p > 0 ? 'visible' : 'hidden';
      if (before) before.style.visibility = p >= 1 ? 'hidden' : 'visible';
      if (svg) {
        svg.style.left = el.offsetLeft + 'px';
        svg.style.top = el.offsetTop + 'px';
        svg.style.width = w + 'px';
        svg.style.height = h + 'px';
        svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
        circ.setAttribute('cx', String(cx));
        circ.setAttribute('cy', String(cy));
        circ.setAttribute('r', String(Math.max(0, r)));
      }
    }, { at: OPEN_AT, dur: OPEN_DUR, ease: 'linear' });
    if (svg) {
      tl.tween(svg, { opacity: [0, 1] }, { at: OPEN_AT, dur: Math.min(0.18 * k, OPEN_DUR), ease: 'outQuad' });
      tl.tween(svg, { opacity: 0 }, { at: Math.max(OPEN_AT, OPEN_END - 0.24 * k), dur: 0.24 * k, ease: 'inQuad' });
    }
  });

  const all = els.concat(befores);
  if (o.fadeIn !== false) {
    tl.tween(all, { opacity: [0, 1] }, { at, dur: Math.min(0.32 * k, dur), ease: 'outCubic' });
  }
  if (o.exit === 'fade' || o.exit === 'up') {
    const ex = o.exitAt ?? (at + dur + 1);
    const props = { opacity: 0 };
    if (o.exit === 'up') props.y = -6 * SLATE.height / 100;
    tl.tween(all, props, { at: ex, dur: 0.5 * Math.min(1, k), ease: 'inCubic' });
  }
  return tl;
};
