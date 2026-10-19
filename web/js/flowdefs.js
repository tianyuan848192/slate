/* 工作流模式（docs/workflow-mode-design.md）的公共定义：三种节点、各自的默认设置、内置模板，以及首页卡片上的缩略图和摘要 */

import { esc } from './util.js';
import { genreById, skillName } from './catalog.js';

export const TYPES = {
  text: { name: '文字', sub: '资料 · 剧本 · 分镜', icon: 'text', max: 1 },
  image: { name: '图片', sub: '3D 图片', icon: 'cube', max: 3 },
  av: { name: '音画', sub: '配音和画面一起出', icon: 'av', max: 1 },
};

/** 节点的默认设置。text.edits 是分镜表里直接改过、还没交给 Agent 的旁白：{镜头号: 旁白} */
export const DEF = {
  text: () => ({ desc: '', refs: [], pics: [], web: true, strict: false, genre: '', dur: 60, edits: {} }),  // pics：视频里用的普通图片，每张带描述
  image: () => ({ mode: 'new', desc: '', photos: [], explode: false, web: true, lib: null }),
  av: () => ({ main: '', insert: '', voice: 'auto', sub: true, bgm: false, ratio: '16:9', res: '1080p', fps: 30 }),
};

export const TEMPLATES = [
  { id: 'blank', name: '空白工作流', desc: '从空画板开始，自己添加节点、连线。', doc: { nodes: [], edges: [] } },
  {
    id: 'explainer', name: '讲解片', desc: '文字 → 音画。剧本和分镜写好先看一眼、聊几轮，满意了再出片。',
    doc: {
      nodes: [{ k: 't', type: 'text', x: 60, y: 60, cfg: { genre: 'science', dur: 60 } },
              { k: 'a', type: 'av', x: 500, y: 100, cfg: {} }],
      edges: [['t', 'a', 'text']],
    },
  },
  {
    id: 'product3d', name: '带 3D 的产品广告', desc: '文字 + 3D 图片 → 音画。3D 图片和剧本可以同时做，做片时镜头直接用模型。',
    doc: {
      nodes: [{ k: 't', type: 'text', x: 60, y: 30, cfg: { genre: 'product', dur: 30 } },
              { k: 'i', type: 'image', x: 60, y: 380, cfg: { mode: 'new', explode: true } },
              { k: 'a', type: 'av', x: 520, y: 170, cfg: { main: 'film-glass-product', ratio: '9:16', bgm: true } }],
      edges: [['t', 'a', 'text'], ['i', 'a', 'img']],
    },
  },
];

const NODE_COL = { text: ['#E6ECFB', '#2D5BD8'], image: ['#E2F1E9', '#2C7A57'], av: ['#FDEFC3', '#8A5D00'] };
const curve = (p, q) => { const dx = Math.max(50, Math.abs(q.x - p.x) * .5); return `M${p.x} ${p.y}C${p.x + dx} ${p.y} ${q.x - dx} ${q.y} ${q.x} ${q.y}`; };

/** 卡片上的画板缩略图：节点画成色块，连线画成曲线 */
export function mini(doc) {
  const ns = doc?.nodes || [];
  if (!ns.length) return '<span class="wf-mini"><svg aria-hidden="true"><use href="#i-plus"/></svg></span>';
  const xs = ns.map(n => n.x), ys = ns.map(n => n.y);
  const x0 = Math.min(...xs) - 40, y0 = Math.min(...ys) - 40, x1 = Math.max(...xs) + 340, y1 = Math.max(...ys) + 260;
  const by = Object.fromEntries(ns.map(n => [n.k, n]));
  const lines = (doc.edges || []).map(([a, b]) => {
    const p = by[a], q = by[b];
    return p && q ? `<path d="${curve({ x: p.x + 300, y: p.y + 40 }, { x: q.x, y: q.y + 70 })}" fill="none" stroke="#8B93A6" stroke-width="5"/>` : '';
  }).join('');
  const boxes = ns.map(n => { const [bg, fg] = NODE_COL[n.type] || NODE_COL.text; return `<rect x="${n.x}" y="${n.y}" width="300" height="200" rx="18" fill="#fff" stroke="${fg}" stroke-width="4"/><rect x="${n.x}" y="${n.y}" width="300" height="56" rx="18" fill="${bg}"/><text x="${n.x + 24}" y="${n.y + 40}" font-size="30" font-weight="700" fill="${fg}">${esc(TYPES[n.type]?.name || '')}</text>`; }).join('');
  return `<svg class="wf-mini" viewBox="${x0} ${y0} ${x1 - x0} ${y1 - y0}" preserveAspectRatio="xMidYMid meet" aria-hidden="true">${lines}${boxes}</svg>`;
}

/** 一行摘要：写作方法、画风、3D 图片个数 */
export function summary(doc) {
  const ns = doc?.nodes || [];
  const t = ns.find(n => n.type === 'text'), a = ns.find(n => n.type === 'av'), k = ns.filter(n => n.type === 'image').length;
  return [t && `写作方法 ${genreById(t.cfg?.genre)?.name || 'Agent 判断'}`, a && `画风 ${a.cfg?.main ? skillName(a.cfg.main) : 'Agent 判断'}`,
    k && `3D 图片 ${k} 个`].filter(Boolean).join(' · ');
}

/** 节点构成：文字 + 图片 ×2 + 音画 */
export function counts(doc) {
  const ns = doc?.nodes || [];
  return Object.keys(TYPES).map(t => [t, ns.filter(n => n.type === t).length]).filter(([, k]) => k)
    .map(([t, k]) => `${TYPES[t].name}${k > 1 ? ` ×${k}` : ''}`).join(' + ');
}
