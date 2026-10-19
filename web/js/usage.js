/* 用量页 #usage：本月额度、按日期范围的每日用量（柱状图）和按任务的用量。数据来自 GET /usage?from=&to= */

import { $, $$, esc, toast, dateTime } from './util.js';
import { api } from './api.js';
import { STATE } from './projects.js';
import {
  fmt, fmtQuota, share, setMonth, cnToday, addDays, daysBetween, presetRange, dayLabel, monthLabel,
} from './credits.js';

const MAX_DAYS = 366; // 后端最长一年

let active = false;
let range = null;   // {from, to, preset}
let data = null;    // 最近一次返回
let seq = 0;

/* ---------- 每日柱状图：单系列，细柱，横轴日期；整列都是悬停区域，悬停或方向键显示当天用量 ---------- */

const H = 220, L = 46, R = 8, T = 14, B = 26; // 高度固定，宽度按容器的实际像素，字号不随宽度缩放
let drawn = null; // {el, days, w}：容器宽度变了就重画

function niceMax(v) {
  if (!(v > 0)) return 1;
  const raw = v / 2, p = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map(m => m * p).find(s => s >= raw);
  return step * 2;
}
const tick = v => (v >= 1000 ? Math.round(v).toLocaleString('zh-CN') : String(Math.round(v * 100) / 100));

/** 柱子：顶端 4px 圆角，底边方角 */
function barPath(x, top, w, base) {
  const h = base - top;
  if (h <= 0.5) return '';
  const r = Math.min(4, w / 2, h);
  return `M${x},${base}V${top + r}Q${x},${top} ${x + r},${top}H${x + w - r}Q${x + w},${top} ${x + w},${top + r}V${base}Z`;
}

/** 补全日期（后端一般已经补好，这里兜底），每天一项 {date, credits} */
function fillDays(from, to, days) {
  const map = new Map((days || []).map(d => [d.date, Number(d.credits) || 0]));
  const out = [];
  for (let d = from, i = 0; d <= to && i <= MAX_DAYS; d = addDays(d, 1), i++) out.push({ date: d, credits: map.get(d) || 0 });
  return out;
}

