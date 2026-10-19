/* 改编自 Apache-2.0 许可的开源素材，动画和写法有改动。许可证原文见 /opt/slate/licenses/kit/LICENSE */
KIT.shots = KIT.shots || {};

KIT.shots["exploded-stack"] = function (root, o = {}) {
  const content = Object.assign({
    title: "一次请求怎样流转", // 左上角标题
    layer1: "交互界面",        // 顶层
    layer2: "API 网关",        // 第 2 层
    layer3: "业务服务",        // 第 3 层
    layer4: "数据存储",        // 底层
  }, o.content);
  const theme = Object.assign({
    "--kit-accent": "#0a84ff",
    "--kit-bg": "#f4f4f5",
    "--kit-ink": "#14161c",
    "--kit-font": "\"Inter\", \"Noto Sans CJK SC\", system-ui, sans-serif",
  }, o.theme);
  const { k, d, exitAt } = KIT.fit(5, o.dur);

  if (!document.querySelector('link[data-kit-font="inter"]')) {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "/assets/fonts/lib/inter.css";
    link.setAttribute("data-kit-font", "inter");
    document.head.appendChild(link);
  }
  SLATE.waits = SLATE.waits || [];
  SLATE.waits.push(Promise.all([
    document.fonts.load('700 60px "Inter"'),
    document.fonts.load('500 34px "Inter"'),
    document.fonts.load('700 60px "Noto Sans CJK SC"'),
    document.fonts.load('500 34px "Noto Sans CJK SC"'),
  ]).catch(() => {}));

  KIT.css("exploded-stack", `
    .kit-exploded-stack{background:var(--kit-bg);font-family:var(--kit-font);overflow:hidden}
    .kit-exploded-stack .es-canvas,.kit-exploded-stack .es-leaders{position:absolute;left:0;top:0;width:1920px;height:1080px;display:block}
    .kit-exploded-stack .es-title{position:absolute;left:120px;top:110px;font-size:60px;font-weight:700;letter-spacing:-0.02em;color:var(--kit-ink);white-space:nowrap}
    .kit-exploded-stack .es-label{position:absolute;left:0;top:0;display:flex;align-items:center;gap:18px;font-size:34px;font-weight:500;color:#1b1e27;white-space:nowrap;opacity:0;line-height:44px}
    .kit-exploded-stack .es-index{font-size:20px;font-weight:700;letter-spacing:0.08em}
    .kit-exploded-stack .es-leaders line{stroke:rgba(27,30,39,0.35);stroke-width:2}
  `);

  const stage = KIT.stage(root, 1920, 1080);
  stage.classList.add("kit-exploded-stack");
  KIT.theme(stage, theme);
  stage.innerHTML = `
    <canvas class="es-canvas"></canvas>
    <svg class="es-leaders" viewBox="0 0 1920 1080" aria-hidden="true"></svg>
    <div class="es-title"></div>
    <div class="es-labels"></div>`;
  stage.querySelector(".es-title").textContent = content.title || "";

  const names = [content.layer1, content.layer2, content.layer3, content.layer4].map(String);
  const labelsBox = stage.querySelector(".es-labels");
  const leaders = stage.querySelector(".es-leaders");
  const NS = "http://www.w3.org/2000/svg";
  const labelEls = [], indexEls = [], lines = [], dots = [];
  names.forEach((name, i) => {
    const el = document.createElement("div");
    el.className = "es-label";
    el.innerHTML = '<span class="es-index">0' + (i + 1) + "</span><span></span>";
    el.lastChild.textContent = name;
    labelsBox.appendChild(el);
    const line = document.createElementNS(NS, "line");
    const dot = document.createElementNS(NS, "circle");
    dot.setAttribute("r", "6");
    leaders.appendChild(line);
    leaders.appendChild(dot);
    labelEls.push(el); indexEls.push(el.firstChild); lines.push(line); dots.push(dot);
  });

  // ---------- 画布与等轴测投影（正交，绕 Y 45°，俯角 arctan(1/√2)） ----------
  const canvas = stage.querySelector(".es-canvas");
  const pr = Math.min(2, Math.max(1, (SLATE.width || 1920) / 1920));
  canvas.width = Math.round(1920 * pr);
  canvas.height = Math.round(1080 * pr);
  const ctx = canvas.getContext("2d");

  const parseColor = (str, fb) => {
    ctx.fillStyle = fb;
    ctx.fillStyle = String(str).trim();
    const h = ctx.fillStyle;
    if (/^#[0-9a-f]{6}$/i.test(h)) return [1, 3, 5].map((p) => parseInt(h.slice(p, p + 2), 16));
    const m = h.match(/[\d.]+/g);
    return m ? m.slice(0, 3).map(Number) : [10, 132, 255];
  };
  const ACCENT = parseColor(theme["--kit-accent"], "#0a84ff");
  const GLYPH_REST = [0xc9, 0xcc, 0xd3];
  const INK_REST = [0x8b, 0x90, 0x9a];
  const mix = (a, b, w) => a.map((v, j) => Math.round(v + (b[j] - v) * w));
  const hex = (c) => "#" + c.map((v) => v.toString(16).padStart(2, "0")).join("");

  const S = 1080 / (2 * 5.9);            // 每个世界单位的像素
  const C = [1.9, 0.7, -1.9];            // 画面中心对应的世界点（相机目标沿右轴平移后）
  const R6 = Math.sqrt(6), R2 = Math.SQRT2;
  const proj = (x, y, z) => {
    const dx = x - C[0], dy = y - C[1], dz = z - C[2];
    return [960 + S * (dx - dz) / R2, 540 - S * (-dx + 2 * dy - dz) / R6];
  };
  const EX = [S / R2, S / R6];            // 世界 x 方向在屏幕上的增量
  const EZ = [-S / R2, S / R6];           // 世界 z 方向在屏幕上的增量
  const planeTransform = (x0, y, z0, unit) => {
    const O = proj(x0, y, z0);
    ctx.setTransform(pr, 0, 0, pr, 0, 0);
    ctx.transform(EX[0] * unit, EX[1] * unit, EZ[0] * unit, EZ[1] * unit, O[0], O[1]);
  };
  const poly = (pts, fill) => {
    ctx.beginPath();
    pts.forEach((p, j) => { const q = proj(p[0], p[1], p[2]); j ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1]); });
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
  };

  // 每层的图案（在 512×512 的面坐标里画）
  function drawGlyph(g, i, color) {
    g.strokeStyle = g.fillStyle = color;
    g.lineWidth = 6;
    if (i === 0) {
      for (let n = 0; n < 3; n++) g.strokeRect(70 + n * 130, 150, 110, 212);
    } else if (i === 1) {
      g.beginPath();
      for (let n = 0; n < 5; n++) { g.moveTo(80, 110 + n * 72); g.lineTo(432, 110 + n * 72); }
      g.stroke();
    } else if (i === 2) {
      for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) g.fillRect(96 + x * 120, 96 + y * 120, 80, 80);
    } else {
      for (let n = 0; n < 3; n++) { g.beginPath(); g.ellipse(256, 150 + n * 100, 150, 40, 0, 0, Math.PI * 2); g.stroke(); }
    }
  }

  const LAYERS = 4, THICK = 0.22, GAP = 1.55, HALF = 2.1, FACE = 4.04;

  function drawPlate(i, y, glyphColor) {
    const yt = y + THICK / 2, yb = y - THICK / 2;
    ctx.setTransform(pr, 0, 0, pr, 0, 0);
    ctx.lineJoin = "round";
    // 朝 +z 的侧面（受光较多）
    poly([[-HALF, yb, HALF], [HALF, yb, HALF], [HALF, yt, HALF], [-HALF, yt, HALF]], "#eceef2");
    // 朝 +x 的侧面
    poly([[HALF, yb, HALF], [HALF, yb, -HALF], [HALF, yt, -HALF], [HALF, yt, HALF]], "#dfe2e8");
    // 顶面外沿
    poly([[-HALF, yt, -HALF], [HALF, yt, -HALF], [HALF, yt, HALF], [-HALF, yt, HALF]], "#fbfbfc");
    // 顶面（贴图坐标：画布 x→世界 x，画布 y→世界 z）
    planeTransform(-FACE / 2, yt, -FACE / 2, FACE / 512);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, 512, 512);
    ctx.strokeStyle = "#d6d8dd";
    ctx.lineWidth = 3;
    ctx.strokeRect(1.5, 1.5, 509, 509);
    drawGlyph(ctx, i, glyphColor);
  }

  function drawShadow() {
    planeTransform(-3.5, -2.4, -3.5, 7 / 256);
    const g = ctx.createRadialGradient(128, 128, 40, 128, 128, 128);
    g.addColorStop(0, "rgba(20,24,40,0.22)");
    g.addColorStop(1, "rgba(20,24,40,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 256, 256);
  }

  // ---------- 节拍（秒，按 5 秒原长） ----------
  const OPEN_AT = 0.3, OPEN_FOR = 0.9, OPEN_STAGGER = 0.06;
  const LAND_AT = 1.25, LAND_EVERY = 0.7, DRAW = 0.3, FULL = 0.4, SETTLE = 0.3;
  const CLOSE_AT = LAND_AT + (LAYERS - 1) * LAND_EVERY + 0.7;
  const CLOSE_FOR = 0.6, CLOSE_STAGGER = 0.05, LIFT = 0.08;
  const CLOSE_LEN = 0.05 + (LAYERS - 1) * CLOSE_STAGGER + CLOSE_FOR;
  const clamp01 = (x) => Math.min(1, Math.max(0, x));
  const ease = (x) => { const u = clamp01(x); return u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2; };
  const easeOut = (x) => 1 - Math.pow(1 - clamp01(x), 3);
  const easeOpen = (x) => easeOut(Math.pow(clamp01(x), 1.4));
  const focus = (T, i) => {
    const land = LAND_AT + i * LAND_EVERY;
    return easeOut((T - land + DRAW) / DRAW) * (1 - ease((T - land - FULL) / SETTLE));
  };

  // 时间映射：入场按 k 缩放，展开后停留，合拢放在镜头末尾
  const ce = Math.min(1, k);
  const closeStart = Math.max(CLOSE_AT * k, exitAt(CLOSE_LEN * ce));
  const mapT = (t) => (t >= closeStart ? CLOSE_AT + (t - closeStart) / ce : Math.min(t / k, CLOSE_AT));

  function draw(t) {
    const T = mapT(t);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    drawShadow();
    const ys = [], ws = [];
    for (let i = 0; i < LAYERS; i++) {
      const order = LAYERS - 1 - i;
      const open = easeOpen((T - OPEN_AT - i * OPEN_STAGGER) / OPEN_FOR) -
        ease((T - CLOSE_AT - 0.05 - order * CLOSE_STAGGER) / CLOSE_FOR);
      ws[i] = focus(T, i);
      ys[i] = order * (THICK + 0.02 + open * GAP) - 2.2 + LIFT * ws[i];
    }
    // 从下往上画，上层遮住下层
    for (let i = LAYERS - 1; i >= 0; i--) drawPlate(i, ys[i], hex(mix(GLYPH_REST, ACCENT, ws[i])));

    for (let i = 0; i < LAYERS; i++) {
      const inkHex = hex(mix(INK_REST, ACCENT, ws[i]));
      indexEls[i].style.color = inkHex;
      dots[i].style.fill = inkHex;
      const shown = easeOut((T - LAND_AT - i * LAND_EVERY + DRAW) / DRAW) * (1 - clamp01((T - CLOSE_AT) / 0.2));
      const [ax, ay] = proj(HALF, ys[i], -HALF);
      const lx = ax + 90;
      labelEls[i].style.opacity = shown.toFixed(3);
      labelEls[i].style.transform = `translate(${Math.round(lx + 24 + (1 - shown) * 16)}px, ${Math.round(ay - 22)}px)`;
      lines[i].setAttribute("x1", ax.toFixed(1));
      lines[i].setAttribute("y1", ay.toFixed(1));
      lines[i].setAttribute("x2", (ax + 90 * shown).toFixed(1));
      lines[i].setAttribute("y2", ay.toFixed(1));
      lines[i].style.opacity = shown > 0 ? 1 : 0;
      dots[i].setAttribute("cx", ax.toFixed(1));
      dots[i].setAttribute("cy", ay.toFixed(1));
      dots[i].style.opacity = shown.toFixed(3);
    }
  }

  draw(0);
  const tl = SLATE.timeline();
  tl.call((p) => draw(p * d), { at: 0, dur: d, ease: "linear" });
  return tl;
};
