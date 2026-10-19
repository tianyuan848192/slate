/* 改编自 Apache-2.0 许可的开源素材，动画和写法有改动。许可证原文见 /opt/slate/licenses/kit/LICENSE */
/** 视差放大转场：网格卡片由中心向外浮现，焦点卡放大铺满画面，其余卡片向外视差散开并淡出。
 *  参数：at 开始秒数；dur 总时长（默认 6）；cards 卡片；focus 焦点卡（序号/选择器/元素）；
 *  scale 焦点卡放大倍数；push 每格外推距离（SLATE.u，默认 83）；label 焦点卡内要淡出的内容；reveal 铺满后淡入的元素。 */
(function () {
  KIT.motions = KIT.motions || {};
  KIT.motions.parallaxZoom = function (tl, target, o = {}) {
    const grids = KIT.els(target);
    const at = o.at ?? 0, dur = o.dur ?? 6;
    const k = dur / 6;
    const T = (s) => at + s * k;
    const W = SLATE.width, H = SLATE.height;

    grids.forEach((grid) => {
      const cards = o.cards ? KIT.els(o.cards, grid) : Array.from(grid.children);
      if (!cards.length) return;

      let focal;
      if (typeof o.focus === 'number') focal = cards[o.focus];
      else if (o.focus) focal = KIT.el(o.focus, grid);
      if (!focal) focal = cards.find((c) => c.dataset.pzFocus === 'true') || cards[Math.floor(cards.length / 2)];
      focal.dataset.pzFocus = 'true';
      if (getComputedStyle(focal).position === 'static') focal.style.position = 'relative';
      focal.style.zIndex = '10';

      const fr = focal.getBoundingClientRect();
      const fcx = fr.left + fr.width / 2, fcy = fr.top + fr.height / 2;
      const push = (o.push ?? 83) * SLATE.u;
      const hasRC = focal.dataset.pzRow != null && focal.dataset.pzCol != null;

      const sibs = [], offs = [];
      cards.forEach((c) => {
        if (c === focal) return;
        let dCol, dRow;
        if (hasRC && c.dataset.pzRow != null && c.dataset.pzCol != null) {
          dCol = Number(c.dataset.pzCol) - Number(focal.dataset.pzCol);
          dRow = Number(c.dataset.pzRow) - Number(focal.dataset.pzRow);
        } else {
          const r = c.getBoundingClientRect();
          dCol = Math.round((r.left + r.width / 2 - fcx) / (fr.width || 1));
          dRow = Math.round((r.top + r.height / 2 - fcy) / (fr.height || 1));
        }
        sibs.push(c);
        offs.push({ dx: dCol * push, dy: dRow * push });
      });

      // 焦点卡放大到刚好盖住整个画面（留余量给圆角）
      const hw = fr.width / 2 || 1, hh = fr.height / 2 || 1;
      const cover = Math.max(fcx / hw, (W - fcx) / hw, fcy / hh, (H - fcy) / hh) * 1.15;
      const S = o.scale ?? Math.max(6, cover);

      // 1. 由中心向外依次浮现
      tl.tween(cards, { opacity: [0, 1] }, { at: T(0), dur: 0.5 * k, ease: 'outCubic', each: 0.03 * k, from: 'center' });

      // 2. 推进：焦点放大，其他卡缩小并向外推
      tl.tween(focal, { scale: [1, S] }, { at: T(1.7), dur: 3 * k, ease: 'inOutCubic' });
      if (sibs.length) {
        tl.tween(sibs, {
          x: (i) => offs[i].dx,
          y: (i) => offs[i].dy,
          scale: 0.6,
        }, { at: T(1.7), dur: 3 * k, ease: 'inOutCubic' });
        // 4. 其他卡片淡出
        tl.tween(sibs, { opacity: 0 }, { at: T(3.5), dur: 1 * k, ease: 'inCubic' });
      }

      // 3. 焦点卡内文字淡出
      const label = o.label ? KIT.els(o.label, grid) : Array.from(focal.children);
      if (label.length) tl.tween(label, { opacity: 0 }, { at: T(2.5), dur: 1 * k, ease: 'inCubic' });
    });

    // 5. 铺满后淡入
    if (o.reveal) {
      const rv = KIT.els(o.reveal);
      if (rv.length) tl.tween(rv, { opacity: [0, 1] }, { at: T(4.2), dur: 0.7 * k, ease: 'outCubic' });
    }
    return tl;
  };
})();
