/* 3D 预览：生成页和素材库共用。
   three.js 第一次用到时才加载（web/vendor/three，按 index.html 的导入映射解析）；模型代码来自 GET /api/tasks/{id}/module，
   在 Worker 里执行（model-worker.js），做出来的 THREE.Group 序列化后交回页面还原。WebGL 渲染器只在显示预览时创建，看不见时暂停渲染，dispose() 时释放。
   模型里有拆解数据（userData.sculptRuntime.explode）时，左上角多一个「拆开 / 合上」的滑杆（docs/library-3d-design.md 第六节） */

import { esc, reduceMotion } from './util.js';

let libs = null;
function loadThree() {
  libs ||= Promise.all([
    import('three'),
    import('three/addons/controls/OrbitControls.js'),
    import('three/addons/environments/RoomEnvironment.js'),
  ]).then(([THREE, oc, env]) => ({ THREE, OrbitControls: oc.OrbitControls, RoomEnvironment: env.RoomEnvironment }))
    .catch(e => { libs = null; throw e; });
  return libs;
}

const BG = 0xECEEF1;            // 影棚背景
const AZIMUTH = 35, ELEVATION = 16; // 初始角度：35 度斜侧、略微俯视（和素材的 35 度图一致）

/** 3D 素材的封面：35 度斜侧图，没有时用第一张 */
export const heroView = views => (Array.isArray(views) ? (views.find(v => v?.angle === 35) || views[0])?.url : null) || null;
/** 多角度图的说明：0 / 90 / 180 / 270 / 35 度 */
export const angleLabel = a => ({ 0: '正面', 90: '侧面', 180: '背面', 270: '侧面', 35: '斜侧' }[a] || '') + ` ${a}°`;

/* ---------- 拆解：算法和 agent/skills/kit-3d/explode.js 的 explodeAt 一样，改一边要一起改 ----------
   拆解数据：{steps: [{label, parts: [{id, offset: [x, y, z]}]}]}；offset 在零件父节点的坐标系里，单位和模型一致。
   t = 0 是组装好，t = 步数是全部拆开；第 i 步在 t 从 i 到 i+1 之间完成，缓入缓出。按 t 直接算姿态，可以任意跳 */
const ease = p => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);
const clamp01 = x => Math.min(1, Math.max(0, x));

/** 模型里的拆解步骤；没有拆解数据时是空数组 */
export function explodeSteps(model) {
  const e = model?.userData?.sculptRuntime?.explode;
  return Array.isArray(e?.steps) ? e.steps : [];
}

/** 把模型摆到拆开程度 t；第一次动某个零件时记下它组装好的位置（userData.__rest） */
export function explodeAt(model, t) {
  const nodes = model.userData.sculptRuntime?.nodes || {};
  explodeSteps(model).forEach((step, i) => {
    const p = ease(clamp01(t - i));
    for (const part of step?.parts || []) {
      const n = nodes[part?.id];
      if (!n || !Array.isArray(part.offset)) continue;
      if (!n.userData.__rest) n.userData.__rest = n.position.clone();
      const r = n.userData.__rest, [x, y, z] = part.offset.map(v => Number(v) || 0);
      n.position.set(r.x + x * p, r.y + y * p, r.z + z * p);
    }
  });
}

/** 正在拆的那一步（0 开始；还没开始拆时是 -1），和 kit-3d 的 stepAt 一样 */
const stepAt = (n, t) => (t <= 0 || !n ? -1 : Math.min(n - 1, Math.floor(t - 1e-6)));
const STEP_MS = 1200; // 按钮动画：每一步 1.2 秒

const MODEL_TIMEOUT = 30000; // 模型代码最多跑这么久

