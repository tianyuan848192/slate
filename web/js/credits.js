/* Credit：顶部额度条、任务用量明细弹窗，以及几个页面共用的格式化和日期工具。
   数字都是 Credit；日期按北京时间（后端按北京时间分日、分月） */

import { $, esc, toast, openModal, closeModal } from './util.js';
import { api, downloadFile } from './api.js';

/** 1234.5 → "1,234.50" */
export const fmt = (v, d = 2) => Number(v || 0).toLocaleString('zh-CN', { minimumFractionDigits: d, maximumFractionDigits: d });
/** 额度一般是整数，整数就不带小数 */
export const fmtQuota = v => (Number.isInteger(Number(v)) ? fmt(v, 0) : fmt(v));
const int = v => (v == null || v === '' ? '' : Number(v).toLocaleString('zh-CN'));
const pad = n => String(n).padStart(2, '0');

/* ---------- 北京时间的日期 ---------- */

const CN = 8 * 3600e3;
const ymd = d => d.toISOString().slice(0, 10); // d 已经平移到北京时间，按 UTC 读
export const cnToday = () => ymd(new Date(Date.now() + CN));
export function addDays(day, n) {
  const d = new Date(day + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return ymd(d);
}
export const daysBetween = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 864e5);
/** 快捷范围：month 本月、last 上月、数字 = 近 N 天（含今天） */
export function presetRange(p) {
  const today = cnToday();
  const [y, m] = today.split('-').map(Number);
  if (p === 'month') return [today.slice(0, 8) + '01', today];
  if (p === 'last') return [ymd(new Date(Date.UTC(y, m - 2, 1))), ymd(new Date(Date.UTC(y, m - 1, 0)))];
  return [addDays(today, -(Number(p) - 1)), today];
}
/** "2026-10-03" → "10月3日" */
export const dayLabel = s => `${Number(s.slice(5, 7))}月${Number(s.slice(8, 10))}日`;
/** "2026-10" → "2026 年 10 月" */
export const monthLabel = s => (s ? `${s.slice(0, 4)} 年 ${Number(s.slice(5, 7))} 月` : '本月');

/* ---------- 顶部额度条 ---------- */

let month = null;      // 最近一次 /me 或 /usage 返回的 credits
let overMsg = '';      // 刚收到 402 时的提示，等下一次 /me 确认
let refresher = null;  // app.js 注册的"重新拉一次 /me"
let lastRefresh = 0;

export const current = () => month;
export function setRefresher(fn) { refresher = fn; }
/** 让 app.js 重新拉一次 /me；force 以外 30 秒内最多一次 */
export function refresh(force = false) {
  if (!force && Date.now() - lastRefresh < 30000) return;
  lastRefresh = Date.now();
  refresher?.();
}

export function setMonth(c) {
  month = c && typeof c === 'object' ? c : null;
  if (month?.warn !== '100') overMsg = '';
  paint();
}

/** 已用占比（0～100） */
export function share(c) {
  const used = Number(c?.used) || 0, quota = Number(c?.quota) || 0;
  if (quota <= 0) return used > 0 ? 100 : 0;
  return Math.min(100, (used / quota) * 100);
}

function paint() {
  const strip = $('#credit-strip');
  const over = !!overMsg || month?.warn === '100';
  if (!month && !over) { strip.hidden = true; return; }
  const pct = share(month);
  const warn = !over && month?.warn === '80';
  strip.hidden = false;
  strip.classList.toggle('warn', warn);
  strip.classList.toggle('over', over);
  $('#credit-meter').hidden = !month;
  if (month) {
    $('#cm-val').textContent = `${fmt(month.used)} / ${fmtQuota(month.quota)}`;
    const track = $('#cm-track');
    track.setAttribute('aria-valuenow', String(Math.round(pct)));
    $('i', track).style.width = `${pct}%`;
  }
  const text = over
    ? `${overMsg || '本月额度已用完，下月 1 日恢复'}。在这之前不能新建视频、发修改或重试，正在进行的这一轮会做完。`
    : warn ? `本月额度已用 ${Math.floor(pct)}%，还剩 ${fmt(month.remaining)} Credit。用完后要等下月 1 日恢复。` : '';
  const box = $('#credit-warn');
  if ($('span', box).textContent !== text) $('span', box).textContent = text;
  box.hidden = !text;
}

addEventListener('slate:quota-exceeded', e => {
  overMsg = String(e.detail?.message || '本月额度已用完，下月 1 日恢复').replace(/[。.]$/, '');
  paint();
  refresh(true);
});

/* ---------- 任务用量明细弹窗（任务详情页"明细"） ---------- */

