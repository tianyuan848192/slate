/* 新建视频「＋ 添加资料」菜单里的「从素材库选」：按类别（3D 图片 / 图片 / 文件）分页，可以搜索，勾选后点「完成」。
   素材库里的视频只保存历史，不在这里出现（docs/library-3d-design.md 第三节） */

import { $, $$, esc, fmtSize, relTime, openModal, closeModal } from './util.js';
import { api } from './api.js';
import { heroView } from './viewer3d.js';

const modal = $('#lp');
const list = $('#lp-list');
const tabs = $$('#lp-tabs [role=tab]');
const NAME = { model3d: '3D 图片', image: '图片', file: '文件' };
const UNIT = { model3d: '个', image: '张', file: '份' };

let kind = 'model3d';
let picked = null;  // 这次打开里勾选的：{model3d: Map(id → 条目), image: Map, file: Map}
let limits = null;  // 最多能选几个：{model3d, image, file}
let onDone = null;
let items = [];
let seq = 0;
let timer = 0;

function hintText() {
  if (kind === 'model3d') return `最多选 ${limits.model3d} 个。Agent 会读素材卡，自己决定哪几镜用、怎么拍：转台、推近或者零件动画。`;
  if (kind === 'image') return limits.image ? `这次最多选 ${limits.image} 张。选好以后在列表里检查每张的描述，Agent 按描述决定放在哪几镜、怎么用。` : '图片已经有 8 张了，先移除一张再选。';
  return limits.file
    ? `文件算一份参考资料，和上传的一样整理、引用。这次最多选 ${limits.file} 份（参考资料合计最多 10 份）。`
    : '参考资料已经有 10 份了，先在描述块里移除一份再选文件。';
}
function setHint(text, warn = false) {
  const h = $('#lp-hint');
  h.textContent = text || hintText();
  h.classList.toggle('is-warn', warn);
}

function counts() {
  tabs.forEach(t => { const n = picked[t.dataset.kind].size; $('span', t).textContent = n || ''; });
  const parts = Object.keys(NAME).map(k => picked[k].size && `${NAME[k]} ${picked[k].size} ${UNIT[k]}`).filter(Boolean);
  $('#lp-count').textContent = parts.length ? `已选 ${parts.join('，')}` : '还没选';
}

function row(x) {
  const on = picked[kind].has(x.id);
  const img = kind === 'model3d' ? heroView(x.views) : kind === 'image' && x.url;
  const media = kind !== 'file'
    ? `<span class="lp-thumb">${img ? `<img src="${esc(img)}" alt="" loading="lazy">` : `<svg aria-hidden="true"><use href="#i-${kind === 'image' ? 'image' : 'cube'}"/></svg>`}</span>`
    : '<span class="lp-thumb is-file"><svg aria-hidden="true"><use href="#i-doc"/></svg></span>';
  const sub = kind === 'model3d' ? x.summary || '' : kind === 'image' ? x.desc || '' : [fmtSize(x.size || 0), relTime(x.updatedAt)].filter(Boolean).join(' · ');
  const tags = (x.tags || []).slice(0, 3).map(t => `<span class="src-tag">${esc(t)}</span>`).join('');
  return `<li><label class="pick"><input type="checkbox" value="${esc(x.id)}"${on ? ' checked' : ''}>${media}<div><b><span class="lp-name">${esc(x.name)}</span>${tags}</b><p>${esc(sub)}</p></div></label></li>`;
}

function render(q) {
  if (items.length) { list.innerHTML = items.map(row).join(''); return; }
  const msg = q ? `没有符合「${esc(q)}」的素材，换个关键词试试。`
    : kind === 'model3d' ? '素材库里还没有 3D 图片。在新建页切到「3D 图片」做一个，做完会自动进素材库。'
    : kind === 'image' ? '素材库里还没有图片。新建视频时上传的图片，会在开始生成时连同描述一起进素材库。'
    : '素材库里还没有文件。新建视频时上传的参考资料，会在开始生成时自动进素材库。';
  list.innerHTML = `<li class="pick-msg">${msg}</li>`;
}

