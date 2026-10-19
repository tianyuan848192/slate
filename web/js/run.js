/* 生成页 #run/<id>：轮询任务详情，展示步骤（含资料整理和剧本核对）、你的设置、播放器、分镜条、修改对话、分镜脚本、成片下载和 Credit 用量。
   3D 图片任务（product 为 model3d）换成另一套中间区域：可以拖动旋转、拆开的 3D 预览，多角度图，拆解图和 GIF 动图，素材卡；
   没有分镜脚本，也没有视频（转台视频已经去掉，老版本里的 turntable 字段不再显示）。顶部可以导出 3D 打印文件 */

import { $, $$, esc, toast, mmss, mss, durLabel, dateTime, safeUrl, hostOf, keyOf } from './util.js';
import { api } from './api.js';
import { fmt, openUsage, refresh as refreshCredits } from './credits.js';
import { mountViewer, angleLabel } from './viewer3d.js';
import { assetHtml, editLibItem } from './library.js';
import { openPrint, closePrint } from './printdlg.js';

const ACTIVE = new Set(['queued', 'running', 'awaiting_confirmation']); // 这些状态下每 2 秒轮询
const POLL_MS = 2000;
const BILLING_POLL_MS = 30000; // 任务结束后用量还在入账（billing.pending）：每 30 秒再取一次
const STATUS = {
  queued: ['wait', '排队中'],
  running: ['live', '生成中'],
  awaiting_confirmation: ['wait', '等你确认分镜'],
  completed: ['', '已完成'],
  failed: ['failed', '失败'],
};
const STEP_CLASS = { done: 'done', running: 'live', failed: 'failed', skipped: 'skipped', pending: '' };
const BGM = { calm: '舒缓', upbeat: '轻快', warm: '温暖', tech: '科技感', inspiring: '励志', epic: '激昂', light: '轻松' };
const DOING = { research: '整理资料' }; // 播放器占位里"Agent 正在……"的说法，没列的直接用步骤名
const REF_KIND = { file: '文件', text: '粘贴的文字', link: '链接', library: '文件' };
const ISSUE_KIND = { contradiction: '和资料矛盾', unsupported: '找不到依据', term: '术语用法' };

const video = $('#player');
const strip = $('#strip');
const scrub = $('#scrub');

let id = null;            // 当前任务 id
let task = null;          // 最近一次拿到的任务详情
let fetchedAt = 0;
let active = false;       // 是否停留在生成页
let pollTimer = null;
let clockTimer = null;
let seq = 0;              // 请求序号：切换任务后丢弃旧请求的结果
let errStreak = 0;
let versionPick = null;   // 用户在下拉里选的版本号；null 表示跟随最新版本
let sceneId = null;       // 当前镜头：播放器、分镜条高亮共用
let scope = null;         // 修改范围：null 表示全片，否则是镜头对象
let sig = {};             // 各区块上次渲染的签名，没变就不重绘（避免打断播放、编辑和展开状态）
let cur = { mode: 'empty', key: null }; // 播放器当前加载的内容
let pendingSeek = null;
let autoplay = false;
let mediaRetryAt = 0;
let justActed = false;    // 刚发了修改 / 确认 / 重试，等下一次轮询结果
const busy = { send: false, confirm: false, retry: false };
let autoTab = false;
let detailsOpen = new Map(); // 左栏折叠块（资料摘要、来源、核对问题……）的展开状态，重绘时保留：key -> 是否展开
let viewer = null;        // 3D 预览，只在 3D 任务有成品时创建，离开页面时释放

/* ---------- 数据小工具 ---------- */

function normalize(t) {
  t.product = t.product === 'model3d' ? 'model3d' : 'video';
  t.steps = Array.isArray(t.steps) ? t.steps : [];
  t.versions = Array.isArray(t.versions) ? t.versions : [];
  t.messages = Array.isArray(t.messages) ? t.messages : [];
  if (t.model) t.model.versions = Array.isArray(t.model.versions) ? t.model.versions : [];
  const list = t.storyboard?.scenes;
  if (Array.isArray(list)) {
    let acc = 0;
    for (const s of list) {
      s.duration = Number(s.duration) || Number(s.clip?.dur) || 0;
      if (typeof s.start !== 'number') s.start = acc;
      acc = s.start + s.duration;
    }
  }
  return t;
}

const scenes = () => task?.storyboard?.scenes || [];
const sceneIndex = sid => scenes().findIndex(s => s.id === sid);
const sceneById = sid => (sid == null ? null : scenes().find(s => s.id === sid) || null);
const sceneNo = sid => { const i = sceneIndex(sid); return i >= 0 ? i + 1 : (parseInt(sid, 10) || sid); };
function totalDur() {
  const l = scenes();
  return l.length ? l[l.length - 1].start + l[l.length - 1].duration : 0;
}
function sceneAt(t) {
  const l = scenes();
  return l.find(s => t >= s.start && t < s.start + s.duration) || l[l.length - 1] || null;
}
const is3d = () => task?.product === 'model3d';
/** 版本：视频是成片，3D 图片是 model.versions */
const versionsOf = t => (t?.product === 'model3d' ? t.model?.versions : t?.versions) || [];
const versions = () => [...versionsOf(task)].sort((a, b) => b.n - a.n);
function currentVersion() {
  const vs = versions();
  return (versionPick != null && vs.find(v => v.n === versionPick)) || vs[0] || null;
}
function specFromRequest() {
  const sp = task?.request?.options?.spec;
  return sp?.enabled ? sp : null;
}
const taskTitle = () => task?.model?.asset?.name || task?.title || task?.brief?.title || task?.storyboard?.title || '新任务';
const num = n => Number(n).toLocaleString('zh-CN');
/** 建任务时给的普通图片：[{id, name, desc, url}]，编号 i01、i02…… */
const reqImages = () => (Array.isArray(task?.request?.images) && !is3d() ? task.request.images.filter(x => x && typeof x === 'object') : []);
const imgById = iid => reqImages().find(x => x.id === iid) || null;
/** 建任务时给的资料（新任务才有 request.refs；老任务是 null） */
const reqRefs = () => (task?.request?.refs && typeof task.request.refs === 'object' ? task.request.refs : null);
const refItems = () => (Array.isArray(reqRefs()?.items) ? reqRefs().items : []);
const refById = rid => (rid == null ? null : refItems().find(r => r.id === rid) || null);
const refName = r => r?.name || r?.title || r?.url || '';
/** 折叠块的 open 属性：用户点过就按用户的，没点过用默认值 */
const openAttr = (k, def = false) => ((detailsOpen.has(k) ? detailsOpen.get(k) : def) ? ' open' : '');

/* ---------- 生命周期 ---------- */

export function enter(taskId) {
  if (taskId !== id) { resetView(); id = taskId; }
  active = true;
  clearInterval(clockTimer);
  clockTimer = setInterval(tickClock, 1000);
  load();
}

export function leave() {
  active = false;
  clearTimeout(pollTimer);
  clearInterval(clockTimer);
  video.pause();
  closePrint();
  disposeViewer();
  sig.model = null; // 回来时重新创建 3D 预览
}

function resetView() {
  clearTimeout(pollTimer);
  seq++;
  disposeViewer();
  task = null; sig = {}; versionPick = null; sceneId = null; errStreak = 0; autoTab = false; justActed = false;
  detailsOpen = new Map();
  Object.assign(busy, { send: false, confirm: false, retry: false });
  cur = { mode: 'empty', key: null }; pendingSeek = null; autoplay = false;
  video.pause(); video.removeAttribute('src'); video.load(); video.hidden = true;
  $('#run-title').textContent = '加载中…';
  $('#run-meta').innerHTML = '';
  setStatus('', '加载中');
  $('#version-wrap').hidden = true;
  $('#dl-btn').disabled = true;
  $('#print-btn').hidden = true;
  $('#run-alert').hidden = true;
  $('#steps').innerHTML = '';
  $('#elapsed').textContent = '';
  $('#settings').innerHTML = '';
  $('#settings-box').hidden = true;
  strip.innerHTML = ''; scrub.innerHTML = '';
  $('#strip-empty').hidden = false;
  $('#msgs').innerHTML = '';
  $('#ask-input').value = '';
  setScope(null);
  $('#script').innerHTML = '';
  $('#confirm-box').hidden = true;
  $('#script-empty').hidden = false;
  $('#files').innerHTML = '';
  $('#files-empty').hidden = true;
  $('#usage-box').hidden = true;
  $('#tc-now').textContent = '00:00';
  $('#tc-total').textContent = '00:00';
  $('#play-btn').disabled = true;
  $('#screen-tag').hidden = true;
  showEmpty('正在加载任务', '');
  $('#m3d-views').innerHTML = '';
  $('#m3d-media').innerHTML = '';
  $('#m3d-views-empty').hidden = false;
  $('#m3d-ex').innerHTML = '';
  $('#m3d-ex-box').hidden = true;
  $('#asset').innerHTML = '';
  $('#asset-edit').hidden = true;
  modelEmpty('正在加载任务', '');
  selectTab($('#t-chat'), false);
  updateAsk();
}

