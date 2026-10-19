/* 改编自 Apache-2.0 许可的开源素材，动画和写法有改动。许可证原文见 /opt/slate/licenses/kit/LICENSE */
KIT.shots["hw-title"] = function (root, o = {}) {
  const content = Object.assign({
    text: "像星星 一样 闪耀 你本来 就是光", // 标题，空格分隔扫亮的词组
    fontSize: 120,   // 字号
    scheme: "chalk", // chalk 白字 / ink 深色字
    seed: 8          // 下划线与抖动的种子
  }, o.content);
  const theme = Object.assign({
    "--kit-accent": "#ffb020",
    "--kit-font": "\"Caveat\", \"Ma Shan Zheng\", cursive"
  }, o.theme);
  const { k, d, exitAt } = KIT.fit(6, o.dur);

  ["/assets/fonts/lib/caveat.css", "/assets/fonts/lib/ma-shan-zheng.css"].forEach(href => {
    if (!document.querySelector('link[href="' + href + '"]')) {
      const l = document.createElement("link"); l.rel = "stylesheet"; l.href = href; document.head.appendChild(l);
    }
  });

  KIT.css("hw-title", `
.kit-hw-title{font-family:var(--kit-font);}
.kit-hw-title .hw-wrap{position:absolute;left:960px;top:537px;opacity:0;pointer-events:none;}
.kit-hw-title .hw-line{font-weight:700;line-height:1.1;white-space:nowrap;text-shadow:0 2px 18px rgba(0,0,0,0.4);}
.kit-hw-title .hw-line .w{display:inline;}
.kit-hw-title .hw-under{overflow:visible;display:block;}
.kit-hw-title .hw-under path{fill:none;stroke:var(--kit-accent);stroke-width:7;stroke-linecap:round;}
`);

  const stage = KIT.stage(root, 1920, 1080);
  stage.classList.add("kit-hw-title");
  KIT.theme(stage, theme);
  stage.innerHTML = `<div class="hw-wrap"><div class="hw-line"></div><svg class="hw-under" width="10" height="34"><path></path></svg></div>`;

  const wrap = stage.querySelector(".hw-wrap");
  const line = stage.querySelector(".hw-line");
  const svg = stage.querySelector(".hw-under");
  const path = svg.querySelector("path");
  line.style.fontSize = content.fontSize + "px";

  const ink = content.scheme === "ink";
  const RGB = ink ? [38, 36, 31] : [244, 242, 236];
  const A0 = ink ? 0.3 : 0.32;
  const col = f => `rgba(${RGB[0]},${RGB[1]},${RGB[2]},${(A0 + (1 - A0) * f).toFixed(3)})`;

  const words = String(content.text).trim().split(/\s+/);
  const cjk = /[\u3000-\u9fff\uff00-\uffef]/.test(content.text);
  const wordEls = [];
  words.forEach((w, i) => {
    if (i > 0 && !cjk) line.appendChild(document.createTextNode(" "));
    const s = document.createElement("span");
    s.className = "w"; s.textContent = w; s.style.color = col(0);
    line.appendChild(s); wordEls.push(s);
  });

  const seed = content.seed;
  const hash = (n, sd) => { const x = Math.sin(n * 127.1 + (sd || 1) * 311.7) * 43758.5453; return (x - Math.floor(x)) * 2 - 1; };

  let built = false, len = 1;
  function build() {
    if (built) return;
    built = true;
    const uw = Math.max(20, Math.round(line.offsetWidth));
    svg.setAttribute("width", uw);
    svg.setAttribute("viewBox", "0 0 " + uw + " 34");
    const segs = Math.max(6, Math.round(uw / 90));
    let dd = "M 2 " + (16 + hash(0, seed) * 4).toFixed(1);
    for (let i = 1; i <= segs; i++) {
      const x = (uw / segs) * i;
      const y = 16 + hash(i * 5 + 1, seed) * 6;
      const cx = x - uw / segs / 2 + hash(i * 5 + 2, seed) * 10;
      const cy = 16 + (i % 2 ? -1 : 1) * (8 + hash(i * 5 + 3, seed) * 4);
      dd += " Q " + cx.toFixed(1) + " " + cy.toFixed(1) + " " + x.toFixed(1) + " " + y.toFixed(1);
    }
    path.setAttribute("d", dd);
    len = path.getTotalLength() || 1;
    path.style.strokeDasharray = len;
    path.style.strokeDashoffset = len;
  }
  SLATE.waits = SLATE.waits || [];
  SLATE.waits.push(Promise.all([
    document.fonts.load('700 120px "Caveat"'),
    document.fonts.load('400 120px "Ma Shan Zheng"', content.text)
  ]).catch(() => {}).then(() => { built = false; build(); }));

  const tl = SLATE.timeline();
  const outDur = 0.36, outAt = exitAt(0.41);
  tl.tween(wrap, "opacity", { at: 0.1 * k, dur: 0.48 * k, ease: "outCubic" }) ;
  tl.tween(wrap, { opacity: [1, 0] }, { at: outAt, dur: outDur, ease: "inCubic" });
  tl.set(stage, { visibility: "hidden" }, d - 0.02);

  const sw0 = 0.8 * k, sw1 = 3.2 * k, uAt = 3.0 * k, uDur = 0.7 * k;
  const uEase = SLATE.easing("inOutCubic");
  tl.call((p) => {
    build();
    const t = p * d;
    // 逐词扫亮
    const sp = SLATE.clamp((t - sw0) / (sw1 - sw0), 0, 1);
    const kk = sp * wordEls.length;
    for (let i = 0; i < wordEls.length; i++) wordEls[i].style.color = col(SLATE.clamp(kk - i, 0, 1));
    // 下划线
    const up = uEase(SLATE.clamp((t - uAt) / uDur, 0, 1));
    path.style.strokeDashoffset = (len * (1 - up)).toFixed(2);
    // 手绘抖动
    const step = Math.floor((t * 30) / 3);
    const bx = hash(step * 3, seed) * 1.4, by = hash(step * 3 + 1, seed) * 1.4, br = hash(step * 3 + 2, seed) * 0.3;
    wrap.style.transform = `translate(-50%,-50%) translate(${bx.toFixed(2)}px,${by.toFixed(2)}px) rotate(${br.toFixed(3)}deg)`;
  }, { at: 0, dur: d, ease: "linear" });
  return tl;
};
