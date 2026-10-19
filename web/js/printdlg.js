/* 导出 3D 打印文件（docs/library-3d-design.md 第六节）：生成页和素材库共用一个弹窗。
   选机型、高度、出法、颜色数和格式 → POST /api/tasks/{id}/print（要 10～30 秒）→ 显示成品尺寸、零件数、颜色和警告，给一个下载链接。
   宽和深放不放得下热床前端算不了，交给后端检查，400 时直接显示它的中文说明 */

import { $, esc, safeUrl, openModal, closeModal } from './util.js';
import { api } from './api.js';

// 机型来自 Bambu Studio 的机型配置：热床宽、深和最大打印高度（毫米）。值和后端一致
const PRINTERS = {
  a1mini: { name: 'A1 mini', size: [180, 180, 180] },
  a1: { name: 'A1 · P1 · X1 · P2S', size: [256, 256, 256] },
  h2d: { name: 'H2D', size: [350, 320, 325] },
  h2s: { name: 'H2S', size: [340, 320, 340] },
};
const MIN_H = 10;
const TIMEOUT = 90000; // 生成要 10～30 秒，接口超时放宽

const modal = $('#print-modal');
const form = $('#print-form');

let target = null; // 正在导出的模型：{taskId, v, name, explode}
let seq = 0;       // 关掉或重新提交后，丢弃旧请求的结果
let busy = false;
let wired = false;
let last = { printer: 'a1', height: 120, colors: 4, format: '3mf' }; // 这次打开页面以来上一次的选择（出法每次按模型定）