async function load() {
  clearTimeout(pollTimer);
  const my = ++seq;
  const want = id;
  try {
    const t = normalize(await api.get(`/tasks/${encodeURIComponent(want)}`));
    if (my !== seq || !active) return;
    const prev = task;
    task = t;
    fetchedAt = Date.now();
    errStreak = 0;
    justActed = false;
    render(prev);
    if (prev && prev.billing?.credits !== t.billing?.credits) refreshCredits(); // 顶部本月已用跟着变
    if (ACTIVE.has(t.status)) schedule(POLL_MS); // completed / failed 时停止轮询
    else if (t.billing?.pending) schedule(BILLING_POLL_MS);
  } catch (e) {
    if (my !== seq || !active) return;
    if (e.status === 401) return; // 已经回到登录页
    if (e.status === 404) { notFound(e.message); return; }
    errStreak++;
    if (errStreak === 1) toast(e.message, 'error');
    if (!task) {
      $('#run-title').textContent = '任务加载失败';
      setStatus('failed', '连接中断');
      showEmpty('任务加载失败', `${e.message}。稍后会自动重试。`);
    }
    if (!task || ACTIVE.has(task.status) || justActed || task.billing?.pending) schedule(Math.min(POLL_MS * 2 ** errStreak, 20000));
  }
}

function schedule(ms) {
  clearTimeout(pollTimer);
  if (!active || document.hidden) return;
  pollTimer = setTimeout(load, ms);
}

function notFound(msg) {
  task = null;
  $('#run-title').textContent = '没有找到这个任务';
  document.title = '没有找到任务｜Slate';
  setStatus('failed', '无法打开');
  alertBox('fail', '没有找到这个任务', msg || '它可能已被删除，或者不属于当前账号。', '<a class="btn ghost small" href="#projects">回到任务列表</a>');
  showEmpty('没有找到这个任务', '');
  updateAsk();
}

function render(prev) {
  setLayout();
  renderHead(prev);
  renderAlert();
  renderSteps();
  renderSettings();
  if (is3d()) renderModel();
  else {
    renderStrip();
    renderPlayer();
    renderScript();
  }
  renderChat();
  renderFiles();
  renderBilling();
  tickClock();
  updateAsk();
  if (task.status === 'awaiting_confirmation') {
    if (!autoTab) { autoTab = true; selectTab($('#t-script'), false); }
  } else autoTab = false;
}

/* ---------- 顶部：片名、规格、版本、状态 ---------- */

function setStatus(cls, text) {
  const pill = $('#run-status');
  pill.className = 'status-pill ' + cls;
  $('span', pill).textContent = text;
}

function renderHead(prev) {
  const title = taskTitle();
  $('#run-title').textContent = title;
  document.title = `${title}｜Slate`;

  const b = task.brief;
  const spec = b || specFromRequest();
  const photos = Array.isArray(task.request?.images) ? task.request.images.length : 0;
  const meta = is3d()
    ? ['3D 图片', photos ? `${photos} 张参考照片` : '只有文字描述']
    : [userGenre() || b?.kind, spec?.ratio, spec?.duration && durLabel(spec.duration), spec?.resolution].filter(Boolean);
  $('#run-meta').innerHTML = meta.length ? meta.map(x => `<span>${esc(x)}</span>`).join('') : '<span>Agent 正在分析需求</span>';

  const vs = versions();
  if (prev && vs.length > versionsOf(prev).length) {
    versionPick = null; // 新版本出来了，切到最新版本
    toast(`第 ${vs[0].n} 版已完成，可以下载了`);
  }
  const sel = $('#version-select');
  const vsig = vs.map(v => v.n).join(',');
  if (vsig !== sig.versions) {
    sig.versions = vsig;
    sel.innerHTML = vs.map(v => `<option value="${v.n}">第 ${v.n} 版</option>`).join('');
  }
  $('#version-wrap').hidden = !vs.length;
  const cv = currentVersion();
  if (cv) sel.value = String(cv.n);
  const dl = $('#dl-btn');
  dl.disabled = !cv;
  dl.title = cv ? `下载第 ${cv.n} 版${is3d() ? ' GLB' : ''}` : '生成完成后可以下载';
  syncPrint();
  // 工作流模式建的任务：回到建它的画板（docs/workflow-mode-design.md）
  const fl = $('#run-flow');
  fl.hidden = !task.flow?.id;
  if (task.flow?.id) fl.href = `#flow/${encodeURIComponent(task.flow.id)}`;

  const [cls, text] = STATUS[task.status] || ['', '未知状态'];
  setStatus(cls, task.statusText || text);
}

/* 失败原因 / 等待确认的提示条 */
function alertBox(kind, title, text, actions = '') {
  const box = $('#run-alert');
  box.className = 'run-alert ' + kind;
  box.innerHTML = `<svg aria-hidden="true"><use href="#i-${kind === 'fail' ? 'alert' : 'clap'}"/></svg><p><b>${esc(title)}</b>${esc(text)}</p>${actions}`;
  box.hidden = false;
}

function renderAlert() {
  const s = task.status;
  const wait = busy.retry || justActed;
  const key = [s, task.failure?.message, task.canRetry, wait].join('|');
  if (key === sig.alert) return;
  sig.alert = key;
  if (s === 'failed') {
    alertBox('fail', '生成失败', task.failure?.message || '没有拿到失败原因。',
      task.canRetry ? `<button type="button" class="btn primary small" data-act="retry" ${wait ? 'disabled' : ''}>${wait ? '正在提交…' : '让 Agent 修复后重试'}</button>` : '');
  } else if (s === 'awaiting_confirmation' && task.long) {
    alertBox('wait', '总纲写好了，等你确认', `一共 ${scenes().length} 章。在右侧「分镜脚本」里每一行是一章，检查每章的讲稿和要点，文字可以直接改。确认后各章同时开始制作。`,
      '<button type="button" class="btn ghost small" data-act="show-script">查看总纲</button>');
  } else if (s === 'awaiting_confirmation') {
    alertBox('wait', '分镜写好了，等你确认', '在右侧「分镜脚本」里检查每一镜的旁白和画面，文字可以直接改。确认后 Agent 才开始渲染。',
      '<button type="button" class="btn ghost small" data-act="show-script">查看分镜脚本</button>');
  } else {
    $('#run-alert').hidden = true;
  }
}

/* ---------- 左栏：步骤（顺序以后端返回的 steps 为准：新任务资料整理在需求分析前面） ---------- */

function stepTime(st) {
  if (st.state === 'running') return '进行中';
  if (st.state === 'skipped') return '跳过';
  if (st.state === 'failed') return '失败';
  if (st.state === 'done' && st.endedAt > 1e12 && task.createdAt > 1e12 && st.endedAt >= task.createdAt) {
    return mss((st.endedAt - task.createdAt) / 1000);
  }
  return '';
}

/** 用户建任务时指定的写作方法名；交给 Agent 时是 null（老任务也没有这个字段） */
const userGenre = () => task?.request?.genre?.name || null;

function briefBlock(b, note) {
  const decided = new Set(b.decided || []);
  const mine = userGenre();
  if (mine) decided.delete('kind'); // 写作方法是你选的：不标「Agent 定」
  const kind = mine || b.kind;      // b.kind 是写作方法的中文名；老任务里可能是"广告宣传"这类旧值，照常显示
  const tag = keys => (keys.some(k => decided.has(k)) ? '<em class="by-agent">Agent 定</em>' : '');
  const skills = (b.skills || []).map(s => (typeof s === 'string' ? s : s?.name || s?.id)).filter(Boolean);
  const rows = [
    ['写作方法', kind, ['kind']],
    ['受众', b.audience, ['audience']],
    ['规格', [b.ratio, b.duration && durLabel(b.duration), b.resolution, b.fps && `${b.fps} 帧`].filter(Boolean).join('，'), ['ratio', 'duration', 'resolution', 'fps']],
    ['画风', skills.map(n => `「${n}」`).join(''), ['skills']],
    ['声音', [b.voice || '不配音', b.subtitles === false ? '不加字幕' : '中文字幕'].join('，'), ['voice', 'subtitles']],
    ['音乐', b.bgm ? (BGM[b.bgm] ? `${BGM[b.bgm]}的背景音乐` : '有背景音乐') : '不加背景音乐', ['bgm']],
  ].filter(r => r[1]);
  const intro = note || (b.audience && kind ? `判断这是一支给${b.audience}看的片子，写作方法${mine ? '按你选的' : '用'}「${kind}」。` : '');
  const lead = decided.size ? '你没有指定的部分由 Agent 决定，标了「Agent 定」：' : '全部按你的指定来做：';
  return `<p>${esc(intro)}${lead}</p><ul class="decided">${rows.map(([k, v, keys]) => `<li><span>${k}</span>${esc(v)}${tag(keys)}</li>`).join('')}</ul>`;
}

