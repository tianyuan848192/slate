/* 改编自 Apache-2.0 许可的开源素材，动画和写法有改动。许可证原文见 /opt/slate/licenses/kit/LICENSE */
/** 镜头推进：目标整体缓慢连续放大（先柔和起步，再匀速推进），结尾轻柔淡出。参数：at 开始秒数，dur 总时长（默认 4），intensity 'subtle'|'standard'|'bold' 或最终缩放数字，fadeOut 是否淡出（默认 true）。 */
KIT.motions = KIT.motions || {};
KIT.motions.pushIn = function (tl, target, o = {}) {
  const els = KIT.els(target);
  const at = o.at ?? 0, dur = Math.max(0.001, o.dur ?? 4);
  const scales = { subtle: 1.08, standard: 1.12, bold: 1.18 };
  const finalScale = typeof o.intensity === 'number' ? o.intensity : (scales[o.intensity] ?? scales.standard);
  const fadeOut = o.fadeOut !== false;

  const IN_BASE = 0.8, OUT_BASE = 0.65, fixed = IN_BASE + OUT_BASE;
  const k = dur < fixed ? dur / fixed : 1;
  const IN = IN_BASE * k, OUT = OUT_BASE * k;
  const HOLD = Math.max(0, dur - IN - OUT);
  const OUT_START = IN + HOLD;
  const inScale = HOLD > 0 ? 1 + (finalScale - 1) * 0.24 : finalScale;

  els.forEach(el => { el.style.transformOrigin = '50% 50%'; el.style.willChange = 'transform, opacity'; });

  tl.tween(els, { scale: [1, inScale], opacity: [1, 1] }, { at, dur: IN, ease: 'inOutSine' });
  if (HOLD > 0) tl.tween(els, { scale: [inScale, finalScale] }, { at: at + IN, dur: HOLD, ease: 'linear' });
  if (fadeOut) tl.tween(els, { opacity: [1, 0] }, { at: at + OUT_START, dur: OUT, ease: 'inCubic' });
  return tl;
};
