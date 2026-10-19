/* 改编自 Apache-2.0 许可的开源素材，动画和写法有改动。许可证原文见 /opt/slate/licenses/kit/LICENSE */
/** 柔焦上浮显现：元素从透明 + 模糊 + 偏移的状态柔和移动到位并变清晰，多个元素依次错开。
 *  参数：at 开始秒数；dur 单个元素时长（默认 0.8）；each 错开间隔（默认 0.12，随 dur 等比缩放）；
 *  distance close|standard|far 或数字(u)；direction up|down；blur soft|standard|heavy 或数字(u)；ease 缓动（默认 outQuart）。 */
KIT.motions = KIT.motions || {};
KIT.motions.softBlurIn = function (tl, target, o = {}) {
  const els = KIT.els(target);
  if (!els.length) return tl;
  const at = o.at ?? 0, dur = o.dur ?? 0.8;
  const k = dur / 0.8;
  const u = SLATE.u;
  // 原设计 1080 短边下：14/28/52px，模糊 8/18/34px，换算成 u（10.8px）
  const distances = { close: 14 / 10.8, standard: 28 / 10.8, far: 52 / 10.8 };
  const blurs = { soft: 8 / 10.8, standard: 18 / 10.8, heavy: 34 / 10.8 };
  const dirs = { up: 1, down: -1 };
  const pick = (table, v, def) => typeof v === 'number' ? v : (Object.prototype.hasOwnProperty.call(table, v) ? table[v] : table[def]);
  const dist = pick(distances, o.distance, 'standard') * u;
  const dir = dirs[o.direction] ?? 1;
  const blur = pick(blurs, o.blur, 'standard') * u;
  const each = (o.each ?? 0.12) * k;
  const ease = o.ease ?? 'outQuart';
  els.forEach(el => { el.style.willChange = 'transform, opacity, filter'; });
  tl.tween(els, {
    opacity: [0, 1],
    y: [dist * dir, 0],
    filter: ['blur(' + blur.toFixed(2) + 'px)', 'blur(0px)']
  }, { at, dur, ease, each });
  return tl;
};
