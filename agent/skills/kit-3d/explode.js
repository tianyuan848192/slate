// 拆解动画（docs/library-3d-design.md 第六节）。模型里的拆解数据：
//   model.userData.sculptRuntime.explode = { steps: [{ label: '拆下缸盖', parts: [{ id: 'cylinder-head', offset: [0, 0.35, 0] }] }] }
// offset 是零件拆开时的位移，在零件父节点的坐标系里，单位和模型一致；一个零件只出现在一步里。
// 网页的 3D 预览（web/js/viewer3d.js）有一份同样的算法，改这里要一起改。
import { Box3, Vector3 } from 'three';

const ease = p => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);
const clamp01 = x => Math.min(1, Math.max(0, x));

/** 拆解的步骤（没有拆解数据时是空数组） */
export function explodeSteps(model) {
  const e = model?.userData?.sculptRuntime?.explode;
  return Array.isArray(e?.steps) ? e.steps : [];
}

/** t = 0 是组装好，t = 步数是全部拆开；第 i 步在 t 从 i 到 i+1 之间完成（缓入缓出）。按时间算姿态，可以任意跳帧 */
export function explodeAt(model, t) {
  const nodes = model.userData.sculptRuntime?.nodes || {};
  const v = new Vector3();
  explodeSteps(model).forEach((step, i) => {
    const p = ease(clamp01(t - i));
    for (const part of step.parts || []) {
      const n = nodes[part.id];
      if (!n || !Array.isArray(part.offset)) continue;
      if (!n.userData.__rest) n.userData.__rest = n.position.clone();
      n.position.copy(n.userData.__rest).addScaledVector(v.fromArray(part.offset), p);
    }
  });
}

/** 正在拆的那一步（0 开始；还没开始拆时是 -1） */
export function stepAt(model, t) {
  const n = explodeSteps(model).length;
  return t <= 0 || !n ? -1 : Math.min(n - 1, Math.floor(t - 1e-6));
}

/** 全部拆开时的包围盒（给镜头取景用），算完恢复到 t */
export function explodedBox(model, t = 0) {
  explodeAt(model, explodeSteps(model).length);
  model.updateMatrixWorld(true);
  const box = new Box3().setFromObject(model);
  explodeAt(model, t);
  model.updateMatrixWorld(true);
  return box;
}

/** 某一步拆下来的零件节点（用来高亮、推近） */
export function stepNodes(model, i) {
  const nodes = model.userData.sculptRuntime?.nodes || {};
  return (explodeSteps(model)[i]?.parts || []).map(p => nodes[p.id]).filter(Boolean);
}
