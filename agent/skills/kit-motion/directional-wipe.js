/* 改编自 Apache-2.0 许可的开源素材，动画和写法有改动。许可证原文见 /opt/slate/licenses/kit/LICENSE */
/** 方向擦除转场：新画面从左往右裁切擦入，同时轻轻推进、缩放回位；旧画面后退、缩小、变模糊，中途有一道扫光和红青色散闪烁。参数：target=[旧画面, 新画面]（也可以只给新画面），at, dur(默认0.9), shift(u,默认9), blur(u,默认0.75), glare, glitch, ring */
KIT.motions = KIT.motions || {};
KIT.motions.directionalWipe = function (tl, target, o = {}) {
  const els = KIT.els(target);
  const at = o.at ?? 0, dur = o.dur ?? 0.9;
  const k = dur / 0.9;
  const u = SLATE.u;
  const shift = (o.shift ?? 9) * u;
  const back = shift * 70 / 60;
  const blur = (o.blur ?? 0.75) * u;
  const fromEl = els.length >= 2 ? els[0] : null;
  const toEl = els.length >= 2 ? els[1] : els[0];
  if (!toEl) return tl;
  const parent = toEl.parentElement;

  if (o.ring) toEl.style.boxShadow = 'inset 0 0 0 ' + Math.max(1, 0.2 * u).toFixed(1) + 'px ' + o.ring;

  // 擦入开始前，新画面完全不可见
  toEl.style.visibility = 'hidden';
  tl.set(toEl, { visibility: 'hidden' }, 0);
  tl.set(toEl, { visibility: 'visible' }, at);

  // 新画面：右侧裁切逐渐收起，从右侧推回原位，缩放 1.04→1
  tl.tween(toEl, {
    clipPath: ['inset(0% 100% 0% 0%)', 'inset(0% 0% 0% 0%)'],
    x: [shift, 0],
    scale: [1.04, 1]
  }, { at, dur, ease: 'inOutQuart' });

  // 旧画面：后退、缩小、变模糊
  if (fromEl) {
    tl.tween(fromEl, {
      x: [0, -back],
      scale: [1, 0.96],
      filter: ['blur(0px)', 'blur(' + blur.toFixed(2) + 'px)']
    }, { at, dur, ease: 'inOutQuart' });
  }

  if (parent && getComputedStyle(parent).position === 'static') parent.style.position = 'relative';

  // 扫光
  if (o.glare !== false && parent) {
    const fx = document.createElement('div');
    fx.setAttribute('data-qa', 'ignore');
    fx.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:5;mix-blend-mode:screen;' +
      'background:linear-gradient(90deg,transparent,rgba(255,255,255,0.75),transparent);';
    parent.appendChild(fx);
    tl.tween(fx, { xPercent: [-110, 110] }, { at: at + 0.18 * k, dur: 0.58 * k, ease: 'inOutCubic' });
  }

  // 红青色散闪烁
  if (o.glitch !== false && parent) {
    const rgb = document.createElement('div');
    rgb.setAttribute('data-qa', 'ignore');
    rgb.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:6;opacity:0;' +
      'background:linear-gradient(90deg,rgba(239,68,68,0.35),transparent,rgba(34,211,238,0.35));';
    parent.appendChild(rgb);
    const j = 2.4 * u;
    tl.tween(rgb, { opacity: [0, 1], x: [-j, j] },
      { at: at + 0.32 * k, dur: 0.07 * k, ease: 'steps(1)', repeat: 3, yoyo: true });
  }
  return tl;
};
