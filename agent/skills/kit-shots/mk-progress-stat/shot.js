/* 改编自 Apache-2.0 许可的开源素材，动画和写法有改动。许可证原文见 /opt/slate/licenses/kit/LICENSE */
KIT.shots["mk-progress-stat"] = function (root, o = {}) {
  const content = Object.assign({
    scheme: "light",          // 配色："light" 浅色 / "dark" 深色
    value: 22,                 // 最终数值（数字从 0 滚到这个值）
    suffix: "",               // 数字后缀，如 "%"、"万"
    label: "已达成目标",        // 数字下方的标签
    caption: "干得漂亮，离终点越来越近了！", // 进度条下方的说明
    max: 30,                   // 进度条满格对应的值（填充比例 = value / max）
    trackWidth: 480,           // 进度条宽度（设计尺寸 px）
    x: 1300,                   // 组左边缘位置（px），null 为水平居中
    y: 250                     // 组上边缘位置（px），null 为垂直居中
  }, o.content);
  const theme = Object.assign({
    "--kit-font": "\"Inter\", \"Noto Sans CJK SC\", sans-serif",
    "--kit-ink": "#1d1d1f",
    "--kit-ink-dim": "#6e6e73",
    "--kit-ink-dark": "#f5f5f7",
    "--kit-ink-dim-dark": "#a1a1a6",
    "--kit-accent": "#0071e3",
    "--kit-accent-dark": "#7d5cff"
  }, o.theme);
  const { k, d, exitAt } = KIT.fit(7, o.dur);

  if (!document.querySelector('link[data-kit-font="inter"]')) {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "/assets/fonts/lib/inter.css";
    link.setAttribute("data-kit-font", "inter");
    document.head.appendChild(link);
  }
  SLATE.waits = SLATE.waits || [];
  SLATE.waits.push(document.fonts.load('600 190px "Inter"'));
  SLATE.waits.push(document.fonts.load('500 42px "Inter"'));
  SLATE.waits.push(document.fonts.load('400 30px "Inter"'));
  SLATE.waits.push(document.fonts.load('500 42px "Noto Sans CJK SC"', "已达成"));

  KIT.css("mk-progress-stat", `
.kit-mk-progress-stat{overflow:hidden;font-family:var(--kit-font);}
.kit-mk-progress-stat .ps-pos{position:absolute;}
.kit-mk-progress-stat .ps-group{position:relative;}
.kit-mk-progress-stat .ps-num{font-weight:600;font-size:190px;line-height:1;letter-spacing:-0.03em;color:var(--kit-ink);font-variant-numeric:tabular-nums;white-space:nowrap;}
.kit-mk-progress-stat .ps-label{margin-top:10px;font-weight:500;font-size:42px;letter-spacing:-0.01em;color:var(--kit-ink);white-space:nowrap;}
.kit-mk-progress-stat .ps-track{position:relative;margin-top:28px;height:6px;border-radius:3px;background:rgba(29,29,31,0.1);overflow:hidden;}
.kit-mk-progress-stat .ps-fill{position:absolute;inset:0;border-radius:3px;background:var(--kit-accent);transform-origin:left center;}
.kit-mk-progress-stat .ps-caption{margin-top:22px;font-weight:400;font-size:30px;color:var(--kit-ink-dim);white-space:nowrap;}
.kit-mk-progress-stat.ps-dark .ps-num,.kit-mk-progress-stat.ps-dark .ps-label{color:var(--kit-ink-dark);}
.kit-mk-progress-stat.ps-dark .ps-caption{color:var(--kit-ink-dim-dark);}
.kit-mk-progress-stat.ps-dark .ps-track{background:rgba(245,245,247,0.18);}
.kit-mk-progress-stat.ps-dark .ps-fill{background:var(--kit-accent-dark);}
`);

  const stage = KIT.stage(root, 1920, 1080);
  stage.classList.add("kit-mk-progress-stat");
  if (content.scheme === "dark") stage.classList.add("ps-dark");
  KIT.theme(stage, theme);
  stage.innerHTML = `
    <div class="ps-pos">
      <div class="ps-group">
        <div class="ps-num"></div>
        <div class="ps-label"></div>
        <div class="ps-track"><div class="ps-fill"></div></div>
        <div class="ps-caption"></div>
      </div>
    </div>`;
  const pos = stage.querySelector(".ps-pos");
  const group = stage.querySelector(".ps-group");
  const num = stage.querySelector(".ps-num");
  const fill = stage.querySelector(".ps-fill");
  stage.querySelector(".ps-label").textContent = content.label;
  stage.querySelector(".ps-caption").textContent = content.caption;
  stage.querySelector(".ps-track").style.width = content.trackWidth + "px";
  num.textContent = "0" + content.suffix;

  // 定位放在外层（不参与补间），null 时用 CSS 居中，避免在字体加载前测量
  let tf = "";
  if (content.x === null || content.x === undefined) { pos.style.left = "50%"; tf += "translateX(-50%) "; }
  else pos.style.left = content.x + "px";
  if (content.y === null || content.y === undefined) { pos.style.top = "50%"; tf += "translateY(-50%)"; }
  else pos.style.top = content.y + "px";
  if (tf) pos.style.transform = tf.trim();

  const ratio = SLATE.clamp(content.max ? content.value / content.max : 0, 0, 1);
  const tl = SLATE.timeline();

  // 入场：上浮淡入
  tl.tween(group, { opacity: [0, 1], y: [28, 0] }, { at: 0.3 * k, dur: 0.7 * k, ease: "outQuart" });
  // 数字滚动与进度条填充用同一缓动
  tl.call((p) => {
    num.textContent = Math.round(p * content.value) + content.suffix;
  }, { at: 0.5 * k, dur: 1.6 * k, ease: "outCubic" });
  tl.tween(fill, { scaleX: [0, ratio] }, { at: 0.5 * k, dur: 1.6 * k, ease: "outCubic" });
  // 退场：上移淡出
  tl.tween(group, { opacity: 0, y: -20 }, { at: exitAt(0.5), dur: 0.4, ease: "inCubic" });
  tl.set(pos, { visibility: "hidden" }, Math.max(0, d - 0.02));
  return tl;
};
