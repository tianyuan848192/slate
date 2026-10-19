/* 工作流模式的画板（#flow/<画板编号>，新建时是 #flow/new:tpl:<模板> 或 #flow/new:my:<我的工作流>）。docs/workflow-mode-design.md
   三种节点：文字（资料、剧本、分镜）、图片（3D 图片）、音画（配音、画面、合成）。文字和音画共用一个视频任务：
   - 运行文字节点 = 建视频任务（强制在分镜处停下）；在文字节点聊天 = 只改剧本和分镜；
   - 运行音画节点 = 确认分镜；出片以后再运行 = 重跑（POST /tasks/<id>/av，按最新的分镜和设置只重做变了的镜头）；
   - 图片节点就是 3D 图片任务（新做一个，或者引用素材库里的）。
   画板第一次运行节点时保存到服务端（kind=canvas），之后有改动就自动保存；"保存为工作流"存的是不带产出的模板（kind=template） */

import { $, $$, esc, toast, mss, safeUrl, openModal, closeModal, reduceMotion } from './util.js';
import { api, uploadFile } from './api.js';
import { loadSkills, skillById, skillName, categories, genreById, genreGroups, stylesOfGenre, BETA_HINT } from './catalog.js';
import { thumbArt } from './art.js';
import { mountViewer, heroView, angleLabel } from './viewer3d.js';
import { openLibPicker } from './libpick.js';
import { assetHtml } from './library.js';
import { TYPES, DEF, TEMPLATES } from './flowdefs.js';

const canvas = $('#wf-canvas'), world = $('#wf-world'), pnBody = $('#pn-body'), pnFoot = $('#pn-foot');
const POLL_MS = 2500;
const ACTIVE = new Set(['queued', 'running']);
const TEXT_STEPS = ['research', 'analyze', 'script', 'storyboard'];
const AV_STEPS = ['code', 'render', 'compose'];
const REF_EXT = ['pdf', 'docx', 'md', 'txt', 'csv', 'xlsx'];
const PHOTO_EXT = ['png', 'jpg', 'jpeg', 'webp'];
const REF_MAX = 10, LINK_MAX = 5, PHOTO_MAX = 4, PIC_MAX = 8;  // PIC_MAX：文字节点的普通图片
const DURS = [[15, '15 秒'], [30, '30 秒'], [60, '60 秒'], [90, '90 秒'], [180, '3 分钟']];
const SUGS = {
  text: ['开场换成一个更抓人的问题', '第 3 镜讲得太快了，拆成两镜', '整体语气再轻松一点'],
  image: ['把外壳改成蓝色', '提手做得更粗一点', '加一个能打开的电池盖'],
  av: ['第 2 镜画面太空了', '配音语速慢一点', '字幕再大一点'],
};
const ico = id => `<svg aria-hidden="true"><use href="#i-${id}"/></svg>`;

let W = null;            // 画板：{id, name, src（从哪个"我的工作流"打开的）, srcArg, savedAt, saveState, nodes, edges}
let T = new Map();       // 任务详情：任务编号 → GET /tasks/<id> 的结果
let V = { x: 0, y: 0, z: 1 };
let SEL = null, PN = null, TAB = 'cfg', PICK = null, PICKCAT = '';
let LINK = null, DRAG = null;
let active = false, pollTimer = 0, saveTimer = 0, openSeq = 0;
let viewer = null;
let voices = null;
let avVer = null;        // 音画节点产出页里选中的版本；null 跟随最新
const acting = new Set(); // 正在提交的节点
const nodeSig = new Map();
let bodySig = '';
const preview = new Audio();

