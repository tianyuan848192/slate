/* 改编自 Apache-2.0 许可的开源素材，动画和写法有改动。许可证原文见 /opt/slate/licenses/kit/LICENSE */
(function () {
  var SCRIPT_SRC = document.currentScript && document.currentScript.src;
  window.KIT = window.KIT || {};
  KIT.shots = KIT.shots || {};

  KIT.shots["weight-wave"] = function (root, o = {}) {
    const content = Object.assign({
      text: "让压力流过每一个字", // 标题，单行
      weightFrom: 400,        // 平时字重
      weightTo: 1000,         // 波峰字重
      crestWidth: 4,          // 波峰半宽（字符数）
      sweepSpeed: 0.5,        // 每秒扫过几遍
      slant: -12,             // 波峰倾斜角（度，负数前倾）
      direction: "ltr"        // ltr / rtl
    }, o.content);
    const theme = Object.assign({
      "--ww-color": "#f5f5f7",
      "--ww-bg": "#0b0b0d",
      "--kit-font": "\"Recursive Wave\", \"Noto Sans CJK SC\", sans-serif"
    }, o.theme);
    const { d } = KIT.fit(6, o.dur);

    // 可变字体（随模板附带）
    SLATE.waits = SLATE.waits || [];
    if (!KIT.__wwFont) {
      const url = SCRIPT_SRC ? new URL("assets/fonts/Recursive-wght-slnt-latin.woff2", SCRIPT_SRC).href : "assets/fonts/Recursive-wght-slnt-latin.woff2";
      const face = new FontFace("Recursive Wave", "url(" + url + ") format(\"woff2\")", { weight: "300 1000", display: "block" });
      document.fonts.add(face);
      KIT.__wwFont = face.load().catch(function () {});
    }
    SLATE.waits.push(KIT.__wwFont);
    SLATE.waits.push(document.fonts.load('400 132px "Noto Sans CJK SC"', "字").catch(function () {}));
    SLATE.waits.push(document.fonts.load('900 132px "Noto Sans CJK SC"', "字").catch(function () {}));

    const num = (v, f, lo, hi) => { let n = Number(v); if (!Number.isFinite(n)) n = f; return Math.min(hi, Math.max(lo, n)); };
    const TEXT = (typeof content.text === "string" && content.text.length) ? content.text : "让压力流过每一个字";
    const W_FROM = num(content.weightFrom, 400, 300, 1000);
    const W_TO = num(content.weightTo, 1000, 300, 1000);
    const CREST = num(content.crestWidth, 4, 1, 24);
    const SPEED = num(content.sweepSpeed, 0.5, 0.05, 3);
    const SLANT = num(content.slant, -12, -15, 0);
    const RTL = content.direction === "rtl";

    KIT.css("weight-wave", `
      .kit-weight-wave{position:relative;overflow:hidden}
      .kit-weight-wave .ww-bg{position:absolute;inset:0;background:var(--ww-bg,#0b0b0d)}
      .kit-weight-wave .ww-stage{position:absolute;inset:0;display:flex;align-items:center;justify-content:center}
      .kit-weight-wave .ww-line{display:block;width:1760px;text-align:center;white-space:pre;
        font-family:var(--kit-font);font-size:132px;line-height:1.15;letter-spacing:0.005em;
        color:var(--ww-color,#f5f5f7);font-weight:400;font-variation-settings:"wght" 400,"slnt" 0}
      .kit-weight-wave .ww-ch{display:inline-block;transform-origin:50% 85%}
    `);

    const stage = KIT.stage(root, 1920, 1080);
    stage.classList.add("kit-weight-wave");
    KIT.theme(stage, theme);
    stage.innerHTML = `<div class="ww-bg"></div><div class="ww-stage"><div class="ww-line"></div></div>`;
    const line = stage.querySelector(".ww-line");

    const chars = Array.from(TEXT);
    const spans = chars.map(ch => {
      const el = document.createElement("span");
      el.className = "ww-ch";
      el.textContent = ch;
      line.appendChild(el);
      return el;
    });
    // 非西文字符没有 slnt 轴，用 skewX 模拟倾斜
    const fake = chars.map(ch => !/[\u0000-\u024F]/.test(ch));
    const N = spans.length;

    // 按最粗状态估算字号，保证扫过时不溢出
    let fitted = false;
    function fit() {
      if (fitted) return; fitted = true;
      const ctx = document.createElement("canvas").getContext("2d");
      const heaviest = Math.min(900, Math.round(Math.max(W_FROM, W_TO) / 100) * 100);
      let fs = 132;
      while (fs > 40) {
        ctx.font = heaviest + " " + fs + 'px "Recursive Wave", "Noto Sans CJK SC", sans-serif';
        if (ctx.measureText(TEXT).width * 1.02 <= 1760) break;
        fs -= 2;
      }
      line.style.fontSize = fs + "px";
    }

    const travel = N - 1 + 2 * CREST;
    function paint(time) {
      fit();
      const pass = time * SPEED;
      const phase = pass - Math.floor(pass);
      let crest = -CREST + phase * travel;
      if (RTL) crest = N - 1 - crest;
      for (let i = 0; i < N; i++) {
        let f = 1 - Math.abs(i - crest) / CREST;
        f = f < 0 ? 0 : f > 1 ? 1 : f;
        const wght = Math.round(W_FROM + (W_TO - W_FROM) * f);
        const slnt = SLANT * f;
        const s = spans[i].style;
        s.fontVariationSettings = '"wght" ' + wght + ', "slnt" ' + slnt.toFixed(2);
        s.fontWeight = String(wght);
        if (fake[i]) s.transform = "skewX(" + slnt.toFixed(2) + "deg)";
      }
    }

    const tl = SLATE.timeline();
    tl.call((p) => paint(p * d), { at: 0, dur: d, ease: "linear" });
    return tl;
  };
})();
