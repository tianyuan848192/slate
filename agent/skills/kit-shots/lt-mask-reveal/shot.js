/* 改编自 Apache-2.0 许可的开源素材，动画和写法有改动。许可证原文见 /opt/slate/licenses/kit/LICENSE */
KIT.shots["lt-mask-reveal"] = function (root, o = {}) {
  const content = Object.assign({
    name: "陈雅文 博士",          // 人物姓名
    role: "主持人 · 神经科学家"     // 身份说明
  }, o.content);
  const theme = Object.assign({
    "--kit-accent": "#ffd23f",
    "--kit-name-color": "#ffffff",
    "--kit-role-color": "#e7eaf0",
    "--kit-font": "\"Outfit\", \"Noto Sans CJK SC\", sans-serif"
  }, o.theme);
  const { k, exitAt } = KIT.fit(4.8, o.dur);

  if (!document.querySelector('link[data-kit-font="outfit"]')) {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "/assets/fonts/lib/outfit.css";
    link.setAttribute("data-kit-font", "outfit");
    document.head.appendChild(link);
  }
  SLATE.waits = SLATE.waits || [];
  SLATE.waits.push(
    document.fonts.load('900 72px "Outfit"').catch(() => {}),
    document.fonts.load('500 28px "Outfit"').catch(() => {}),
    document.fonts.load('900 72px "Noto Sans CJK SC"', "陈").catch(() => {})
  );

  KIT.css("lt-mask-reveal", `
    .kit-lt-mask-reveal { font-family: var(--kit-font); }
    .kit-lt-mask-reveal .lt {
      position: absolute; left: 130px; bottom: 250px;
      display: flex; flex-direction: column; align-items: flex-start; gap: 14px;
    }
    .kit-lt-mask-reveal .lt-namewrap { position: relative; overflow: hidden; padding: 2px 0; }
    .kit-lt-mask-reveal .lt-name {
      font-size: 72px; font-weight: 900; color: var(--kit-name-color);
      line-height: 1.08; letter-spacing: -0.01em; white-space: nowrap;
      text-shadow: 0 2px 22px rgba(0,0,0,0.45);
      clip-path: inset(0% 100% 0% 0%);
    }
    .kit-lt-mask-reveal .lt-sweep {
      position: absolute; top: 0; bottom: 0; left: 0; width: 8px;
      background: var(--kit-accent); opacity: 0;
    }
    .kit-lt-mask-reveal .lt-role {
      font-size: 28px; font-weight: 500; color: var(--kit-role-color);
      line-height: 1.2; letter-spacing: 0.04em; white-space: nowrap;
      text-shadow: 0 2px 16px rgba(0,0,0,0.45); opacity: 0;
    }
  `);

  const stage = KIT.stage(root, 1920, 1080);
  stage.classList.add("kit-lt-mask-reveal");
  KIT.theme(stage, theme);
  stage.innerHTML = `
    <div class="lt">
      <div class="lt-namewrap">
        <div class="lt-name"></div>
        <div class="lt-sweep"></div>
      </div>
      <div class="lt-role"></div>
    </div>`;
  const wrap = stage.querySelector(".lt");
  const nameWrap = stage.querySelector(".lt-namewrap");
  const nameEl = stage.querySelector(".lt-name");
  const sweep = stage.querySelector(".lt-sweep");
  const role = stage.querySelector(".lt-role");
  nameEl.textContent = content.name;
  role.textContent = content.role;

  const tl = SLATE.timeline();
  const ioCubic = SLATE.easing("inOutCubic");

  // 入场：扫光出现并横穿，姓名在其身后被擦出，身份行上浮淡入
  tl.tween(sweep, { opacity: [0, 1] }, { at: 0.1 * k, dur: 0.12 * k, ease: "linear" });
  tl.call((p) => {
    const w = nameWrap.clientWidth;
    sweep.style.transform = `translateX(${ioCubic(p) * w}px)`;
  }, { at: 0.12 * k, dur: 0.55 * k, ease: "linear" });
  tl.tween(nameEl, { clipPath: ["inset(0% 100% 0% 0%)", "inset(0% 0% 0% 0%)"] }, { at: 0.16 * k, dur: 0.5 * k, ease: "inOutCubic" });
  tl.tween(sweep, { opacity: 0 }, { at: 0.6 * k, dur: 0.15 * k, ease: "linear" });
  tl.tween(role, { y: [14, 0], opacity: [0, 1] }, { at: 0.55 * k, dur: 0.5 * k, ease: "outQuart" });

  // 退场：身份行淡出，姓名从左向右擦除，最后隐藏
  const e = exitAt(0.55);
  tl.tween(role, { opacity: 0 }, { at: e, dur: 0.3, ease: "inCubic" });
  tl.tween(nameEl, { clipPath: ["inset(0% 0% 0% 0%)", "inset(0% 0% 0% 100%)"] }, { at: e + 0.05, dur: 0.4, ease: "inCubic" });
  tl.set(wrap, { visibility: "hidden" }, e + 0.5);

  return tl;
};
