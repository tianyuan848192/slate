/* 改编自 Apache-2.0 许可的开源素材，动画和写法有改动。许可证原文见 /opt/slate/licenses/kit/LICENSE */
/** 电影暗角：在目标上叠一层径向渐变遮罩，从浅收紧到深，再轻轻呼吸。参数：at, dur, color, fromAlpha, toAlpha, fromSize, toSize, breathe, edge, shape, z */
KIT.motions = KIT.motions || {};
KIT.motions.vignette = function (tl, target, o = {}) {
  const els = KIT.els(target);
  const NATIVE = 3.8;
  const at = o.at ?? 0, dur = o.dur ?? NATIVE;
  const k = dur / NATIVE;
  const rgb = o.color ?? "0,0,0";
  const a0 = o.fromAlpha ?? 0.35, a1 = o.toAlpha ?? 0.92;
  const s0 = o.fromSize ?? 70, s1 = o.toSize ?? 26;
  const sb = o.breathe === undefined ? 32 : o.breathe;
  const edge = o.edge ?? 100;
  const shape = o.shape ?? "ellipse";
  const eRamp = SLATE.easing("inOutCubic");
  const eSine = SLATE.easing("inOutSine");
  const lerp = (a, b, p) => a + (b - a) * p;
  const clamp = (v) => Math.max(0, Math.min(1, v));

  const bg = (alpha, size) =>
    `radial-gradient(${shape} at center, rgba(${rgb},0) ${size.toFixed(3)}%, rgba(${rgb},${alpha.toFixed(4)}) ${edge}%)`;

  // 本地时间 s（原设计秒数）→ 状态
  const state = (s) => {
    const pr = eRamp(clamp(s / 1.6));
    let alpha = lerp(a0, a1, pr);
    let size = lerp(s0, s1, pr);
    if (sb !== null && s > 2.0) {
      if (s < 2.9) size = lerp(s1, sb, eSine(clamp((s - 2.0) / 0.9)));
      else size = lerp(sb, s1, eSine(clamp((s - 2.9) / 0.9)));
    }
    return { alpha, size };
  };

  const overlays = els.map((el) => {
    const parent = el.parentElement || document.body;
    if (getComputedStyle(parent).position === "static") parent.style.position = "relative";
    const ov = document.createElement("div");
    ov.className = "kit-vignette";
    ov.setAttribute("data-qa", "ignore");
    ov.setAttribute("aria-hidden", "true");
    Object.assign(ov.style, {
      position: "absolute",
      left: el.offsetLeft + "px",
      top: el.offsetTop + "px",
      width: el.offsetWidth + "px",
      height: el.offsetHeight + "px",
      pointerEvents: "none",
      zIndex: String(o.z ?? 90),
      borderRadius: getComputedStyle(el).borderRadius,
    });
    const s = state(0);
    ov.style.background = bg(s.alpha, s.size);
    parent.appendChild(ov);
    return ov;
  });

  tl.call((p) => {
    const s = state(p * NATIVE);
    const v = bg(s.alpha, s.size);
    for (const ov of overlays) ov.style.background = v;
  }, { at, dur: NATIVE * k, ease: "linear" });

  return tl;
};
