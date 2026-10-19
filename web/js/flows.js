/* 工作流模式首页（#flows）：新建（内置模板）、最近运行的画板、我的工作流。打开在 flow.js 的画板里 */

import { $, esc, relTime, toast } from './util.js';
import { api } from './api.js';
import { loadSkills } from './catalog.js';
import { TEMPLATES, mini, summary, counts } from './flowdefs.js';

let items = [];
let seq = 0;

function card(w, kind) {
  const href = kind === 'tpl' ? `#flow/new:tpl:${w.id}` : kind === 'my' ? `#flow/new:my:${w.id}` : `#flow/${w.id}`;
  const blank = !(w.doc?.nodes || []).length;
  const sub = kind === 'tpl' ? w.desc : summary(w.doc) || '空画板';
  const acts = kind === 'tpl' ? `<span class="count">${blank ? '空画板' : esc(counts(w.doc))}</span>`
    : `<span class="count">${esc(relTime(w.updatedAt))}${blank ? '' : ` · ${esc(counts(w.doc))}`}</span>
       <button type="button" class="icon-btn" data-rename="${esc(w.id)}" aria-label="给「${esc(w.name)}」改名" title="改名"><svg><use href="#i-edit"/></svg></button>
       <button type="button" class="icon-btn" data-del="${esc(w.id)}" aria-label="删除「${esc(w.name)}」" title="删除"><svg><use href="#i-trash"/></svg></button>`;
  return `<li class="wf-card${blank ? ' is-blank' : ''}">
    <a class="wf-card-open" href="${href}">${mini(w.doc)}<span class="wf-card-txt"><b>${esc(w.name)}</b><small>${esc(sub)}</small></span></a>
    <div class="wf-card-bar">${acts}</div></li>`;
}

function render() {
  $('#wf-tpls').innerHTML = TEMPLATES.map(t => card(t, 'tpl')).join('');
  const my = items.filter(x => x.kind === 'template'), recent = items.filter(x => x.kind === 'canvas').slice(0, 24);
  $('#wf-my').innerHTML = my.map(w => card(w, 'my')).join('');
  $('#wf-my-n').textContent = my.length ? `${my.length} 个` : '';
  $('#wf-my-empty').hidden = !!my.length;
  $('#wf-recent').innerHTML = recent.map(w => card(w, 'canvas')).join('');
  $('#wf-recent-n').textContent = recent.length ? `${recent.length} 个` : '';
  $('#wf-recent-box').hidden = !recent.length;
}

async function load() {
  const my = ++seq;
  try {
    const r = await api.get('/flows');
    if (my !== seq) return;
    items = Array.isArray(r?.items) ? r.items : [];
    $('#wf-msg').hidden = true;
  } catch (e) {
    if (my !== seq || e.status === 401) return;
    $('#wf-msg').textContent = `没有取到保存的工作流：${e.message}`;
    $('#wf-msg').hidden = false;
  }
  render();
}

async function rename(id) {
  const w = items.find(x => x.id === id);
  const v = prompt('新名称', w?.name || '')?.trim();
  if (!w || !v || v === w.name) return;
  try { await api.patch(`/flows/${encodeURIComponent(id)}`, { name: v }); w.name = v; render(); } catch (e) { if (e.status !== 401) toast(e.message, 'error'); }
}

async function remove(id) {
  const w = items.find(x => x.id === id);
  if (!w) return;
  const what = w.kind === 'canvas' ? `删除画板「${w.name}」？用它跑过的任务还在"任务"页里，不受影响。` : `删除工作流「${w.name}」？用它跑过的任务不受影响。`;
  if (!confirm(what)) return;
  try { await api.del(`/flows/${encodeURIComponent(id)}`); items = items.filter(x => x !== w); render(); } catch (e) { if (e.status !== 401) toast(e.message, 'error'); }
}

export function enter() {
  render();
  load();
  loadSkills().then(render).catch(() => {});  // 摘要里的画风名、写作方法名来自目录
}

export function init() {
  $('#view-flows').addEventListener('click', e => {
    const r = e.target.closest('[data-rename]'), d = e.target.closest('[data-del]');
    if (r) rename(r.dataset.rename);
    else if (d) remove(d.dataset.del);
  });
}
