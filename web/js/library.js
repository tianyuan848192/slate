/* 素材库 #library：视频、3D 图片、图片、文件四类，按更新时间倒序，可以搜索。
   图片是新建视频时上传过的普通图片，带着当时写的描述（可以改），下次选用时一起带出来。
   视频点开播放、选版本下载；3D 图片点开可以拖动旋转（可拆解的还能拆开），看多角度图和零件，导出 3D 打印文件，
   「用它做视频」带着它去新建视频；文件可以下载。3D 图片没有视频，老条目带的 turntable 不显示。
   每一项都能改名、编辑标签、从素材库移除。改名和标签的弹窗、素材卡也给生成页用。接口见 docs/library-3d-design.md 第五、六节 */

import { $, $$, esc, toast, relTime, dateTime, mss, fmtSize, safeUrl, openModal, closeModal } from './util.js';
import { api } from './api.js';
import { thumbArt } from './art.js';
import { loadSkills } from './catalog.js';
import { mountViewer, heroView, angleLabel } from './viewer3d.js';
import { useModel, setProduct } from './compose.js';
import { openPrint, closePrint } from './printdlg.js';

const EMPTY = {
  video: '还没有视频。视频任务完成后，成片会自动进到这里，每个版本都在。<a href="#compose" data-new="video">新建一支视频</a>',
  model3d: '还没有 3D 图片。在新建页切到「3D 图片」做一个，做完会自动进到这里。<a href="#compose" data-new="model3d">新建 3D 图片</a>',
  file: '还没有文件。新建视频时上传的参考资料，会在开始生成时自动进到这里，下次直接选用，不用重新上传。',
  image: '还没有图片。新建视频时上传的图片，会在开始生成时连同描述一起进到这里，下次直接选用，不用重新上传。',
};
const TAGS_MAX = 10, TAG_LEN = 20;

const grid = $('#lib-grid');
const tabs = $$('#lib-tabs [role=tab]');
const modal = $('#mat-modal');
const editBox = $('#mat-edit');
const delBox = $('#mat-del');

let kind = 'video';
let items = null;     // 当前类别的条目；null 表示还没加载
let active = false;
let seq = 0;
let timer = 0;
let open = null;      // 预览弹窗里的条目
let viewer = null;    // 预览弹窗里的 3D 预览
let videoN = null;    // 预览弹窗里正在放的视频版本
let editing = null;   // 改名和标签：{kind, item, resolve}
let removing = null;  // 等确认移除的条目

/* ---------- 素材卡（生成页也用） ---------- */

const tagList = tags => (Array.isArray(tags) && tags.length
  ? `<ul class="mat-tags">${tags.map(t => `<li>${esc(t)}</li>`).join('')}</ul>` : '');

function partsHtml(parts) {
  if (!Array.isArray(parts) || !parts.length) return '';
  return `<h3>零件<small>${parts.length} 个，做视频时可以单独动</small></h3><div class="parts-wrap"><table class="parts">
    <thead><tr><th scope="col">编号</th><th scope="col">名称</th><th scope="col">说明</th></tr></thead>
    <tbody>${parts.map(p => `<tr><td><code>${esc(p.id)}</code></td><td>${esc(p.name || '')}</td><td>${esc(p.note || '')}</td></tr>`).join('')}</tbody>
  </table></div>`;
}

/** 拆解步骤（asset.explode.steps）：每一步的说明和拆下来的零件，零件编号换成零件表里的名称 */
function explodeHtml(ex, parts) {
  const steps = (Array.isArray(ex?.steps) ? ex.steps : []).filter(s => s && typeof s === 'object');
  if (!steps.length) return '';
  const names = new Map((Array.isArray(parts) ? parts : []).filter(p => p?.id).map(p => [p.id, p.name || p.id]));
  const pid = p => (typeof p === 'string' ? p : p?.id); // 约定是零件编号；也接受 {id, offset}
  return `<h3>拆解步骤<small>${steps.length} 步，做视频时可以一步步拆开</small></h3><ol class="ex-steps">${steps.map((s, i) => {
    const ids = (Array.isArray(s.parts) ? s.parts : []).map(pid).filter(Boolean);
    return `<li><b>${esc(s.label || `第 ${i + 1} 步`)}</b><span>${esc(ids.map(x => names.get(x) || x).join('、') || '—')}</span></li>`;
  }).join('')}</ol>`;
}

