/* 改编自 Apache-2.0 许可的开源素材，动画和写法有改动。许可证原文见 /opt/slate/licenses/kit/LICENSE */
/** 逐词/逐字上浮：模糊到清晰的错开级联，落位柔和减速后保持静止，可选淡出或上浮退场。参数：at, dur(1.45), split('word'|'char'), cues[], exit('none'|'fade'|'up'), hold, exitAt, exitDur, rise(u), blur(u) */
KIT.motions = KIT.motions || {};
KIT.motions.perWordRise = function (tl, target, o = {}) {
  const els = KIT.els(target);
  const at = o.at ?? 0, dur = o.dur ?? 1.45;
  const k = dur / 1.45;
  const u = SLATE.u;
  const split = o.split === 'char' ? 'char' : 'word';
  const exit = o.exit === 'fade' || o.exit === 'up' ? o.exit : 'none';
  const Y0 = (o.rise ?? 4) * u;
  const B0 = (o.blur ?? 0.7) * u;
  const YOUT = -(o.rise ?? 4) * 0.5625 * u; // 原 -4.5cqh 对 8cqh
  const BOUT = B0 * 0.5;

  // 拆分
  const units = [];
  els.forEach(el => {
    let list = el._kitUnits;
    if (!list) {
      if (el.dataset.kitSplit) {
        list = Array.from(el.querySelectorAll('span'));
      } else {
        list = split === 'char' ? KIT.splitChars(el) : KIT.splitWords(el);
        el.dataset.kitSplit = split;
      }
      el._kitUnits = list;
    }
    list.forEach(s => {
      if (getComputedStyle(s).display === 'inline') s.style.display = 'inline-block';
      s.style.willChange = 'transform, filter, opacity';
      units.push(s);
    });
  });
  const n = units.length;
  if (!n) return tl;

  const IN = 1.45 * k, RISE = 0.74 * k;
  const STAGGER = n > 1 ? 0.62 * k : 0;
  const OUT = exit === 'none' ? 0 : (o.exitDur ?? 0.5 * k);
  const EXIT_STAGGER = n > 1 ? OUT * 0.28 : 0;
  const EXIT_MOVE = Math.max(0.001, OUT - EXIT_STAGGER);

  // 落位缓动：无过冲的减速 + 收尾滑行
  const SPLIT = 0.78, RES = 0.07, SLOPE = ((1 - RES) / SPLIT) * 0.5;
  function landEase(p) {
    if (p <= 0) return 0;
    if (p >= 1) return 1;
    if (p < SPLIT) {
      const x = p / SPLIT, inv = 1 - x;
      return (1 - RES) * (0.5 * (1 - inv * inv * inv) + 0.5 * x);
    }
    const q = (p - SPLIT) / (1 - SPLIT);
    const b = SLOPE * (1 - SPLIT), c = 3 * RES - 2 * b, d = b - 2 * RES;
    return 1 - RES + b * q + c * q * q + d * q * q * q;
  }

  // 落位时刻（相对 at）
  let landings;
  const cues = Array.isArray(o.cues) ? o.cues.filter(v => Number.isFinite(v) && v >= 0) : [];
  if (cues.length) {
    const last = cues[cues.length - 1];
    const gap = cues.length >= 2 ? Math.max(0.05, (last - cues[0]) / (cues.length - 1)) : RISE * 0.4;
    landings = units.map((_, i) => Math.max(0.05, i < cues.length ? cues[i] : last + (i - (cues.length - 1)) * gap));
  } else {
    const step = n > 1 ? STAGGER / (n - 1) : 0;
    landings = units.map((_, i) => i * step + RISE);
  }
  const riseEnd = Math.max(IN, Math.max.apply(null, landings));
  const starts = landings.map(l => Math.max(0, l - RISE));
  const durs = landings.map((l, i) => Math.max(0.08, l - starts[i]));

  let outStart = Infinity;
  if (exit !== 'none') {
    outStart = o.exitAt != null ? o.exitAt - at : riseEnd + (o.hold ?? 1.55 * k);
  }
  const exitEach = n > 1 ? EXIT_STAGGER / (n - 1) : 0;
  const total = exit === 'none' ? riseEnd : outStart + EXIT_STAGGER + EXIT_MOVE;

  tl.call((p) => {
    const lt = p * total;
    for (let i = 0; i < n; i++) {
      const s = units[i];
      const e = lt <= starts[i] ? 0 : landEase((lt - starts[i]) / durs[i]);
      let op = e, y = Y0 * (1 - e), bl = B0 * (1 - e);
      const os = outStart + i * exitEach;
      if (lt > os) {
        const q = SLATE.clamp((lt - os) / EXIT_MOVE, 0, 1);
        const ee = q * q * q;
        op = 1 - ee;
        if (exit === 'up') { y = YOUT * ee; bl = BOUT * ee; }
      }
      s.style.opacity = op.toFixed(4);
      s.style.transform = 'translateY(' + y.toFixed(2) + 'px)';
      s.style.filter = bl > 0.01 ? 'blur(' + bl.toFixed(2) + 'px)' : 'none';
    }
  }, { at, dur: total, ease: 'linear' });

  return tl;
};
