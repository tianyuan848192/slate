/* Slate 管理端（第一批：用户、模型与密钥、操作日志；第二批：Credit 用量、额度、计费设置；风格创建）。页面样式和交互沿用设计稿（docs/admin-design/prototype/）。
   Credit 的接口见 docs/credit-design.md 第 9 节，风格创建的接口见 docs/style-creator-design.md 第十一节；日期一律按北京时间 */
import { loadConfig, login, completeNewPassword, idToken, logout, isLoggedIn, sessionEmail, AuthError } from './auth.js';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icon = id => `<svg><use href="#i-${id}"/></svg>`;
const pad = n => String(n).padStart(2, '0');
const fmtDate = ms => { if (!ms) return '—'; const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const fmtTime = ms => { if (!ms) return '—'; const d = new Date(ms); return `${fmtDate(ms)} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const ago = ms => { if (!ms) return '—'; const m = Math.round((Date.now() - ms) / 60000); return m < 1 ? '刚刚' : m < 60 ? `${m} 分钟前` : m < 1440 ? `${Math.round(m / 60)} 小时前` : `${Math.round(m / 1440)} 天前`; };
const badge = (cls, text) => `<span class="badge ${cls}">${icon('dot')}${esc(text)}</span>`;
const userBadge = s => ({ active: badge('b-ok', '正常'), disabled: badge('b-fail', '已停用'), invited: badge('b-idle', '待激活') }[s] || '');
const taskBadge = s => ({ completed: badge('b-ok', '已完成'), failed: badge('b-fail', '失败'), running: badge('b-run', '生成中'), queued: badge('b-run', '排队中'), awaiting_confirmation: badge('b-warn', '等确认') }[s] || badge('b-idle', s || '—'));
const kpi = (label, val, foot = '') => `<div class="card kpi"><div class="k-label">${label}</div><div class="k-val num">${val}</div>${foot ? `<div class="k-foot">${foot}</div>` : ''}</div>`;
/** Credit：1234.5 → "1,234.50"；额度是整数时不带小数 */
const cr = (v, d = 2) => Number(v || 0).toLocaleString('zh-CN', { minimumFractionDigits: d, maximumFractionDigits: d });
const crq = v => (Number.isInteger(Number(v)) ? cr(v, 0) : cr(v));
const int = v => (v == null || v === '' ? '—' : Number(v).toLocaleString('zh-CN'));
const meterCls = p => (p >= 1 ? 'over' : p >= 0.8 ? 'warn' : '');
const monthLabel = s => (s ? `${s.slice(0, 4)} 年 ${+s.slice(5, 7)} 月` : '本月');

// 北京时间的日期（后端按北京时间分日、分月）
const ymd = d => d.toISOString().slice(0, 10);
const cnToday = () => ymd(new Date(Date.now() + 8 * 3600e3));
const addDays = (day, n) => { const d = new Date(day + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return ymd(d); };
const daysBetween = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 864e5);
const dayLabel = s => `${+s.slice(5, 7)}月${+s.slice(8, 10)}日`;
/** 快捷范围：month 本月、last 上月、数字 = 近 N 天（含今天） */
function presetRange(p) {
  const today = cnToday(), [y, m] = today.split('-').map(Number);
  if (p === 'month') return [today.slice(0, 8) + '01', today];
  if (p === 'last') return [ymd(new Date(Date.UTC(y, m - 2, 1))), ymd(new Date(Date.UTC(y, m - 1, 0)))];
  return [addDays(today, -(Number(p) - 1)), today];
}
const newRange = (p = 'month') => { const [from, to] = presetRange(p); return { from, to, preset: p }; };
/** 补全日期，每天一项 {date, credits} */
function fillDays(from, to, days) {
  const map = new Map((days || []).map(d => [d.date, Number(d.credits) || 0])), out = [];
  for (let d = from, i = 0; d <= to && i <= 366; d = addDays(d, 1), i++) out.push({ date: d, credits: map.get(d) || 0 });
  return out;
}

// ---------------------------------------------------------------- API
class ApiErr extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } }
async function api(method, path, body, { raw = false } = {}) {
  const tok = await idToken();
  if (!tok) { showLogin(); throw new ApiErr(401, 'unauthorized', '请先登录'); }
  let res;
  try {
    res = await fetch(`/api${path}`, { method, headers: { Authorization: tok, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  } catch { throw new ApiErr(0, 'network', '网络连接失败，请重试'); }
  if (res.status === 401) { logout(); showLogin(); throw new ApiErr(401, 'unauthorized', '登录已过期，请重新登录'); }
  if (raw && res.ok) return res.blob();
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiErr(res.status, data?.error?.code, data?.error?.message || `请求失败（${res.status}）`);
  return data;
}
/** 带登录凭证下载文件（比如用量 CSV）：先取回 Blob，再用临时链接保存 */
async function downloadFile(path, filename) {
  const url = URL.createObjectURL(await api('GET', path, undefined, { raw: true }));
  const a = Object.assign(document.createElement('a'), { href: url, download: filename, rel: 'noopener' });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// ---------------------------------------------------------------- 提示和弹窗
function toast(t) { const el = $('#toast'); el.textContent = t; el.hidden = false; clearTimeout(toast.h); toast.h = setTimeout(() => (el.hidden = true), 2800); }
function closeModal() { $('#modal-bg').hidden = true; }
/** 弹窗。onOk 可以是 async：返回 false 不关闭；抛错时把错误显示在弹窗里 */
function modal(html, onOk, { wide = false } = {}) {
  $('#modal').className = 'modal' + (wide ? ' wide' : '');
  $('#modal').innerHTML = html + '<p class="form-err" id="modal-err" hidden></p>';
  $('#modal-bg').hidden = false;
  $$('[data-close]', $('#modal')).forEach(b => b.addEventListener('click', closeModal));
  const ok = $('[data-ok]', $('#modal'));
  if (ok) ok.addEventListener('click', async () => {
    ok.disabled = true;
    try { const r = await onOk?.(); if (r !== false) closeModal(); }
    catch (e) { const el = $('#modal-err'); el.textContent = e.message; el.hidden = false; }
    finally { ok.disabled = false; }
  });
  ($('#modal input, #modal textarea') || $('#modal [data-close]'))?.focus();
}
$('#modal-bg').addEventListener('click', e => { if (e.target.id === 'modal-bg') closeModal(); });
addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#modal-bg').hidden) closeModal(); });
function showSecret(title, value, note) {
  modal(`<h3>${esc(title)}</h3><div class="copy-box"><code>${esc(value)}</code><button class="btn sm" data-copy>复制</button></div>
    <div class="note">${icon('alert')}<span>${esc(note)}</span></div><div class="actions"><button class="btn primary" data-close>我已记下</button></div>`);
  $('[data-copy]', $('#modal')).addEventListener('click', () => navigator.clipboard?.writeText(value).then(() => toast('已复制')));
}

/** 柱状图（单系列）：每月任务数等。悬停显示数值；最后一根（本月还没结束）颜色浅 */
function barChart(points, { h = 190, unit = '个', partialLast = true } = {}) {
  const W = 720, H = h, L = 36, B = 24, T = 10, max = Math.max(1, ...points.map(p => p.v)) * 1.15;
  const step = (W - L) / points.length, bw = Math.max(4, Math.min(28, step * 0.62)), y = v => T + (H - T - B) * (1 - v / max);
  const ticks = [0, .5, 1].map(f => f * max);
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="柱状图">
    ${ticks.map(v => `<line class="grid-line" x1="${L}" x2="${W}" y1="${y(v)}" y2="${y(v)}"/><text class="axis-label" x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${Math.round(v)}</text>`).join('')}
    ${points.map((p, i) => { const x = L + i * step + (step - bw) / 2, top = y(p.v); return `<rect class="bar${partialLast && i === points.length - 1 ? ' dim' : ''}" x="${x}" y="${top}" width="${bw}" height="${Math.max(0, H - B - top)}" rx="3"><title>${esc(p.l)}：${p.v} ${unit}</title></rect>`; }).join('')}
    ${points.map((p, i) => `<text class="axis-label" x="${L + i * step + step / 2}" y="${H - 6}" text-anchor="middle">${esc(p.short)}</text>`).join('')}
  </svg>`;
}

/** 每日柱状图（单系列，细柱）：按容器实际宽度画，字号不缩放；整列都是悬停区域，悬停或方向键显示当天用量 */
function drawDayChart(el, days) {
  const H = 210, L = 46, R = 8, T = 14, B = 26, W = Math.max(300, Math.round(el.clientWidth || 720)), n = days.length, base = H - B;
  const peakV = Math.max(0, ...days.map(d => d.credits));
  let max = 1;
  if (peakV > 0) { const raw = peakV / 2, p = 10 ** Math.floor(Math.log10(raw)); max = [1, 2, 2.5, 5, 10].map(m => m * p).find(v => v >= raw) * 2; }
  const y = v => T + (base - T) * (1 - v / max), step = (W - L - R) / n, bw = Math.max(1.5, Math.min(24, step * 0.62));
  const every = Math.ceil(n / Math.max(2, Math.min(8, Math.floor(W / 80)))), today = cnToday();
  const path = (x, top, w) => { const h = base - top; if (h <= 0.5) return ''; const r = Math.min(4, w / 2, h); return `M${x},${base}V${top + r}Q${x},${top} ${x + r},${top}H${x + w - r}Q${x + w},${top} ${x + w},${top + r}V${base}Z`; };
  const tick = v => (v >= 1000 ? Math.round(v).toLocaleString('zh-CN') : String(Math.round(v * 100) / 100));
  const peak = days.reduce((a, d) => (d.credits > a.credits ? d : a), days[0]), total = days.reduce((s, d) => s + d.credits, 0);
  el.innerHTML = `<div class="dc" tabindex="0" role="group" aria-label="${esc(`${dayLabel(days[0].date)}到${dayLabel(days[n - 1].date)}每日用量，合计 ${cr(total)} Credit，最高 ${dayLabel(peak.date)} ${cr(peak.credits)} Credit。用左右方向键逐日查看。`)}">
    <svg class="dc-svg" viewBox="0 0 ${W} ${H}" aria-hidden="true">
      ${[0, max / 2, max].map(v => `<line class="dc-grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text class="dc-axis" x="${L - 8}" y="${y(v) + 4}" text-anchor="end">${tick(v)}</text>`).join('')}
      <line class="dc-base" x1="${L}" x2="${W - R}" y1="${base}" y2="${base}"/>
      ${days.map((d, i) => `<path class="dc-bar${d.date === today ? ' is-today' : ''}" data-i="${i}" d="${path(L + i * step + (step - bw) / 2, y(d.credits), bw)}"/>`).join('')}
      ${days.map((d, i) => (i % every === 0 ? `<text class="dc-axis" x="${L + i * step + step / 2}" y="${H - 7}" text-anchor="middle">${+d.date.slice(5, 7)}/${+d.date.slice(8, 10)}</text>` : '')).join('')}
    </svg><div class="dc-tip" aria-live="polite" hidden><b></b><span></span></div></div>`;
  const box = $('.dc', el), svg = $('svg', box), tip = $('.dc-tip', box);
  let cur = -1;
  const show = i => {
    if (i < 0 || i >= n) return;
    cur = i;
    $$('.dc-bar.is-hot', svg).forEach(b => b.classList.remove('is-hot'));
    $(`.dc-bar[data-i="${i}"]`, svg)?.classList.add('is-hot');
    $('b', tip).textContent = `${cr(days[i].credits)} Credit`;
    $('span', tip).textContent = dayLabel(days[i].date) + (days[i].date === today ? '（今天，还在统计）' : '');
    tip.hidden = false;
    const r = svg.getBoundingClientRect(), k = r.width / W, half = tip.offsetWidth / 2;
    tip.style.left = `${Math.min(Math.max((L + i * step + step / 2) * k, half), r.width - half)}px`;
    tip.style.top = `${Math.max(tip.offsetHeight + 2, y(days[i].credits) * k - 8)}px`;
  };
  const hide = () => { cur = -1; tip.hidden = true; $$('.dc-bar.is-hot', svg).forEach(b => b.classList.remove('is-hot')); };
  svg.addEventListener('pointermove', e => { const r = svg.getBoundingClientRect(), i = Math.floor(((e.clientX - r.left) * (W / r.width) - L) / step); if (i >= 0 && i < n) { if (i !== cur) show(i); } else hide(); });
  svg.addEventListener('pointerleave', hide);
  box.addEventListener('focus', () => show(cur >= 0 ? cur : n - 1));
  box.addEventListener('blur', hide);
  box.addEventListener('keydown', e => {
    const d = { ArrowLeft: -1, ArrowRight: 1 }[e.key];
    if (d) { e.preventDefault(); show(Math.min(n - 1, Math.max(0, (cur < 0 ? n - 1 : cur) + d))); }
    else if (e.key === 'Home' || e.key === 'End') { e.preventDefault(); show(e.key === 'Home' ? 0 : n - 1); }
  });
  // 容器宽度变了就按新宽度重画
  el._ro?.disconnect();
  el._ro = new ResizeObserver(() => { const w = Math.round(el.clientWidth); if (w && Math.abs(w - W) > 4 && document.body.contains(el)) drawDayChart(el, days); });
  el._ro.observe(el);
}
/** 每日用量卡片：没有用量时只显示一句话 */
function dayCard(host, from, to, days) {
  const list = fillDays(from, to, days);
  if (list.some(d => d.credits > 0)) drawDayChart(host, list);
  else host.innerHTML = '<div class="empty">这段时间没有用量</div>';
}

/** 日期范围：快捷按钮 + 两个日期框。st = {from, to, preset}，改动后调用 onChange */
const PRESETS = [['month', '本月'], ['last', '上月'], ['7', '近 7 天'], ['30', '近 30 天']];
function rangeBar(st) {
  const today = cnToday();
  return `<div class="range-bar"><div class="chips" role="group" aria-label="快捷日期">${PRESETS.map(([k, t]) => `<button class="chip" data-preset="${k}" aria-pressed="${st.preset === k}">${t}</button>`).join('')}</div>
    <label class="date-field"><span class="sr-only">开始日期</span><input class="inp num" type="date" data-from value="${st.from}" max="${today}"></label><span class="muted">至</span>
    <label class="date-field"><span class="sr-only">结束日期</span><input class="inp num" type="date" data-to value="${st.to}" max="${today}"></label></div>`;
}
function bindRange(root, st, onChange) {
  const sync = () => { $('[data-from]', root).value = st.from; $('[data-to]', root).value = st.to; $$('[data-preset]', root).forEach(b => b.setAttribute('aria-pressed', String(b.dataset.preset === st.preset))); };
  const set = (from, to, preset = null) => {
    if (!from || !to) return;
    if (from > to) [from, to] = [to, from];
    if (daysBetween(from, to) > 366) { toast('日期范围最长一年'); sync(); return; }
    Object.assign(st, { from, to, preset }); sync(); onChange();
  };
  $$('[data-preset]', root).forEach(b => b.addEventListener('click', () => { const [f, t] = presetRange(b.dataset.preset); set(f, t, b.dataset.preset); }));
  const onDate = () => set($('[data-from]', root).value, $('[data-to]', root).value);
  $('[data-from]', root).addEventListener('change', onDate);
  $('[data-to]', root).addEventListener('change', onDate);
}

// ---------------------------------------------------------------- 任务用量：明细（每次调用）和调整（退还、补扣）
const KIND = { model: '模型', vision: '看图', video: '看视频', voice: '配音', render: '渲染', adjust: '调整' };
const MODEL_NAMES = { 'claude-opus-5-5': 'Claude Opus 5.5', 'claude-opus-4-8': 'Claude Opus 4.8', 'claude-sonnet-5-5': 'Claude Sonnet 5.5', 'gpt-6-astra': 'GPT-6 Astra', 'g4dn.xlarge': 'T4 渲染机（g4dn.xlarge）', 'g5.xlarge': 'A10G 渲染机（g5.xlarge）' };
const modelName = id => { if (!id) return '—'; const s = String(id).replace(/^(global|us|eu|apac|jp|au)\./, '').replace(/^(anthropic|openai|amazon|meta|minimax)\./, ''); return MODEL_NAMES[s] || s; };
const callTime = ms => { if (!ms) return '—'; const d = new Date(ms); return `${fmtTime(ms)}:${pad(d.getSeconds())}`; };
function usageRows(items) {
  return items.map(r => {
    const free = r.billable === false;
    const use = r.kind === 'voice' ? `<td class="r num" colspan="4">${r.chars != null ? `${int(r.chars)} 字` : '—'}</td>`
      : r.kind === 'render' ? `<td class="r num" colspan="4">${r.seconds != null ? `${Number(r.seconds).toFixed(1)} 秒` : '—'}</td>`
      : r.kind === 'adjust' ? `<td colspan="4" class="u-note">${esc(r.note || '管理员调整')}</td>`
      : ['input', 'cacheRead', 'cacheWrite', 'output'].map(k => `<td class="r num">${int(r[k])}</td>`).join('');
    return `<tr class="${free ? 'is-free' : ''}"><td class="muted num">${esc(callTime(r.at))}</td><td>${esc(r.label || '—')}</td><td>${esc(KIND[r.kind] || r.kind || '—')}</td>
      <td title="${esc(r.model || '')}">${esc(modelName(r.model))}</td>${use}
      <td class="r num"><span class="${free ? 'u-struck' : ''}">${cr(r.credits, 4)}</span>${free ? `<span class="u-free" title="${esc(r.note || '不计费')}">不计费</span>${r.note ? `<span class="sr-only">：${esc(r.note)}</span>` : ''}` : ''}</td></tr>`;
  }).join('');
}
async function showTaskUsage(t) {
  const title = t.title || t.id;
  modal(`<h3>用量明细 · ${esc(title)}</h3><div class="u-scroll" id="tu-body"><div class="loading">加载中…</div></div>
    <div class="actions"><span class="grow muted" id="tu-sum"></span><button class="btn" id="tu-csv" disabled>${icon('download')}导出 CSV</button><button class="btn primary" data-close>关闭</button></div>`, null, { wide: true });
  const body = $('#tu-body');
  $('#tu-csv').addEventListener('click', async e => {
    const b = e.currentTarget; b.disabled = true;
    try { await downloadFile(`/tasks/${encodeURIComponent(t.id)}/usage?format=csv`, `${String(title).replace(/[\\/:*?"<>|\s]+/g, '') || 'Slate'}_用量明细.csv`); toast('已开始下载 CSV'); }
    catch (err) { toast(err.message); } finally { b.disabled = false; }
  });
  try {
    const r = await api('GET', `/tasks/${encodeURIComponent(t.id)}/usage`);
    if (!document.body.contains(body)) return; // 弹窗已经换成别的内容
    const items = r.items || [], free = items.filter(x => x.billable === false).length;
    body.innerHTML = items.length ? `<table class="t"><thead><tr><th>时间</th><th>轮次</th><th>类型</th><th>模型</th><th class="r">输入</th><th class="r">缓存读</th><th class="r">缓存写</th><th class="r">输出</th><th class="r">Credit</th></tr></thead>
      <tbody>${usageRows(items)}</tbody></table>` : '<div class="empty">还没有用量记录</div>';
    $('#tu-sum').textContent = `共 ${items.length} 条，合计 ${cr(r.total)} Credit${free ? `，其中 ${free} 条不计费、不算在内` : ''}`;
    $('#tu-csv').disabled = !items.length;
  } catch (e) {
    if (document.body.contains(body)) body.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
  }
}
function adjustTask(t, after) {
  modal(`<h3>调整 Credit · ${esc(t.title || t.id)}</h3>
    <p class="muted">这个任务目前合计 ${cr(t.credits)} Credit。负数是退还给用户，正数是补扣。会记一条调整明细、计入用户当月用量，并写进操作日志。</p>
    <label class="field"><span>数量（Credit）</span><input class="inp num" id="a-cr" type="number" step="0.01" placeholder="例如 -2.50 表示退还 2.50"><small id="a-hint">负数退还，正数补扣</small></label>
    <label class="field"><span>原因（必填）</span><textarea class="inp" id="a-reason" maxlength="200" placeholder="例如：渲染服务故障导致重跑，退还这一轮"></textarea><small>用户在这个任务的用量明细里能看到这条原因</small></label>
    <div class="actions"><button class="btn" data-close>取消</button><button class="btn primary" data-ok>确认调整</button></div>`, async () => {
    const raw = $('#a-cr').value.trim(), v = Math.round(Number(raw) * 100) / 100, reason = $('#a-reason').value.trim();
    if (!raw || !Number.isFinite(v) || v === 0) throw new Error('数量要填一个不为 0 的数：负数退还，正数补扣');
    if (Math.abs(v) > 100000) throw new Error('数量太大了，检查一下');
    if (!reason) throw new Error('请填写原因');
    await api('POST', `/tasks/${encodeURIComponent(t.id)}/adjust`, { credits: v, reason });
    toast(v < 0 ? `已退还 ${cr(-v)} Credit` : `已补扣 ${cr(v)} Credit`);
    after?.();
  });
  $('#a-cr').addEventListener('input', e => {
    const v = Number(e.target.value);
    $('#a-hint').textContent = !e.target.value || !v ? '负数退还，正数补扣' : v < 0 ? `将退还 ${cr(-v)} Credit 给用户` : `将向用户补扣 ${cr(v)} Credit`;
  });
}
const taskActs = t => `<span class="row-acts"><button class="btn sm" data-usage="${esc(t.id)}">明细</button><button class="btn sm" data-adjust="${esc(t.id)}">调整</button></span>`;
function bindTaskActs(root, list, after) {
  const find = id => list.find(t => t.id === id);
  $$('[data-usage]', root).forEach(b => b.addEventListener('click', e => { e.stopPropagation(); const t = find(b.dataset.usage); if (t) showTaskUsage(t); }));
  $$('[data-adjust]', root).forEach(b => b.addEventListener('click', e => { e.stopPropagation(); const t = find(b.dataset.adjust); if (t) adjustTask(t, after); }));
}

// ---------------------------------------------------------------- 用户列表
const uState = { q: '', st: 'all', sort: 'monthTasks', dir: -1, items: null };
async function pageUsers() {
  const items = uState.items = (await api('GET', '/users')).items;
  return renderUsers(items);
}
function renderUsers(all) {
  const counts = { all: all.length, active: 0, disabled: 0, invited: 0 }; all.forEach(u => counts[u.status]++);
  const rows = all.filter(u => (uState.st === 'all' || u.status === uState.st) && (!uState.q || `${u.name} ${u.email}`.toLowerCase().includes(uState.q.toLowerCase())))
    .sort((a, b) => ((a[uState.sort] ?? -1) > (b[uState.sort] ?? -1) ? 1 : -1) * uState.dir);
  const th = (k, t, r = '') => `<th class="sortable ${r}" data-sort="${k}">${t}${uState.sort === k ? (uState.dir < 0 ? ' ↓' : ' ↑') : ''}</th>`;
  const month = all.reduce((s, u) => s + u.monthTasks, 0);
  return `
  <div class="ph"><div class="grow"><h1>用户</h1><p>账号由管理员开通（用户池关闭了自助注册）。admin 组的账号是管理员，能登录这个管理端</p></div>
    <div class="ph-actions"><button class="btn primary" data-act="create">${icon('plus')}开通账号</button></div></div>
  <div class="grid g4">
    ${kpi('用户总数', `${all.length}<small>个</small>`, `${counts.invited} 个待激活 · ${counts.disabled} 个已停用`)}
    ${kpi('本月活跃', `${all.filter(u => u.monthTasks).length}<small>个</small>`, '本月至少生成过一个任务')}
    ${kpi('本月任务', `${month}<small>个</small>`, `成片合计 ${all.reduce((s, u) => s + u.monthMinutes, 0).toFixed(1)} 分钟`)}
    ${kpi('管理员', `${all.filter(u => u.admin).length}<small>个</small>`, '至少保留一个')}
  </div>
  <div class="toolbar mt">
    <label class="search">${icon('search')}<input class="inp" id="u-q" placeholder="搜索姓名、邮箱" value="${esc(uState.q)}"></label>
    <div class="chips">${[['all', '全部'], ['active', '正常'], ['invited', '待激活'], ['disabled', '已停用']].map(([k, t]) => `<button class="chip" data-st="${k}" aria-pressed="${uState.st === k}">${t}<span class="n">${counts[k]}</span></button>`).join('')}</div>
    <div class="grow"></div><span class="muted">${rows.length} 个用户</span>
  </div>
  <div class="table-wrap"><table class="t"><thead><tr>
    <th>用户</th><th>状态</th>${th('monthTasks', '本月任务', 'r')}${th('monthMinutes', '本月成片', 'r')}${th('monthCredits', '本月 Credit', 'r')}${th('quota', '月额度', 'r')}<th class="r">成功率</th>${th('totalTasks', '累计任务', 'r')}${th('last', '最近活跃')}${th('created', '开通时间')}
  </tr></thead><tbody>
  ${rows.map(u => `<tr class="link" data-href="#user/${u.sub}">
    <td class="who"><b>${esc(u.name || u.email.split('@')[0])} ${u.admin ? badge('b-info', '管理员') : ''}</b><small>${esc(u.email)}</small></td>
    <td>${userBadge(u.status)}</td><td class="r num">${u.monthTasks || '—'}</td><td class="r num">${u.monthMinutes ? u.monthMinutes + ' 分钟' : '—'}</td>
    <td class="r">${creditCell(u)}</td><td class="r num">${u.quota != null ? crq(u.quota) : '—'}</td>
    <td class="r num">${u.success == null ? '—' : Math.round(u.success * 100) + '%'}</td><td class="r num">${u.totalTasks || '—'}</td>
    <td class="muted">${u.last ? ago(u.last) : u.status === 'invited' ? '从未登录' : '—'}</td><td class="muted">${fmtDate(u.created)}</td></tr>`).join('') || `<tr><td colspan="10" class="empty">没有符合条件的用户</td></tr>`}
  </tbody></table></div>`;
}
/** 本月 Credit：数字 + 占月额度的小进度条（80% 起变色，超额变红） */
function creditCell(u) {
  if (u.monthCredits == null) return '<span class="muted">—</span>';
  const p = u.quota > 0 ? u.monthCredits / u.quota : (u.monthCredits > 0 ? 1 : 0);
  return `<div class="bar-cell" title="已用月额度的 ${Math.floor(p * 100)}%"><span class="num">${u.monthCredits ? cr(u.monthCredits) : '—'}</span><span class="mini"><i class="${meterCls(p)}" style="width:${Math.min(100, p * 100)}%"></i></span></div>`;
}
function bindUsers() {
  const rerender = () => { $('#page').innerHTML = renderUsers(uState.items); bindUsers(); bindRows(); };
  $('#u-q').addEventListener('input', e => { uState.q = e.target.value.trim(); rerender(); $('#u-q').focus(); $('#u-q').setSelectionRange(99, 99); });
  $$('[data-st]').forEach(b => b.addEventListener('click', () => { uState.st = b.dataset.st; rerender(); }));
  $$('[data-sort]').forEach(t => t.addEventListener('click', () => { const k = t.dataset.sort; uState.dir = uState.sort === k ? -uState.dir : -1; uState.sort = k; rerender(); }));
  $('[data-act=create]').addEventListener('click', () => modal(`<h3>开通账号</h3>
    <label class="field"><span>邮箱</span><input class="inp" id="n-email" type="email" placeholder="name@company.com"></label>
    <label class="field"><span>姓名（可选）</span><input class="inp" id="n-name"></label>
    <label class="review"><label><input type="checkbox" id="n-admin">设为管理员（可以登录管理端，管理用户和密钥）</label></label>
    <div class="note">${icon('alert')}<span>开通后会生成一个临时密码，只显示一次。请转交给对方，对方首次登录时要改密码。</span></div>
    <div class="actions"><button class="btn" data-close>取消</button><button class="btn primary" data-ok>开通</button></div>`, async () => {
    const r = await api('POST', '/users', { email: $('#n-email').value, name: $('#n-name').value, admin: $('#n-admin').checked });
    setTimeout(() => { showSecret(`已开通 ${r.email}`, r.tempPassword, '临时密码只显示这一次。对方用它登录后会被要求设置新密码。'); render(); });
  }));
}

// ---------------------------------------------------------------- 用户详情
let uTab = 'overview';
let uuRange = newRange(); // 用户详情"用量历史"里的日期范围
async function pageUser(sub) {
  const [u, tasks] = await Promise.all([api('GET', `/users/${sub}`), api('GET', `/users/${sub}/tasks`)]);
  pageUser.cur = u;
  pageUser.tasks = tasks.items;
  const months = u.months.map(m => ({ ...m, v: m.tasks, l: `${m.month.slice(0, 4)} 年 ${+m.month.slice(5)} 月`, short: `${+m.month.slice(5)}月` }));
  const cur = u.months[u.months.length - 1], fin = cur.done + cur.failed;
  const tabs = [['overview', '概况'], ['usage', '用量历史'], ['tasks', `任务 ${tasks.items.length}`]];
  const body = {
    overview: `
      <div class="grid g4">
        ${kpi('本月任务', `${cur.tasks}<small>个</small>`, fin ? `成功率 ${Math.round(cur.done / fin * 100)}%` : '本月还没有完成的任务')}
        ${kpi('本月成片', `${cur.minutes}<small>分钟</small>`, '按每个任务最新一版的时长')}
        ${kpi('累计任务', `${u.totalTasks}<small>个</small>`, `近 12 个月 ${u.months.reduce((s, m) => s + m.tasks, 0)} 个`)}
        ${kpi('最近活跃', u.lastActive ? ago(u.lastActive) : '—', u.lastActive ? fmtTime(u.lastActive) : '还没有生成过任务')}
      </div>
      ${creditCard(u.credits)}
      <div class="grid g-main mt">
        <div class="card"><div class="card-head"><div><h2>近 12 个月任务数</h2><p class="sub">按北京时间分月；本月还没结束，颜色浅一些</p></div><button class="btn sm" data-tab-go="usage">看明细</button></div>${barChart(months)}</div>
        <div class="card"><h2>账号信息</h2><dl class="kv mt">
          <dt>邮箱</dt><dd>${esc(u.email)}</dd><dt>姓名</dt><dd>${esc(u.name || '—')}</dd><dt>状态</dt><dd>${userBadge(u.status)}</dd>
          <dt>角色</dt><dd>${u.admin ? badge('b-info', '管理员') : '普通用户'}</dd><dt>开通时间</dt><dd>${fmtTime(u.created)}</dd>
          <dt>用户 ID</dt><dd class="mono">${esc(u.sub)}</dd><dt>生成上限</dt><dd>同时最多 3 个任务 · 每天最多 30 个</dd></dl></div>
      </div>`,
    usage: `
      <div class="sec-h"><h2>按日期</h2><span class="sub">Credit 用量，按北京时间统计</span></div>
      <div class="toolbar" id="uu-range">${rangeBar(uuRange)}<div class="grow"></div><span class="muted" id="uu-total"></span></div>
      <div class="range-body" id="uu-body"><div class="card loading">加载中…</div></div>
      <div class="sec-h" style="margin-top:28px"><h2>按月</h2><span class="sub">近 12 个月</span></div>
      <div class="card"><div class="card-head"><div><h2>按月任务数</h2><p class="sub">任务数、成片时长、结果和 Credit；成片时长取每个任务最新一版</p></div></div>${barChart(months, { h: 170 })}</div>
      <div class="table-wrap mt"><table class="t"><thead><tr><th>月份</th><th class="r">任务</th><th class="r">已完成</th><th class="r">失败</th><th class="r">成片时长</th><th class="r">Credit</th></tr></thead><tbody>
      ${[...months].reverse().map(m => `<tr><td>${m.l}</td><td class="r num">${m.tasks || '—'}</td><td class="r num">${m.done || '—'}</td><td class="r num">${m.failed || '—'}</td><td class="r num">${m.minutes ? m.minutes + ' 分钟' : '—'}</td><td class="r num">${m.credits ? cr(m.credits) : '—'}</td></tr>`).join('')}
      </tbody></table></div>`,
    tasks: `
      <div class="table-wrap" id="ut-table"><table class="t"><thead><tr><th>任务</th><th>风格</th><th>状态</th><th class="r">成片</th><th class="r">版本</th><th class="r">Credit</th><th>创建时间</th><th>最近更新</th><th class="r">用量</th></tr></thead><tbody>
      ${tasks.items.map(t => `<tr><td class="who"><b>${esc(t.title)}</b><small class="mono">${esc(t.id.slice(0, 8))}</small>${t.failure ? `<small style="color:var(--fail)">${esc(t.failure)}</small>` : ''}</td>
        <td>${esc((t.skills || []).join('、') || '—')}</td><td>${taskBadge(t.status)}</td><td class="r num">${t.seconds ? Math.round(t.seconds) + ' 秒' : '—'}</td>
        <td class="r num">${t.versions || '—'}</td><td class="r num">${t.credits != null ? cr(t.credits) : '—'}</td><td class="muted">${fmtTime(t.createdAt)}</td><td class="muted">${ago(t.updatedAt)}</td>
        <td class="r">${taskActs(t)}</td></tr>`).join('') || '<tr><td colspan="9" class="empty">还没有任务</td></tr>'}
      </tbody></table></div>
      <p class="muted mt">管理员只能看到任务的标题、状态和用量，看不到成片和素材。</p>`,
  }[uTab];
  return `
  <div class="detail-head"><span class="avatar">${esc((u.name || u.email)[0].toUpperCase())}</span>
    <div class="grow"><h1>${esc(u.name || u.email.split('@')[0])} ${userBadge(u.status)} ${u.admin ? badge('b-info', '管理员') : ''}</h1><div class="meta"><span>${esc(u.email)}</span></div></div>
    <div class="ph-actions"><button class="btn" data-act="reset">重置密码</button><button class="btn" data-act="role">${u.admin ? '取消管理员' : '设为管理员'}</button>
      <button class="btn ${u.status === 'disabled' ? '' : 'danger'}" data-act="toggle">${u.status === 'disabled' ? '启用账号' : '停用账号'}</button></div></div>
  <div class="tabs" role="tablist">${tabs.map(([k, t]) => `<button class="tab" role="tab" data-tab="${k}" aria-selected="${uTab === k}">${t}</button>`).join('')}</div>
  ${body}`;
}
/** 用户详情概况里的"本月 Credit"卡片 */
function creditCard(c) {
  if (!c) return '';
  const p = c.quota > 0 ? c.used / c.quota : (c.used > 0 ? 1 : 0);
  return `<div class="card mt"><div class="card-head"><div><h2>本月 Credit ${c.custom ? badge('b-info', '单独设置') : badge('b-idle', '默认额度')}</h2>
      <p class="sub">${monthLabel(c.month)} · 北京时间自然月，每月 1 日重新计算。用完后不能新建任务、修改或重试，正在跑的那一轮会做完</p></div>
      <button class="btn sm" data-act="quota">修改额度</button></div>
    <div class="credit-line"><span class="k-val num">${cr(c.used)}<small>/ ${crq(c.quota)} Credit</small></span>
      <span class="meter ${meterCls(p)}" role="progressbar" aria-label="本月额度已用" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(Math.min(1, p) * 100)}"><i style="width:${Math.min(100, p * 100)}%"></i></span>
      <span class="muted">已用 ${Math.floor(p * 100)}% · 剩余 ${cr(Math.max(0, c.quota - c.used))} Credit</span></div></div>`;
}
/** 修改月额度：单独设置一个数，或者恢复默认（monthly: null） */
function editQuota(u, after) {
  const c = u.credits || {};
  modal(`<h3>修改月额度 · ${esc(u.email)}</h3>
    <p class="muted">本月已用 ${cr(c.used)} Credit，现在的额度是 ${crq(c.quota)} Credit（${c.custom ? '单独设置' : '默认'}）。改动立即生效；新额度低于已用量时，这个月不能再新建任务、修改或重试。</p>
    <div class="radio-cards" role="radiogroup" aria-label="额度">
      <label><input type="radio" name="q-mode" value="default" ${c.custom ? '' : 'checked'}><b>使用默认额度</b><small id="q-default">跟随计费设置里的默认月额度</small></label>
      <label><input type="radio" name="q-mode" value="custom" ${c.custom ? 'checked' : ''}><b>单独设置</b><small>只对这个用户生效</small></label>
    </div>
    <label class="field"><span>每月额度（Credit）</span><input class="inp num" id="q-val" type="number" min="0" step="1" value="${esc(c.quota ?? '')}"></label>
    <div class="actions"><button class="btn" data-close>取消</button><button class="btn primary" data-ok>保存</button></div>`, async () => {
    const custom = $('input[name=q-mode]:checked').value === 'custom', raw = $('#q-val').value.trim(), monthly = custom ? Number(raw) : null;
    if (custom && (!raw || !Number.isFinite(monthly) || monthly < 0)) throw new Error('额度要填一个不小于 0 的数');
    await api('PUT', `/users/${u.sub}/quota`, { monthly });
    toast(custom ? `已把月额度设为 ${crq(monthly)} Credit` : '已恢复默认额度');
    after?.();
  });
  const sync = () => { $('#q-val').disabled = $('input[name=q-mode]:checked').value !== 'custom'; };
  $$('input[name=q-mode]').forEach(r => r.addEventListener('change', sync));
  sync();
  $('input[name=q-mode]:checked').focus(); // 单选组的焦点放在选中的那一项
  api('GET', '/billing').then(b => { const el = $('#q-default'); if (el && b?.defaultMonthly != null) el.textContent = `现在是每月 ${crq(b.defaultMonthly)} Credit`; }).catch(() => {});
}
/** 用户详情"用量历史"：按日期范围取这个用户的每日用量和任务用量 */
async function loadUserUsage(sub) {
  const box = $('#uu-body');
  if (!box) return;
  const my = loadUserUsage.seq = (loadUserUsage.seq || 0) + 1, st = { ...uuRange };
  box.classList.add('is-loading');
  try {
    const r = await api('GET', `/users/${sub}/usage?from=${st.from}&to=${st.to}`);
    if (my !== loadUserUsage.seq || !document.body.contains(box)) return;
    const tasks = [...(r.tasks || [])].sort((a, b) => (b.credits || 0) - (a.credits || 0));
    $('#uu-total').textContent = `合计 ${cr(r.total)} Credit · ${tasks.length} 个任务`;
    box.innerHTML = `<div class="card"><div class="card-head"><div><h2>每日用量</h2><p class="sub">单位 Credit；今天还没结束，颜色浅一些</p></div></div><div class="dc-host"></div></div>
      <div class="table-wrap mt"><table class="t"><thead><tr><th>任务</th><th>状态</th><th>创建时间</th><th class="r">Credit</th><th class="r">用量</th></tr></thead><tbody>
      ${tasks.map(t => `<tr><td class="who"><b>${esc(t.title || '—')}</b><small class="mono">${esc(String(t.id).slice(0, 8))}</small></td><td>${taskBadge(t.status)}</td>
        <td class="muted">${fmtTime(t.createdAt)}</td><td class="r num">${cr(t.credits)}</td><td class="r">${taskActs(t)}</td></tr>`).join('') || '<tr><td colspan="5" class="empty">这段时间没有任务用量</td></tr>'}
      </tbody></table></div>`;
    dayCard($('.dc-host', box), r.from || st.from, r.to || st.to, r.days);
    bindTaskActs(box, tasks, render);
  } catch (e) {
    if (my !== loadUserUsage.seq || !document.body.contains(box) || e.status === 401) return;
    box.innerHTML = `<div class="card empty">${esc(e.message)} <button class="btn sm" data-uu-retry>重试</button></div>`;
    $('[data-uu-retry]', box).addEventListener('click', () => loadUserUsage(sub));
  } finally {
    if (my === loadUserUsage.seq) box.classList.remove('is-loading');
  }
}
function bindUser(sub) {
  const u = pageUser.cur;
  $('[data-act=quota]')?.addEventListener('click', () => editQuota(u, render));
  if ($('#uu-range')) { bindRange($('#uu-range'), uuRange, () => loadUserUsage(sub)); loadUserUsage(sub); }
  if ($('#ut-table')) bindTaskActs($('#ut-table'), pageUser.tasks || [], render);
  $$('[data-tab]').forEach(b => b.addEventListener('click', () => { uTab = b.dataset.tab; render(); }));
  $$('[data-tab-go]').forEach(b => b.addEventListener('click', () => { uTab = b.dataset.tabGo; render(); }));
  $('[data-act=reset]').addEventListener('click', () => modal(`<h3>重置密码 · ${esc(u.email)}</h3><p>会生成一个新的临时密码，对方下次登录时必须修改。旧密码立即失效。</p>
    <div class="actions"><button class="btn" data-close>取消</button><button class="btn primary" data-ok>重置</button></div>`, async () => {
    const r = await api('POST', `/users/${sub}/reset-password`, {});
    setTimeout(() => showSecret(`${u.email} 的临时密码`, r.tempPassword, '只显示这一次，请转交给对方。'));
  }));
  $('[data-act=toggle]').addEventListener('click', () => modal(`<h3>${u.status === 'disabled' ? '启用' : '停用'}账号 · ${esc(u.email)}</h3>
    <p>${u.status === 'disabled' ? '启用后对方可以重新登录和新建任务。' : '停用后对方立即退出、不能再登录；正在生成的任务会继续跑完，已有成片保留。'}</p>
    <label class="field"><span>原因（记入操作日志）</span><input class="inp" id="t-reason"></label>
    <div class="actions"><button class="btn" data-close>取消</button><button class="btn ${u.status === 'disabled' ? 'primary' : 'danger'}" data-ok>确认</button></div>`, async () => {
    await api('POST', `/users/${sub}/${u.status === 'disabled' ? 'enable' : 'disable'}`, { reason: $('#t-reason').value });
    toast('已更新账号状态'); render();
  }));
  $('[data-act=role]').addEventListener('click', () => modal(`<h3>${u.admin ? '取消管理员' : '设为管理员'} · ${esc(u.email)}</h3>
    <p>${u.admin ? '取消后对方不能再登录管理端，用户端不受影响。' : '设为管理员后，对方可以登录管理端，管理所有用户和模型密钥。对方需要重新登录后生效。'}</p>
    <div class="actions"><button class="btn" data-close>取消</button><button class="btn primary" data-ok>确认</button></div>`, async () => {
    await api('PUT', `/users/${sub}/role`, { admin: !u.admin });
    toast(u.admin ? '已取消管理员' : '已设为管理员'); render();
  }));
}

// ---------------------------------------------------------------- Skill 创建（docs/style-creator-design.md 第五、十一节，docs/skills-two-dimensions.md）
// 上传参考视频 → Agent 反编译出画风和写作方法两种 Skill（各是一条记录，共用一个生成任务）→ 各自待验证 → 内测发布（只有管理员能用）→ 做测试片 → 公开发布；以后可以下架
const ST_STATUS = { draft: ['b-idle', '待上传'], generating: ['b-run', '生成中'], review: ['b-warn', '待验证'], beta: ['b-info', '内测中'],
  public: ['b-ok', '已公开'], retired: ['b-idle', '已下架'], rejected: ['b-fail', '已驳回'], failed: ['b-fail', '生成失败'] };
const styleBadge = s => badge(...(ST_STATUS[s] || ['b-idle', s || '—']));
const STYLE_CATS = ['信息与图解', '图形与排版', '手绘与绘画', '东方传统', '印刷与版画', '材质与 3D', '卡通与动画', '游戏', '电影与时代', '插画讲解'];
const GEN_STEPS = { analyze: '看视频', listen: '听旁白', traits: '提炼要素', skill: '写说明书', engine: '写引擎和示范镜头', writing: '写写作方法', check: '自检打分' };
const KIND_NAME = { visual: '画风', writing: '写作方法' };
const isWriting = s => s?.kind === 'writing';
const kn = s => KIND_NAME[isWriting(s) ? 'writing' : 'visual'];
const GROUPS = ['讲解', '宣传'];
/** 画风看分类，写作方法看属于讲解类还是宣传类 */
const sortOf = s => (isWriting(s) ? `${s.group || '讲解'}类` : s.cat || '未分类');
const WTRIAL_KEYS = [['structure', '结构'], ['opening', '开场'], ['rhythm', '节奏'], ['voice', '口吻']];
const STEP_STATE = { done: ['done', '已完成'], running: ['run', '进行中'], failed: ['fail', '失败'], skipped: ['', '跳过'], pending: ['', '等待'] };
const TRIAL_KEYS = [['color', '色彩'], ['layout', '版式'], ['motion', '动作'], ['grammar', '镜头语法']];
const VIDEO_TYPES = { mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm' };
const VIDEO_MAX = 300 * 1024 * 1024;
const SLUG_RE = /^[a-z][a-z0-9-]{2,30}$/;
const HEX_RE = /^#[0-9a-f]{3,8}$/i;
const extOf = name => (String(name).match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();
const fmtSize = b => (b == null ? '—' : b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
const fmtDur = sec => { const r = Math.round(sec); return r >= 60 ? `${Math.floor(r / 60)} 分 ${pad(r % 60)} 秒` : `${r} 秒`; };
const dec = (x, d = 2) => (x == null || x === '' || !Number.isFinite(Number(x)) ? '—' : Number(x).toFixed(d));
/** 媒体链接都是后端签发的；只认 http(s) 和站内路径，别的一律不放进页面 */
const safeUrl = u => (typeof u === 'string' && /^(https?:\/\/|\/[^/])/i.test(u) ? u : '');
const genGoing = t => !!t && (t.status === 'queued' || t.status === 'running');
const textOf = x => (typeof x === 'string' ? x : x?.text || x?.message || '');
/** "内测 v2 · 公开 v1"；还有更新的版本时再加"最新 v3" */
function verLine(s) {
  const out = [];
  if (s.betaV && s.betaV !== s.publicV) out.push(`内测 v${s.betaV}`);
  if (s.publicV) out.push(`公开 v${s.publicV}`);
  if (s.latestV && s.latestV !== s.betaV && s.latestV !== s.publicV) out.push(`最新 v${s.latestV}`);
  return out.join(' · ') || '还没有版本';
}

// ---- 列表
let stFilter = 'all', stKind = 'all';
async function pageStyles() {
  pageStyles.items = (await api('GET', '/styles')).items || [];
  return renderStyles(pageStyles.items);
}
function renderStyles(all) {
  all = all.filter(s => stKind === 'all' || (stKind === 'writing') === isWriting(s));
  const n = k => (k === 'all' ? all.length : all.filter(s => s.status === k).length);
  // 前四个状态常驻，少见的状态有了才出现
  const chips = [['all', '全部'], ...['review', 'generating', 'beta', 'public', 'failed', 'rejected', 'retired', 'draft']
    .filter((k, i) => i < 4 || n(k) || stFilter === k).map(k => [k, ST_STATUS[k][1]])];
  const list = all.filter(s => stFilter === 'all' || s.status === stFilter).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return `
  <div class="ph"><div class="grow"><h1>Skill 创建</h1><p>上传一段参考视频，由 Agent 反编译成两种 Skill：画风（画面长什么样）和写作方法（剧本怎么组织）。两种分开验证、分开发布：先内测，只有管理员能用；做过测试片、确认效果后再公开发布给所有用户</p></div>
    <div class="ph-actions"><a class="btn primary" href="#style-new">${icon('plus')}新建 Skill</a></div></div>
  <div class="toolbar"><div class="chips" role="group" aria-label="种类">${[['all', '全部种类'], ['visual', '画风'], ['writing', '写作方法']].map(([k, t]) => `<button class="chip" data-k="${k}" aria-pressed="${stKind === k}">${t}</button>`).join('')}</div>
    <div class="chips">${chips.map(([k, t]) => `<button class="chip" data-f="${k}" aria-pressed="${stFilter === k}">${t}<span class="n">${n(k)}</span></button>`).join('')}</div>
    <div class="grow"></div><span class="muted">${list.length} 个 Skill</span></div>
  ${list.length ? `<div class="skill-grid">${list.map(styleCard).join('')}</div>`
    : `<div class="card empty">${all.length ? '没有这个状态的 Skill' : stKind !== 'all' ? `还没有${KIND_NAME[stKind]}` : '还没有 Skill。点右上角「新建 Skill」，上传一段参考视频开始'}</div>`}`;
}
function styleCard(s) {
  const thumb = safeUrl(s.thumb);
  return `<a class="sk-card" href="#style/${esc(s.id)}">
    <div class="sk-thumb">${thumb ? `<img src="${esc(thumb)}" alt="" loading="lazy">` : `<div class="ph-swatch${isWriting(s) ? ' wr' : ''}">${s.status === 'generating' ? '正在生成…' : s.status === 'draft' ? '参考视频还没传完' : isWriting(s) ? `写作方法 · ${esc(sortOf(s))}` : '没有缩略图'}</div>`}${styleBadge(s.status)}</div>
    <div class="sk-body"><b>${esc(s.name)} <span class="sk-ver">${esc(verLine(s))}</span></b>
      <p><span class="mono">${esc(s.id)}</span> · ${kn(s)} · ${esc(sortOf(s))}</p>
      <p>${esc(s.createdBy?.email || '—')} · ${ago(s.updatedAt || s.createdAt)}更新</p></div></a>`;
}
function bindStyles() {
  const redo = () => { $('#page').innerHTML = renderStyles(pageStyles.items); bindStyles(); };
  $$('[data-f]').forEach(b => b.addEventListener('click', () => { stFilter = b.dataset.f; redo(); }));
  $$('[data-k]').forEach(b => b.addEventListener('click', () => { stKind = b.dataset.k; stFilter = 'all'; redo(); }));
}

// ---- 新建：先登记（POST /styles 拿到上传地址）→ 用 XHR 把视频 PUT 上去（看得到进度）→ POST /styles/{id}/start → 去详情页
let snState = null;
let uploading = 0; // 正在上传的视频数。离开这一页上传照常进行，关标签页前提醒一下
addEventListener('beforeunload', e => { if (uploading) { e.preventDefault(); e.returnValue = ''; } });
function pageStyleNew() {
  snState = { file: null, dur: null, created: null, uploaded: false };
  return `
  <div class="ph"><div class="grow"><h1>新建 Skill</h1><p>Agent 先看视频、听旁白，再分别写画风（说明书、引擎和示范镜头）和写作方法（结构、开场、节奏、旁白口吻），各自自检打分。生成好以后两种分开验证，满意了再内测发布</p></div></div>
  <div class="grid g-main">
    <div class="card"><h2>1. 参考视频</h2>
      <label class="drop mt" id="sn-drop"><input class="sr-only" type="file" id="sn-file" accept=".mp4,.mov,.webm,video/mp4,video/quicktime,video/webm">${icon('upload')}<b>点这里选择参考视频，或者把文件拖进来</b>MP4、MOV、WebM，不超过 300 MB；一段视频可以做一种画风加一种写作方法</label>
      <div id="sn-file-row"></div>
      <div class="up-line" id="sn-up" hidden><span class="meter" role="progressbar" aria-label="上传进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><i style="width:0"></i></span><span class="muted num"></span></div>
      <div class="review mt"><label><input type="checkbox" id="sn-rights">我确认有权使用这段视频做参考。生成的 Skill 只学习画法（色彩、版式、动作）和讲法（结构、开场、节奏、口吻），不复制其中的具体画面、角色、Logo 和文案</label></div>
      <h2 style="margin-top:22px">2. 要生成什么</h2>
      <div class="review mt">
        <label><input type="checkbox" id="sn-out-visual" data-out="visual" checked><span><b>画风</b>　画面长什么样：配色、字体、版式和动作</span></label>
        <label><input type="checkbox" id="sn-out-writing" data-out="writing" checked><span><b>写作方法</b>　剧本怎么组织：结构、开场、节奏和旁白口吻。参考视频要有旁白或画面上的大字</span></label></div>
      <div class="form-grid mt">
        <label class="field full"><span>英文短名</span><input class="inp mono" id="sn-slug" maxlength="31" placeholder="paper-kepu" autocomplete="off" spellcheck="false"><small id="sn-slug-hint">两种共用，创建后不能改</small></label>
        <label class="field" data-for="visual"><span>画风名称</span><input class="inp" id="sn-name" maxlength="20" placeholder="例如：纸面科普"><small>用户在画风库里看到的名字。用中性的描述，不用品牌名或作者名</small></label>
        <label class="field" data-for="visual"><span>画风分类</span><select class="inp" id="sn-cat"><option value="">选一个分类</option>${STYLE_CATS.map(c => `<option>${esc(c)}</option>`).join('')}</select></label>
        <label class="field" data-for="writing"><span>写作方法名称</span><input class="inp" id="sn-wname" maxlength="20" placeholder="例如：悬念拆解"><small>用户在写作方法下拉框里看到的名字。同样不用品牌名或作者名</small></label>
        <label class="field" data-for="writing"><span>写作方法属于</span><select class="inp" id="sn-group">${GROUPS.map(g => `<option value="${g}">${g}类</option>`).join('')}</select><small>决定做片时配哪份通用打法</small></label>
        <label class="field full"><span>补充说明（可选）</span><textarea class="inp" id="sn-notes" maxlength="500" placeholder="比如：保留纸张质感；不要出现参考视频里的人物和品牌；开场的反问一定要学到"></textarea><small>交给 Agent：一定要保留的、不要的，或者希望能变化的地方</small></label>
      </div></div>
    <div><div class="card"><h2>3. 开始生成</h2>
      <p class="sub mt">点"开始生成"后，先上传视频，传完马上开始。生成中可以离开这个页面，做好了状态会变成「待验证」。</p>
      <div class="note mt">${icon('coin')}<span id="sn-est">${estimate(['visual', 'writing'])}</span></div>
      <p class="form-err mt" id="sn-err" role="alert" hidden></p>
      <div class="ph-actions mt"><a class="btn" href="#styles">取消</a><button class="btn primary" id="sn-go">开始生成</button></div></div></div>
  </div>`;
}
/** 预计用时和用量：画风要逐段重建和渲染，写作方法只听旁白、写说明书、试写剧本 */
function estimate(outs) {
  const v = outs.includes('visual'), w = outs.includes('writing');
  return !v && !w ? '至少选一种' : `预计约 ${v ? (w ? '50～100' : '40～90') : '15～30'} 分钟、约 ${v ? (w ? '18～40' : '15～35') : '3～8'} Credit（记在你的账上）。`;
}
const outsOf = () => $$('[data-out]').filter(x => x.checked).map(x => x.dataset.out);
function slugHint(v) {
  const outs = outsOf(), core = v.replace(/^(film|write)-/, '');
  if (!v) return '两种共用，创建后不能改';
  if (!SLUG_RE.test(v)) return '小写字母开头，只用小写字母、数字和连字符，3～31 个字符';
  return `${outs.map(k => `${KIND_NAME[k]} id 是 ${k === 'visual' ? 'film-' : 'write-'}${core}`).join('，') || '先选要生成哪种'}，创建后不能改`;
}
function snErr(msg) { const el = $('#sn-err'); if (el) { el.textContent = msg; el.hidden = !msg; } }
function fileRow(st) {
  const f = st.file;
  if (!f) return '';
  return `<div class="file-row">${icon('film')}<span class="grow">${esc(f.name)} <span class="muted">· ${st.dur ? `${fmtDur(st.dur)} · ` : ''}${fmtSize(f.size)}</span></span>
    ${st.uploaded ? badge('b-ok', '已上传') : st.created ? '' : `<button class="btn sm ghost" data-clear aria-label="换一个文件">${icon('x')}</button>`}</div>`;
}
function refreshFileRow(st) {
  if (st !== snState || !$('#sn-file-row')) return;
  $('#sn-file-row').innerHTML = fileRow(st);
  $('[data-clear]')?.addEventListener('click', () => { Object.assign(st, { file: null, dur: null }); $('#sn-file').value = ''; refreshFileRow(st); });
}
function pickVideo(st, f) {
  if (!f || st.created) return;
  if (!VIDEO_TYPES[extOf(f.name)]) return toast('只收 MP4、MOV、WebM 格式的视频');
  if (f.size > VIDEO_MAX) return toast(`这段视频有 ${fmtSize(f.size)}，超过了 300 MB`);
  if (!f.size) return toast('这个文件是空的');
  Object.assign(st, { file: f, dur: null });
  refreshFileRow(st);
  // 读出时长显示一下；浏览器解不了的格式（比如部分 MOV）读不到，不影响上传
  const v = document.createElement('video'), url = URL.createObjectURL(f);
  v.preload = 'metadata';
  v.onloadedmetadata = () => { if (st.file === f && Number.isFinite(v.duration)) { st.dur = v.duration; refreshFileRow(st); } URL.revokeObjectURL(url); };
  v.onerror = () => URL.revokeObjectURL(url);
  v.src = url;
}
/** 读表单，校验后返回 POST /styles 的请求体；不对时抛错（e.el 是出错的输入框） */
function readStyleForm(st) {
  const bad = (msg, el) => Object.assign(new Error(msg), { el });
  const f = st.file, outs = outsOf(), slug = $('#sn-slug').value.trim(), cat = $('#sn-cat').value, group = $('#sn-group').value;
  const name = $('#sn-name').value.trim(), wname = $('#sn-wname').value.trim();
  if (!f) throw bad('先选择一段参考视频', $('#sn-file'));
  if (!$('#sn-rights').checked) throw bad('请先勾选确认：你有权使用这段视频做参考', $('#sn-rights'));
  if (!outs.length) throw bad('至少选一种：画风或写作方法', $('#sn-out-visual'));
  if (!SLUG_RE.test(slug)) throw bad('英文短名要以小写字母开头，只用小写字母、数字和连字符，3～31 个字符', $('#sn-slug'));
  if (outs.includes('visual') && !name) throw bad('请填写画风名称', $('#sn-name'));
  if (outs.includes('visual') && !cat) throw bad('请选择画风分类', $('#sn-cat'));
  if (outs.includes('writing') && !wname) throw bad('请填写写作方法名称', $('#sn-wname'));
  return { name: outs.includes('visual') ? name : wname, wname, slug, cat, group, outputs: outs, notes: $('#sn-notes').value.trim(), rights: true,
    file: { name: f.name, size: f.size, contentType: VIDEO_TYPES[extOf(f.name)] } };
}
function lockStyleForm(lock) {
  $$('#sn-name, #sn-wname, #sn-group, #sn-slug, #sn-cat, #sn-notes, #sn-rights, #sn-file, [data-out]').forEach(el => (el.disabled = lock));
  $('#sn-drop').classList.toggle('is-locked', lock);
}
/** 把视频 PUT 到预签名地址。用 XHR 是为了拿到上传进度（fetch 拿不到）；onProgress(已传字节, 总字节) */
function putVideo(up, file, onProgress) {
  if (!safeUrl(up?.url)) return Promise.reject(new Error('服务器没有给出上传地址，请重试'));
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest(), hs = Object.entries(up.headers || {});
    x.open('PUT', up.url);
    hs.forEach(([k, v]) => { if (!/^(host|content-length)$/i.test(k)) x.setRequestHeader(k, v); }); // 这两个浏览器不让设
    if (!hs.some(([k]) => /^content-type$/i.test(k))) x.setRequestHeader('Content-Type', VIDEO_TYPES[extOf(file.name)]);
    x.upload.onprogress = e => onProgress(e.loaded, e.lengthComputable ? e.total : file.size);
    x.onload = () => (x.status >= 200 && x.status < 300 ? resolve()
      : reject(new Error(x.status === 403 ? '上传地址已经失效（403）' : `上传失败（${x.status}）`)));
    x.onerror = () => reject(new Error('上传中断了，请检查网络后重试'));
    x.send(file);
  });
}
function showUpload(done, total) {
  const box = $('#sn-up'), p = total ? Math.min(1, done / total) : 0;
  if (!box) return;
  box.hidden = false;
  $('i', box).style.width = `${p * 100}%`;
  $('.meter', box).setAttribute('aria-valuenow', String(Math.round(p * 100)));
  $('.muted', box).textContent = p >= 1 ? '已上传 100%，正在确认…' : `已上传 ${Math.floor(p * 100)}% · ${fmtSize(done)} / ${fmtSize(total)}`;
}
async function submitStyle() {
  const st = snState, btn = $('#sn-go'), live = () => st === snState && document.body.contains(btn);
  const label = t => { if (live()) btn.textContent = t; };
  let body;
  if (!st.created) {
    try { body = readStyleForm(st); } catch (e) { snErr(e.message); e.el?.focus(); return; }
  }
  snErr(''); btn.disabled = true; lockStyleForm(true);
  try {
    if (!st.created) { label('正在登记…'); st.created = await api('POST', '/styles', body); st.name = body.name; refreshFileRow(st); }
    if (!st.uploaded) {
      label('正在上传…'); uploading++;
      try { await putVideo(st.created.upload, st.file, (d, t) => live() && showUpload(d, t)); } finally { uploading--; }
      st.uploaded = true; refreshFileRow(st);
    }
    label('正在开始…');
    await api('POST', `/styles/${encodeURIComponent(st.created.id)}/start`);
    if (live()) { toast('已开始生成，做好了状态会变成「待验证」'); location.hash = `#style/${st.created.id}`; }
    else toast(`「${st.name}」的参考视频传完了，已开始生成`);
  } catch (e) {
    if (!live()) { if (e.status !== 401) toast(`「${st.name || body?.name}」没能开始生成：${e.message}`); return; }
    btn.disabled = false;
    btn.textContent = !st.created ? '开始生成' : !st.uploaded ? '重新上传' : '重试开始生成';
    snErr(st.created && !st.uploaded ? `${e.message}。已经登记为 ${Object.values(st.created.ids || { v: st.created.id }).join('、')}，点「重新上传」再传一次` : e.message);
    if (!st.created) lockStyleForm(false);
  }
}
function bindStyleNew() {
  const st = snState, drop = $('#sn-drop');
  $('#sn-file').addEventListener('change', e => pickVideo(st, e.target.files[0]));
  drop.addEventListener('dragover', e => { e.preventDefault(); if (!st.created) drop.classList.add('is-over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('is-over'));
  drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('is-over'); pickVideo(st, e.dataTransfer.files[0]); });
  $('#sn-slug').addEventListener('input', e => {
    const el = e.target, v = el.value.toLowerCase();
    if (v !== el.value) el.value = v;
    $('#sn-slug-hint').textContent = slugHint(v);
  });
  // 只要一种时，另一种的名称和分类收起来
  const outs = () => {
    const o = outsOf();
    $$('[data-for]').forEach(el => (el.hidden = !o.includes(el.dataset.for)));
    $('#sn-est').textContent = estimate(o);
    $('#sn-slug-hint').textContent = slugHint($('#sn-slug').value);
  };
  $$('[data-out]').forEach(b => b.addEventListener('change', outs));
  $('#sn-go').addEventListener('click', submitStyle);
}

// ---- 详情：生成过程、验证、测试片、风格要素、文件、版本。生成中每 10 秒刷新一次，离开页面（或重新渲染）就停
let stTab = null, stV = null, stFile = null;
const stPoll = { timer: 0, seq: 0 };
function stopStylePoll() { clearTimeout(stPoll.timer); stPoll.seq++; }
async function pageStyle(id) {
  const [s, cfg] = await Promise.all([api('GET', `/styles/${encodeURIComponent(id)}`), loadConfig().catch(() => ({}))]);
  const vers = [...(s.versions || [])].sort((a, b) => a.n - b.n), latest = vers[vers.length - 1];
  if (!stTab) stTab = latest && !genGoing(s.task) ? 'review' : 'progress';
  if (!latest) stTab = 'progress';
  const v = vers.find(x => x.n === stV) || latest;
  Object.assign(pageStyle, { cur: s, v });
  const tabs = [['progress', '生成过程'], ...(latest ? [['review', '验证'], ['tests', `测试片 ${(s.tests || []).length}`], ['traits', `${kn(s)}要素`], ['files', '文件'], ['history', `版本 ${vers.length}`]] : [])];
  const tag = x => (x.n === s.publicV ? ' · 已公开' : x.n === s.betaV ? ' · 内测中' : x === latest ? ' · 最新' : '');
  const pick = vers.length > 1 && ['review', 'traits', 'files'].includes(stTab)
    ? `<div class="chips" role="group" aria-label="看哪一版">${[...vers].reverse().map(x => `<button class="chip" data-ver-pick="${x.n}" aria-pressed="${x === v}">v${x.n}${tag(x)}</button>`).join('')}</div>` : '';
  const body = { progress: () => progressTab(s), review: () => reviewTab(s, v, vers), tests: () => testsTab(s, vers, cfg?.userSite),
    traits: () => (isWriting(s) ? writingTraitsTab(v) : traitsTab(v)), files: () => filesTab(s, v), history: () => historyTab(s, vers) }[stTab]();
  return `${styleHead(s, latest)}
  <div class="tabs" role="tablist">${tabs.map(([k, t]) => `<button class="tab" role="tab" data-tab="${k}" aria-selected="${stTab === k}">${t}</button>`).join('')}${pick}</div>
  <div id="st-body">${body}</div>`;
}
function styleHead(s, latest) {
  const src = s.source, url = safeUrl(src?.url);
  const srcName = esc(src?.name || '参考视频');
  return `<div class="detail-head"><div class="grow">
    <h1>${esc(s.name)}${latest ? ` <span class="ver">v${latest.n}</span>` : ''} ${styleBadge(s.status)}</h1>
    <div class="meta"><span class="mono">${esc(s.id)}</span><span>${kn(s)} · ${esc(sortOf(s))}</span>
      ${s.pair ? `<span>同一段参考视频还生成了${isWriting(s) ? '画风' : '写作方法'}：<a class="mono" href="#style/${esc(s.pair)}">${esc(s.pair)}</a></span>` : ''}
      ${s.betaV || s.publicV ? `<span>${esc(verLine({ ...s, latestV: null }))}</span>` : ''}
      <span>来源：${src ? `${url ? `<a href="${esc(url)}" target="_blank" rel="noopener">${srcName}</a>` : srcName}${src.size ? ` · ${fmtSize(src.size)}` : ''}` : '还没上传'}</span>
      <span>${esc(s.createdBy?.email || '—')} · ${fmtTime(s.createdAt)}</span></div>
    ${s.notes ? `<p class="st-line">补充说明：${esc(s.notes)}</p>` : ''}
    ${s.status === 'rejected' && s.reason ? `<p class="st-line bad">驳回原因：${esc(s.reason)}</p>` : ''}</div></div>`;
}
function progressTab(s) {
  const t = s.task;
  if (!t) return `<div class="card empty">${s.status === 'draft' ? '参考视频还没传完，还没开始生成' : '没有生成记录'}</div>`;
  const steps = t.steps?.length ? t.steps : Object.keys(GEN_STEPS).map(id => ({ id, state: 'pending' })), fail = textOf(t.failure);
  return `<div class="grid g-main">
    <div class="card"><div class="card-head"><div><h2>生成过程 ${taskBadge(t.status)}</h2>
      <p class="sub">${genGoing(t) ? `${s.pair ? '画风和写作方法在同一个任务里生成，一共约 50～100 分钟。' : isWriting(s) ? '一共约 15～30 分钟。' : '一共约 40～90 分钟。'}可以离开这个页面，做好了状态会变成「待验证」；这里每 10 秒刷新一次` : t.status === 'failed' ? '这一轮没做完' : '这一轮做完了'}</p></div></div>
      ${fail ? `<div class="note warn" style="margin-bottom:12px">${icon('alert')}<span>${esc(fail)}</span></div>` : ''}
      <div class="steps">${steps.map(stepRow).join('')}</div>
      ${t.stale ? `<div class="note warn mt">${icon('alert')}<span>已经 ${Math.round((Date.now() - (t.updatedAt || 0)) / 60000)} 分钟没有动静，Agent 可能已经停了（比如会话被回收）。可以重试，在同一个任务里接着做。</span></div>` : ''}
      ${t.status === 'completed' && !(s.versions || []).length ? `<div class="note warn mt">${icon('alert')}<span>生成任务做完了，但这份${kn(s)}没有导出${s.pair ? `（同一个任务里的${isWriting(s) ? '画风' : '写作方法'}可能已经好了）` : ''}。看看 Agent 的消息；可以重试，让 Agent 接着把它做完。</span></div>` : ''}
      ${(['failed', 'completed'].includes(t.status) && !(s.versions || []).length) || t.stale ? `<div class="ph-actions mt"><button class="btn primary" data-act="retry">${icon('refresh')}重试</button></div>` : ''}</div>
    <div class="card"><div class="card-head"><div><h2>Agent 的消息</h2><p class="sub">新的在上面</p></div><span class="muted num">已用 ${cr(t.credits)} Credit</span></div>
      <ul class="msgs">${msgList(t.messages)}</ul></div></div>`;
}
function stepRow(st, i) {
  const [cls, label] = STEP_STATE[st.state] || STEP_STATE.pending;
  const took = st.state === 'done' && st.startedAt && st.endedAt ? `${Math.max(1, Math.round((st.endedAt - st.startedAt) / 60000))} 分钟` : label;
  return `<div class="step ${cls}"><span class="dot">${st.state === 'done' ? icon('check') : st.state === 'failed' ? icon('x') : i + 1}</span>
    <div><b>${esc(st.label || GEN_STEPS[st.id] || st.name || st.id)}</b>${st.note ? `<p>${esc(st.note)}</p>` : ''}</div><span class="t">${took}</span></div>`;
}
function msgList(list) {
  const items = [...(list || [])].sort((a, b) => (b.at || 0) - (a.at || 0)).slice(0, 8);
  return items.map(m => `<li class="${m.role === 'agent' ? '' : 'mine'}"><span class="muted">${m.role === 'agent' ? 'Agent' : '修改意见'} · ${ago(m.at)}</span><p>${esc(m.text)}</p></li>`).join('')
    || '<li class="muted">还没有消息</li>';
}
function videoBox(url, cap) {
  const u = safeUrl(url);
  return `<figure class="vid">${u ? `<video src="${esc(u)}" controls muted playsinline preload="metadata"></video>` : '<div class="ph-swatch">没有视频</div>'}${cap ? `<figcaption>${esc(cap)}</figcaption>` : ''}</figure>`;
}
function segBlock(g) {
  const lag = g.peakLag && typeof g.peakLag === 'object' ? g.peakLag.median : g.peakLag, cmp = safeUrl(g.cmp);
  const sc = [['轮廓相似', dec(g.structure)], ['动作曲线相关', dec(g.motion)], ['配色色差', dec(g.paletteDeltaE, 1)], ['动作峰值时间差', lag == null ? '—' : `${dec(lag, 1)} 秒`]];
  return `<div class="seg"><div class="seg-h"><b class="mono">${esc(g.id)}</b><span>${esc(g.desc || '')}</span></div>
    ${videoBox(g.side, '左：参考 右：重建')}
    <dl class="scores">${sc.map(([k, x]) => `<div><dt>${k}</dt><dd class="num">${x}</dd></div>`).join('')}</dl>
    ${cmp ? `<a class="cmp" href="${esc(cmp)}" target="_blank" rel="noopener" title="在新标签页里看大图"><img src="${esc(cmp)}" alt="${esc(g.id)} 的逐帧对比图" loading="lazy"></a>` : ''}</div>`;
}
function trialBlock(t) {
  const notes = Array.isArray(t.notes) ? t.notes.join('；') : t.notes;
  return `<div class="trial mt">${videoBox(t.url)}<div><b>${esc(t.label || '试写')}</b>
    <div class="trial-scores">${TRIAL_KEYS.map(([k, n]) => `<span>${n} <b class="num">${esc(t.scores?.[k] ?? '—')}</b><small>/ 5</small></span>`).join('')}</div>
    ${notes ? `<p class="sub">${esc(notes)}</p>` : ''}</div></div>`;
}
/** 写作方法的试写：题材、四项分数、评审意见；剧本点开再取（review/trial-N.json） */
function wtrialBlock(t, i, v) {
  const path = `review/trial-${i + 1}.json`, has = (v.reviewFiles || []).includes(path);
  return `<div class="wtrial mt"><b>${esc(t.label || '试写')}</b>${t.topic ? `<span class="muted">　题材：${esc(t.topic)}</span>` : ''}
    <div class="trial-scores">${WTRIAL_KEYS.map(([k, n]) => `<span>${n} <b class="num">${esc(t.scores?.[k] ?? '—')}</b><small>/ 5</small></span>`).join('')}</div>
    ${t.notes ? `<p class="sub">${esc(t.notes)}</p>` : ''}
    ${has ? `<button class="btn sm mt" data-trial="${esc(path)}">看试写的剧本</button><div class="tbl-view" data-trial-view="${esc(path)}" hidden></div>` : ''}</div>`;
}
const fmtSec = x => (Number.isFinite(Number(x)) ? `${Number(x).toFixed(1)} 秒` : '—');
/** 原片分镜表 review/breakdown.json */
function breakdownTable(bd) {
  const shots = Array.isArray(bd?.shots) ? bd.shots : [], st = bd?.stats || {};
  if (!shots.length) return '<p class="muted">分镜表是空的</p>';
  const stat = [st.avg_shot != null && `平均镜头 ${dec(st.avg_shot, 1)} 秒`, st.chars_per_second != null && `每秒 ${dec(st.chars_per_second, 1)} 个字`,
    st.hook_seconds != null && `${dec(st.hook_seconds, 1)} 秒进入主题`, st.sections != null && `分 ${esc(st.sections)} 段`].filter(Boolean).join(' · ');
  return `${stat ? `<p class="sub">全长 ${fmtSec(bd.duration)} · ${stat}</p>` : ''}
    <div class="table-wrap mt"><table class="t mini wtable"><thead><tr><th>镜头</th><th>时间</th><th>旁白</th><th>屏上的字</th><th>语气</th><th>作用</th><th>镜头类型</th></tr></thead><tbody>
    ${shots.map(x => `<tr><td class="mono">${esc(x.id ?? '')}</td><td class="num nowrap">${dec(x.start, 1)}～${dec(x.end, 1)}</td><td>${esc(x.narration || '')}</td>
      <td>${esc(x.onscreen || '')}</td><td>${esc(x.tone || '')}</td><td>${esc(x.purpose || '')}</td><td>${esc(x.shot_type || '')}</td></tr>`).join('')}</tbody></table></div>`;
}
/** 试写出来的剧本 review/trial-N.json 的 trial.scenes */
function trialTable(rec) {
  const sc = Array.isArray(rec?.trial?.scenes) ? rec.trial.scenes : [];
  if (!sc.length) return '<p class="muted">没有剧本</p>';
  return `${rec.trial.title ? `<p class="mt"><b>${esc(rec.trial.title)}</b></p>` : ''}${rec.copied ? `<p class="st-line bad">和原片旁白有一段一样：「${esc(rec.copied)}」</p>` : ''}
    <div class="table-wrap mt"><table class="t mini wtable"><thead><tr><th>镜头</th><th>标题</th><th>旁白</th><th>画面</th><th class="r">时长</th><th>语气</th></tr></thead><tbody>
    ${sc.map(x => `<tr><td class="mono">${esc(x.id ?? '')}</td><td>${esc(x.title || '')}</td><td>${esc(x.narration || '')}</td><td>${esc(x.visual || '')}</td>
      <td class="r num">${esc(x.duration ?? '—')}</td><td>${esc(x.tone || '')}</td></tr>`).join('')}</tbody></table></div>`;
}
function writingReview(s, v, vers) {
  const trials = v.trials || [], checks = v.checks || [], bd = (v.reviewFiles || []).includes('review/breakdown.json');
  return `<div class="grid g-main">
    <div class="grid" style="align-content:start">
      <div class="card"><h2>原片分镜表</h2><p class="sub">Agent 听了旁白（看视频的模型能听出语气、语速和配乐），按切点拆成镜头：每镜多长、说了什么、起什么作用。试写打分就对照它。它只给你看，不进 Skill</p>
        ${bd ? '<div id="bd-view" class="mt">加载中…</div>' : '<p class="muted mt">这一版没有原片分镜表</p>'}</div>
      <div class="card"><h2>冷启动试写</h2><p class="sub">另开一次干净的模型调用，只给通用打法和这份写作方法，换一个新题材写剧本和分镜，再对照原片分镜表打分。四项各 5 分，分数低说明说明书没写清楚</p>
        ${trials.map((t, i) => wtrialBlock(t, i, v)).join('') || '<p class="muted mt">这一版没有试写</p>'}</div>
    </div>
    <div class="grid" style="align-content:start">
      ${checksCard(checks)}
      ${actionCard(s, v, vers)}
    </div></div>`;
}
function checksCard(checks) {
  return `<div class="card"><h2>自动检查</h2>${checks.length ? `<p class="sub">通过 ${checks.filter(c => c.ok).length} / ${checks.length} 项</p>
        <ul class="checks mt">${checks.map(c => `<li class="${c.ok ? 'ok' : 'fail'}">${icon(c.ok ? 'check' : 'x')}<span>${esc(c.name)}<span class="sr-only">${c.ok ? '：通过' : '：没通过'}</span><small>${esc(c.detail || '')}</small></span></li>`).join('')}</ul>`
        : '<p class="muted mt">这一版没有检查记录</p>'}</div>`;
}
function reviewTab(s, v, vers) {
  if (isWriting(s)) return writingReview(s, v, vers);
  const segs = v.segments || [], demos = v.demos || [], trials = v.trials || [], checks = v.checks || [];
  return `<div class="grid g-main">
    <div class="grid" style="align-content:start">
      <div class="card"><h2>逐段重建对比</h2><p class="sub">Agent 先把参考视频里的几段逐帧重建出来、和原片对上，再抽成引擎。轮廓相似、动作曲线相关越接近 1 越好；配色色差、动作峰值时间差越小越好</p>
        ${segs.map(segBlock).join('') || '<p class="muted mt">这一版没有重建对比</p>'}</div>
      <div class="card"><h2>示范镜头</h2><p class="sub">用生成的引擎写的示范镜头，题材和参考视频无关。做片时 Agent 照着它学写法</p>
        ${demos.length ? `<div class="vid-grid mt">${demos.map(d => videoBox(d.url, [d.id, d.title].filter(Boolean).join(' · '))).join('')}</div>` : '<p class="muted mt">这一版没有示范镜头</p>'}</div>
      <div class="card"><h2>冷启动试写</h2><p class="sub">另开一次干净的模型调用，只给说明书，换一个新题材写一个镜头。四项各 5 分，分数低说明说明书没写清楚</p>
        ${trials.map(trialBlock).join('') || '<p class="muted mt">这一版没有试写</p>'}</div>
    </div>
    <div class="grid" style="align-content:start">
      ${checksCard(checks)}
      ${actionCard(s, v, vers)}
    </div></div>`;
}
/** 验证页的操作，按状态给：待验证（意见、驳回、内测发布）、内测中（意见、撤回、公开发布）、已公开（意见、下架，有更新的内测版时公开发布它） */
function actionCard(s, v, vers) {
  const st = s.status, beta = vers.find(x => x.n === s.betaV), multi = vers.length > 1;
  const pub = beta && (st === 'beta' || (st === 'public' && beta.n > (s.publicV || 0)));
  const fb = ['review', 'beta', 'public'].includes(st) || (st === 'failed' && vers.length > 0);
  const btns = [];
  if (st === 'review' || (st === 'failed' && vers.length)) btns.push('<button class="btn danger" data-act="reject">驳回</button>');
  if (st === 'review') btns.push(`<button class="btn primary" data-act="beta">内测发布${multi ? ` v${v.n}` : ''}</button>`);
  if (st === 'beta') btns.push('<button class="btn" data-act="unbeta">撤回内测</button>');
  if (st === 'public') btns.push('<button class="btn danger" data-act="retire">下架</button>');
  if (pub) btns.push(`<button class="btn primary" data-act="publish" ${beta.canPublish ? '' : 'disabled title="这一版至少要有一支做完的测试片"'}>公开发布${multi ? ` v${beta.n}` : ''}</button>`);
  if (!fb && !btns.length) return '';
  const where = isWriting(s) ? '新建视频的写作方法下拉框' : '画风库';
  const hint = { review: isWriting(s) ? '看完原片分镜表、试写和自检，满意就内测发布；不满意写修改意见重新生成，或者驳回。' : '看完对比、示范镜头和自检，满意就内测发布；不满意写修改意见重新生成，或者驳回。',
    beta: `v${s.betaV} 内测中：管理员在用户端的${where}里能看到它。做完一支测试片后可以公开发布。`,
    public: `v${s.publicV} 已公开，所有用户都能用。${pub ? `v${beta.n} 正在内测，确认后可以公开发布，替换 v${s.publicV}。` : ''}`,
    failed: '这一轮生成失败了。可以写修改意见再生成一次，或者驳回。' }[st];
  return `<div class="card"><h2>下一步</h2>${hint ? `<p class="sub">${esc(hint)}</p>` : ''}
    ${fb ? `<label class="field mt"><span>修改意见（交给 Agent，在 v${v.n} 的基础上出下一版${s.pair ? `；只改这份${kn(s)}` : ''}）</span><textarea class="inp" id="st-fb" maxlength="2000" placeholder="${isWriting(s) ? '比如：开场的反问再短一点；每段结尾都要有一句回扣' : '比如：纸色再淡一点；物件下面的名字改成手写标签'}"></textarea></label>
      <div class="ph-actions mt"><button class="btn" data-act="feedback">${icon('refresh')}按意见重新生成</button></div>` : ''}
    ${btns.length ? `<div class="ph-actions st-acts">${btns.join('')}</div>` : ''}
    ${pub && !beta.canPublish ? `<p class="sub mt">公开发布要求 v${beta.n} 至少有一支做完的测试片，在「测试片」里看怎么做。</p>` : ''}</div>`;
}
function testsTab(s, vers, site) {
  site = safeUrl(site);
  const tests = [...(s.tests || [])].sort((a, b) => (b.at || 0) - (a.at || 0)), beta = vers.find(x => x.n === s.betaV);
  const runUrl = id => `${site.replace(/\/+$/, '')}/#/run/${encodeURIComponent(id)}`;
  return `<div class="note">${icon('alert')}<span>${isWriting(s) ? '内测期间，在用户端新建视频时，写作方法下拉框里会出现这个写作方法' : '内测期间，在用户端新建视频时，画风库里会出现这个画风'}（标着"内测"，只有管理员看得到）。用它做一两支测试片，确认效果后再公开发布。</span></div>
  ${beta ? `<p class="mt">${beta.canPublish ? `${badge('b-ok', '可以公开发布')} v${beta.n} 已经有做完的测试片` : `${badge('b-idle', '还不能公开发布')} v${beta.n} 还没有做完的测试片`}</p>` : ''}
  <div class="table-wrap mt"><table class="t"><thead><tr><th>任务标题</th><th>谁做的</th><th class="r">版本</th><th>状态</th><th class="r">用量</th><th>时间</th>${site ? '<th><span class="sr-only">操作</span></th>' : ''}</tr></thead><tbody>
  ${tests.map(t => `<tr><td class="who"><b>${esc(t.title || '—')}</b><small class="mono">${esc(String(t.taskId || '').slice(0, 8))}</small></td>
    <td>${esc(t.email || '—')}</td><td class="r num">${t.v ? `v${esc(t.v)}` : '—'}</td><td>${taskBadge(t.status)}</td>
    <td class="r num">${t.credits != null ? `${cr(t.credits)} Credit` : '—'}</td><td class="muted nowrap">${fmtTime(t.at)}</td>
    ${site ? `<td class="r">${t.taskId ? `<a class="btn sm" href="${esc(runUrl(t.taskId))}" target="_blank" rel="noopener">去用户端看</a>` : ''}</td>` : ''}</tr>`).join('')
    || `<tr><td colspan="${site ? 7 : 6}" class="empty">还没有测试片</td></tr>`}
  </tbody></table></div>
  ${site && tests.length ? '<p class="muted mt">用户端只能打开自己做的任务；别的管理员做的测试片，这里只看得到状态和用量。</p>' : ''}`;
}
function traitsTab(v) {
  const t = v.traits || {}, has = a => Array.isArray(a) && a.length > 0;
  const list = a => `<ul class="dots">${a.map(x => `<li>${esc(x)}</li>`).join('')}</ul>`;
  const rhythm = t.rhythm && typeof t.rhythm === 'object' && !Array.isArray(t.rhythm) ? Object.entries(t.rhythm) : [];
  const rows = [
    t.line && ['一句话定位', esc(t.line)],
    has(t.palette) && ['色板', `<ul class="swatch-list">${t.palette.map(p => `<li><i style="${HEX_RE.test(p.hex) ? `background:${p.hex}` : ''}"></i><span><b class="mono">${esc(p.hex)}</b><small>${esc(p.role || '')}</small></span></li>`).join('')}</ul>`],
    has(t.materials) && ['材质', list(t.materials)],
    has(t.type) && ['字体', `<table class="t mini"><thead><tr><th>用在</th><th>字体</th><th class="r">字重</th><th>字号</th></tr></thead><tbody>
      ${t.type.map(x => `<tr><td>${esc(x.use)}</td><td>${esc(x.font)}</td><td class="r num">${esc(x.weight ?? '—')}</td><td class="num">${esc(x.size ?? '—')}</td></tr>`).join('')}</tbody></table>`],
    has(t.motion) && ['动作', list(t.motion)],
    has(t.grammar) && ['镜头语法', list(t.grammar)],
    has(t.rhythm) ? ['节奏', list(t.rhythm)] : rhythm.length ? ['节奏', `<dl class="kv">${rhythm.map(([k, x]) => `<dt>${esc(k)}</dt><dd class="num">${esc(x)}</dd>`).join('')}</dl>`]
      : typeof t.rhythm === 'string' && t.rhythm && ['节奏', esc(t.rhythm)],
    has(t.not) && ['不是什么', list(t.not)],
  ].filter(Boolean);
  if (!rows.length && !has(t.excluded) && !has(t.extrapolated)) return '<div class="card empty">这一版没有画风要素</div>';
  return traitsLayout('画风要素', 'Agent 从参考视频里量出来、看出来的，已经写进说明书。不对的地方写进修改意见，重新生成', rows, t, '这些只用来看，不进说明书和示范镜头');
}
function traitsLayout(title, sub, rows, t, exNote) {
  const has = a => Array.isArray(a) && a.length > 0, list = a => `<ul class="dots">${a.map(x => `<li>${esc(x)}</li>`).join('')}</ul>`;
  return `<div class="grid g-main">
    <div class="card"><h2>${title}</h2><p class="sub">${sub}</p>
      <dl class="trait-list mt">${rows.map(([k, h]) => `<dt>${k}</dt><dd>${h}</dd>`).join('')}</dl></div>
    <div class="grid" style="align-content:start">
      ${has(t.extrapolated) ? `<div class="card confirm"><h2>${icon('alert')}需要你确认</h2><p class="sub">参考视频里没有、Agent 推断出来的规则。确认合适再发布；不合适写进修改意见</p>${list(t.extrapolated)}</div>` : ''}
      <div class="card"><h2>没有带进 Skill 的参考内容</h2><p class="sub">${exNote}</p>${has(t.excluded) ? list(t.excluded) : '<p class="muted mt">没有记录</p>'}</div>
    </div></div>`;
}
/** 写作方法的 traits.json：一句话定位、分组、最有辨识度的点、结构、节奏、口吻、适合的题材 */
function writingTraitsTab(v) {
  const t = v.traits || {}, has = a => Array.isArray(a) && a.length > 0;
  const list = a => `<ul class="dots">${a.map(x => `<li>${esc(x)}</li>`).join('')}</ul>`;
  const rhythm = t.rhythm && typeof t.rhythm === 'object' && !Array.isArray(t.rhythm) ? Object.entries(t.rhythm) : [];
  const rows = [
    t.line && ['一句话定位', esc(t.line)],
    t.group && ['属于', `${esc(t.group)}类`],
    has(t.highlights) && ['辨识度', list(t.highlights)],
    has(t.structure) && ['结构', list(t.structure)],
    rhythm.length ? ['节奏', `<dl class="kv">${rhythm.map(([k, x]) => `<dt>${esc(k)}</dt><dd>${esc(x)}</dd>`).join('')}</dl>`] : typeof t.rhythm === 'string' && t.rhythm && ['节奏', esc(t.rhythm)],
    t.voice && ['旁白口吻', esc(t.voice)],
    t.example && ['适合的题材', esc(t.example)],
  ].filter(Boolean);
  if (!rows.length && !has(t.excluded) && !has(t.extrapolated)) return '<div class="card empty">这一版没有写作方法要素</div>';
  return traitsLayout('写作方法要素', 'Agent 听旁白、拆分镜后提炼出来的，已经写进说明书。不对的地方写进修改意见，重新生成', rows, t, '原片的文案、品牌、产品和人名不进说明书；举例的句子是 Agent 自己写的');
}
function filesTab(s, v) {
  const files = [...(v.files || []), ...(v.reviewFiles || [])];
  if (!files.length) return '<div class="card empty">这一版没有文件</div>';
  const cur = files.includes(stFile) ? stFile : files[0];
  return `<div class="card"><div class="card-head"><div><h2>v${v.n} 的文件</h2><p class="sub">${isWriting(s) ? '说明书、要素和自检报告；review/ 下是验证材料（听旁白的结果、原片分镜表、试写），不进 Skill' : '说明书、引擎、示范镜头和自检报告'}。点左边的文件名看内容</p></div></div>
    <div class="files"><ul>${files.map(f => `<li><button data-file="${esc(f)}" aria-current="${f === cur}">${icon('file')}<span>${esc(f)}</span></button></li>`).join('')}</ul>
      <pre id="file-view" tabindex="0">加载中…</pre></div></div>`;
}
const fileCache = new Map(); // 同一版发布后不再改，看过的文件不用再取
async function showFile(id, v, path) {
  const pre = $('#file-view'), key = `${id}|${v}|${path}`;
  if (!pre) return;
  stFile = path; showFile.want = key;
  $$('[data-file]').forEach(b => b.setAttribute('aria-current', String(b.dataset.file === path)));
  const put = text => { if (showFile.want === key && document.body.contains(pre)) { pre.textContent = text; pre.scrollTop = 0; } };
  pre.textContent = '加载中…';
  try {
    const text = await getFile(id, v, path);
    let pretty = text;
    if (path.endsWith('.json')) try { pretty = JSON.stringify(JSON.parse(text), null, 2); } catch { /* 不是合法 JSON 就原样显示 */ }
    put(pretty);
  } catch (e) { put(e.message); }
}
async function getFile(id, v, path) {
  const key = `${id}|${v}|${path}`;
  if (!fileCache.has(key)) {
    const r = await api('GET', `/styles/${encodeURIComponent(id)}/file?v=${encodeURIComponent(v)}&path=${encodeURIComponent(path)}`);
    fileCache.set(key, String(r.text ?? ''));
  }
  return fileCache.get(key);
}
/** 写作方法的验证页：原片分镜表进页面就取，试写的剧本点了再取 */
async function loadJson(id, v, path, el, view) {
  try { el.innerHTML = view(JSON.parse(await getFile(id, v, path))); } catch (e) { el.textContent = e instanceof SyntaxError ? '文件格式不对' : e.message; }
}
function historyTab(s, vers) {
  return `<div class="table-wrap"><table class="t"><thead><tr><th>版本</th><th>时间</th><th>一句话定位</th><th>来自哪条修改意见</th><th>状态</th><th class="r">自动检查</th></tr></thead><tbody>
  ${[...vers].reverse().map(v => { const fb = textOf(v.feedback), ck = v.checks || [];
    return `<tr class="link" data-ver="${v.n}"><td><b>v${v.n}</b></td><td class="muted nowrap">${fmtTime(v.at)}</td><td>${esc(v.summary || '—')}</td>
      <td>${fb ? esc(fb) : `<span class="muted">${v === vers[0] ? '首次生成' : '—'}</span>`}</td>
      <td>${v.n === s.publicV ? badge('b-ok', '已公开') : v.n === s.betaV ? badge('b-info', '内测中') : ''}</td>
      <td class="r num">${ck.length ? `${ck.filter(c => c.ok).length} / ${ck.length}` : '—'}</td></tr>`; }).join('')}
  </tbody></table></div><p class="muted mt">点一行，去看这一版的验证材料。</p>`;
}
/** 生成中：每 10 秒取一次详情。状态、版本有变化就整页重画，否则只更新"生成过程"，不打断正在看的视频 */
async function pollStyle(id, my) {
  const n = await api('GET', `/styles/${encodeURIComponent(id)}`).catch(() => null);
  if (my !== stPoll.seq || !isLoggedIn()) return; // 已经离开这个页面，或者页面重画过（重画时会重新开始）
  const o = pageStyle.cur, key = x => JSON.stringify([x.status, x.task?.status, x.task?.stale, (x.versions || []).length, x.betaV, x.publicV]);
  if (n && key(n) !== key(o)) {
    if ((n.versions || []).length > (o.versions || []).length) { toast(`「${n.name}」的新版本生成好了，可以验证了`); if (stTab === 'progress') { stTab = 'review'; stV = null; } }
    else if (n.task?.status === 'failed') toast(`「${n.name}」生成失败了，看看 Agent 的消息`);
    return render();
  }
  if (n) { pageStyle.cur = n; if (stTab === 'progress' && $('#st-body')) $('#st-body').innerHTML = progressTab(n); }
  stPoll.timer = setTimeout(() => pollStyle(id, my), 10000);
}
function bindStyle(id) {
  const s = pageStyle.cur, v = pageStyle.v, post = (act, body) => api('POST', `/styles/${encodeURIComponent(s.id)}/${act}`, body);
  const done = (msg, tab) => { toast(msg); if (tab) stTab = tab; render(); };
  const ask = (title, text, ok, okCls, run) => modal(`<h3>${esc(title)}</h3><p>${esc(text)}</p>
    <div class="actions"><button class="btn" data-close>取消</button><button class="btn ${okCls}" data-ok>${esc(ok)}</button></div>`, run);
  $$('[data-tab]').forEach(b => b.addEventListener('click', () => { stTab = b.dataset.tab; render(); }));
  $$('[data-ver-pick]').forEach(b => b.addEventListener('click', () => { stV = +b.dataset.verPick; render(); }));
  $$('tr[data-ver]').forEach(tr => tr.addEventListener('click', () => { stV = +tr.dataset.ver; stTab = 'review'; render(); }));
  $$('[data-file]').forEach(b => b.addEventListener('click', () => showFile(s.id, v.n, b.dataset.file)));
  if ($('[data-file]')) showFile(s.id, v.n, $('[data-file][aria-current=true]').dataset.file);
  if ($('#bd-view')) loadJson(s.id, v.n, 'review/breakdown.json', $('#bd-view'), breakdownTable);
  $$('[data-trial]').forEach(b => b.addEventListener('click', () => {
    const box = $(`[data-trial-view="${b.dataset.trial}"]`);
    box.hidden = !box.hidden;
    b.textContent = box.hidden ? '看试写的剧本' : '收起剧本';
    if (!box.hidden && !box.dataset.done) { box.dataset.done = '1'; box.textContent = '加载中…'; loadJson(s.id, v.n, b.dataset.trial, box, trialTable); }
  }));
  $('[data-act=feedback]')?.addEventListener('click', async e => {
    const b = e.currentTarget, text = $('#st-fb').value.trim();
    if (!text) { toast('先写修改意见'); $('#st-fb').focus(); return; }
    b.disabled = true;
    try { await post('feedback', { v: v.n, text }); done('已提交修改意见，开始生成下一版', 'progress'); }
    catch (err) { toast(err.message); b.disabled = false; }
  });
  $('[data-act=retry]')?.addEventListener('click', async e => {
    const b = e.currentTarget;
    b.disabled = true;
    try { await post('retry'); done('已重新开始生成', 'progress'); }
    catch (err) { toast(err.message); b.disabled = false; }
  });
  $('[data-act=reject]')?.addEventListener('click', () => modal(`<h3>驳回 · ${esc(s.name)}</h3>
    <p>驳回后状态变成「已驳回」，不会出现在用户端。${s.pair ? `只驳回这份${kn(s)}，另一种不受影响。` : ''}</p>
    <label class="field"><span>原因（必填，记进操作日志）</span><textarea class="inp" id="rj-reason" maxlength="500" placeholder="比如：画面和参考视频里的角色太像，有照搬的风险"></textarea></label>
    <div class="actions"><button class="btn" data-close>取消</button><button class="btn danger" data-ok>驳回</button></div>`, async () => {
    const reason = $('#rj-reason').value.trim();
    if (!reason) throw new Error('请填写驳回原因');
    await post('reject', { reason }); done('已驳回');
  }));
  $('[data-act=beta]')?.addEventListener('click', () => ask(`内测发布 · ${s.name} v${v.n}`,
    `发布后只有管理员能在用户端的${isWriting(s) ? '写作方法下拉框' : '画风库'}里看到和使用（标着"内测"）。用它做一两支测试片，确认效果后再公开发布。`, '内测发布', 'primary',
    async () => { await post('beta', { v: v.n }); done(`已内测发布 v${v.n}，去用户端用它做一两支测试片`, 'tests'); }));
  $('[data-act=unbeta]')?.addEventListener('click', () => ask(`撤回内测 · ${s.name}`,
    `撤回后，用户端不再出现这个${kn(s)}。已经做好的测试片不受影响。`, '撤回内测', 'primary',
    async () => { await post('unbeta'); done('已撤回内测'); }));
  $('[data-act=publish]')?.addEventListener('click', () => { const n = s.betaV; ask(`公开发布 · ${s.name} v${n}`,
    `发布后所有用户都能在${isWriting(s) ? '写作方法下拉框' : '画风库'}里看到和使用它。${s.publicV ? `现在公开的 v${s.publicV} 会被替换，已经用 v${s.publicV} 做的任务照常用原来那一版。` : ''}`, '公开发布', 'primary',
    async () => { await post('publish', { v: n }); done(`已公开发布 v${n}`); }); });
  $('[data-act=retire]')?.addEventListener('click', () => ask(`下架 · ${s.name}`,
    `下架后用户端不再出现这个${kn(s)}，已经用过它的任务照常能改和重渲。`, '下架', 'danger',
    async () => { await post('retire'); done('已下架'); }));
  if (genGoing(s.task)) { const my = stPoll.seq; stPoll.timer = setTimeout(() => pollStyle(id, my), 10000); }
}

// ---------------------------------------------------------------- 模型与密钥
// 模型都用部署账号的 IAM 角色调用（docs/model-keys-design.md），平台不存模型的 Key；只有 MiniMax 配音有 Key
const testLine = t => t ? `<span class="test-line ${t.ok ? 'ok' : 'bad'}">${t.ok ? '连通正常' : '连通失败'} · ${t.ms} 毫秒 · ${ago(t.at)}${t.msg ? `：${esc(t.msg)}` : ''}</span>` : '<span class="muted test-line">还没测试过</span>';
async function pageKeys() {
  const m = pageKeys.cur = await api('GET', '/models');
  const src = m.source || {};
  return `
  <div class="ph"><div class="grow"><h1>模型与密钥</h1><p>模型都用本账号的 IAM 角色调用，平台不存模型的 Key；只有 MiniMax 配音要填 Key，存在 Secrets Manager，保存后只显示首尾几位${m.updatedAt ? ` · 最近修改：${esc(m.updatedBy || '')} ${ago(m.updatedAt)}` : ''}</p></div></div>
  <div class="grid g-main">
    <div class="card"><div class="card-head"><div><h2>模型来源</h2><p class="sub">整个平台只有一个模型来源，所有用到模型的地方都走它</p></div>${badge('b-ok', src.name || '本账号 IAM 角色')}</div>
      <table class="t"><thead><tr><th>用途</th><th>模型</th><th>来源</th></tr></thead><tbody>
        ${m.routes.map(r => `<tr><td>${esc(r.use)}</td><td>${esc(r.model)}${r.alt?.length ? `<div class="muted small">被内容安全策略拦下时换：${r.alt.map(esc).join(' → ')}</div>` : ''}${r.fallback ? `<div class="muted small">调不通时改用：${esc(r.fallback)}</div>` : ''}</td><td><b>${esc(r.source)}</b></td></tr>`).join('')}
      </tbody></table>
      <div class="note mt">${icon('lock')}<span>调用模型的权限单独放在 IAM 托管策略${src.policy ? `「<span class="mono">${esc(src.policy)}</span>」` : ''}里，挂在 Agent 的执行角色和 llm Lambda 上，和调用其他 AWS 服务的权限分开。想换模型调用的权限，改这一个策略就行。</span></div>
      <p class="muted mt">部署到不能用 Bedrock 的账号时，模型改走 OpenAI 兼容接口（客户自己的代理平台），经平台的模型网关调用。这个还没做，见设计文档。</p></div>
    <div class="grid" style="align-content:start">
      <div class="card key-card"><div class="card-head" style="margin:0"><div><h2>MiniMax 中国区</h2><p class="sub">配音（语音合成）</p></div>${m.minimax.configured ? badge('b-ok', '已配置') : badge('b-idle', '未配置')}</div>
        ${m.minimax.configured ? `<div class="key-line"><span class="key-mask">${esc(m.minimax.mask)}</span><span class="muted">https://api.minimax.cn</span></div>` : '<p class="muted">没有配置时，配音用 Amazon Polly。</p>'}
        <div class="key-line">${testLine(m.minimax.test)}</div>
        <div class="ph-actions">${m.minimax.configured ? '<button class="btn sm" data-test="minimax">测试连通</button>' : ''}<button class="btn sm" data-key="minimax">${m.minimax.configured ? '更换 Key' : '填写 Key'}</button></div></div>
    </div>
  </div>`;
}
function bindKeys() {
  $$('[data-test]').forEach(b => b.addEventListener('click', async () => {
    b.disabled = true; b.textContent = '测试中…';
    try { const r = await api('POST', '/models/test', { source: 'minimax' }); toast(r.ok ? `连通正常（${r.ms} 毫秒）` : `连通失败：${r.msg}`); render(); }
    catch (e) { toast(e.message); b.disabled = false; b.textContent = '测试连通'; }
  }));
  $$('[data-key]').forEach(b => b.addEventListener('click', () => {
    modal(`<h3>MiniMax 中国区</h3><label class="field"><span>API Key</span><input class="inp mono" id="k-val" type="password" autocomplete="off" placeholder="粘贴 Key"><small>保存后存进 Secrets Manager，只显示首尾几位；只有配音 Lambda 读得到</small></label>
      <p class="test-line" id="k-test"></p>
      <div class="actions"><button class="btn" data-close>取消</button><button class="btn" id="k-try">先测试连通</button><button class="btn primary" data-ok>保存</button></div>`, async () => {
      await api('PUT', '/models/minimax', { apiKey: $('#k-val').value }); toast('已保存'); render(); });
    $('#k-try').addEventListener('click', async () => { const el = $('#k-test'); el.textContent = '测试中…'; el.className = 'test-line muted';
      try { const r = await api('POST', '/models/test', { source: 'minimax', apiKey: $('#k-val').value }); el.className = `test-line ${r.ok ? 'ok' : 'bad'}`; el.textContent = `${r.ok ? '连通正常' : '连通失败'} · ${r.ms} 毫秒：${r.msg}`; }
      catch (e) { el.className = 'test-line bad'; el.textContent = e.message; } });
  }));
}

// ---------------------------------------------------------------- 用量（全部用户）
let auRange = newRange();
function pageUsage() {
  return `
  <div class="ph"><div class="grow"><h1>用量</h1><p>全部用户的 Credit 用量，按北京时间统计；用量大约 1 分钟后入账</p></div></div>
  <div class="toolbar" id="au-range">${rangeBar(auRange)}</div>
  <div class="range-body" id="au-body"><div class="card loading">加载中…</div></div>`;
}
async function loadUsageAll() {
  const box = $('#au-body');
  if (!box) return;
  const my = loadUsageAll.seq = (loadUsageAll.seq || 0) + 1, st = { ...auRange };
  box.classList.add('is-loading');
  try {
    const r = await api('GET', `/usage?from=${st.from}&to=${st.to}`);
    if (my !== loadUsageAll.seq || !document.body.contains(box)) return;
    const from = r.from || st.from, to = r.to || st.to, n = daysBetween(from, to) + 1;
    const users = (r.users || []).filter(x => x.credits > 0), activeDays = (r.days || []).filter(d => d.credits > 0).length, total = Number(r.total) || 0;
    box.innerHTML = `
      <div class="grid g3">
        ${kpi('合计', `${cr(total)}<small>Credit</small>`, `${dayLabel(from)}到${dayLabel(to)}，共 ${n} 天`)}
        ${kpi('有用量的用户', `${users.length}<small>个</small>`, users[0] ? `最多：${esc(users[0].email || users[0].sub)}` : '这段时间没有用量')}
        ${kpi('日均', `${cr(total / n)}<small>Credit</small>`, `有用量的有 ${activeDays} 天`)}
      </div>
      <div class="card mt"><div class="card-head"><div><h2>每日用量</h2><p class="sub">全部用户合计，单位 Credit；今天还没结束，颜色浅一些</p></div></div><div class="dc-host"></div></div>
      <div class="card mt"><div class="card-head"><div><h2>用户排行</h2><p class="sub">按 Credit 从高到低；点一行看这个用户的详情</p></div></div>
        <div class="scroll-x"><table class="t"><thead><tr><th class="r">#</th><th>用户</th><th class="r">Credit</th><th class="r">占合计</th></tr></thead><tbody>
        ${users.map((x, i) => { const p = total > 0 ? x.credits / total : 0; return `<tr class="link" data-href="#user/${esc(x.sub)}"><td class="r num muted">${i + 1}</td>
          <td><a href="#user/${esc(x.sub)}">${esc(x.email || x.sub)}</a></td><td class="r num">${cr(x.credits)}</td>
          <td class="r"><div class="bar-cell"><span class="num muted">${(p * 100).toFixed(1)}%</span><span class="mini"><i style="width:${p * 100}%"></i></span></div></td></tr>`; }).join('') || '<tr><td colspan="4" class="empty">这段时间没有用量</td></tr>'}
        </tbody></table></div></div>`;
    dayCard($('.dc-host', box), from, to, r.days);
    $$('tr[data-href]', box).forEach(tr => tr.addEventListener('click', e => { if (!e.target.closest('a')) location.hash = tr.dataset.href; }));
  } catch (e) {
    if (my !== loadUsageAll.seq || !document.body.contains(box) || e.status === 401) return;
    box.innerHTML = `<div class="card empty">${esc(e.message)} <button class="btn sm" data-au-retry>重试</button></div>`;
    $('[data-au-retry]', box).addEventListener('click', loadUsageAll);
  } finally {
    if (my === loadUsageAll.seq) box.classList.remove('is-loading');
  }
}
function bindUsage() { bindRange($('#au-range'), auRange, loadUsageAll); loadUsageAll(); }

// ---------------------------------------------------------------- 计费设置（PUT /billing）
const PRICE_COLS = [['input', '输入'], ['cacheRead', '缓存读'], ['cacheWrite', '缓存写'], ['output', '输出']];
function priceRow(id, m = {}, isNew = false) {
  const name = m.name || id || '新模型';
  return `<tr data-id="${esc(id)}"${isNew ? ' data-new' : ''}>
    <td><div class="price-model">${isNew ? '<input class="inp mono" data-k="id" placeholder="模型 ID，例如 global.anthropic.…" aria-label="模型 ID">' : `<div class="mono">${esc(id)}</div>`}
      <input class="inp" data-k="name" value="${esc(m.name || '')}" placeholder="显示名称" aria-label="${esc(name)} 的显示名称"></div></td>
    ${PRICE_COLS.map(([k, t]) => `<td class="r"><input class="inp num" type="number" min="0" step="0.01" data-k="${k}" value="${esc(m[k] ?? '')}" aria-label="${esc(name)} 的${t}单价"></td>`).join('')}
    <td>${isNew ? `<button class="btn sm ghost danger" data-del-model aria-label="不添加这个模型">${icon('x')}</button>` : ''}</td></tr>`;
}
async function pageBilling() {
  const b = pageBilling.cur = await api('GET', '/billing');
  return `
  <div class="ph"><div class="grow"><h1>计费设置</h1><p>Credit 换算比例、默认月额度和各模型单价。当前是第 ${esc(b.version ?? '—')} 版${b.updatedAt ? ` · 最近修改：${esc(b.updatedBy || '')} ${ago(b.updatedAt)}（${fmtTime(b.updatedAt)}）` : ''}</p></div>
    <div class="ph-actions"><button class="btn" data-act="reset-billing">放弃改动</button><button class="btn primary" data-act="save-billing">保存</button></div></div>
  <div class="note warn">${icon('alert')}<span>改价只影响保存之后新产生的用量。已经记下的每一条明细都按当时的价格算好了（记着当时的价格版本），不会重算；要补偿已经发生的用量，请在用户详情里对任务做"调整"。</span></div>
  <div class="grid g2 mt">
    <div class="card"><h2>换算和额度</h2>
      <div class="rate-box mt"><label for="b-ratio">1 美元 =</label><input class="inp num" id="b-ratio" type="number" min="0" step="0.01" value="${esc(b.ratio)}"><span>Credit</span></div>
      <p class="sub mt">每次调用按"美元成本 × 比例"折成 Credit。比例里高出成本的部分，覆盖会话容器、渲染机开机和空闲、Lambda 这些不单独计费的开销。</p>
      <div class="form-grid mt">
        <label class="field"><span>默认月额度</span><input class="inp num" id="b-monthly" type="number" min="0" step="1" value="${esc(b.defaultMonthly)}"><small>Credit。没有单独设置额度的用户都用这个</small></label>
        <label class="field"><span>美元兑人民币</span><input class="inp num" id="b-cny" type="number" min="0" step="0.01" value="${esc(b.fx?.CNY)}"><small>1 美元 = 多少人民币；配音价格用它折成美元</small></label>
      </div></div>
    <div class="card"><h2>配音</h2><p class="sub">按模型服务返回的计费字数计价</p>
      <div class="form-grid mt"><label class="field"><span>单价</span><input class="inp num" id="b-voice" type="number" min="0" step="0.01" value="${esc(b.voice?.per10kChars)}"><small>${b.voice?.currency === 'USD' ? '美元' : '人民币'} / 万字符</small></label></div></div>
  </div>
  <div class="card mt"><h2>渲染机单价</h2><p class="sub">美元 / 小时，按每次渲染、自检实际占用渲染机的秒数计价（开机和空闲不算）。默认值是 EC2 按需价加 7.8% 的 AgentCore 管理费</p>
    <div class="scroll-x"><table class="t price-table"><thead><tr><th>机型</th><th class="r">单价</th></tr></thead>
    <tbody id="render-rows">${Object.entries(b.render || {}).map(([id, m]) => `<tr data-id="${esc(id)}"><td><div class="price-model"><div class="mono">${esc(id)}</div>
      <input class="inp" data-k="name" value="${esc(m.name || '')}" placeholder="显示名称" aria-label="${esc(id)} 的显示名称"></div></td>
      <td class="r"><input class="inp num" type="number" min="0" step="0.001" data-k="perHour" value="${esc(m.perHour ?? '')}" aria-label="${esc(id)} 每小时单价"></td></tr>`).join('')}</tbody></table></div></div>
  <div class="card mt"><div class="card-head"><div><h2>模型单价</h2><p class="sub">美元 / 百万 token。没有登记的模型按表里最贵的价格记，看到后在这里补上价格</p></div><button class="btn sm" data-act="add-model">${icon('plus')}添加模型</button></div>
    <div class="scroll-x"><table class="t price-table"><thead><tr><th>模型</th>${PRICE_COLS.map(([, t]) => `<th class="r">${t}</th>`).join('')}<th><span class="sr-only">操作</span></th></tr></thead>
    <tbody id="price-rows">${Object.entries(b.models || {}).map(([id, m]) => priceRow(id, m)).join('')}</tbody></table></div></div>
`;
}
/** 读表单，校验后返回 PUT /billing 的请求体；不对时抛错（e.el 是出错的输入框） */
function readBilling(b) {
  const bad = (msg, el) => Object.assign(new Error(msg), { el });
  const num = (sel, label, positive = false) => {
    const el = $(sel), raw = el.value.trim(), v = Number(raw);
    if (!raw || !Number.isFinite(v) || v < 0 || (positive && v === 0)) throw bad(`${label}要填一个${positive ? '大于 0' : '不小于 0'}的数`, el);
    return v;
  };
  const models = {};
  for (const tr of $$('#price-rows tr')) {
    const idEl = $('[data-k=id]', tr), id = (idEl ? idEl.value : tr.dataset.id).trim();
    if (!id) throw bad('新增的模型要填模型 ID（和 Bedrock 调用日志里的 modelId 一致）', idEl);
    if (models[id]) throw bad(`模型 ${id} 重复了`, idEl);
    const m = { ...(b.models?.[id] || {}), name: $('[data-k=name]', tr).value.trim() || id };
    for (const [k, t] of PRICE_COLS) {
      const el = $(`[data-k=${k}]`, tr), raw = el.value.trim(), v = Number(raw);
      if (!raw || !Number.isFinite(v) || v < 0) throw bad(`${m.name} 的${t}单价要填一个不小于 0 的数`, el);
      m[k] = v;
    }
    models[id] = m;
  }
  const render = {};
  for (const tr of $$('#render-rows tr')) {
    const id = tr.dataset.id, el = $('[data-k=perHour]', tr), raw = el.value.trim(), v = Number(raw);
    if (!raw || !Number.isFinite(v) || v < 0) throw bad(`${id} 的单价要填一个不小于 0 的数`, el);
    render[id] = { ...(b.render?.[id] || {}), name: $('[data-k=name]', tr).value.trim() || id, perHour: v };
  }
  return {
    version: b.version, ratio: num('#b-ratio', '换算比例', true), defaultMonthly: num('#b-monthly', '默认月额度'),
    fx: { ...(b.fx || {}), CNY: num('#b-cny', '汇率', true) }, voice: { ...(b.voice || {}), per10kChars: num('#b-voice', '配音单价') }, models, render,
  };
}
/** 改了哪些：保存前给管理员确认 */
function billingDiff(a, b) {
  const out = [], v = x => (x == null || x === '' ? '—' : String(x)), am = a.models || {};
  if (+a.ratio !== b.ratio) out.push(`换算比例：1 美元 = ${v(a.ratio)} → ${b.ratio} Credit`);
  if (+a.defaultMonthly !== b.defaultMonthly) out.push(`默认月额度：${v(a.defaultMonthly)} → ${b.defaultMonthly} Credit`);
  if (+a.fx?.CNY !== b.fx.CNY) out.push(`美元兑人民币：${v(a.fx?.CNY)} → ${b.fx.CNY}`);
  if (+a.voice?.per10kChars !== b.voice.per10kChars) out.push(`配音单价：${v(a.voice?.per10kChars)} → ${b.voice.per10kChars} / 万字符`);
  for (const [id, m] of Object.entries(b.render || {})) {
    const o = (a.render || {})[id] || {};
    if (+o.perHour !== m.perHour) out.push(`渲染机 ${m.name}：${v(o.perHour)} → ${m.perHour} 美元 / 小时`);
    if ((o.name || id) !== m.name) out.push(`${id} 的名称：${v(o.name)} → ${m.name}`);
  }
  for (const [id, m] of Object.entries(b.models)) {
    const o = am[id];
    if (!o) { out.push(`新增模型 ${m.name}（${id}）：${PRICE_COLS.map(([k, t]) => `${t} ${m[k]}`).join('，')}`); continue; }
    if ((o.name || id) !== m.name) out.push(`${id} 的名称：${v(o.name)} → ${m.name}`);
    for (const [k, t] of PRICE_COLS) if (+o[k] !== m[k]) out.push(`${m.name} ${t}：${v(o[k])} → ${m[k]}`);
  }
  return out;
}
function bindBilling() {
  const b = pageBilling.cur;
  $('[data-act=add-model]').addEventListener('click', () => {
    $('#price-rows').insertAdjacentHTML('beforeend', priceRow('', {}, true));
    $('#price-rows tr:last-child [data-k=id]').focus();
  });
  $('#price-rows').addEventListener('click', e => { const x = e.target.closest('[data-del-model]'); if (x) x.closest('tr').remove(); });
  $('[data-act=reset-billing]').addEventListener('click', () => render());
  $('[data-act=save-billing]').addEventListener('click', () => {
    let next;
    try { next = readBilling(b); } catch (e) { toast(e.message); e.el?.focus(); return; }
    const changes = billingDiff(b, next);
    if (!changes.length) { toast('没有改动'); return; }
    modal(`<h3>保存计费设置</h3><p>保存后，新产生的用量按新的设置计算；已经记下的明细不重算。改动会记进操作日志。</p>
      <ul class="change-list">${changes.map(c => `<li>${esc(c)}</li>`).join('')}</ul>
      <div class="actions"><button class="btn" data-close>取消</button><button class="btn primary" data-ok>确认保存</button></div>`, async () => {
      await api('PUT', '/billing', next);
      toast('已保存，新的设置从现在开始生效');
      render();
    });
  });
}

// ---------------------------------------------------------------- 操作日志
async function pageAudit() {
  const { items } = await api('GET', '/audit');
  return `
  <div class="ph"><div class="grow"><h1>操作日志</h1><p>管理员的修改，以及系统自动做的切换。保留 3 年，不能删除</p></div></div>
  <div class="table-wrap"><table class="t"><thead><tr><th>时间</th><th>操作人</th><th>操作</th><th>对象</th><th>详情</th></tr></thead><tbody>
    ${items.map(a => `<tr><td class="muted">${fmtTime(a.at)}</td><td>${esc(a.who)}</td><td><b>${esc(a.act)}</b></td><td>${esc(a.obj)}</td><td class="muted">${esc(a.detail)}</td></tr>`).join('') || '<tr><td colspan="5" class="empty">还没有记录</td></tr>'}
  </tbody></table></div>`;
}

// ---------------------------------------------------------------- 路由
const PAGES = {
  users: { title: '用户', html: pageUsers, bind: bindUsers },
  user: { title: '用户详情', parent: ['用户', '#users'], html: pageUser, bind: bindUser },
  styles: { title: 'Skill 创建', html: pageStyles, bind: bindStyles },
  'style-new': { title: '新建 Skill', parent: ['Skill 创建', '#styles'], html: pageStyleNew, bind: bindStyleNew },
  style: { title: 'Skill 详情', parent: ['Skill 创建', '#styles'], html: pageStyle, bind: bindStyle },
  usage:{ title: '用量', html: pageUsage, bind: bindUsage },
  keys: { title: '模型与密钥', html: pageKeys, bind: bindKeys },
  billing: { title: '计费设置', html: pageBilling, bind: bindBilling },
  audit: { title: '操作日志', html: pageAudit },
};
let lastRoute = '', seq = 0;
function bindRows() { $$('#page tr[data-href]').forEach(tr => tr.addEventListener('click', () => (location.hash = tr.dataset.href))); }
async function render() {
  if (!isLoggedIn()) return showLogin();
  const [name, arg] = (location.hash.replace(/^#\/?/, '') || 'users').split('/'); // #styles 和 #/styles 都认
  const route = name in PAGES ? name : 'users', p = PAGES[route];
  stopStylePoll(); // 风格详情的自动刷新：换页面、重画都先停，详情页绑定时按需再开
  if (`${route}/${arg}` !== lastRoute) {
    if (route === 'user') { uTab = 'overview'; uuRange = newRange(); }
    if (route === 'style') stTab = stV = stFile = null;
    lastRoute = `${route}/${arg}`;
  }
  $$('.side-item').forEach(a => { if (a.dataset.route.split(' ').includes(route)) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
  $('#crumbs').innerHTML = p.parent ? `<a href="${p.parent[1]}">${p.parent[0]}</a><span>/</span><b>${esc(p.title)}</b>` : `<b>${p.title}</b>`;
  document.title = `${p.title} · Slate 管理端`;
  const my = ++seq;
  if (!$('#page').innerHTML) $('#page').innerHTML = '<div class="loading">加载中…</div>';
  try {
    const html = await p.html(arg);
    if (my !== seq) return;
    $('#page').innerHTML = html;
    p.bind?.(arg); bindRows();
    if (route === 'user' && pageUser.cur) $('#crumbs b').textContent = pageUser.cur.name || pageUser.cur.email;
    if (route === 'style' && pageStyle.cur) $('#crumbs b').textContent = pageStyle.cur.name;
  } catch (e) {
    if (my !== seq) return;
    if (e.status === 403) { logout(); return showLogin(e.message); }
    if (e.status !== 401) {
      $('#page').innerHTML = `<div class="card empty">${esc(e.message)} <button class="btn sm" id="retry">重试</button></div>`;
      $('#retry').addEventListener('click', render);
    }
  }
}

// ---------------------------------------------------------------- 登录
function showLogin(msg) {
  $('#shell').hidden = true; $('#login').hidden = false; $('#login-form').hidden = false; $('#newpw-form').hidden = true;
  const err = $('#login-err'); err.hidden = !msg; err.textContent = msg || '';
}
function showApp() { $('#login').hidden = true; $('#shell').hidden = false; $('#me-email').textContent = sessionEmail(); render(); }
$('#login-form').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target, btn = $('button', f), err = $('#login-err'); btn.disabled = true; err.hidden = true;
  try {
    const r = await login(f.email.value.trim(), f.password.value);
    if (r.challenge) { $('#login-form').hidden = true; $('#newpw-form').hidden = false; $('#newpw-form input').focus(); }
    else showApp();
  } catch (ex) { err.textContent = ex instanceof AuthError ? ex.message : '登录失败，请重试'; err.hidden = false; }
  finally { btn.disabled = false; }
});
$('#newpw-form').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target, btn = $('button', f), err = $('#newpw-err'); btn.disabled = true; err.hidden = true;
  try { await completeNewPassword(f.pw.value); showApp(); }
  catch (ex) { err.textContent = ex.message; err.hidden = false; }
  finally { btn.disabled = false; }
});
$('#logout').addEventListener('click', () => { logout(); showLogin(); });
window.addEventListener('hashchange', render);
await loadConfig().catch(() => null);
if (isLoggedIn()) showApp(); else showLogin();
