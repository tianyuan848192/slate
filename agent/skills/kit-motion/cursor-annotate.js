/* 改编自 Apache-2.0 许可的开源素材，动画和写法有改动。许可证原文见 /opt/slate/licenses/kit/LICENSE */
/** 马克笔滑入，在目标区域周围手绘圈/下划线/箭头，墨迹紧跟笔尖，画完抬笔离开。参数：at 开始秒数，dur 时长（默认 2.95），shape circle|underline|arrow，color 墨水颜色 */
(function () {
  var NS = "http://www.w3.org/2000/svg";
  KIT.css("kit-cursor-annotate",
    ".kit-ca-layer{position:absolute;left:0;top:0;width:0;height:0;overflow:visible;pointer-events:none;z-index:50}" +
    ".kit-ca-ink{position:absolute;left:0;top:0;width:1px;height:1px;overflow:visible}" +
    ".kit-ca-pen{position:absolute;left:0;top:0;width:0;height:0}" +
    ".kit-ca-pen svg{position:absolute;left:-40px;top:-200px;width:240px;height:240px;overflow:visible}");

  var E = {
    glide: SLATE.easing("outQuart"), stroke: SLATE.easing("inOutSine"),
    hop: SLATE.easing("inOutCubic"), aside: SLATE.easing("outCubic"), leave: SLATE.easing("inCubic")
  };
  function clamp01(u) { return u < 0 ? 0 : u > 1 ? 1 : u; }
  function smooth(x) { return x * x * (3 - 2 * x); }
  function lerp2(a, b, u) { return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u]; }
  function mix(a, b, u) { return { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u }; }

  function makeLayer(el, color) {
    var parent = el.parentElement;
    if (getComputedStyle(parent).position === "static") parent.style.position = "relative";
    var layer = document.createElement("div");
    layer.className = "kit-ca-layer";
    layer.setAttribute("aria-hidden", "true");
    layer.innerHTML =
      '<svg class="kit-ca-ink"></svg>' +
      '<div class="kit-ca-pen"><svg viewBox="-40 -200 240 240"><g class="kit-ca-body"><g transform="rotate(-50)">' +
      '<path d="M0 0 L15 -5.5 L15 5.5 Z" fill="#1d1d22"/>' +
      '<path d="M3 -1.4 L15 -5.5 L15 5.5 L3 1.4 Z" fill="' + color + '"/>' +
      '<rect x="15" y="-7.5" width="14" height="15" rx="2" fill="#2a2a31"/>' +
      '<rect x="29" y="-9" width="62" height="18" rx="4" fill="#ffffff" stroke="#141414" stroke-width="2"/>' +
      '<rect x="36" y="-9" width="8" height="18" fill="' + color + '"/>' +
      '<rect x="91" y="-9.5" width="16" height="19" rx="6" fill="#1d1d22"/>' +
      '</g></g></svg></div>';
    parent.appendChild(layer);
    return { parent: parent, layer: layer, ink: layer.querySelector(".kit-ca-ink"), pen: layer.querySelector(".kit-ca-pen"), body: layer.querySelector(".kit-ca-body") };
  }

  function build(el, L, shape, color, duration) {
    var pr = L.parent.getBoundingClientRect();
    var scale = (pr.width / (L.parent.offsetWidth || pr.width)) || 1;
    var ox = pr.left + L.parent.clientLeft * scale, oy = pr.top + L.parent.clientTop * scale;
    var r = el.getBoundingClientRect();
    var box = { x: (r.left - ox) / scale, y: (r.top - oy) / scale, w: r.width / scale, h: r.height / scale };
    var F = { l: -ox / scale, t: -oy / scale, r: (innerWidth - ox) / scale, b: (innerHeight - oy) / scale };
    var FW = F.r - F.l, FH = F.b - F.t;
    var unit = SLATE.u / 10.8 / scale;

    var paths;
    if (shape === "underline") {
      var uy = box.y + box.h + 14 * unit, x0 = box.x - box.w * 0.04, span = box.w * 1.08;
      paths = [function (u) { return [x0 + span * u, uy + 4 * unit * Math.sin(u * Math.PI * 1.3) - 12 * unit * u * u]; }];
    } else if (shape === "arrow") {
      var tip = [box.x - 10 * unit, box.y + box.h + 8 * unit];
      var from = [tip[0] - Math.max(160 * unit, box.w * 0.7), tip[1] + Math.max(120 * unit, box.h * 0.9)];
      var ctrl = [from[0] + (tip[0] - from[0]) * 0.15, tip[1] + (from[1] - tip[1]) * 0.05];
      var back = Math.atan2(ctrl[1] - tip[1], ctrl[0] - tip[0]);
      var blen = 30 * unit;
      var barb = function (s) { return [tip[0] + Math.cos(back + s) * blen, tip[1] + Math.sin(back + s) * blen]; };
      paths = [
        function (u) { var v = 1 - u; return [v * v * from[0] + 2 * v * u * ctrl[0] + u * u * tip[0], v * v * from[1] + 2 * v * u * ctrl[1] + u * u * tip[1]]; },
        function (u) { return u < 0.5 ? lerp2(barb(0.5), tip, smooth(u * 2)) : lerp2(tip, barb(-0.5), smooth(u * 2 - 1)); }
      ];
    } else {
      var cx = box.x + box.w / 2, cy = box.y + box.h / 2;
      var rx = box.w * 0.62 + 18 * unit, ry = box.h * 0.66 + 16 * unit, tilt = -5 * Math.PI / 180;
      paths = [function (u) {
        var a = -2.55 + (Math.PI * 2 + 0.5) * u;
        var rr = (1 + 0.035 * Math.sin(3 * a + 1.1)) * (1 + 0.08 * u);
        var ex = Math.cos(a) * rx * rr, ey = Math.sin(a) * ry * rr;
        return [cx + ex * Math.cos(tilt) - ey * Math.sin(tilt), cy + ex * Math.sin(tilt) + ey * Math.cos(tilt)];
      }];
    }

    var squeeze = Math.min(1, duration / 2.95);
    var T_LAND = 0.5 * squeeze, T_DRAW = 0.7 * squeeze, HOP = 0.2 * squeeze;
    var ASIDE_TIME = 0.35 * squeeze, EXIT_TIME = 0.35 * squeeze;
    var drawTotal = (shape === "circle" ? 1.1 : shape === "arrow" ? 0.95 : 0.6) * squeeze;

    function arcLength(fn) {
      var sum = 0, prev = fn(0);
      for (var i = 1; i <= 200; i++) { var p = fn(i / 200); sum += Math.hypot(p[0] - prev[0], p[1] - prev[1]); prev = p; }
      return sum;
    }
    var STEPS = 160, MIN_W = 3 * unit, MAX_W = 7 * unit;
    var strokes = paths.map(function (fn) {
      var pts = [];
      for (var k = 0; k <= STEPS; k++) {
        var u = E.stroke(k / STEPS), p = fn(u);
        var a = fn(Math.max(0, u - 1e-4)), b = fn(Math.min(1, u + 1e-4));
        var tl = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
        pts.push({ x: p[0], y: p[1], nx: -(b[1] - a[1]) / tl, ny: (b[0] - a[0]) / tl });
      }
      pts.forEach(function (p, k) {
        var a = pts[Math.max(0, k - 1)], b = pts[Math.min(STEPS, k + 1)];
        p.speed = Math.hypot(b.x - a.x, b.y - a.y);
      });
      return { pts: pts, length: arcLength(fn) };
    });
    var top = 0;
    strokes.forEach(function (s) { s.pts.forEach(function (p) { top = Math.max(top, p.speed); }); });
    top = top || 1;
    strokes.forEach(function (s) {
      s.pts.forEach(function (p, k) {
        var lift = 1 - smooth(clamp01((k / STEPS - 0.82) / 0.18));
        p.w = MIN_W + (MAX_W - MIN_W) * (1 - p.speed / top) * lift;
      });
      s.el = document.createElementNS(NS, "path");
      s.el.setAttribute("fill", color);
      L.ink.appendChild(s.el);
    });
    var total = strokes.reduce(function (a, s) { return a + s.length; }, 0) || 1;
    var windows = [], cur = T_DRAW;
    strokes.forEach(function (s, i) {
      var sp = (drawTotal - HOP * (strokes.length - 1)) * (s.length / total);
      windows.push({ start: cur, end: cur + sp });
      cur += sp + (i < strokes.length - 1 ? HOP : 0);
    });
    var T_LIFT = cur;
    var T_EXIT = Math.max(T_LIFT + ASIDE_TIME, duration - EXIT_TIME);

    function drawnTo(s, f) {
      var x = clamp01(f) * STEPS, k = Math.floor(x), out = s.pts.slice(0, k + 1);
      if (k < STEPS && x > k) {
        var a = s.pts[k], b = s.pts[k + 1], m = x - k;
        out.push({ x: a.x + (b.x - a.x) * m, y: a.y + (b.y - a.y) * m, nx: a.nx + (b.nx - a.nx) * m, ny: a.ny + (b.ny - a.ny) * m, w: a.w + (b.w - a.w) * m });
      }
      return out;
    }
    function outline(pts) {
      if (pts.length < 2) return "";
      function side(p, d) { var h = p.w / 2 * d; return (p.x + p.nx * h).toFixed(1) + " " + (p.y + p.ny * h).toFixed(1); }
      function cap(p) { var rr = (p.w / 2).toFixed(2); return " A" + rr + " " + rr + " 0 0 0 "; }
      var last = pts[pts.length - 1], d = "M" + side(pts[0], 1);
      for (var i = 1; i < pts.length; i++) d += " L" + side(pts[i], 1);
      d += cap(last) + side(last, -1);
      for (var j = pts.length - 2; j >= 0; j--) d += " L" + side(pts[j], -1);
      return d + cap(pts[0]) + side(pts[0], 1) + " Z";
    }
    function nibOf(s, f) { var p = drawnTo(s, f); p = p[p.length - 1]; return { x: p.x, y: p.y }; }
    var first = nibOf(strokes[0], 0), endPoint = nibOf(strokes[strokes.length - 1], 1);

    var ib = { l: box.x, t: box.y, r: box.x + box.w, b: box.y + box.h };
    strokes.forEach(function (s) { s.pts.forEach(function (p) {
      ib.l = Math.min(ib.l, p.x); ib.t = Math.min(ib.t, p.y); ib.r = Math.max(ib.r, p.x); ib.b = Math.max(ib.b, p.y);
    }); });
    var away = { x: endPoint.x - (box.x + box.w / 2), y: endPoint.y - (box.y + box.h / 2) };
    var al = Math.hypot(away.x, away.y) || 1;
    away = { x: away.x / al, y: away.y / al };
    function reach(p, l, t, rr, b) {
      var hits = [];
      if (away.x > 1e-6) hits.push((rr - p.x) / away.x);
      if (away.x < -1e-6) hits.push((l - p.x) / away.x);
      if (away.y > 1e-6) hits.push((b - p.y) / away.y);
      if (away.y < -1e-6) hits.push((t - p.y) / away.y);
      return hits.length ? Math.max(0, Math.min.apply(null, hits)) : 0;
    }
    var clear = 40 * unit;
    var step = reach(endPoint, ib.l - clear, ib.t - clear, ib.r + clear, ib.b + clear);
    var ASIDE = {
      x: Math.max(F.l + 40 * unit, Math.min(F.r - 100 * unit, endPoint.x + away.x * step)),
      y: Math.max(F.t + 100 * unit, Math.min(F.b - 40 * unit, endPoint.y + away.y * step))
    };
    var off = reach(ASIDE, F.l, F.t, F.r, F.b) + 180 * unit;
    var END = { x: ASIDE.x + away.x * off, y: ASIDE.y + away.y * off };
    var START = { x: first.x + 0.3 * FW, y: F.t + FH * 1.25 };

    function penAt(t) {
      if (t <= T_LAND) return { p: mix(START, first, E.glide(clamp01(t / T_LAND))), lift: 1 };
      if (t <= T_DRAW) return { p: first, lift: 1 - clamp01((t - T_LAND) / (T_DRAW - T_LAND)) };
      for (var i = 0; i < windows.length; i++) {
        var w = windows[i];
        if (t <= w.end) return { p: nibOf(strokes[i], (t - w.start) / (w.end - w.start)), lift: 0 };
        var nx = windows[i + 1];
        if (nx && t < nx.start) {
          var u = (t - w.end) / (nx.start - w.end);
          return { p: mix(nibOf(strokes[i], 1), nibOf(strokes[i + 1], 0), E.hop(u)), lift: Math.sin(Math.PI * u) };
        }
      }
      if (t <= T_EXIT) {
        var a = clamp01((t - T_LIFT) / ASIDE_TIME);
        return { p: mix(endPoint, ASIDE, E.aside(a)), lift: Math.min(1, a * 2.5) };
      }
      return { p: mix(ASIDE, END, E.leave(clamp01((t - T_EXIT) / Math.max(1e-6, duration - T_EXIT)))), lift: 1 };
    }

    return function render(t) {
      strokes.forEach(function (s, i) {
        var w = windows[i];
        s.el.setAttribute("d", outline(drawnTo(s, (t - w.start) / (w.end - w.start))));
      });
      var st = penAt(t), lift = st.lift;
      L.pen.style.transform = "translate(" + st.p.x.toFixed(2) + "px," + st.p.y.toFixed(2) + "px)";
      L.body.setAttribute("transform", "scale(" + ((0.85 + 0.07 * lift) * unit).toFixed(4) + ") rotate(" + (-4 * lift).toFixed(2) + ")");
      L.pen.style.filter = "drop-shadow(0 " + ((3 + 7 * lift) * unit).toFixed(1) + "px " + ((4 + 8 * lift) * unit).toFixed(1) + "px rgba(0,0,0," + (0.3 - 0.1 * lift).toFixed(3) + "))";
    };
  }

  KIT.motions = KIT.motions || {};
  KIT.motions.cursorAnnotate = function (tl, target, o) {
    o = o || {};
    var els = KIT.els(target);
    var at = o.at != null ? o.at : 0, dur = o.dur != null ? o.dur : 2.95;
    dur = Math.max(0.001, dur);
    var shape = ["circle", "underline", "arrow"].indexOf(o.shape) >= 0 ? o.shape : "circle";
    var color = o.color || "#f43f5e";
    els.forEach(function (el) {
      var L = makeLayer(el, color);
      L.pen.style.transform = "translate(-99999px,-99999px)";
      var render = null;
      tl.call(function (p) {
        if (!render) render = build(el, L, shape, color, dur);
        render(p * dur);
      }, { at: at, dur: dur, ease: "linear" });
    });
    return tl;
  };
})();
