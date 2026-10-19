/* 改编自 Apache-2.0 许可的开源素材，动画和写法有改动。许可证原文见 /opt/slate/licenses/kit/LICENSE */
KIT.shots["mk-clone-wall-transition"] = function (root, o = {}) {
  const content = Object.assign({
    word: "下一章节",      // 平铺重复的词
    fontSize: 240,        // 平铺文字字号 px
    spreadX: 90,          // 词间距 px
    spreadY: 60,          // 行间距 px
    brickOffset: true,    // 隔行错开半个词
    card: true,           // 是否显示缩小的画面卡片
    cardSrc: "",          // 卡片图片（上一镜静帧），空则用渐变
    driftX: -46           // 停留期间墙面平移距离
  }, o.content);
  const theme = Object.assign({
    "--kit-font": "\"Inter\", \"Noto Sans CJK SC\", sans-serif",
    "--kit-ink": "#1d1d1f",
    "--kit-paper": "#ffffff",
    "--kit-blob-1": "#ff7ac8",
    "--kit-blob-2": "#45d6c8",
    "--kit-radius-card": "40px",
    "--kit-shadow": "0 30px 80px rgba(0, 0, 0, 0.22)"
  }, o.theme);
  const { k, d, exitAt } = KIT.fit(2.4, o.dur);

  if (!document.querySelector('link[data-kit-font="inter"]')) {
    const l = document.createElement("link");
    l.rel = "stylesheet"; l.href = "/assets/fonts/lib/inter.css";
    l.setAttribute("data-kit-font", "inter");
    document.head.appendChild(l);
  }
  SLATE.waits = SLATE.waits || [];
  SLATE.waits.push(document.fonts.load('600 240px "Inter"'), document.fonts.load('600 240px "Noto Sans CJK SC"', content.word));

  KIT.css("mk-clone-wall-transition", `
.kit-mk-clone-wall-transition{overflow:hidden;background:transparent}
.kit-mk-clone-wall-transition .cw-wall{position:absolute;inset:0;background:var(--kit-paper);isolation:isolate}
.kit-mk-clone-wall-transition .cw-tiles{position:absolute;inset:0}
.kit-mk-clone-wall-transition .cw-row{position:absolute;white-space:nowrap;font-family:var(--kit-font);font-weight:600;letter-spacing:-0.02em;color:var(--kit-ink);line-height:1}
.kit-mk-clone-wall-transition .cw-tile{display:inline-block}
.kit-mk-clone-wall-transition .cw-invert{position:absolute;inset:0;background:var(--kit-paper);mix-blend-mode:difference}
.kit-mk-clone-wall-transition .cw-card{position:absolute;top:0;left:0;width:1920px;height:1080px;border-radius:0;overflow:hidden;background:linear-gradient(120deg,#fdfbfd 0%,var(--kit-blob-1) 38%,var(--kit-blob-2) 100%);box-shadow:var(--kit-shadow);transform-origin:50% 50%}
.kit-mk-clone-wall-transition .cw-card img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
`);

  const stage = KIT.stage(root, 1920, 1080);
  stage.classList.add("kit-mk-clone-wall-transition");
  KIT.theme(stage, theme);
  stage.innerHTML = `<div class="cw-wall"><div class="cw-tiles" data-qa="ignore"></div><div class="cw-invert"></div></div><div class="cw-card"></div>`;

  const W = 1920, H = 1080;
  const wall = stage.querySelector(".cw-wall");
  const tilesBox = stage.querySelector(".cw-tiles");
  const invert = stage.querySelector(".cw-invert");
  const card = stage.querySelector(".cw-card");

  // 搭文字墙：按字符估宽（中日韩字约 1em，西文约 0.58em）
  const fs = content.fontSize;
  const word = String(content.word);
  let em = 0;
  for (const ch of word) em += /[\u2e80-\u9fff\uac00-\ud7af\uff00-\uffef]/.test(ch) ? 1 : 0.58;
  const tileW = Math.max(em * fs, fs * 0.6) + content.spreadX;
  const rowH = fs + content.spreadY;
  const rows = Math.ceil(H / rowH) + 1;
  const perRow = Math.ceil(W / tileW) + 3;
  for (let r = 0; r < rows; r++) {
    const row = document.createElement("div");
    row.className = "cw-row";
    row.style.fontSize = fs + "px";
    row.style.top = (r * rowH - fs * 0.35) + "px";
    const off = content.brickOffset && r % 2 === 1 ? -Math.round(tileW / 2) : 0;
    row.style.left = (off - tileW) + "px";
    for (let c = 0; c < perRow + 1; c++) {
      const t = document.createElement("span");
      t.className = "cw-tile";
      t.textContent = word;
      t.style.marginRight = content.spreadX + "px";
      row.appendChild(t);
    }
    tilesBox.appendChild(row);
  }

  if (content.card && content.cardSrc) {
    const img = document.createElement("img");
    img.src = content.cardSrc;
    SLATE.waits.push(img.decode ? img.decode().catch(() => {}) : Promise.resolve());
    card.appendChild(img);
  }
  if (!content.card) card.style.display = "none";

  const tl = SLATE.timeline();
  const E = exitAt(0.5);           // 整墙淡出开始
  const cardOut = Math.min(1.35 * k, E - 0.45);

  if (content.card) {
    // 画面缩成墙上的圆角卡片
    tl.tween(card, { x: [0, 640], y: [0, 330], width: [1920, 640], height: [1080, 420], borderRadius: [0, 40] }, { at: 0.2 * k, dur: 0.75 * k, ease: "inOutQuart" });
    // 卡片收走
    tl.tween(card, { scale: 0.6, opacity: 0 }, { at: cardOut, dur: 0.4 * k, ease: "inCubic" });
    tl.set(card, { visibility: "hidden" }, cardOut + 0.41 * k);
  }

  // 停留期间墙面缓慢平移
  tl.tween(tilesBox, { x: [0, content.driftX] }, { at: 0.3 * k, dur: Math.max(0.3, E + 0.2 - 0.3 * k), ease: "inOutSine" });

  // 反色层横扫进来并保持
  tl.tween(invert, { x: [-W, 0] }, { at: 0.85 * k, dur: 0.65 * k, ease: "inOutQuart" });

  // 反色后的墙淡出，露出切换后的画面
  tl.tween(wall, { opacity: [1, 0] }, { at: E, dur: 0.45, ease: "inOutCubic" });
  tl.set(stage, { visibility: "visible" }, 0);
  tl.set(stage, { visibility: "hidden" }, Math.min(d, E + 0.46));

  return tl;
};