function sourcesBlock() {
  const src = task.sources;
  if (!src || (!src.queries?.length && !src.sources?.length)) return '';
  const qs = (src.queries || []).map(q => `<span class="q"><svg class="ico"><use href="#i-search"/></svg>${esc(q)}</span>`).join('');
  const items = (src.sources || []).map(s => {
    const href = safeUrl(s.url);
    const title = esc(s.title || s.url);
    const link = href
      ? `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${title}<small>${esc(hostOf(href))}</small></a>`
      : `<b>${title}</b>`;
    const note = s.used === false ? `<em>没有采用${s.note ? '：' + esc(s.note) : ''}</em>` : (s.note ? `<em>${esc(s.note)}</em>` : '');
    return `<li>${link}${note}</li>`;
  }).join('');
  return `<details class="sources" data-k="sources"${openAttr('sources')}><summary>查看搜索和来源</summary><ul>${qs ? `<li class="q-list">${qs}</li>` : ''}${items}</ul></details>`;
}

const factText = f => (typeof f === 'string' ? f : f?.text || f?.fact || '');

/** 资料整理的结果（notes）：一句整体理解；每份资料一行：名称、是否用到、摘要，用到的事实和术语折叠起来 */
function notesBlock() {
  const n = task.notes;
  const items = Array.isArray(n?.items) ? n.items : [];
  if (!n || typeof n !== 'object' || (!n.angle && !items.length)) return '';
  const rows = items.map((x, i) => {
    const k = `rn-${x.id ?? i}`;
    const name = refName(refById(x.id)) || x.title || x.name || `资料 ${i + 1}`;
    const used = x.used !== false;
    const facts = (Array.isArray(x.facts) ? x.facts : []).map(factText).filter(Boolean);
    const terms = (Array.isArray(x.terms) ? x.terms : []).filter(t => t?.term);
    const label = [facts.length && `用到的事实 ${facts.length} 条`, terms.length && `术语 ${terms.length} 个`].filter(Boolean).join('，');
    const more = label ? `<details data-k="${esc(k)}"${openAttr(k)}><summary>${label}</summary><ul class="rn-facts">${facts.map(f => `<li>${esc(f)}</li>`).join('')}${terms.length ? `${facts.length ? '<li class="rn-sub">术语</li>' : ''}${terms.map(t => `<li><dfn>${esc(t.term)}</dfn>${t.meaning ? `：${esc(t.meaning)}` : ''}</li>`).join('')}` : ''}</ul></details>` : '';
    return `<li class="rn-item"><div class="rn-h"><b title="${esc(name)}">${esc(name)}</b><em class="rn-tag ${used ? 'used' : 'unused'}">${used ? '用到了' : '没用到'}</em></div>${x.summary ? `<p>${esc(x.summary)}</p>` : ''}${!used && x.reason ? `<p class="rn-why">没用的原因：${esc(x.reason)}</p>` : ''}${more}</li>`;
  }).join('');
  const usedN = items.filter(x => x.used !== false).length;
  const label = items.length ? `查看资料摘要（${items.length} 份，用到 ${usedN} 份）` : '查看资料摘要';
  return `<details class="rnotes" data-k="notes"${openAttr('notes')}><summary>${label}</summary><div class="rnotes-body">${n.angle ? `<p class="rn-angle">${esc(n.angle)}</p>` : ''}${rows ? `<ul class="rn-list">${rows}</ul>` : ''}</div></details>`;
}

/** 剧本核对结果（scriptCheck）：放在"写剧本"这一步下面 */
function checkBlock() {
  const c = task.scriptCheck;
  if (!c || typeof c !== 'object') return '';
  const issues = Array.isArray(c.issues) ? c.issues.filter(x => x && typeof x === 'object') : [];
  const rounds = Number(c.rounds) || 0;
  const head = rounds ? `已核对 ${rounds} 轮，` : '已核对，';
  if (c.ok !== false && !issues.length) {
    return `<p class="rcheck-line ok"><svg aria-hidden="true"><use href="#i-check"/></svg><span>${head}${c.strict ? '全部有依据' : '没有和资料矛盾的说法'}</span></p>`;
  }
  const rows = issues.map(x => {
    const r = refById(x.ref);
    const src = r ? refName(r) : '';
    return `<li><em class="rc-kind ${esc(x.kind || '')}">${esc(ISSUE_KIND[x.kind] || '其他问题')}</em>${x.text ? `<q>${esc(x.text)}</q>` : ''}${x.suggestion ? `<span class="rc-sug">建议：${esc(x.suggestion)}</span>` : ''}${src ? `<small>对照资料：${esc(src)}</small>` : ''}</li>`;
  }).join('');
  const line = `<p class="rcheck-line warn"><svg aria-hidden="true"><use href="#i-alert"/></svg><span>${head}${issues.length ? `有 ${issues.length} 条未解决` : '还有问题没解决'}</span></p>`;
  return line + (rows ? `<details class="rcheck" data-k="check"${openAttr('check', true)}><summary>未解决的问题</summary><ul class="rc-issues">${rows}</ul></details>` : '');
}

function researchSkipped() {
  const r = task.request || {};
  if (reqRefs()) return !refItems().length && reqRefs().web === false ? '没有给资料，联网搜索也关了，这一步跳过。' : '这次不需要整理资料。';
  return r.web_search === false ? '联网搜索已关闭，Agent 只用描述和你给的内容。' : '这次不需要联网搜索。'; // 老任务
}

function scriptSummary() {
  const paras = task.script?.paragraphs || [];
  const chars = paras.join('').length;
  // 新任务没有讲解稿，按资料和描述写；老任务照旧按讲解稿的用法说
  const how = reqRefs()
    ? (refItems().length ? '结合你给的资料写了' : 'Agent 按描述写了')
    : { agent: '没有提供讲解稿，Agent 按描述写了', outline: '按你给的大纲写了', verbatim: '按你的讲解稿逐字讲解，分成' }[task.script?.mode] || '写了';
  return `${how} ${paras.length} 段旁白，共 ${chars} 字。`;
}

const CH_STATE = { queued: '排队中', running: '制作中', done: '已完成', failed: '没完成' };
/** 长片各章的进度：每章一行 */
function chaptersBlock() {
  const rows = (task.chapters || []).map(ch => {
    const prog = ch.status === 'running' && ch.scenes ? `，已渲染 ${ch.clips}/${ch.scenes} 镜` : '';
    return `<li class="ch-${esc(ch.status)}"><b>第 ${parseInt(ch.id, 10)} 章</b>${esc(ch.title || '')}<span>${CH_STATE[ch.status] || ch.status}${prog}</span></li>`;
  }).join('');
  return rows ? `<ul class="chapters">${rows}</ul>` : '';
}

function stepBody(st) {
  const note = st.note ? `<p>${esc(st.note)}</p>` : '';
  const pending = st.state === 'pending';
  if (task.chapters && st.name === 'code') return note + chaptersBlock();
  switch (st.name) {
    case 'analyze':
      if (task.product === 'model3d') return note + sourcesBlock();  // 3D 图片：看图分析时联网查到的来源
      return task.brief ? briefBlock(task.brief, st.note) : note;
    case 'research':
      if (st.state === 'skipped' && !st.note) return `<p>${researchSkipped()}</p>`;
      return note + notesBlock() + sourcesBlock();
    case 'script':
      return (note || (pending || !task.script ? '' : `<p>${esc(scriptSummary())}</p>`)) + checkBlock();
    case 'storyboard':
      return note || (pending || !scenes().length ? '' : `<p>${scenes().length} 个镜头，共 ${durLabel(totalDur())}。</p>`);
    case 'render': {
      const l = scenes();
      const done = l.filter(s => s.clip).length;
      const text = note || (l.length && !pending ? `<p>已渲染 ${done}/${l.length} 镜</p>` : '');
      const bar = st.state === 'running' && l.length ? `<div class="bar" aria-hidden="true"><i style="width:${(done / l.length) * 100}%"></i></div>` : '';
      return text + bar;
    }
    default:
      return note;
  }
}

function renderSteps() {
  const key = JSON.stringify([task.steps, task.brief, task.sources, task.notes, task.scriptCheck, task.request?.refs,
    task.script?.paragraphs?.length, task.script?.mode, scenes().map(s => [s.duration, !!s.clip]), task.createdAt,
    task.request?.web_search, task.request?.genre, task.chapters]);
  if (key === sig.steps) return;
  sig.steps = key;
  $('#steps').innerHTML = task.steps.map(st => `<li class="${STEP_CLASS[st.state] ?? ''}">
    <i class="mk"></i>
    <div class="step-head"><b>${esc(st.label || st.name)}</b><time>${stepTime(st)}</time></div>
    ${stepBody(st)}
  </li>`).join('');
}

