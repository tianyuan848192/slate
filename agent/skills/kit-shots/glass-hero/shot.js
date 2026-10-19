/* 改编自 Apache-2.0 许可的开源素材，动画和写法有改动。许可证原文见 /opt/slate/licenses/kit/LICENSE */
KIT.shots = KIT.shots || {};

KIT.shots["glass-hero"] = function (root, o = {}) {
  const content = Object.assign({
    headline: "澄澈", // 玻璃后面的巨型标题
    subline: "每一处细节，都清晰可见，毫无遮挡。", // 底部副标题
    shape: "lens", // 玻璃形状：lens 透镜 / ring 圆环
  }, o.content);
  const theme = Object.assign({
    "--gh-bg": "#0b0b0c",
    "--gh-type": "#f4efe4",
    "--gh-tint": "#cfe9ff",
    "--gh-sub": "rgba(244, 239, 228, 0.78)",
    "--kit-font": "\"Inter\", \"Noto Sans CJK SC\", sans-serif",
    "--kit-font-caption": "\"Inter\", \"Noto Sans CJK SC\", sans-serif",
  }, o.theme);
  const { k, d } = KIT.fit(5, o.dur);
  const hex = (v, fb) => (/^#[0-9a-f]{6}$/i.test(String(v).trim()) ? String(v).trim() : fb);
  const bg = hex(theme["--gh-bg"], "#0b0b0c");
  const typeColor = hex(theme["--gh-type"], "#f4efe4");
  const tint = hex(theme["--gh-tint"], "#cfe9ff");
  const headFont = theme["--kit-font"];
  const lens = content.shape !== "ring";

  // 字体样式表
  const fontHref = "/assets/fonts/lib/inter.css";
  let link = document.querySelector(`link[data-kit-font="${fontHref}"]`);
  if (!link) {
    link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = fontHref;
    link.setAttribute("data-kit-font", fontHref);
    link._kitReady = new Promise((res) => { link.onload = res; link.onerror = res; });
    document.head.appendChild(link);
  }
  const cssReady = link._kitReady || Promise.resolve();

  KIT.css("glass-hero", `
    .kit-glass-hero { background: var(--gh-bg); overflow: hidden; }
    .kit-glass-hero .gh-canvas { position: absolute; left: 0; top: 0; width: 1920px; height: 1080px; display: block; }
    .kit-glass-hero .gh-subline {
      position: absolute; left: 96px; right: 96px; bottom: 240px; text-align: center;
      font: 500 36px/1.2 var(--kit-font-caption); letter-spacing: 0.01em;
      color: var(--gh-sub); opacity: 0; white-space: nowrap;
    }
  `);
  const stage = KIT.stage(root, 1920, 1080);
  stage.classList.add("kit-glass-hero");
  KIT.theme(stage, theme);
  stage.innerHTML = `<canvas class="gh-canvas" width="1920" height="1080"></canvas><div class="gh-subline"></div>`;
  const canvas = stage.querySelector(".gh-canvas");
  const subline = stage.querySelector(".gh-subline");
  subline.textContent = content.subline || "";

  // ---------- 标题贴图（玻璃折射的就是这张图） ----------
  const tc = document.createElement("canvas");
  tc.width = 3840;
  tc.height = 2160;
  const g2 = tc.getContext("2d");
  const drawHeadline = () => {
    g2.fillStyle = bg;
    g2.fillRect(0, 0, tc.width, tc.height);
    const text = String(content.headline || "澄澈").toUpperCase();
    let size = 1000;
    g2.font = `900 ${size}px ${headFont}`;
    while (g2.measureText(text).width > 3100 && size > 200) {
      size -= 20;
      g2.font = `900 ${size}px ${headFont}`;
    }
    g2.textAlign = "center";
    g2.textBaseline = "middle";
    g2.fillStyle = typeColor;
    g2.fillText(text, tc.width / 2, tc.height * 0.47);
  };

  // ---------- WebGL：全屏着色器，透镜解析求交 / 圆环步进求交 ----------
  const gl = canvas.getContext("webgl2", { preserveDrawingBuffer: true, antialias: false, premultipliedAlpha: false });
  const VS = `#version 300 es
  in vec2 p; void main(){ gl_Position = vec4(p, 0.0, 1.0); }`;
  const FS = `#version 300 es
  precision highp float;
  uniform vec2 uRes; uniform sampler2D uTex; uniform vec3 uPos; uniform float uScale;
  uniform mat3 uRot; uniform int uShape; uniform vec3 uAtt;
  out vec4 outC;
  const vec3 CAM = vec3(0.0, 0.0, 10.0);
  const float TANH = 0.26794919;
  const float ASP = 1.7777778;
  const float PH = 2.0 * 0.26794919 * 12.0;
  vec3 backdrop(vec3 dir){
    float t = (-2.0 - CAM.z) / dir.z;
    vec3 p = CAM + dir * t;
    vec2 uv = vec2(p.x / (PH * ASP) + 0.5, p.y / PH + 0.5);
    return pow(texture(uTex, uv).rgb, vec3(2.2));
  }
  float softbox(vec3 rd, vec3 c, vec2 hs, float lv){
    vec3 z = normalize(-c);
    vec3 x = normalize(cross(vec3(0.0, 1.0, 0.0), z));
    vec3 y = cross(z, x);
    float den = dot(rd, -z);
    if (den <= 0.0) return 0.0;
    float t = dot(c, -z) / den;
    vec3 q = rd * t - c;
    float u = abs(dot(q, x)), v = abs(dot(q, y));
    return lv * (1.0 - smoothstep(hs.x - 0.06, hs.x + 0.06, u)) * (1.0 - smoothstep(hs.y - 0.06, hs.y + 0.06, v));
  }
  vec3 env(vec3 rd){
    float l = 0.08;
    l = max(l, softbox(rd, vec3(-1.0, 6.0, 2.0), vec2(4.0, 1.5), 2.5));
    l = max(l, softbox(rd, vec3(-7.0, 0.0, -1.0), vec2(0.6, 4.5), 4.0));
    l = max(l, softbox(rd, vec3(7.0, 0.0, -1.0), vec2(0.6, 4.5), 4.0));
    return vec3(l);
  }
  bool hitLens(vec3 ro, vec3 rd, out float t, out vec3 n){
    vec3 r = vec3(1.6, 1.6, 0.672);
    vec3 o = ro / r, dd = rd / r;
    float a = dot(dd, dd), b = dot(o, dd), c = dot(o, o) - 1.0;
    float h = b * b - a * c;
    if (h < 0.0) return false;
    t = (-b - sqrt(h)) / a;
    if (t < 0.0) return false;
    vec3 q = ro + rd * t;
    n = normalize(q / (r * r));
    return true;
  }
  float sdTorus(vec3 p){ return length(vec2(length(p.xy) - 1.25, p.z)) - 0.46; }
  bool hitTorus(vec3 ro, vec3 rd, out float t, out vec3 n){
    float b = dot(ro, rd), c = dot(ro, ro) - 1.75 * 1.75;
    float h = b * b - c;
    if (h < 0.0) return false;
    h = sqrt(h);
    t = max(0.0, -b - h);
    float tmax = -b + h;
    for (int i = 0; i < 80; i++){
      vec3 p = ro + rd * t;
      float dd = sdTorus(p);
      if (dd < 0.0004){
        vec3 ring = 1.25 * normalize(vec3(p.xy, 0.0) + vec3(1e-6, 0.0, 0.0));
        n = normalize(p - ring);
        return true;
      }
      t += dd;
      if (t > tmax) return false;
    }
    return false;
  }
  vec3 shade(vec2 frag){
    vec2 ndc = frag / uRes * 2.0 - 1.0;
    vec3 rd = normalize(vec3(ndc.x * ASP * TANH, ndc.y * TANH, -1.0));
    vec3 ro = (CAM - uPos) * uRot / uScale;
    vec3 rdo = rd * uRot;
    float t; vec3 no;
    bool hit = (uShape == 0) ? hitLens(ro, rdo, t, no) : hitTorus(ro, rdo, t, no);
    if (!hit) return backdrop(rd);
    vec3 n = normalize(uRot * no);
    vec3 hp = CAM + rd * t * uScale;
    float th = 0.6 * uScale;
    float ior = 1.3, hs = 0.02;
    vec3 col;
    col.r = backdrop(normalize(hp + refract(rd, n, 1.0 / (ior - hs)) * th - CAM)).r;
    col.g = backdrop(normalize(hp + refract(rd, n, 1.0 / ior) * th - CAM)).g;
    col.b = backdrop(normalize(hp + refract(rd, n, 1.0 / (ior + hs)) * th - CAM)).b;
    col *= exp(-uAtt * th);
    float cosi = clamp(dot(-rd, n), 0.0, 1.0);
    float fp = pow(1.0 - cosi, 5.0);
    float F = 0.017 + 0.983 * fp;
    float Fc = 0.04 + 0.96 * fp;
    float Ft = clamp(F + Fc * (1.0 - F), 0.0, 1.0);
    vec3 refl = env(reflect(rd, n));
    vec3 L = normalize(vec3(-4.0, 5.0, 6.0));
    vec3 H = normalize(L - rd);
    float spec = pow(max(dot(n, H), 0.0), 1500.0) * 60.0 * 2.4 * max(dot(n, L), 0.0) * Ft;
    return col * (1.0 - Ft) + refl * Ft + vec3(spec);
  }
  void main(){
    vec2 f = gl_FragCoord.xy;
    vec2 ndc = f / uRes * 2.0 - 1.0;
    vec3 rd = normalize(vec3(ndc.x * ASP * TANH, ndc.y * TANH, -1.0));
    vec3 oc = CAM - uPos;
    float R = 1.85 * uScale;
    float b = dot(oc, rd), c = dot(oc, oc) - R * R;
    vec3 c3;
    if (b * b - c < 0.0) {
      c3 = backdrop(rd);
    } else {
      c3 = 0.25 * (shade(f + vec2(-0.25, -0.25)) + shade(f + vec2(0.25, -0.25)) + shade(f + vec2(-0.25, 0.25)) + shade(f + vec2(0.25, 0.25)));
    }
    outC = vec4(pow(clamp(c3, 0.0, 1.0), vec3(1.0 / 2.2)), 1.0);
  }`;

  let prog = null, U = {}, tex = null;
  if (gl) {
    const mk = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) console.error(gl.getShaderInfoLog(s));
      return s;
    };
    prog = gl.createProgram();
    gl.attachShader(prog, mk(gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, mk(gl.FRAGMENT_SHADER, FS));
    gl.bindAttribLocation(prog, 0, "p");
    gl.linkProgram(prog);
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    ["uRes", "uTex", "uPos", "uScale", "uRot", "uShape", "uAtt"].forEach((n) => (U[n] = gl.getUniformLocation(prog, n)));
    gl.uniform2f(U.uRes, 1920, 1080);
    gl.uniform1i(U.uTex, 0);
    gl.uniform1i(U.uShape, lens ? 0 : 1);
    const tl3 = [1, 3, 5].map((i) => Math.pow(parseInt(tint.slice(i, i + 2), 16) / 255, 2.2));
    gl.uniform3f(U.uAtt, ...tl3.map((c) => -Math.log(Math.max(c, 1e-4)) / 2.2));
    tex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    const aniso = gl.getExtension("EXT_texture_filter_anisotropic");
    if (aniso) gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT)));
    gl.viewport(0, 0, 1920, 1080);
  }
  const upload = () => {
    drawHeadline();
    if (!gl) return;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, tc);
    gl.generateMipmap(gl.TEXTURE_2D);
  };
  upload();

  // 字体加载完后重绘标题贴图
  const fontsReady = cssReady
    .then(() => Promise.all([
      document.fonts.load(`900 200px "Inter"`),
      document.fonts.load(`500 36px "Inter"`),
      document.fonts.load(`900 200px "Noto Sans CJK SC"`, content.headline || "澄"),
      document.fonts.load(`500 36px "Noto Sans CJK SC"`, content.subline || "字"),
    ]))
    .catch(() => {})
    .then(() => upload());
  if (SLATE.waits) SLATE.waits.push(fontsReady);

  // 欧拉角（XYZ 顺序）→ 列主序 3x3 旋转矩阵
  const rotMat = (x, y, z) => {
    const a = Math.cos(x), b = Math.sin(x), c = Math.cos(y), dd = Math.sin(y), e = Math.cos(z), f = Math.sin(z);
    const ae = a * e, af = a * f, be = b * e, bf = b * f;
    return new Float32Array([
      c * e, af + be * dd, bf - ae * dd,
      -c * f, ae - bf * dd, be + af * dd,
      dd, -b * c, a * c,
    ]);
  };

  const easeOut = (x) => 1 - Math.pow(1 - Math.min(1, Math.max(0, x)), 3);
  const riseDur = 1.8 * k;
  const renderAt = (t) => {
    if (!gl) return;
    // 先上升落定，之后一直转动，静帧也能看到文字在玻璃里移动
    const rise = easeOut(t / riseDur);
    gl.useProgram(prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform3f(U.uPos, Math.sin(t * 0.55) * 0.35, -3.2 * (1 - rise) + Math.sin(t * 0.9) * 0.06, 1.2);
    gl.uniform1f(U.uScale, 0.62 + 0.14 * rise);
    gl.uniformMatrix3fv(U.uRot, false, rotMat(
      lens ? Math.sin(t * 0.7) * 0.35 : 0.5 + t * 0.22,
      lens ? Math.sin(t * 0.5) * 0.5 + 0.2 : t * 0.34,
      lens ? 0 : 0.2 + t * 0.08
    ));
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };

  const tl = SLATE.timeline();
  tl.call((p) => renderAt(p * d), { at: 0, dur: d, ease: "linear" });
  tl.tween(subline, { opacity: [0, 1], y: [18, 0] }, { at: Math.min(1.5, d * 0.3), dur: 0.7 * k, ease: "outCubic" });
  return tl;
};
