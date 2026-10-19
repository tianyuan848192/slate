/* 任务列表 #projects：视频和 3D 图片都在这里。按状态筛选、搜名称、失败行重试，点行进入生成页；每行显示这个任务用了多少 Credit */

import { $, $$, esc, toast, relTime } from './util.js';
import { thumbArt } from './art.js';
import { loadSkills } from './catalog.js';
import { api } from './api.js';
import { fmt } from './credits.js';

// 筛选规则和 API 一致：active = queued / running / awaiting_confirmation
const GROUP = { queued: 'active', running: 'active', awaiting_confirmation: 'active', completed: 'done', failed: 'failed' };
export const STATE = {
  queued: ['wait', '排队中'],
  running: ['live', '生成中'],
  awaiting_confirmation: ['wait', '等你确认分镜'],
  completed: ['done', '已完成'],
  failed: ['failed', '失败'],
};
const REFRESH_MS = 5000; // 有进行中的任务时，列表每 5 秒刷新一次

let items = null;
let filter = 'all';
let active = false;
let timer = null;
const retrying = new Set();

function message(html) {
  $('#proj-body').innerHTML = `<tr class="is-msg"><td class="p-msg" colspan="6">${html}</td></tr>`;
}

/** 缩略图：3D 图片用 35 度斜侧图（thumbUrl），视频按风格选示意图 */
function thumb(t) {
  if (t.product === 'model3d' && t.thumbUrl) return `<img class="art is-3d" src="${esc(t.thumbUrl)}" alt="" loading="lazy">`;
  return thumbArt(t.thumb, '');
}

function row(t) {
  const m3d = t.product === 'model3d';
  const [cls, text] = STATE[t.status] || ['', '未知状态'];
  const failed = t.status === 'failed';
  const why = failed
    ? `<span class="fail-why">${esc(t.failure?.message || '没有拿到失败原因。')}<button type="button" data-retry="${esc(t.id)}" ${retrying.has(t.id) ? 'disabled' : ''}>让 Agent 修复后重试</button></span>`
    : '';
  const href = '#run/' + encodeURIComponent(t.id);
  return `<tr data-id="${esc(t.id)}">
    <td><div class="p-video"><span class="thumb">${thumb(t)}</span><div><a href="${href}">${esc(t.title || '新任务')}</a><p>${esc(t.description || '')}</p></div></div></td>
    <td class="p-kind">${m3d ? '3D 图片' : esc(t.kind || '待定')}</td>
    <td class="p-spec">${esc(t.spec || (m3d ? '—' : '待定'))}</td>
    <td><span class="state ${cls}">${failed ? '<i><svg style="width:14px;height:14px"><use href="#i-x"/></svg></i>' : '<i></i>'}${esc(t.statusText || text)}</span>${why}</td>
    <td class="p-cr">${t.credits == null ? '<span class="dim">—</span>' : `${fmt(t.credits)} <small>Credit</small>`}</td>
    <td class="p-time">${esc(relTime(t.updatedAt))}</td>
  </tr>`;
}

function render() {
  if (!items) return;
  const q = $('#proj-q').value.trim().toLowerCase();
  const c = { all: items.length, active: 0, done: 0, failed: 0 };
  items.forEach(t => { const g = GROUP[t.status]; if (g) c[g]++; });
  $$('#proj-filter button').forEach(b => { $('span', b).textContent = c[b.dataset.f] ?? 0; });

  if (!items.length) return message('还没有任务。<a href="#compose">新建一支视频或一张 3D 图片</a>');
  const rows = items.filter(t => (filter === 'all' || GROUP[t.status] === filter) && (!q || String(t.title || '').toLowerCase().includes(q)));
  if (!rows.length) return message(q ? '没有名称符合的任务，换个关键词试试。' : '这个分类下还没有任务。');
  $('#proj-body').innerHTML = rows.map(row).join('');
}

async function load() {
  clearTimeout(timer);
  try {
    // 风格目录一起取（只取一次）：生成风格的缩略图链接在目录里。目录没取到不影响列表
    const [r] = await Promise.all([api.get('/tasks?status=all'), loadSkills().catch(() => {})]);
    if (!active) return;
    items = Array.isArray(r?.items) ? r.items : [];
    render();
  } catch (e) {
    if (!active || e.status === 401) return;
    if (!items) message(`${esc(e.message)}<button type="button" class="link-btn" data-reload>重试</button>`);
    else toast(e.message, 'error');
  }
  if (active && items?.some(t => GROUP[t.status] === 'active')) timer = setTimeout(load, REFRESH_MS);
}

async function retry(id, btn) {
  if (retrying.has(id)) return;
  retrying.add(id);
  btn.disabled = true;
  try {
    await api.post(`/tasks/${encodeURIComponent(id)}/retry`);
    toast('已让 Agent 修复后重试');
  } catch (e) {
    if (e.status !== 401) toast(e.message, 'error');
  } finally {
    retrying.delete(id);
    if (active) load();
  }
}

export function enter() {
  active = true;
  if (!items) message('正在加载任务…');
  else render();
  load();
}

export function leave() {
  active = false;
  clearTimeout(timer);
}

export function init() {
  $('#proj-filter').addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    $$('#proj-filter button').forEach(x => x.setAttribute('aria-selected', x === b));
    filter = b.dataset.f;
    render();
  });
  $('#proj-q').addEventListener('input', render);
  $('#proj-body').addEventListener('click', e => {
    if (e.target.closest('[data-reload]')) { message('正在加载任务…'); load(); return; }
    const rb = e.target.closest('[data-retry]');
    if (rb) { e.stopPropagation(); retry(rb.dataset.retry, rb); return; }
    if (e.target.closest('a')) return;
    const tr = e.target.closest('tr[data-id]');
    if (tr) location.hash = 'run/' + encodeURIComponent(tr.dataset.id);
  });
}
