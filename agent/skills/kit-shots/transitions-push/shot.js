/* 改编自 Apache-2.0 许可的开源素材，动画和写法有改动。许可证原文见 /opt/slate/licenses/kit/LICENSE */
(function () {
  KIT.shots = KIT.shots || {};
  KIT.shots["transitions-push"] = function (root, o = {}) {
    const content = Object.assign({
      label: "转场目录",                 // 标题卡小标签
      title: "推移转场",                 // 标题卡主标题
      count: "共 4 种转场",              // 标题卡副标题
      sceneA: { big: "第一幕", tag: "场景 A" }, // 画面 A
      sceneB: { big: "第二幕", tag: "场景 B" }, // 画面 B
      items: [                           // 四种转场说明
        { name: "横向推移", desc: "旧画面整体向左推出，新画面紧随推入" },
        { name: "纵向推移", desc: "旧画面向上推出，新画面自下而上接替" },
        { name: "弹性推移", desc: "带回弹过冲的横向推移，落位更有力量" },
        { name: "挤压", desc: "旧画面横向压缩消失，新画面从右侧展开" }
      ],
      outroLabel: "推移转场",            // 收尾卡小标签
      outroTitle: "4 种转场"             // 收尾卡主标题
    }, o.content);
    const theme = Object.assign({
      "--kit-accent": "#e07a5f",
      "--kit-card": "#0d1b2a",
      "--kit-scene-a": "#1b263b",
      "--kit-scene-a-text": "#778da9",
      "--kit-scene-b": "#e07a5f",
      "--kit-font": "\"Inter\", \"Noto Sans CJK SC\", sans-serif"
    }, o.theme);
    const { k, d, exitAt } = KIT.fit(24, o.dur);

    // 字体
    let link = document.querySelector('link[data-kit-font="inter"]');
    if (!link) {
      link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = "/assets/fonts/lib/inter.css";
      link.dataset.kitFont = "inter";
      document.head.appendChild(link);
    }
    const linkReady = new Promise(res => {
      if (link.sheet) return res();
      link.addEventListener("load", res); link.addEventListener("error", res);
    });
    SLATE.waits = SLATE.waits || [];
    SLATE.waits.push(linkReady.then(() => Promise.all([
      document.fonts.load('900 72px "Inter"'),
      document.fonts.load('700 20px "Inter"'),
      document.fonts.load('400 24px "Inter"')
    ])).catch(() => {}));

    KIT.css("transitions-push", `
.kit-transitions-push{background:#000;overflow:hidden;font-family:var(--kit-font);}
.kit-transitions-push *{margin:0;padding:0;box-sizing:border-box;}
.kit-transitions-push .kp-pair{position:absolute;inset:0;visibility:hidden;}
.kit-transitions-push .kp-scene{position:absolute;left:0;top:0;width:1920px;height:1080px;overflow:hidden;}
.kit-transitions-push .kp-scene1{z-index:1;}
.kit-transitions-push .kp-scene2{z-index:2;opacity:0;visibility:hidden;}
.kit-transitions-push .kp-inner{width:100%;height:100%;display:flex;align-items:center;justify-content:center;flex-direction:column;}
.kit-transitions-push .kp-s1{background:var(--kit-scene-a);transform-origin:left center;}
.kit-transitions-push .kp-s2{background:var(--kit-scene-b);transform-origin:right center;}
.kit-transitions-push .kp-big{font-size:200px;font-weight:900;line-height:1.2;}
.kit-transitions-push .kp-s1 .kp-big{color:rgba(255,255,255,0.08);}
.kit-transitions-push .kp-s2 .kp-big{color:rgba(255,255,255,0.15);}
.kit-transitions-push .kp-tag{font-size:32px;font-weight:700;letter-spacing:0.15em;margin-top:-20px;}
.kit-transitions-push .kp-s1 .kp-tag{color:var(--kit-scene-a-text);}
.kit-transitions-push .kp-s2 .kp-tag{color:#fff;}
.kit-transitions-push .kp-info{position:absolute;left:0;right:0;bottom:240px;z-index:100;background:rgba(0,0,0,0.88);padding:24px 96px;display:flex;align-items:center;gap:40px;opacity:0;}
.kit-transitions-push .kp-num{font-size:14px;font-weight:700;color:var(--kit-accent);letter-spacing:0.1em;}
.kit-transitions-push .kp-name{font-size:20px;font-weight:700;color:#fff;}
.kit-transitions-push .kp-desc{font-size:14px;color:rgba(255,255,255,0.5);}
.kit-transitions-push .kp-card{position:absolute;left:0;top:0;width:1920px;height:1080px;background:var(--kit-card);display:flex;align-items:center;justify-content:center;flex-direction:column;z-index:50;}
.kit-transitions-push .kp-outro{opacity:0;visibility:hidden;}
.kit-transitions-push .kp-label{font-size:14px;font-weight:700;color:var(--kit-accent);letter-spacing:0.2em;text-transform:uppercase;opacity:0;}
.kit-transitions-push .kp-title{font-size:72px;font-weight:900;color:#fff;margin-top:16px;opacity:0;}
.kit-transitions-push .kp-count{font-size:24px;font-weight:400;color:rgba(255,255,255,0.4);margin-top:12px;opacity:0;}
.kit-transitions-push .kp-otitle{font-size:56px;font-weight:900;color:#fff;margin-top:16px;opacity:0;}
`);

    const stage = KIT.stage(root, 1920, 1080);
    stage.classList.add("kit-transitions-push");
    KIT.theme(stage, theme);

    const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
    const A = content.sceneA || {}, B = content.sceneB || {};
    const items = (content.items || []).slice(0, 4);
    while (items.length < 4) items.push({ name: "", desc: "" });

    const pairHTML = `
      <div class="kp-pair">
        <div class="kp-scene kp-scene1"><div class="kp-inner kp-s1">
          <div class="kp-big">${esc(A.big)}</div><div class="kp-tag">${esc(A.tag)}</div>
        </div></div>
        <div class="kp-scene kp-scene2"><div class="kp-inner kp-s2">
          <div class="kp-big">${esc(B.big)}</div><div class="kp-tag">${esc(B.tag)}</div>
        </div></div>
      </div>`;

    stage.innerHTML = `
      ${pairHTML}${pairHTML}${pairHTML}${pairHTML}
      ${items.map((it, i) => `
        <div class="kp-info">
          <div class="kp-num">${String(i + 1).padStart(2, "0")}</div>
          <div class="kp-name">${esc(it.name)}</div>
          <div class="kp-desc">${esc(it.desc)}</div>
        </div>`).join("")}
      <div class="kp-card kp-intro">
        <div class="kp-label">${esc(content.label)}</div>
        <div class="kp-title">${esc(content.title)}</div>
        <div class="kp-count">${esc(content.count)}</div>
      </div>
      <div class="kp-card kp-outro">
        <div class="kp-label kp-olabel">${esc(content.outroLabel)}</div>
        <div class="kp-otitle">${esc(content.outroTitle)}</div>
      </div>`;

    const q = s => stage.querySelector(s);
    const pairs = Array.from(stage.querySelectorAll(".kp-pair"));
    const infos = Array.from(stage.querySelectorAll(".kp-info"));
    const intro = q(".kp-intro"), outro = q(".kp-outro");
    const introTexts = Array.from(intro.children);

    const tl = SLATE.timeline();
    const S = x => x * k;

    // 标题卡
    tl.tween(introTexts[0], { opacity: 1 }, { at: S(0.3), dur: S(0.4), ease: "outCubic" });
    tl.tween(introTexts[1], { opacity: [0, 1], y: [20, 0] }, { at: S(0.6), dur: S(0.5), ease: "outCubic" });
    tl.tween(introTexts[2], { opacity: [0, 1] }, { at: S(1.0), dur: S(0.4), ease: "outCubic" });
    // 标题文字先于底色淡出，避免与下方画面文字叠在一起
    tl.tween(introTexts, { opacity: 0 }, { at: S(2.4), dur: S(0.2), ease: "inOutCubic" });
    tl.tween(intro, { opacity: 0 }, { at: S(2.4), dur: S(0.4), ease: "inOutCubic" });
    tl.set(intro, { visibility: "hidden" }, S(2.8));

    const seg = [3, 7.5, 12, 16.5].map(S);
    const O = S(21);

    pairs.forEach((p, i) => {
      const sc1 = p.querySelector(".kp-scene1"), sc2 = p.querySelector(".kp-scene2");
      const s1 = p.querySelector(".kp-s1"), s2 = p.querySelector(".kp-s2");
      tl.set(p, { visibility: "visible" }, i === 0 ? S(2.6) : seg[i]);
      tl.set(p, { visibility: "hidden" }, i < 3 ? seg[i + 1] : O + S(0.4));

      const info = infos[i];
      tl.tween(info, { opacity: [0, 1] }, { at: seg[i] + S(0.2), dur: S(0.3), ease: "outQuad" });
      tl.tween(info, { opacity: 0 }, { at: seg[i] + S(4), dur: S(0.2), ease: "outQuad" });

      const T = seg[i] + S(1.5);
      tl.set(sc2, { opacity: 1, visibility: "inherit" }, T);
      if (i === 0) {
        tl.tween(s1, { x: [0, -1920] }, { at: T, dur: S(0.5), ease: "inOutQuart" });
        tl.tween(s2, { x: [1920, 0] }, { at: T, dur: S(0.5), ease: "inOutQuart" });
      } else if (i === 1) {
        tl.tween(s1, { y: [0, -1080] }, { at: T, dur: S(0.5), ease: "inOutQuart" });
        tl.tween(s2, { y: [1080, 0] }, { at: T, dur: S(0.5), ease: "inOutQuart" });
      } else if (i === 2) {
        tl.tween(s1, { x: [0, -1920] }, { at: T, dur: S(0.5), ease: "inQuart" });
        tl.tween(s2, { x: [1920, 30] }, { at: T + S(0.1), dur: S(0.4), ease: "outQuint" });
        tl.tween(s2, { x: [30, -15] }, { at: T + S(0.5), dur: S(0.15), ease: "inOutSine" });
        tl.tween(s2, { x: [-15, 0] }, { at: T + S(0.65), dur: S(0.1), ease: "outSine" });
      } else {
        tl.tween(s1, { scaleX: [1, 0] }, { at: T, dur: S(0.4), ease: "inOutQuart" });
        tl.tween(s2, { scaleX: [0, 1] }, { at: T + S(0.1), dur: S(0.4), ease: "inOutQuart" });
      }
      // 推出画面后隐藏旧画面
      tl.set(sc1, { opacity: 0, visibility: "hidden" }, T + S(0.5));
    });

    // 收尾卡
    tl.set(outro, { visibility: "visible" }, O);
    tl.tween(outro, { opacity: [0, 1] }, { at: O, dur: S(0.4), ease: "inOutCubic" });
    tl.tween(outro.querySelector(".kp-olabel"), { opacity: [0, 1] }, { at: O + S(0.3), dur: S(0.4), ease: "outCubic" });
    tl.tween(outro.querySelector(".kp-otitle"), { opacity: [0, 1], y: [20, 0] }, { at: O + S(0.6), dur: S(0.5), ease: "outCubic" });
    const outAt = Math.max(O + S(1.6), exitAt(0.4));
    if (outAt <= d - 0.2) {
      tl.tween(outro, { opacity: 0 }, { at: outAt, dur: Math.min(0.4, d - outAt), ease: "inOutCubic" });
    }
    return tl;
  };
})();