function drawChart(el, days) {
  const W = Math.max(300, Math.round(el.clientWidth || 720));
  drawn = { el, days, w: W };
  const n = days.length;
  const max = niceMax(Math.max(0, ...days.map(d => d.credits)));
  const base = H - B;
  const y = v => T + (base - T) * (1 - v / max);
  const step = (W - L - R) / n;
  const bw = Math.max(1.5, Math.min(24, step * 0.62));
  const every = Math.ceil(n / Math.max(2, Math.min(8, Math.floor(W / 80))));
  const today = cnToday();
  const peak = days.reduce((a, d) => (d.credits > a.credits ? d : a), days[0]);
  const total = days.reduce((s, d) => s + d.credits, 0);
  const grid = [0, max / 2, max].map(v => `<line class="dc-grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text class="dc-axis" x="${L - 8}" y="${y(v) + 4}" text-anchor="end">${tick(v)}</text>`).join('');
  const bars = days.map((d, i) => {
    const x = L + i * step + (step - bw) / 2;
    return `<path class="dc-bar${d.date === today ? ' is-today' : ''}" data-i="${i}" d="${barPath(x, y(d.credits), bw, base)}"/>`;
  }).join('');
  const labels = days.map((d, i) => (i % every === 0
    ? `<text class="dc-axis" x="${L + i * step + step / 2}" y="${H - 7}" text-anchor="middle">${Number(d.date.slice(5, 7))}/${Number(d.date.slice(8, 10))}</text>` : '')).join('');
  const summary = `${dayLabel(days[0].date)}到${dayLabel(days[n - 1].date)}每日用量，合计 ${fmt(total)} Credit，最高 ${dayLabel(peak.date)} ${fmt(peak.credits)} Credit。用左右方向键逐日查看。`;
  el.innerHTML = `<div class="dc" tabindex="0" role="group" aria-label="${esc(summary)}">
    <svg class="dc-svg" viewBox="0 0 ${W} ${H}" aria-hidden="true">${grid}<line class="dc-base" x1="${L}" x2="${W - R}" y1="${base}" y2="${base}"/>${bars}${labels}</svg>
    <div class="dc-tip" aria-live="polite" hidden><b></b><span></span></div>
  </div>`;

  const box = $('.dc', el), svg = $('svg', box), tip = $('.dc-tip', box);
  let cur = -1;
  const show = i => {
    if (i < 0 || i >= n) return;
    cur = i;
    const d = days[i];
    $$('.dc-bar.is-hot', svg).forEach(b => b.classList.remove('is-hot'));
    $(`.dc-bar[data-i="${i}"]`, svg)?.classList.add('is-hot');
    const cx = L + i * step + step / 2;
    $('b', tip).textContent = `${fmt(d.credits)} Credit`;
    $('span', tip).textContent = dayLabel(d.date) + (d.date === today ? '（今天，还在统计）' : '');
    tip.hidden = false;
    const r = svg.getBoundingClientRect(), k = r.width / W;
    const half = tip.offsetWidth / 2;
    const left = Math.min(Math.max(cx * k, half), r.width - half);
    tip.style.left = `${left}px`;
    tip.style.top = `${Math.max(tip.offsetHeight + 2, y(d.credits) * k - 8)}px`;
  };
  const hide = () => {
    cur = -1; tip.hidden = true;
    $$('.dc-bar.is-hot', svg).forEach(b => b.classList.remove('is-hot'));
  };
  svg.addEventListener('pointermove', e => {
    const r = svg.getBoundingClientRect();
    const x = (e.clientX - r.left) * (W / r.width);
    const i = Math.floor((x - L) / step);
    if (i >= 0 && i < n) { if (i !== cur) show(i); } else hide();
  });
  svg.addEventListener('pointerleave', hide);
  box.addEventListener('focus', () => show(cur >= 0 ? cur : n - 1));
  box.addEventListener('blur', hide);
  box.addEventListener('keydown', e => {
    const step1 = { ArrowLeft: -1, ArrowRight: 1 }[e.key];
    if (step1) { e.preventDefault(); show(Math.min(n - 1, Math.max(0, (cur < 0 ? n - 1 : cur) + step1))); }
    else if (e.key === 'Home') { e.preventDefault(); show(0); }
    else if (e.key === 'End') { e.preventDefault(); show(n - 1); }
  });
}

/* ---------- 渲染 ---------- */

function renderMonth(c) {
  const el = $('#usage-month');
  if (!c) { el.innerHTML = ''; return; }
  const pct = share(c);
  const cls = c.warn === '100' ? 'over' : c.warn === '80' ? 'warn' : '';
  el.innerHTML = `
    <div class="um-head"><h2>${esc(monthLabel(c.month))}</h2><span>每月 1 日零点（北京时间）重新计算</span></div>
    <dl class="um-stats">
      <div><dt>本月已用</dt><dd>${fmt(c.used)}<small>Credit</small></dd></div>
      <div><dt>月额度</dt><dd>${fmtQuota(c.quota)}<small>Credit</small></dd></div>
      <div><dt>剩余</dt><dd>${fmt(c.remaining)}<small>Credit</small></dd></div>
    </dl>
    <div class="um-meter ${cls}" role="progressbar" aria-label="本月额度已用" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(pct)}"><i style="width:${pct}%"></i></div>
    <p class="um-note">${c.warn === '100' ? '本月额度已用完，下月 1 日恢复。在这之前不能新建视频、发修改或重试。' : `已用 ${pct > 0 && pct < 1 ? '不到 1' : Math.floor(pct)}%。用到 80% 和 100% 时，页面顶部会提醒。`}</p>`;
}