const val = name => form.querySelector(`input[name="${name}"]:checked`)?.value;
const mm = n => (Number.isFinite(Number(n)) ? String(Math.round(Number(n) * 10) / 10) : '—');
const cleanHex = h => (typeof h === 'string' && /^#[0-9a-f]{6}$/i.test(h) ? h.toUpperCase() : null);

function err(text) {
  const p = $('#pr-err');
  p.textContent = text || '';
  p.hidden = !text;
}

/** 机型和格式变了：高度的上限、说明，STL 只有单色 */
function sync() {
  const p = PRINTERS[$('#pr-printer').value] || PRINTERS.a1;
  $('#pr-height').max = String(p.size[2]);
  $('#pr-height-hint').textContent = `${MIN_H} 到 ${p.size[2]} 毫米。宽和深按模型比例缩放，放不下 ${p.size[0]}×${p.size[1]} 毫米的热床时会提示。`;
  const stl = val('pr-format') === 'stl';
  $('#pr-colors').disabled = stl;
  $('#pr-colors-hint').textContent = stl ? 'STL 只有一种颜色，要多色请选 3MF' : '4 色正好一组 AMS';
}

function setBusy(on) {
  busy = on;
  $('#pr-fields').disabled = on;
  const ok = $('#pr-ok');
  ok.disabled = on;
  ok.classList.toggle('is-busy', on);
  ok.textContent = on ? '正在生成…' : '生成打印文件';
  $('#pr-busy').hidden = !on;
}

/** 表单 → 请求体；不合法时返回 [null, 提示] */
function read() {
  const printer = $('#pr-printer').value;
  const p = PRINTERS[printer];
  if (!p) return [null, '先选一台机型'];
  const raw = $('#pr-height').value.trim();
  const height = Number(raw);
  if (!raw || !Number.isFinite(height)) return [null, '填一个高度，单位是毫米'];
  if (height < MIN_H) return [null, `高度最少 ${MIN_H} 毫米`];
  if (height > p.size[2]) return [null, `${p.name} 最高打 ${p.size[2]} 毫米。把高度调低一些，或者换一台机型`];
  const format = val('pr-format') === 'stl' ? 'stl' : '3mf';
  return [{
    v: target.v, printer, height: Math.round(height * 10) / 10, mode: val('pr-mode') === 'parts' ? 'parts' : 'whole',
    colors: format === 'stl' ? 1 : Number($('#pr-colors').value), format,
  }, null];
}

function showStep(done) {
  $('#pr-set').hidden = done;
  $('#pr-done').hidden = !done;
  $('#pr-btns-set').hidden = done;
  $('#pr-btns-done').hidden = !done;
  $('#pr-note').hidden = done;
}

/** 生成好了：成品尺寸、零件数和物体数、颜色、警告、下载 */
function showReport(r, body, href) {
  const rep = r.report && typeof r.report === 'object' ? r.report : {};
  const [w, d, h] = Array.isArray(rep.sizeMm) ? rep.sizeMm : [];
  const colors = (Array.isArray(rep.colors) ? rep.colors : []).filter(c => c && typeof c === 'object');
  const warns = (Array.isArray(rep.warnings) ? rep.warnings : []).filter(x => typeof x === 'string' && x.trim());
  const file = String(r.file || '').trim() || `3D打印文件.${body.format === 'stl' && body.mode === 'parts' ? 'zip' : body.format}`;
  const stat = (k, v) => (v == null || v === '' ? '' : `<div><dt>${k}</dt><dd>${v}</dd></div>`);
  const num = n => (Number.isFinite(Number(n)) ? esc(Number(n)) : null);
  const colorRows = colors.map(c => {
    const hex = cleanHex(c.hex);
    const names = (Array.isArray(c.parts) ? c.parts : []).filter(Boolean).map(String);
    return `<li>${hex ? `<i class="pr-sw" style="background:${hex}" aria-hidden="true"></i>` : '<i></i>'}<code>${esc(hex || c.hex || '')}</code><span>${esc(names.join('、') || '—')}</span></li>`;
  }).join('');
  $('#pr-done').innerHTML = `<p class="pr-ok"><svg aria-hidden="true"><use href="#i-check"/></svg>打印文件做好了</p>
    <dl class="pr-stats">
      ${stat('成品尺寸', w != null ? `${mm(w)} × ${mm(d)} × ${mm(h)}<small>毫米（宽 × 深 × 高）</small>` : '')}
      ${stat('零件数', num(rep.parts))}
      ${stat('物体数', num(rep.objects))}
    </dl>
    ${colorRows ? `<h3>颜色<small>${colors.length} 种，每种用在哪些零件</small></h3><ul class="pr-colors">${colorRows}</ul>` : ''}
    ${warns.length ? `<h3>注意<small>${warns.length} 条，打印前看一下</small></h3><ul class="pr-warns">${warns.map(x => `<li><svg aria-hidden="true"><use href="#i-alert"/></svg><span>${esc(x)}</span></li>`).join('')}</ul>` : ''}
    <a class="btn primary big pr-dl" id="pr-dl" href="${esc(href)}" download="${esc(file)}" rel="noopener"><svg aria-hidden="true"><use href="#i-download"/></svg><span>下载 ${esc(file)}</span></a>
    <p class="pr-tip">${body.format === '3mf' ? '在 Bambu Studio 里打开后，导入颜色时把每种颜色对应到 AMS 的耗材；零件分开时按 A 自动排版。' : '在 Bambu Studio 里打开后选好耗材再切片；零件分开时按 A 自动排版。'}</p>`;
  showStep(true);
  $('#pr-dl').focus();
}

async function submit(e) {
  e.preventDefault();
  if (busy || !target || $('#pr-set').hidden) return; // 已经在看结果了：回车不重新提交
  const [body, why] = read();
  if (why) { err(why); $('#pr-height').focus(); return; }
  err('');
  last = { ...last, printer: body.printer, height: body.height, format: body.format, ...(body.format === '3mf' ? { colors: body.colors } : {}) };
  const my = ++seq, want = target;
  setBusy(true);
  try {
    const r = await api.post(`/tasks/${encodeURIComponent(want.taskId)}/print`, body, { timeout: TIMEOUT });
    if (my !== seq) return;
    const href = safeUrl(r?.download);
    if (!href) throw new Error('服务返回的数据不完整，请重试');
    setBusy(false);
    showReport(r, body, href);
  } catch (e2) {
    if (my !== seq) return;
    setBusy(false);
    if (e2.status !== 401) err(e2.message || '打印文件没有生成出来，请稍后再试');
    if (!modal.contains(document.activeElement)) $('#pr-ok').focus(); // 表单禁用时焦点掉出去了，放回按钮上
  }
}

function wire() {
  if (wired) return;
  wired = true;
  form.addEventListener('submit', submit);
  form.addEventListener('change', e => { if (e.target.id === 'pr-printer' || e.target.name === 'pr-format') { sync(); err(''); } });
  $('#pr-height').addEventListener('input', () => err(''));
  $('#pr-again').addEventListener('click', () => { showStep(false); $('#pr-printer').focus(); });
  // 点背景关闭；生成中不响应点背景（免得误关），关闭按钮和 Esc 照常
  modal.addEventListener('click', e => {
    if (e.target.closest('[data-close]') || (e.target === modal && !busy)) closePrint();
  });
  // 捕获阶段先处理 Esc：只关这一层，不让下面的素材库预览也跟着关
  addEventListener('keydown', e => {
    if (e.key !== 'Escape' || modal.hidden) return;
    e.stopPropagation();
    closePrint();
  }, true);
}

/**
 * 打开导出弹窗。opts：{taskId, v（版本号）, name, explode（模型有拆解步骤时默认零件分开）}
 */
export function openPrint(opts) {
  if (!opts?.taskId) return;
  wire();
  seq++;
  setBusy(false);
  target = opts;
  $('#print-sub').textContent = `「${opts.name || '3D 图片'}」${opts.v ? `第 ${opts.v} 版` : ''}`;
  $('#pr-printer').value = last.printer;
  $('#pr-height').value = String(last.height);
  $('#pr-colors').value = String(last.colors);
  form.querySelector(`input[name="pr-format"][value="${last.format}"]`).checked = true;
  form.querySelector(`input[name="pr-mode"][value="${opts.explode ? 'parts' : 'whole'}"]`).checked = true;
  sync();
  err('');
  $('#pr-done').innerHTML = '';
  showStep(false);
  openModal(modal, $('#pr-printer'));
}

export function closePrint() {
  if (modal.hidden) return;
  seq++; // 还在生成的话，结果不要了
  setBusy(false);
  target = null;
  closeModal(modal);
}
