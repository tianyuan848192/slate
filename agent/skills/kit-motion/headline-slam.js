/* 改编自 Apache-2.0 许可的开源素材，动画和写法有改动。许可证原文见 /opt/slate/licenses/kit/LICENSE */
/** 标题重砸：从放大状态砸进画面，落地抖三帧，停留时轻轻浮动，最后向上甩出。参数：at 开始秒数，dur 总时长（默认 3.5），shake 抖动倍数（默认 1），drift 浮动幅度（单位 u，默认 0.33），exit 是否退场（默认 true），from 起始缩放（默认 1.6） */
KIT.motions = KIT.motions || {};
KIT.motions.headlineSlam = function (tl, target, o = {}) {
  const els = KIT.els(target);
  const at = o.at ?? 0, dur = o.dur ?? 3.5;
  const u = SLATE.u;
  const shake = o.shake ?? 1;
  const drift = (o.drift ?? 0.33) * u;
  const exit = o.exit ?? true;
  const fromScale = o.from ?? 1.6;

  const IN_BASE = 0.72, OUT_BASE = 0.46, LAND_BASE = 0.58, FRAME_BASE = 1 / 30;
  const outBase = exit ? OUT_BASE : 0;
  const baseTotal = IN_BASE + outBase;
  const s = dur < baseTotal ? Math.max(0.001, dur) / baseTotal : 1;
  const IN = IN_BASE * s, OUT = outBase * s, LAND = LAND_BASE * s, FRAME = FRAME_BASE * s;
  const HOLD = Math.max(0, dur - IN - OUT);
  const OUT_START = at + IN + HOLD;

  els.forEach(el => {
    if (!el.style.transformOrigin) el.style.transformOrigin = '50% 50%';
    el.style.translate = '0px 0px';
  });

  // 砸入
  tl.tween(els, { scale: [fromScale, 1], opacity: [0, 1] }, { at, dur: LAND, ease: 'outExpo' });

  // 落地三帧抖动
  const px = (x, y) => `${(x * u * shake).toFixed(3)}px ${(y * u * shake).toFixed(3)}px`;
  if (shake) {
    tl.tween(els, { translate: [px(0, 0), px(0.78, -0.18)] }, { at: at + LAND, dur: FRAME, ease: 'outCubic' });
    tl.tween(els, { translate: [px(0.78, -0.18), px(-0.54, 0.12)] }, { at: at + LAND + FRAME, dur: FRAME, ease: 'outCubic' });
    tl.tween(els, { translate: [px(-0.54, 0.12), '0px 0px'] }, { at: at + LAND + FRAME * 2, dur: FRAME, ease: 'outCubic' });
  }

  // 停留浮动：上去再回来
  if (HOLD > 0 && drift) {
    tl.tween(els, { y: [0, -drift] }, { at: at + IN, dur: HOLD / 2, ease: 'inOutSine' });
    tl.tween(els, { y: [-drift, 0] }, { at: at + IN + HOLD / 2, dur: HOLD / 2, ease: 'inOutSine' });
  }

  // 向上甩出
  if (exit) {
    tl.tween(els, { y: [0, -SLATE.height * 1.2] }, { at: OUT_START, dur: OUT, ease: 'inQuint' });
  }
  return tl;
};
