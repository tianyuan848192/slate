/* 改编自 Apache-2.0 许可的开源素材，动画和写法有改动。许可证原文见 /opt/slate/licenses/kit/LICENSE */
KIT.shots["lt-kicker-name"] = function (root, o = {}) {
  const content = Object.assign({
    kicker: "第 47 期 · 对谈", // 上方荧光标签：期数 / 栏目
    name: "陈美雅"            // 人物姓名
  }, o.content);
  const theme = Object.assign({
    "--kit-accent": "#46e5b7",
    "--kit-kicker-ink": "#141518",
    "--kit-ink": "#ffffff",
    "--kit-font": "\"Archivo\", \"Noto Sans CJK SC\", sans-serif",
    "--kit-mono": "\"JetBrains Mono\", \"Noto Sans CJK SC\", monospace"
  }, o.theme);
  const { k, exitAt } = KIT.fit(4.8, o.dur);

  ["/assets/fonts/lib/archivo.css", "/assets/fonts/lib/jetbrains-mono.css"].forEach(href => {
    if (!document.querySelector('link[href="' + href + '"]')) {
      const l = document.createElement("link");
      l.rel = "stylesheet"; l.href = href;
      document.head.appendChild(l);
    }
  });
  SLATE.waits = SLATE.waits || [];
  SLATE.waits.push(document.fonts.load('900 70px "Archivo"'), document.fonts.load('700 22px "JetBrains Mono"'));

  KIT.css("lt-kicker-name", `
.kit-lt-kicker-name .lt{position:absolute;left:130px;bottom:250px;display:flex;flex-direction:column;align-items:flex-start;gap:14px;}
.kit-lt-kicker-name .lt-kickwrap{overflow:hidden;}
.kit-lt-kicker-name .lt-kicker{display:inline-block;font-family:var(--kit-mono);font-size:22px;font-weight:700;color:var(--kit-kicker-ink);background:var(--kit-accent);padding:6px 14px;letter-spacing:0.1em;text-transform:uppercase;white-space:nowrap;line-height:1.25;}
.kit-lt-kicker-name .lt-name{font-family:var(--kit-font);font-size:70px;font-weight:900;color:var(--kit-ink);line-height:1.05;letter-spacing:-0.015em;text-transform:uppercase;white-space:nowrap;text-shadow:0 2px 22px rgba(0,0,0,0.5);}
.kit-lt-kicker-name .lt-baseline{height:5px;width:100%;background:var(--kit-accent);border-radius:3px;transform-origin:0% 50%;}
`);

  const stage = KIT.stage(root, 1920, 1080);
  stage.classList.add("kit-lt-kicker-name");
  KIT.theme(stage, theme);
  stage.innerHTML = `<div class="lt"><div class="lt-kickwrap"><span class="lt-kicker"></span></div><div class="lt-name"></div><div class="lt-baseline"></div></div>`;
  const wrap = stage.querySelector(".lt");
  const kicker = stage.querySelector(".lt-kicker");
  const nameEl = stage.querySelector(".lt-name");
  const baseline = stage.querySelector(".lt-baseline");
  kicker.textContent = content.kicker;
  nameEl.textContent = content.name;

  const tl = SLATE.timeline();
  // 入场：标签落下、姓名弹起、底线画出
  tl.tween(kicker, { y: [-40, 0] }, { at: 0.1 * k, dur: 0.42 * k, ease: "outBack(2)" });
  tl.tween(nameEl, { y: [34, 0], opacity: [0, 1] }, { at: 0.32 * k, dur: 0.45 * k, ease: "outBack(1.5)" });
  tl.tween(baseline, { scaleX: [0, 1] }, { at: 0.5 * k, dur: 0.5 * k, ease: "outQuint" });

  // 退场：底线收回、文字上提、直接隐藏
  const ex = exitAt(0.55);
  tl.tween(baseline, { scaleX: 0 }, { at: ex, dur: 0.3, ease: "inCubic" });
  tl.tween(nameEl, { y: -16, opacity: 0 }, { at: ex + 0.05, dur: 0.32, ease: "inCubic" });
  tl.tween(kicker, { y: -40 }, { at: ex + 0.07, dur: 0.3, ease: "inCubic" });
  tl.set(wrap, { visibility: "hidden" }, ex + 0.5);
  return tl;
};
