/* 改编自 Apache-2.0 许可的开源素材，动画和写法有改动。许可证原文见 /opt/slate/licenses/kit/LICENSE */
KIT.shots["code-typing"] = function (root, o = {}) {
  const content = Object.assign({
    // 标题栏里高亮的文件名
    filename: "loadConfig.js",
    // 文件名后面的说明
    title: "代码打字演示",
    // 代码：每行若干 [文字, 颜色] 片段
    code: [
      [["async", "#F97583"], [" "], ["function", "#F97583"], [" "], ["loadConfig", "#B392F0"], ["("], ["path", "#FFAB70"], [") {"]],
      [["  "], ["const", "#F97583"], [" "], ["raw", "#79B8FF"], [" "], ["=", "#F97583"], [" "], ["await", "#F97583"], [" "], ["readFile", "#B392F0"], ["(path, "], ['"utf8"', "#9ECBFF"], [")"]],
      [["  "], ["const", "#F97583"], [" "], ["config", "#79B8FF"], [" "], ["=", "#F97583"], [" "], ["JSON", "#79B8FF"], ["."], ["parse", "#B392F0"], ["(raw)"]],
      [["  "], ["return", "#F97583"], [" "], ["validate", "#B392F0"], ["(config)"]],
      [["}"]]
    ],
    // 每个字符的打字间隔（秒）
    perChar: 0.028
  }, o.content);
  const theme = Object.assign({
    "--kit-bg": "#05070b",
    "--kit-editor": "#0b0f17",
    "--kit-fg": "#E1E4E8",
    "--kit-accent": "#58a6ff",
    "--kit-muted": "#828c9b",
    "--kit-font": "\"JetBrains Mono\", \"Noto Sans CJK SC\", monospace"
  }, o.theme);
  const { k } = KIT.fit(5, o.dur);

  if (!document.querySelector('link[data-kit-font="jetbrains-mono"]')) {
    const l = document.createElement("link");
    l.rel = "stylesheet"; l.href = "/assets/fonts/lib/jetbrains-mono.css"; l.dataset.kitFont = "jetbrains-mono";
    document.head.appendChild(l);
  }
  SLATE.waits = SLATE.waits || [];
  SLATE.waits.push(document.fonts.load('400 30px "JetBrains Mono"'), document.fonts.load('400 19px "Noto Sans CJK SC"'));

  KIT.css("code-typing", `
.kit-code-typing{position:absolute;inset:0;overflow:hidden;background:var(--kit-bg);font-family:var(--kit-font);color:#e6edf3}
.kit-code-typing *{box-sizing:border-box;margin:0;padding:0}
.kit-code-typing .bg-field{position:absolute;inset:0;background:radial-gradient(1200px 700px at 50% 18%,#0e1726 0%,#070b12 55%,#05070b 100%)}
.kit-code-typing .bg-grid{position:absolute;inset:0;background-image:linear-gradient(rgba(88,166,255,.05) 1px,transparent 1px),linear-gradient(90deg,rgba(88,166,255,.05) 1px,transparent 1px);background-size:64px 64px;-webkit-mask-image:radial-gradient(1100px 620px at 50% 42%,#000 0%,transparent 78%);mask-image:radial-gradient(1100px 620px at 50% 42%,#000 0%,transparent 78%)}
.kit-code-typing .bg-glow{position:absolute;width:900px;height:900px;border-radius:50%;filter:blur(120px);opacity:.5}
.kit-code-typing .bg-glow.a{background:#1f6feb55;left:-180px;top:-200px}
.kit-code-typing .bg-glow.b{background:#2ea04355;right:-200px;bottom:-260px}
.kit-code-typing .editor{position:absolute;left:50%;top:50%;margin-left:-690px;margin-top:-400px;width:1380px;height:800px;background:var(--kit-editor);border:1px solid #1d2733;border-radius:16px;box-shadow:0 40px 120px rgba(0,0,0,.6),0 2px 0 rgba(255,255,255,.03) inset;overflow:hidden;display:flex;flex-direction:column}
.kit-code-typing .titlebar{height:56px;flex:0 0 56px;display:flex;align-items:center;gap:16px;padding:0 22px;background:linear-gradient(#11161f,#0c111a);border-bottom:1px solid #1b2430}
.kit-code-typing .dots{display:flex;gap:10px}
.kit-code-typing .dot{width:14px;height:14px;border-radius:50%}
.kit-code-typing .dot.r{background:#ff5f57}.kit-code-typing .dot.y{background:#febc2e}.kit-code-typing .dot.g{background:#28c840}
.kit-code-typing .filename{font-size:19px;color:#8b98a9;letter-spacing:.2px;white-space:nowrap}
.kit-code-typing .filename .accent{color:#d6e2f0}
.kit-code-typing .surface{position:relative;flex:1 1 auto;overflow:hidden}
.kit-code-typing .scene{position:absolute;inset:0;opacity:0}
.kit-code-typing .code{position:absolute;top:38px;left:0;right:0;padding:0 44px 0 104px;font-size:30px;line-height:46px;font-variant-ligatures:none;tab-size:2}
.kit-code-typing .gutter{position:absolute;top:38px;left:0;width:84px;padding-right:18px;font-size:30px;line-height:46px;text-align:right;color:var(--kit-muted)}
.kit-code-typing .ln{display:block;height:46px}
.kit-code-typing .line{display:block;min-height:46px;white-space:pre;position:relative;z-index:1}
.kit-code-typing .tok{display:inline-block;white-space:pre;opacity:0}
.kit-code-typing .caret{position:absolute;top:0;left:0;width:3px;height:32px;margin-top:6px;background:var(--kit-accent);border-radius:1px;z-index:3}
`);

  const stage = KIT.stage(root, 1920, 1080);
  stage.classList.add("kit-code-typing");
  KIT.theme(stage, theme);
  const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  stage.innerHTML = `
    <div class="bg-field"></div><div class="bg-grid"></div>
    <div class="bg-glow a"></div><div class="bg-glow b"></div>
    <div class="editor">
      <div class="titlebar">
        <div class="dots"><span class="dot r"></span><span class="dot y"></span><span class="dot g"></span></div>
        <span class="filename"><span class="accent">${esc(content.filename)}</span> — ${esc(content.title)}</span>
      </div>
      <div class="surface"><div class="scene"><div class="gutter"></div><div class="code"></div></div></div>
    </div>`;

  const editor = stage.querySelector(".editor");
  const scene = stage.querySelector(".scene");
  const code = stage.querySelector(".code");
  const gutter = stage.querySelector(".gutter");

  const chars = [];
  const lines = content.code || [];
  lines.forEach(parts => {
    const line = document.createElement("div");
    line.className = "line";
    (parts || []).forEach(p => {
      const text = Array.isArray(p) ? String(p[0]) : String(p);
      const color = (Array.isArray(p) && p[1]) || "var(--kit-fg)";
      for (const ch of Array.from(text)) {
        const s = document.createElement("span");
        s.className = "tok";
        s.textContent = ch;
        s.style.color = color;
        line.appendChild(s);
        chars.push({ el: s, line, ws: /\s/.test(ch) });
      }
    });
    code.appendChild(line);
  });
  gutter.innerHTML = lines.map((_, i) => `<span class="ln">${i + 1}</span>`).join("");
  const caret = document.createElement("div");
  caret.className = "caret";
  code.appendChild(caret);

  const FADE = 0.45 * k;
  const START = 0.45 * k;
  const PER = (content.perChar || 0.028) * k;
  const t0 = START + FADE;

  const tl = SLATE.timeline();
  tl.tween(editor, { opacity: { from: 0 }, scale: { from: 0.985 } }, { at: 0, dur: 0.5 * k, ease: "outCubic" });
  tl.tween(scene, { opacity: [0, 1] }, { at: START, dur: FADE, ease: "outQuad" });

  chars.forEach((c, i) => {
    tl.tween(c.el, { opacity: [0, 1] }, { at: t0 + i * PER, dur: c.ws ? 0.01 : 0.12 * k, ease: "outQuad" });
  });

  // 光标：测量放到第一次渲染时（字体已加载完），按 t 线性插值到当前最前面那个字的右边缘
  let pts = null;
  const measure = () => {
    pts = [];
    if (!chars.length) return;
    const f = chars[0];
    pts.push([f.line.offsetLeft + f.el.offsetLeft, f.line.offsetTop + f.el.offsetTop]);
    chars.forEach(c => {
      pts.push([c.line.offsetLeft + c.el.offsetLeft + c.el.offsetWidth, c.line.offsetTop + c.el.offsetTop]);
    });
  };
  const total = Math.max(chars.length * PER, 0.001);
  tl.call((p, t) => {
    if (!pts) measure();
    if (!pts.length) { caret.style.opacity = 0; return; }
    const n = chars.length;
    const e = Math.max(0, t - t0);
    let i = Math.min(Math.floor(e / PER), n - 1);
    let f = SLATE.clamp((e - i * PER) / PER, 0, 1);
    if (t < t0) { i = 0; f = 0; }
    const a = pts[i], b = pts[i + 1];
    const x = SLATE.lerp(a[0], b[0], f), y = SLATE.lerp(a[1], b[1], f);
    caret.style.transform = `translate(${x}px, ${y}px)`;
  }, { at: 0, dur: t0 + total });

  return tl;
};
