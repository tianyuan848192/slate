"""3D 图片（docs/library-3d-design.md）：把程序化 three.js 模型渲染成多角度图、转台视频，导出 GLB。

会话里的 slate-model 和渲染机的工作进程共用这个模块。模型代码是一个只依赖 three 的 ES 模块，导出 createXxxModel()，
返回 THREE.Group；可以单独动的零件放在 group.userData.sculptRuntime.nodes 里。
页面放在 scenes/M3D/，由 slate.page 的 ScenePage 打开（和 slate-render 同一套机制，three.js r170）。
角度 0 是正面（模型 +Z 朝向镜头），顺时针转；默认再加一张 35 度斜侧。
"""
import base64, json, os, re, shutil, subprocess

from . import page as pg
from .common import ffmpeg, path

SCENE = "M3D"
ANGLES = (0, 90, 180, 270, 35)
# 模型代码会在用户浏览器的 3D 预览里执行，只能建模，不能碰网络、存储、页面和全局对象（document 只能用来建 canvas）。
# 这是第一道关；真正兜底的是网站的内容安全策略（只允许连本站接口）。同一条规则在 backend/lib/library.py 也有一份
UNSAFE_RE = re.compile(r"(?<![\w$.'\"`-])(?:fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon|localStorage|sessionStorage|indexedDB|cookie"
                       r"|eval|Function|importScripts|postMessage|Worker|navigator|location|globalThis|window|self|innerHTML|outerHTML"
                       r"|insertAdjacentHTML|setTimeout|setInterval|ownerDocument|defaultView|Image|Audio|document)\b(?![-'\"`])"
                       r"|\.(?:constructor|ownerDocument|defaultView)\b|\[\s*['\"`]constructor|\bimport\s*\(")
CANVAS_RE = re.compile(r"\bdocument\.createElement\(\s*(['\"])canvas\1\s*\)|\btypeof\s+document\b")  # 允许的 document 用法：建 canvas、判断有没有页面
def unsafe(code):
    """返回第一处不允许的写法 (行号, 原文)，没有时返回 None。
    直接查原始代码，注释、字符串里出现也算：先剥掉注释和字符串再查的做法，判断 / 是除号还是正则时总有歧义，
    攻击者能借此让会执行的代码被当成注释或正则抹掉（增量安全扫描 #1、#2）。正常的模型代码用不到这些词"""
    bare = CANVAS_RE.sub("__canvas__()", code)
    hit = UNSAFE_RE.search(bare)
    return (bare[:hit.start()].count("\n") + 1, hit.group(0)) if hit else None
IMPORT_RE = re.compile(r"""(?:\bimport\b[^'"`;]*?\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"]([^'"]+)['"]""")