const uid = (p = '') => p + Math.random().toString(36).slice(2, 10);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const strip = h => h.replace(/\?[^"'\s>]*/g, '');  // 签名链接每次轮询都会变：比较内容时去掉查询串
const node = k => W?.nodes.find(n => n.k === k);
const ofType = t => W.nodes.filter(n => n.type === t);
const label = n => (n.type === 'image' ? `图片 ${ofType('image').indexOf(n) + 1}` : TYPES[n.type].name);
const avOf = n => { const e = W.edges.find(x => x.from === n.k); return e ? node(e.to) : null; };
const linkedText = av => { const e = W.edges.find(x => x.to === av.k && x.port === 'text'); return e ? node(e.from) : null; };
const linkedImgs = av => W.edges.filter(x => x.to === av.k && x.port === 'img').map(x => node(x.from)).filter(Boolean);
const taskOf = n => { const t = n?.task ? T.get(n.task) : null; return t && !t.missing ? t : null; };
const busy = t => !!t && ACTIVE.has(t.status);
const sceneNo = id => parseInt(id, 10) || id;
const extOf = name => { const i = name.lastIndexOf('.'); return i > 0 ? name.slice(i + 1).toLowerCase() : ''; };
const videoTaskOf = n => (n.type === 'av' ? taskOf(linkedText(n)) : n.type === 'text' ? taskOf(n) : null);

/* ---------- 节点状态（都从任务详情推出来） ---------- */

function stepsOf(t, names) {
  const list = (t?.steps || []).filter(s => !names || names.includes(s.name));
  const now = list.findIndex(s => s.state === 'running');
  return { list, now, label: now >= 0 ? list[now].label : t?.status === 'queued' ? '排队中' : '准备中' };
}

const refSig = r => (r.kind === 'link' ? `link:${r.url}` : `file:${r.name}`);
function textDirty(n, t) {
  const r = t.request || {}, c = n.cfg;
  const mine = c.refs.filter(x => x.state !== 'error').map(refSig).sort().join('|');
  const theirs = (r.refs?.items || []).map(x => (x.kind === 'link' ? `link:${x.url}` : `file:${x.title || ''}`)).sort().join('|');
  const picSig = list => list.map(x => `${x.name}|${(x.desc || '').trim()}`).join('\n');
  if (picSig((c.pics || []).filter(x => x.state !== 'error')) !== picSig(r.images || [])) return true;
  return c.desc.trim() !== (r.description || '') || (c.genre || null) !== (r.genre?.id || null)
    || +c.dur !== +(r.options?.spec?.duration || 0) || !!c.web !== !!(r.refs ? r.refs.web : r.web_search)
    || (!!c.strict && c.refs.length > 0) !== !!r.refs?.strict || mine !== theirs;
}

function textInfo(n) {
  if (!n.task) return { st: 'idle' };
  const t = T.get(n.task);
  if (!t) return { st: 'loading' };
  if (t.missing) return { st: 'idle', missing: true };
  const nd = t.flow?.node || 'text';
  if (busy(t) && nd === 'text') return { st: 'running', t, steps: stepsOf(t, TEXT_STEPS) };
  if (t.status === 'failed' && nd === 'text') return { st: 'failed', t };
  if (!t.storyboard) return { st: busy(t) ? 'running' : 'failed', t, steps: stepsOf(t, TEXT_STEPS) };
  return { st: 'done', t, busyAv: busy(t), dirty: textDirty(n, t) };
}

function imgDirty(n, t) {
  const r = t.request || {};
  return n.cfg.desc.trim() !== (r.description || '') || !!n.cfg.explode !== !!r.explode || !!n.cfg.web !== !!r.web_search
    || n.cfg.photos.length !== (r.images || []).length;
}

function imageInfo(n) {
  if (!n.task) return { st: n.cfg.mode === 'lib' ? 'pick' : 'idle' };
  const t = T.get(n.task);
  if (!t) return { st: 'loading' };
  if (t.missing) return { st: n.cfg.mode === 'lib' ? 'pick' : 'idle', missing: true };
  const vs = t.model?.versions || [];
  const ver = vs.reduce((a, v) => Math.max(a, v.n), 0);
  if (busy(t)) return { st: 'running', t, ver, steps: stepsOf(t) };
  if (!ver) return { st: 'failed', t };
  return { st: 'done', t, ver, dirty: n.cfg.mode === 'new' && imgDirty(n, t), failed: t.status === 'failed' };
}

function avDiff(av, t) {
  const o = t.request?.options || {}, sp = o.spec || {}, a = av.cfg;
  const ids = [a.main, a.insert].filter(Boolean), was = o.skills?.enabled ? o.skills.ids || [] : [];
  return [[ids.join() !== was.join(), '画风'], [a.voice !== (sp.voice_id || 'auto'), '音色'], [a.ratio !== sp.ratio, '画幅'],
    [a.res !== sp.resolution, '清晰度'], [+a.fps !== +sp.fps, '帧率'], [!!a.sub !== !!sp.subtitles, '字幕'], [!!a.bgm !== !!sp.bgm, '背景音乐']]
    .filter(([d]) => d).map(([, k]) => k);
}

/** 连着的 3D 图片和任务里用的比：新连的、出了新版本的、断开的 */
function modelDiff(av, t) {
  const have = new Map((t.request?.models || []).map(m => [m.taskId, m.version]));
  const want = linkedImgs(av).map(n => ({ n, i: imageInfo(n) })).filter(x => x.i.st === 'done');
  const out = [];
  for (const { n, i } of want) {
    if (!have.has(n.task)) out.push(`新连了${label(n)}`);
    else if (have.get(n.task) !== i.ver) out.push(`${label(n)} 有新版本`);
  }
  const ids = new Set(want.map(x => x.n.task));
  const gone = [...have.keys()].filter(id => !ids.has(id)).length;
  if (gone) out.push(`去掉了 ${gone} 个 3D 图片`);
  return out;
}

function avInfo(n) {
  const tn = linkedText(n);
  if (!tn) return { st: 'block', why: '先把文字节点连到这里' };
  const ti = textInfo(tn);
  if (ti.st === 'idle') return { st: 'block', why: '先运行文字节点' };
  if (ti.st === 'loading') return { st: 'loading' };
  const t = ti.t;
  if (busy(t) && t.flow?.node === 'av') return { st: 'running', t, steps: stepsOf(t, AV_STEPS) };
  if (t.status === 'failed' && t.flow?.node === 'av') return { st: 'failed', t };
  if (ti.st === 'running') return { st: 'block', why: '等文字节点写完分镜', t };
  if (ti.st === 'failed') return { st: 'block', why: '文字节点没有完成，先在文字节点里重试', t };
  const wait = linkedImgs(n).filter(i => imageInfo(i).st !== 'done');
  if (!t.versions?.length) {
    if (wait.length) return { st: 'block', why: `等${wait.map(label).join('、')} 做好`, t };
    return { st: 'ready', t, late: modelDiff(n, t) };
  }
  const why = [];
  const ch = [...(t.flow?.changed || []), ...(t.flow?.removed || [])];
  if (ch.length) why.push(`文字节点改了第 ${ch.map(sceneNo).join('、')} 镜`);
  const ed = Object.keys(tn.cfg.edits || {});
  if (ed.length) why.push(`分镜表里直接改了第 ${ed.map(sceneNo).join('、')} 镜`);
  const d = avDiff(n, t);
  if (d.length) why.push(`改了${d.join('、')}`);
  why.push(...modelDiff(n, t));
  if (wait.length && why.length) return { st: 'block', why: `等${wait.map(label).join('、')} 做好再重跑`, t, video: true };
  return { st: why.length ? 'stale' : 'done', t, why };
}

const infoOf = n => (n.type === 'text' ? textInfo(n) : n.type === 'image' ? imageInfo(n) : avInfo(n));

function status(n) {
  const i = infoOf(n);
  if (acting.has(n.k)) return { cls: 'run', text: '正在提交' };
  if (i.st === 'loading') return { cls: '', text: '加载中' };
  if (i.st === 'running') return { cls: 'run', text: `运行中 · ${i.steps?.label || ''}` };
  if (i.st === 'failed') return { cls: 'fail', text: '没完成' };
  if (n.type === 'text') {
    if (i.st === 'done') return i.dirty ? { cls: 'stale', text: '设置有改动' } : { cls: 'ok', text: '分镜已就绪' };
    return { cls: '', text: '未运行' };
  }
  if (n.type === 'image') {
    if (i.st === 'pick') return { cls: '', text: '还没选' };
    if (i.st === 'done') return i.dirty ? { cls: 'stale', text: '设置有改动' } : { cls: 'ok', text: n.cfg.mode === 'lib' ? '已选好' : `已完成 v${i.ver}` };
    return { cls: '', text: '未运行' };
  }
  if (i.st === 'block') return { cls: 'block', text: i.video ? '需要重跑' : '还不能运行' };
  if (i.st === 'ready') return { cls: '', text: '可以运行' };
  if (i.st === 'stale') return { cls: 'stale', text: '需要重跑' };
  return { cls: 'ok', text: `成片 v${i.t.versions.length}` };
}

/* ---------- 画板：视图 ---------- */

function applyView() {
  world.style.transform = `translate(${V.x}px, ${V.y}px) scale(${V.z})`;
  const g = 22 * V.z;
  canvas.style.backgroundSize = `${g}px ${g}px`;
  canvas.style.backgroundPosition = `${V.x}px ${V.y}px`;
  $('#wf-z-val').textContent = Math.round(V.z * 100) + '%';
}
function toWorld(cx, cy) { const r = canvas.getBoundingClientRect(); return { x: (cx - r.left - V.x) / V.z, y: (cy - r.top - V.y) / V.z }; }
function zoomAt(cx, cy, z) {
  z = clamp(z, 0.3, 2);
  const p = toWorld(cx, cy), r = canvas.getBoundingClientRect();
  V.z = z; V.x = cx - r.left - p.x * z; V.y = cy - r.top - p.y * z;
  applyView();
}
function zoomCenter(f) { const r = canvas.getBoundingClientRect(); zoomAt(r.left + r.width / 2, r.top + r.height / 2, V.z * f); }
function fit() {
  const r = canvas.getBoundingClientRect();
  const els = $$('#wf-nodes .wf-node');
  if (!els.length) { V = { x: 280, y: 60, z: 1 }; applyView(); return; }
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  els.forEach(el => { const n = node(el.dataset.node); x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y); x1 = Math.max(x1, n.x + el.offsetWidth); y1 = Math.max(y1, n.y + el.offsetHeight); });
  const padL = 260, padR = PN ? 510 : 40, aw = r.width - padL - padR, ah = r.height - 90;
  const z = clamp(Math.min(aw / (x1 - x0), ah / (y1 - y0)), 0.45, 1);
  V = { z, x: padL + (aw - (x1 - x0) * z) / 2 - x0 * z, y: 30 + (ah - (y1 - y0) * z) / 2 - y0 * z };
  applyView();
}
// 面板盖住了选中的节点，就把画板挪一下，让节点露在面板左边、添加节点浮层右边
function ensureVisible(k) {
  const el = $(`#wf-nodes [data-node="${k}"]`);
  if (!el) return;
  const r = el.getBoundingClientRect(), c = canvas.getBoundingClientRect();
  const right = c.right - (PN ? 480 : 0) - 24, left = c.left + 252;
  let dx = 0, dy = 0;
  if (r.right > right) dx = right - r.right;
  if (r.left + dx < left) dx = left - r.left;
  if (r.top < c.top + 12) dy = c.top + 12 - r.top;
  else if (r.bottom > c.bottom - 44 && r.height < c.height - 60) dy = c.bottom - 44 - r.bottom;
  if (!dx && !dy) return;
  V.x += dx; V.y += dy;
  if (!reduceMotion) { world.style.transition = 'transform .25s ease-out'; setTimeout(() => { world.style.transition = ''; }, 260); }
  applyView();
}

/* ---------- 画板：节点卡片和连线 ---------- */

function cardBody(n) {
  const c = n.cfg, i = infoOf(n);
  const row = (k, v, miss) => `<div class="nd-row${miss ? ' is-missing' : ''}"><span class="k">${k}</span><span class="v">${esc(v)}</span></div>`;
  let h = '';
  if (n.type === 'text') {
    h += row('描述', c.desc.trim() || '还没写', !c.desc.trim());
    h += row('写作方法', genreById(c.genre)?.name || '交给 Agent 判断');
    h += row('时长', `${c.dur} 秒 · 资料 ${c.refs.length} 份${c.pics?.length ? ` · 图片 ${c.pics.length} 张` : ''}${c.web ? ' · 联网' : ''}${c.strict && c.refs.length ? ' · 强制引用' : ''}`);
    const sb = i.t?.storyboard;
    if (sb?.scenes?.length) {
      const chars = (i.t.script?.paragraphs || []).join('').length;
      const ed = Object.keys(c.edits || {});
      h += `<div class="nd-prev">${sb.scenes.length} 镜${chars ? ` · 剧本 ${chars} 字` : ''}${ed.length ? ` · <b>直接改了 ${ed.length} 镜</b>` : ''}<br>「${esc(sb.scenes[0].narration)}」</div>`;
    }
  } else if (n.type === 'image') {
    if (c.mode === 'lib') h += row('来源', c.lib ? `素材库：${c.lib.name}` : '素材库：还没选', !c.lib);
    else {
      h += row('来源', '新做一个');
      h += row('描述', c.desc.trim() || (c.photos.length ? `${c.photos.length} 张照片` : '还没写'), !c.desc.trim() && !c.photos.length);
      h += row('照片', `${c.photos.length} 张${c.explode ? ' · 做拆解' : ''}`);
    }
    const v = i.t && [...(i.t.model?.versions || [])].sort((a, b) => b.n - a.n)[0];
    const img = v && safeUrl(heroView(v.views));
    if (img) h += `<div class="nd-prev media"><img src="${esc(img)}" alt="" loading="lazy"><span class="nd-ver">v${v.n}</span></div>`;
  } else {
    const tn = linkedText(n), imgs = linkedImgs(n);
    h += `<div class="nd-row"><span class="port in${tn ? ' is-linked' : ''}" data-port-in="text"></span><span class="k">文字</span><span class="v">${tn ? '已连接' : '未连接'}</span></div>`;
    h += `<div class="nd-row"><span class="port in${imgs.length ? ' is-linked' : ''}" data-port-in="img"></span><span class="k">图片</span><span class="v">${imgs.length ? esc(imgs.map(label).join('、')) : '可选，最多 3 个'}</span></div>`;
    const picked = (i.t?.brief?.skills || [])[0]?.id;
    h += row('画风', (c.main ? skillName(c.main) : picked ? `Agent 选了${skillName(picked)}` : '交给 Agent 判断') + (c.insert ? ` + ${skillName(c.insert)}` : ''));
    const heard = c.voice === 'auto' && i.t?.brief?.voice;  // 交给 Agent 时显示它这一版选的音色
    h += row('配音', `${heard ? `Agent 选了${heard}` : voiceName(c.voice)} · ${c.ratio} · ${c.res}`);
    const vs = i.t?.versions || [];
    if (vs.length) {
      const last = vs.reduce((a, v) => (v.n > a.n ? v : a), vs[0]);
      h += `<div class="nd-prev media">${thumbArt(c.main || picked)}<span class="nd-ver">v${last.n} · ${mss(last.dur || 0)}</span></div>`;
    }
  }
  if (i.st === 'running' && i.steps) h += `<div class="nd-steps">${i.steps.list.map((s, k) => `<i class="${s.state === 'done' || s.state === 'skipped' ? 'done' : k === i.steps.now ? 'now' : ''}"></i>`).join('')}</div>`;
  if (i.st === 'failed') h += `<p class="nd-note err">${ico('alert')}<span>${esc(i.t?.failure?.message || '上一轮没有完成')}</span></p>`;
  if (n.type === 'av') {
    if (i.st === 'stale') h += `<p class="nd-note">${ico('alert')}<span>${esc(i.why.join('；'))}</span></p>`;
    else if (i.st === 'block') h += `<p class="nd-note dim">${ico('lock')}<span>${esc(i.why)}</span></p>`;
    else if (i.st === 'ready' && i.late?.length) h += `<p class="nd-note dim">${ico('alert')}<span>${esc(i.late.join('、'))}，运行时交给 Agent 调整相关镜头</span></p>`;
  }
  if (n.type === 'image' && !avOf(n)) h += `<p class="nd-note dim">${ico('alert')}<span>还没连到音画节点，做片时用不到</span></p>`;
  if (n.type !== 'av' && i.dirty) h += `<p class="nd-note">${ico('alert')}<span>设置改了，重新运行才生效</span></p>`;
  if (i.missing) h += `<p class="nd-note err">${ico('alert')}<span>关联的任务找不到了，重新运行会新建一个</span></p>`;
  return h;
}

/** 节点的主按钮：运行、重新运行、重跑、重试 */
function runBtn(n, small) {
  const cls = small ? 'btn small' : 'btn', i = infoOf(n);
  if (acting.has(n.k) || i.st === 'running') return `<button type="button" class="${cls} ghost" disabled>运行中…</button>`;
  if (i.st === 'loading') return '';
  if (i.st === 'failed') return `<button type="button" class="${cls} primary" data-retry>${ico('rotate')}重试</button>`;
  if (n.type === 'av') {
    if (i.st === 'block') return `<button type="button" class="${cls} primary" disabled>${ico('play')}${i.video ? '重跑' : '运行'}</button>`;
    if (i.st === 'ready') return `<button type="button" class="${cls} primary" data-run>${ico('play')}运行</button>`;
    return i.st === 'stale' ? `<button type="button" class="${cls} primary" data-run>${ico('rotate')}重跑</button>` : '';
  }
  if (n.type === 'image' && n.cfg.mode === 'lib') return '';
  if (i.st === 'done') return i.dirty ? `<button type="button" class="${cls} primary" data-run>${ico('rotate')}重新运行</button>` : '';
  return `<button type="button" class="${cls} primary" data-run>${ico('play')}运行</button>`;
}

function chatCount(n) { return msgsOf(n).filter(m => m.kind !== 'system').length; }

function nodeHTML(n) {
  const t = TYPES[n.type], st = status(n), sel = SEL?.k === 'node' && SEL.id === n.k, k = chatCount(n);
  return `<div class="wf-node${sel ? ' is-sel' : ''}" data-node="${n.k}" data-type="${n.type}" style="left:${n.x}px;top:${n.y}px">
    <div class="nd-head"><span class="ni ni-${n.type}">${ico(t.icon)}</span>
      <span class="nd-title"><b>${esc(label(n))}</b><small>${t.sub}</small></span>
      <span class="st ${st.cls}"><i></i>${esc(st.text)}</span></div>
    <div class="nd-body">${cardBody(n)}</div>
    <div class="nd-foot">${runBtn(n, true)}<span class="sp"></span><button type="button" class="nd-chat" data-open-chat>${ico('chat')}${k ? `对话 ${k}` : '对话'}</button></div>
    ${n.type !== 'av' ? '<span class="port out" data-port-out title="拖到音画节点上连线"></span>' : ''}
  </div>`;
}

function portPos(el) { const r = el.getBoundingClientRect(); return toWorld(r.left + r.width / 2, r.top + r.height / 2); }
const curve = (p, q) => { const dx = Math.max(50, Math.abs(q.x - p.x) * 0.5); return `M${p.x} ${p.y}C${p.x + dx} ${p.y} ${q.x - dx} ${q.y} ${q.x} ${q.y}`; };

function renderEdges() {
  let h = '';
  for (const e of W.edges) {
    const a = $(`#wf-nodes [data-node="${e.from}"] [data-port-out]`), b = $(`#wf-nodes [data-node="${e.to}"] [data-port-in="${e.port}"]`);
    if (!a || !b) continue;
    const p = portPos(a), q = portPos(b), d = curve(p, q), to = node(e.to), from = node(e.from);
    const ti = avInfo(to);
    const cls = ti.st === 'running' || (e.port === 'text' && textInfo(from).st === 'running') ? ' is-flow' : ti.st === 'stale' ? ' is-stale' : '';
    const sel = SEL?.k === 'edge' && SEL.id === e.id;
    h += `<path class="e-hit" data-edge="${e.id}" d="${d}"><title>${esc(label(from))} → ${esc(label(to))}：点一下选中，再点 × 删除</title></path><path class="e${cls}${sel ? ' is-sel' : ''}" d="${d}"/>`;
    if (sel) h += `<g class="e-del" data-edge-del="${e.id}" transform="translate(${(p.x + q.x) / 2} ${(p.y + q.y) / 2})"><circle r="11"/><path d="M-4 -4L4 4M4 -4L-4 4"/></g>`;
  }
  if (LINK) h += `<path class="e is-temp${LINK.ok === false ? ' is-bad' : ''}" d="${curve(LINK.p, LINK.q)}"/>`;
  $('#wf-edges').innerHTML = h;
}

/** 节点卡片：内容没变的不重画（运行中每 2.5 秒轮询一次，整块重画会闪） */
function renderNodes() {
  if (!W) return;
  const host = $('#wf-nodes'), keep = new Set();
  for (const n of W.nodes) {
    keep.add(n.k);
    const html = nodeHTML(n), sig = strip(html);
    const el = host.querySelector(`[data-node="${n.k}"]`);
    if (el && nodeSig.get(n.k) === sig) continue;
    const tmp = document.createElement('div');
    tmp.innerHTML = html;
    if (el) el.replaceWith(tmp.firstElementChild); else host.append(tmp.firstElementChild);
    nodeSig.set(n.k, sig);
  }
  for (const el of $$('.wf-node', host)) if (!keep.has(el.dataset.node)) { nodeSig.delete(el.dataset.node); el.remove(); }
  renderEdges();
  for (const [t, d] of Object.entries(TYPES)) {
    const k = ofType(t).length;
    $(`#view-flow [data-count="${t}"]`).textContent = `${k}/${d.max}`;
    $(`#view-flow [data-add="${t}"]`).disabled = k >= d.max;
  }
}

const hhmm = ms => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
function renderTop() {
  if (!W) return;
  if (document.activeElement !== $('#wf-name')) $('#wf-name').value = W.name;
  const s = $('#wf-saved');
  s.textContent = !W.id ? '还没运行过，离开后不保留' : W.saveState === 'saving' ? '正在保存…'
    : W.saveState === 'error' ? '自动保存没成功，稍后再试' : `已自动保存 ${hhmm(W.savedAt || Date.now())}`;
  s.classList.toggle('is-warn', !W.id || W.saveState === 'error');
}

function renderAll() {
  renderNodes();
  renderTop();
  if (PN) renderPanel(false);
}

/* ---------- 保存 ---------- */

/** 存到服务端的画板内容。template=true 时是"我的工作流"：不带任务、上传记录（会过期）和分镜表里改的字 */
function docOf(template = false) {
  return {
    nodes: W.nodes.map(n => {
      const c = { ...n.cfg };
      if (n.type === 'text') {
        c.refs = c.refs.filter(r => r.kind !== 'file' || (!template && r.state === 'done' && r.uploadId))
          .map(r => (r.kind === 'file' ? { kind: 'file', name: r.name, size: r.size, uploadId: r.uploadId }
            : r.kind === 'library' ? { kind: 'library', fileId: r.fileId, name: r.name, size: r.size } : { kind: 'link', url: r.url }));
        c.edits = template ? {} : { ...(c.edits || {}) };
        // 图片：上传的要传完、有上传记录；"我的工作流"不存图片（和照片一样）
        c.pics = template ? [] : (c.pics || []).filter(p => p.kind !== 'file' || (p.state === 'done' && p.uploadId))
          .map(p => ({ kind: p.kind, name: p.name, size: p.size, desc: p.desc || '', ...(p.kind === 'file' ? { uploadId: p.uploadId } : { fileId: p.fileId, url: p.url }) }));
      }
      if (n.type === 'image') c.photos = template ? [] : c.photos.filter(p => p.state === 'done' && p.uploadId).map(p => ({ name: p.name, size: p.size, uploadId: p.uploadId }));
      return { k: n.k, type: n.type, x: Math.round(n.x), y: Math.round(n.y), cfg: c, ...(n.task && !template ? { task: n.task } : {}) };
    }),
    edges: W.edges.map(e => [e.from, e.to, e.port]),
  };
}

const defaultName = () => (ofType('text')[0]?.cfg.desc.trim().replace(/\s+/g, ' ').slice(0, 16)) || '未命名工作流';

function persistSoon() {
  if (!W?.id) { renderTop(); return; }
  clearTimeout(saveTimer);
  saveTimer = setTimeout(persistNow, 800);
}
async function persistNow() {
  clearTimeout(saveTimer);
  saveTimer = 0;
  if (!W?.id) return;
  const w = W;
  w.saveState = 'saving'; renderTop();
  try {
    const r = await api.patch(`/flows/${encodeURIComponent(w.id)}`, { name: w.name || defaultName(), doc: docOf() });
    w.savedAt = r?.updatedAt || Date.now(); w.saveState = '';
  } catch (e) {
    w.saveState = 'error';
    if (e.status !== 401 && W === w) saveTimer = setTimeout(persistNow, 8000);
  }
  if (W === w) renderTop();
}

/** 第一次运行节点前，画板要先存到服务端（任务记着画板编号，任务页能回到这里） */
async function ensureCanvas() {
  if (W.id) return W.id;
  const r = await api.post('/flows', { kind: 'canvas', name: W.name || defaultName(), doc: docOf() });
  W.id = r.id; W.savedAt = r.updatedAt || Date.now(); W.srcArg = null;
  history.replaceState(null, '', '#flow/' + encodeURIComponent(r.id));  // 换成画板自己的地址，刷新后还能打开（不触发 hashchange）
  renderTop();
  return W.id;
}
function changed() { persistSoon(); renderNodes(); }

/* ---------- 增删节点和连线 ---------- */

function addNode(type, x, y) {
  const d = TYPES[type];
  if (ofType(type).length >= d.max) { toast(`最多 ${d.max} 个${d.name}节点`); return; }
  const n = { k: uid('n'), type, x: Math.round(x), y: Math.round(y), cfg: DEF[type](), task: null };
  W.nodes.push(n);
  // 文字和音画只有一对，加了就自动连上；图片节点让用户自己连
  const t = ofType('text')[0], av = ofType('av')[0];
  if (t && av && !linkedText(av) && type !== 'image') W.edges.push({ id: uid('e'), from: t.k, to: av.k, port: 'text' });
  changed();
  select({ k: 'node', id: n.k });
  if (type === 'image') toast('加好了。从图片节点右边的圆点拖到音画节点上，做片时才会用到它');
}
// 点一下添加：放在看得见的区域中间，和已有节点重叠就往外找空位
function addNodeCenter(type) {
  const r = canvas.getBoundingClientRect();
  const c = toWorld(r.left + 252 + (r.width - 252 - (PN ? 480 : 0)) / 2, r.top + r.height / 2);
  const boxes = $$('#wf-nodes .wf-node').map(el => { const n = node(el.dataset.node); return [n.x - 24, n.y - 24, n.x + el.offsetWidth + 24, n.y + el.offsetHeight + 24]; });
  const w = 300, h = 240, free = (x, y) => !boxes.some(([a, b, c2, d]) => x < c2 && x + w > a && y < d && y + h > b);
  let best = [c.x - w / 2, c.y - h / 2];
  search: for (let ring = 0; ring < 12; ring++) {
    for (let i = 0; i < Math.max(1, ring * 8); i++) {
      const a = (i / Math.max(1, ring * 8)) * Math.PI * 2, x = c.x - w / 2 + Math.cos(a) * ring * 70, y = c.y - h / 2 + Math.sin(a) * ring * 70;
      if (free(x, y)) { best = [x, y]; break search; }
    }
  }
  addNode(type, best[0], best[1]);
}

function canLink(from, to, port) {
  if (to.type !== 'av') return '只能连到音画节点';
  if (W.edges.some(e => e.from === from.k && e.to === to.k)) return '已经连过了';
  if (port === 'img' && linkedImgs(to).length >= 3) return '一个音画节点最多连 3 个图片';
  if (port === 'text' && linkedText(to)) return '音画节点已经连着文字节点了';
  if (avInfo(to).st === 'running') return '音画节点运行中，等这一轮做完再连';
  return '';
}
function removeEdge(id) {
  const e = W.edges.find(x => x.id === id);
  if (!e) return;
  if (avInfo(node(e.to)).st === 'running') { toast('音画节点运行中，等这一轮做完再改连线'); return; }
  W.edges = W.edges.filter(x => x !== e);
  SEL = null;
  changed();
}
function delNode(k) {
  const n = node(k);
  if (!n) return;
  const i = infoOf(n);
  if (i.st === 'running' || acting.has(k)) { toast('运行中的节点不能删除'); return; }
  const msg = n.type === 'text' && n.task ? '删除文字节点？音画节点会跟着断开这个视频任务。任务和成片还在"任务"页里。'
    : n.task && n.type === 'image' && n.cfg.mode === 'new' ? `删除${label(n)}？做好的 3D 图片还在素材库里。` : '';
  if (msg && !confirm(msg)) return;
  W.nodes = W.nodes.filter(x => x !== n);
  W.edges = W.edges.filter(e => e.from !== k && e.to !== k);
  select(null);
  changed();
}

function select(s) {
  SEL = s;
  if (s?.k === 'node') {
    if (PN !== s.id) { TAB = 'cfg'; PICK = null; avVer = null; }
    openPanel(s.id);
  } else closePanel();
  renderNodes();
  if (s?.k === 'node') ensureVisible(s.id);
}

/* ---------- 画板：鼠标 ---------- */

function begin(e, onMove, onUp) { DRAG = { sx: e.clientX, sy: e.clientY, moved: false, onMove, onUp }; canvas.setPointerCapture(e.pointerId); }
function endDrag(e) { if (!DRAG) return; const d = DRAG; DRAG = null; d.onUp(e, d.moved); }

function startPan(e) {
  const ox = V.x, oy = V.y;
  canvas.classList.add('is-panning');
  begin(e, (ev, dx, dy) => { V.x = ox + dx; V.y = oy + dy; applyView(); },
    (ev, moved) => { canvas.classList.remove('is-panning'); if (!moved) select(null); });
}
function startNodeDrag(e, k) {
  const n = node(k), ox = n.x, oy = n.y;
  begin(e, (ev, dx, dy) => {
    n.x = Math.round(ox + dx / V.z); n.y = Math.round(oy + dy / V.z);
    const el = $(`#wf-nodes [data-node="${k}"]`);  // 运行中的节点会重画，每次重新取
    if (el) { el.style.left = n.x + 'px'; el.style.top = n.y + 'px'; el.classList.add('is-drag'); }
    renderEdges();
  }, (ev, moved) => { if (moved) changed(); else select({ k: 'node', id: k }); });
}
function linkTarget(ev) {
  const nd = document.elementFromPoint(ev.clientX, ev.clientY)?.closest?.('.wf-node');
  const to = nd && node(nd.dataset.node);
  if (!to || to === LINK.from) return null;
  const port = LINK.from.type === 'text' ? 'text' : 'img', msg = canLink(LINK.from, to, port);
  return { to, port, ok: !msg, msg };
}
function hilite(tg) {
  $$('#wf-nodes .port.in.is-ok, #wf-nodes .wf-node.is-drop').forEach(el => el.classList.remove('is-ok', 'is-drop'));
  if (!tg?.ok) return;
  const nd = $(`#wf-nodes [data-node="${tg.to.k}"]`);
  nd?.classList.add('is-drop');
  nd?.querySelector(`[data-port-in="${tg.port}"]`)?.classList.add('is-ok');
}
function startLink(e, el) {
  const from = node(el.closest('.wf-node').dataset.node), p = portPos(el);
  LINK = { from, p, q: p, ok: null };
  begin(e, ev => { LINK.q = toWorld(ev.clientX, ev.clientY); const tg = linkTarget(ev); LINK.ok = tg ? tg.ok : null; hilite(tg); renderEdges(); },
    (ev, moved) => {
      const tg = moved ? linkTarget(ev) : null;
      hilite(null); LINK = null;
      if (tg?.ok) { W.edges.push({ id: uid('e'), from: from.k, to: tg.to.k, port: tg.port }); changed(); if (PN) renderPanel(true); }
      else { if (tg?.msg) toast(tg.msg); else if (!moved) toast('按住圆点拖到音画节点上，就连上了'); renderEdges(); }
    });
}

/* ---------- 运行节点 ---------- */

function refPayload(r) {
  if (r.kind === 'file') return { kind: 'file', uploadId: r.uploadId, name: r.name };
  if (r.kind === 'library') return { kind: 'library', fileId: r.fileId };
  return { kind: 'link', url: r.url };
}
const doneImages = av => (av ? linkedImgs(av).filter(i => imageInfo(i).st === 'done').map(i => i.task) : []);

const picPayload = p => (p.kind === 'file' ? { kind: 'file', uploadId: p.uploadId, name: p.name, desc: (p.desc || '').trim() }
  : { kind: 'library', fileId: p.fileId, desc: (p.desc || '').trim() });

function textPayload(n) {
  const c = n.cfg, av = avOf(n), a = av?.cfg || DEF.av(), ids = [a.main, a.insert].filter(Boolean);
  return {
    mode: 'advanced', flow: W.id, description: c.desc.trim(), web_search: c.web, genre: c.genre || null,
    refs: { web: c.web, strict: !!c.strict && c.refs.length > 0, items: c.refs.map(refPayload) },
    images: (c.pics || []).map(picPayload),
    models: doneImages(av),
    options: {
      skills: { enabled: ids.length > 0, ids },
      spec: { enabled: true, ratio: a.ratio, duration: +c.dur, resolution: a.res, fps: +a.fps, voice: true, voice_id: a.voice, subtitles: a.sub, bgm: a.bgm },
      confirm_storyboard: true,
    },
  };
}

/** 分镜表里直接改过的旁白：拼成一份完整分镜交给 Agent（格式和确认分镜时的一样）；没改过时返回 null */
function editedStoryboard(tn) {
  const t = taskOf(tn), ed = tn?.cfg.edits || {};
  if (!t?.storyboard || !Object.keys(ed).length) return null;
  const { title, ratio, resolution, fps, bgm, caption_style: cs } = t.storyboard;
  return {
    title, ratio, resolution, fps, ...(bgm !== undefined ? { bgm } : {}), ...(cs ? { caption_style: cs } : {}),
    scenes: t.storyboard.scenes.map(s => ({ id: s.id, title: s.title, narration: ed[s.id] ?? s.narration, visual: s.visual, duration: s.duration, ...(s.skill ? { skill: s.skill } : {}) })),
  };
}

function avPayload(av, extra = {}) {
  const a = av.cfg, body = {
    skills: { ids: [a.main, a.insert].filter(Boolean) },
    spec: { ratio: a.ratio, resolution: a.res, fps: +a.fps, voice_id: a.voice, subtitles: a.sub, bgm: a.bgm },
    models: doneImages(av), ...extra,
  };
  const sb = editedStoryboard(linkedText(av));
  if (sb) body.storyboard = sb;
  return body;
}

async function act(n, fn, ok) {
  if (acting.has(n.k)) return;
  acting.add(n.k);
  renderNodes(); if (PN === n.k) renderPanel(false);
  try {
    await fn();
    await persistNow();
    if (ok) toast(ok);
  } catch (e) {
    if (e.status !== 401) toast(e.message, 'error');
  } finally {
    acting.delete(n.k);
    poll(true);
  }
}

function need(msg, n) { toast(msg, 'error'); select({ k: 'node', id: n.k }); TAB = 'cfg'; renderPanel(true); }

function run(n) {
  const i = infoOf(n);
  if (n.type === 'text') {
    if (!n.cfg.desc.trim()) return need('先在设置里写一段描述', n);
    if (n.cfg.refs.some(r => r.state === 'uploading')) return toast('还有资料在上传，等上传完成再运行');
    if (n.cfg.refs.some(r => r.state === 'error')) return need('有资料没有上传成功，移除后再运行', n);
    const pics = n.cfg.pics || [];
    if (pics.some(p => p.state === 'uploading')) return toast('还有图片在上传，等上传完成再运行');
    if (pics.some(p => p.state === 'error')) return need('有图片没有上传成功，移除后再运行', n);
    const bare = pics.find(p => !(p.desc || '').trim());
    if (bare) return need(`给图片「${bare.name}」写一句描述：这是什么、想在片子里怎么用`, n);
    const video = avOf(n) && taskOf(n)?.versions?.length;
    if (i.st === 'done' && !confirm(`按新设置重新运行会新建一个任务，重写剧本和分镜${video ? '，音画节点也要重新出片' : ''}。原来的任务和成片还在"任务"页里。继续吗？`)) return;
    act(n, async () => {
      await ensureCanvas();
      const r = await api.post('/tasks', textPayload(n));
      n.task = r.id; n.cfg.edits = {};
    }, '文字节点开始运行：资料整理 → 需求分析 → 写剧本 → 写分镜');
  } else if (n.type === 'image') {
    if (n.cfg.mode === 'lib') return;
    if (!n.cfg.desc.trim()) return need('先写一段描述：要做什么物体、长什么样', n);
    if (n.cfg.photos.some(p => p.state === 'uploading')) return toast('还有照片在上传，等上传完成再运行');
    if (n.cfg.photos.some(p => p.state === 'error')) return need('有照片没有上传成功，移除后再运行', n);
    if (i.st === 'done' && !confirm('按新设置重新运行会新做一个 3D 图片（原来的还在素材库里）。继续吗？')) return;
    act(n, async () => {
      await ensureCanvas();
      const r = await api.post('/tasks', { product: 'model3d', flow: W.id, description: n.cfg.desc.trim(), web_search: n.cfg.web, explode: n.cfg.explode,
        images: n.cfg.photos.map(p => p.uploadId) });
      n.task = r.id;
    }, `${label(n)} 开始运行`);
  } else {
    if (i.st === 'block') return toast(i.why);
    const tn = linkedText(n);
    act(n, async () => {
      const r = await api.post(`/tasks/${encodeURIComponent(tn.task)}/av`, avPayload(n));
      tn.cfg.edits = {};
      if (r?.changes?.length && i.st === 'ready') toast(`带上了 ${r.changes.length} 处改动`);
    }, i.st === 'stale' ? '开始重跑：只重做变了的镜头' : '音画节点开始运行：配音 → 写画面 → 渲染 → 合成');
  }
}

function retryNode(n) {
  const t = n.type === 'image' ? taskOf(n) : videoTaskOf(n);
  if (!t) return;
  act(n, () => api.post(`/tasks/${encodeURIComponent(t.id)}/retry`), 'Agent 开始修复，然后继续');
}

/* ---------- 节点对话 ---------- */

function msgsOf(n) {
  if (n.type === 'image') return taskOf(n)?.messages || [];
  const t = videoTaskOf(n);
  return (t?.messages || []).filter(m => (m.node || 'text') === n.type);
}

function chatBlock(n) {
  if (acting.has(n.k)) return '正在提交，稍等';
  if (n.type === 'image') {
    if (n.cfg.mode === 'lib') return '素材库里的 3D 图片不在这里改。要改的话，把来源换成"新做一个"';
    const i = imageInfo(n);
    if (i.st === 'running') return '这个节点正在运行，等这一轮做完再说';
    return i.st === 'done' ? '' : '先运行这个节点，3D 图片做好以后可以在这里改';
  }
  const t = videoTaskOf(n);
  if (!t) return n.type === 'text' ? '先运行文字节点，Agent 写好剧本和分镜以后可以在这里改' : '出片以后可以在这里改画面和声音';
  if (busy(t)) return (t.flow?.node || 'text') === n.type ? '这个节点正在运行，等这一轮做完再说' : '文字和音画共用一个任务，等另一个节点这一轮做完';
  if (t.status === 'failed') return '上一轮没有完成，先点"重试"';
  if (n.type === 'text' && !t.storyboard) return '分镜还没写好';
  if (n.type === 'av' && !t.versions?.length) return '出片以后可以在这里改画面和声音。还没出片时，在文字节点里改剧本和分镜';
  return '';
}

function send(n, text) {
  text = text.trim();
  if (!text) return;
  const b = chatBlock(n);
  if (b) { toast(b); return; }
  if (n.type === 'image') return act(n, () => api.post(`/tasks/${encodeURIComponent(n.task)}/messages`, { text }), '收到，Agent 开始修改');
  const tn = n.type === 'text' ? n : linkedText(n), t = taskOf(tn);
  if (n.type === 'text') {
    const sb = editedStoryboard(tn);
    return act(n, async () => {
      await api.post(`/tasks/${encodeURIComponent(t.id)}/messages`, { text, node: 'text', ...(sb ? { storyboard: sb } : {}) });
      tn.cfg.edits = {};
    }, '收到，Agent 开始改剧本和分镜');
  }
  // 音画节点有还没同步到成片的改动时，这条消息和改动一起重跑；否则就是平常的修改
  if (avInfo(n).st === 'stale') {
    return act(n, async () => { await api.post(`/tasks/${encodeURIComponent(t.id)}/av`, avPayload(n, { note: text })); tn.cfg.edits = {}; }, '收到，连同其他改动一起重跑');
  }
  return act(n, () => api.post(`/tasks/${encodeURIComponent(t.id)}/messages`, { text, node: 'av' }), '收到，Agent 开始修改');
}

/* ---------- 节点面板 ---------- */

function openPanel(k) { PN = k; $('#wf-panel').hidden = false; renderPanel(true); }
function closePanel() { PN = null; $('#wf-panel').hidden = true; disposeViewer(); preview.pause(); }
function disposeViewer() { viewer?.dispose(); viewer = null; }

function subOf(n) {
  const t = n.type === 'image' ? taskOf(n) : videoTaskOf(n);
  if (n.type === 'image') return n.cfg.mode === 'lib' ? '引用素材库里的 3D 图片，不新建任务' : `单独的 3D 图片任务${t ? `「${t.title || ''}」` : ''}`;
  return `${n.type === 'text' ? '和音画节点' : '和文字节点'}共用一个视频任务${t ? `「${t.title || ''}」` : ''}、同一个 Agent 会话`;
}

function renderPanel(force) {
  const n = node(PN);
  if (!n) { closePanel(); return; }
  const st = status(n), k = chatCount(n), t = n.type === 'image' ? taskOf(n) : videoTaskOf(n);
  $('#pn-icon').className = `ni ni-${n.type}`;
  $('#pn-icon').innerHTML = ico(TYPES[n.type].icon);
  $('#pn-title').innerHTML = `${esc(label(n))}<span class="st ${st.cls}"><i></i>${esc(st.text)}</span>`;
  $('#pn-sub').textContent = subOf(n);
  $('#pn-chat-n').textContent = k ? ` ${k}` : '';
  const open = $('#pn-open');
  open.hidden = !t;
  if (t) open.href = `#run/${encodeURIComponent(t.id)}`;
  $$('#pn-tabs [data-tab]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === TAB)));

  // 正文：内容没变就不重画；设置页里正在输入时也不重画（轮询不能打断输入）
  const html = TAB === 'cfg' ? cfgHTML(n) : TAB === 'out' ? outHTML(n) : chatHTML(n);
  const sig = `${PN}|${TAB}|${strip(html)}`;
  const ae = document.activeElement;
  const typing = pnBody.contains(ae) && ae.matches('input:not([type=radio]):not([type=checkbox]), textarea, select');
  if (force || (sig !== bodySig && !typing)) {
    const keep = sig.split('|').slice(0, 2).join('|') === bodySig.split('|').slice(0, 2).join('|') ? pnBody.scrollTop : 0;
    const bottom = pnBody.scrollHeight - pnBody.scrollTop - pnBody.clientHeight < 60;
    disposeViewer();
    pnBody.innerHTML = html;
    bodySig = sig;
    mountModel(n);
    pnBody.scrollTop = TAB === 'chat' && (bottom || !keep) ? pnBody.scrollHeight : keep;
  }
  if (TAB === 'chat') {
    if (pnFoot.dataset.key !== n.k) { pnFoot.innerHTML = chatFoot(n); pnFoot.dataset.key = n.k; }
    const b = chatBlock(n);
    $('#wf-ask').disabled = !!b;
    $('#wf-ask-send').disabled = !!b;
    $$('[data-sug]', pnFoot).forEach(x => { x.disabled = !!b; });
    $('#wf-ask').placeholder = b || { text: '比如：第 3 镜讲得太快了', image: '比如：把外壳改成蓝色', av: '比如：第 2 镜画面太空了' }[n.type];
  } else {
    const f = runFoot(n);
    if (pnFoot.dataset.key !== `run:${strip(f)}`) { pnFoot.innerHTML = f; pnFoot.dataset.key = `run:${strip(f)}`; }
  }
}

function runFoot(n) {
  const i = infoOf(n);
  let p = '', cls = '', extra = '';
  if (acting.has(n.k)) p = '正在提交…';
  else if (i.st === 'running') p = `正在${i.steps?.label || '处理'}${i.steps?.now >= 0 ? `（第 ${i.steps.now + 1}/${i.steps.list.length} 步）` : ''}`;
  else if (i.st === 'failed') { cls = 'err'; p = `${i.t?.failure?.message || '上一轮没有完成'}。点"重试"让 Agent 修复后继续。`; }
  else if (n.type === 'text') {
    if (i.st !== 'done') p = 'Agent 读资料、写剧本和分镜，写完停下来给你看。大约 4～8 分钟。';
    else if (i.dirty) { cls = 'warn'; p = '设置改了。重新运行会新建一个任务，按新设置重写剧本和分镜。'; }
    else if (i.busyAv) p = '音画节点正在出片。';
    else p = '要改剧本和分镜，在"对话"里说，或者在"产出"里直接改旁白。';
  } else if (n.type === 'image') {
    if (n.cfg.mode === 'lib') p = n.cfg.lib ? '从素材库选的 3D 图片不用运行，连到音画节点就能用。' : '从上面选一个素材库里的 3D 图片。';
    else if (i.st !== 'done') p = '和文字节点可以同时跑。大约 7～13 分钟。';
    else if (i.dirty) { cls = 'warn'; p = '设置改了。重新运行会新做一个 3D 图片。'; }
    else p = '要改模型，在"对话"里说，每改一次出一个新版本。';
  } else if (i.st === 'block') p = i.why;
  else if (i.st === 'ready') p = `相当于确认分镜：先配音，再写画面、渲染，最后合成。大约 8～15 分钟。${i.late?.length ? `${i.late.join('、')}，会一起交给 Agent。` : ''}`;
  else if (i.st === 'stale') { cls = 'warn'; p = `${i.why.join('；')}。重跑只重做受影响的镜头，没变的直接复用。`; }
  else if (i.st === 'done') {
    p = '要改画面和声音，在"对话"里说。';
    const v = [...(i.t.versions || [])].sort((a, b) => b.n - a.n)[0];
    const href = v && safeUrl(v.download);
    if (href) extra = `<a class="btn ghost" href="${esc(href)}" download>${ico('download')}下载成片</a>`;
  }
  return `${runBtn(n)}${extra}<p class="${cls}">${esc(p)}</p>`;
}

const seg = (name, val, opts) => `<div class="seg" role="radiogroup">${opts.map(([v, t]) => `<label class="opt"><input type="radio" name="${name}" value="${v}" ${String(v) === String(val) ? 'checked' : ''}>${t}</label>`).join('')}</div>`;
const sw = (key, on, cls = 'switch', inner = '', dis = false) => `<button type="button" class="${cls}" role="switch" aria-checked="${!!on}" data-sw="${key}" ${dis ? 'disabled' : ''}>${inner}</button>`;
const voiceName = id => (voices || []).find(v => v.id === id)?.name || (id === 'auto' || !id ? 'Agent 挑选' : id);

function upState(x) {
  if (x.state === 'uploading') return `<small data-up="${x.key}">上传中 ${Math.round((x.progress || 0) * 100)}%</small>`;
  if (x.state === 'error') return `<small class="err" title="${esc(x.error || '')}">上传失败</small>`;
  return `<small>${{ file: '上传', library: '素材库', link: '链接' }[x.kind]}</small>`;
}

function cfgHTML(n) {
  const c = n.cfg, i = infoOf(n), lock = i.st === 'running' || acting.has(n.k);
  let h = `<fieldset class="pn-fs" ${lock ? 'disabled' : ''}>`;
  if (n.type === 'text') {
    const g = genreById(c.genre), links = c.refs.filter(r => r.kind === 'link').length;
    h += `<div class="pn-sec"><h3>描述 <small>必填</small></h3>
        <textarea data-f="desc" maxlength="4000" placeholder="讲什么、给谁看、想让观众记住什么。例如：给第一次接触大模型的产品经理讲清楚 RAG，语气轻松。">${esc(c.desc)}</textarea></div>
      <div class="pn-sec"><h3>资料 <small>${c.refs.length} / ${REF_MAX}</small></h3>
        ${c.refs.length ? `<div class="rf-items">${c.refs.map((r, k) => `<div class="rf-item">${ico(r.kind === 'link' ? 'link' : r.kind === 'library' ? 'archive' : 'doc')}<span title="${esc(r.name || r.url)}">${esc(r.name || r.url)}</span>${upState(r)}<button type="button" class="icon-btn" data-rf-del="${k}" aria-label="移除">${ico('x')}</button></div>`).join('')}</div>` : ''}
        <div class="rf-add-row">
          <button type="button" class="btn ghost small" data-rf="file" ${c.refs.length >= REF_MAX ? 'disabled' : ''}>${ico('upload')}上传文件</button>
          <button type="button" class="btn ghost small" data-rf="lib">${ico('archive')}从素材库选</button>
          <button type="button" class="btn ghost small" data-rf="link" ${links >= LINK_MAX || c.refs.length >= REF_MAX ? 'disabled' : ''}>${ico('link')}添加链接</button>
        </div>
        <div class="rf-link-row" id="wf-link-row" hidden><label class="sr-only" for="wf-link">链接地址</label><input type="url" id="wf-link" placeholder="博客或在线文档的网址，按回车添加"><button type="button" class="btn primary small" id="wf-link-ok">添加</button></div>
        <p class="pn-hint">文件只收 pdf、docx、md、txt、csv、xlsx，每个不超过 1 MB；链接最多 5 个，开工前抓取正文。</p>
        <div class="pn-row">${sw('web', c.web, 'pill-toggle', `${ico('globe')}<span>联网搜索</span>`)}
          ${sw('strict', c.strict && c.refs.length > 0, 'pill-toggle', `${ico('quote')}<span>强制引用</span>`, !c.refs.length)}</div>
        <p class="pn-hint">${c.refs.length ? '打开强制引用后，剧本里的说法都要在资料里找得到依据。' : '加了资料才能打开强制引用。'}</p></div>
      <div class="pn-sec"><h3>图片 <small>${(c.pics || []).length} / ${PIC_MAX}</small></h3>
        ${(c.pics || []).length ? `<div class="rf-items">${c.pics.map((p, k) => `<div class="rf-item rf-pic-item">
          <span class="rf-pic-thumb">${p.preview || p.url ? `<img src="${esc(p.preview || p.url)}" alt="">` : ico('image')}</span><span title="${esc(p.name)}">${esc(p.name)}</span>${upState(p)}<button type="button" class="icon-btn" data-pic-del="${k}" aria-label="移除图片">${ico('x')}</button>
          <input type="text" data-pic-desc="${k}" maxlength="200" value="${esc(p.desc || '')}" placeholder="这是什么、想在片子里怎么用（必填）" aria-label="「${esc(p.name)}」的描述"></div>`).join('')}</div>` : ''}
        <div class="rf-add-row">
          <button type="button" class="btn ghost small" data-pic="file" ${(c.pics || []).length >= PIC_MAX ? 'disabled' : ''}>${ico('upload')}上传图片</button>
          <button type="button" class="btn ghost small" data-pic="lib">${ico('archive')}从素材库选</button>
        </div>
        <p class="pn-hint">产品照、截图、Logo，png、jpg、webp，每张不超过 10 MB。Agent 按描述决定放在哪几镜、多大、怎么出现。</p></div>
      <div class="pn-sec"><h3>写作方法 <small>决定剧本怎么组织</small></h3>
        <select data-f="genre" aria-label="写作方法"><option value="">交给 Agent 判断</option>${genreGroups().map(gr => `<optgroup label="${esc(gr.name)}">${gr.items.map(x => `<option value="${esc(x.id)}" ${x.id === c.genre ? 'selected' : ''}>${esc(x.name)}${x.beta ? '（内测）' : ''}</option>`).join('')}</optgroup>`).join('')}</select>
        <p class="pn-hint">${esc(g ? g.summary : '叙事结构、开场和节奏。和画风互相独立，画风在音画节点里选。')}</p></div>
      <div class="pn-sec"><h3>时长</h3>${seg('wf-dur', c.dur, DURS)}<p class="pn-hint">超过 3 分钟的长片，第一版先用自由模式做。</p></div>`;
    if (i.st === 'done') h += '<p class="pn-hint">运行以后再改这些设置，要点"重新运行"才生效，会新建一个任务。改剧本和分镜，直接在"对话"里说就行。</p>';
  } else if (n.type === 'image') {
    h += `<div class="pn-sec"><h3>来源</h3>${seg('wf-imode', c.mode, [['new', '新做一个'], ['lib', '从素材库选']])}</div>`;
    if (c.mode === 'lib') {
      const t = taskOf(n), v = t && [...(t.model?.versions || [])].sort((a, b) => b.n - a.n)[0], img = (v && safeUrl(heroView(v.views))) || c.lib?.thumb;
      h += `<div class="pn-sec"><h3>素材库里的 3D 图片</h3>
        <div class="lib-cur">${img ? `<img src="${esc(img)}" alt="">` : `<span class="sty-none">${ico('cube')}</span>`}<div><b>${esc(c.lib?.name || '还没选')}</b><small>${c.lib ? '连到音画节点后，模型和素材卡会复制进视频任务' : '素材库里做好的 3D 图片，选了就能直接用，不用再运行'}</small></div>
          <button type="button" class="btn ghost small" data-lib-pick>${c.lib ? '换一个' : '选一个'}</button></div></div>`;
    } else {
      h += `<div class="pn-sec"><h3>描述 <small>必填</small></h3><textarea data-f="desc" maxlength="2000" placeholder="要做什么物体：名称、型号、外观特点。例如：复古双铃闹钟，红色外壳，铃铛和提手是银色。">${esc(c.desc)}</textarea></div>
        <div class="pn-sec"><h3>照片 <small>0～4 张，同一个物体的不同角度</small></h3>
          <div class="photos-row">${c.photos.map((p, k) => `<div class="photo${p.state === 'error' ? ' err' : ''}" title="${esc(p.name)}">${p.preview ? `<img src="${esc(p.preview)}" alt="${esc(p.name)}">` : `<span class="sty-none">${ico('image')}</span>`}${p.state === 'uploading' ? `<i data-up="${p.key}" style="width:${Math.round((p.progress || 0) * 100)}%"></i>` : ''}<button type="button" data-photo-del="${k}" aria-label="移除">${ico('x')}</button></div>`).join('')}${c.photos.length < PHOTO_MAX ? '<button type="button" class="photo-add" data-photo-add>添加照片</button>' : ''}</div>
          <p class="pn-hint">png、jpg、webp，每张不超过 10 MB。没有照片时，Agent 先画一张示意图当参考。</p></div>
        <div class="pn-sec"><div class="sound-line"><span>做拆解</span>${sw('explode', c.explode)}</div>
          <p class="pn-hint">模型做成能一步步拆开的结构，做片时可以用拆开、合上的镜头。</p>
          <div class="sound-line"><span>联网搜索</span>${sw('web', c.web)}</div>
          <p class="pn-hint">有具体品牌、型号时，查尺寸、配色和材质。</p></div>`;
    }
  } else {
    const tn = linkedText(n), t = taskOf(tn), g = genreById(tn?.cfg.genre), rec = stylesOfGenre(g), list = loadedStyles();
    const picked = (t?.brief?.skills || [])[0]?.id;
    const cur = (slot, id) => `<div class="sty-cur">${id ? thumbArt(id) : `<span class="sty-none">${slot === 'main' ? '自动' : '无'}</span>`}
        <div><b>${slot === 'main' ? '主画风' : '插入画风'}：${esc(id ? skillName(id) : slot === 'main' ? '交给 Agent 判断' : '不用')}</b>
        <small>${esc(id ? `${skillById(id)?.cat || ''}${skillById(id)?.beta ? `（内测：${BETA_HINT}）` : ''}` : slot === 'main' ? (picked ? `这一版 Agent 选的是「${skillName(picked)}」` : '没选时，Agent 按内容和写作方法挑') : '只用在中间一段"片中片"里，可以不选')}</small></div>
        <button type="button" class="btn ghost small" data-pick="${slot}">${PICK === slot ? '收起' : id ? '换一个' : slot === 'main' ? '选一个' : '添加'}</button>
        ${slot === 'insert' && id ? `<button type="button" class="icon-btn" data-clear-insert aria-label="不用插入画风">${ico('x')}</button>` : ''}</div>`;
    const picker = slot => {
      const show = list.filter(s => !PICKCAT || s.cat === PICKCAT).sort((a, b) => (rec.indexOf(a.id) + 1 || 999) - (rec.indexOf(b.id) + 1 || 999));
      return `<div class="sty-filter"><select data-pickcat aria-label="画风分类"><option value="">全部 ${list.length} 个</option>${categories(list).map(x => `<option ${x === PICKCAT ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select>
          ${slot === 'main' ? '<button type="button" class="btn ghost small" data-style-auto>交给 Agent</button>' : ''}</div>
        <div class="sty-grid">${show.map(s => `<button type="button" class="sty-opt" data-style="${esc(s.id)}" data-slot="${slot}" aria-pressed="${n.cfg[slot] === s.id}">${thumbArt(s.id)}${rec.includes(s.id) ? '<em>常搭配</em>' : s.beta ? '<em>内测</em>' : ''}${esc(s.name)}</button>`).join('')}</div>`;
    };
    const v = (voices || []).find(x => x.id === c.voice);
    const vg = [...new Set((voices || []).map(x => x.cat))];
    h += `<div class="pn-sec"><h3>画风 <small>决定画面长什么样</small></h3>
        ${cur('main', c.main)}${PICK === 'main' ? picker('main') : ''}
        ${cur('insert', c.insert)}${PICK === 'insert' ? picker('insert') : ''}
        ${rec.length ? `<p class="pn-hint">标"常搭配"的是文字节点里的写作方法「${esc(g.name)}」常用的画风，排在前面，不限制选择。</p>` : ''}</div>
      <div class="pn-sec"><h3>配音风格</h3><div class="sound-rows">
        <div class="sound-line"><span>音色</span><select data-f="voice" aria-label="音色"><option value="auto">由 Agent 按内容挑选</option>${vg.map(cat => `<optgroup label="${esc(cat)}">${voices.filter(x => x.cat === cat).map(x => `<option value="${esc(x.id)}" ${x.id === c.voice ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</optgroup>`).join('')}</select>
          <button type="button" class="icon-btn" data-voice-play aria-label="试听" title="试听" ${v?.preview ? '' : 'disabled'}>${ico('play')}</button></div>
        ${v ? `<p class="pn-hint">${esc(v.desc)}</p>` : ''}
        <div class="sound-line"><span>字幕</span>${sw('sub', c.sub)}</div>
        <div class="sound-line"><span>背景音乐</span>${sw('bgm', c.bgm)}</div></div></div>
      <div class="pn-sec"><h3>规格</h3>
        <div class="pn-row"><span class="k">画幅</span>${seg('wf-ratio', c.ratio, [['16:9', '16:9'], ['9:16', '9:16'], ['1:1', '1:1'], ['4:5', '4:5']])}</div>
        <div class="pn-row"><span class="k">清晰度</span>${seg('wf-res', c.res, [['720p', '720p'], ['1080p', '1080p']])}${seg('wf-fps', c.fps, [[30, '30 帧'], [60, '60 帧']])}</div>
        <p class="pn-hint">时长跟着文字节点的分镜走。出片以后再改这里的设置，点"重跑"生效：换画风不动讲稿和配音，换音色会全部重新配音，换画幅会全部重新渲染。</p></div>`;
  }
  return h + '</fieldset>';
}

let styleCache = [];
const loadedStyles = () => styleCache;

function stepsHtml(t, names) {
  const { list } = stepsOf(t, names);
  const word = { done: '完成', running: '进行中', skipped: '跳过', failed: '失败', pending: '' };
  return `<ul class="out-steps">${list.map(s => `<li class="${s.state === 'running' ? 'live' : s.state === 'done' ? 'done' : ''}"><span>${esc(s.label)}</span><b>${word[s.state] || ''}</b><small>${esc(s.note || '')}</small></li>`).join('')}</ul>`;
}

function outHTML(n) {
  const empty = msg => `<div class="out-empty">${ico(TYPES[n.type].icon)}<p>${msg}</p></div>`;
  if (n.type === 'text') {
    const t = taskOf(n);
    if (!t) return empty('运行以后，这里显示资料摘要、剧本和分镜。');
    const sb = t.storyboard, ed = n.cfg.edits || {}, lock = busy(t) || acting.has(n.k);
    const changed = new Set(t.flow?.changed || []);
    const refName = id => (t.request?.refs?.items || []).find(r => r.id === id)?.title || '';
    const notes = Array.isArray(t.notes?.items) ? t.notes.items : [];
    let h = `<div class="pn-sec"><h3>进度</h3>${stepsHtml(t, TEXT_STEPS)}</div>`;
    if (notes.length || t.notes?.angle) {
      h += `<div class="pn-sec"><h3>资料摘要 <small>${notes.length} 份</small></h3>${t.notes?.angle ? `<p class="pn-hint">${esc(t.notes.angle)}</p>` : ''}
        <ul class="notes-list">${notes.map((x, k) => `<li><b>${esc(refName(x.id) || x.title || `资料 ${k + 1}`)}${x.used === false ? '（没用到）' : ''}</b>${esc(x.summary || x.reason || '')}</li>`).join('')}</ul></div>`;
    }
    const paras = t.script?.paragraphs || [];
    if (paras.length) h += `<div class="pn-sec"><h3>剧本 <small>${paras.join('').length} 字</small></h3><p class="script-p">${esc(paras.join('\n\n'))}</p></div>`;
    if (sb?.scenes?.length) {
      h += `<div class="pn-sec"><h3>分镜 <small>${sb.scenes.length} 镜 · 旁白可以直接改</small></h3><div class="sb-list">${sb.scenes.map(s => {
        const mine = ed[s.id] !== undefined, hot = mine || changed.has(s.id);
        return `<div class="sb${hot ? ' is-changed' : ''}"><div class="sb-n">${sceneNo(s.id)}<small>${Number(s.duration || 0).toFixed(1)}s</small></div>
          <label for="wf-sb-${esc(s.id)}"><span>${esc(s.title || '旁白')}</span>${mine ? '<span class="sb-tag">直接改过，还没交给 Agent</span>' : changed.has(s.id) ? '<span class="sb-tag">出片后改过</span>' : ''}</label>
          <textarea id="wf-sb-${esc(s.id)}" data-sb="${esc(s.id)}" rows="${Math.max(2, Math.ceil((ed[s.id] ?? s.narration ?? '').length / 24))}" maxlength="600" ${lock ? 'disabled' : ''}>${esc(ed[s.id] ?? s.narration ?? '')}</textarea>
          <div class="sb-vis">画面：${esc(s.visual || '')}</div></div>`;
      }).join('')}</div>
      ${Object.keys(ed).length ? '<p class="pn-hint">直接改的旁白会在下次和文字节点对话、或者运行音画节点时一起交给 Agent。</p>' : ''}</div>`;
    }
    return h;
  }
  if (n.type === 'image') {
    const t = taskOf(n);
    if (!t) return empty(n.cfg.mode === 'lib' ? '选好以后，这里显示 3D 预览和素材卡。' : '运行以后，这里显示 3D 预览和素材卡。');
    const vs = [...(t.model?.versions || [])].sort((a, b) => b.n - a.n), v = vs[0];
    let h = busy(t) || !v ? `<div class="pn-sec"><h3>进度</h3>${stepsHtml(t)}</div>` : '';
    if (v) {
      h += `<div class="wf-m3d" id="wf-m3d" data-task="${esc(t.id)}" data-v="${v.n}"></div>
        <div class="pn-sec"><h3>多角度图 <small>第 ${v.n} 版</small></h3><div class="wf-views">${(v.views || []).map(x => { const u = safeUrl(x.url); return u ? `<a href="${esc(u)}" target="_blank" rel="noopener noreferrer"><img src="${esc(u)}" alt="${esc(angleLabel(x.angle))}" loading="lazy"></a>` : ''; }).join('')}</div></div>`;
    }
    if (t.model?.asset) h += `<div class="pn-sec"><h3>素材卡</h3><div class="asset">${assetHtml(t.model.asset)}</div><p class="pn-hint">连到音画节点后，模型文件和素材卡会复制进视频任务，镜头直接加载模型、驱动零件。</p></div>`;
    return h;
  }
  const t = videoTaskOf(n);
  if (!t) return empty('运行以后，这里显示成片和每镜小样。');
  const vs = [...(t.versions || [])].sort((a, b) => b.n - a.n), cur = vs.find(v => v.n === avVer) || vs[0];
  let h = '';
  if (cur) {
    const src = safeUrl(cur.url);
    h += `<video class="wf-player" controls preload="metadata" playsinline ${src ? `src="${esc(src)}"` : ''}></video>
      <div class="pn-sec"><div class="ver-row">${vs.map(v => `<button type="button" class="chip" data-ver="${v.n}" aria-pressed="${v.n === cur.n}">第 ${v.n} 版</button>`).join('')}<span class="sp"></span>
        <span class="pn-hint">${mss(cur.dur || 0)} · 累计 ${Number(t.billing?.credits || 0).toFixed(2)} Credit</span></div></div>`;
  }
  if (busy(t) && t.flow?.node === 'av' || !cur) h += `<div class="pn-sec"><h3>进度</h3>${stepsHtml(t, AV_STEPS)}</div>`;
  const scenes = t.storyboard?.scenes || [];
  if (scenes.some(s => s.clip)) {
    h += `<div class="pn-sec"><h3>每镜小样 <small>${scenes.length} 镜</small></h3><div class="wf-shots">${scenes.map(s => {
      const u = s.clip && safeUrl(s.clip.url);
      return `<div class="wf-shot" title="${esc(s.title || '')}">${u ? `<video muted preload="metadata" playsinline src="${esc(u)}"></video>` : ''}<span>${sceneNo(s.id)}</span>${u ? '' : '<em>未渲染</em>'}</div>`;
    }).join('')}</div></div>`;
  }
  return h || empty('运行以后，这里显示成片和每镜小样。');
}

function mountModel(n) {
  const host = $('#wf-m3d', pnBody);
  if (!host) return;
  viewer = mountViewer(host);
  const id = host.dataset.task, v = host.dataset.v;
  viewer.load(() => api.get(`/tasks/${encodeURIComponent(id)}/module?v=${v}`), `${label(n)}第 ${v} 版的 3D 预览`);
}

function msgHtml(m) {
  const text = esc(m.text);
  if (m.kind === 'system') return `<div class="msg system"><p>${text}</p></div>`;
  if (m.role === 'user') return `<div class="msg user"><p>${text}</p></div>`;
  if (m.kind === 'plan') {
    const lines = String(m.text || '').split('\n').map(l => l.replace(/^\s*(?:[-*•·]|\d+[.、)])\s*/, '').trim()).filter(Boolean);
    return `<div class="msg agent"><span class="who">Agent</span><div class="plan"><b>改动计划</b><ul>${lines.map(l => `<li>${esc(l)}</li>`).join('')}</ul></div></div>`;
  }
  return `<div class="msg agent"><span class="who">Agent</span><p>${text}</p></div>`;
}

function chatHTML(n) {
  const tip = {
    text: '这里的对话只改剧本和分镜，不配音、不渲染。出片以后再回来改，音画节点会标成"需要重跑"。',
    image: '这里的对话只改这个 3D 图片，每改一次出一个新版本。',
    av: '这里的对话改画面和声音，和平常修改成片一样，每改一次出一个新版本。',
  }[n.type];
  const ms = msgsOf(n);
  return `<p class="pn-hint" style="margin-bottom:12px">${tip}</p><div class="wf-chat">${ms.map(msgHtml).join('') || '<p class="msgs-empty">还没有对话。</p>'}</div>`;
}

const chatFoot = n => `<div style="display:grid;gap:4px;width:100%"><form class="ask" id="wf-ask-form" novalidate>
    <label class="sr-only" for="wf-ask">发给${esc(label(n))}的消息</label>
    <textarea id="wf-ask" rows="2" maxlength="2000"></textarea>
    <div class="ask-bar" style="display:flex;justify-content:flex-end"><button type="submit" class="btn primary small" id="wf-ask-send">${ico('send')}发送</button></div>
  </form><div class="chat-sugs">${SUGS[n.type].map(s => `<button type="button" data-sug>${esc(s)}</button>`).join('')}</div></div>`;

/* ---------- 面板里的操作 ---------- */

function cfgChanged(n, rerender = true) {
  changed();
  renderPanel(rerender);
}

/** 运行过的文字节点：上传的文件建任务时进了素材库，画板里换成素材库的文件，以后重新运行不用重新上传（上传记录会过期） */
function syncRefs() {
  for (const n of W.nodes.filter(x => x.type === 'text')) {
    const t = taskOf(n);
    if (!t || n.cfg.refsFrom === t.id) continue;
    let hit = false;
    for (const it of t.request?.refs?.items || []) {
      if (!it.fileId) continue;
      const r = n.cfg.refs.find(x => x.kind === 'file' && x.name === it.title);
      if (r) { Object.assign(r, { kind: 'library', fileId: it.fileId, state: 'done' }); delete r.uploadId; hit = true; }
    }
    // 上传的图片也进了素材库（带着描述）：换成素材库的
    for (const it of t.request?.images || []) {
      if (!it.fileId) continue;
      const p = (n.cfg.pics || []).find(x => x.kind === 'file' && x.name === it.name);
      if (p) { Object.assign(p, { kind: 'library', fileId: it.fileId, url: it.url, state: 'done' }); delete p.uploadId; hit = true; }
    }
    n.cfg.refsFrom = t.id;
    // 分镜改了以后，已经不存在的镜头的直接改动丢掉
    const ids = new Set((t.storyboard?.scenes || []).map(s => s.id));
    for (const k of Object.keys(n.cfg.edits || {})) if (!ids.has(k)) { delete n.cfg.edits[k]; hit = true; }
    if (hit) persistSoon();
  }
}

function paintUpload(x) {
  const el = pnBody.querySelector(`[data-up="${x.key}"]`);
  if (!el) return;
  if (el.tagName === 'I') el.style.width = `${Math.round(x.progress * 100)}%`;
  else el.textContent = `上传中 ${Math.round(x.progress * 100)}%`;
}

async function upload(n, list, file, purpose) {
  const x = { key: uid('u'), kind: 'file', name: file.name, size: file.size, state: 'uploading', progress: 0, preview: purpose === 'image' ? URL.createObjectURL(file) : null };
  list.push(x);
  renderPanel(true);
  try {
    x.uploadId = await uploadFile(file, p => { x.progress = p; paintUpload(x); }, {}, purpose);
    x.state = 'done';
  } catch (e) {
    x.state = 'error'; x.error = e.message;
    if (e.status !== 401) toast(`「${file.name}」没有上传成功：${e.message}`, 'error');
  }
  if (node(n.k) === n) cfgChanged(n);
}

function addFiles(n, files) {
  for (const f of files) {
    if (n.cfg.refs.length >= REF_MAX) { toast(`资料最多 ${REF_MAX} 份`); break; }
    if (!REF_EXT.includes(extOf(f.name))) { toast(`「${f.name}」的格式不支持，只收 ${REF_EXT.join('、')}`, 'error'); continue; }
    if (f.size > 1024 * 1024) { toast(`「${f.name}」超过 1 MB`, 'error'); continue; }
    upload(n, n.cfg.refs, f, 'ref');
  }
}
function addPics(n, files) {
  n.cfg.pics ||= [];
  for (const f of files) {
    if (n.cfg.pics.length >= PIC_MAX) { toast(`图片最多 ${PIC_MAX} 张`); break; }
    if (!PHOTO_EXT.includes(extOf(f.name))) { toast(`「${f.name}」的格式不支持，只收 png、jpg、webp`, 'error'); continue; }
    if (f.size > 10 * 1024 * 1024) { toast(`「${f.name}」超过 10 MB`, 'error'); continue; }
    upload(n, n.cfg.pics, f, 'image');
  }
}
function pickLibPics(n) {
  const pics = n.cfg.pics || [], lib = pics.filter(p => p.kind === 'library');
  openLibPicker({ only: 'image', models: [], files: [], images: lib.map(p => ({ id: p.fileId, name: p.name, url: p.url, desc: p.desc })),
    maxModels: 0, maxFiles: 0, maxImages: PIC_MAX - (pics.length - lib.length) }, ({ images }) => {
    const ids = new Set(images.map(x => x.id));
    n.cfg.pics = pics.filter(p => p.kind !== 'library' || ids.has(p.fileId));
    for (const x of images) if (!n.cfg.pics.some(p => p.kind === 'library' && p.fileId === x.id)) n.cfg.pics.push({ kind: 'library', fileId: x.id, name: x.name, size: x.size, url: x.url, desc: x.desc || '', state: 'done' });
    cfgChanged(n);
  });
}
function addPhotos(n, files) {
  for (const f of files) {
    if (n.cfg.photos.length >= PHOTO_MAX) { toast(`照片最多 ${PHOTO_MAX} 张`); break; }
    if (!PHOTO_EXT.includes(extOf(f.name))) { toast(`「${f.name}」的格式不支持，只收 png、jpg、webp`, 'error'); continue; }
    if (f.size > 10 * 1024 * 1024) { toast(`「${f.name}」超过 10 MB`, 'error'); continue; }
    upload(n, n.cfg.photos, f, 'image');
  }
}

function addLink(n) {
  const raw = $('#wf-link').value.trim();
  let url = raw;
  if (url && !/^https?:\/\//i.test(url)) url = 'https://' + url;
  try { const u = new URL(url); if (!/^https?:$/.test(u.protocol) || !u.hostname.includes('.')) throw 0; } catch { toast('网址不对，要以 http:// 或 https:// 开头', 'error'); return; }
  if (n.cfg.refs.filter(r => r.kind === 'link').length >= LINK_MAX) { toast(`链接最多 ${LINK_MAX} 个`); return; }
  if (n.cfg.refs.some(r => r.kind === 'link' && r.url === url)) { toast('这个链接已经加过了'); return; }
  n.cfg.refs.push({ kind: 'link', url, state: 'done' });
  cfgChanged(n);
}

function pickLibFiles(n) {
  const lib = n.cfg.refs.filter(r => r.kind === 'library');
  openLibPicker({ only: 'file', models: [], files: lib.map(r => ({ id: r.fileId, name: r.name, size: r.size })), maxModels: 0, maxFiles: REF_MAX - (n.cfg.refs.length - lib.length) }, ({ files }) => {
    const ids = new Set(files.map(f => f.id));
    n.cfg.refs = n.cfg.refs.filter(r => r.kind !== 'library' || ids.has(r.fileId));
    for (const f of files) if (!n.cfg.refs.some(r => r.kind === 'library' && r.fileId === f.id)) n.cfg.refs.push({ kind: 'library', fileId: f.id, name: f.name, size: f.size, state: 'done' });
    cfgChanged(n);
  });
}
function pickLibModel(n) {
  openLibPicker({ only: 'model3d', models: n.cfg.lib ? [{ id: n.cfg.lib.id, name: n.cfg.lib.name }] : [], files: [], maxModels: 1, maxFiles: 0 }, ({ models }) => {
    const m = models[0];
    n.cfg.lib = m ? { id: m.id, name: m.name, thumb: heroView(m.views) } : null;
    n.task = m ? m.id : null;
    cfgChanged(n);
    poll(true);
  });
}

function togglePreview(v) {
  if (!v?.preview) return;
  if (!preview.paused && preview.dataset.id === v.id) { preview.pause(); return; }
  preview.src = v.preview; preview.dataset.id = v.id;
  preview.play().catch(() => toast('试听音频加载失败'));
}

function wirePanel() {
  $('#pn-tabs').addEventListener('click', e => { const b = e.target.closest('[data-tab]'); if (!b) return; TAB = b.dataset.tab; PICK = null; renderPanel(true); });
  $('#pn-close').addEventListener('click', () => select(null));
  $('#pn-del').addEventListener('click', () => delNode(PN));
  const panel = $('#wf-panel');
  panel.addEventListener('click', e => {
    const n = node(PN);
    if (!n) return;
    const q = s => e.target.closest(s), c = n.cfg;
    if (q('[data-run]')) run(n);
    else if (q('[data-retry]')) retryNode(n);
    else if (q('[data-sw]')) {
      const k = q('[data-sw]').dataset.sw;
      if (k === 'strict' && !c.refs.length) return;
      c[k] = !c[k];
      cfgChanged(n);
    } else if (q('[data-rf]')) {
      const k = q('[data-rf]').dataset.rf;
      if (k === 'file') { fileRefs.dataset.node = n.k; fileRefs.click(); } else if (k === 'lib') pickLibFiles(n);
      else { $('#wf-link-row').hidden = false; $('#wf-link').focus(); }
    } else if (q('[data-pic]')) {
      if (q('[data-pic]').dataset.pic === 'file') { filePics.dataset.node = n.k; filePics.click(); } else pickLibPics(n);
    } else if (q('[data-pic-del]')) { const [p] = c.pics.splice(+q('[data-pic-del]').dataset.picDel, 1); if (p?.preview) URL.revokeObjectURL(p.preview); cfgChanged(n); }
    else if (q('#wf-link-ok')) addLink(n);
    else if (q('[data-rf-del]')) { c.refs.splice(+q('[data-rf-del]').dataset.rfDel, 1); if (!c.refs.length) c.strict = false; cfgChanged(n); }
    else if (q('[data-photo-add]')) { filePhotos.dataset.node = n.k; filePhotos.click(); }
    else if (q('[data-photo-del]')) { const [p] = c.photos.splice(+q('[data-photo-del]').dataset.photoDel, 1); if (p?.preview) URL.revokeObjectURL(p.preview); cfgChanged(n); }
    else if (q('[data-lib-pick]')) pickLibModel(n);
    else if (q('[data-pick]')) { const s = q('[data-pick]').dataset.pick; PICK = PICK === s ? null : s; PICKCAT = ''; renderPanel(true); }
    else if (q('[data-style]')) {
      const b = q('[data-style]'), slot = b.dataset.slot, id = b.dataset.style;
      if ((slot === 'insert' && id === c.main) || (slot === 'main' && id === c.insert)) { toast('主画风和插入画风不能是同一个'); return; }
      c[slot] = id; PICK = null; cfgChanged(n);
    } else if (q('[data-style-auto]')) { c.main = ''; PICK = null; cfgChanged(n); }
    else if (q('[data-clear-insert]')) { c.insert = ''; cfgChanged(n); }
    else if (q('[data-voice-play]')) togglePreview((voices || []).find(v => v.id === c.voice));
    else if (q('[data-ver]')) { avVer = +q('[data-ver]').dataset.ver; renderPanel(true); }
    else if (q('[data-sug]')) { const i = $('#wf-ask'); if (!i.disabled) { i.value = q('[data-sug]').textContent; i.focus(); } }
  });
  panel.addEventListener('input', e => {
    const n = node(PN), f = e.target.dataset?.f;
    if (n && f && e.target.tagName === 'TEXTAREA') { n.cfg[f] = e.target.value; changed(); renderPanel(false); }
    const pk = e.target.dataset?.picDesc;
    if (n && pk != null && n.cfg.pics?.[+pk]) { n.cfg.pics[+pk].desc = e.target.value; changed(); renderPanel(false); }
  });
  panel.addEventListener('change', e => {
    const n = node(PN);
    if (!n) return;
    const t = e.target, c = n.cfg;
    if (t.matches('select[data-f]')) { c[t.dataset.f] = t.value; cfgChanged(n); }
    else if (t.matches('[data-pickcat]')) { PICKCAT = t.value; renderPanel(true); }
    else if (t.name === 'wf-dur') { c.dur = +t.value; cfgChanged(n); }
    else if (t.name === 'wf-ratio') { c.ratio = t.value; cfgChanged(n); }
    else if (t.name === 'wf-res') { c.res = t.value; cfgChanged(n); }
    else if (t.name === 'wf-fps') { c.fps = +t.value; cfgChanged(n); }
    else if (t.name === 'wf-imode') {
      c.mode = t.value;
      n.task = c.mode === 'lib' ? c.lib?.id || null : null;  // 新做的 3D 图片换成素材库的（或者反过来）：原来的任务还在素材库里
      cfgChanged(n);
      poll(true);
    } else if (t.matches('[data-sb]')) {
      const tk = taskOf(n), s = tk?.storyboard?.scenes.find(x => x.id === t.dataset.sb);
      if (!s) return;
      const v = t.value.trim();
      if (!v || v === (s.narration || '').trim()) delete c.edits[s.id]; else c.edits[s.id] = v;
      changed(); renderPanel(true);
    }
  });
  panel.addEventListener('keydown', e => {
    if (e.target.id === 'wf-link' && e.key === 'Enter') { e.preventDefault(); addLink(node(PN)); }
    if (e.target.id === 'wf-ask' && e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('#wf-ask-form').requestSubmit(); }
  });
  panel.addEventListener('submit', e => {
    if (e.target.id !== 'wf-ask-form') return;
    e.preventDefault();
    const n = node(PN), i = $('#wf-ask'), v = i.value;
    if (!n || !v.trim() || chatBlock(n)) return;
    i.value = '';
    send(n, v);
  });
}

let fileRefs, filePhotos, filePics;
function fileInput(accept, onPick) {
  const el = document.createElement('input');
  Object.assign(el, { type: 'file', multiple: true, accept, hidden: true });
  el.addEventListener('change', () => { const n = node(el.dataset.node); if (n) onPick(n, [...el.files]); el.value = ''; });
  document.body.append(el);
  return el;
}

/* ---------- 保存为"我的工作流" ---------- */

async function saveTemplate(asNew) {
  if (!W) return;
  if (!asNew && W.src?.kind === 'my') {
    try {
      await api.patch(`/flows/${encodeURIComponent(W.src.id)}`, { name: W.name || defaultName(), doc: docOf(true) });
      toast(`已更新我的工作流「${W.name || defaultName()}」`);
    } catch (e) { if (e.status !== 401) toast(e.message, 'error'); }
    return;
  }
  $('#wf-save-h').textContent = asNew ? '另存为我的工作流' : '保存为我的工作流';
  $('#wf-save-name').value = W.name || defaultName();
  openModal($('#wf-save-modal'), $('#wf-save-name'));
  $('#wf-save-name').select();
}

/* ---------- 进入和离开 ---------- */

async function loadVoices() {
  if (voices) return;
  try { voices = (await api.get('/voices'))?.items || []; } catch { voices = []; }
}

function fromDoc(x) {
  const cfg = { ...DEF[x.type](), ...(x.cfg || {}) };
  if (x.type === 'text') { cfg.refs = (cfg.refs || []).map(r => ({ ...r, state: 'done' })); cfg.pics = (cfg.pics || []).map(p => ({ ...p, key: uid('u'), state: 'done' })); cfg.edits = { ...(cfg.edits || {}) }; }
  if (x.type === 'image') cfg.photos = (cfg.photos || []).map(p => ({ ...p, key: uid('u'), state: 'done' }));
  return { k: x.k, type: x.type, x: x.x, y: x.y, cfg, task: x.task || (x.type === 'image' && cfg.mode === 'lib' ? cfg.lib?.id || null : null) };
}

async function poll(all) {
  clearTimeout(pollTimer);
  if (!active || !W) return;
  const w = W;
  const ids = [...new Set(W.nodes.map(n => n.task).filter(Boolean))];
  const want = all ? ids : ids.filter(id => !T.has(id) || busy(T.get(id)));
  await Promise.all(want.map(id => api.get(`/tasks/${encodeURIComponent(id)}`)
    .then(d => { if (W === w) T.set(id, d); })
    .catch(e => { if (e.status === 404 && W === w) T.set(id, { id, missing: true }); })));
  if (!active || W !== w) return;
  syncRefs();
  renderAll();
  const more = ids.some(id => busy(T.get(id)));
  pollTimer = setTimeout(() => poll(false), more ? POLL_MS : 15000);
}

export async function enter(arg) {
  active = true;
  document.title = '工作流画板｜Slate';
  if (W && (arg === W.id || (W.srcArg && arg === W.srcArg))) {  // 从别的页面回来：接着用内存里的画板
    renderAll();
    requestAnimationFrame(renderEdges);
    poll(true);
    return;
  }
  const my = ++openSeq;
  W = null; T = new Map(); nodeSig.clear(); bodySig = ''; SEL = null;
  closePanel();
  $('#wf-nodes').innerHTML = ''; $('#wf-edges').innerHTML = '';
  $('#wf-loading').hidden = false;
  try {
    await Promise.all([loadSkills().then(l => { styleCache = l; }).catch(() => {}), loadVoices()]);
    let doc, name = '', src = null, id = null, savedAt = 0;
    const m = /^new:(tpl|my):(.+)$/.exec(arg || '');
    if (m && m[1] === 'tpl') {
      const t = TEMPLATES.find(x => x.id === m[2]) || TEMPLATES[0];
      doc = t.doc; name = t.id === 'blank' ? '' : t.name;
    } else if (m || !arg || arg === 'new') {
      if (m) { const r = await api.get(`/flows/${encodeURIComponent(m[2])}`); doc = r.doc; name = r.name; src = { kind: 'my', id: r.id }; } else doc = TEMPLATES[0].doc;
    } else {
      const r = await api.get(`/flows/${encodeURIComponent(arg)}`);
      doc = r.doc; name = r.name;
      if (r.kind === 'canvas') { id = r.id; savedAt = r.updatedAt; } else src = { kind: 'my', id: r.id };
    }
    if (my !== openSeq) return;
    W = { id, name, src, srcArg: id ? null : arg, savedAt, saveState: '', nodes: (doc.nodes || []).map(fromDoc),
          edges: (doc.edges || []).map(([a, b, p]) => ({ id: uid('e'), from: a, to: b, port: p })) };
  } catch (e) {
    if (my !== openSeq) return;
    if (e.status !== 401) toast(e.message, 'error');
    location.replace('#flows');
    return;
  }
  $('#wf-loading').hidden = true;
  renderAll();
  requestAnimationFrame(() => { fit(); renderEdges(); });
  poll(true);
}

export function leave() {
  active = false;
  clearTimeout(pollTimer);
  if (saveTimer) persistNow();
  preview.pause();
  disposeViewer();
  bodySig = '';
  $$('video', $('#view-flow')).forEach(v => v.pause());
}

export function init() {
  fileRefs = fileInput(REF_EXT.map(x => '.' + x).join(','), addFiles);
  filePhotos = fileInput('image/png,image/jpeg,image/webp', addPhotos);
  filePics = fileInput('.png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp', addPics);
  canvas.addEventListener('pointermove', e => {
    if (!DRAG) return;
    const dx = e.clientX - DRAG.sx, dy = e.clientY - DRAG.sy;
    if (!DRAG.moved && Math.hypot(dx, dy) > 3) DRAG.moved = true;
    if (DRAG.moved) DRAG.onMove(e, dx, dy);
  });
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('pointerdown', e => {
    if (!W || (e.button !== 0 && e.button !== 1)) return;
    const t = e.target;
    if (t.closest('.wf-palette, .wf-zoom')) return;
    const del = t.closest('[data-edge-del]'); if (del) { removeEdge(del.dataset.edgeDel); return; }
    const eh = t.closest('[data-edge]'); if (eh) { select({ k: 'edge', id: eh.dataset.edge }); return; }
    const out = t.closest('[data-port-out]'); if (out && e.button === 0) { startLink(e, out); return; }
    const nd = t.closest('.wf-node');
    if (nd && e.button === 0) { if (!t.closest('button, a')) startNodeDrag(e, nd.dataset.node); return; }
    startPan(e);
  });
  canvas.addEventListener('wheel', e => {
    if (e.target.closest('.wf-palette')) return;
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) zoomAt(e.clientX, e.clientY, V.z * Math.exp(-clamp(e.deltaY, -60, 60) * 0.005));  // 鼠标滚轮一格约 100，触控板捏合每次只有几
    else { V.x -= e.deltaX; V.y -= e.deltaY; applyView(); }
  }, { passive: false });
  $('#wf-nodes').addEventListener('click', e => {
    const nd = e.target.closest('.wf-node');
    const n = nd && node(nd.dataset.node);
    if (!n) return;
    if (e.target.closest('[data-run]')) run(n);
    else if (e.target.closest('[data-retry]')) retryNode(n);
    else if (e.target.closest('[data-open-chat]')) { TAB = 'chat'; PICK = null; SEL = { k: 'node', id: n.k }; openPanel(n.k); renderNodes(); ensureVisible(n.k); }
  });
  $('#wf-z-in').addEventListener('click', () => zoomCenter(1.2));
  $('#wf-z-out').addEventListener('click', () => zoomCenter(1 / 1.2));
  $('#wf-z-val').addEventListener('click', () => zoomCenter(1 / V.z));
  $('#wf-z-fit').addEventListener('click', fit);

  // 添加节点：点一下放到中间，拖动放到松手的位置
  $$('#view-flow .wf-pal-item').forEach(b => {
    b.addEventListener('pointerdown', e => {
      if (b.disabled || e.button !== 0 || !W) return;
      e.preventDefault();
      const type = b.dataset.add, sx = e.clientX, sy = e.clientY;
      let ghost = null;
      const mv = ev => {
        if (!ghost && Math.hypot(ev.clientX - sx, ev.clientY - sy) > 4) {
          ghost = document.createElement('div');
          ghost.className = 'wf-ghost';
          ghost.innerHTML = `<span class="ni ni-${type}">${ico(TYPES[type].icon)}</span>${TYPES[type].name}`;
          document.body.append(ghost);
        }
        if (ghost) { ghost.style.left = ev.clientX + 'px'; ghost.style.top = ev.clientY + 'px'; }
      };
      const up = ev => {
        removeEventListener('pointermove', mv); removeEventListener('pointerup', up);
        if (!ghost) { addNodeCenter(type); return; }
        ghost.remove();
        const r = canvas.getBoundingClientRect();
        if (ev.clientX < r.left || ev.clientX > r.right || ev.clientY < r.top || ev.clientY > r.bottom) return;
        const p = toWorld(ev.clientX, ev.clientY);
        addNode(type, p.x - 150, p.y - 24);
      };
      addEventListener('pointermove', mv); addEventListener('pointerup', up);
    });
    b.addEventListener('click', e => { if (e.detail === 0 && W) addNodeCenter(b.dataset.add); });  // 键盘
  });

  addEventListener('keydown', e => {
    if (!active || !W || !$('#view-flow').classList.contains('is-active')) return;
    if (e.target.closest?.('input, textarea, select, [contenteditable], .modal')) return;
    if ((e.key === 'Delete' || e.key === 'Backspace') && SEL) {
      e.preventDefault();
      if (SEL.k === 'edge') removeEdge(SEL.id); else delNode(SEL.id);
    } else if (e.key === 'Escape' && $('#wf-save-modal').hidden) select(null);
  });

  wirePanel();
  $('#wf-name').addEventListener('input', e => { if (W) { W.name = e.target.value; persistSoon(); } });
  $('#wf-save').addEventListener('click', () => saveTemplate(false));
  $('#wf-saveas').addEventListener('click', () => saveTemplate(true));
  const modal = $('#wf-save-modal');
  modal.addEventListener('click', e => { if (e.target === modal || e.target.closest('[data-close]')) closeModal(modal); });
  $('#wf-save-form').addEventListener('submit', async e => {
    e.preventDefault();
    const name = $('#wf-save-name').value.trim();
    if (!name) { $('#wf-save-name').focus(); return; }
    try {
      const r = await api.post('/flows', { kind: 'template', name, doc: docOf(true) });
      W.src = { kind: 'my', id: r.id };
      if (!W.name) { W.name = name; persistSoon(); renderTop(); }
      closeModal(modal);
      toast(`保存好了。在"我的工作流"里可以接着用，换描述和资料就能跑`);
    } catch (err) { if (err.status !== 401) toast(err.message, 'error'); }
  });
  addEventListener('keydown', e => { if (e.key === 'Escape' && !modal.hidden) closeModal(modal); });
  addEventListener('pagehide', () => { if (saveTimer) persistNow(); });
}