/* ---------- 左栏：你的设置（资料清单、联网搜索、强制引用；老任务还有讲解稿） ---------- */

function refRow(x) {
  const name = refName(x) || REF_KIND[x.kind] || '资料';
  const href = x.kind === 'link' && safeUrl(x.url);
  const tag = x.kind === 'library' ? `<em class="rf-tag">${esc(x.source || '素材库')}</em>` : '';
  const title = href ? `<b><a href="${esc(href)}" target="_blank" rel="noopener noreferrer" title="${esc(x.url)}">${esc(name.replace(/^https?:\/\//, ''))}</a></b>` : `<b title="${esc(name)}">${esc(name)}${tag}</b>`;
  const meta = [REF_KIND[x.kind], x.chars ? `${num(x.chars)} 字` : ''].filter(Boolean).join('，');
  return `<li>${title}${meta ? `<small>${esc(meta)}</small>` : ''}${x.note ? `<small>备注：${esc(x.note)}</small>` : ''}${x.error ? `<small class="err">没抓到正文：${esc(x.error)}</small>` : ''}</li>`;
}

/** 老任务的讲解稿（request.options.script）：逐字 / 按大纲，大纲字数和文件 */
function scriptSetting(sc) {
  const outline = String(sc.outline || '').trim();
  const files = Array.isArray(sc.files) ? sc.files : Array.isArray(sc.uploads) ? sc.uploads : [];
  const names = (Array.isArray(sc.files) ? sc.files : []).map(f => String(f).split('/').pop()).filter(Boolean);
  const parts = [outline && `大纲 ${num([...outline].length)} 字`, files.length && `文件 ${files.length} 份`].filter(Boolean);
  return `${sc.verbatim ? '逐字讲解' : '按大纲讲'}${parts.length ? `<span class="dim">，${parts.join('，')}</span>` : ''}${names.length ? `<ul class="set-refs">${names.map(n => `<li><small>${esc(n)}</small></li>`).join('')}</ul>` : ''}`;
}

/** 3D 图片的设置：描述、参考照片、联网搜索和拆解 */
function renderModelSettings() {
  const r = task.request || {};
  const imgs = Array.isArray(r.images) ? r.images : [];
  const key = JSON.stringify([r.description, r.web_search, r.explode, imgs.map(x => [x.name, keyOf(x.url)])]);
  if (key === sig.settings) return;
  sig.settings = key;
  const photos = imgs.length
    ? `<ul class="set-photos">${imgs.map(x => {
      const href = safeUrl(x.url);
      return `<li>${href ? `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer" title="${esc(x.name || '')}"><img src="${esc(href)}" alt="${esc(x.name || '参考照片')}"></a>` : `<span>${esc(x.name || '')}</span>`}</li>`;
    }).join('')}</ul>`
    : '<span class="dim">没有照片，Agent 先按描述画示意图</span>';
  $('#settings').innerHTML = [['描述', `<span class="set-desc">${esc(r.description || '')}</span>`], ['照片', photos],
    ['联网搜索', r.web_search ? '开' : '<span class="dim">关</span>'],
    ['拆解', r.explode ? '开<span class="dim">：内部零件也做，出拆解图和 GIF 动图</span>' : '<span class="dim">关</span>']]
    .map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('');
  $('#settings-box').hidden = false;
}

function renderSettings() {
  if (is3d()) { renderModelSettings(); return; }
  const r = task.request || {};
  const refs = reqRefs();
  const sc = r.options?.script?.enabled ? r.options.script : null;
  const models = Array.isArray(r.models) ? r.models.filter(m => m && typeof m === 'object') : [];
  const imgs = reqImages();
  const key = JSON.stringify([refs, r.web_search, sc, models, imgs.map(x => [x.id, x.desc, x.error, keyOf(x.url)])]);
  if (key === sig.settings) return;
  sig.settings = key;
  const items = refItems();
  const rows = [];
  if (refs) rows.push(['资料', items.length ? `<ul class="set-refs">${items.map(refRow).join('')}</ul>` : '<span class="dim">没有给资料</span>']);
  // 从素材库引用的 3D 图片：点名称打开那个 3D 任务
  // 普通图片：缩略图、编号和描述（分镜里每镜用到哪几张，对的就是这里的编号）
  if (imgs.length) rows.push(['图片', `<ul class="set-imgs">${imgs.map(x => {
    const href = safeUrl(x.url);
    return `<li>${href ? `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer"><img src="${esc(href)}" alt=""></a>` : '<span class="ph"></span>'}
      <div><b>${esc(x.id)}</b>${x.error ? `<small class="err">${esc(x.error)}</small>` : ''}<small>${esc(x.desc || '')}</small></div></li>`;
  }).join('')}</ul>`]);
  if (models.length) rows.push(['3D 素材', `<ul class="set-refs">${models.map(m => `<li><b>${m.taskId ? `<a href="#run/${encodeURIComponent(m.taskId)}">${esc(m.name || '3D 图片')}</a>` : esc(m.name || '3D 图片')}</b></li>`).join('')}</ul>`]);
  rows.push(['联网搜索', (refs ? refs.web !== false : r.web_search !== false) ? '开' : '关']);
  if (refs) rows.push(['强制引用', refs.strict ? '开<span class="dim">：事实、数字和术语只用资料</span>' : '关<span class="dim">：资料只作参考</span>']);
  if (sc) rows.push(['讲解稿', scriptSetting(sc)]);
  $('#settings').innerHTML = rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('');
  $('#settings-box').hidden = false;
}

function tickClock() {
  if (!task || typeof task.elapsed !== 'number') { $('#elapsed').textContent = ''; return; }
  let e = task.elapsed;
  if (task.status === 'running' || task.status === 'queued') e += (Date.now() - fetchedAt) / 1000;
  $('#elapsed').textContent = `已用 ${mss(e)}`;
}

/* ---------- 中间：播放器和分镜条 ---------- */

function showEmpty(title, text) {
  $('#screen-empty').hidden = false;
  $('#empty-title').textContent = title;
  $('#empty-text').textContent = text;
  $('#empty-text').hidden = !text;
}

function emptyMessage(s) {
  const st = task?.status;
  if (!task) return showEmpty('正在加载任务', '');
  if (s) {
    const n = sceneIndex(s.id) + 1;
    if (s.clip) return showEmpty(`第 ${n} 镜暂时无法预览`, '这一镜已经渲染好了，但预览链接不可用。');
    const tail = st === 'failed' ? '生成失败了，可以让 Agent 修复后重试。' : st === 'awaiting_confirmation' ? '确认分镜后才开始渲染。' : '';
    return showEmpty(`第 ${n} 镜「${s.title}」还没渲染`, [s.visual && `画面：${s.visual}`, tail].filter(Boolean).join('　'));
  }
  if (st === 'queued') return showEmpty('任务在排队', '马上开始。镜头渲染好一个，就会在这里显示一个。');
  if (st === 'failed') return showEmpty('没有可以播放的画面', '生成失败了，可以让 Agent 修复后重试。');
  const step = task.steps.find(x => x.state === 'running');
  return showEmpty('还没有画面', step ? `Agent 正在${DOING[step.name] || step.label}。镜头渲染好一个，就会在这里显示一个。` : '镜头渲染好一个，就会在这里显示一个。');
}

/** 播放什么：有成片放成片；没有成片放选中镜头的 clip；都没有显示占位 */
function want() {
  const v = currentVersion();
  if (v?.url) return { mode: 'version', key: `v${v.n}|${keyOf(v.url)}`, url: v.url, v };
  const s = sceneById(sceneId) || scenes()[0] || null;
  if (s?.clip?.url) return { mode: 'clip', key: `c${s.id}|${keyOf(s.clip.url)}`, url: s.clip.url, s };
  return { mode: 'empty', s };
}

function renderPlayer() {
  const w = want();
  if (w.mode === 'empty') {
    if (cur.key) { video.pause(); video.removeAttribute('src'); video.load(); }
    cur = { mode: 'empty', key: null };
    video.hidden = true;
    emptyMessage(w.s);
  } else if (w.key !== cur.key) {
    const wasPlaying = !video.paused && !video.ended;
    let resume = null;
    if (w.mode === 'version' && cur.mode === 'clip') {
      const cs = sceneById(cur.sceneId);
      if (cs) resume = cs.start + (video.currentTime || 0); // 从单镜预览切到成片时接着放
    } else if (w.mode === 'version' && cur.mode === 'version') {
      resume = video.currentTime || 0; // 切版本保持位置
    }
    cur = { mode: w.mode, key: w.key, url: w.url, sceneId: w.s?.id ?? null, n: w.v?.n ?? null };
    if (pendingSeek == null && resume) pendingSeek = resume;
    video.src = w.url;
    video.hidden = false;
    $('#screen-empty').hidden = true;
    if (wasPlaying || autoplay) { autoplay = false; video.play().catch(() => {}); }
  } else {
    cur.url = w.url; // 同一个文件，只是签名链接换了：不打断播放，留着出错时用
  }
  $('#play-btn').disabled = cur.mode === 'empty';
  updateTag();
  renderScrub();
}

