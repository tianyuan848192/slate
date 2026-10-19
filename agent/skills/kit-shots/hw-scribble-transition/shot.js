/* 改编自 Apache-2.0 许可的开源素材，动画和写法有改动。许可证原文见 /opt/slate/licenses/kit/LICENSE */
KIT.shots["hw-scribble-transition"] = function (root, o = {}) {
  const content = Object.assign({
    bands: 7,        // 横向涂鸦条数
    strokeScale: 1,  // 笔触粗细倍数
    seed: 17         // 抖动随机种子
  }, o.content);
  const theme = Object.assign({
    "--kit-accent": "#ffb020" // 暖色马克笔
  }, o.theme);
  const { k, d, exitAt } = KIT.fit(2.2, o.dur);
  KIT.css("hw-scribble-transition", `
    .kit-hw-scribble-transition{overflow:hidden;background:transparent}
    .kit-hw-scribble-transition .st-svg{position:absolute;inset:0;width:100%;height:100%;overflow:visible}
    .kit-hw-scribble-transition .st-svg path{fill:none;stroke:var(--kit-accent);stroke-linecap:round;stroke-linejoin:round}
    .kit-hw-scribble-transition .st-solid{position:absolute;inset:0;background:var(--kit-accent);opacity:0}
  `);
  const stage = KIT.stage(root, 1920, 1080);
  stage.classList.add("kit-hw-scribble-transition");
  KIT.theme(stage, theme);
  stage.innerHTML = `<svg class="st-svg" viewBox="0 0 1920 1080"></svg><div class="st-solid"></div>`;
  const svg = stage.querySelector(".st-svg");
  const solid = stage.querySelector(".st-solid");
  const NS = "http://www.w3.org/2000/svg";
  const W = 1920, H = 1080;
  const hash = (n, s) => { const x = Math.sin(n * 127.1 + (s || 1) * 311.7) * 43758.5453; return (x - Math.floor(x)) * 2 - 1; };

  const B = Math.max(1, Math.round(content.bands));
  const bandH = H / B;
  const paths = [];
  for (let b = 0; b < B; b++) {
    const y0 = b * bandH + bandH / 2;
    const pts = [[-80, y0 + hash(b * 17, content.seed) * 20]];
    const zigs = 7;
    for (let i = 1; i <= zigs; i++) {
      const x = (W + 160) * (i / zigs) - 80;
      const y = y0 + (i % 2 ? -1 : 1) * bandH * 0.32 + hash(b * 17 + i, content.seed) * 16;
      pts.push([x, y]);
    }
    let len = 0;
    for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    len = Math.ceil(len) + 2;
    const p = document.createElementNS(NS, "path");
    p.setAttribute("d", pts.map((q, i) => (i ? "L " : "M ") + q[0].toFixed(1) + " " + q[1].toFixed(1)).join(" "));
    p.setAttribute("stroke-width", Math.ceil(bandH * 0.85 * content.strokeScale));
    p.style.strokeDasharray = len + "px";
    p.style.strokeDashoffset = (b % 2 ? -len : len) + "px";
    svg.appendChild(p);
    paths.push({ p, len });
  }

  const tl = SLATE.timeline();
  tl.set(stage, { visibility: "visible" }, 0);
  // 入场：各条笔触交替方向涂上
  paths.forEach(({ p, len }, i) => {
    tl.tween(p, { strokeDashoffset: [i % 2 ? -len : len, 0] }, { at: 0.04 * i * k, dur: 0.55 * k, ease: "inCubic" });
  });
  // 实色底板兜底，保证完全覆盖
  tl.tween(solid, { opacity: [0, 1] }, { at: 0.8 * k, dur: 0.12 * k, ease: "linear" });

  // 退场：底板撤走，笔触沿另一方向擦掉
  const E = Math.max(0.92 * k, exitAt(0.78));
  tl.tween(solid, { opacity: [1, 0] }, { at: E, dur: 0.15, ease: "linear" });
  paths.forEach(({ p, len }, i) => {
    tl.tween(p, { strokeDashoffset: [0, i % 2 ? len : -len] }, { at: E + 0.035 * i, dur: 0.5, ease: "outCubic" });
  });
  tl.set(stage, { visibility: "hidden" }, Math.min(d, E + 0.75));
  return tl;
};
