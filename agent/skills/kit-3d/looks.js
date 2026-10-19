// 3D 素材按风格换画法：模型是程序化的，材质都能换，换完再调用一次 applyLook(model, 'pbr') 可以恢复原样。
//   pbr   原样（写实材质）
//   clay  素模：统一的哑光颜色，适合讲结构、做剪影
//   toon  卡通着色 + 描边，颜色可以映射到风格的调色板
//   line  线稿 + 平涂：零件的轮廓线和折边，适合机械图解、蓝图 / 工程制图
import * as THREE from 'three';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';

export const LOOKS = ['pbr', 'clay', 'toon', 'line'];

const rgb = hex => new THREE.Color(hex);
const srgb = c => c.getRGB({}, THREE.SRGBColorSpace);
/** 调色板里和这个颜色最接近的一个。按 sRGB 比（和眼睛看到的接近；线性空间里暗色会占便宜，中等亮度的颜色容易被并成黑色） */
function nearest(color, palette) {
  if (!palette?.length) return color.clone();
  const a = srgb(color);
  let best = null, bd = Infinity;
  for (const p of palette) {
    const c = rgb(p), b = srgb(c);
    const d = 3 * (b.r - a.r) ** 2 + 4 * (b.g - a.g) ** 2 + 2 * (b.b - a.b) ** 2;
    if (d < bd) { bd = d; best = c; }
  }
  return best;
}

/** 卡通着色的明暗台阶（n 级，最近邻采样，不过渡） */
export function toonRamp(n = 3) {
  const data = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    const v = Math.round(255 * (0.35 + 0.65 * i / Math.max(1, n - 1)));
    data.set([v, v, v, 255], i * 4);
  }
  const tex = new THREE.DataTexture(data, n, 1, THREE.RGBAFormat);
  tex.minFilter = tex.magFilter = THREE.NearestFilter;
  tex.needsUpdate = true;
  return tex;
}

/** 描边：同一个几何体沿法线外扩、只画背面（inverted hull）。只用在封闭的实体上：双面材质的薄片、开口壳体法线朝向不定，外扩出来会盖住零件 */
function outlineMesh(mesh, color, width) {
  const mat = new THREE.MeshBasicMaterial({ color, side: THREE.BackSide, toneMapped: false });
  mat.onBeforeCompile = shader => {
    shader.uniforms.uOutline = { value: width };
    shader.vertexShader = 'uniform float uOutline;\n' + shader.vertexShader.replace('#include <begin_vertex>', 'vec3 transformed = position + normalize(normal) * uOutline;');
  };
  // 成排的重复元素（InstancedMesh）：描边也按同样的实例位置画
  const hull = mesh.isInstancedMesh ? new THREE.InstancedMesh(mesh.geometry, mat, mesh.count) : new THREE.Mesh(mesh.geometry, mat);
  if (mesh.isInstancedMesh) hull.instanceMatrix = mesh.instanceMatrix;
  hull.castShadow = false;
  hull.userData.__lookChild = true;
  return hull;
}

/** 线稿：折边超过 angle 度的边画成线（线宽按像素，自动跟随画布大小） */
function edgeLines(mesh, color, width, angle) {
  const geo = new LineSegmentsGeometry().fromEdgesGeometry(new THREE.EdgesGeometry(mesh.geometry, angle));
  const mat = new LineMaterial({ color, linewidth: width, worldUnits: false, toneMapped: false });
  const line = new LineSegments2(geo, mat);
  const size = new THREE.Vector2();
  line.onBeforeRender = renderer => { renderer.getDrawingBufferSize(size); mat.resolution.copy(size); };
  line.userData.__lookChild = true;
  return line;
}

/**
 * 给模型换画法。opts：
 *   palette   颜色映射到的调色板（toon、line 的平涂），比如风格的主色 ['#e8e2d0', '#c0392b', '#1d2a3a']
 *   color     clay 的颜色
 *   fill      line 的平涂颜色；不给时用零件原来的颜色（映射到调色板）
 *   line      线条颜色；width 线宽（像素，默认 1.5）；angle 折边角度阈值（默认 30）；外轮廓用描边画，粗细 lineOutline（模型单位，默认模型尺寸的 0.25%）
 *   outline   toon 的描边颜色；outlineWidth 描边粗细（模型单位，默认是模型尺寸的 0.4%）；steps 明暗台阶数（默认 3）
 */
export function applyLook(model, look = 'pbr', opts = {}) {
  const meshes = [];
  model.traverse(o => { if (o.isMesh && !o.userData.__lookChild) meshes.push(o); });
  for (const m of meshes) {  // 先清掉上一次的描边和线条，恢复原来的材质
    for (const ch of [...m.children]) if (ch.userData.__lookChild) m.remove(ch);
    if (m.userData.__origMaterial) m.material = m.userData.__origMaterial;
    else m.userData.__origMaterial = m.material;
  }
  if (look === 'pbr') return;
  const size = new THREE.Box3().setFromObject(model).getSize(new THREE.Vector3()).length() || 1;
  const ramp = look === 'toon' ? toonRamp(opts.steps || 3) : null;
  for (const m of meshes) {
    const orig = Array.isArray(m.material) ? m.material[0] : m.material;
    const base = orig?.color ? orig.color.clone() : rgb('#cccccc');
    // 沿用原来的单双面和透明：开口的壳体、薄片常用双面材质，改成单面会缺面
    const keep = { side: orig?.side ?? THREE.FrontSide, transparent: !!orig?.transparent, opacity: orig?.opacity ?? 1, depthWrite: orig?.depthWrite ?? true };
    const solid = !keep.transparent && keep.side === THREE.FrontSide;
    if (look === 'clay') {
      m.material = new THREE.MeshStandardMaterial({ ...keep, color: opts.color || '#cfc8bc', roughness: 0.85, metalness: 0 });
    } else if (look === 'toon') {
      m.material = new THREE.MeshToonMaterial({ ...keep, color: nearest(base, opts.palette), map: orig?.map || null, gradientMap: ramp });
      if (solid) m.add(outlineMesh(m, opts.outline || '#1b1b1b', opts.outlineWidth ?? size * 0.004));
    } else if (look === 'line') {
      m.material = new THREE.MeshBasicMaterial({ ...keep, color: opts.fill ? rgb(opts.fill) : nearest(base, opts.palette), toneMapped: false,
                                                 polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
      // 折边画线；圆柱、球这类光滑曲面没有折边，外轮廓靠描边
      if (solid) m.add(outlineMesh(m, opts.line || '#1d2a3a', opts.lineOutline ?? size * 0.0025));
      if (!m.isInstancedMesh) m.add(edgeLines(m, opts.line || '#1d2a3a', opts.width || 1.5, opts.angle || 30));  // 重复元素只平涂和描边
    }
  }
}
