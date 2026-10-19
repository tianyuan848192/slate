/* 改编自 Apache-2.0 许可的开源素材，动画和写法有改动。许可证原文见 /opt/slate/licenses/kit/LICENSE */
/** 细线环形仪表：圆环从顶部顺时针画到目标比例，中心数字同步滚动，整体上浮淡入、上移淡出。参数：at 开始秒数，dur 总时长（默认 3.35），value 比例 0–1，num 数字选择器，prefix/suffix，color，track，stroke，exit */
(function () {
  KIT.motions = KIT.motions || {};
  const NS = "http://www.w3.org/2000/svg";

  function ensureRing(el, o) {
    let fill = el.querySelector("[data-arc-fill]");
    if (fill) return fill;
    if (getComputedStyle(el).position === "static") el.style.position = "relative";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 220 220");
    svg.setAttribute("data-kit-arc", "");
    Object.assign(svg.style, {
      position: "absolute", left: "0", top: "0", width: "100%", height: "100%",
      pointerEvents: "none", overflow: "visible"
    });
    const sw = String(o.stroke ?? 3);
    const track = document.createElementNS(NS, "circle");
    track.setAttribute("cx", "110"); track.setAttribute("cy", "110"); track.setAttribute("r", "92");
    track.setAttribute("fill", "none");
    track.setAttribute("stroke-width", sw);
    track.style.stroke = o.track ?? "rgba(29,29,31,0.1)";
    fill = document.createElementNS(NS, "circle");
    fill.setAttribute("cx", "110"); fill.setAttribute("cy", "110"); fill.setAttribute("r", "92");
    fill.setAttribute("fill", "none");
    fill.setAttribute("stroke-width", sw);
    fill.setAttribute("stroke-linecap", "round");
    fill.setAttribute("transform", "rotate(-90 110 110)");
    fill.setAttribute("data-arc-fill", "");
    fill.style.stroke = o.color ?? "var(--kit-accent, #0071e3)";
    svg.appendChild(track);
    svg.appendChild(fill);
    el.insertBefore(svg, el.firstChild);
    return fill;
  }

  KIT.motions.mkUsageArc = function (tl, target, o = {}) {
    const els = KIT.els(target);
    const at = o.at ?? 0, dur = o.dur ?? 3.35;
    const k = dur / 3.35;
    const value = Math.max(0, Math.min(1, o.value ?? 0.76));
    const prefix = o.prefix ?? "", suffix = o.suffix ?? "%";
    const u = SLATE.u;

    els.forEach((el) => {
      const fill = ensureRing(el, o);
      const num = o.num ? el.querySelector(o.num) : el.querySelector("[data-arc-num], .arc-num");
      const C = 2 * Math.PI * parseFloat(fill.getAttribute("r"));
      fill.style.strokeDasharray = String(C);
      fill.style.strokeDashoffset = String(C);
      if (num) num.textContent = prefix + "0" + suffix;

      // 入场：淡入 + 上浮
      tl.tween(el, { opacity: [0, 1], y: [1.5 * u, 0] }, { at, dur: 0.6 * k, ease: "outQuart" });
      // 画弧 + 数字滚动，同一个进度驱动
      tl.call((p) => {
        const v = value * p;
        fill.style.strokeDashoffset = String(C * (1 - v));
        if (num) num.textContent = prefix + Math.round(v * 100) + suffix;
      }, { at: at + 0.15 * k, dur: 1.1 * k, ease: "inOutCubic" });
      // 退场：上移淡出
      if (o.exit !== false) {
        tl.tween(el, { opacity: 0, y: -1.1 * u }, { at: at + 3.0 * k, dur: 0.35 * k, ease: "inCubic" });
      }
    });
    return tl;
  };
})();
