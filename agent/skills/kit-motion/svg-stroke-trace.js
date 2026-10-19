/* 改编自 Apache-2.0 许可的开源素材，动画和写法有改动。许可证原文见 /opt/slate/licenses/kit/LICENSE */
/** SVG 描线显形：按实测长度把线条从头描到尾，闭合图形描完后淡淡填色，可选停留浮动与退场。参数：at, dur(1.85), color, strokeWidth, fill('auto'|true|false), fillOpacity(0.16), glow(true), each(0), hold(0), exit('none'|'fade'|'up'), path */
(function () {
  var GEOM = 'path,line,polyline,polygon,circle,ellipse,rect';
  var NS = 'http://www.w3.org/2000/svg';
  var DEFAULT_PATH = 'M 92 328 C 178 142 292 138 366 276 C 430 396 500 414 558 262 C 622 94 724 112 786 274 C 836 406 894 376 930 194';

  function isClosed(s) {
    var tag = s.tagName.toLowerCase();
    if (tag === 'path') return /[zZ]\s*$/.test(s.getAttribute('d') || '');
    return tag === 'polygon' || tag === 'circle' || tag === 'ellipse' || tag === 'rect';
  }

  KIT.motions = KIT.motions || {};
  KIT.motions.svgStrokeTrace = function (tl, target, o) {
    o = o || {};
    var els = KIT.els(target);
    var at = o.at != null ? o.at : 0;
    var dur = o.dur != null ? o.dur : 1.85;
    var k = dur / 1.85;
    var DRAW = dur * 0.84, FILL = dur - DRAW;
    var each = o.each || 0;
    var fillMode = o.fill != null ? o.fill : 'auto';
    var fillOpacity = o.fillOpacity != null ? o.fillOpacity : 0.16;
    var hold = Math.max(0, o.hold || 0);
    var exit = o.exit === 'fade' || o.exit === 'up' ? o.exit : 'none';
    var OUT = 0.45 * k;
    var u = SLATE.u;

    els.forEach(function (el, ei) {
      var stage = el;
      var shapes = el.matches && el.matches(GEOM) ? [el] : Array.prototype.slice.call(el.querySelectorAll(GEOM));

      if (!shapes.length) {
        // 目标里没有图形：在目标上方叠一层线稿
        var parent = el.parentElement || document.body;
        if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative';
        var wrap = document.createElement('div');
        wrap.setAttribute('data-qa', 'ignore');
        wrap.style.cssText = 'position:absolute;pointer-events:none;left:' + el.offsetLeft + 'px;top:' + el.offsetTop + 'px;width:' + el.offsetWidth + 'px;height:' + el.offsetHeight + 'px;';
        var svg = document.createElementNS(NS, 'svg');
        svg.setAttribute('viewBox', '0 0 1024 520');
        svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
        svg.style.cssText = 'display:block;width:100%;height:100%;overflow:visible';
        var p = document.createElementNS(NS, 'path');
        p.setAttribute('d', o.path || DEFAULT_PATH);
        p.setAttribute('stroke', o.color || '#71f5a7');
        p.setAttribute('stroke-width', String(o.strokeWidth || 12));
        svg.appendChild(p);
        wrap.appendChild(svg);
        parent.appendChild(wrap);
        stage = wrap;
        shapes = [p];
      }

      var t0 = at + ei * each * shapes.length;
      stage.style.opacity = '0';
      tl.tween(stage, { opacity: [0, 1] }, { at: t0, dur: Math.min(0.28 * k, DRAW), ease: 'outCubic' });

      shapes.forEach(function (s, si) {
        var color = o.color || getComputedStyle(s).stroke;
        if (!color || color === 'none') color = '#71f5a7';
        var wantFill = fillMode === true || (fillMode === 'auto' && isClosed(s));
        var ts = t0 + si * each;

        if (wantFill) {
          var f = s.cloneNode(false);
          f.removeAttribute('id');
          f.style.stroke = 'none';
          f.style.fill = color;
          f.style.filter = 'none';
          f.style.opacity = '0';
          s.parentNode.insertBefore(f, s);
          tl.tween(f, { opacity: [0, fillOpacity] }, { at: ts + DRAW, dur: FILL, ease: 'outCubic' });
        }

        s.style.fill = 'none';
        s.style.stroke = color;
        s.style.strokeLinecap = 'round';
        s.style.strokeLinejoin = 'round';
        if (o.strokeWidth) s.setAttribute('stroke-width', String(o.strokeWidth));
        if (o.glow !== false) {
          s.style.filter = 'drop-shadow(0 0 ' + (1.1 * u).toFixed(2) + 'px color-mix(in srgb, ' + color + ' 34%, transparent))';
        }
        var L = s.getTotalLength ? s.getTotalLength() : 1000;
        s.style.strokeDasharray = L + ' ' + L;
        s.style.strokeDashoffset = String(L);
        tl.tween(s, { strokeDashoffset: [L, 0] }, { at: ts, dur: DRAW, ease: 'inOutSine' });
      });

      var inEnd = t0 + (shapes.length - 1) * each + dur;
      if (hold > 0) {
        tl.tween(stage, { y: [0, -0.45 * u] }, { at: inEnd, dur: hold / 2, ease: 'inOutSine', yoyo: true, repeat: 1 });
      }
      var outAt = inEnd + hold;
      if (exit === 'up') {
        tl.tween(stage, { opacity: 0, y: [0, -1.5 * u] }, { at: outAt, dur: OUT, ease: 'inCubic' });
      } else if (exit === 'fade') {
        tl.tween(stage, { opacity: 0 }, { at: outAt, dur: OUT, ease: 'inCubic' });
      }
    });
    return tl;
  };
})();