function updateTag() {
  const tag = $('#screen-tag');
  let text = '';
  if (cur.mode === 'version') {
    const s = sceneById(sceneId);
    text = `第 ${cur.n} 版` + (s ? `　第 ${sceneIndex(s.id) + 1} 镜 ${s.title}` : '');
  } else if (cur.mode === 'clip') {
    const s = sceneById(cur.sceneId);
    text = s ? `第 ${sceneIndex(s.id) + 1} 镜 ${s.title}（单镜预览）` : '';
  }
  tag.textContent = text;
  tag.hidden = !text;
}

function playhead() {
  if (cur.mode === 'version') return video.currentTime || 0;
  if (cur.mode === 'clip') return (sceneById(cur.sceneId)?.start || 0) + (video.currentTime || 0);
  return sceneById(sceneId)?.start || 0;
}
function timelineTotal() {
  if (cur.mode === 'version') return currentVersion()?.dur || video.duration || totalDur();
  return totalDur();
}

function updateHead() {
  const t = playhead();
  const total = timelineTotal();
  $('#tc-now').textContent = mmss(t);
  const head = $('.head', scrub);
  if (head) head.style.left = total ? `${Math.min(100, (t / total) * 100)}%` : '0';
}

function renderScrub() {
  const l = scenes();
  const vmode = cur.mode === 'version';
  const key = JSON.stringify([vmode, l.map(s => [s.duration, !!s.clip])]);
  if (key !== sig.scrub) {
    sig.scrub = key;
    scrub.innerHTML = l.map(s => `<span class="seg-s ${vmode || s.clip ? 'done' : ''}" style="flex:${s.duration || 1}"></span>`).join('') + '<span class="head"></span>';
    // 镜头之间的间隔按镜头数收窄：长片一两百镜时，固定 3 像素的间隔加起来会把播放器撑出中间栏
    scrub.style.gap = `${l.length > 150 ? 0 : l.length > 60 ? 1 : l.length > 30 ? 2 : 3}px`;
  }
  $('#tc-total').textContent = mmss(timelineTotal());
  updateHead();
}

function markCurrent() {
  $$('.shot', strip).forEach(b => b.classList.toggle('is-current', b.dataset.id === sceneId));
}

function renderStrip() {
  const l = scenes();
  $('#strip-empty').hidden = l.length > 0;
  strip.style.setProperty('--cols', Math.max(1, Math.min(l.length, 6)));
  const structure = JSON.stringify(l.map(s => [s.id, s.title, s.start, s.duration]));
  if (structure !== sig.strip) {
    sig.strip = structure;
    sig.clips = {};
    strip.innerHTML = l.map((s, i) => `<li><button type="button" class="shot pending" data-id="${esc(s.id)}">
      <span class="thumb">待渲染</span>
      <span class="shot-title"><em>${i + 1}</em>${esc(s.title)}</span>
      <span class="shot-time">${mss(s.start)} 到 ${mss(s.start + s.duration)}</span>
    </button></li>`).join('');
    if (!sceneById(sceneId)) sceneId = l[0]?.id ?? null;
    if (scope && !sceneById(scope.id)) setScope(null);
  }
  l.forEach((s, i) => {
    const k = s.clip ? (s.clip.url ? keyOf(s.clip.url) : 'no-url') : '';
    if (sig.clips[s.id] === k) return;
    sig.clips[s.id] = k;
    const btn = strip.querySelector(`.shot[data-id="${CSS.escape(s.id)}"]`);
    if (!btn) return;
    const done = !!s.clip;
    btn.classList.toggle('done', done);
    btn.classList.toggle('pending', !done);
    btn.setAttribute('aria-label', `第 ${i + 1} 镜 ${s.title}，${done ? '已渲染' : '待渲染'}`);
    const th = $('.thumb', btn);
    if (!done) th.textContent = '待渲染';
    else if (s.clip.url && l.length <= 40) th.innerHTML = `<video muted playsinline preload="metadata" tabindex="-1" aria-hidden="true" src="${esc(s.clip.url)}#t=0.5"></video>`;  // 镜头太多时不预载缩略画面
    else th.textContent = '已渲染';
  });
  markCurrent();
}

function seek(t) {
  if (video.readyState >= 1) video.currentTime = Math.max(0, t);
  else pendingSeek = t;
}

function selectScene(s) {
  setScope(s);
  sceneId = s.id;
  markCurrent();
  if (cur.mode === 'version') seek(s.start + 0.01);
  else if (cur.mode === 'clip' && cur.sceneId === s.id) seek(0);
  else { pendingSeek = null; renderPlayer(); }
  updateTag();
  updateHead();
}

/* ---------- 右栏：修改对话 ---------- */

function setScope(s) {
  scope = s || null;
  const chip = $('#scope-chip');
  chip.classList.toggle('is-shot', !!s);
  chip.innerHTML = s ? `只改第 ${sceneNo(s.id)} 镜 ${esc(s.title)}<button type="button" aria-label="改为全片"><svg><use href="#i-x"/></svg></button>` : '全片';
  $('.ask-hint').hidden = !!s;
}

function msgHtml(m) {
  const text = esc(m.text);
  if (m.kind === 'system') return `<div class="msg system"><p>${text}</p></div>`;
  if (m.role === 'user') {
    const sc = m.scope && m.scope !== 'all' ? `【第 ${sceneNo(m.scope)} 镜】` : '';
    return `<div class="msg user"><p>${esc(sc)}${text}</p></div>`;
  }
  if (m.kind === 'plan') {
    const lines = String(m.text || '').split('\n')
      .map(l => l.replace(/^\s*(?:[-*•·]|\d+[.、)])\s*/, '').trim()).filter(Boolean);
    return `<div class="msg agent"><span class="who">Agent</span><div class="plan"><b>改动计划</b><ul>${lines.map(l => `<li>${esc(l)}</li>`).join('')}</ul></div></div>`;
  }
  return `<div class="msg agent"><span class="who">Agent</span><p>${text}</p></div>`;
}

function renderChat() {
  const msgs = task.messages;
  const key = msgs.map(m => `${m.id}:${m.kind}:${(m.text || '').length}`).join('|') + '#' + scenes().length;
  if (key === sig.chat) return;
  const first = sig.chat === undefined;
  sig.chat = key;
  const box = $('#msgs');
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  box.innerHTML = msgs.length
    ? msgs.map(msgHtml).join('')
    : `<p class="msgs-empty">${is3d() ? '还没有对话。模型做好以后，可以在这里告诉 Agent 要改什么，每次修改出一个新版本。'
      : '还没有对话。片子生成好以后，可以在这里告诉 Agent 要改什么；想只改某一镜，先在分镜条上点选那一镜。'}</p>`;
  if (first || nearBottom) box.scrollTop = box.scrollHeight;
}

function askReason() {
  if (!task) return '';
  if (justActed && !task.canConfirm) return 'Agent 正在工作，等这一轮完成后再发';
  if (task.canMessage) return '';
  switch (task.status) {
    case 'queued':
    case 'running': return 'Agent 正在工作，等这一轮完成后再发';
    case 'awaiting_confirmation': return '先在「分镜脚本」里确认分镜，生成完成后才能提修改';
    case 'failed': return '任务失败了，先让 Agent 修复后重试';
    default: return '现在不能发送修改';
  }
}

function updateAsk() {
  const can = !!task?.canMessage && !justActed;
  $('#ask-input').disabled = !can;
  $('#ask-send').disabled = !can || busy.send;
  $('#ask-form').classList.toggle('is-disabled', !can);
  $('#ask-reason').textContent = busy.send ? '正在发送…' : askReason();
}

async function send() {
  if (busy.send) return;
  if (!task?.canMessage || justActed) { const r = askReason(); if (r) toast(r); return; }
  const input = $('#ask-input');
  const text = input.value.trim();
  if (!text) { input.focus(); return; }
  const want = id;
  const sc = scope;
  busy.send = true;
  updateAsk();
  try {
    await api.post(`/tasks/${encodeURIComponent(want)}/messages`, { text, scope: sc ? sc.id : 'all' });
    if (want !== id) return;
    input.value = '';
    justActed = true;
    toast(sc ? `已发给 Agent，只改第 ${sceneNo(sc.id)} 镜` : '已发给 Agent');
    load();
  } catch (e) {
    if (e.status !== 401) toast(e.message, 'error');
    if (e.status === 409) load();
  } finally {
    busy.send = false;
    updateAsk();
  }
}

/* ---------- 右栏：分镜脚本和确认 ---------- */

