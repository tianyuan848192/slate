/* 改编自 Apache-2.0 许可的开源素材，动画和写法有改动。许可证原文见 /opt/slate/licenses/kit/LICENSE */
KIT.shots["mk-callout-highlight"] = function (root, o = {}) {
  const content = Object.assign({
    // 要逐词高亮的句子（空格或“/”分词）
    text: "从一开始 我们的目标 就是 让它 真正 好用",
    // 文字块左边缘，null = 水平居中
    x: 1030,
    // 最大宽度
    maxWidth: 700,
    // 字号
    fontSize: 60,
    // 扫亮开始时刻（秒，原设计时间）
    sweepStart: 1.2
  }, o.content);
  const theme = Object.assign({
    "--kit-ink": "#1d1d1f",
    "--kit-ink-faint": "#bcbcc2",
    "--kit-font": "\"Inter\", \"Noto Sans CJK SC\", -apple-system, sans-serif"
  }, o.theme);
  const { k, d, exitAt } = KIT.fit(8, o.dur);

  if (!document.querySelector('link[data-kit-font="inter"]')) {
    const l = document.createElement("link");
    l.rel = "stylesheet"; l.href = "/assets/fonts/lib/inter.css"; l.dataset.kitFont = "inter";
    document.head.appendChild(l);
  }
  SLATE.waits = SLATE.waits || [];
  SLATE.waits.push(document.fonts.load('500 60px "Inter"').catch(() => {}));
  SLATE.waits.push(document.fonts.load('500 60px "Noto Sans CJK SC"', "中文").catch(() => {}));

  KIT.css("mk-callout-highlight", `
.kit-mk-callout-highlight{position:relative;overflow:hidden;background:transparent}
.kit-mk-callout-highlight .ch-wrap{position:absolute;top:50%;transform:translateY(-50%)}
.kit-mk-callout-highlight .ch-box{font-family:var(--kit-font);font-weight:500;letter-spacing:-0.015em;line-height:1.3;text-align:left;opacity:0}
.kit-mk-callout-highlight .ch-word{display:inline;color:var(--kit-ink-faint)}
`);

  const stage = KIT.stage(root, 1920, 1080);
  stage.classList.add("kit-mk-callout-highlight");
  KIT.theme(stage, theme);
  stage.innerHTML = `<div class="ch-wrap"><div class="ch-box"></div></div>`;
  const wrap = stage.querySelector(".ch-wrap");
  const box = stage.querySelector(".ch-box");
  box.style.fontSize = content.fontSize + "px";
  box.style.maxWidth = content.maxWidth + "px";
  wrap.style.width = content.maxWidth + "px";
  if (content.x === null || content.x === undefined) {
    wrap.style.left = "50%";
    wrap.style.transform = "translate(-50%,-50%)";
    wrap.style.width = "max-content";
  } else {
    wrap.style.left = content.x + "px";
  }

  let words = [];
  const text = String(content.text);
  if (/[\s\/]/.test(text.trim())) {
    const parts = text.split(/[\s\/]+/).filter(Boolean);
    const latin = /[A-Za-z0-9]/;
    parts.forEach((w, i) => {
      if (i > 0 && latin.test(parts[i - 1].slice(-1)) && latin.test(w[0])) box.appendChild(document.createTextNode(" "));
      const s = document.createElement("span");
      s.className = "ch-word";
      s.textContent = w;
      box.appendChild(s);
      words.push(s);
    });
  } else {
    box.textContent = text;
    words = KIT.splitWords(box);
    words.forEach(s => s.classList.add("ch-word"));
  }

  const n = words.length;
  const paint = p => {
    const kk = p * n;
    for (let i = 0; i < n; i++) {
      const f = SLATE.clamp(kk - i, 0, 1);
      words[i].style.color = `color-mix(in srgb, var(--kit-ink) ${(f * 100).toFixed(2)}%, var(--kit-ink-faint))`;
    }
  };
  paint(0);

  const tl = SLATE.timeline();
  // 入场：淡入上浮
  tl.tween(box, { opacity: [0, 1], y: [24, 0] }, { at: 0.3 * k, dur: 0.7 * k, ease: "outQuart" });
  // 扫亮：线性推进
  const exitStart = exitAt(0.5);
  const s0 = content.sweepStart * k;
  const s1 = Math.max(s0 + 0.5, exitStart - 1.3 * k);
  tl.call(p => paint(p), { at: s0, dur: s1 - s0, ease: "linear" });
  // 退场
  tl.tween(box, { opacity: 0, y: -16 }, { at: exitStart, dur: 0.4 * k, ease: "inCubic" });
  tl.set(stage, { visibility: "hidden" }, Math.max(exitStart + 0.4 * k, d - 0.02));
  return tl;
};