PAGE = r"""<!doctype html><html><head><meta charset="utf-8">
<script type="importmap">{"imports":{"three":"/node_modules/three/build/three.module.js","three/addons/":"/node_modules/three/examples/jsm/"}}</script>
<style>html,body{margin:0;background:#d6dae0;overflow:hidden}canvas{display:block}</style></head><body>
<script type="module">
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { explodeAt, explodeSteps, explodedBox } from '/skills/kit-3d/explode.js';
import { screenPoints, callouts } from '/skills/kit-3d/labels.js';
import * as M from './model.js';
window.READY = false;
const CFG = window.__SLATE_CONFIG, W = CFG.width, H = CFG.height, JOB = __JOB__;
const factory = M[JOB.factory] || Object.values(M).find(v => typeof v === 'function' && /^create\w*Model$/.test(v.name));
if (!factory) throw new Error('模型代码没有导出 createXxxModel 工厂函数');
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(1); renderer.setSize(W, H);
renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.append(renderer.domElement);
const scene = new THREE.Scene(); scene.background = new THREE.Color('#d6dae0');
scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8f99, 0.6));
const key = new THREE.DirectionalLight(0xffffff, 2.2); key.castShadow = true; key.shadow.mapSize.set(2048, 2048); scene.add(key);
const model = factory({}); scene.add(model);
model.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
const STEPS = explodeSteps(model).length;
// 拆开的画面（拆解图、拆解动画）按全部拆开时的大小取景，不然零件会出画
const box = (STEPS && (JOB.explode > 0 || JOB.explodeAnim)) ? explodedBox(model) : new THREE.Box3().setFromObject(model);
const size = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3());
const sphere = box.getBoundingSphere(new THREE.Sphere()), R = sphere.radius || 1;
const ground = new THREE.Mesh(new THREE.PlaneGeometry(R * 12, R * 12), new THREE.ShadowMaterial({ opacity: 0.22 }));
ground.rotation.x = -Math.PI / 2; ground.position.y = box.min.y - R * 1e-4; ground.receiveShadow = true; scene.add(ground);
key.position.set(c.x + R * 2, c.y + R * 4, c.z + R * 3); key.target.position.copy(c); scene.add(key.target);
Object.assign(key.shadow.camera, { left: -R * 3, right: R * 3, top: R * 3, bottom: -R * 3, near: R * 0.1, far: R * 20 });
const cam = new THREE.PerspectiveCamera(30, W / H, R * 0.01, R * 100);
const dist = R / Math.sin(THREE.MathUtils.degToRad(15)) * 1.08;
function view(deg) {
  const a = THREE.MathUtils.degToRad(deg), e = THREE.MathUtils.degToRad(16);
  cam.position.set(c.x + Math.sin(a) * Math.cos(e) * dist, c.y + Math.sin(e) * dist, c.z + Math.cos(a) * Math.cos(e) * dist);
  cam.lookAt(c); renderer.render(scene, cam);
}
// 拆解动画的时间线：组装好停一下 → 一步一步拆开 → 全部拆开停住 → 合上；镜头在 35 度附近缓慢来回
function explodeAmount(t, d) {
  const a = d * 0.1, b = d * 0.55, h = d * 0.2;
  if (t < a) return 0;
  if (t < a + b) return STEPS * (t - a) / b;
  if (t < a + b + h) return STEPS;
  return STEPS * Math.max(0, 1 - (t - a - b - h) / (d - a - b - h));
}
const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
svg.setAttribute('width', W); svg.setAttribute('height', H);
svg.style.cssText = 'position:absolute;left:0;top:0;pointer-events:none';
document.body.append(svg);
let marks = null;
function label() {  // 拆解图：零件引线和名称
  marks?.remove(); marks = null;
  const ids = Object.keys(JOB.labels || {});
  if (!ids.length || !(JOB.explode > 0)) return;
  const pts = screenPoints(model, cam, ids, W, H);
  const items = ids.filter(id => pts[id]?.visible).map(id => ({ x: pts[id].x, y: pts[id].y, text: JOB.labels[id] }));
  marks = callouts(svg, items, { width: W, height: H, color: '#1d2a3a', font: '"Noto Sans CJK SC", "Noto Sans SC", sans-serif' });
}
// views：第 i 帧拍第 i 个角度（explode 大于 0 时按拆开的样子拍）；explodeAnim：拆解动画（转成 GIF 动图）
window.render = t => {
  if (JOB.explodeAnim) {
    explodeAt(model, explodeAmount(t, JOB.explodeAnim));
    return view(35 + 12 * Math.sin(2 * Math.PI * t / JOB.explodeAnim));
  }
  explodeAt(model, JOB.explode || 0);
  view(JOB.angles[Math.max(0, Math.min(JOB.angles.length - 1, Math.floor(t + 1e-6)))]);
  label();
};
let meshes = 0, tris = 0;
model.traverse(o => { if (o.isMesh && o.geometry) { meshes++; const g = o.geometry; tris += (g.index ? g.index.count : g.attributes.position.count) / 3 * (o.isInstancedMesh ? o.count : 1); } });
const rt = model.userData.sculptRuntime || {};
window.__info = { factory: factory.name, meshes, triangles: Math.round(tris), size: size.toArray().map(v => +v.toFixed(4)),
  parts: Object.keys(rt.nodes || {}), finite: [size.x, size.y, size.z].every(Number.isFinite) && R > 0,
  steps: explodeSteps(model).map(s => ({ label: s.label, parts: (s.parts || []).map(p => p.id) })) };
// 3D 打印的源数据：组装好的样子，每块网格换算到世界坐标，按所属零件（sculptRuntime.nodes 里最近的上级）和颜色分组
window.__printSource = () => {
  explodeAt(model, 0); model.updateMatrixWorld(true);
  const owner = new Map(Object.entries(rt.nodes || {}).filter(([, n]) => n !== model).map(([id, n]) => [n, id]));
  const out = [], v = new THREE.Vector3(), m = new THREE.Matrix4();
  model.traverse(o => {
    if (!o.isMesh || !o.visible || !o.geometry?.attributes?.position) return;
    const mat = Array.isArray(o.material) ? o.material[0] : o.material;
    if (mat?.transparent && (mat.opacity ?? 1) < 0.5) return;  // 玻璃这类透明件不打印
    let p = o, part = 'body';
    while (p && p !== model) { if (owner.has(p)) { part = owner.get(p); break; } p = p.parent; }
    const pos = o.geometry.attributes.position, idx = o.geometry.index ? Array.from(o.geometry.index.array) : null;
    const copies = o.isInstancedMesh ? o.count : 1;
    for (let k = 0; k < copies; k++) {
      m.copy(o.matrixWorld);
      if (o.isInstancedMesh) { const im = new THREE.Matrix4(); o.getMatrixAt(k, im); m.multiply(im); }
      const arr = new Array(pos.count * 3);
      for (let i = 0; i < pos.count; i++) { v.fromBufferAttribute(pos, i).applyMatrix4(m); arr[3 * i] = +v.x.toFixed(5); arr[3 * i + 1] = +v.y.toFixed(5); arr[3 * i + 2] = +v.z.toFixed(5); }
      out.push({ part, color: '#' + (mat?.color ? mat.color.getHexString() : 'cccccc'), name: o.name || '', pos: arr, idx });
    }
  });
  return { meshes: out };
};
window.__glb = async () => {
  const { GLTFExporter } = await import('three/addons/exporters/GLTFExporter.js');
  const ab = await new GLTFExporter().parseAsync(model, { binary: true });
  let s = ''; const b = new Uint8Array(ab); for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
  return btoa(s);
};
window.READY = true;
</script></body></html>
"""


