/* 改编自 Apache-2.0 许可的开源素材，动画和写法有改动。许可证原文见 /opt/slate/licenses/kit/LICENSE */
import * as THREE from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

KIT.shots = KIT.shots || {};
KIT.shots["product-turntable"] = function (root, o = {}) {
  const content = Object.assign({
    model_url: "",                 // GLB/glTF 地址，留空用内置饮料罐
    product_name: "柚子",            // 标签大字
    flavor: "气泡柑橘",              // 标签口味行
    volume: "355 ML",               // 标签接缝处小字
    caption: "气泡柑橘 · 355 毫升",   // 左下说明文字
    turns: 1,                       // 整段转几圈
  }, o.content);
  const theme = Object.assign({
    "--kit-bg": "#e8e4dc",
    "--kit-label": "#f2c230",
    "--kit-ink": "#1d2a24",
    "--kit-caption": "rgba(20, 22, 24, 0.62)",
    "--kit-font": "\"Inter\", \"Noto Sans CJK SC\", system-ui, sans-serif",
  }, o.theme);
  const { d } = KIT.fit(6, o.dur);
  const hex = (v, f) => (/^#[0-9a-f]{6}$/i.test(String(v)) ? String(v) : f);
  const turns = Math.max(1, Math.min(4, Math.round(Number(content.turns) || 1)));
  const FONT = theme["--kit-font"];

  KIT.css("product-turntable", `
    .kit-product-turntable{overflow:hidden;
      background:radial-gradient(1100px 760px at 50% 38%, rgba(255,255,255,0.72), transparent 70%), var(--kit-bg);}
    .kit-product-turntable .pt-canvas{position:absolute;left:0;top:0;width:1920px;height:1080px;display:block;}
    .kit-product-turntable .pt-caption{position:absolute;left:96px;bottom:250px;
      font:500 30px/1 var(--kit-font);letter-spacing:0.01em;color:var(--kit-caption);white-space:nowrap;}
  `);
  const stage = KIT.stage(root, 1920, 1080);
  stage.classList.add("kit-product-turntable");
  KIT.theme(stage, theme);
  stage.innerHTML = `<canvas class="pt-canvas" width="1920" height="1080"></canvas><div class="pt-caption"></div>`;
  stage.querySelector(".pt-caption").textContent = content.caption || "";

  // 字体
  const href = "/assets/fonts/lib/inter.css";
  let link = document.querySelector(`link[href="${href}"]`);
  let linkP;
  if (!link) {
    link = document.createElement("link");
    link.rel = "stylesheet"; link.href = href;
    linkP = new Promise((r) => { link.onload = r; link.onerror = r; });
    document.head.appendChild(link);
  } else linkP = Promise.resolve();
  const txt = String(content.product_name) + content.flavor + content.caption + content.volume;
  const fontsP = linkP.then(() => Promise.all([
    document.fonts.load('800 280px "Inter"'),
    document.fonts.load('500 30px "Inter"'),
    document.fonts.load('800 280px "Noto Sans CJK SC"', txt).catch(() => {}),
    document.fonts.load('500 30px "Noto Sans CJK SC"', txt).catch(() => {}),
  ])).catch(() => {});

  // 渲染器与场景
  const renderer = new THREE.WebGLRenderer({
    canvas: stage.querySelector(".pt-canvas"), antialias: true, alpha: true, preserveDrawingBuffer: true,
  });
  renderer.setPixelRatio(1);
  renderer.setSize(1920, 1080, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.3;

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  const studio = new THREE.Scene();
  const room = new RoomEnvironment();
  room.traverse((ob) => {
    if (ob.isLight) ob.intensity *= 0.3;
    if (ob.material && ob.material.emissiveIntensity) ob.material.emissiveIntensity *= 0.3;
  });
  studio.add(room);
  for (const [deg, intensity] of [[-35, 5], [120, 8]]) {
    const strip = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 8), new THREE.MeshLambertMaterial({
      color: 0x000000, emissive: 0xffffff, emissiveIntensity: intensity, side: THREE.DoubleSide,
    }));
    const a = THREE.MathUtils.degToRad(deg);
    strip.position.set(6 * Math.sin(a), 1, 6 * Math.cos(a));
    strip.lookAt(0, 1, 0);
    studio.add(strip);
  }
  scene.environment = pmrem.fromScene(studio, 0.02).texture;

  const camera = new THREE.PerspectiveCamera(24, 1920 / 1080, 0.1, 100);
  camera.position.set(0, 2.1, 9.4);
  camera.lookAt(0, 0.9, 0);

  const key = new THREE.DirectionalLight(0xffffff, 1.6);
  key.position.set(-3.5, 5, 4); scene.add(key);
  const rim = new THREE.DirectionalLight(0xfff1dc, 2.2);
  rim.position.set(4, 3, -4); scene.add(rim);

  const plinth = new THREE.Mesh(new THREE.CylinderGeometry(1.42, 1.46, 0.2, 96),
    new THREE.MeshStandardMaterial({ color: 0xf4f1ec, roughness: 0.55, metalness: 0 }));
  plinth.position.y = -0.1; scene.add(plinth);

  function radialTexture(inner, outer) {
    const c = document.createElement("canvas");
    c.width = c.height = 256;
    const g = c.getContext("2d");
    const grad = g.createRadialGradient(128, 128, 0, 128, 128, 128);
    grad.addColorStop(0, inner); grad.addColorStop(1, outer);
    g.fillStyle = grad; g.fillRect(0, 0, 256, 256);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }
  const shadow = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 2.4), new THREE.MeshBasicMaterial({
    map: radialTexture("rgba(0,0,0,0.55)", "rgba(0,0,0,0)"), transparent: true, depthWrite: false,
  }));
  shadow.rotation.x = -Math.PI / 2; shadow.position.y = 0.002; scene.add(shadow);

  const turntable = new THREE.Group();
  scene.add(turntable);

  function labelTexture() {
    const c = document.createElement("canvas");
    c.width = 2048; c.height = 872; // 2.35:1，与标签周长/高度一致
    const g = c.getContext("2d");
    g.fillStyle = hex(theme["--kit-label"], "#f2c230");
    g.fillRect(0, 0, 2048, 872);
    g.fillStyle = hex(theme["--kit-ink"], "#1d2a24");
    g.fillRect(0, 70, 2048, 12);
    g.fillRect(0, 790, 2048, 12);
    const name = String(content.product_name || "").toUpperCase();
    const flavor = String(content.flavor || "").toUpperCase();
    for (const cx of [512, 1536]) {
      g.save();
      g.textAlign = "center"; g.textBaseline = "middle";
      let size = 280;
      g.font = `800 ${size}px ${FONT}`;
      while (g.measureText(name).width > 600 && size > 80) { size -= 10; g.font = `800 ${size}px ${FONT}`; }
      g.fillText(name, cx, 400);
      g.font = `800 50px ${FONT}`;
      g.globalAlpha = 0.8;
      g.fillText(flavor, cx, 590, 540);
      g.restore();
    }
    g.save();
    g.textAlign = "center";
    g.font = `800 34px ${FONT}`;
    g.globalAlpha = 0.7;
    for (const cx of [0, 1024, 2048]) g.fillText(String(content.volume || ""), cx, 450);
    g.restore();
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
    return tex;
  }

  function builtInCan() {
    const can = new THREE.Group();
    const metal = new THREE.MeshStandardMaterial({ color: 0xd4d7dc, metalness: 1, roughness: 0.24 });
    const profile = [
      [0.0, 0.1], [0.46, 0.06], [0.6, 0.0], [0.66, 0.06], [0.67, 0.16], [0.67, 2.02], [0.63, 2.14],
      [0.56, 2.24], [0.555, 2.29], [0.575, 2.31], [0.56, 2.33], [0.5, 2.3], [0.0, 2.27],
    ].map(([x, y]) => new THREE.Vector2(x, y));
    can.add(new THREE.Mesh(new THREE.LatheGeometry(profile, 128), metal));
    const labelMat = new THREE.MeshPhysicalMaterial({
      map: labelTexture(), metalness: 0.45, roughness: 0.32, clearcoat: 1, clearcoatRoughness: 0.12,
    });
    const label = new THREE.Mesh(new THREE.CylinderGeometry(0.674, 0.674, 1.8, 128, 1, true), labelMat);
    label.position.y = 1.1; can.add(label);
    const tab = new THREE.Mesh(new THREE.CapsuleGeometry(0.07, 0.22, 4, 12), metal);
    tab.rotation.set(Math.PI / 2, 0, Math.PI / 2);
    tab.scale.set(1, 1, 0.25);
    tab.position.set(0.1, 2.285, 0);
    can.add(tab);
    return can;
  }

  function fitModel(object) {
    const box = new THREE.Box3().setFromObject(object);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const scale = Math.min(2.3 / size.y, 2.6 / Math.max(size.x, size.z));
    object.scale.setScalar(scale);
    object.position.set(-center.x * scale, -box.min.y * scale, -center.z * scale);
    const wrapper = new THREE.Group();
    wrapper.add(object);
    return wrapper;
  }

  let lastP = 0;
  function draw(p) {
    lastP = p;
    turntable.rotation.y = p * turns * Math.PI * 2;
    renderer.render(scene, camera);
  }

  const ready = (async () => {
    await fontsP;
    const url = String(content.model_url || "").trim();
    let obj;
    if (url) {
      try { obj = fitModel((await new GLTFLoader().loadAsync(url)).scene); }
      catch (e) { console.error("[product-turntable] 模型加载失败，改用内置饮料罐", e); obj = builtInCan(); }
    } else obj = builtInCan();
    turntable.add(obj);
    draw(lastP);
  })();
  (SLATE.waits = SLATE.waits || []).push(ready);

  const tl = SLATE.timeline();
  tl.call((p) => draw(p), { at: 0, dur: d, ease: "linear" });
  return tl;
};
