/* 改编自 Apache-2.0 许可的开源素材，动画和写法有改动。许可证原文见 /opt/slate/licenses/kit/LICENSE */
/** 逐词浮现：文字一个词接一个词淡入，同时升起、去模糊、放大到原大小。参数：at, dur, direction(up|down|left|right), distance(close|standard|far|数字), tone(ink|paper|accent|颜色), split(auto|words|chars|none), each, wordDur, ease */
(function () {
  KIT.motions = KIT.motions || {};

  var AXES = { up: [0, 1], down: [0, -1], left: [-1, 0], right: [1, 0] };
  var REACH = { close: 0.5, standard: 1, far: 1.85 };
  var TONES = { ink: "var(--fg, #18181b)", paper: "#fafafa", accent: "var(--brand, #34d399)" };

  function pieces(el, mode) {
    if (mode === "none") return [el];
    if (el._kitFadeUnits) return el._kitFadeUnits;
    var units;
    var hasText = Array.prototype.some.call(el.childNodes, function (n) {
      return n.nodeType === 3 && n.textContent.trim();
    });
    if (mode === "auto" && el.children.length && !hasText) {
      units = Array.prototype.slice.call(el.children);
    } else if (el.dataset.kitSplit) {
      units = Array.prototype.slice.call(el.children);
    } else {
      units = mode === "chars" ? KIT.splitChars(el) : KIT.splitWords(el);
      el.dataset.kitSplit = mode === "chars" ? "chars" : "words";
    }
    units.forEach(function (u) {
      if (getComputedStyle(u).display === "inline") u.style.display = "inline-block";
    });
    el._kitFadeUnits = units;
    return units;
  }

  KIT.motions.staggeredFadeUp = function (tl, target, o) {
    o = o || {};
    var els = KIT.els(target);
    var mode = o.split || "auto";
    var units = [];
    els.forEach(function (el) {
      if (o.tone) el.style.color = TONES[o.tone] || o.tone;
      units = units.concat(pieces(el, mode));
    });
    if (!units.length) return tl;

    var n = units.length;
    var baseEach = o.each ?? 0.18, baseWord = o.wordDur ?? 0.4;
    var native = baseWord + (n - 1) * baseEach;
    var at = o.at ?? 0, dur = o.dur ?? native;
    var k = dur / native;

    var axis = AXES[o.direction] || AXES.up;
    var reach = typeof o.distance === "number" ? o.distance : (REACH[o.distance] ?? 1);
    var u = SLATE.u;
    var off = 5 * u * reach;
    var blur = 1.05 * u;
    var ease = o.ease || "outQuart";
    var opt = { at: at, dur: baseWord * k, ease: ease, each: baseEach * k };

    tl.tween(units, {
      opacity: [0, 1],
      x: [axis[0] * off, 0],
      y: [axis[1] * off, 0],
      scale: [0.92, 1],
      filter: ["blur(" + blur.toFixed(2) + "px)", "blur(0px)"]
    }, opt);
    return tl;
  };
})();
