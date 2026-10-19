/* 改编自 Apache-2.0 许可的开源素材，动画和写法有改动。许可证原文见 /opt/slate/licenses/kit/LICENSE */
/** 乱码解码显现：文字先显示确定性乱码，再按帧从左到右逐字锁定成原文，同时弧线淡入。参数：at, dur(1.65), each, fps, seed, glyphs, cjkGlyphs, move, hold, exit('none'|'fade'|'up'), exitDur */
(function () {
  window.KIT = window.KIT || {};
  KIT.motions = KIT.motions || {};

  const BASE = 1.65, ARRIVAL = 0.42, TAIL = 0.15, STILL = 0.3;
  const CJK_RE = /[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff]/;

  KIT.motions.scrambleReveal = function (tl, target, o = {}) {
    const els = KIT.els(target);
    const at = o.at ?? 0, dur = o.dur ?? BASE;
    const each = o.each ?? 0.15;
    const fps = o.fps ?? 30;
    const glyphs = o.glyphs ?? "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789#$%&*+?<>";
    const cjk = o.cjkGlyphs ?? "数据码流信号加密解析矩阵节点协议端口序列量子网络核心系统通道指令回路模块终端频段校验缓存";
    const hold = o.hold ?? 0;
    const exit = o.exit ?? "none";
    const exitDur = o.exitDur ?? 0.45;
    const u = SLATE.u;
    const k = dur / BASE;
    const arrival = ARRIVAL * k;
    const reveal = Math.max(0, dur - TAIL * k);
    const lastFrame = Math.max(1, Math.round(reveal * fps));
    const firstLock = Math.min(lastFrame, Math.max(1, Math.round(0.2 * fps * k)));
    const moves = o.move ? KIT.els(o.move) : null;

    els.forEach((el, n) => {
      const start = at + n * each;
      if (el.dataset.kitScrambleText == null) el.dataset.kitScrambleText = el.textContent;
      const text = el.dataset.kitScrambleText;
      const chars = Array.from(text);
      el.style.whiteSpace = "pre";
      el.setAttribute("aria-label", text);

      // 确定性乱码表：初始化时算一次
      let state = ((o.seed ?? 0x27c0ffee) + n * 7919) >>> 0;
      const lockFrames = chars.map((c, i) => {
        if (/\s/.test(c)) return 0;
        const pos = chars.length <= 1 ? 1 : i / (chars.length - 1);
        return Math.round(firstLock + pos * (lastFrame - firstLock));
      });
      const rows = [];
      for (let f = 0; f <= lastFrame; f++) {
        rows.push(chars.map((c, i) => {
          if (/\s/.test(c) || f >= lockFrames[i]) return c;
          state = (Math.imul(1664525, state) + 1013904223) >>> 0;
          const pool = CJK_RE.test(c) ? cjk : glyphs;
          const pa = Array.from(pool);
          let gi = state % pa.length;
          if (pa[gi] === c) gi = (gi + 1) % pa.length;
          return pa[gi];
        }).join(""));
      }
      el.textContent = rows[0];

      const callDur = lastFrame / fps + 1 / fps;
      let shown = -1;
      tl.call((p) => {
        const f = Math.max(0, Math.min(lastFrame, Math.floor(p * callDur * fps + 1e-6)));
        if (f !== shown) { shown = f; el.textContent = rows[f]; }
      }, { at: start, dur: callDur, ease: "linear" });

      // 入场弧线：三个轴分别缓动
      const mv = moves ? (moves[n] || moves[0]) : el;
      if (mv.dataset.kitScrambleMoved) return;
      mv.dataset.kitScrambleMoved = "1";
      if (getComputedStyle(mv).display === "inline") mv.style.display = "inline-block";
      tl.tween(mv, { opacity: [0, 1] }, { at: start, dur: arrival, ease: "outCubic" });
      tl.tween(mv, { x: [-5.4 * u, 0] }, { at: start, dur: arrival, ease: "outQuart" });
      tl.tween(mv, { y: [1.0 * u, 0] }, { at: start, dur: arrival, ease: "inOutSine" });

      // 停留：一次轻微漂移，最后静止
      const holdStart = start + dur;
      const half = Math.max(0, hold - STILL) / 2;
      if (half > 0) {
        tl.tween(mv, { y: -0.22 * u }, { at: holdStart, dur: half, ease: "inOutSine", yoyo: true, repeat: 1 });
      }

      // 退场（可选）
      const outAt = holdStart + hold;
      if (exit === "up") {
        tl.tween(mv, { x: 6.8 * u }, { at: outAt, dur: exitDur, ease: "inCubic" });
        tl.tween(mv, { y: [0, -3.5 * u] }, { at: outAt, dur: exitDur, ease: "inOutSine" });
        tl.tween(mv, { opacity: 0 }, { at: outAt, dur: exitDur, ease: "inCubic" });
      } else if (exit === "fade") {
        tl.tween(mv, { opacity: 0 }, { at: outAt, dur: exitDur, ease: "inCubic" });
      }
    });
    return tl;
  };
})();