function renderScript() {
  const l = scenes();
  const can = !!task.canConfirm && !justActed;
  $('#confirm-box').hidden = !can;
  // 长片确认的是总纲（每一行是一章），普通片子确认的是分镜
  const outline = task.long && !task.chapters;
  $('#confirm-title').textContent = outline ? '总纲写好了，等你确认' : '分镜写好了，等你确认';
  $('#confirm-text').textContent = outline ? '每一行是一章，检查每章的讲稿和要点，文字可以直接改。确认后各章同时开始制作。'
    : '检查每一镜的旁白和画面，文字可以直接改。确认后 Agent 才开始写动画、渲染。';
  if (!busy.confirm) $('#confirm-btn').textContent = outline ? '确认总纲，开始制作' : '确认分镜，开始生成';
  $('#script-empty').hidden = l.length > 0;
  const key = JSON.stringify([!!task.canConfirm, l.map(s => [s.id, s.title, s.narration, s.visual, s.start, s.duration, s.images]), reqImages().map(x => keyOf(x.url))]);
  if (key === sig.script) return;
  sig.script = key;
  const ol = $('#script');
  const editable = !!task.canConfirm;
  ol.classList.toggle('is-editable', editable);
  const ed = editable ? ' contenteditable="true" spellcheck="false"' : '';
  // 长片：确认总纲时每一行是一章；各章开工后，分镜按章分组，章名单独占一行
  const outlineRows = task.long && !task.chapters;
  const head = (s, i) => (task.long && !outlineRows && s.chapter !== l[i - 1]?.chapter
    ? `<li class="ch-head" aria-hidden="true">第 ${parseInt(s.chapter, 10)} 章　${esc(s.chapterTitle || '')}</li>` : '');
  ol.innerHTML = l.map((s, i) => `${head(s, i)}<li data-id="${esc(s.id)}">
    <div class="script-h"><b>${outlineRows ? `第 ${i + 1} 章` : i + 1}　${esc(s.title)}</b><time>${mss(s.start)} 到 ${mss(s.start + s.duration)}</time></div>
    <dl><dt>旁白</dt><dd data-field="narration"${ed}>${esc(s.narration)}</dd><dt>${outlineRows ? '要点' : '画面'}</dt><dd data-field="visual"${ed}>${esc(s.visual)}</dd>${sceneImages(s)}</dl>
  </li>`).join('');
  countEdits();
}

/** 这一镜用到的用户图片（分镜的 images）：小缩略图，悬停看编号和描述 */
function sceneImages(s) {
  const list = (Array.isArray(s.images) ? s.images : []).map(imgById).filter(Boolean);
  if (!list.length) return '';
  return `<dt>图片</dt><dd class="sb-imgs">${list.map(x => {
    const href = safeUrl(x.url);
    return href ? `<img src="${esc(href)}" alt="${esc(x.id)}" title="${esc(`${x.id}：${x.desc || ''}`)}">` : `<span>${esc(x.id)}</span>`;
  }).join('')}</dd>`;
}

function readEdits() {
  return scenes().map(s => {
    const li = $(`#script li[data-id="${CSS.escape(s.id)}"]`);
    const get = f => (li ? $(`[data-field="${f}"]`, li).innerText : s[f] || '').trim();
    return { s, narration: get('narration'), visual: get('visual') };
  });
}
const changedEdit = x => x.narration !== (x.s.narration || '').trim() || x.visual !== (x.s.visual || '').trim();

function countEdits() {
  const n = readEdits().reduce((a, x) => a + (x.narration !== (x.s.narration || '').trim()) + (x.visual !== (x.s.visual || '').trim()), 0);
  $('#confirm-edits').textContent = n ? `改了 ${n} 处，确认时会一起交给 Agent。` : '';
}

async function confirmStoryboard() {
  if (!task?.canConfirm || busy.confirm || justActed) return;
  const edits = readEdits();
  // 长片确认的是总纲：每一行是一章（整章讲稿 + 要点），上限和后端的总纲格式一致；普通片子每一行是一镜
  const outlineRows = task.long && !task.chapters;
  const [unit, text, note, maxText, maxNote] = outlineRows ? ['章', '讲稿', '要点', 6000, 300] : ['镜', '旁白', '画面描述', 600, 400];
  for (const [i, x] of edits.entries()) {
    if (!x.narration) return toast(`第 ${i + 1} ${unit}的${text}是空的，填一下再确认`, 'error');
    if ([...x.narration].length > maxText) return toast(`第 ${i + 1} ${unit}的${text}太长了，最多 ${maxText} 字`, 'error');
    if (!x.visual) return toast(`第 ${i + 1} ${unit}的${note}是空的，填一下再确认`, 'error');
    if ([...x.visual].length > maxNote) return toast(`第 ${i + 1} ${unit}的${note}太长了，最多 ${maxNote} 字`, 'error');
  }
  let body = {};
  if (edits.some(changedEdit)) {
    const { scenes: _omit, ...rest } = task.storyboard;
    body = {
      storyboard: {
        ...rest,
        scenes: edits.map(({ s, narration, visual }) => {
          const o = { id: s.id, title: s.title, narration, visual, duration: s.duration };
          if (s.skill) o.skill = s.skill;
          if (s.images?.length) o.images = s.images; // 用到的用户图片：改旁白和画面描述时保留
          return o;
        }),
      },
    };
  }
  const want = id;
  const btn = $('#confirm-btn');
  busy.confirm = true;
  btn.disabled = true;
  btn.textContent = '正在提交…';
  try {
    await api.post(`/tasks/${encodeURIComponent(want)}/confirm`, body);
    if (want !== id) return;
    justActed = true;
    $('#confirm-box').hidden = true;
    toast(task.long && !task.chapters ? '已确认总纲，各章开始制作' : '已确认分镜，Agent 开始生成');
    load();
  } catch (e) {
    if (e.status !== 401) toast(e.message, 'error');
    if (e.status === 409) load();
  } finally {
    busy.confirm = false;
    btn.disabled = false;
    btn.textContent = task.long && !task.chapters ? '确认总纲，开始制作' : '确认分镜，开始生成';
  }
}

/* ---------- 失败重试 ---------- */

async function retry() {
  if (!task?.canRetry || busy.retry || justActed) return;
  const want = id;
  busy.retry = true;
  renderAlert();
  try {
    await api.post(`/tasks/${encodeURIComponent(want)}/retry`);
    if (want !== id) return;
    justActed = true;
    toast('已让 Agent 修复后重试');
    load();
  } catch (e) {
    if (e.status !== 401) toast(e.message, 'error');
    if (e.status === 409) load();
  } finally {
    busy.retry = false;
    if (task) renderAlert();
  }
}

/* ---------- 左栏：Credit 用量（合计、按轮次小计；明细在弹窗里） ---------- */

function renderBilling() {
  const b = task.billing;
  const box = $('#usage-box');
  if (!b) { box.hidden = true; return; }
  const turns = Array.isArray(b.turns) ? b.turns : [];
  const key = JSON.stringify([b.credits, b.pending, turns.map(x => [x.turnId, x.label, x.credits, x.calls])]);
  if (key === sig.billing) return;
  sig.billing = key;
  box.hidden = false;
  $('#usage-total').textContent = fmt(b.credits);
  $('#usage-pending').hidden = !b.pending;
  const ul = $('#usage-turns');
  ul.innerHTML = turns.map(x => `<li><span>${esc(x.label || '—')}${x.calls ? `<small>${Number(x.calls)} 次调用</small>` : ''}</span><b>${fmt(x.credits)}</b></li>`).join('');
  ul.hidden = !turns.length;
}

/* ---------- 文件：各版本成片下载 ---------- */

