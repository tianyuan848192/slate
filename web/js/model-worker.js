/* 3D 预览的模型代码在这个 Worker 里执行，不在网站页面里执行：模型代码是 Agent 写的，可能被网页里的提示注入带偏。
   Worker 碰不到页面、localStorage 里的登录信息和 top 窗口。做出来的 3D 对象用 toJSON 转成纯数据交回页面，
   页面用 ObjectLoader 还原（viewer3d.js 的 buildModel）。 */
import * as THREE from '../vendor/three/build/three.module.js';

const THREE_URL = new URL('../vendor/three/build/three.module.js', import.meta.url).href;

// 模型代码只能用 document 建 canvas（画贴图）：给它一个只会建 OffscreenCanvas 的 document
self.document = {
  createElement(tag) {
    if (String(tag).toLowerCase() !== 'canvas') throw new Error(`模型代码不能创建 ${tag}`);
    return new OffscreenCanvas(300, 150);
  },
};

const toDataURL = async canvas => {
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return new FileReaderSync().readAsDataURL(blob);
};

/** userData 里引用的 3D 对象换成 {$uuid}（页面那边按 uuid 接回去），函数之类存不下的丢掉。
    JSON.stringify 会先调用对象自己的 toJSON，所以按 this[k] 看原来的值 */
function plain(v) {
  try {
    return JSON.parse(JSON.stringify(v, function (k, x) {
      const raw = this[k];
      return raw?.isObject3D ? { $uuid: raw.uuid } : typeof raw === 'function' ? undefined : x;
    }));
  } catch {
    return {};
  }
}

self.onmessage = async ({ data: { code, factory } }) => {
  try {
    // 模型代码 import 'three'：Worker 里没有页面的导入映射，换成 three.js 的地址（和上面是同一个模块）
    const src = code.replace(/(\bfrom\s*|\bimport\s*\(\s*)(['"])three\2/g, (m, a, q) => `${a}${q}${THREE_URL}${q}`);
    const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
    let mod;
    try {
      mod = await import(url);
    } finally {
      URL.revokeObjectURL(url);
    }
    if (typeof mod[factory] !== 'function') throw new Error(`模型代码里没有 ${factory}`);
    const obj = await mod[factory]();
    if (!obj?.isObject3D) throw new Error('模型代码没有返回 3D 对象');
    // canvas 画的贴图：Worker 里 toJSON 存不下 OffscreenCanvas，记下来，序列化后换成 PNG 数据地址。
    // 几何体一律转成普通 BufferGeometry 传顶点数据：带参数的几何体有的还原不回来（比如沿 CurvePath 挤出的）
    const canvases = new Map(), geos = new Map();
    const warn = console.warn;
    console.warn = () => {}; // 序列化时 three.js 会对每张 canvas 贴图警告一次"存不下"，下面自己补上
    let json;
    try {
      obj.traverse(o => {
        if (o.geometry?.isBufferGeometry && o.geometry.type !== 'BufferGeometry') {
          if (!geos.has(o.geometry)) geos.set(o.geometry, new THREE.BufferGeometry().copy(o.geometry));
          o.geometry = geos.get(o.geometry);
        }
        for (const m of [].concat(o.material || [])) {
          for (const v of Object.values(m)) if (v?.isTexture && v.image instanceof OffscreenCanvas) canvases.set(v.source.uuid, v.image);
        }
        if (Object.keys(o.userData).length) o.userData = plain(o.userData);
      });
      obj.updateMatrixWorld(true); // toJSON 存的是 matrix：模型代码只改了 position 等，要先算出来
      json = obj.toJSON();
    } finally {
      console.warn = warn;
    }
    for (const im of json.images || []) if (canvases.has(im.uuid)) im.url = await toDataURL(canvases.get(im.uuid));
    self.postMessage({ json });
  } catch (e) {
    const msg = String(e?.message || '');
    self.postMessage({ error: msg.startsWith('模型代码') ? msg : '模型代码运行出错', detail: String(e?.stack || e).slice(0, 500) });
  }
};
