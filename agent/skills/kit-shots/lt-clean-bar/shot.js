/* 改编自 Apache-2.0 许可的开源素材，动画和写法有改动。许可证原文见 /opt/slate/licenses/kit/LICENSE */
KIT.shots["lt-clean-bar"] = function (root, o = {}) {
  const content = Object.assign({
    name: "陈雅文 博士",          // 姓名
    role: "主持人 · 神经科学家"     // 身份 / 头衔
  }, o.content);
  const theme = Object.assign({
    "--kit-accent": "#ff5a36",
    "--kit-card": "#ffffff",
    "--kit-name": "#0f1115",
    "--kit-role": "#5a6170",
    "--kit-font": "\"Outfit\", \"Noto Sans CJK SC\", sans-serif"
  }, o.theme);
  const { k, d, exitAt } = KIT.fit(4.8, o.dur);

  if (!document.querySelector('link[data-kit-font="outfit"]')) {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "/assets/fonts/lib/outfit.css";
    link.setAttribute("data-kit-font", "outfit");
    document.head.appendChild(link);
  }
  SLATE.waits = SLATE.waits || [];
  SLATE.waits.push(document.fonts.load('700 52px "Outfit"'), document.fonts.load('400 27px "Outfit"'));

  KIT.css("lt-clean-bar", `
    .kit-lt-clean-bar, .kit-lt-clean-bar * { box-sizing: border-box; margin: 0; padding: 0; }
    .kit-lt-clean-bar { font-family: var(--kit-font); }
    .kit-lt-clean-bar .lt {
      position: absolute; left: 120px; bottom: 250px;
      display: flex; align-items: stretch;
      border-radius: 16px; overflow: hidden;
      box-shadow: 0 14px 44px rgba(15,17,21,0.18);
      clip-path: inset(0 100% 0 0);
    }
    .kit-lt-clean-bar .lt-tab { width: 12px; background: var(--kit-accent); flex-shrink: 0; transform-origin: 50% 0%; }
    .kit-lt-clean-bar .lt-body {
      background: var(--kit-card); padding: 22px 40px 24px 30px;
      display: flex; flex-direction: column; gap: 7px;
    }
    .kit-lt-clean-bar .lt-name {
      font-size: 52px; font-weight: 700; color: var(--kit-name);
      line-height: 1.06; letter-spacing: -0.015em; white-space: nowrap; opacity: 0;
    }
    .kit-lt-clean-bar .lt-role {
      font-size: 27px; font-weight: 400; color: var(--kit-role);
      line-height: 1.2; letter-spacing: 0.01em; white-space: nowrap; opacity: 0;
    }
  `);

  const stage = KIT.stage(root, 1920, 1080);
  stage.classList.add("kit-lt-clean-bar");
  KIT.theme(stage, theme);
  stage.innerHTML = `
    <div class="lt">
      <div class="lt-tab"></div>
      <div class="lt-body">
        <div class="lt-name"></div>
        <div class="lt-role"></div>
      </div>
    </div>`;
  const card = stage.querySelector(".lt");
  const tab = stage.querySelector(".lt-tab");
  const nameEl = stage.querySelector(".lt-name");
  const role = stage.querySelector(".lt-role");
  nameEl.textContent = content.name;
  role.textContent = content.role;

  const tl = SLATE.timeline();
  // 卡片从左擦入，竖条向下长出，文字错开上浮
  tl.tween(card, { clipPath: ["inset(0 100% 0 0)", "inset(0 0% 0 0)"] }, { at: 0.1 * k, dur: 0.55 * k, ease: "outQuart" });
  tl.tween(tab, { scaleY: [0, 1] }, { at: 0.28 * k, dur: 0.45 * k, ease: "outCubic" });
  tl.tween(nameEl, { y: [22, 0], opacity: [0, 1] }, { at: 0.34 * k, dur: 0.5 * k, ease: "outQuart" });
  tl.tween(role, { y: [22, 0], opacity: [0, 1] }, { at: 0.44 * k, dur: 0.5 * k, ease: "outQuart" });

  // 退场：下沉淡出，然后隐藏
  const ex = exitAt(0.5);
  tl.tween(card, { y: [0, 18], opacity: [1, 0] }, { at: ex, dur: 0.35, ease: "inCubic" });
  tl.set(card, { visibility: "hidden" }, Math.min(ex + 0.45, d));
  return tl;
};
