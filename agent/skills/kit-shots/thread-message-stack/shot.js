/* 改编自 Apache-2.0 许可的开源素材，动画和写法有改动。许可证原文见 /opt/slate/licenses/kit/LICENSE */
KIT.shots["thread-message-stack"] = function (root, o = {}) {
  const content = Object.assign({
    // 消息列表：incoming 在左（收到），outgoing 在右（发出）；sender 可选
    messages: [
      { side: "incoming", text: "等等，这也太离谱了吧", sender: "北极光客服" },
      { side: "outgoing", text: "能帮我修好吗？" },
      { side: "incoming", text: "早就在弄了" },
      { side: "outgoing", text: "你简直神了" },
      { side: "incoming", text: "这回他得请你吃顿大餐" },
      { side: "outgoing", text: "已经订好位子了" }
    ],
    // 相邻消息间隔（秒）
    stagger: 0.86,
    // 最后一条之后的停留（秒）
    hold: 1
  }, o.content);
  const theme = Object.assign({
    "--kit-out-fill": "#2d89e1",
    "--kit-out-ink": "#ffffff",
    "--kit-in-fill": "rgba(240, 240, 245, 0.82)",
    "--kit-in-ink": "#101216",
    "--kit-bg": "#2e241a",
    "--kit-font": "\"Inter\", \"Noto Sans CJK SC\", sans-serif"
  }, o.theme);
  const { k, d } = KIT.fit(8, o.dur);

  if (!document.querySelector('link[data-kit-font="inter"]')) {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "/assets/fonts/lib/inter.css";
    link.setAttribute("data-kit-font", "inter");
    document.head.appendChild(link);
  }
  SLATE.waits = SLATE.waits || [];
  SLATE.waits.push(document.fonts.load('500 42px "Inter"').catch(() => {}));
  SLATE.waits.push(document.fonts.load('700 24px "Inter"').catch(() => {}));

  KIT.css("thread-message-stack", `
.kit-thread-message-stack, .kit-thread-message-stack * { box-sizing: border-box; }
.kit-thread-message-stack { overflow: hidden; isolation: isolate; background: var(--kit-bg); color: #fff; font-family: var(--kit-font); }
.kit-thread-message-stack .tms-roll, .kit-thread-message-stack .tms-scrim, .kit-thread-message-stack .tms-view { position: absolute; inset: 0; }
.kit-thread-message-stack .tms-roll { overflow: hidden; background:
  radial-gradient(circle at 18% 20%, #f0d3a6 0, transparent 31%),
  radial-gradient(circle at 75% 18%, #e8a86a 0, transparent 34%),
  radial-gradient(circle at 62% 74%, #2e6a8c 0, transparent 32%),
  radial-gradient(circle at 18% 82%, #6b4a7a 0, transparent 35%), var(--kit-bg); }
.kit-thread-message-stack .tms-scrim { background:
  linear-gradient(to bottom, transparent 0, rgba(0,0,0,0.18) 42%, rgba(0,0,0,0.38) 100%),
  linear-gradient(to right, rgba(0,0,0,0.32), rgba(0,0,0,0) 78%); }
.kit-thread-message-stack .tms-view { overflow: hidden;
  -webkit-mask-image: linear-gradient(to bottom, transparent 5%, #000 24%, #000 100%);
  mask-image: linear-gradient(to bottom, transparent 5%, #000 24%, #000 100%); }
.kit-thread-message-stack .tms-column { position: absolute; inset: 0; }
.kit-thread-message-stack .tms-row { position: absolute; right: 6%; bottom: 23%; left: 6%; display: flex; flex-direction: column; opacity: 0; }
.kit-thread-message-stack .tms-row[data-side="incoming"] { align-items: flex-start; }
.kit-thread-message-stack .tms-row[data-side="outgoing"] { align-items: flex-end; }
.kit-thread-message-stack .tms-sender { min-height: 30px; padding: 0 18px 8px; color: #fff; font-size: 24px; font-weight: 700; line-height: 1; text-shadow: 0 3px 12px rgba(0,0,0,0.72); }
.kit-thread-message-stack .tms-bubble { max-width: min(72%, 920px); padding: 24px 38px; border-radius: 42px; font-size: 42px; font-weight: 500; letter-spacing: -0.015em; line-height: 1.3; overflow-wrap: anywhere; white-space: pre-wrap; }
.kit-thread-message-stack .tms-row[data-side="incoming"] .tms-bubble { color: var(--kit-in-ink);
  background: linear-gradient(180deg, rgba(255,255,255,0.14), rgba(0,0,0,0.05)), var(--kit-in-fill);
  box-shadow: 0 12px 34px rgba(0,0,0,0.3); }
.kit-thread-message-stack .tms-row[data-side="outgoing"] .tms-bubble { color: var(--kit-out-ink);
  background: linear-gradient(180deg, rgba(255,255,255,0.2), rgba(0,0,0,0.17)), var(--kit-out-fill);
  box-shadow: 0 12px 38px rgba(0,0,0,0.38); }
`);

  const stage = KIT.stage(root, 1920, 1080);
  stage.classList.add("kit-thread-message-stack");
  KIT.theme(stage, theme);
  stage.innerHTML = `<div class="tms-roll"></div><div class="tms-scrim"></div><div class="tms-view"><div class="tms-column"></div></div>`;
  const roll = stage.querySelector(".tms-roll");
  const column = stage.querySelector(".tms-column");

  const messages = content.messages || [];
  const rows = messages.map((m) => {
    const row = document.createElement("div");
    row.className = "tms-row";
    row.dataset.side = m.side === "outgoing" ? "outgoing" : "incoming";
    if (m.sender !== undefined && m.sender !== null) {
      const s = document.createElement("div");
      s.className = "tms-sender";
      s.textContent = m.sender;
      row.appendChild(s);
    }
    const b = document.createElement("div");
    b.className = "tms-bubble";
    b.textContent = m.text;
    row.appendChild(b);
    column.appendChild(row);
    return row;
  });

  const rawH = rows.map((r) => r.offsetHeight || 118);
  const heights = rawH.map((h) => Math.max(118, h) + 22);

  const available = Math.max(0.2, 8 - Math.max(0, Number(content.hold || 0)) - 0.35);
  const req = Math.max(0, Number(content.stagger == null ? 0.72 : content.stagger));
  const stagger = rows.length <= 1 ? 0 : Math.min(req, available / rows.length);
  const start = 0.25;
  const rowBottom = 1080 * 0.77;
  // 顶部渐隐遮罩区（约 24% 以上）里的旧消息直接淡出，避免越出安全边距
  const fadeTop = 1080 * 0.2;

  const tl = SLATE.timeline();
  tl.tween(roll, { x: [0, -54], y: [0, -22], scale: [1.12, 1.18] }, { at: 0, dur: d, ease: "inOutSine" });

  const faded = rows.map(() => false);
  rows.forEach((row, index) => {
    const at = (start + index * stagger) * k;
    const dir = row.dataset.side === "incoming" ? -1 : 1;
    row.style.transformOrigin = dir < 0 ? "0% 100%" : "100% 100%";
    tl.tween(row, { x: [dir * 34, 0], y: [0, 0], scale: [0.94, 1], opacity: [0, 1] }, { at, dur: 0.28, ease: "outBack(1.45)" });
    let offset = 0;
    for (let p = index - 1; p >= 0; p--) {
      offset += heights[p + 1];
      tl.tween(rows[p], { y: -offset }, { at, dur: 0.24, ease: "outQuart" });
      const top = rowBottom - rawH[p] - offset;
      if (!faded[p] && top < fadeTop) {
        faded[p] = true;
        tl.tween(rows[p], { opacity: 0 }, { at, dur: 0.16, ease: "outQuart" });
        tl.set(rows[p], { visibility: "hidden" }, at + 0.16);
      }
    }
  });
  tl.set(stage, { opacity: 1 }, d);
  return tl;
};