function renderRange() {
  if (!data) return;
  const days = fillDays(data.from || range.from, data.to || range.to, data.days);
  $('#usage-range-total').textContent = `合计 ${fmt(data.total)} Credit`;
  const chart = $('#usage-chart');
  drawn = null;
  if (!days.length) chart.innerHTML = '<p class="usage-msg">没有数据。</p>';
  else if (!days.some(d => d.credits > 0)) chart.innerHTML = '<p class="usage-msg">这段时间没有用量。</p>';
  else drawChart(chart, days);

  const tasks = [...(Array.isArray(data.tasks) ? data.tasks : [])].sort((a, b) => (Number(b.credits) || 0) - (Number(a.credits) || 0));
  $('#usage-tasks').innerHTML = tasks.length ? tasks.map(t => {
    const [cls, text] = STATE[t.status] || ['', t.status ? '未知状态' : '—'];
    return `<tr data-id="${esc(t.id)}">
      <td><a href="#run/${encodeURIComponent(t.id)}">${esc(t.title || '新任务')}</a></td>
      <td><span class="state ${cls}">${t.status === 'failed' ? '<i><svg style="width:14px;height:14px"><use href="#i-x"/></svg></i>' : '<i></i>'}${esc(text)}</span></td>
      <td class="p-time">${esc(dateTime(t.createdAt))}</td>
      <td class="p-cr">${fmt(t.credits)} <small>Credit</small></td>
    </tr>`;
  }).join('') : '<tr class="is-msg"><td class="p-msg" colspan="4">这段时间没有任务用量。</td></tr>';
}

function message(html) {
  $('#usage-chart').innerHTML = `<p class="usage-msg">${html}</p>`;
  $('#usage-range-total').textContent = '';
  $('#usage-tasks').innerHTML = '';
}

/* ---------- 数据 ---------- */

function syncInputs() {
  $('#usage-from').value = range.from;
  $('#usage-to').value = range.to;
  const today = cnToday();
  $('#usage-from').max = today;
  $('#usage-to').max = today;
  $$('#usage-presets button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.preset === range.preset)));
}

async function load() {
  const my = ++seq;
  $('#usage-body').classList.add('is-loading');
  if (!data) message('正在加载用量…');
  try {
    const r = await api.get(`/usage?from=${range.from}&to=${range.to}`);
    if (my !== seq || !active) return;
    data = r || {};
    if (data.month) setMonth(data.month);
    renderMonth(data.month);
    renderRange();
  } catch (e) {
    if (my !== seq || !active || e.status === 401) return;
    if (!data) message(`${esc(e.message)}<button type="button" class="link-btn" data-reload>重试</button>`);
    else toast(e.message, 'error');
  } finally {
    if (my === seq) $('#usage-body').classList.remove('is-loading');
  }
}

function setRange(from, to, preset = null) {
  if (!from || !to) return;
  if (from > to) [from, to] = [to, from];
  if (daysBetween(from, to) > MAX_DAYS) { toast('日期范围最长一年，请缩短一些', 'error'); syncInputs(); return; }
  range = { from, to, preset };
  syncInputs();
  load();
}

export function enter() {
  active = true;
  // 本月范围的结束日是"今天"：跨天后重新算一次
  if (!range || (range.preset && presetRange(range.preset)[1] !== range.to)) {
    const p = range?.preset || 'month';
    const [from, to] = presetRange(p);
    range = { from, to, preset: p };
  }
  syncInputs();
  if (data) { renderMonth(data.month); renderRange(); }
  load();
}

export function leave() {
  active = false;
}

export function init() {
  new ResizeObserver(() => {
    if (!drawn || !active) return;
    const w = Math.round(drawn.el.clientWidth);
    if (w && Math.abs(w - drawn.w) > 4) drawChart(drawn.el, drawn.days);
  }).observe($('#usage-chart'));
  $('#usage-presets').addEventListener('click', e => {
    const b = e.target.closest('button[data-preset]');
    if (!b) return;
    const [from, to] = presetRange(b.dataset.preset);
    setRange(from, to, b.dataset.preset);
  });
  const onDate = () => {
    const from = $('#usage-from').value, to = $('#usage-to').value;
    if (from && to) setRange(from, to);
  };
  $('#usage-from').addEventListener('change', onDate);
  $('#usage-to').addEventListener('change', onDate);
  $('#usage-body').addEventListener('click', e => {
    if (e.target.closest('[data-reload]')) { message('正在加载用量…'); load(); return; }
    if (e.target.closest('a')) return;
    const tr = e.target.closest('tr[data-id]');
    if (tr) location.hash = 'run/' + encodeURIComponent(tr.dataset.id);
  });
}
