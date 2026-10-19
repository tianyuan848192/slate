/* 改编自 Apache-2.0 许可的开源素材，动画和写法有改动。许可证原文见 /opt/slate/licenses/kit/LICENSE */
/** 流式吐字：词按实测的不均匀 token 节奏成串出现，每个词先灰后墨（0.27 秒线性上色）。参数：at 开始秒数；dur 整段时长（不填按自然节奏）；tone 'dark-on-light' | 'light-on-dark'；ink / fresh 自定颜色；ramp 每词上色时长。 */
KIT.motions = KIT.motions || {};
KIT.motions.streamingText = function (tl, target, o = {}) {
  const els = KIT.els(target);
  const GAPS = [
    0.167, 0.1, 0.0, 0.367, 0.0, 0.167, 0.133, 0.1, 0.1, 0.133, 0.167, 0.133, 0.0, 0.233, 0.167,
    0.1, 0.0, 0.133, 0.133, 0.1, 0.167, 0.133, 0.1, 0.133, 0.167, 0.1, 0.133, 0.1, 0.133,
  ];
  const TONES = {
    'dark-on-light': { ink: '#141414', fresh: '#767676' },
    'light-on-dark': { ink: '#f3f3f3', fresh: '#5f5f5f' },
  };
  const tone = TONES[o.tone] || null;
  const baseRamp = o.ramp ?? 0.2667;

  // 收集所有词
  const groups = els.map((el) => {
    let words = el.__kitWords;
    if (!words) {
      if (el.dataset.kitSplit) {
        words = Array.from(el.querySelectorAll('span'));
      } else {
        words = KIT.splitWords(el);
        el.dataset.kitSplit = 'words';
      }
      words = words.filter((w) => w.textContent.trim().length > 0);
      el.__kitWords = words;
    }
    const ink = o.ink || (tone ? tone.ink : getComputedStyle(el).color || TONES['dark-on-light'].ink);
    const fresh = o.fresh || (tone ? tone.fresh : TONES['dark-on-light'].fresh);
    return { words, ink, fresh };
  });

  // 自然节奏下的相对时刻
  const times = [];
  let t = 0, i = 0;
  groups.forEach((g) => g.words.forEach(() => {
    if (i > 0) t += GAPS[i % GAPS.length];
    times.push(t);
    i++;
  }));
  const natural = Math.max(0.001, t + baseRamp);
  const at = o.at ?? 0;
  const dur = o.dur ?? natural;
  const k = dur / natural;
  const ramp = baseRamp * k;

  let n = 0;
  groups.forEach((g) => {
    g.words.forEach((w) => {
      w.style.opacity = '0';
      w.style.color = g.fresh;
      const wt = at + times[n++] * k;
      tl.set(w, { opacity: 1 }, wt);
      tl.tween(w, { color: [g.fresh, g.ink] }, { at: wt, dur: ramp, ease: 'linear' });
    });
  });
  return tl;
};
