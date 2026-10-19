/* 改编自 Apache-2.0 许可的开源素材，动画和写法有改动。许可证原文见 /opt/slate/licenses/kit/LICENSE */
KIT.shots["code-diff"] = function (root, o = {}) {
  const content = Object.assign({
    filename: "greet.js",          // 标题栏里高亮的文件名
    label: " — 代码对比",           // 文件名后的说明
    // 改动前的代码
    before: 'function greet(name) {\n  console.log("你好，" + name)\n}',
    // 改动后的代码
    after: 'function greet(name, lang) {\n  const msg = translate("你好", lang)\n  console.log(`${msg}，${name}`)\n}'
  }, o.content);
  const theme = Object.assign({
    "--kit-bg": "#05070b",
    "--kit-accent": "#58a6ff",
    "--kit-del": "#f85149",
    "--kit-add": "#3fb950",
    "--kit-font": "\"JetBrains Mono\", \"Noto Sans CJK SC\", monospace"
  }, o.theme);
  const { k, d } = KIT.fit(6, o.dur);

  // 字体
  SLATE.waits = SLATE.waits || [];
  const fontLoad = () => Promise.all([
    document.fonts.load('400 30px "JetBrains Mono"'),
    document.fonts.load('400 30px "Noto Sans CJK SC"')
  ]).catch(() => {});
  let link = document.querySelector('link[data-kit-font="jetbrains-mono"]');
  if (!link) {
    link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "/assets/fonts/lib/jetbrains-mono.css";
    link.dataset.kitFont = "jetbrains-mono";
    const p = new Promise(r => { link.onload = r; link.onerror = r; }).then(fontLoad);
    document.head.appendChild(link);
    SLATE.waits.push(p);
  } else {
    SLATE.waits.push(fontLoad());
  }

  KIT.css("code-diff", `
.kit-code-diff{font-family:var(--kit-font);color:#e6edf3;background:var(--kit-bg);overflow:hidden}
.kit-code-diff *{box-sizing:border-box;margin:0;padding:0}
.kit-code-diff .bg-field{position:absolute;inset:0;background:radial-gradient(1200px 700px at 50% 18%,#0e1726 0%,#070b12 55%,var(--kit-bg) 100%)}
.kit-code-diff .bg-grid{position:absolute;inset:0;background-image:linear-gradient(color-mix(in srgb,var(--kit-accent) 5%,transparent) 1px,transparent 1px),linear-gradient(90deg,color-mix(in srgb,var(--kit-accent) 5%,transparent) 1px,transparent 1px);background-size:64px 64px;-webkit-mask-image:radial-gradient(1100px 620px at 50% 42%,#000 0%,transparent 78%);mask-image:radial-gradient(1100px 620px at 50% 42%,#000 0%,transparent 78%)}
.kit-code-diff .bg-glow{position:absolute;width:900px;height:900px;border-radius:50%;filter:blur(120px);opacity:.5}
.kit-code-diff .bg-glow.a{background:color-mix(in srgb,var(--kit-accent) 33%,transparent);left:-180px;top:-200px}
.kit-code-diff .bg-glow.b{background:color-mix(in srgb,var(--kit-add) 33%,transparent);right:-200px;bottom:-260px}
.kit-code-diff .editor{position:absolute;left:50%;top:50%;width:1380px;height:800px;margin:-400px 0 0 -690px;background:#0b0f17;border:1px solid #1d2733;border-radius:16px;box-shadow:0 40px 120px rgba(0,0,0,.6),0 2px 0 rgba(255,255,255,.03) inset;overflow:hidden;display:flex;flex-direction:column}
.kit-code-diff .titlebar{height:56px;flex:0 0 56px;display:flex;align-items:center;gap:16px;padding:0 22px;background:linear-gradient(#11161f,#0c111a);border-bottom:1px solid #1b2430}
.kit-code-diff .dots{display:flex;gap:10px}
.kit-code-diff .dot{width:14px;height:14px;border-radius:50%}
.kit-code-diff .dot.r{background:#ff5f57}.kit-code-diff .dot.y{background:#febc2e}.kit-code-diff .dot.g{background:#28c840}
.kit-code-diff .filename{font-size:19px;color:#8b98a9;letter-spacing:.2px;white-space:pre}
.kit-code-diff .filename .accent{color:#d6e2f0}
.kit-code-diff .code-surface{position:relative;flex:1 1 auto;overflow:hidden}
.kit-code-diff .scene{position:absolute;inset:0;opacity:0}
.kit-code-diff .code{position:absolute;top:38px;left:0;right:0;padding:0 44px 0 104px;font-size:30px;line-height:46px;font-variant-ligatures:none;tab-size:2}
.kit-code-diff .diff-line{display:block;min-height:0;height:46px;position:relative;overflow:hidden;padding-left:14px}
.kit-code-diff .diff-inner{display:block;height:46px;line-height:46px;white-space:pre;transform-origin:50% 0}
.kit-code-diff .tok{display:inline-block;white-space:pre}
.kit-code-diff .diff-sign{display:inline-block;width:22px;color:#41506220}
.kit-code-diff .diff-del{background:color-mix(in srgb,var(--kit-del) 12%,transparent);box-shadow:inset 3px 0 var(--kit-del)}
.kit-code-diff .diff-add{background:color-mix(in srgb,var(--kit-add) 12%,transparent);box-shadow:inset 3px 0 var(--kit-add);height:0;opacity:0}
.kit-code-diff .diff-del .diff-sign{color:var(--kit-del)}
.kit-code-diff .diff-add .diff-sign{color:var(--kit-add)}
`);

  const stage = KIT.stage(root, 1920, 1080);
  stage.classList.add("kit-code-diff");
  KIT.theme(stage, theme);
  stage.innerHTML = `
    <div class="bg-field"></div><div class="bg-grid"></div>
    <div class="bg-glow a"></div><div class="bg-glow b"></div>
    <div class="editor">
      <div class="titlebar">
        <div class="dots"><span class="dot r"></span><span class="dot y"></span><span class="dot g"></span></div>
        <span class="filename"><span class="accent"></span><span class="lbl"></span></span>
      </div>
      <div class="code-surface"><div class="scene"><div class="code"></div></div></div>
    </div>`;
  stage.querySelector(".filename .accent").textContent = content.filename;
  stage.querySelector(".filename .lbl").textContent = content.label;
  const editor = stage.querySelector(".editor");
  const scene = stage.querySelector(".scene");
  const code = stage.querySelector(".code");

  // —— 简易 JS 语法着色 ——
  const C = { kw: "#F97583", fn: "#B392F0", param: "#FFAB70", str: "#9ECBFF", cst: "#79B8FF", fg: "#E1E4E8" };
  const KW = new Set(["function", "const", "let", "var", "return", "if", "else", "for", "while", "new", "import", "from", "export", "await", "async", "class", "true", "false", "null", "undefined", "this", "of", "in", "typeof"]);
  function tokenize(line) {
    const out = [];
    const push = (s, c) => { if (s) out.push([s, c]); };
    const isDecl = /^\s*(async\s+)?function\b/.test(line);
    let i = 0, params = false, sawParen = false, prevKw = "";
    while (i < line.length) {
      const ch = line[i];
      if (ch === '"' || ch === "'") {
        let j = i + 1;
        while (j < line.length && line[j] !== ch) { if (line[j] === "\\") j++; j++; }
        push(line.slice(i, j + 1), C.str); i = j + 1; continue;
      }
      if (ch === "`") {
        let j = i + 1, buf = "`";
        while (j < line.length && line[j] !== "`") {
          if (line[j] === "$" && line[j + 1] === "{") {
            push(buf + "${", C.str);
            j += 2;
            let e = line.indexOf("}", j); if (e < 0) e = line.length;
            push(line.slice(j, e), C.fg);
            buf = "}"; j = e + 1; continue;
          }
          buf += line[j]; j++;
        }
        if (j < line.length) buf += "`";
        push(buf, C.str); i = j + 1; continue;
      }
      if (/[A-Za-z_$]/.test(ch)) {
        let j = i; while (j < line.length && /[\w$]/.test(line[j])) j++;
        const w = line.slice(i, j);
        let c = C.fg;
        if (KW.has(w)) c = C.kw;
        else if (prevKw === "const" || prevKw === "let" || prevKw === "var") c = C.cst;
        else if (params) c = C.param;
        else if (/^\s*\(/.test(line.slice(j))) c = C.fn;
        prevKw = KW.has(w) ? w : "";
        push(w, c); i = j; continue;
      }
      if (/\d/.test(ch)) {
        let j = i; while (j < line.length && /[\d.]/.test(line[j])) j++;
        push(line.slice(i, j), C.cst); i = j; continue;
      }
      if (/[=+\-*/<>!&|?%]/.test(ch)) { push(ch, C.kw); i++; continue; }
      if (ch === "(" && isDecl && !sawParen) { sawParen = true; params = true; }
      else if (ch === ")" && params) params = false;
      push(ch, C.fg); i++;
    }
    const merged = [];
    out.forEach(t => { const l = merged[merged.length - 1]; if (l && l[1] === t[1]) l[0] += t[0]; else merged.push(t.slice()); });
    return merged;
  }

  // —— 按行做最长公共子序列比较 ——
  const A = String(content.before).replace(/\n+$/, "").split("\n");
  const B = String(content.after).replace(/\n+$/, "").split("\n");
  const n = A.length, m = B.length;
  const dp = [];
  for (let i = 0; i <= n; i++) dp.push(new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
    dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const ops = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { ops.push(["same", B[j]]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) ops.push(["del", A[i++]]);
    else ops.push(["add", B[j++]]);
  }
  while (i < n) ops.push(["del", A[i++]]);
  while (j < m) ops.push(["add", B[j++]]);

  const dels = [], adds = [];
  ops.forEach(([type, text]) => {
    const ln = document.createElement("div");
    ln.className = "diff-line" + (type === "del" ? " diff-del" : type === "add" ? " diff-add" : "");
    const inner = document.createElement("div");
    inner.className = "diff-inner";
    const sign = document.createElement("span");
    sign.className = "diff-sign";
    sign.textContent = type === "del" ? "- " : type === "add" ? "+ " : "  ";
    inner.appendChild(sign);
    tokenize(text).forEach(([s, c]) => {
      const sp = document.createElement("span");
      sp.className = "tok"; sp.textContent = s; sp.style.color = c;
      inner.appendChild(sp);
    });
    ln.appendChild(inner);
    code.appendChild(ln);
    if (type === "del") dels.push([ln, inner]);
    if (type === "add") adds.push([ln, inner]);
  });

  // —— 时间线 ——
  const tl = SLATE.timeline();
  tl.tween(editor, { opacity: { from: 0 }, scale: { from: 0.985 } }, { at: 0, dur: 0.5 * k, ease: "outCubic" });
  const start = 0.45 * k, FADE = 0.45 * k;
  tl.tween(scene, { opacity: [0, 1] }, { at: start, dur: FADE, ease: "outQuad" });
  const atDel = start + FADE + 0.3 * k, DEL = 0.55 * k;
  dels.forEach(([el, inner], q) => {
    const o2 = { at: atDel + q * 0.08 * k, dur: DEL, ease: "inOutCubic" };
    tl.tween(el, { height: [46, 0], opacity: [1, 0] }, o2);
    // 文字随行高一起压扁，避免收起过程中与相邻行重叠
    tl.tween(inner, { scaleY: [1, 0] }, o2);
  });
  const atAdd = atDel + DEL + 0.15 * k;
  adds.forEach(([el, inner], q) => {
    const o2 = { at: atAdd + q * 0.12 * k, dur: 0.6 * k, ease: "outCubic" };
    tl.tween(el, { height: [0, 46], opacity: [0, 1] }, o2);
    tl.tween(inner, { scaleY: [0, 1] }, o2);
  });
  // 停留到镜头结束
  tl.call(() => {}, { at: 0, dur: d });
  return tl;
};
