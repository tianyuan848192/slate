/* 改编自 Apache-2.0 许可的开源素材，动画和写法有改动。许可证原文见 /opt/slate/licenses/kit/LICENSE */
/** 环形包围：标签沿椭圆环交替弹出，围住不动的中心主体，然后向内收拢并压暗四周。参数：at, dur(默认5), chips(标签元素), closeIn, cues, exit('none'|'fade'|'up'), farX/farY/nearX/nearY(单位 u), dim */
KIT.motions = KIT.motions || {};
KIT.motions.radialSurround = function (tl, target, o = {}) {
  const els = KIT.els(target);
  const center = els[0];
  if (!center) return tl;
  const at = o.at ?? 0, dur = o.dur ?? 5;
  const D0 = 5, k = dur / D0, u = SLATE.u;
  const T = (s) => at + s * k;
  const parent = center.parentElement;
  if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative';

  const chips = o.chips ? KIT.els(o.chips) : [];
  const n = chips.length;
  const closeIn = o.closeIn !== false;
  const exit = o.exit === 'fade' || o.exit === 'up' ? o.exit : 'none';
  const FAR = { rx: o.farX ?? 46, ry: o.farY ?? 25 };
  const NEAR = { rx: o.nearX ?? 31, ry: o.nearY ?? 18 };
  const step = 360 / Math.max(1, n);
  const ring = (i, r) => {
    const deg = -90 + Math.ceil(i / 2) * step * (i % 2 === 1 ? 1 : -1);
    const a = deg * Math.PI / 180;
    return { x: Math.cos(a) * r.rx * u, y: Math.sin(a) * r.ry * u };
  };

  // 定位层：宽高为 0 的 flex 盒，标签自然居中在锚点上
  const wraps = chips.map((chip) => {
    const w = document.createElement('div');
    w.className = 'kit-rs-pos';
    w.style.cssText = 'position:absolute;left:50%;top:50%;width:0;height:0;display:flex;align-items:center;justify-content:center;pointer-events:none;z-index:2;';
    chip.style.whiteSpace = 'nowrap';
    chip.style.flexShrink = '0';
    chip.style.opacity = '0';
    parent.appendChild(w);
    w.appendChild(chip);
    return w;
  });

  let vig = null;
  if (closeIn && o.dim !== false) {
    vig = document.createElement('div');
    vig.setAttribute('data-qa', 'ignore');
    vig.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:3;opacity:0;background:radial-gradient(ellipse at center, rgba(5,7,12,0) 60%, rgba(5,7,12,0.34) 100%);';
    parent.appendChild(vig);
  }

  // 测量中心点（布局坐标，不受缩放影响），只测一次
  let placed = false;
  const place = () => {
    if (placed) return;
    let x = 0, y = 0, e = center;
    while (e && e !== parent) { x += e.offsetLeft; y += e.offsetTop; e = e.offsetParent; }
    if (e !== parent) { x = parent.clientWidth / 2 - center.offsetWidth / 2; y = parent.clientHeight / 2 - center.offsetHeight / 2; }
    const cx = x + center.offsetWidth / 2, cy = y + center.offsetHeight / 2;
    wraps.forEach((w) => { w.style.left = cx + 'px'; w.style.top = cy + 'px'; });
    placed = true;
  };
  tl.call(() => place(), { at: 0, dur: 0.001 });

  // 按 5 秒原设计排期，再整体缩放
  const ENTRY = 0.55, CLOSE_DUR = 0.75, CLOSE_STAG = 0.09, BREATH = 0.35, BASE = 0.9, GAP = 0.3;
  const OUT = exit === 'none' ? 0 : Math.min(0.45, D0 * 0.2);
  const avail = D0 - OUT;
  const closeSpan = closeIn && n ? (n - 1) * CLOSE_STAG + CLOSE_DUR : 0;
  const latest = Math.max(0, avail - ENTRY - closeSpan);
  const gap = n > 1 ? Math.min(GAP, Math.max(0, latest - BASE) / (n - 1)) : GAP;
  const cues = o.cues || [];
  const starts = chips.map((c, i) => {
    const cue = Number(cues[i]);
    const has = cues[i] !== undefined && cues[i] !== null && cues[i] !== '' && Number.isFinite(cue);
    const s = has ? cue : Math.min(BASE, latest) + gap * i;
    return Math.max(0, Math.min(s, latest));
  });

  // 中心：淡入 + 轻微缩放落定，之后不再动
  tl.tween(center, { opacity: [0, 1], scale: [0.94, 1] }, {
    at: T(Math.min(0.05, latest)), dur: Math.min(0.7, Math.max(0.2, avail * 0.25)) * k, ease: 'outQuart'
  });

  // 标签在外环上交替弹出
  chips.forEach((chip, i) => {
    tl.tween(chip, { scale: [0, 1], opacity: [0, 1] }, { at: T(starts[i]), dur: ENTRY * k, ease: 'outQuart' });
  });

  const nearY = [];
  if (closeIn && n) {
    const maxEnd = Math.max(...starts) + ENTRY;
    const closeStart = Math.max(maxEnd, Math.min(maxEnd + BREATH, avail - closeSpan));
    wraps.forEach((w, i) => {
      const f = ring(i, FAR), nr = ring(i, NEAR);
      nearY.push(nr.y);
      tl.tween(w, { x: [f.x, nr.x], y: [f.y, nr.y] }, { at: T(closeStart + i * CLOSE_STAG), dur: CLOSE_DUR * k, ease: 'inOutCubic' });
    });
    if (vig) tl.tween(vig, { opacity: [0, 1] }, { at: T(closeStart + 0.05), dur: Math.min(0.9, Math.max(0.2, closeSpan)) * k, ease: 'inOutQuad' });
  } else {
    wraps.forEach((w, i) => { const f = ring(i, FAR); nearY.push(f.y); tl.set(w, { x: f.x, y: f.y }, 0); });
  }

  // 退场：整体一起离开
  if (exit !== 'none') {
    const os = T(D0 - OUT), od = OUT * k, lift = 0.04 * SLATE.height;
    const all = [center, ...wraps];
    if (vig) all.push(vig);
    tl.tween(all, { opacity: 0 }, { at: os, dur: od, ease: 'inCubic' });
    if (exit === 'up') {
      tl.tween(center, { y: [0, -lift] }, { at: os, dur: od, ease: 'inCubic' });
      wraps.forEach((w, i) => tl.tween(w, { y: [nearY[i], nearY[i] - lift] }, { at: os, dur: od, ease: 'inCubic' }));
    }
  }
  return tl;
};
