/* 改编自 Apache-2.0 许可的开源素材，动画和写法有改动。许可证原文见 /opt/slate/licenses/kit/LICENSE */
KIT.shots["logo-outro"] = function (root, o = {}) {
  const content = Object.assign({
    tagline: "伟大的作品，从不孤军奋战。", // 品牌标语
    url: "example.com"                    // 网址胶囊里的文字
  }, o.content);
  const theme = Object.assign({
    "--kit-bg": "#0a0a0f",
    "--kit-c1": "#F24E1E",
    "--kit-c2": "#A259FF",
    "--kit-c3": "#FF7262",
    "--kit-c4": "#1ABCFE",
    "--kit-c5": "#0ACF83",
    "--kit-glow": "rgba(162, 89, 255, 0.25)",
    "--kit-text": "#ffffff",
    "--kit-pill-bg": "#1a1a1f",
    "--kit-pill-border": "#2c2c2c",
    "--kit-url": "#666666",
    "--kit-font": "\"Inter\", \"Noto Sans CJK SC\", sans-serif"
  }, o.theme);
  const { k } = KIT.fit(6, o.dur);

  if (!document.querySelector('link[data-kit-font="inter"]')) {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "/assets/fonts/lib/inter.css";
    link.setAttribute("data-kit-font", "inter");
    document.head.appendChild(link);
  }
  SLATE.waits = SLATE.waits || [];
  SLATE.waits.push(document.fonts.load('500 44px "Inter"'), document.fonts.load('400 18px "Inter"'));

  KIT.css("logo-outro", `
.kit-logo-outro{background:var(--kit-bg);overflow:hidden;font-family:var(--kit-font);}
.kit-logo-outro *{box-sizing:border-box;margin:0;padding:0;}
.kit-logo-outro .lo-glow{position:absolute;left:760px;top:300px;width:400px;height:400px;border-radius:50%;
  background:radial-gradient(circle,var(--kit-glow) 0%,rgba(10,10,15,0) 70%);opacity:0;pointer-events:none;z-index:1;}
.kit-logo-outro .lo-logo{position:absolute;left:880px;top:380px;width:160px;height:240px;z-index:2;}
.kit-logo-outro .lo-logo svg{display:block;overflow:visible;}
.kit-logo-outro .lo-piece{transform-box:fill-box;transform-origin:center center;opacity:0;}
.kit-logo-outro .lo-text{position:absolute;top:700px;left:0;width:100%;display:flex;flex-direction:column;align-items:center;z-index:3;}
.kit-logo-outro .lo-tagline{font-size:44px;font-weight:500;color:var(--kit-text);opacity:0;margin-bottom:32px;text-align:center;white-space:nowrap;}
.kit-logo-outro .lo-pill{background:var(--kit-pill-bg);border:1px solid var(--kit-pill-border);border-radius:100px;padding:8px 24px;opacity:0;display:flex;align-items:center;justify-content:center;}
.kit-logo-outro .lo-url{font-size:18px;color:var(--kit-url);letter-spacing:0.5px;}
`);

  const stage = KIT.stage(root, 1920, 1080);
  stage.classList.add("kit-logo-outro");
  KIT.theme(stage, theme);
  stage.innerHTML = `
<div class="lo-glow"></div>
<div class="lo-logo">
  <svg viewBox="0 0 160 240" width="160" height="240">
    <path class="lo-piece" d="M 0 40 C 0 17.9 17.9 0 40 0 L 80 0 L 80 80 L 40 80 C 17.9 80 0 62.1 0 40 Z" style="fill:var(--kit-c1)"/>
    <path class="lo-piece" d="M 80 0 L 120 0 C 142.1 0 160 17.9 160 40 C 160 62.1 142.1 80 120 80 L 80 80 L 80 0 Z" style="fill:var(--kit-c2)"/>
    <path class="lo-piece" d="M 0 120 C 0 97.9 17.9 80 40 80 L 80 80 L 80 160 L 40 160 C 17.9 160 0 142.1 0 120 Z" style="fill:var(--kit-c3)"/>
    <circle class="lo-piece" cx="120" cy="120" r="40" style="fill:var(--kit-c4)"/>
    <path class="lo-piece" d="M 0 200 C 0 177.9 17.9 160 40 160 L 80 160 L 80 200 C 80 222.1 62.1 240 40 240 C 17.9 240 0 222.1 0 200 Z" style="fill:var(--kit-c5)"/>
  </svg>
</div>
<div class="lo-text">
  <div class="lo-tagline"></div>
  <div class="lo-pill"><span class="lo-url"></span></div>
</div>`;
  stage.querySelector(".lo-tagline").textContent = content.tagline;
  stage.querySelector(".lo-url").textContent = content.url;

  const pieces = Array.from(stage.querySelectorAll(".lo-piece"));
  const glow = stage.querySelector(".lo-glow");
  const tagline = stage.querySelector(".lo-tagline");
  const pill = stage.querySelector(".lo-pill");

  const tl = SLATE.timeline();
  const eIn = SLATE.easing("outQuint");
  const eBack = SLATE.easing("outBack(1.7)");
  const eBackIn = SLATE.easing("inOutCubic");
  const clamp01 = v => Math.max(0, Math.min(1, v));
  const expandTime = 1.2;

  // 1. 各块从右侧依次滑入；2. 弹性放大再缩回（逐帧计算，两段平滑衔接）
  const growScale = (t, i) => {
    const p = clamp01((t - (expandTime + i * 0.02) * k) / (0.5 * k));
    return 1 + 0.15 * eBack(p);
  };
  tl.call((p, t) => {
    pieces.forEach((el, i) => {
      const pin = clamp01((t - i * 0.08 * k) / (1.2 * k));
      const ein = eIn(pin);
      const x = 1920 * (1 - ein);
      const op = ein;
      const shrinkAt = (expandTime + 0.3) * k;
      let s;
      if (t < shrinkAt) s = growScale(t, i);
      else {
        const s0 = growScale(shrinkAt, i);
        const q = clamp01((t - shrinkAt) / (0.4 * k));
        s = s0 + (1 - s0) * eBackIn(q);
      }
      el.style.transform = `translateX(${x}px) scale(${s})`;
      el.style.opacity = op;
    });
  }, { at: 0, dur: 6 * k });

  // 3. 光晕绽放后散开
  tl.tween(glow, { opacity: [0, 1], scale: [0.5, 1.2] }, { at: expandTime * k, dur: 0.4 * k, ease: "outCubic" });
  tl.tween(glow, { opacity: 0, scale: 1.8 }, { at: (expandTime + 0.4) * k, dur: 1.2 * k, ease: "outCubic" });

  // 4. 标语与网址胶囊淡入
  const textStart = expandTime + 0.8;
  tl.tween(tagline, { opacity: [0, 1], y: [20, 0] }, { at: textStart * k, dur: 1 * k, ease: "outQuart" });
  tl.tween(pill, { opacity: [0, 1], y: [15, 0] }, { at: (textStart + 0.4) * k, dur: 0.8 * k, ease: "outQuart" });

  return tl;
};
