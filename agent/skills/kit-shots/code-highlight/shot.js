/* 改编自 Apache-2.0 许可的开源素材，动画和写法有改动。许可证原文见 /opt/slate/licenses/kit/LICENSE */
KIT.shots["code-highlight"] = function (root, o = {}) {
  const content = Object.assign({
    // 标题栏文件名
    filename: "loadConfig.js",
    // 文件名后的说明
    subtitle: " — 读取并校验配置",
    // 代码，\n 分行
    code: 'async function loadConfig(path) {\n  const raw = await readFile(path, "utf8")\n  const config = JSON.parse(raw)\n  return validate(config) // 校验后返回\n}',
    // 高亮第几行（从 1 开始）
    line: 2,
  }, o.content);
  const theme = Object.assign({
    "--kit-accent": "#58a6ff",
    "--kit-hl-fill": "rgba(88, 166, 255, 0.16)",
    "--kit-bg": "#05070b",
    "--kit-editor": "#0b0f17",
    "--kit-font": "\"JetBrains Mono\", \"Noto Sans CJK SC\", monospace",
  }, o.theme);
  const { k } = KIT.fit(5, o.dur);

  if (!document.querySelector('link[data-kit-font="jetbrains-mono"]')) {
    const l = document.createElement("link");
    l.rel = "stylesheet";
    l.href = "/assets/fonts/lib/jetbrains-mono.css";
    l.setAttribute("data-kit-font", "jetbrains-mono");
    document.head.appendChild(l);
  }
  SLATE.waits = SLATE.waits || [];
  SLATE.waits.push(document.fonts.load('400 30px "JetBrains Mono"').catch(() => {}));
  SLATE.waits.push(document.fonts.load('400 30px "Noto Sans CJK SC"').catch(() => {}));

  KIT.css("code-highlight", `
.kit-code-highlight{font-family:var(--kit-font);color:#e6edf3;background:var(--kit-bg);overflow:hidden}
.kit-code-highlight *{box-sizing:border-box;margin:0;padding:0}
.kit-code-highlight .bg-field{position:absolute;inset:0;background:radial-gradient(1200px 700px at 50% 18%,#0e1726 0%,#070b12 55%,var(--kit-bg) 100%)}
.kit-code-highlight .bg-grid{position:absolute;inset:0;background-image:linear-gradient(rgba(88,166,255,.05) 1px,transparent 1px),linear-gradient(90deg,rgba(88,166,255,.05) 1px,transparent 1px);background-size:64px 64px;-webkit-mask-image:radial-gradient(1100px 620px at 50% 42%,#000 0%,transparent 78%);mask-image:radial-gradient(1100px 620px at 50% 42%,#000 0%,transparent 78%)}
.kit-code-highlight .bg-glow{position:absolute;width:900px;height:900px;border-radius:50%;filter:blur(120px);opacity:.5}
.kit-code-highlight .bg-glow.a{background:#1f6feb55;left:-180px;top:-200px}
.kit-code-highlight .bg-glow.b{background:#2ea04355;right:-200px;bottom:-260px}
.kit-code-highlight .editor{position:absolute;left:270px;top:140px;width:1380px;height:800px;background:var(--kit-editor);border:1px solid #1d2733;border-radius:16px;box-shadow:0 40px 120px rgba(0,0,0,.6),0 2px 0 rgba(255,255,255,.03) inset;overflow:hidden;display:flex;flex-direction:column}
.kit-code-highlight .titlebar{height:56px;flex:0 0 56px;display:flex;align-items:center;gap:16px;padding:0 22px;background:linear-gradient(#11161f,#0c111a);border-bottom:1px solid #1b2430}
.kit-code-highlight .dots{display:flex;gap:10px}
.kit-code-highlight .dot{width:14px;height:14px;border-radius:50%}
.kit-code-highlight .dot.r{background:#ff5f57}.kit-code-highlight .dot.y{background:#febc2e}.kit-code-highlight .dot.g{background:#28c840}
.kit-code-highlight .filename{font-size:19px;color:#8b98a9;letter-spacing:.2px;white-space:pre}
.kit-code-highlight .filename .accent{color:#d6e2f0}
.kit-code-highlight .code-surface{position:relative;flex:1 1 auto;overflow:hidden}
.kit-code-highlight .scene{position:absolute;inset:0;opacity:0}
.kit-code-highlight .code{position:absolute;top:38px;left:0;right:0;padding:0 44px 0 104px;font-size:30px;line-height:46px;font-variant-ligatures:none;tab-size:2}
.kit-code-highlight .gutter{position:absolute;top:38px;left:0;width:84px;padding-right:18px;font-size:30px;line-height:46px;text-align:right;color:#828c9b}
.kit-code-highlight .ln{display:block;height:46px}
.kit-code-highlight .line{display:block;min-height:46px;white-space:pre;position:relative;z-index:1}
.kit-code-highlight .tok{display:inline-block;white-space:pre}
.kit-code-highlight .hl-box{position:absolute;left:96px;height:48px;width:0;background:var(--kit-hl-fill);border-left:3px solid var(--kit-accent);border-radius:6px;z-index:0;overflow:hidden;opacity:0}
`);

  const stage = KIT.stage(root, 1920, 1080);
  stage.classList.add("kit-code-highlight");
  KIT.theme(stage, theme);

  const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  // 简单的 JS 风格着色
  const KW = new Set(["async","function","const","let","var","await","return","if","else","for","while","new","import","from","export","default","class","extends","try","catch","throw","of","in","typeof","def"]);
  const CONST = new Set(["true","false","null","undefined","this"]);
  const C = { kw: "#F97583", fn: "#B392F0", str: "#9ECBFF", cst: "#79B8FF", prm: "#FFAB70", cm: "#6A737D", fg: "#E1E4E8" };
  function tokenize(line) {
    const out = [];
    const re = /(\/\/.*$|#.*$)|("(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?|`(?:[^`\\]|\\.)*`?)|(\d+(?:\.\d+)?)|([A-Za-z_$][\w$]*)|(=>|===|!==|==|[=+\-*\/<>!&|?:]+)|(\s+)|(.)/g;
    let m, prevWord = "", inParams = false, depth = 0, afterFnName = false;
    while ((m = re.exec(line))) {
      const s = m[0];
      let c = C.fg;
      if (m[1]) c = C.cm;
      else if (m[2]) c = C.str;
      else if (m[3]) c = C.cst;
      else if (m[4]) {
        const rest = line.slice(re.lastIndex);
        if (KW.has(s)) c = C.kw;
        else if (CONST.has(s)) c = C.cst;
        else if (/^\s*\(/.test(rest)) { c = C.fn; if (prevWord === "function") afterFnName = true; }
        else if (inParams) c = C.prm;
        else if (prevWord === "const" || prevWord === "let" || prevWord === "var" || /^[A-Z][A-Z0-9_]*$/.test(s)) c = C.cst;
        prevWord = s;
      } else if (m[5]) c = C.kw;
      else if (m[7]) {
        if (s === "(" && afterFnName) { inParams = true; depth = 0; afterFnName = false; }
        else if (s === "(" && inParams) depth++;
        else if (s === ")" && inParams) { if (depth === 0) inParams = false; else depth--; }
      }
      out.push(`<span class="tok" style="color:${c}">${esc(s)}</span>`);
    }
    return out.join("");
  }

  const lines = String(content.code).replace(/\n+$/, "").split("\n");
  const idx = Math.max(0, Math.min(lines.length - 1, (parseInt(content.line, 10) || 1) - 1));

  stage.innerHTML = `
    <div class="bg-field"></div><div class="bg-grid"></div>
    <div class="bg-glow a"></div><div class="bg-glow b"></div>
    <div class="editor">
      <div class="titlebar">
        <div class="dots"><span class="dot r"></span><span class="dot y"></span><span class="dot g"></span></div>
        <span class="filename"><span class="accent">${esc(content.filename)}</span>${esc(content.subtitle)}</span>
      </div>
      <div class="code-surface">
        <div class="scene">
          <div class="gutter">${lines.map((_, i) => `<span class="ln">${i + 1}</span>`).join("")}</div>
          <div class="code">
            <div class="hl-box" style="top:${idx * 46 - 1}px"></div>
            ${lines.map(l => `<div class="line">${tokenize(l)}</div>`).join("")}
          </div>
        </div>
      </div>
    </div>`;

  const editor = stage.querySelector(".editor");
  const scene = stage.querySelector(".scene");
  const box = stage.querySelector(".hl-box");
  const lineEls = Array.from(stage.querySelectorAll(".line"));
  const others = lineEls.filter((_, i) => i !== idx);
  const BOX_W = 1232 + 18; // 行宽（编辑器宽减左右内边距）+ 18

  const FADE = 0.45, SWEEP = 0.9, START = 0.45;
  const tl = SLATE.timeline();
  tl.tween(editor, { opacity: { from: 0 }, scale: { from: 0.985 } }, { at: 0, dur: 0.5 * k, ease: "outCubic" });
  tl.tween(scene, { opacity: [0, 1] }, { at: START * k, dur: FADE * k, ease: "outQuad" });
  const at = (START + FADE + 0.2) * k;
  tl.tween(box, { width: [0, BOX_W], opacity: [0, 1] }, { at, dur: SWEEP * k, ease: "inOutCubic" });
  if (others.length) tl.tween(others, { opacity: [1, 0.45] }, { at, dur: SWEEP * k, ease: "inOutCubic" });
  return tl;
};
