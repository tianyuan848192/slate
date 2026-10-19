/* 改编自 Apache-2.0 许可的开源素材，动画和写法有改动。许可证原文见 /opt/slate/licenses/kit/LICENSE */
KIT.shots["split-flap-board"] = function (root, o = {}) {
  const content = Object.assign({
    text: "CA1835 正在登机",   // 显示屏文字（按格居中）
    cells: 12,                 // 格数 1~24
    alphabet: " ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.,'", // 字牌鼓顺序
    filler: "北京上海广州深圳成都杭州西安重庆南京武汉天津长沙厦门昆明青岛大连航班出发到达延误取消候机安检登机口", // 中文翻动时经过的字池
    flipDuration: 0.09,        // 每翻一张牌的秒数
    stagger: 0.05              // 相邻格的开始间隔
  }, o.content);
  const theme = Object.assign({
    "--kit-font": "\"JetBrains Mono\", \"Noto Sans CJK SC\", ui-monospace, monospace",
    "--sf-ink": "#f4efe2",
    "--sf-bg-a": "#23242a",
    "--sf-bg-b": "#121317",
    "--sf-bg-c": "#0a0a0c",
    "--sf-face-a": "#26272c",
    "--sf-face-b": "#1a1b1f"
  }, o.theme);
  const { k, d } = KIT.fit(3.5, o.dur);

  if (!document.querySelector('link[data-kit-font="jetbrains-mono"]')) {
    const l = document.createElement("link");
    l.rel = "stylesheet"; l.href = "/assets/fonts/lib/jetbrains-mono.css";
    l.setAttribute("data-kit-font", "jetbrains-mono");
    document.head.appendChild(l);
    SLATE.waits = SLATE.waits || [];
    SLATE.waits.push(new Promise(r => { l.onload = r; l.onerror = r; }).then(() => Promise.all([
      document.fonts.load('700 100px "JetBrains Mono"'),
      document.fonts.load('700 100px "Noto Sans CJK SC"', "登机")
    ])).catch(() => {}));
  }

  KIT.css("split-flap-board", `
    .kit-split-flap-board, .kit-split-flap-board * { box-sizing: border-box; margin: 0; padding: 0; }
    .kit-split-flap-board .sf-bg { position:absolute; inset:0;
      background: radial-gradient(120% 90% at 50% 42%, var(--sf-bg-a) 0%, var(--sf-bg-b) 62%, var(--sf-bg-c) 100%), var(--sf-bg-c); }
    .kit-split-flap-board .sf-board { position:absolute; inset:0; display:flex; align-items:center; justify-content:center; }
    .kit-split-flap-board .sf-cell { position:relative; flex:0 0 auto; perspective:900px; border-radius:9px; background:#0c0c0e;
      box-shadow: 0 18px 34px rgba(0,0,0,0.55), 0 0 0 1px rgba(255,255,255,0.05); }
    .kit-split-flap-board .sf-face { position:absolute; left:0; width:100%; height:50%; overflow:hidden;
      background: linear-gradient(180deg, var(--sf-face-a) 0%, var(--sf-face-b) 100%); }
    .kit-split-flap-board .sf-top, .kit-split-flap-board .sf-leaf-a { top:0; border-radius:9px 9px 0 0; }
    .kit-split-flap-board .sf-bot, .kit-split-flap-board .sf-leaf-b { top:50%; border-radius:0 0 9px 9px;
      background: linear-gradient(180deg, #191a1e 0%, #232429 100%); }
    .kit-split-flap-board .sf-leaf-a { transform-origin:50% 100%; z-index:3; backface-visibility:hidden; opacity:0; }
    .kit-split-flap-board .sf-leaf-b { transform-origin:50% 0%; z-index:3; backface-visibility:hidden; opacity:0; }
    .kit-split-flap-board .sf-glyph { position:absolute; left:0; width:100%; display:block; text-align:center;
      font-family: var(--kit-font); font-weight:700; color: var(--sf-ink); white-space:pre; }
    .kit-split-flap-board .sf-seam { position:absolute; left:0; top:50%; width:100%; height:3px; margin-top:-1.5px; background:#050506; z-index:4; }
  `);

  const stage = KIT.stage(root, 1920, 1080);
  stage.classList.add("kit-split-flap-board");
  KIT.theme(stage, theme);
  stage.innerHTML = `<div class="sf-bg"></div><div class="sf-board"></div>`;
  const board = stage.querySelector(".sf-board");

  const DEF = " ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.,'";
  let alphabet = String(content.alphabet || DEF);
  if (alphabet.length < 2) alphabet = DEF;
  const alpha = Array.from(alphabet);
  const filler = Array.from(String(content.filler || "北京上海广州深圳"));
  const flipDur = SLATE.clamp(+content.flipDuration || 0.09, 0.03, 1.2) * k;
  const stagger = SLATE.clamp(+content.stagger || 0, 0, 0.5) * k;
  const cellCount = Math.round(SLATE.clamp(+content.cells || 12, 1, 24));
  const chars = Array.from(String(content.text == null ? "" : content.text).toUpperCase()).slice(0, cellCount);
  const lead = Math.floor((cellCount - chars.length) / 2);
  const rng = SLATE.rng(1835);

  const GAP = 10;
  const cw = Math.min(130, Math.floor((1920 - 240 - (cellCount - 1) * GAP) / cellCount));
  const chh = Math.round(cw * 1.45);
  board.style.gap = GAP + "px";

  // 只有上半牌作为可读文字；下半牌和翻动叶片是同一字的另一半，标记为装饰
  function makeFace(cls, glyphTop, deco) {
    const face = document.createElement("div");
    face.className = "sf-face " + cls;
    if (deco) face.setAttribute("data-qa", "ignore");
    const g = document.createElement("span");
    g.className = "sf-glyph";
    g.style.height = chh + "px"; g.style.lineHeight = chh + "px";
    g.style.fontSize = Math.round(cw * 0.78) + "px";
    g.style.top = glyphTop + "px";
    face.appendChild(g);
    return face;
  }

  const cells = [];
  for (let c = 0; c < cellCount; c++) {
    const ch = c >= lead && c < lead + chars.length ? chars[c - lead] : alpha[0];
    let drum, steps;
    const gi = alpha.indexOf(ch);
    if (gi >= 0) { drum = alpha; steps = gi; }
    else {
      // 不在字牌鼓里的字符：固定随机的一段字牌，再落到目标字
      const n = 14 + Math.floor(rng() * 15);
      drum = [alpha[0]];
      for (let j = 0; j < n; j++) drum.push(filler[Math.floor(rng() * filler.length)]);
      drum.push(ch);
      steps = drum.length - 1;
    }
    const cell = document.createElement("div");
    cell.className = "sf-cell";
    cell.setAttribute("data-layout-allow-overlap", "");
    cell.setAttribute("data-layout-allow-occlusion", "");
    cell.setAttribute("data-layout-allow-overflow", "");
    cell.style.width = cw + "px"; cell.style.height = chh + "px";
    const top = makeFace("sf-top", 0, false);
    const bot = makeFace("sf-bot", -Math.round(chh / 2), true);
    const leafA = makeFace("sf-leaf-a", 0, true);
    const leafB = makeFace("sf-leaf-b", -Math.round(chh / 2), true);
    const seam = document.createElement("div");
    seam.className = "sf-seam";
    cell.append(top, bot, leafA, leafB, seam);
    board.appendChild(cell);
    cells.push({ drum, steps, top: top.firstChild, bot: bot.firstChild, leafA, leafB, glyphA: leafA.firstChild, glyphB: leafB.firstChild });
  }

  const DEG = Math.PI / 180;
  function clearLeaf(leaf, g) { leaf.style.opacity = "0"; leaf.style.transform = ""; leaf.style.filter = ""; g.textContent = ""; }
  function showLeaf(leaf, g, ch, angle, shade) {
    g.textContent = ch; leaf.style.opacity = "1";
    leaf.style.transform = "rotateX(" + angle.toFixed(2) + "deg)";
    leaf.style.filter = "brightness(" + shade + ")";
  }
  function paint(t) {
    for (let i = 0; i < cells.length; i++) {
      const cell = cells[i];
      const tl0 = t - i * stagger;
      const raw = tl0 <= 0 ? 0 : tl0 / flipDur;
      let count = Math.floor(raw), p = raw - count;
      if (count >= cell.steps) { count = cell.steps; p = 0; }
      const outgoing = cell.drum[count];
      const incoming = cell.drum[Math.min(count + 1, cell.drum.length - 1)];
      const flipping = count < cell.steps && p > 0;
      if (!flipping) {
        cell.top.textContent = outgoing; cell.bot.textContent = outgoing;
        clearLeaf(cell.leafA, cell.glyphA); clearLeaf(cell.leafB, cell.glyphB);
        continue;
      }
      cell.top.textContent = incoming; cell.bot.textContent = outgoing;
      const theta = 180 * p * p;
      const shade = (1 - 0.5 * Math.sin(theta * DEG)).toFixed(3);
      if (theta < 90) { showLeaf(cell.leafA, cell.glyphA, outgoing, -theta, shade); clearLeaf(cell.leafB, cell.glyphB); }
      else { clearLeaf(cell.leafA, cell.glyphA); showLeaf(cell.leafB, cell.glyphB, incoming, 180 - theta, shade); }
    }
  }
  paint(0);

  const tl = SLATE.timeline();
  tl.call(p => paint(p * d), { at: 0, dur: d, ease: "linear" });
  return tl;
};
