// 零件标注：零件在画面上的位置，加引线和名称（说明书式的拆解图、视频里的零件讲解）。
// 标注画在一层 SVG 上（盖在 three.js 画布上面），字体、颜色跟着镜头的风格走。
import { Box3, Vector3 } from 'three';

const NS = 'http://www.w3.org/2000/svg';

/** 零件中心在画面上的位置：{id: {x, y, visible}}，x、y 是像素（width × height 的画布） */
export function screenPoints(model, camera, ids, width, height) {
  const nodes = model.userData.sculptRuntime?.nodes || {};
  const out = {};
  model.updateMatrixWorld(true);
  for (const id of ids) {
    const n = nodes[id];
    if (!n) continue;
    const p = new Box3().setFromObject(n).getCenter(new Vector3()).project(camera);
    out[id] = { x: (p.x + 1) / 2 * width, y: (1 - p.y) / 2 * height, visible: p.z > -1 && p.z < 1 && Math.abs(p.x) <= 1 && Math.abs(p.y) <= 1 };
  }
  return out;
}

/**
 * 画引线和名称。items：[{x, y, text}]（零件在画面上的位置和名称）；标签排在画面左右两列，按高度排开、互不重叠。
 * opts：width、height（画布像素）、margin（标签离画面边缘，默认宽的 4%）、gap（标签最小间距，默认高的 5%）、
 *       color（线和字，默认 #1d2a3a）、font（默认 sans-serif）、size（字号像素，默认高的 2.6%）、dot（端点半径）、opacity（0～1，做淡入）
 * 返回画上去的 <g>，换帧前用 g.remove() 清掉
 */
export function callouts(svg, items, opts = {}) {
  const W = opts.width || svg.clientWidth, H = opts.height || svg.clientHeight;
  const margin = opts.margin ?? W * 0.04, gap = opts.gap ?? H * 0.05, size = opts.size ?? H * 0.026;
  const color = opts.color || '#1d2a3a', font = opts.font || 'sans-serif', dot = opts.dot ?? size * 0.22;
  const g = document.createElementNS(NS, 'g');
  g.setAttribute('opacity', String(opts.opacity ?? 1));
  for (const side of ['left', 'right']) {
    const col = items.filter(it => (it.x < W / 2) === (side === 'left')).sort((a, b) => a.y - b.y);
    // 从上往下排，太挤就往下推；推出画面再整体往上收
    const ys = [];
    col.forEach((it, i) => ys.push(Math.max(it.y, i ? ys[i - 1] + gap : H * 0.08)));
    const over = (ys[ys.length - 1] ?? 0) - H * 0.92;
    if (over > 0) for (let i = ys.length - 1; i >= 0; i--) ys[i] = Math.min(ys[i] - over, i < ys.length - 1 ? ys[i + 1] - gap : Infinity);
    col.forEach((it, i) => {
      const lx = side === 'left' ? margin : W - margin, dir = side === 'left' ? 1 : -1;
      const t = document.createElementNS(NS, 'text');
      t.setAttribute('x', lx); t.setAttribute('y', ys[i]); t.setAttribute('dy', '0.35em');
      t.setAttribute('text-anchor', side === 'left' ? 'start' : 'end');
      t.setAttribute('font-family', font); t.setAttribute('font-size', size); t.setAttribute('fill', color);
      t.textContent = it.text;
      g.append(t);
      svg.append(g);  // 放进页面才量得出文字宽度
      const w = t.getComputedTextLength ? t.getComputedTextLength() : it.text.length * size;
      // 引线：零件 → 斜到拐点 → 水平接到文字靠近零件的一端
      const near = lx + dir * (w + size * 0.5), knee = near + dir * size * 1.5;
      const line = document.createElementNS(NS, 'polyline');
      line.setAttribute('points', `${it.x},${it.y} ${knee},${ys[i]} ${near},${ys[i]}`);
      line.setAttribute('fill', 'none'); line.setAttribute('stroke', color); line.setAttribute('stroke-width', String(Math.max(1, size * 0.07)));
      const c = document.createElementNS(NS, 'circle');
      c.setAttribute('cx', it.x); c.setAttribute('cy', it.y); c.setAttribute('r', dot); c.setAttribute('fill', color);
      g.append(line, c);
    });
  }
  svg.append(g);
  return g;
}
