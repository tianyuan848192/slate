/* 改编自 Apache-2.0 许可的开源素材，动画和写法有改动。许可证原文见 /opt/slate/licenses/kit/LICENSE */
/** 行动号召收尾：标题上浮淡入 → 按钮胶囊回弹弹出 → 小字落定 → 整组极轻浮动停留。参数：at、dur（默认 4）、action/button/micro（子元素，默认取容器前三个子元素）、drift（停留浮动幅度，单位 SLATE.u，默认 0.35）。 */
KIT.motions = KIT.motions || {};
KIT.motions.ctaLockup = function (tl, target, o = {}) {
  const els = KIT.els(target);
  const at = o.at ?? 0, dur = o.dur ?? 4;
  const u = SLATE.u;
  if (!els.length) return tl;

  let groups = [];
  const pick = (v, scope, fallback) => {
    if (v == null) return fallback;
    if (typeof v === 'string') return scope.querySelector(v) || fallback;
    return v;
  };
  if (els.length >= 2 && (o.action == null && o.button == null)) {
    // 直接传入了 [标题, 按钮, 小字]
    groups.push({ box: els[0].parentElement, action: els[0], button: els[1], micro: els[2] || null });
  } else {
    els.forEach(box => {
      const kids = Array.from(box.children);
      groups.push({
        box,
        action: pick(o.action, box, kids[0] || null),
        button: pick(o.button, box, kids[1] || null),
        micro: pick(o.micro, box, kids[2] || null)
      });
    });
  }

  const IN_BASE = 1.6;
  const k = Math.min(1, Math.max(0.001, dur) / IN_BASE);
  const IN = IN_BASE * k;
  const HOLD = Math.max(0, dur - IN);
  const drift = (o.drift ?? 0.35) * u;

  groups.forEach(g => {
    if (g.action) {
      tl.tween(g.action, { opacity: [0, 1], y: [3.4 * u, 0] }, { at, dur: 0.5 * k, ease: 'outQuart' });
    }
    if (g.button) {
      if (!g.button.style.transformOrigin) g.button.style.transformOrigin = '50% 50%';
      tl.tween(g.button, { scale: [0.72, 1], y: [2.2 * u, 0] }, { at: at + 0.56 * k, dur: 0.6 * k, ease: 'outBack(1.7)' });
      tl.tween(g.button, { opacity: [0, 1] }, { at: at + 0.56 * k, dur: 0.24 * k, ease: 'outCubic' });
    }
    if (g.micro) {
      tl.tween(g.micro, { opacity: [0, 1], y: [1.8 * u, 0] }, { at: at + 1.18 * k, dur: 0.42 * k, ease: 'outCubic' });
    }
    if (HOLD > 0 && drift && g.box) {
      tl.tween(g.box, { y: [0, -drift] }, { at: at + IN, dur: HOLD / 2, ease: 'inOutSine', yoyo: true, repeat: 1 });
    }
  });
  return tl;
};