/** 在 Worker 里运行模型代码（model-worker.js，不在网站页面里执行），把做出来的 3D 对象还原回来 */
async function buildModel(data) {
  const { code, factory } = data || {};
  if (typeof code !== 'string' || !code || typeof factory !== 'string' || !factory) throw new Error('模型数据不完整');
  const { THREE } = await loadThree();
  const json = await new Promise((ok, no) => {
    const w = new Worker(new URL('./model-worker.js', import.meta.url), { type: 'module' });
    const done = (f, v) => { clearTimeout(timer); w.terminate(); f(v); };
    const timer = setTimeout(() => done(no, new Error('模型代码运行太久')), MODEL_TIMEOUT);
    w.onmessage = ({ data: r }) => {
      if (r?.json) return done(ok, r.json);
      if (r?.detail) console.warn('3D 模型代码出错：', r.detail);
      done(no, new Error(r?.error || '模型代码运行出错'));
    };
    w.onerror = () => done(no, new Error('模型代码运行出错'));
    w.postMessage({ code, factory });
  });
  let obj;
  try { obj = await new THREE.ObjectLoader().parseAsync(json); } catch { throw new Error('模型代码运行出错'); }
  // userData 里的 {$uuid} 接回对应的 3D 对象：拆解数据 sculptRuntime.nodes 靠它找零件
  const byId = new Map();
  obj.traverse(o => byId.set(o.uuid, o));
  const relink = v => (Array.isArray(v) ? v.map(relink)
    : v && typeof v === 'object' ? (typeof v.$uuid === 'string' && Object.keys(v).length === 1 ? byId.get(v.$uuid) ?? null
      : Object.fromEntries(Object.entries(v).map(([k, x]) => [k, relink(x)]))) : v);
  obj.traverse(o => { if (Object.keys(o.userData).length) o.userData = relink(o.userData); });
  return obj;
}

function disposeTree(obj) {
  obj?.traverse(o => {
    o.geometry?.dispose();
    for (const m of [].concat(o.material || [])) {
      for (const v of Object.values(m)) if (v?.isTexture) v.dispose();
      m.dispose();
    }
  });
}

/**
 * 在 host 里放一个 3D 预览。host 要有确定的尺寸（比如 position: absolute; inset: 0）。
 * 返回 {load(fetchModule, label), dispose()}；fetchModule() 返回 {code, factory}，出错时可以点「重试」再调一次。
 */
