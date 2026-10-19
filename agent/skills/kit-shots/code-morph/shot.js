/* 改编自 Apache-2.0 许可的开源素材，动画和写法有改动。许可证原文见 /opt/slate/licenses/kit/LICENSE */
KIT.shots = KIT.shots || {};
KIT.shots["code-morph"] = function (root, o = {}) {
  const content = Object.assign({
    // 标题栏高亮的文件名
    filename: "refactor.js",
    // 文件名后的说明
    subtitle: "— 代码变形",
    // 依次变形的代码版本
    states: [
      "// 第一版：用循环收集名字\nfunction activeNames(users) {\n  const out = []\n  for (const u of users) {\n    if (u.active) {\n      out.push(u.name)\n    }\n  }\n  return out\n}",
      "// 第二版：改成链式调用\nfunction activeNames(users) {\n  return users\n    .filter((u) => u.active)\n    .map((u) => u.name)\n}",
      "// 第三版：一行箭头函数\nconst activeNames = (users) =>\n  users.filter((u) => u.active).map((u) => u.name)"
    ]
  }, o.content);
  const theme = Object.assign({
    "--kit-font": "\"JetBrains Mono\", \"Noto Sans CJK SC\", monospace",
    "--kit-bg": "#05070b",
    "--kit-bg-mid": "#0e1726",
    "--kit-editor-bg": "#0b0f17",
    "--kit-accent": "rgba(88, 166, 255, 0.05)",
    "--kit-glow-a": "#1f6feb55",
    "--kit-glow-b": "#2ea04355"
  }, o.theme);
  const { k, d } = KIT.fit(7, o.dur);

  // 字体
  const FONT_CSS = "/assets/fonts/lib/jetbrains-mono.css";
  if (!document.querySelector('link[href="' + FONT_CSS + '"]')) {
    const l = document.createElement("link");
    l.rel = "stylesheet"; l.href = FONT_CSS;
    document.head.appendChild(l);
  }
  SLATE.waits = SLATE.waits || [];
  SLATE.waits.push(document.fonts.load('400 30px "JetBrains Mono"').catch(() => {}));
  SLATE.waits.push(document.fonts.load('400 30px "Noto Sans CJK SC"', "版本").catch(() => {}));

  KIT.css("code-morph", `
.kit-code-morph{font-family:var(--kit-font);color:#e6edf3;background:var(--kit-bg);overflow:hidden}
.kit-code-morph *{box-sizing:border-box;margin:0;padding:0}
.kit-code-morph .cm-field{position:absolute;inset:0;background:radial-gradient(1200px 700px at 50% 18%,var(--kit-bg-mid) 0%,#070b12 55%,var(--kit-bg) 100%)}
.kit-code-morph .cm-grid{position:absolute;inset:0;background-image:linear-gradient(var(--kit-accent) 1px,transparent 1px),linear-gradient(90deg,var(--kit-accent) 1px,transparent 1px);background-size:64px 64px;-webkit-mask-image:radial-gradient(1100px 620px at 50% 42%,#000 0%,transparent 78%);mask-image:radial-gradient(1100px 620px at 50% 42%,#000 0%,transparent 78%)}
.kit-code-morph .cm-glow{position:absolute;width:900px;height:900px;border-radius:50%;filter:blur(120px);opacity:.5}
.kit-code-morph .cm-glow.a{background:var(--kit-glow-a);left:-180px;top:-200px}
.kit-code-morph .cm-glow.b{background:var(--kit-glow-b);right:-200px;bottom:-260px}
.kit-code-morph .cm-editor{position:absolute;left:50%;top:50%;width:1380px;height:800px;margin-left:-690px;margin-top:-400px;background:var(--kit-editor-bg);border:1px solid #1d2733;border-radius:16px;box-shadow:0 40px 120px rgba(0,0,0,.6),0 2px 0 rgba(255,255,255,.03) inset;overflow:hidden;display:flex;flex-direction:column}
.kit-code-morph .cm-titlebar{height:56px;flex:0 0 56px;display:flex;align-items:center;gap:16px;padding:0 22px;background:linear-gradient(#11161f,#0c111a);border-bottom:1px solid #1b2430}
.kit-code-morph .cm-dots{display:flex;gap:10px}
.kit-code-morph .cm-dot{width:14px;height:14px;border-radius:50%}
.kit-code-morph .cm-dot.r{background:#ff5f57}.kit-code-morph .cm-dot.y{background:#febc2e}.kit-code-morph .cm-dot.g{background:#28c840}
.kit-code-morph .cm-filename{font-size:19px;color:#8b98a9;letter-spacing:.2px;white-space:pre}
.kit-code-morph .cm-filename .accent{color:#d6e2f0}
.kit-code-morph .cm-surface{position:relative;flex:1 1 auto;overflow:hidden}
.kit-code-morph .cm-scene{position:absolute;inset:0;opacity:0;visibility:hidden}
.kit-code-morph .cm-code{position:absolute;top:38px;left:0;right:0;padding:0 44px 0 104px;font-size:30px;line-height:46px;font-variant-ligatures:none;tab-size:2}
.kit-code-morph .cm-code.meas{visibility:hidden}
.kit-code-morph .cm-line{display:block;min-height:46px;white-space:pre}
.kit-code-morph .cm-tok{display:inline-block;white-space:pre}
`);

  const stage = KIT.stage(root, 1920, 1080);
  stage.classList.add("kit-code-morph");
  KIT.theme(stage, theme);
  const esc = s => String(s).replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  stage.innerHTML = `
    <div class="cm-field"></div><div class="cm-grid"></div>
    <div class="cm-glow a"></div><div class="cm-glow b"></div>
    <div class="cm-editor">
      <div class="cm-titlebar">
        <div class="cm-dots"><span class="cm-dot r"></span><span class="cm-dot y"></span><span class="cm-dot g"></span></div>
        <span class="cm-filename"><span class="accent">${esc(content.filename)}</span> ${esc(content.subtitle)}</span>
      </div>
      <div class="cm-surface"></div>
    </div>`;
  const editor = stage.querySelector(".cm-editor");
  const surface = stage.querySelector(".cm-surface");

  // ---- 简易语法高亮（深色主题配色） ----
  const C = { kw: "#F97583", fn: "#B392F0", param: "#FFAB70", cst: "#79B8FF", str: "#9ECBFF", com: "#6A737D", tx: "#E1E4E8" };
  const KW = new Set("function const let var for of in if else return new class extends import export from default async await while do switch case break continue try catch finally throw typeof instanceof yield delete void".split(" "));
  const LIT = new Set(["true", "false", "null", "undefined", "this", "NaN"]);
  function tokenize(src) {
    const re = /(\/\/[^\n]*)|('(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`)|(\d[\d_.]*)|([A-Za-z_$\u4e00-\u9fff][\w$\u4e00-\u9fff]*)|(\n)|([ \t]+)|(=>|===|!==|==|!=|<=|>=|&&|\|\||\+\+|--|\+=|-=|\S)/g;
    const toks = []; let m;
    while ((m = re.exec(src))) {
      const type = m[1] ? "com" : m[2] ? "str" : m[3] ? "num" : m[4] ? "id" : m[5] ? "nl" : m[6] ? "ws" : "op";
      toks.push({ text: m[0], type, color: C.tx });
    }
    const sig = toks.filter(t => t.type !== "ws" && t.type !== "nl");
    sig.forEach((t, i) => {
      const prev = sig[i - 1], next = sig[i + 1];
      if (t.type === "com") t.color = C.com;
      else if (t.type === "str") t.color = C.str;
      else if (t.type === "num") t.color = C.cst;
      else if (t.type === "op") t.color = /^[=+\-*\/<>!&|?%]/.test(t.text) ? C.kw : C.tx;
      else if (KW.has(t.text)) t.color = C.kw;
      else if (LIT.has(t.text)) t.color = C.cst;
      else if (prev && prev.text === ".") t.color = C.tx;
      else if (next && next.text === "(") t.color = C.fn;
      else if (prev && /^(const|let|var)$/.test(prev.text)) {
        let fnLike = false;
        for (let j = i + 1; j < sig.length && j < i + 12; j++) if (sig[j].text === "=>" || sig[j].text === "function") { fnLike = true; break; }
        t.color = fnLike && next && next.text === "=" ? C.fn : C.cst;
      }
    });
    // 参数：箭头函数或 function 声明括号里的标识符
    for (let i = 0; i < sig.length; i++) {
      if (sig[i].text !== "(") continue;
      let depth = 0, j = i;
      for (; j < sig.length; j++) {
        if (sig[j].text === "(") depth++;
        else if (sig[j].text === ")") { depth--; if (!depth) break; }
      }
      const after = sig[j + 1];
      const isDecl = sig[i - 1] && sig[i - 1].type === "id" && sig[i - 2] && sig[i - 2].text === "function";
      if ((after && after.text === "=>") || isDecl) {
        let dd = 0;
        for (let q = i; q < j; q++) {
          const t = sig[q];
          if (t.text === "(") dd++; else if (t.text === ")") dd--;
          else if (dd === 1 && t.type === "id" && !KW.has(t.text) && !(sig[q - 1] && sig[q - 1].text === ".")) t.color = C.param;
        }
      }
    }
    return toks;
  }

  function renderInto(code, toks) {
    code.textContent = "";
    const sigEls = [];
    let line = document.createElement("div");
    line.className = "cm-line"; code.appendChild(line);
    toks.forEach(t => {
      if (t.type === "nl") {
        line = document.createElement("div");
        line.className = "cm-line"; code.appendChild(line);
        return;
      }
      const sp = document.createElement("span");
      sp.className = "cm-tok"; sp.textContent = t.text; sp.style.color = t.color;
      line.appendChild(sp);
      if (t.type !== "ws") sigEls.push({ el: sp, tok: t });
    });
    return sigEls;
  }

  // 匹配：最长公共子序列 + 同名词就近配对
  function match(a, b) {
    const n = a.length, m = b.length;
    const dp = [];
    for (let i = 0; i <= n; i++) dp.push(new Array(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
      dp[i][j] = a[i].tok.text === b[j].tok.text ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    const bToA = new Array(m).fill(-1), aUsed = new Array(n).fill(false);
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (a[i].tok.text === b[j].tok.text) { bToA[j] = i; aUsed[i] = true; i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) i++; else j++;
    }
    for (let q = 0; q < m; q++) {
      if (bToA[q] >= 0 || b[q].tok.type === "com") continue;
      let best = -1, bd = Infinity;
      for (let p = 0; p < n; p++) {
        if (aUsed[p] || a[p].tok.text !== b[q].tok.text) continue;
        const dd = Math.abs(p / Math.max(1, n) - q / Math.max(1, m));
        if (dd < bd) { bd = dd; best = p; }
      }
      if (best >= 0) { bToA[q] = best; aUsed[best] = true; }
    }
    return { bToA, aUsed };
  }

  const inOutCubic = x => x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
  const inQuad = x => x * x;
  const outQuad = x => 1 - (1 - x) * (1 - x);
  const cl = x => Math.max(0, Math.min(1, x));

  const states = (content.states || []).map(s => tokenize(String(s)));
  const tl = SLATE.timeline();

  // 编辑器入场
  tl.tween(editor, { opacity: { from: 0 }, scale: { from: 0.985 } }, { at: 0, dur: 0.5 * k, ease: "outCubic" });

  const FADE = 0.45 * k, STEP = 1.2 * k, HOLD = 1.0 * k;
  let t = 0.45 * k;

  function makeScene() {
    const scene = document.createElement("div");
    scene.className = "cm-scene";
    const meas = document.createElement("div");
    meas.className = "cm-code meas";
    const vis = document.createElement("div");
    vis.className = "cm-code vis";
    scene.appendChild(meas); scene.appendChild(vis);
    surface.appendChild(scene);
    return { scene, meas, vis };
  }

  if (states.length === 1) {
    const sc = makeScene();
    renderInto(sc.vis, states[0]);
    tl.set(sc.scene, { visibility: "visible" }, t);
    tl.tween(sc.scene, { opacity: [0, 1] }, { at: t, dur: FADE, ease: "outQuad" });
  }

  for (let s = 0; s < states.length - 1; s++) {
    const sc = makeScene();
    const fromEls = renderInto(sc.meas, states[s]);
    const toEls = renderInto(sc.vis, states[s + 1]);
    const { bToA, aUsed } = match(fromEls, toEls);
    // 被删掉的词：在新代码层里放一份绝对定位的副本，淡出
    const leavers = [];
    fromEls.forEach((f, i) => {
      if (aUsed[i]) return;
      const sp = document.createElement("span");
      sp.className = "cm-tok"; sp.textContent = f.tok.text; sp.style.color = f.tok.color;
      sp.style.position = "absolute";
      sc.vis.appendChild(sp);
      leavers.push({ el: sp, src: f.el });
    });
    let measured = null;
    const measure = () => {
      if (measured) return measured;
      const movers = [], enterers = [];
      toEls.forEach((b, q) => {
        const ai = bToA[q];
        if (ai >= 0) {
          const fa = fromEls[ai].el;
          movers.push({ el: b.el, dx: fa.offsetLeft - b.el.offsetLeft, dy: fa.offsetTop - b.el.offsetTop });
        } else enterers.push(b.el);
      });
      leavers.forEach(l => {
        l.el.style.left = l.src.offsetLeft + "px";
        l.el.style.top = l.src.offsetTop + "px";
      });
      measured = { movers, enterers };
      return measured;
    };

    const segStart = t + FADE;
    const segEnd = segStart + STEP + HOLD;
    const isLast = s === states.length - 2;
    // 前后两段在交接时画面完全相同（上一段的终态 = 下一段的起态），直接切换
    tl.set(sc.scene, { visibility: "visible" }, t);
    if (s === 0) tl.tween(sc.scene, { opacity: [0, 1] }, { at: t, dur: FADE, ease: "outQuad" });
    else tl.set(sc.scene, { opacity: 1 }, t);
    if (!isLast) tl.set(sc.scene, { visibility: "hidden" }, segEnd - FADE);
    tl.call((p) => {
      const m = measure();
      const lt = p * 1.2; // 原设计的局部秒数
      const e = inOutCubic(cl(lt / 1.2));
      m.movers.forEach(o => {
        o.el.style.transform = `translate(${o.dx * (1 - e)}px, ${o.dy * (1 - e)}px)`;
      });
      const eo = outQuad(cl((lt - 0.54) / 0.6));
      m.enterers.forEach(el => { el.style.opacity = eo; el.style.visibility = eo > 0 ? "visible" : "hidden"; });
      const lo = 1 - inQuad(cl(lt / 0.6));
      leavers.forEach(l => { l.el.style.opacity = lo; l.el.style.visibility = lo > 0 ? "visible" : "hidden"; });
      // 词块飞行途中会互相穿过，只是运动中的过渡画面
      if (p > 0 && p < 1) sc.vis.setAttribute("data-qa", "ignore");
      else sc.vis.removeAttribute("data-qa");
    }, { at: segStart, dur: STEP, ease: "linear" });
    t = segEnd - FADE;
  }

  // 撑满整段时长（停留在最后一版）
  tl.call(() => {}, { at: 0, dur: d });
  return tl;
};
