/* 改编自 Apache-2.0 许可的开源素材，动画和写法有改动。许可证原文见 /opt/slate/licenses/kit/LICENSE */
KIT.shots["flowchart"] = function (root, o = {}) {
  const content = Object.assign({
    question: "我该学编程吗？",      // 根节点问题
    branchA: "要学",                  // 左分支
    branchB: "不确定",                // 右分支
    labelA: "要学",                   // 左连线标签
    labelB: "不确定",                 // 右连线标签
    leaf1Prefix: "先学 ",             // 叶子1 前缀
    leaf1Wrong: "Pythom",             // 打错的词
    leaf1Right: "Python",             // 改正后的词
    leaf2: "先试试无代码工具",        // 叶子2
    leaf3: "做一个个人网站",          // 叶子3
    leaf4: "上一门免费入门课",        // 叶子4
    cursorTag: "我",                  // 光标标签
    emoji: "👍"                       // 表情
  }, o.content);
  const theme = Object.assign({
    "--kit-font": "\"Inter\", \"Noto Sans CJK SC\", sans-serif",
    "--kit-ink": "#333333",
    "--kit-bg": "#ffffff",
    "--kit-dot": "#e5e5e5",
    "--kit-yellow": "#e8d44d",
    "--kit-green": "#c2e8a0",
    "--kit-peach": "#f5c5a3",
    "--kit-lavender": "#d4c5f9",
    "--kit-blue": "#a8d8f0",
    "--kit-pink": "#f8b4c8",
    "--kit-accent": "#9747ff",
    "--kit-select": "#0b84f3",
    "--kit-highlight": "#d0e4ff"
  }, o.theme);
  const { k, d, exitAt } = KIT.fit(12, o.dur);

  if (!document.querySelector('link[data-kit-font="inter"]')) {
    const l = document.createElement("link");
    l.rel = "stylesheet"; l.href = "/assets/fonts/lib/inter.css"; l.setAttribute("data-kit-font", "inter");
    document.head.appendChild(l);
  }
  SLATE.waits = SLATE.waits || [];
  SLATE.waits.push(document.fonts.load('500 18px "Inter"'), document.fonts.load('600 14px "Inter"'));

  KIT.css("flowchart", `
.kit-flowchart{background-color:var(--kit-bg);background-image:radial-gradient(var(--kit-dot) 1px,transparent 1px);background-size:20px 20px;overflow:hidden;font-family:var(--kit-font);}
.kit-flowchart *{box-sizing:border-box;margin:0;padding:0;}
.kit-flowchart .fc-canvas{position:absolute;left:0;top:44px;width:1920px;height:1080px;transform:scale(1.2);transform-origin:960px 300px;}
.kit-flowchart .fc-svg{position:absolute;left:0;top:0;z-index:5;}
.kit-flowchart .fc-conn{stroke:var(--kit-ink);stroke-dasharray:1000;stroke-dashoffset:1000;}
.kit-flowchart .fc-node{position:absolute;padding:16px 24px;border-radius:12px;font-size:18px;font-weight:500;color:var(--kit-ink);box-shadow:0 4px 12px rgba(0,0,0,.1);white-space:nowrap;display:flex;flex-direction:column;align-items:center;justify-content:center;z-index:10;}
.kit-flowchart .yellow{background:var(--kit-yellow);} .kit-flowchart .green{background:var(--kit-green);}
.kit-flowchart .peach{background:var(--kit-peach);} .kit-flowchart .lavender{background:var(--kit-lavender);}
.kit-flowchart .blue{background:var(--kit-blue);} .kit-flowchart .pink{background:var(--kit-pink);}
.kit-flowchart .fc-label{position:absolute;font-size:14px;font-weight:600;color:var(--kit-ink);background:#fff;padding:2px 6px;border-radius:4px;opacity:0;z-index:6;white-space:nowrap;}
.kit-flowchart .fc-wrap{position:relative;display:inline-block;}
.kit-flowchart .fc-squiggle{position:absolute;right:0;bottom:-4px;opacity:0;}
.kit-flowchart .fc-hl{background:var(--kit-highlight);}
.kit-flowchart .fc-sel{position:absolute;top:-4px;left:-4px;right:-4px;bottom:-4px;border:2px solid var(--kit-select);border-radius:16px;opacity:0;}
.kit-flowchart .fc-cursor{position:absolute;left:1600px;top:640px;z-index:100;display:flex;align-items:flex-start;opacity:0;visibility:hidden;}
.kit-flowchart .fc-tag{background:var(--kit-accent);color:#fff;padding:2px 8px;border-radius:4px;font-size:12px;font-weight:600;margin-left:4px;margin-top:12px;white-space:nowrap;}
.kit-flowchart .fc-emoji{position:absolute;font-size:32px;left:510px;top:500px;z-index:20;line-height:1;}
.kit-flowchart .fc-fade{position:absolute;left:-200px;top:-200px;width:2400px;height:1500px;background:#fff;opacity:0;z-index:1000;}
`);

  const stage = KIT.stage(root, 1920, 1080);
  stage.classList.add("kit-flowchart");
  KIT.theme(stage, theme);
  const esc = s => String(s).replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
  const path = (dd) => `<path class="fc-conn" d="${dd}" fill="none" stroke-width="4"/>`;
  const sq = "M 0 3 Q 2 0 4 3 T 8 3 T 12 3 T 16 3 T 20 3 T 24 3 T 28 3 T 32 3 T 36 3 T 40 3 T 44 3 T 48 3 T 52 3 T 56 3 T 60 3 T 64 3";
  stage.innerHTML = `
<div class="fc-canvas">
  <svg class="fc-svg" width="1920" height="1080" viewBox="0 0 1920 1080">
    <g class="c1">${path("M 960 130 L 960 200 L 600 200 L 600 270")}${path("M 960 130 L 960 200 L 1320 200 L 1320 270")}</g>
    <g class="c2">${path("M 600 330 L 600 400 L 400 400 L 400 470")}${path("M 600 330 L 600 400 L 800 400 L 800 470")}${path("M 1320 330 L 1320 400 L 1120 400 L 1120 470")}${path("M 1320 330 L 1320 400 L 1520 400 L 1520 470")}</g>
  </svg>
  <div class="fc-label" style="left:780px;top:230px">${esc(content.labelA)}</div>
  <div class="fc-label" style="left:1140px;top:230px">${esc(content.labelB)}</div>
  <div class="fc-node yellow n-root" style="left:960px;top:100px">${esc(content.question)}</div>
  <div class="fc-node green n-l2" style="left:600px;top:300px">${esc(content.branchA)}</div>
  <div class="fc-node peach n-l2" style="left:1320px;top:300px">${esc(content.branchB)}</div>
  <div class="fc-node lavender n-leaf" style="left:400px;top:500px">
    <div class="fc-wrap"><span>${esc(content.leaf1Prefix)}</span><span class="fc-word">${esc(content.leaf1Wrong)}</span>
      <svg class="fc-squiggle" width="64" height="6" viewBox="0 0 64 6"><path d="${sq}" fill="none" stroke="#E53935" stroke-width="2"/></svg></div>
    <div class="fc-sel"></div>
  </div>
  <div class="fc-node blue n-leaf" style="left:800px;top:500px">${esc(content.leaf2)}</div>
  <div class="fc-node pink n-leaf" style="left:1120px;top:500px">${esc(content.leaf3)}</div>
  <div class="fc-node yellow n-leaf" style="left:1520px;top:500px">${esc(content.leaf4)}</div>
  <div class="fc-cursor"><svg width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M5.65376 12.3673H5.46026L5.31717 12.4976L0.500002 16.8829L0.500002 1.19841L11.7841 12.3673H5.65376Z" fill="white" stroke="black"/></svg><div class="fc-tag">${esc(content.cursorTag)}</div></div>
  <div class="fc-emoji">${esc(content.emoji)}</div>
  <div class="fc-fade"></div>
</div>`;

  const q = s => stage.querySelector(s), qa = s => Array.from(stage.querySelectorAll(s));
  const root1 = q(".n-root"), l2 = qa(".n-l2"), leaves = qa(".n-leaf");
  const labels = qa(".fc-label"), cursor = q(".fc-cursor"), emoji = q(".fc-emoji");
  const squiggle = q(".fc-squiggle"), sel = q(".fc-sel"), word = q(".fc-word"), fade = q(".fc-fade");
  const T = s => s * k;

  const tl = SLATE.timeline();
  tl.set([root1, ...l2, ...leaves, emoji], { xPercent: -50, yPercent: -50, scale: 0 }, 0);
  tl.set(labels, { xPercent: -50, yPercent: -50 }, 0);

  // 根节点
  tl.tween(root1, { scale: [0, 1] }, { at: 0, dur: T(0.4), ease: "outCubic" });
  // 第一层连线、标签、分支节点（hold1 = 1.0）
  tl.tween(qa(".c1 .fc-conn"), { strokeDashoffset: [1000, 0] }, { at: T(1.0), dur: T(0.5), ease: "linear" });
  tl.tween(labels, { opacity: [0, 1] }, { at: T(1.25), dur: T(0.2), ease: "outQuad" });
  tl.tween(l2[0], { scale: [0, 1] }, { at: T(1.4), dur: T(0.4), ease: "outBack(1.7)" });
  tl.tween(l2[1], { scale: [0, 1] }, { at: T(1.6), dur: T(0.4), ease: "outBack(1.7)" });
  // 第二层（hold2 = 2.5）
  tl.tween(qa(".c2 .fc-conn"), { strokeDashoffset: [1000, 0] }, { at: T(2.5), dur: T(0.4), ease: "linear" });
  leaves.forEach((n, i) => tl.tween(n, { scale: [0, 1] }, { at: T(2.8 + i * 0.15), dur: T(0.4), ease: "outBack(1.7)" }));
  tl.tween(squiggle, { opacity: [0, 1] }, { at: T(2.8), dur: T(0.1), ease: "outQuad" });

  // 光标从右侧画面内淡入并滑向第一个叶子（hold3 = 4.45）
  tl.set(cursor, { visibility: "visible" }, T(4.45));
  tl.tween(cursor, { opacity: [0, 1] }, { at: T(4.45), dur: T(0.15), ease: "outQuad" });
  tl.tween(cursor, { x: [0, -1150], y: [0, -100] }, { at: T(4.45), dur: T(1), ease: "inOutQuad" });
  tl.set(sel, { opacity: 1 }, T(5.45));
  tl.tween(cursor, { scale: [1, 0.8] }, { at: T(5.45), dur: T(0.05), repeat: 1, yoyo: true, ease: "outQuad" });
  // 双击（hold4 = 5.85）
  tl.tween(cursor, { scale: [1, 0.8] }, { at: T(5.85), dur: T(0.05), repeat: 3, yoyo: true, ease: "outQuad" });

  // 改字：由 t 直接算出状态
  const hlAt = T(5.95), typeAt = T(6.25), step = T(0.05);
  const right = Array.from(content.leaf1Right);
  const typeEnd = typeAt + right.length * step;
  let last = "";
  tl.call((p, t) => {
    let txt, hl;
    if (t < hlAt) { txt = content.leaf1Wrong; hl = false; }
    else if (t < typeAt) { txt = content.leaf1Wrong; hl = true; }
    else if (t < typeEnd) { txt = right.slice(0, Math.floor((t - typeAt) / step) + 1).join(""); hl = true; }
    else { txt = content.leaf1Right; hl = false; }
    const key = txt + "|" + hl;
    if (key !== last) { last = key; word.textContent = txt; word.classList.toggle("fc-hl", hl); }
  }, { at: 0, dur: d });
  tl.set(squiggle, { opacity: 0 }, typeEnd);

  // 点开别处取消选中（hold6 = typeEnd + 0.5）
  const h6 = typeEnd + T(0.5);
  tl.tween(cursor, { x: -1100, y: -60 }, { at: h6, dur: T(0.3), ease: "outQuad" });
  tl.tween(cursor, { scale: [1, 0.8] }, { at: h6 + T(0.3), dur: T(0.05), repeat: 1, yoyo: true, ease: "outQuad" });
  tl.tween(sel, { opacity: 0 }, { at: h6 + T(0.3), dur: T(0.1), ease: "outQuad" });
  tl.tween(emoji, { scale: [0, 1] }, { at: h6 + T(0.4), dur: T(0.15), ease: "outBack(2)" });

  // 白场淡出（原作 9.6 秒开始，结束后留 1.9 秒白）
  const fadeAt = Math.max(h6 + T(0.55), exitAt(2.4));
  tl.tween(fade, { opacity: [0, 1] }, { at: fadeAt, dur: 0.5, ease: "outQuad" });
  tl.set(fade, { opacity: 1 }, Math.max(fadeAt + 0.5, d));
  return tl;
};