export function mountViewer(host) {
  host.classList.add('viewer3d');
  host.innerHTML = `<div class="v3-msg" role="status"></div>
    <div class="v3-bar">
      <span class="v3-hint">拖动旋转，滚轮缩放</span>
      <button type="button" class="v3-btn" data-v="spin" aria-pressed="false" title="自动旋转"><svg aria-hidden="true"><use href="#i-rotate"/></svg><span class="sr-only">自动旋转</span></button>
      <button type="button" class="v3-btn" data-v="reset" title="回到初始角度"><svg aria-hidden="true"><use href="#i-reset"/></svg><span class="sr-only">回到初始角度</span></button>
      <button type="button" class="v3-btn" data-v="fs" title="全屏"><svg aria-hidden="true"><use href="#i-expand"/></svg><span class="sr-only">全屏</span></button>
    </div>
    <div class="v3-ex" role="group" aria-label="拆解" hidden>
      <div class="v3-ex-row">
        <label class="v3-ex-k"><span aria-hidden="true">拆开</span><input type="range" min="0" max="1" step="0.01" value="0" aria-label="拆开程度"></label>
        <button type="button" class="v3-tbtn" data-x="open">拆开</button>
        <button type="button" class="v3-tbtn" data-x="close">合上</button>
      </div>
      <p class="v3-ex-step" aria-hidden="true"></p>
      <span class="sr-only" role="status"></span>
    </div>`;
  const msg = host.querySelector('.v3-msg');
  const bar = host.querySelector('.v3-bar');
  const spinBtn = host.querySelector('[data-v=spin]');
  const exBox = host.querySelector('.v3-ex');
  const slider = exBox.querySelector('input');
  bar.hidden = true;

  let g = null;        // three.js 的对象：渲染器、场景、相机、控制器、灯光、地面
  let model = null;
  let fetcher = null, title = '';
  let seq = 0, raf = 0, visible = true, disposed = false;
  let ex = null;       // 拆解：{steps, n, t（当前拆开程度）, anim（按钮动画的 rAF）}；模型没有拆解数据时是 null
  let resumeSpin = false; // 拖滑杆时先停下自动旋转，松手后接着转

  function say(html) { msg.innerHTML = html; }
  const running = () => g && model && visible && !document.hidden && !disposed;
  function tick() {
    raf = 0;
    if (!running()) return;
    g.controls.update();
    g.renderer.render(g.scene, g.camera);
    raf = requestAnimationFrame(tick);
  }
  const wake = () => { if (!raf && running()) raf = requestAnimationFrame(tick); };

  function setSpin(on) {
    if (!g) return;
    g.controls.autoRotate = on;
    spinBtn.setAttribute('aria-pressed', on);
  }

  function resize() {
    if (!g) return;
    const w = host.clientWidth, h = host.clientHeight;
    if (!w || !h) return;
    g.renderer.setSize(w, h, false);
    g.camera.aspect = w / h;
    g.camera.updateProjectionMatrix();
    if (model) frame(false);
  }

  const io = new IntersectionObserver(es => { visible = es[es.length - 1].isIntersecting; wake(); });
  const ro = new ResizeObserver(resize);
  io.observe(host);
  ro.observe(host);
  document.addEventListener('visibilitychange', wake);

  function setup({ THREE, OrbitControls, RoomEnvironment }) {
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    const canvas = renderer.domElement;
    canvas.className = 'v3-canvas';
    canvas.tabIndex = 0;
    canvas.setAttribute('role', 'img');
    host.prepend(canvas);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(BG);
    // 影棚光：RoomEnvironment 做环境反射，再加一盏主光投影
    const pmrem = new THREE.PMREMGenerator(renderer);
    const room = new RoomEnvironment();
    const env = pmrem.fromScene(room, 0.04).texture;
    room.dispose();
    pmrem.dispose();
    scene.environment = env;
    const key = new THREE.DirectionalLight(0xffffff, 1.2);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.bias = -0.0005;
    scene.add(key, key.target);
    // 地面只显示柔和的投影
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShadowMaterial({ opacity: 0.2 }));
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);

    const camera = new THREE.PerspectiveCamera(30, 1, 0.01, 100);
    const controls = new OrbitControls(camera, canvas);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.enablePan = false;
    controls.autoRotateSpeed = 1.6;
    controls.maxPolarAngle = Math.PI * 0.52; // 最多平视略低一点，不钻到地面下面
    controls.addEventListener('start', () => setSpin(false));
    g = { THREE, renderer, scene, camera, controls, key, ground, env, canvas, base: null };

    canvas.addEventListener('keydown', onKey);
    resize();
  }

  /* 取景半径和对准的高度：组装好时按模型本身；有拆解时按拆开程度在"组装好"和"全部拆开"之间插值，拆开时镜头跟着拉远 */
  const fitR = () => g.base.radius + (g.base.radiusEx - g.base.radius) * (ex ? ex.t / ex.n : 0);
  const fitY = () => g.base.cy + (g.base.cyEx - g.base.cy) * (ex ? ex.t / ex.n : 0);

  /** 按模型大小摆相机、灯光和地面；first 为 true 时回到初始角度 */
  function frame(first) {
    const { THREE, camera, controls, key, ground } = g;
    const r = fitR(), cy = fitY();
    const vfov = THREE.MathUtils.degToRad(camera.fov);
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * camera.aspect);
    const dist = (r / Math.sin(Math.min(vfov, hfov) / 2)) * 1.05;
    controls.minDistance = r * 1.2;
    controls.maxDistance = dist * 3;
    camera.near = dist / 100;
    camera.far = dist * 20;
    camera.updateProjectionMatrix();
    if (!first) return;
    const az = THREE.MathUtils.degToRad(AZIMUTH), el = THREE.MathUtils.degToRad(ELEVATION);
    controls.target.set(0, cy, 0);
    camera.position.set(Math.sin(az) * Math.cos(el) * dist, cy + Math.sin(el) * dist, Math.cos(az) * Math.cos(el) * dist);
    controls.update();
    controls.saveState();
    // 灯光、投影和地面按全部拆开时的大小算，拆开后零件也有影子
    const rr = Math.max(g.base.radius, g.base.radiusEx);
    ground.scale.setScalar(rr * 12);
    key.position.set(rr * 1.6, rr * 4, rr * 2.4);
    const sc = key.shadow.camera;
    sc.left = sc.bottom = -rr * 1.8;
    sc.right = sc.top = rr * 1.8;
    sc.near = rr * 0.5;
    sc.far = rr * 10;
    sc.updateProjectionMatrix();
    key.shadow.normalBias = rr * 0.01;
  }

  /* ---------- 拆解滑杆 ---------- */

  function exText(t) {
    const i = stepAt(ex.n, t);
    if (i < 0) return { line: `共 ${ex.n} 步，拖动滑杆或点「拆开」`, value: '组装好' };
    const label = String(ex.steps[i]?.label || '').trim() || `第 ${i + 1} 步`;
    return { line: `第 ${i + 1} / ${ex.n} 步：${label}`, value: t >= ex.n ? `全部拆开，共 ${ex.n} 步` : `第 ${i + 1} 步，${label}` };
  }

  /** 摆到拆开程度 t：零件移位，镜头保持用户的缩放比例跟着拉远或拉近 */
  function setExplode(t) {
    if (!ex || !g || !model) return;
    t = Math.min(ex.n, Math.max(0, t));
    const { camera, controls } = g;
    const r0 = fitR();
    ex.t = t;
    explodeAt(model, t);
    const off = camera.position.clone().sub(controls.target).multiplyScalar(fitR() / r0);
    controls.target.y = fitY();
    camera.position.copy(controls.target).add(off);
    frame(false);
    controls.update();
    slider.value = String(t);
    const { line, value } = exText(t);
    exBox.querySelector('.v3-ex-step').textContent = line;
    slider.setAttribute('aria-valuetext', value);
    wake();
  }

  function stopAnim() {
    if (ex?.anim) { cancelAnimationFrame(ex.anim); ex.anim = 0; }
  }
  const announce = () => { exBox.querySelector('[role=status]').textContent = ex.t >= ex.n ? '已全部拆开' : ex.t <= 0 ? '已合上' : ''; };

  /** 「拆开」「合上」：每一步 1.2 秒；系统设置了减少动态效果时直接跳过去 */
  function animateTo(target) {
    if (!ex) return;
    stopAnim();
    const from = ex.t, dur = Math.abs(target - from) * STEP_MS;
    if (reduceMotion || !dur) { setExplode(target); announce(); return; }
    const t0 = performance.now();
    const step = now => {
      const k = Math.min(1, (now - t0) / dur);
      setExplode(from + (target - from) * k);
      if (k < 1) ex.anim = requestAnimationFrame(step);
      else { ex.anim = 0; announce(); }
    };
    ex.anim = requestAnimationFrame(step);
  }

  /** 新模型加载后：有拆解数据就显示滑杆，从组装好开始 */
  function setupExplode(steps) {
    stopAnim();
    ex = steps.length ? { steps, n: steps.length, t: 0, anim: 0 } : null;
    exBox.hidden = !ex;
    exBox.querySelector('[role=status]').textContent = '';
    if (!ex) return;
    slider.max = String(ex.n);
    setExplode(0);
  }

  slider.addEventListener('input', () => { stopAnim(); setExplode(Number(slider.value)); });
  slider.addEventListener('pointerdown', () => { if (g?.controls.autoRotate) { resumeSpin = true; setSpin(false); } });
  const release = () => { if (resumeSpin) { resumeSpin = false; setSpin(true); wake(); } };
  slider.addEventListener('pointerup', release);
  slider.addEventListener('pointercancel', release);
  slider.addEventListener('change', release);
  // 键盘：方向键每次四分之一步，PageUp / PageDown 一整步，Home / End 到头
  slider.addEventListener('keydown', e => {
    if (!ex) return;
    const d = { ArrowRight: 0.25, ArrowUp: 0.25, ArrowLeft: -0.25, ArrowDown: -0.25, PageUp: 1, PageDown: -1 }[e.key];
    if (d == null && e.key !== 'Home' && e.key !== 'End') return;
    e.preventDefault();
    stopAnim();
    setExplode(e.key === 'Home' ? 0 : e.key === 'End' ? ex.n : ex.t + d);
  });
  exBox.addEventListener('click', e => {
    const b = e.target.closest('[data-x]');
    if (b && ex) animateTo(b.dataset.x === 'open' ? ex.n : 0);
  });

  /** 键盘：方向键转动，+ / - 缩放 */
  function onKey(e) {
    const { THREE, camera, controls } = g;
    const step = THREE.MathUtils.degToRad(10);
    const k = { ArrowLeft: [-step, 0, 1], ArrowRight: [step, 0, 1], ArrowUp: [0, -step, 1], ArrowDown: [0, step, 1], '+': [0, 0, 0.85], '=': [0, 0, 0.85], '-': [0, 0, 1.18] }[e.key];
    if (!k || !model) return;
    e.preventDefault();
    setSpin(false);
    const off = camera.position.clone().sub(controls.target);
    const s = new THREE.Spherical().setFromVector3(off);
    s.theta += k[0];
    s.phi = Math.min(controls.maxPolarAngle, Math.max(0.05, s.phi + k[1]));
    s.radius = Math.min(controls.maxDistance, Math.max(controls.minDistance, s.radius * k[2]));
    camera.position.copy(controls.target).add(off.setFromSpherical(s));
    controls.update();
    wake();
  }

  bar.addEventListener('click', e => {
    const b = e.target.closest('[data-v]');
    if (!b || !g) return;
    if (b.dataset.v === 'spin') setSpin(!g.controls.autoRotate);
    if (b.dataset.v === 'reset') { g.controls.reset(); if (model) frame(true); setSpin(!reduceMotion); } // 拆开着时按拆开后的大小取景
    if (b.dataset.v === 'fs') {
      if (document.fullscreenElement) document.exitFullscreen();
      else host.requestFullscreen?.().catch(() => {});
    }
    wake();
  });
  msg.addEventListener('click', e => { if (e.target.closest('[data-v=retry]') && fetcher) load(fetcher, title); });

  /** 加载（或换成）一个模型 */
  async function load(fetchModule, label = '3D 预览') {
    const my = ++seq;
    fetcher = fetchModule;
    title = label;
    say('<span class="v3-spin" aria-hidden="true"></span><span>正在加载 3D 预览…</span>');
    let three;
    try {
      three = await loadThree();
    } catch {
      if (my === seq && !disposed) say('<b>3D 预览组件没有加载出来</b><span>检查网络后再试。</span><button type="button" class="btn ghost small" data-v="retry">重试</button>');
      return;
    }
    if (my !== seq || disposed) return;
    if (!g) {
      try { setup(three); } catch {
        say('<b>这个浏览器打不开 3D 预览</b><span>需要 WebGL。可以先看多角度图。</span>');
        return;
      }
    }
    let obj;
    try {
      obj = await buildModel(await fetchModule());
    } catch (e) {
      if (my === seq && !disposed && e.status !== 401) say(`<b>3D 预览没有加载出来</b><span>${esc(e.message || '请稍后再试')}</span><button type="button" class="btn ghost small" data-v="retry">重试</button>`);
      return;
    }
    if (my !== seq || disposed) { disposeTree(obj); return; }
    if (model) { g.scene.remove(model); disposeTree(model); }
    obj.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    // 放到地面中间：底面贴地，水平居中
    const { THREE } = g;
    const box = new THREE.Box3().setFromObject(obj);
    const size = box.getSize(new THREE.Vector3());
    const c = box.getCenter(new THREE.Vector3());
    obj.position.x -= c.x;
    obj.position.z -= c.z;
    obj.position.y -= box.min.y;
    obj.updateMatrixWorld(true);
    g.base = { radius: Math.max(size.length() / 2, 1e-3), cy: size.y / 2 };
    g.base.radiusEx = g.base.radius;
    g.base.cyEx = g.base.cy;
    // 有拆解时先摆到全部拆开量一次大小（取景用），再合上
    const steps = explodeSteps(obj);
    if (steps.length) {
      explodeAt(obj, steps.length);
      obj.updateMatrixWorld(true);
      const bx = new THREE.Box3().setFromObject(obj).union(box.translate(new THREE.Vector3(-c.x, -box.min.y, -c.z)));
      explodeAt(obj, 0);
      obj.updateMatrixWorld(true);
      if (!bx.isEmpty() && Number.isFinite(bx.max.y)) {
        const cyEx = (bx.min.y + bx.max.y) / 2;
        const r = Math.hypot(Math.max(-bx.min.x, bx.max.x), (bx.max.y - bx.min.y) / 2, Math.max(-bx.min.z, bx.max.z));
        g.base.radiusEx = Math.max(r, g.base.radius);
        g.base.cyEx = cyEx;
      }
    }
    model = obj;
    g.scene.add(obj);
    g.canvas.setAttribute('aria-label', `${label}。可以拖动旋转、滚轮缩放；选中后用方向键转动，加减号缩放`);
    setupExplode(steps);
    frame(true);
    setSpin(!reduceMotion); // 系统设置了减少动态效果时不自动旋转
    say('');
    bar.hidden = false;
    wake();
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    seq++;
    stopAnim();
    cancelAnimationFrame(raf);
    io.disconnect();
    ro.disconnect();
    document.removeEventListener('visibilitychange', wake);
    if (document.fullscreenElement === host) document.exitFullscreen().catch(() => {});
    if (g) {
      disposeTree(model);
      g.controls.dispose();
      g.env.dispose();
      g.ground.geometry.dispose();
      g.ground.material.dispose();
      g.key.shadow.map?.dispose();
      g.renderer.dispose();
      g.renderer.forceContextLoss();
    }
    g = model = fetcher = null;
    host.innerHTML = '';
    host.classList.remove('viewer3d');
  }

  return { load, dispose };
}
