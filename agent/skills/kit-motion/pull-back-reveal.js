/* 改编自 Apache-2.0 许可的开源素材，动画和写法有改动。许可证原文见 /opt/slate/licenses/kit/LICENSE */
/** 拉远揭示：镜头先紧贴一个细节停住，再一次减速拉远露出完整画面，最后轻轻落定。参数：at, dur(默认2.4), from(起始倍数2.2), focus(起始对准的子元素), origin, context(拉远后才淡入的周边文字), hold(落定后光晕呼吸时长), ground(光晕元素/false), color */
KIT.motions = KIT.motions || {};
KIT.motions.pullBackReveal = function (tl, target, o = {}) {
  const els = KIT.els(target);
  const at = o.at ?? 0, dur = o.dur ?? 2.4;
  const k = dur / 2.4;
  const HOLD0 = 0.55 * k, WHIP = 1.2 * k, DRIFT = 0.65 * k;
  const IN = HOLD0 + WHIP + DRIFT;
  const hold = Math.max(0, o.hold ?? 0);
  const from = o.from ?? 2.2;
  const u = SLATE.u;
  const color = o.color || 'var(--kit-accent, #8b5cf6)';

  els.forEach((world) => {
    // 缩放原点对准 focus 元素的中心
    let origin = o.origin || '50% 50%';
    const focus = o.focus ? KIT.el(o.focus, world) : null;
    if (focus) {
      const wr = world.getBoundingClientRect();
      const fr = focus.getBoundingClientRect();
      if (wr.width > 0 && wr.height > 0) {
        const ox = ((fr.left + fr.width / 2 - wr.left) / wr.width) * 100;
        const oy = ((fr.top + fr.height / 2 - wr.top) / wr.height) * 100;
        origin = ox.toFixed(2) + '% ' + oy.toFixed(2) + '%';
      }
    }
    world.style.transformOrigin = origin;
    if (getComputedStyle(world).position === 'static') world.style.position = 'relative';

    // 地面光晕
    let ground = null;
    if (o.ground) ground = KIT.el(o.ground, world);
    else if (o.ground !== false) {
      ground = document.createElement('div');
      ground.setAttribute('data-qa', 'ignore');
      ground.className = 'kit-pbr-ground';
      Object.assign(ground.style, {
        position: 'absolute', zIndex: '0', left: '15%', bottom: '2%', width: '70%', height: '10%',
        borderRadius: '50%', pointerEvents: 'none', opacity: '0',
        background: 'color-mix(in srgb, ' + color + ' 16%, #0b0c0e)',
        filter: 'blur(' + (3 * u).toFixed(1) + 'px)', transformOrigin: '50% 50%'
      });
      world.insertBefore(ground, world.firstChild);
    }

    // 镜头：紧贴停住 → 一次减速拉远（略拉过头）→ 轻轻落定
    tl.tween(world, { scale: [from, 1.055], y: [0, 0.7 * u] }, { at: at + HOLD0, dur: WHIP, ease: 'outQuint' });
    tl.tween(world, { scale: 1, y: 0 }, { at: at + HOLD0 + WHIP, dur: DRIFT, ease: 'inOutSine' });

    // 周边文字：放大时会被推到画框外，等镜头基本拉开后再淡入
    if (o.context) {
      const ctx = KIT.els(o.context, world);
      if (ctx.length) {
        const cAt = at + HOLD0 + WHIP * 0.6;
        ctx.forEach((c) => { c.style.visibility = 'hidden'; c.style.opacity = '0'; });
        tl.set(ctx, { visibility: 'hidden' }, at);
        tl.set(ctx, { visibility: 'visible' }, cAt);
        tl.tween(ctx, { opacity: [0, 1] }, { at: cAt, dur: WHIP * 0.4 + DRIFT * 0.3, ease: 'outCubic' });
      }
    }

    if (ground) {
      tl.tween(ground, { opacity: [0, 0.78], scaleX: [0.72, 1], scaleY: [0.72, 1] }, { at: at + HOLD0 + WHIP, dur: DRIFT, ease: 'outCubic' });
      if (hold > 0) {
        tl.tween(ground, { opacity: 0.68, scaleX: 0.97 }, { at: at + IN, dur: hold * 0.5, ease: 'inOutSine' });
        tl.tween(ground, { opacity: 0.78, scaleX: 1 }, { at: at + IN + hold * 0.5, dur: hold * 0.5, ease: 'inOutSine' });
      }
    }
  });
  return tl;
};