SKETCH = "M3S"


async def sketch(svg_path, out_png, size=1024):
    """没有参考照片时，Agent 按描述画的示意图（SVG）渲染成 PNG，当参考图用"""
    from playwright.async_api import async_playwright
    d = path("scenes", SKETCH)
    shutil.rmtree(d, ignore_errors=True); os.makedirs(d)
    shutil.copy(svg_path, os.path.join(d, "sketch.svg"))
    open(os.path.join(d, "index.html"), "w", encoding="utf-8").write(
        '<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:#fff}'
        'img{display:block;width:100vw;height:100vh;object-fit:contain}</style></head><body><img src="sketch.svg">'
        '<script>window.render = () => {};</script></body></html>')
    cfg = {"width": size, "height": size, "fps": 1, "duration": 1, "scene": SKETCH, "ratio": "1:1", "subtitles": False, "captions": []}
    async with async_playwright() as pw:
        async with pg.ScenePage(pw, SKETCH, cfg, name=f"slate_m3s_{os.getpid()}") as sp:
            await sp.frame(0)
            os.makedirs(os.path.dirname(os.path.abspath(out_png)), exist_ok=True)
            open(out_png, "wb").write(await sp.png())
            return sp.errors[:5]


def check_module(src):
    """模型代码只能依赖 three（渲染时页面不能访问外网，也没有打包步骤），返回导出的工厂函数名"""
    code = open(src, encoding="utf-8").read()
    bad = sorted({m for m in IMPORT_RE.findall(code) if m != "three"})
    if bad:
        raise ValueError(f"模型代码只能 import 'three'，不能引用 {', '.join(bad)}")
    hit = unsafe(code)
    if hit:
        raise ValueError(f"模型代码第 {hit[0]} 行用了不允许的写法「{hit[1]}」：模型只能建模，不能访问网络、存储、页面和全局对象"
                         "（document 只能 document.createElement('canvas')）。注释和字符串里也不能出现这些词，换个说法")
    names = re.findall(r"export\s+(?:async\s+)?function\s+(create\w*Model)\s*\(", code) + \
        re.findall(r"export\s*\{[^}]*?\b(create\w*Model)\b", code)
    if not names:
        raise ValueError("模型代码没有导出 createXxxModel 工厂函数（export function createXxxModel(options) { … return group; }）")
    return names[0]


def prepare(src, job):
    """把模型代码和预览页放进 scenes/M3D/。job：{"angles": [...], "explode": 拆开程度, "labels": {零件 id: 名称}} 或 {"explodeAnim": 秒数}；返回带工厂函数名的 job"""
    factory = check_module(src)
    d = path("scenes", SCENE)
    shutil.rmtree(d, ignore_errors=True); os.makedirs(d)
    shutil.copy(src, os.path.join(d, "model.js"))
    job = {"angles": list(job.get("angles") or ANGLES), "factory": factory,
           "explode": job.get("explode") or 0, "explodeAnim": job.get("explodeAnim") or 0, "labels": job.get("labels") or {}}
    open(os.path.join(d, "index.html"), "w", encoding="utf-8").write(PAGE.replace("__JOB__", json.dumps(job)))
    return job


