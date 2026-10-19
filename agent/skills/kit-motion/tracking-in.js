/* 改编自 Apache-2.0 许可的开源素材，动画和写法有改动。许可证原文见 /opt/slate/licenses/kit/LICENSE */
/** 字距收拢入场：文字从宽字距、略低处淡入，字距收紧并上浮到位。参数：at, dur, each, tracking, rise, tone, ease */
(function () {
  window.KIT = window.KIT || {};
  KIT.motions = KIT.motions || {};
  var REACH = { tight: 0.6, standard: 1, wide: 1.8 };
  var RISE = { subtle: 4 / 10.8, standard: 8 / 10.8, bold: 18 / 10.8 }; // 以 SLATE.u 计
  var TONE = { inherit: null, ink: "#18181b", paper: "#fafafa", accent: "var(--kit-accent, #34d399)" };

  KIT.motions.trackingIn = function (tl, target, o) {
    o = o || {};
    var els = KIT.els(target);
    var n = els.length;
    if (!n) return tl;
    var each0 = o.each != null ? o.each : 0.1;
    var base = 0.9 + each0 * (n - 1);
    var at = o.at != null ? o.at : 0;
    var dur = o.dur != null ? o.dur : base;
    var k = dur / base;
    var reach = typeof o.tracking === "number" ? o.tracking : (REACH[o.tracking] != null ? REACH[o.tracking] : 1);
    var riseU = typeof o.rise === "number" ? o.rise : (RISE[o.rise] != null ? RISE[o.rise] : RISE.standard);
    var risePx = riseU * SLATE.u;
    var color = o.tone == null ? null : (Object.prototype.hasOwnProperty.call(TONE, o.tone) ? TONE[o.tone] : o.tone);
    if (color) els.forEach(function (el) { el.style.color = color; });
    var from = (0.28 * reach).toFixed(4) + "em";
    var to = (0.02 * reach).toFixed(4) + "em";
    els.forEach(function (el) { el.style.letterSpacing = from; el.style.opacity = "0"; });
    tl.tween(els, {
      opacity: [0, 1],
      letterSpacing: [from, to],
      y: [risePx, 0]
    }, { at: at, dur: 0.9 * k, ease: o.ease || "outQuart", each: each0 * k });
    return tl;
  };
})();
