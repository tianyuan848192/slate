/* 改编自 Apache-2.0 许可的开源素材，动画和写法有改动。许可证原文见 /opt/slate/licenses/kit/LICENSE */
/** 标志重击定格：元素从放大状态以急停缓动落到原尺寸，落地瞬间弹出一圈强调色光环并白闪一帧，随后静止。参数：at 起始秒，dur 时长(默认0.95)，accent 光环颜色(green/blue/violet/CSS色)，ringSize 光环直径px，from 起始缩放(1.15)，flash 白闪不透明度(1) */
KIT.motions = KIT.motions || {};
KIT.motions.logoSting = function (tl, target, o = {}) {
  const els = KIT.els(target);
  const at = o.at ?? 0, dur = o.dur ?? 0.95;
  const k = dur / 0.95;
  const IMPACT = 0.55 * k;
  const RING = 0.4 * k;
  const FLASH = Math.min(1 / 30, RING);
  const u = SLATE.u;
  const colors = { green: "#5df28b", blue: "#4da3ff", violet: "#a978ff" };
  const accent = colors[o.accent] || o.accent || colors.green;
  const size = o.ringSize ?? 38 * u;
  const border = Math.max(2, 0.35 * u);
  const fromScale = o.from ?? 1.15;
  const flashOp = o.flash ?? 1;
  const flashed = new Set();

  els.forEach((el) => {
    const parent = el.parentElement;
    if (getComputedStyle(parent).position === "static") parent.style.position = "relative";

    const ring = document.createElement("div");
    ring.setAttribute("aria-hidden", "true");
    ring.dataset.qa = "ignore";
    Object.assign(ring.style, {
      position: "absolute", left: "0px", top: "0px",
      width: size + "px", height: size + "px",
      marginLeft: -size / 2 + "px", marginTop: -size / 2 + "px",
      border: border + "px solid " + accent, borderRadius: "50%",
      boxSizing: "border-box", opacity: "0", pointerEvents: "none", zIndex: "0"
    });
    parent.insertBefore(ring, el);
    if (getComputedStyle(el).position === "static") el.style.position = "relative";
    if (!el.style.zIndex) el.style.zIndex = "1";

    // 每帧把光环对准目标中心（offset 不受 transform 影响）
    tl.call(() => {
      ring.style.left = el.offsetLeft + el.offsetWidth / 2 + "px";
      ring.style.top = el.offsetTop + el.offsetHeight / 2 + "px";
    }, { at: 0, dur: at + dur + 0.001 });

    tl.tween(el, { scale: [fromScale, 1] }, { at, dur: IMPACT, ease: "outExpo" });
    tl.set(ring, { scale: 0.34, opacity: 0 }, 0);
    tl.tween(ring, { scale: [0.34, 2.4], opacity: [0.92, 0] }, { at: at + IMPACT, dur: RING, ease: "outQuart" });

    if (flashOp > 0 && !flashed.has(parent)) {
      flashed.add(parent);
      const fl = document.createElement("div");
      fl.setAttribute("aria-hidden", "true");
      fl.dataset.qa = "ignore";
      Object.assign(fl.style, {
        position: "absolute", inset: "0", background: "#ffffff",
        opacity: "0", pointerEvents: "none", zIndex: "3"
      });
      parent.appendChild(fl);
      tl.set(fl, { opacity: 0 }, 0);
      tl.set(fl, { opacity: flashOp }, at + IMPACT);
      tl.set(fl, { opacity: 0 }, at + IMPACT + FLASH);
    }
  });
  return tl;
};