function fileName(n, ext = 'mp4', suffix = '') {
  const t = taskTitle().replace(/[\\/:*?"<>|\s]+/g, '') || 'Slate';
  return `${t}_第${n}版${suffix}.${ext}`;
}

/** 3D 图片的文件：每个版本的 GLB，加上当前版本的多角度图、拆解图和 GIF 动图（打印文件在顶部按需导出） */
function renderModelFiles() {
  const vs = versions();
  const cv = currentVersion();
  const activeNow = ACTIVE.has(task.status);
  const ex = cv?.explode && typeof cv.explode === 'object' ? cv.explode : null;
  const key = JSON.stringify([vs.map(v => [v.n, v.at, keyOf(v.glb)]), cv?.n, (cv?.views || []).map(v => keyOf(v.url)), keyOf(ex?.image), keyOf(ex?.gif), activeNow, taskTitle()]);
  if (key === sig.files) return;
  sig.files = key;
  const li = (icon, name, meta, act) => `<li><svg class="ico"><use href="#${icon}"/></svg><div><b>${esc(name)}</b><small>${esc(meta)}</small></div>${act}</li>`;
  const link = (url, label) => { const href = safeUrl(url); return href ? `<a class="icon-btn" href="${esc(href)}" target="_blank" rel="noopener noreferrer" aria-label="${esc(label)}"><svg><use href="#i-download"/></svg></a>` : ''; };
  const rows = [];
  if (activeNow) {
    const next = (vs[0]?.n || 0) + 1;
    rows.push(`<li class="pending"><svg class="ico"><use href="#i-cube"/></svg><div><b>${esc(fileName(next, 'glb'))}</b><small>导出后可下载</small></div><button type="button" class="icon-btn" aria-label="第 ${next} 版还没做好" disabled><svg><use href="#i-download"/></svg></button></li>`);
  }
  for (const v of vs) {
    rows.push(li('i-cube', fileName(v.n, 'glb'), [`第 ${v.n} 版的模型`, dateTime(v.at)].filter(Boolean).join('，'),
      `<button type="button" class="icon-btn" data-dl="${v.n}" aria-label="下载第 ${v.n} 版 GLB"><svg><use href="#i-download"/></svg></button>`));
  }
  for (const v of cv?.views || []) rows.push(li('i-image', fileName(cv.n, 'png', `_${v.angle}度`), `第 ${cv.n} 版，${angleLabel(v.angle)}`, link(v.url, `下载${angleLabel(v.angle)}的图`)));
  if (ex?.image) rows.push(li('i-explode', fileName(cv.n, 'png', '_拆解图'), `第 ${cv.n} 版的拆解图，带零件名`, link(ex.image, `下载第 ${cv.n} 版的拆解图`)));
  if (ex?.gif) rows.push(li('i-explode', fileName(cv.n, 'gif', '_拆解'), `第 ${cv.n} 版的拆解动图`, link(ex.gif, `下载第 ${cv.n} 版的拆解 GIF 动图`)));
  $('#files').innerHTML = rows.join('');
  $('#files-empty').hidden = rows.length > 0;
}

function renderFiles() {
  if (is3d()) { renderModelFiles(); return; }
  const vs = versions();
  const activeNow = ACTIVE.has(task.status);
  const res = task.brief?.resolution || task.storyboard?.resolution || '';
  const key = JSON.stringify([vs.map(v => [v.n, v.dur, v.createdAt]), activeNow, taskTitle(), res]);
  if (key === sig.files) return;
  sig.files = key;
  const rows = [];
  if (activeNow) {
    const next = (vs[0]?.n || 0) + 1;
    rows.push(`<li class="pending"><svg class="ico"><use href="#i-film"/></svg><div><b>${esc(fileName(next))}</b><small>生成完成后可下载</small></div><button type="button" class="icon-btn" aria-label="第 ${next} 版还没生成好" disabled><svg><use href="#i-download"/></svg></button></li>`);
  }
  for (const v of vs) {
    const meta = [res, v.dur && durLabel(v.dur), dateTime(v.createdAt)].filter(Boolean).join('，');
    rows.push(`<li><svg class="ico"><use href="#i-film"/></svg><div><b>${esc(fileName(v.n))}</b><small>${esc(meta)}</small></div><button type="button" class="icon-btn" data-dl="${v.n}" aria-label="下载第 ${v.n} 版"><svg><use href="#i-download"/></svg></button></li>`);
  }
  $('#files').innerHTML = rows.join('');
  $('#files-empty').hidden = rows.length > 0;
}

async function download(n) {
  if (!task) return;
  // 预签名链接 1 小时有效：页面停留太久就先取一次新链接
  if (Date.now() - fetchedAt > 30 * 60 * 1000) {
    try {
      const prev = task;
      task = normalize(await api.get(`/tasks/${encodeURIComponent(id)}`));
      fetchedAt = Date.now();
      render(prev);
    } catch (e) {
      if (e.status === 401) return;
    }
  }
  const v = task && versionsOf(task).find(x => x.n === n);
  const href = v && safeUrl(is3d() ? v.glb : v.download || v.url);
  if (!href) { toast('这个版本暂时不能下载，稍后再试', 'error'); return; }
  const a = document.createElement('a');
  a.href = href;
  a.download = fileName(n, is3d() ? 'glb' : 'mp4');
  a.rel = 'noopener';
  document.body.append(a);
  a.click();
  a.remove();
  toast(`开始下载第 ${n} 版`);
}

/* ---------- 3D 图片：预览、多角度图、拆解、素材卡 ---------- */

/** 视频和 3D 图片用不同的中间区域；分镜脚本标签和修改范围只有视频有 */
function setLayout() {
  const m3d = is3d();
  if (sig.layout === m3d) return;
  sig.layout = m3d;
  $('#run-video').hidden = m3d;
  $('#run-m3d').hidden = !m3d;
  $('#t-script').hidden = m3d;
  $('#ask-scope').hidden = m3d;
  $('#ask-input').placeholder = m3d ? '告诉 Agent 要改什么，比如：提手改成棕色皮革' : '告诉 Agent 要改什么，比如：节奏再快一点，结尾停留 2 秒';
  $('#dl-btn span').textContent = m3d ? '下载 GLB' : '下载 MP4';
  if (!m3d) $('#print-btn').hidden = true;
  $('#files-empty').textContent = m3d ? '还没有成品。导出后，每个版本的 GLB、多角度图和拆解图都可以在这里下载；3D 打印文件在顶部导出。'
    : '还没有成片。生成完成后，每个版本的 MP4 都可以在这里下载。';
  if (m3d) {
    video.pause();
    if ($('#t-script').getAttribute('aria-selected') === 'true') selectTab($('#t-chat'), false);
  }
}

/** 「导出 3D 打印文件」：当前版本有打印源数据（printable）时才显示 */
function syncPrint() {
  const cv = is3d() ? currentVersion() : null;
  const btn = $('#print-btn');
  btn.hidden = cv?.printable !== true;
  if (cv) btn.title = `用第 ${cv.n} 版生成拓竹打印机能直接打开的 3MF 或 STL`;
}

/** 素材卡里有拆解步骤：打印时默认零件分开 */
const hasExplodeSteps = () => Array.isArray(task?.model?.asset?.explode?.steps) && task.model.asset.explode.steps.length > 0;

function printIt() {
  const cv = currentVersion();
  if (!task || !is3d() || cv?.printable !== true) return;
  openPrint({ taskId: id, v: cv.n, name: taskTitle(), explode: hasExplodeSteps() });
}

function disposeViewer() {
  viewer?.dispose();
  viewer = null;
}

function modelEmpty(title, text) {
  $('#m3d-empty').hidden = false;
  $('#m3d-empty-title').textContent = title;
  $('#m3d-empty-text').textContent = text;
  $('#m3d-empty-text').hidden = !text;
}

function renderModel() {
  const cv = currentVersion();
  // 同一个版本只加载一次模型；换版本时在同一个预览里换模型
  const key = cv ? `${id}|${cv.n}` : '';
  if (key !== sig.model) {
    sig.model = key;
    if (cv) {
      $('#m3d-empty').hidden = true;
      viewer ||= mountViewer($('#m3d-viewer'));
      const want = id, n = cv.n;
      viewer.load(() => api.get(`/tasks/${encodeURIComponent(want)}/module?v=${n}`), `「${taskTitle()}」第 ${n} 版的 3D 预览`);
    } else disposeViewer();
  }
  if (!cv) {
    const step = task.steps.find(x => x.state === 'running');
    if (task.status === 'queued') modelEmpty('任务在排队', '马上开始。导出后可以在这里拖动旋转查看。');
    else if (task.status === 'failed') modelEmpty('还没有模型', '生成失败了，可以让 Agent 修复后重试。');
    else modelEmpty('还没有模型', step ? `Agent 正在${step.label}。导出后可以在这里拖动旋转查看。` : '导出后可以在这里拖动旋转查看。');
  }
  renderViews(cv);
  renderExplode(cv);
  renderAsset();
}

/** 多角度图和对比图；签名链接每次轮询都会变，文件没变就不重绘。没有视频：老版本带的 turntable 不显示 */
function renderViews(cv) {
  const key = JSON.stringify(cv ? [cv.n, (cv.views || []).map(v => [v.angle, keyOf(v.url)]), keyOf(cv.comparison)] : null);
  if (key === sig.views) return;
  sig.views = key;
  $('#m3d-views-empty').hidden = !!cv;
  $('#m3d-views').innerHTML = (cv?.views || []).map(v => {
    const href = safeUrl(v.url);
    const label = esc(angleLabel(v.angle));
    return href ? `<li><a href="${esc(href)}" target="_blank" rel="noopener noreferrer"><img src="${esc(href)}" alt="${label}" loading="lazy"></a><span>${label}</span></li>` : '';
  }).join('');
  const cmp = cv && safeUrl(cv.comparison);
  $('#m3d-media').innerHTML = cmp ? `<figure><a href="${esc(cmp)}" target="_blank" rel="noopener noreferrer"><img src="${esc(cmp)}" alt="和参考照片的对比图" loading="lazy"></a><figcaption>和参考照片对比</figcaption></figure>` : '';
}

/** 拆解（这个版本的 explode 不是 null 时）：带零件名的拆解图、GIF 动图预览和下载。逐步看拆解用 3D 预览里的滑杆 */
function renderExplode(cv) {
  const ex = cv?.explode && typeof cv.explode === 'object' ? cv.explode : null;
  const img = ex && safeUrl(ex.image), gif = ex && safeUrl(ex.gif);
  const key = JSON.stringify(ex ? [cv.n, keyOf(img), keyOf(gif)] : null);
  if (key === sig.explode) return;
  sig.explode = key;
  const items = [];
  if (img) items.push(`<figure><a href="${esc(img)}" target="_blank" rel="noopener noreferrer"><img src="${esc(img)}" alt="第 ${cv.n} 版的拆解图，拆开的零件旁边标着名称" loading="lazy"></a><figcaption>拆解图，点开看大图</figcaption></figure>`);
  if (gif) {
    items.push(`<figure><img src="${esc(gif)}" alt="第 ${cv.n} 版的拆解动图：组装好、逐步拆开、停留、再合上" loading="lazy"><figcaption>拆解动图</figcaption></figure>`);
    items.push(`<p class="ex-dl"><a class="btn ghost small" href="${esc(gif)}" download="${esc(fileName(cv.n, 'gif', '_拆解'))}" rel="noopener"><svg><use href="#i-download"/></svg>下载 GIF 动图</a></p>`);
  }
  $('#m3d-ex').innerHTML = items.join('');
  $('#m3d-ex-box').hidden = !items.length;
}

function renderAsset() {
  const a = task.model?.asset;
  const key = JSON.stringify(a || null);
  if (key === sig.asset) return;
  sig.asset = key;
  $('#asset-edit').hidden = !a;
  $('#asset').innerHTML = a ? assetHtml(a) : '<p class="panel-empty">Agent 发布素材卡后显示在这里：名称、标签、零件、推荐拍法和局限。</p>';
}

async function editAsset() {
  const a = task?.model?.asset;
  if (!a) return;
  const want = id;
  const saved = await editLibItem('model3d', { id: want, name: a.name, tags: a.tags || [] });
  if (saved && want === id && active) load();
}

/* ---------- 标签页 ---------- */

const tabs = $$('.inspector .tabs [role=tab]');
function selectTab(t, focus = true) {
  tabs.forEach(x => {
    const sel = x === t;
    x.setAttribute('aria-selected', sel);
    x.tabIndex = sel ? 0 : -1;
    $('#' + x.getAttribute('aria-controls')).hidden = !sel;
  });
  if (focus) t.focus();
}

/* ---------- 事件 ---------- */

export function init() {
  // 记住左栏折叠块的展开状态（toggle 不冒泡，用捕获）
  $('#steps').addEventListener('toggle', e => { const k = e.target.dataset?.k; if (k) detailsOpen.set(k, e.target.open); }, true);

  tabs.forEach(t => {
    t.addEventListener('click', () => selectTab(t));
    t.addEventListener('keydown', e => {
      const shown = tabs.filter(x => !x.hidden); // 3D 任务没有分镜脚本标签
      const i = shown.indexOf(t);
      if (e.key === 'ArrowRight') selectTab(shown[(i + 1) % shown.length]);
      if (e.key === 'ArrowLeft') selectTab(shown[(i - 1 + shown.length) % shown.length]);
    });
  });

  // 播放器
  const togglePlay = () => {
    if (cur.mode === 'empty') return;
    if (video.paused || video.ended) video.play().catch(() => toast('这个视频暂时放不了，稍后再试', 'error'));
    else video.pause();
  };
  $('#play-btn').addEventListener('click', togglePlay);
  video.addEventListener('click', togglePlay);
  const setIcon = p => {
    const btn = $('#play-btn');
    btn.innerHTML = `<svg><use href="#i-${p ? 'pause' : 'play'}"/></svg>`;
    btn.setAttribute('aria-label', p ? '暂停' : '播放');
  };
  video.addEventListener('play', () => setIcon(true));
  video.addEventListener('pause', () => setIcon(false));
  video.addEventListener('emptied', () => setIcon(false));
  video.addEventListener('loadedmetadata', () => {
    if (pendingSeek != null) {
      video.currentTime = Math.max(0, Math.min(pendingSeek, (video.duration || pendingSeek) - 0.05));
      pendingSeek = null;
    }
    updateHead();
  });
  video.addEventListener('timeupdate', () => {
    if (cur.mode === 'version') {
      const s = sceneAt(video.currentTime);
      if (s && s.id !== sceneId) { sceneId = s.id; markCurrent(); updateTag(); }
    }
    updateHead();
  });
  video.addEventListener('ended', () => {
    if (cur.mode !== 'clip') return;
    const l = scenes();
    const i = sceneIndex(cur.sceneId);
    const next = l[i + 1];
    if (!next) return;
    if (next.clip?.url) { sceneId = next.id; autoplay = true; markCurrent(); renderPlayer(); } // 单镜预览：接着放下一镜
    else toast(`第 ${i + 2} 镜还在渲染，渲染好就能接着看`);
  });
  video.addEventListener('error', () => {
    if (!video.getAttribute('src') || cur.mode === 'empty') return;
    if (Date.now() - mediaRetryAt < 15000) { toast('视频加载失败，请刷新页面再试', 'error'); return; }
    // 预签名链接可能过期了：取一次最新数据，用新链接重新加载
    mediaRetryAt = Date.now();
    pendingSeek = video.currentTime || null;
    cur.key = null;
    load();
  });
  // 分镜条缩略图的链接过期时，换成最新的链接
  strip.addEventListener('error', e => {
    const v = e.target;
    if (v.tagName !== 'VIDEO' || v.dataset.retried) return;
    const s = sceneById(v.closest('.shot')?.dataset.id);
    if (s?.clip?.url && keyOf(s.clip.url) === keyOf(v.src) && s.clip.url !== v.src.replace(/#.*$/, '')) {
      v.dataset.retried = '1';
      v.src = s.clip.url + '#t=0.5';
    }
  }, true);

  scrub.addEventListener('click', e => {
    const r = scrub.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    if (cur.mode === 'version') { seek(ratio * timelineTotal()); return; }
    const s = sceneAt(ratio * totalDur());
    if (!s) { toast('还没有可以播放的画面'); return; }
    if (!s.clip?.url) { toast('这一段还没渲染好'); return; }
    const offset = ratio * totalDur() - s.start;
    sceneId = s.id;
    markCurrent();
    if (cur.mode === 'clip' && cur.sceneId === s.id) seek(offset);
    else { pendingSeek = offset; renderPlayer(); }
    updateHead();
  });

  strip.addEventListener('click', e => {
    const b = e.target.closest('.shot');
    const s = b && sceneById(b.dataset.id);
    if (s) selectScene(s);
  });

  $('#safe-btn').addEventListener('click', e => {
    const b = e.currentTarget;
    const on = b.getAttribute('aria-pressed') !== 'true';
    b.setAttribute('aria-pressed', on);
    $('#screen').classList.toggle('show-safe', on);
  });
  $('#fs-btn').addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else $('#screen').requestFullscreen?.().catch(() => toast('浏览器不允许全屏'));
  });

  // 版本和下载
  $('#version-select').addEventListener('change', e => {
    versionPick = Number(e.target.value);
    if (is3d()) { renderModel(); renderFiles(); } else renderPlayer();
    const cv = currentVersion();
    $('#dl-btn').title = cv ? `下载第 ${cv.n} 版${is3d() ? ' GLB' : ''}` : '';
    syncPrint();
  });
  $('#asset-edit').addEventListener('click', editAsset);
  $('#print-btn').addEventListener('click', printIt);
  $('#dl-btn').addEventListener('click', () => { const v = currentVersion(); if (v) download(v.n); });
  $('#files').addEventListener('click', e => {
    const b = e.target.closest('[data-dl]');
    if (b) download(Number(b.dataset.dl));
  });

  $('#usage-detail').addEventListener('click', () => { if (task) openUsage(id, taskTitle()); });

  // 提示条上的按钮
  $('#run-alert').addEventListener('click', e => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    if (b.dataset.act === 'retry') retry();
    if (b.dataset.act === 'show-script') selectTab($('#t-script'));
  });

  // 修改对话
  $('#scope-chip').addEventListener('click', e => { if (e.target.closest('button')) setScope(null); });
  $('#ask-form').addEventListener('submit', e => { e.preventDefault(); send(); });  // 不让表单真的提交（会刷新页面）
  $('#ask-input').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
  });

  // 分镜脚本
  $('#script').addEventListener('input', countEdits);
  $('#confirm-btn').addEventListener('click', confirmStoryboard);

  document.addEventListener('visibilitychange', () => {
    if (!active) return;
    if (document.hidden) clearTimeout(pollTimer);
    else if (!task || ACTIVE.has(task.status) || task.billing?.pending) load();
  });
}