/** 素材卡：名称、标签、简介、零件表、拆解步骤、推荐拍法、局限 */
export function assetHtml(a) {
  const list = (title, xs) => (Array.isArray(xs) && xs.length ? `<h3>${title}</h3><ul class="asset-list">${xs.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : '');
  return `<div class="asset-h"><b>${esc(a.name || '')}</b>${tagList(a.tags)}</div>
    ${a.summary ? `<p class="asset-sum">${esc(a.summary)}</p>` : ''}
    ${partsHtml(a.parts)}${explodeHtml(a.explode, a.parts)}${list('推荐拍法', a.recommendedShots)}${list('局限', a.limits)}`;
}

const viewsHtml = views => (Array.isArray(views) && views.length ? `<ul class="views">${views.map(v => {
  const href = safeUrl(v.url);
  const label = esc(angleLabel(v.angle));
  return href ? `<li><a href="${esc(href)}" target="_blank" rel="noopener noreferrer"><img src="${esc(href)}" alt="${label}" loading="lazy"></a><span>${label}</span></li>` : '';
}).join('')}</ul>` : '');

/* ---------- 列表 ---------- */

const lastVersion = x => [...(x.versions || [])].sort((a, b) => b.n - a.n)[0] || null;
const extOf = name => { const i = String(name).lastIndexOf('.'); return i > 0 ? name.slice(i + 1).toLowerCase() : ''; };

function card(x) {
  const name = esc(x.name || '未命名');
  const download = (x.kind === 'file' || x.kind === 'image') && safeUrl(x.download);
  const acts = `<div class="mat-acts">
    ${download ? `<a class="icon-btn" href="${esc(download)}" download="${esc(x.name || '')}" data-act="download" aria-label="下载「${name}」" title="下载"><svg><use href="#i-download"/></svg></a>` : ''}
    <button type="button" class="icon-btn" data-act="edit" aria-label="改名或编辑「${name}」的标签" title="改名和标签"><svg><use href="#i-edit"/></svg></button>
    <button type="button" class="icon-btn" data-act="remove" aria-label="从素材库移除「${name}」" title="从素材库移除"><svg><use href="#i-trash"/></svg></button>
  </div>`;
  if (x.kind === 'image') {
    const src = safeUrl(x.url);
    return `<li class="mat-card is-image" data-id="${esc(x.id)}">
      ${src ? `<a class="mat-thumb" href="${esc(src)}" target="_blank" rel="noopener noreferrer" aria-label="查看大图「${name}」"><img src="${esc(src)}" alt="" loading="lazy"></a>` : '<span class="mat-thumb"><svg class="mat-ph" aria-hidden="true"><use href="#i-image"/></svg></span>'}
      <div class="mat-body"><b class="mat-name" title="${name}">${name}</b><p class="mat-desc">${esc(x.desc || '')}</p><p class="mat-meta">${esc([fmtSize(x.size || 0), relTime(x.updatedAt)].join(' · '))}</p>${tagList(x.tags)}</div>
      ${acts}
    </li>`;
  }
  if (x.kind === 'file') {
    return `<li class="mat-card is-file" data-id="${esc(x.id)}">
      <span class="mat-file" aria-hidden="true"><svg><use href="#i-doc"/></svg><em>${esc(extOf(x.name))}</em></span>
      <div class="mat-body"><b class="mat-name" title="${name}">${name}</b><p class="mat-meta">${esc([fmtSize(x.size || 0), relTime(x.updatedAt)].join(' · '))}</p>${tagList(x.tags)}</div>
      ${acts}
    </li>`;
  }
  const v = x.kind === 'video' ? lastVersion(x) : null;
  const img = x.kind === 'model3d' && heroView(x.views);
  const media = x.kind === 'video'
    ? `${thumbArt(x.thumb, '')}${v?.dur ? `<span class="mat-badge">${esc(mss(v.dur))}</span>` : ''}<span class="mat-play" aria-hidden="true"><svg><use href="#i-play"/></svg></span>`
    : img ? `<img src="${esc(img)}" alt="" loading="lazy">` : '<svg class="mat-ph" aria-hidden="true"><use href="#i-cube"/></svg>';
  const n = x.kind === 'video' ? (x.versions || []).length : 0;
  const meta = [relTime(x.updatedAt), n > 1 && `${n} 个版本`, x.kind === 'model3d' && x.version && `第 ${x.version} 版`].filter(Boolean).join(' · ');
  return `<li class="mat-card is-${x.kind}" data-id="${esc(x.id)}">
    <button type="button" class="mat-thumb" data-act="open" aria-label="${x.kind === 'video' ? '播放' : '预览'}「${name}」">${media}</button>
    <div class="mat-body"><b class="mat-name" title="${name}">${name}</b><p class="mat-meta">${x.kind === 'model3d' && x.explode ? '<em class="ex-tag">可拆解</em>' : ''}${esc(meta)}</p>${tagList(x.tags)}</div>
    ${acts}
  </li>`;
}

function message(html) {
  grid.innerHTML = '';
  const p = $('#lib-empty');
  p.innerHTML = html;
  p.hidden = false;
}

function render() {
  if (!items) return;
  // 重绘后焦点还放在同一张卡的同一个按钮上
  const f = document.activeElement;
  const keep = grid.contains(f) && f.closest('.mat-card') ? [f.closest('.mat-card').dataset.id, f.dataset.act] : null;
  grid.innerHTML = items.map(card).join('');
  if (keep) $(`.mat-card[data-id="${CSS.escape(keep[0])}"] [data-act="${keep[1]}"]`, grid)?.focus();
  const q = $('#lib-q').value.trim();
  if (items.length) $('#lib-empty').hidden = true;
  else message(q ? `没有符合「${esc(q)}」的素材，换个关键词试试。` : EMPTY[kind]);
}

async function load() {
  clearTimeout(timer);
  const my = ++seq, k = kind, q = $('#lib-q').value.trim();
  if (!items) message('正在加载素材…');
  const panel = $('#lib-panel');
  panel.classList.add('is-loading');
  try {
    // 风格目录一起取（只取一次）：生成风格的缩略图链接在目录里。目录没取到不影响素材
    const [r] = await Promise.all([api.get(`/library?kind=${k}${q ? `&q=${encodeURIComponent(q)}` : ''}`), loadSkills().catch(() => {})]);
    if (my !== seq || !active) return;
    items = Array.isArray(r?.items) ? r.items : [];
    render();
  } catch (e) {
    if (my !== seq || !active || e.status === 401) return;
    if (!items) message(`${esc(e.message)}<button type="button" class="link-btn" data-reload>重试</button>`);
    else toast(e.message, 'error');
  } finally {
    if (my === seq) panel.classList.remove('is-loading');
  }
}

function selectTab(t, focus = true) {
  tabs.forEach(x => {
    const sel = x === t;
    x.setAttribute('aria-selected', sel);
    x.tabIndex = sel ? 0 : -1;
  });
  $('#lib-panel').setAttribute('aria-labelledby', t.id);
  if (focus) t.focus();
  if (kind === t.dataset.kind && items) return;
  kind = t.dataset.kind;
  items = null;
  load();
}

const byId = id => items?.find(x => x.id === id) || null;

/* ---------- 预览：视频播放和版本；3D 预览、多角度图、零件和导出打印文件 ---------- */

function paintHead() {
  $('#mat-h').textContent = open.name || '未命名';
  $('#mat-ex').hidden = !(open.kind === 'model3d' && open.explode);
  $('#mat-tags').innerHTML = (open.tags || []).map(t => `<li>${esc(t)}</li>`).join('');
}

function paintVideo() {
  const vs = [...(open.versions || [])].sort((a, b) => b.n - a.n);
  const v = vs.find(y => y.n === videoN) || vs[0];
  const el = $('#mat-video');
  if (v?.url && el.dataset.n !== String(v.n)) { el.src = v.url; el.dataset.n = String(v.n); }
  $('#mat-versions').innerHTML = vs.map(y => {
    const href = safeUrl(y.download || y.url);
    return `<li><button type="button" data-ver="${y.n}" aria-pressed="${y.n === v?.n}">第 ${y.n} 版${y.dur ? `<small>${esc(mss(y.dur))}</small>` : ''}</button>${href ? `<a class="icon-btn" href="${esc(href)}" download aria-label="下载第 ${y.n} 版" title="下载第 ${y.n} 版"><svg><use href="#i-download"/></svg></a>` : ''}</li>`;
  }).join('');
}

function openPreview(x) {
  open = x;
  paintHead();
  const body = $('#mat-body');
  const task = `<a class="btn ghost small" href="#run/${encodeURIComponent(x.id)}">打开任务</a>`;
  if (x.kind === 'video') {
    videoN = lastVersion(x)?.n ?? null;
    body.innerHTML = '<div class="mat-player"><video id="mat-video" controls playsinline preload="metadata"></video></div><ul class="mat-versions" id="mat-versions" aria-label="版本"></ul>';
    paintVideo();
    $('#mat-foot').innerHTML = `<span>创建于 ${esc(dateTime(x.createdAt))}</span><span class="modal-btns">${task}</span>`;
  } else {
    const glb = safeUrl(x.glb);
    body.innerHTML = `<div class="mat-3d">
      <div class="mat-stage"><div class="v3-host" id="mat-viewer"></div></div>
      <div class="mat-side asset">
        ${x.summary ? `<p class="asset-sum">${esc(x.summary)}</p>` : ''}
        ${viewsHtml(x.views)}
        ${partsHtml(x.parts)}
      </div>
    </div>`;
    viewer = mountViewer($('#mat-viewer'));
    viewer.load(() => api.get(`/tasks/${encodeURIComponent(x.id)}/module${x.version ? `?v=${x.version}` : ''}`), `「${x.name}」的 3D 预览`);
    $('#mat-foot').innerHTML = `<span>${x.version ? `第 ${x.version} 版，` : ''}更新于 ${esc(dateTime(x.updatedAt))}</span><span class="modal-btns">${task}${glb ? `<a class="btn ghost small" href="${esc(glb)}" download><svg><use href="#i-download"/></svg>下载 GLB</a>` : ''}${x.printable === true ? '<button type="button" class="btn ghost small" data-act="print" aria-haspopup="dialog"><svg><use href="#i-print3d"/></svg>导出 3D 打印文件</button>' : ''}<button type="button" class="btn primary small" data-act="use">用它做视频</button></span>`;
  }
  modal.querySelector('.modal-card').classList.toggle('is-3d', x.kind === 'model3d');
  openModal(modal, $('[data-close]', modal));
}

function closePreview() {
  if (modal.hidden) return;
  closePrint();
  viewer?.dispose();
  viewer = null;
  $('#mat-body').innerHTML = ''; // 视频跟着停下
  open = null;
  closeModal(modal);
}

function useIt(x) {
  if (!useModel(x)) return;
  closePreview();
  location.hash = 'compose';
  toast(`「${x.name}」已加到新视频的资料里，写好描述就能开始`);
}

/* ---------- 改名和标签 ---------- */

/** 打开改名和标签的弹窗；保存成功时返回更新后的条目，取消时返回 null */
export function editLibItem(k, item) {
  editing?.resolve(null);
  return new Promise(resolve => {
    editing = { kind: k, item, resolve };
    $('#mat-name').value = item.name || '';
    $('#mat-tags-input').value = (item.tags || []).join('，');
    $('#mat-desc-field').hidden = k !== 'image';  // 图片还能改描述
    $('#mat-desc').value = item.desc || '';
    $('#mat-edit-h').textContent = k === 'image' ? '改名、描述和标签' : '改名和标签';
    $('#mat-edit-err').hidden = true;
    openModal(editBox, $('#mat-name'));
  });
}

function closeEdit(result = null) {
  if (editBox.hidden) return;
  const e = editing;
  editing = null;
  closeModal(editBox);
  e?.resolve(result);
}

async function saveEdit(ev) {
  ev.preventDefault();
  const btn = $('#mat-edit-ok');
  if (!editing || btn.disabled) return;
  const err = msg => { const p = $('#mat-edit-err'); p.textContent = msg; p.hidden = false; };
  const name = $('#mat-name').value.trim();
  const tags = [...new Set($('#mat-tags-input').value.split(/[,，、;；\s]+/).map(x => x.trim()).filter(Boolean))];
  if (!name) { err('名称不能为空'); $('#mat-name').focus(); return; }
  if (tags.length > TAGS_MAX) { err(`标签最多 ${TAGS_MAX} 个，现在有 ${tags.length} 个`); return; }
  const long = tags.find(t => [...t].length > TAG_LEN);
  if (long) { err(`「${long}」太长了，每个标签不超过 ${TAG_LEN} 字`); return; }
  const { kind: k, item } = editing;
  const body = {};
  if (name !== item.name) body.name = name;
  if (tags.join('\n') !== (item.tags || []).join('\n')) body.tags = tags;
  if (k === 'image') {
    const desc = $('#mat-desc').value.replace(/\s+/g, ' ').trim();
    if (!desc) { err('描述不能为空：这是什么、想在片子里怎么用'); $('#mat-desc').focus(); return; }
    if (desc !== (item.desc || '')) body.desc = desc;
  }
  if (!Object.keys(body).length) { closeEdit(); return; }
  btn.disabled = true;
  try {
    const saved = await api.patch(`/library/${k}/${encodeURIComponent(item.id)}`, body);
    toast('已保存');
    closeEdit(saved && typeof saved === 'object' ? saved : { ...item, ...body });
  } catch (e) {
    if (e.status !== 401) err(e.message);
  } finally {
    btn.disabled = false;
  }
}

async function edit(x) {
  const saved = await editLibItem(x.kind, x);
  if (!saved) return;
  if (items) {
    const i = items.findIndex(y => y.id === saved.id);
    if (i >= 0) { items[i] = { ...items[i], ...saved }; render(); }
  }
  if (open?.id === saved.id) { open = { ...open, ...saved }; paintHead(); }
  load(); // 更新时间变了，按服务端的顺序重新排
}

/* ---------- 从素材库移除 ---------- */

function askRemove(x) {
  removing = x;
  const file = x.kind === 'file' || x.kind === 'image';
  $('#mat-del-h').textContent = `${file ? '删除' : '从素材库移除'}「${x.name || '未命名'}」？`;
  $('#mat-del-text').textContent = file
    ? `${x.kind === 'image' ? '图片' : '文件'}会被删除，不能恢复。已经用过它的任务不受影响。`
    : `只是从素材库里移除，任务列表里还在，随时可以打开。${x.kind === 'model3d' ? '已经引用过它的视频也不受影响。' : ''}`;
  $('#mat-del-ok').textContent = file ? (x.kind === 'image' ? '删除图片' : '删除文件') : '移除';
  openModal(delBox, $('.btn[data-close]', delBox));
}

function closeDel() {
  if (delBox.hidden) return;
  removing = null;
  closeModal(delBox);
}

async function doRemove() {
  const x = removing, btn = $('#mat-del-ok');
  if (!x || btn.disabled) return;
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = '正在移除…';
  try {
    await api.del(`/library/${x.kind}/${encodeURIComponent(x.id)}`);
    closeDel();
    if (open?.id === x.id) closePreview();
    const i = items ? items.findIndex(y => y.id === x.id) : -1;
    if (i >= 0) {
      items.splice(i, 1);
      render();
      // 焦点放到下一张卡，没有了就回到搜索框
      const cards = $$('.mat-card', grid);
      const next = cards[Math.min(i, cards.length - 1)];
      (next ? $('[data-act]', next) : $('#lib-q')).focus();
    }
    toast(x.kind === 'file' || x.kind === 'image' ? `已删除「${x.name}」` : `已从素材库移除「${x.name}」，任务列表里还在`);
  } catch (e) {
    if (e.status !== 401) toast(e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

/* ---------- 生命周期和事件 ---------- */

export function enter() {
  active = true;
  if (items) render();
  load();
}

export function leave() {
  active = false;
  clearTimeout(timer);
  closeDel();
  closeEdit();
  closePreview();
}

export function init() {
  tabs.forEach((t, i) => {
    t.addEventListener('click', () => selectTab(t));
    t.addEventListener('keydown', e => {
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') selectTab(tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length]);
    });
  });
  $('#lib-q').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(load, 250); });
  $('#lib-empty').addEventListener('click', e => {
    if (e.target.closest('[data-reload]')) { message('正在加载素材…'); load(); }
    const n = e.target.closest('[data-new]');
    if (n) setProduct(n.dataset.new);
  });
  grid.addEventListener('click', e => {
    const b = e.target.closest('[data-act]');
    const x = b && byId(b.closest('.mat-card')?.dataset.id);
    if (!x) return;
    if (b.dataset.act === 'open') openPreview(x);
    if (b.dataset.act === 'edit') edit(x);
    if (b.dataset.act === 'remove') askRemove(x);
  });

  modal.addEventListener('click', e => {
    if (e.target === modal || e.target.closest('[data-close]')) { closePreview(); return; }
    const b = e.target.closest('[data-act], [data-ver]');
    if (!b || !open) return;
    if (b.dataset.ver) {
      videoN = Number(b.dataset.ver);
      paintVideo();
      $('#mat-video').play().catch(() => {});
    }
    if (b.dataset.act === 'edit') edit(open);
    if (b.dataset.act === 'remove') askRemove(open);
    if (b.dataset.act === 'use') useIt(open);
    if (b.dataset.act === 'print') openPrint({ taskId: open.id, v: open.version, name: open.name, explode: !!open.explode });
  });

  $('#mat-edit-form').addEventListener('submit', saveEdit);
  editBox.addEventListener('click', e => { if (e.target === editBox || e.target.closest('[data-close]')) closeEdit(); });
  delBox.addEventListener('click', e => { if (e.target === delBox || e.target.closest('[data-close]')) closeDel(); });
  $('#mat-del-ok').addEventListener('click', doRemove);

  // Esc 先关最上面的一层
  addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    if (!delBox.hidden) closeDel();
    else if (!editBox.hidden) closeEdit();
    else closePreview();
  });
}
