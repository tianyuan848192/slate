/* 改编自 Apache-2.0 许可的开源素材，动画和写法有改动。许可证原文见 /opt/slate/licenses/kit/LICENSE */
/** 划线替换：一条横线从旧文字一侧划过，随后新文字淡入上浮。参数：at、dur、next（新文字元素）、origin(left|center|right)、thickness(thin|standard|thick|数字em)、tint(red|amber|blue|violet)、color、rise(em) */
KIT.motions = KIT.motions || {};
KIT.motions.strikethroughReplace = function (tl, target, o = {}) {
  const els = KIT.els(target);
  const at = o.at ?? 0, dur = o.dur ?? 0.54;
  const k = dur / 0.54;
  const origins = { left: "left center", center: "center center", right: "right center" };
  const thick = { thin: 3 / 58, standard: 6 / 58, thick: 10 / 58 };
  const tints = { red: "#ef4444", amber: "#f59e0b", blue: "var(--accent, #38bdf8)", violet: "var(--accent-2, #a78bfa)" };
  const origin = origins[o.origin] || origins.left;
  const th = typeof o.thickness === "number" ? o.thickness : (thick[o.thickness] || thick.standard);
  const color = o.color || tints[o.tint] || tints.red;
  const rise = o.rise ?? 14 / 58;
  const nexts = o.next ? KIT.els(o.next) : [];

  const lines = [];
  els.forEach((el) => {
    const parent = el.parentElement || document.body;
    if (getComputedStyle(parent).position === "static") parent.style.position = "relative";
    const fs = parseFloat(getComputedStyle(el).fontSize) || 16;
    const h = Math.max(1, fs * th);
    const line = document.createElement("i");
    line.setAttribute("data-qa", "ignore");
    Object.assign(line.style, {
      position: "absolute", display: "block", pointerEvents: "none",
      height: h + "px", borderRadius: "999px", background: color,
      transformOrigin: origin, zIndex: 2, left: "0px", top: "0px", width: "0px"
    });
    parent.appendChild(line);
    lines.push({ el, line, h });
  });

  // 每帧按旧文字的位置摆放横线（字体加载后排版变化也能对齐）
  tl.call(() => {
    lines.forEach(({ el, line, h }) => {
      line.style.left = el.offsetLeft + "px";
      line.style.width = el.offsetWidth + "px";
      line.style.top = (el.offsetTop + el.offsetHeight / 2 - h / 2) + "px";
    });
  }, { at: 0, dur: Math.max(at + dur, 0.001) });

  tl.tween(lines.map((l) => l.line), { scaleX: [0, 1] }, { at, dur: 0.28 * k, ease: "outCubic" });

  if (nexts.length) {
    tl.tween(nexts, {
      opacity: [0, 1],
      y: [(i, el) => (parseFloat(getComputedStyle(el).fontSize) || 16) * rise, 0]
    }, { at: at + 0.24 * k, dur: 0.3 * k, ease: "outCubic" });
  }
  return tl;
};