async function load() {
  clearTimeout(timer);
  const my = ++seq, k = kind, q = $('#lp-q').value.trim();
  if (list.dataset.kind !== k) list.innerHTML = '<li class="pick-msg">正在加载…</li>';
  list.setAttribute('aria-busy', 'true');
  try {
    const r = await api.get(`/library?kind=${k}${q ? `&q=${encodeURIComponent(q)}` : ''}`);
    if (my !== seq) return;
    items = Array.isArray(r?.items) ? r.items : [];
    list.dataset.kind = k;
    render(q);
  } catch (e) {
    if (my !== seq || e.status === 401) return;
    list.dataset.kind = '';
    list.innerHTML = `<li class="pick-msg">${esc(e.message)}<button type="button" class="link-btn" data-reload>重试</button></li>`;
  } finally {
    if (my === seq) list.removeAttribute('aria-busy');
  }
}

function selectTab(t, focus = true) {
  tabs.forEach(x => {
    const sel = x === t;
    x.setAttribute('aria-selected', sel);
    x.tabIndex = sel ? 0 : -1;
  });
  list.setAttribute('aria-labelledby', t.id);
  if (focus) t.focus();
  if (kind === t.dataset.kind && list.dataset.kind === kind) return;
  kind = t.dataset.kind;
  setHint();
  load();
}

function close() {
  seq++;
  clearTimeout(timer);
  onDone = null;
  closeModal(modal);
}

/**
 * 打开选择框。models / images / files 是已经选上的（{id, name, ...}），maxModels / maxImages / maxFiles 是最多能选几个，
 * only 是只显示哪一类（model3d / image / file），也可以是几类的数组；不传 maxImages 时不显示图片这一页。
 * 点「完成」时回调 done({models, images, files})，取消时不回调
 */
export function openLibPicker({ models, images = [], files, maxModels, maxImages, maxFiles, only }, done) {
  picked = { model3d: new Map(models.map(m => [m.id, m])), image: new Map(images.map(f => [f.id, f])), file: new Map(files.map(f => [f.id, f])) };
  const shown = only ? [].concat(only) : Object.keys(NAME);
  // 工作流的节点只选几类：3D 图片节点选 3D 图片，文字节点选文件和图片
  tabs.forEach(t => { t.hidden = !shown.includes(t.dataset.kind) || (t.dataset.kind === 'image' && maxImages == null); });
  limits = { model3d: maxModels, image: Math.max(0, maxImages || 0), file: Math.max(0, maxFiles) };
  onDone = done;
  $('#lp-q').value = '';
  list.dataset.kind = '';
  items = [];
  counts();
  openModal(modal, $('#lp-q'));
  kind = '';
  const vis = tabs.filter(t => !t.hidden);
  selectTab(vis.find(t => t.getAttribute('aria-selected') === 'true') || vis[0] || tabs[0], false);
}

export function init() {
  tabs.forEach((t, i) => {
    t.addEventListener('click', () => selectTab(t));
    t.addEventListener('keydown', e => {
      const vis = tabs.filter(x => !x.hidden), j = vis.indexOf(t);
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') selectTab(vis[(j + (e.key === 'ArrowRight' ? 1 : vis.length - 1)) % vis.length]);
    });
  });
  $('#lp-q').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(load, 250); });
  list.addEventListener('change', e => {
    const box = e.target.closest('input[type=checkbox]');
    if (!box) return;
    const map = picked[kind];
    if (box.checked) {
      if (map.size >= limits[kind]) {
        box.checked = false;
        setHint(kind === 'model3d' ? `3D 图片最多选 ${limits.model3d} 个，先取消一个再选。`
          : kind === 'image' ? (limits.image ? `这次最多选 ${limits.image} 张图片，一支片子合计最多 8 张。` : hintText())
          : limits.file ? `这次最多选 ${limits.file} 份文件，参考资料合计最多 10 份。` : hintText(), true);
        return;
      }
      map.set(box.value, items.find(x => x.id === box.value));
    } else map.delete(box.value);
    setHint();
    counts();
  });
  modal.addEventListener('click', e => {
    if (e.target === modal || e.target.closest('[data-close]')) close();
    if (e.target.closest('[data-reload]')) load();
  });
  $('#lp-done').addEventListener('click', () => {
    const done = onDone;
    const result = { models: [...picked.model3d.values()], images: [...picked.image.values()], files: [...picked.file.values()] };
    close();
    done?.(result);
  });
  addEventListener('keydown', e => { if (e.key === 'Escape' && !modal.hidden) close(); });
}