const KIND = { model: '模型', vision: '看图', video: '看视频', voice: '配音', render: '渲染', adjust: '调整' };
const MODEL_NAMES = {
  'claude-opus-5-5': 'Claude Opus 5.5', 'claude-opus-4-8': 'Claude Opus 4.8',
  'claude-sonnet-5-5': 'Claude Sonnet 5.5', 'gpt-6-astra': 'GPT-6 Astra',
  'g4dn.xlarge': 'T4 渲染机', 'g5.xlarge': 'A10G 渲染机',
};
/** "global.anthropic.claude-opus-5-5" → "Claude Opus 5.5"；认不出的去掉区域和厂商前缀 */
export function modelName(id) {
  if (!id) return '';
  const short = String(id).replace(/^(global|us|eu|apac|jp|au)\./, '').replace(/^(anthropic|openai|amazon|meta|minimax)\./, '');
  return MODEL_NAMES[short] || short;
}
const callTime = ms => {
  if (!ms) return '';
  const d = new Date(ms);
  return `${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

function usageRow(r) {
  const free = r.billable === false;
  const amount = `<span class="u-cr${free ? ' is-free' : ''}">${fmt(r.credits, 4)}</span>`;
  const tag = free ? `<span class="u-free" title="${esc(r.note || '不计费')}">不计费</span>${r.note ? `<span class="sr-only">：${esc(r.note)}</span>` : ''}` : '';
  let usage;
  if (r.kind === 'voice') usage = `<td class="u-num" colspan="4">${r.chars != null ? `${int(r.chars)} 字` : '—'}</td>`;
  else if (r.kind === 'render') usage = `<td class="u-num" colspan="4">${r.seconds != null ? `${Number(r.seconds).toFixed(1)} 秒` : '—'}</td>`;
  else if (r.kind === 'adjust') usage = `<td class="u-note" colspan="4">${esc(r.note || '管理员调整')}</td>`;
  else usage = ['input', 'cacheRead', 'cacheWrite', 'output'].map(k => `<td class="u-num">${r[k] != null ? int(r[k]) : '—'}</td>`).join('');
  return `<tr class="${free ? 'is-free' : ''}">
    <td class="u-time">${esc(callTime(r.at))}</td>
    <td>${esc(r.label || '—')}</td>
    <td>${esc(KIND[r.kind] || r.kind || '—')}</td>
    <td class="u-model" title="${esc(r.model || '')}">${esc(modelName(r.model) || '—')}</td>
    ${usage}
    <td class="u-num">${amount}${tag}</td>
  </tr>`;
}

let usageFor = null; // {id, title}

async function loadUsage() {
  const want = usageFor;
  const body = $('#usage-body-modal');
  body.innerHTML = '<p class="usage-msg">正在加载明细…</p>';
  $('#usage-sum').textContent = '';
  $('#usage-csv').disabled = true;
  try {
    const r = await api.get(`/tasks/${encodeURIComponent(want.id)}/usage`);
    if (want !== usageFor) return;
    const items = Array.isArray(r?.items) ? r.items : [];
    if (!items.length) {
      body.innerHTML = '<p class="usage-msg">还没有用量记录。任务开始后，每次模型调用大约 1 分钟后出现在这里。</p>';
      $('#usage-sum').textContent = '合计 0.00 Credit';
      return;
    }
    const free = items.filter(x => x.billable === false).length;
    body.innerHTML = `<table class="usage-table">
      <caption class="sr-only">每一次模型调用的用量</caption>
      <thead><tr><th scope="col">时间</th><th scope="col">轮次</th><th scope="col">类型</th><th scope="col">模型</th>
        <th scope="col" class="u-num">输入</th><th scope="col" class="u-num">缓存读</th><th scope="col" class="u-num">缓存写</th><th scope="col" class="u-num">输出</th>
        <th scope="col" class="u-num">Credit</th></tr></thead>
      <tbody>${items.map(usageRow).join('')}</tbody>
    </table>`;
    $('#usage-sum').textContent = `共 ${items.length} 条，合计 ${fmt(r.total)} Credit${free ? `（其中 ${free} 条不计费，不算在内）` : ''}。token 数是模型服务返回的实际数字，配音按字数，渲染按渲染机实际占用的秒数。`;
    $('#usage-csv').disabled = false;
  } catch (e) {
    if (want !== usageFor || e.status === 401) return;
    body.innerHTML = `<p class="usage-msg">${esc(e.message)}<button type="button" class="link-btn" data-usage-reload>重试</button></p>`;
  }
}

/** 打开某个任务的用量明细 */
export function openUsage(id, title) {
  usageFor = { id, title };
  $('#usage-h').textContent = title ? `用量明细：${title}` : '用量明细';
  openModal($('#usage-modal'));
  loadUsage();
}

async function exportCsv(btn) {
  if (!usageFor) return;
  const name = `${(usageFor.title || 'Slate').replace(/[\\/:*?"<>|\s]+/g, '') || 'Slate'}_用量明细.csv`;
  btn.disabled = true;
  try {
    await downloadFile(`/tasks/${encodeURIComponent(usageFor.id)}/usage?format=csv`, name);
    toast('已开始下载 CSV');
  } catch (e) {
    if (e.status !== 401) toast(e.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

export function init() {
  const m = $('#usage-modal');
  m.addEventListener('click', e => {
    if (e.target === m || e.target.closest('[data-close]')) { usageFor = null; closeModal(m); }
    if (e.target.closest('[data-usage-reload]')) loadUsage();
  });
  addEventListener('keydown', e => { if (e.key === 'Escape' && !m.hidden) { usageFor = null; closeModal(m); } });
  $('#usage-csv').addEventListener('click', e => exportCsv(e.currentTarget));
}
