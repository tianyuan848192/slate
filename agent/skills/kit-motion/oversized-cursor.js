/* 改编自 Apache-2.0 许可的开源素材，动画和写法有改动。许可证原文见 /opt/slate/licenses/kit/LICENSE */
/** 巨型光标：放大的箭头光标从画外滑入，尖端点中目标、按下点亮，退到目标下方停住，再加速离开画面。参数：at, dur(默认2.6), variant(light|dark), size, ignite(默认true), accent, fg, exit(none|fade|up) */
(function () {
  KIT.motions = KIT.motions || {};
  KIT.motions.oversizedCursor = function (tl, target, o = {}) {
    const els = KIT.els(target);
    const at = o.at ?? 0, dur = o.dur ?? 2.6;
    if (!els.length) return tl;
    const el = els[0];
    const par = el.parentElement;
    if (getComputedStyle(par).position === 'static') par.style.position = 'relative';
    const u = SLATE.u;
    const size = o.size ?? 20.7 * u;
    const dark = o.variant === 'dark';

    const cur = document.createElement('div');
    cur.setAttribute('data-qa', 'ignore');
    cur.setAttribute('aria-hidden', 'true');
    cur.style.cssText = 'position:absolute;left:0;top:0;pointer-events:none;z-index:50;visibility:hidden;' +
      'width:' + size + 'px;height:' + size + 'px;transform-origin:20.83% 12.5%;' +
      'filter:drop-shadow(0 ' + (0.93 * u) + 'px ' + (1.3 * u) + 'px rgba(0,0,0,0.3));';
    cur.innerHTML = '<svg viewBox="0 0 24 24" style="display:block;width:100%;height:100%;stroke-linejoin:round;stroke-linecap:round;fill:' +
      (dark ? '#1c1c1c' : '#ffffff') + ';stroke:' + (dark ? '#ffffff' : '#141414') + ';stroke-width:1.4"><path d="M5 3 L5 19 L9 15 L12 22 L15 20.5 L11.5 14 L18 14 Z"/></svg>';
    par.appendChild(cur);

    // 时间：入场/退场固定，停留可伸缩；太短时等比压缩
    const IN0 = 1.02, OUT0 = 0.4;
    const s = Math.min(1, dur / (IN0 + OUT0));
    const IN = IN0 * s, OUT = OUT0 * s;
    const HOLD = Math.max(0, dur - IN - OUT);
    const OUT_AT = IN + HOLD;
    const glide = 0.5 * s, ci = 0.1 * s, co = 0.22 * s, C = 0.7 * s;
    const drift = Math.min(0.4, HOLD);

    const eOutQuart = SLATE.easing('outQuart'), eInCubic = SLATE.easing('inCubic'),
      eOutCubic = SLATE.easing('outCubic'), eInOutCubic = SLATE.easing('inOutCubic');
    const cl = v => Math.max(0, Math.min(1, v));
    const lerp = (a, b, p) => a + (b - a) * p;

    function tipPoint() {
      let x = 0, y = 0, n = el;
      while (n && n !== par) { x += n.offsetLeft; y += n.offsetTop; n = n.offsetParent; }
      if (n !== par) {
        const a = el.getBoundingClientRect(), b = par.getBoundingClientRect();
        return { x: a.left - b.left + a.width / 2, y: a.top - b.top + a.height / 2 };
      }
      return { x: x + el.offsetWidth / 2, y: y + el.offsetHeight / 2 };
    }

    tl.call((p, t) => {
      const lt = t - at;
      if (lt < 0 || lt >= dur) { cur.style.visibility = 'hidden'; return; }
      cur.style.visibility = 'visible';
      const W = par.clientWidth, H = par.clientHeight;
      const tip = tipPoint();
      const offX = 0.48 * W, offY = 1.16 * H;
      // 滑入
      const g = eOutQuart(cl(lt / glide));
      let x = lerp(offX, tip.x, g), y = lerp(offY, tip.y, g);
      // 退到目标下方
      if (drift > 0.05) {
        const d = eInOutCubic(cl((lt - IN) / drift));
        x += 4.44 * u * d; y += 3.73 * u * d;
      }
      // 离开画面
      const q = eInCubic(cl((lt - OUT_AT) / OUT));
      y = lerp(y, 1.2 * H + size * 0.125, q);
      // 点击缩放
      let sc = 1;
      if (lt >= C && lt < C + ci) sc = lerp(1, 0.9, eInCubic(cl((lt - C) / ci)));
      else if (lt >= C + ci) sc = lerp(0.9, 1, eOutCubic(cl((lt - C - ci) / co)));
      cur.style.transform = 'translate(' + (x - 0.2083 * size) + 'px,' + (y - 0.125 * size) + 'px) scale(' + sc + ')';
    }, { at, dur });

    // 目标被按下、点亮
    tl.tween(el, { scale: [1, 0.96] }, { at: at + C, dur: ci, ease: 'inCubic' });
    tl.tween(el, { scale: 1 }, { at: at + C + ci, dur: co, ease: 'outCubic' });
    if (o.ignite !== false) {
      const accent = o.accent ?? '#0a84ff';
      tl.tween(el, { backgroundColor: accent, borderColor: accent, color: o.fg ?? '#ffffff' },
        { at: at + C + ci, dur: 0.3 * s, ease: 'outCubic' });
    }
    if (o.exit === 'fade') {
      tl.tween(els, { opacity: 0 }, { at: at + OUT_AT, dur: OUT, ease: 'inCubic' });
    } else if (o.exit === 'up') {
      tl.tween(els, { opacity: 0, y: -4 * u }, { at: at + OUT_AT, dur: OUT, ease: 'inCubic' });
    }
    return tl;
  };
})();