async def capture(job, out_dir, size=768, glb=False, extract=False):
    """在浏览器里打开 scenes/M3D/，按 job 出一种画面：
    - views：多角度图 views/<角度>.png（job.explode 大于 0 时是拆开的样子，放在 exploded/<角度>.png，带零件标注）
    - explodeAnim：拆解动画 explode.mp4（slate-model 再转成 GIF 动图）
    glb=True 时再导出 model.glb；extract=True 时取出 3D 打印的源数据 print-src.json.gz（见 printfile.py）。
    返回 {"info": 网格数、三角形数、尺寸、零件、拆解步骤, "files": {...}, "errors": [...], "print_check": [...]}"""
    from playwright.async_api import async_playwright
    secs = job.get("explodeAnim") or 0
    fps = 24 if secs else 1
    n = int(round(secs * fps)) if secs else len(job["angles"])
    cfg = {"width": size, "height": size, "fps": fps, "duration": n / fps, "scene": SCENE, "ratio": "1:1", "subtitles": False, "captions": []}
    files, check = {}, []
    os.makedirs(out_dir, exist_ok=True)
    async with async_playwright() as pw:
        async with pg.ScenePage(pw, SCENE, cfg, name=f"slate_m3d_{os.getpid()}") as sp:
            info = await sp.page.evaluate("window.__info")
            if secs:
                mp4 = os.path.join(out_dir, "explode.mp4")
                ff = subprocess.Popen([ffmpeg(), "-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", str(fps), "-c:v", "mjpeg", "-i", "-",
                                       "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", mp4], stdin=subprocess.PIPE)
                for f in range(n):
                    await sp.frame(f / fps)
                    ff.stdin.write(await sp.jpeg())
                ff.stdin.close(); ff.wait()
                files["explode"] = mp4
            else:
                sub = "exploded" if job.get("explode") else "views"
                os.makedirs(os.path.join(out_dir, sub), exist_ok=True)
                files[sub] = {}
                for i, a in enumerate(job["angles"]):
                    await sp.frame(i + 0.5)
                    p = os.path.join(out_dir, sub, f"{a:03d}.png")
                    open(p, "wb").write(await sp.png())
                    files[sub][str(a)] = p
            if glb:
                p = os.path.join(out_dir, "model.glb")
                open(p, "wb").write(base64.b64decode(await sp.page.evaluate("window.__glb()")))
                files["glb"] = p
            if extract:
                from . import printfile
                src = printfile.prepare(await sp.page.evaluate("window.__printSource()"))
                p = os.path.join(out_dir, "print-src.json.gz")
                open(p, "wb").write(printfile.dumps(src))
                files["print_src"] = p
                check = printfile.check(src)
            errors = sp.errors[:8] + [f"被拦截的请求：{u}" for u in sp.blocked[:4]]
    return {"info": info, "files": files, "errors": errors, "print_check": check}


def sheet(refs, views, out):
    """对比图：参考图（红字）在前，各角度的渲染在后"""
    from PIL import Image, ImageDraw, ImageFont
    cell = 420
    font = _cjk_font(22)
    ref_label, view_label = ("参考图", "渲染") if font else ("REF", "VIEW")
    font = font or ImageFont.load_default()
    items = [(f"{ref_label} {os.path.basename(p)}", p) for p in refs] + [(f"{view_label} {a}°", p) for a, p in views]
    cols = min(4, len(items)); rows = (len(items) + cols - 1) // cols
    img = Image.new("RGB", (cols * cell, rows * (cell + 34)), "white")
    d = ImageDraw.Draw(img)
    for i, (label, p) in enumerate(items):
        im = Image.open(p).convert("RGB"); im.thumbnail((cell - 8, cell - 8))
        x, y = (i % cols) * cell, (i // cols) * (cell + 34)
        img.paste(im, (x + (cell - im.width) // 2, y + 34 + (cell - im.height) // 2))
        d.text((x + 8, y + 4), label, fill=(200, 40, 40) if label.startswith((ref_label,)) else (30, 30, 30), font=font)
    img.save(out)
    return out
