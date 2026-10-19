/* 改编自 Apache-2.0 许可的开源素材，动画和写法有改动。许可证原文见 /opt/slate/licenses/kit/LICENSE */
KIT.shots["mk-background"] = function (root, o = {}) {
  const content = Object.assign({
    scheme: "light",          // 配色："light" 浅色 / "dark" 深色
    animationIn: true,         // 入场：淡入 + 色块收回
    animationOut: true,        // 结尾淡出
    drift: true,               // 色块缓慢漂移
    blob1: { x: 0.28, y: 0.32, r: 950, opacity: 0.85 },  // 色块1：中心（占宽高的比例）、半径 px、不透明度
    blob2: { x: 0.74, y: 0.66, r: 1100, opacity: 0.8 },  // 色块2
    barDemo: true,             // 演示 全屏 → 圆角卡片 → 全屏
    bar: { x: 240, y: 140, width: 1440, height: 800, roundness: 40 }, // 卡片位置尺寸
    contentOpacity: 1,         // 卡片层不透明度
    frostBlur: 0               // 毛玻璃模糊 px，0 为关闭
  }, o.content);
  const theme = Object.assign({
    "--kit-font": "\"Inter\", \"Noto Sans CJK SC\", sans-serif",
    "--kit-stage": "#f5f5f7",
    "--kit-base": "#ffffff",
    "--kit-blob-1": "#ff7ac8",
    "--kit-blob-2": "#45d6c8",
    "--kit-stage-dark": "#000000",
    "--kit-base-dark": "#0a0a0c",
    "--kit-blob-1-dark": "#7d5cff",
    "--kit-blob-2-dark": "#2d1b69",
    "--kit-shadow": "0 30px 80px rgba(0, 0, 0, 0.18)"
  }, o.theme);
  const { k, d, exitAt } = KIT.fit(10, o.dur);
  const W = 1920, H = 1080;

  KIT.css("mk-background", `
    .kit-mk-background, .kit-mk-background * { box-sizing: border-box; margin: 0; padding: 0; }
    .kit-mk-background .mkb-root { position: absolute; left: 0; top: 0; width: 1920px; height: 1080px; overflow: hidden; background: var(--kit-stage); }
    .kit-mk-background .mkb-root.mkb-dark { background: var(--kit-stage-dark); }
    .kit-mk-background .mkb-card { position: absolute; left: 0; top: 0; width: 1920px; height: 1080px; overflow: hidden; border-radius: 0px; background: var(--kit-base); box-shadow: var(--kit-shadow); }
    .kit-mk-background .mkb-dark .mkb-card { background: var(--kit-base-dark); }
    .kit-mk-background .mkb-blob { position: absolute; border-radius: 50%; will-change: transform; }
    .kit-mk-background .mkb-b1 { background: radial-gradient(circle closest-side, var(--kit-blob-1) 0%, rgba(255,255,255,0) 72%); }
    .kit-mk-background .mkb-b2 { background: radial-gradient(circle closest-side, var(--kit-blob-2) 0%, rgba(255,255,255,0) 72%); }
    .kit-mk-background .mkb-dark .mkb-b1 { background: radial-gradient(circle closest-side, var(--kit-blob-1-dark) 0%, rgba(0,0,0,0) 72%); }
    .kit-mk-background .mkb-dark .mkb-b2 { background: radial-gradient(circle closest-side, var(--kit-blob-2-dark) 0%, rgba(0,0,0,0) 72%); }
  `);

  const stage = KIT.stage(root, W, H);
  stage.classList.add("kit-mk-background");
  KIT.theme(stage, theme);
  stage.innerHTML = `<div class="mkb-root${content.scheme === "dark" ? " mkb-dark" : ""}"><div class="mkb-card"><div class="mkb-blob mkb-b1"></div><div class="mkb-blob mkb-b2"></div></div></div>`;

  const rootEl = stage.querySelector(".mkb-root");
  const card = stage.querySelector(".mkb-card");
  const blob1 = stage.querySelector(".mkb-b1");
  const blob2 = stage.querySelector(".mkb-b2");

  function placeBlob(el, b) {
    const dd = b.r * 2;
    el.style.width = dd + "px";
    el.style.height = dd + "px";
    el.style.left = (b.x * W - b.r) + "px";
    el.style.top = (b.y * H - b.r) + "px";
    el.style.opacity = String(b.opacity);
  }
  placeBlob(blob1, content.blob1);
  placeBlob(blob2, content.blob2);

  card.style.opacity = String(content.contentOpacity);
  if (content.frostBlur > 0) {
    card.style.backdropFilter = "blur(" + content.frostBlur + "px) saturate(1.4)";
  }

  const tl = SLATE.timeline();

  // 入场：淡入，色块从放大状态收回
  if (content.animationIn) {
    tl.tween(rootEl, { opacity: [0, 1] }, { at: 0, dur: 0.7 * k, ease: "outCubic" });
    tl.tween([blob1, blob2], { scale: [1.14, 1] }, { at: 0, dur: 1.2 * k, ease: "outQuart" });
  }

  // 漂移：正弦缓动来回，往返次数按时长撑满
  if (content.drift) {
    const half = 2.35;
    const start = 0.3 * k;
    const reps = Math.max(0, Math.round((d - start) / half) - 1);
    tl.tween(blob1, { x: 70, y: 42 }, { at: start, dur: half, ease: "inOutSine", yoyo: true, repeat: reps });
    tl.tween(blob2, { x: -84, y: -36 }, { at: start, dur: half, ease: "inOutSine", yoyo: true, repeat: reps });
  }

  // 全屏 → 圆角卡片 → 全屏
  if (content.barDemo) {
    const b = content.bar;
    tl.tween(card, { x: b.x, y: b.y, width: b.width, height: b.height, borderRadius: b.roundness },
      { at: 0.38 * d, dur: 1.1 * k, ease: "inOutQuart" });
    tl.tween(card, { x: 0, y: 0, width: W, height: H, borderRadius: 0 },
      { at: 0.76 * d, dur: 1.0 * k, ease: "inOutQuart" });
  }

  // 退场
  if (content.animationOut) {
    tl.tween(rootEl, { opacity: 0 }, { at: exitAt(0.45), dur: 0.4, ease: "inCubic" });
  }
  tl.set(rootEl, { visibility: "hidden" }, Math.max(0, d - 0.02));

  return tl;
};
