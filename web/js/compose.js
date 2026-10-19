/* 新建页：顶部切换做视频还是 3D 图片。
   视频：快速 / 高级模式、描述块（描述、联网搜索、强制引用，「添加资料」：上传文件、从素材库选文件和 3D 图片、添加链接，都排在一个列表里）、写作方法、3 个高级选项、上传、画风 Skills；
   3D 图片：描述加 0～4 张参考照片，联网搜索和做拆解两个开关。两种共用场记板、校验和提交 */

import { $, $$, esc, toast, reduceMotion, fmtSize, today, openModal, closeModal, durLabel } from './util.js';
import { thumbArt } from './art.js';
import { api, uploadFile, contentTypeOf } from './api.js';
import { loadSkills, skillById, skillName, genreById, genreGroups, stylesOfGenre, BETA_HINT } from './catalog.js';
import { openLibPicker, init as initLibPicker } from './libpick.js';
import { heroView } from './viewer3d.js';

const form = $('#compose-form');
const stack = $('#skill-stack');
const rfList = $('#rf-list');
const rfMenu = $('#rf-menu');
const rfAddBtn = $('#rf-add-btn');

let selected = [];        // 选中的画风 id：第一个是主画风，第二个是插入画风（可以没有）
const MAX_STYLES = 2;
let exampleTitle = '';
let submitting = false;
let lastMode = 'quick';
let genresReady = false;  // 写作方法下拉框是否已经按目录填好
let genresFailed = false; // 目录没取到：只剩"交给 Agent 判断"
let seq = 0;
let refs = [];            // 参考资料，按添加顺序：{key, kind: file|link|library, el, ...}；file 还带上传状态：state uploading|done|error、progress、uploadId、error、handle
let product = 'video';    // 做什么：video 视频，model3d 3D 图片
let photos = [];          // 3D 图片的参考照片，按添加顺序：{key, file, preview（本地预览链接）, el}，上传状态和参考资料的文件一样
let models = [];          // 视频引用的 3D 图片（素材库里的）：{key, kind: model3d, id, name, thumb, explode, el}。和参考资料排在同一个列表里，但不算参考资料
let pics = [];            // 视频里用的普通图片（docs/image-refs-design.md）：上传的 {kind: pic, file, preview, 上传状态}，素材库的 {kind: libpic, fileId, name, url}；每张都要写描述

const ADV = ['c-skills', 'c-spec', 'c-board'];
// 参考资料的限制和后端一致（docs/references-design.md）
const REF_EXT = ['pdf', 'docx', 'md', 'txt', 'csv', 'xlsx'];
const REF_MAX_BYTES = 1024 * 1024;
const REF_MAX_LINKS = 5;
const REF_MAX = 10;
const REF_ICON = { file: 'i-doc', link: 'i-link', library: 'i-doc', model3d: 'i-cube', pic: 'i-image', libpic: 'i-image' };
const PIC_MAX = 8;          // 一支片子最多 8 张图片，不占参考资料的名额
const PIC_DESC_MAX = 200;
const DESC_MAX = 4000; // 描述的字数上限，和后端、#f-desc 的 maxlength 一致
// 3D 图片的参考照片和视频引用的 3D 图片（docs/library-3d-design.md）
const PHOTO_EXT = ['png', 'jpg', 'jpeg', 'webp'];
const PHOTO_MAX_BYTES = 10 * 1024 * 1024;
const PHOTO_MAX = 4;
const MODEL_MAX = 3;
const PRODUCT = {
  video: { h: '新建视频', title: '片名（暂定，Agent 会再拟）', lead: '用一段话说清楚想做什么。Agent 会自己查资料、写稿、定画风、写动画代码，最后渲染成 MP4。' },
  model3d: { h: '新建 3D 图片', title: '名称（暂定，Agent 会再拟）', lead: '描述一个物体，可以附上几张不同角度的照片。Agent 会看图、手写 three.js 模型并逐轮比对修正，做出可以拖动旋转的 3D 图片，做完自动进素材库，可以在视频里引用。' },
};
const LONG_SECONDS = 180;  // 超过 3 分钟按章节并行制作（和后端一致）
/** 选中的时长（秒）：预设值，或自定义的分钟和秒 */
function durSeconds() {
  const v = form.querySelector('input[name="dur"]:checked').value;
  if (v !== 'custom') return Number(v);
  const m = Math.max(0, Math.floor(Number($('#f-dur-min').value) || 0)), s = Math.max(0, Math.min(59, Math.floor(Number($('#f-dur-sec').value) || 0)));
  return m * 60 + s;
}
/** 预计用时：3 分钟以内按实测；更长的片子各章同时做，主要花在写总纲、最长的一章和拼接上 */
function etaText(sec) {
  const preset = form.querySelector(`input[name="dur"][value="${sec}"]`);
  if (preset?.dataset.eta) return `约 ${preset.dataset.eta} 分钟`;
  if (sec <= LONG_SECONDS) return `约 ${Math.max(4, Math.round(sec / 10))} 分钟`;
  const lo = Math.round((15 + 30 + 5) / 10) * 10, hi = Math.round((25 + 60 + 10 + sec / 600) / 10) * 10;
  return `约 ${lo} 到 ${hi} 分钟（按章节同时制作）`;
}

const PROMPT = {
  quick: { label: '想做一支什么样的片子', ph: '讲什么、给谁看、想让观众记住什么。例如：给第一次接触大模型的产品经理讲清楚 RAG，语气轻松，一分钟左右。' },
  advanced: { label: '描述：讲解方向和要求', ph: '自由写讲解方向和要求。例如：讲给销售团队听，少讲技术细节，多举客户案例；结尾要有行动号召。' },
};

const val = name => form.querySelector(`input[name="${name}"]:checked`)?.value;
const on = id => $('#' + id).getAttribute('aria-checked') === 'true';
const checked = id => $('#' + id).checked;
const isAdv = () => val('mode') === 'advanced';
const use = id => isAdv() && checked(id); // 高级选项只在高级模式下生效
const auto = text => `<span class="auto">${text}</span>`;
const genre = () => genreById($('#f-genre').value); // 选中的写作方法；"交给 Agent 判断" 时是 undefined。两种模式都生效
const num = n => Number(n).toLocaleString('zh-CN');
const extOf = name => { const i = name.lastIndexOf('.'); return i > 0 ? name.slice(i + 1).toLowerCase() : ''; };
const linkCount = () => refs.filter(r => r.kind === 'link').length;

/* ---------- 写作方法：一个下拉框，"交给 Agent 判断" 加上按分组（讲解类、宣传类）排的写作方法 ---------- */

const groupLabel = name => (name.endsWith('类') ? name : name + '类');

function renderGenres() {
  if (genresReady) return;
  const groups = genreGroups();
  genresFailed = !groups.length;
  genresReady = !genresFailed;
  $('#f-genre').innerHTML = '<option value="">交给 Agent 判断</option>' + groups.map(g =>
    `<optgroup label="${esc(groupLabel(g.name))}">${g.items.map(x => `<option value="${esc(x.id)}">${esc(x.name)}${x.beta ? '（内测）' : ''}</option>`).join('')}</optgroup>`).join('');
  updateSlate();
}

function updateGenre(g) {
  const desc = $('#genre-desc');
  const html = g
    ? `<b>${esc(g.name)}</b>${esc(g.summary || '')}${g.example ? `<span class="eg">比如：${esc(g.example)}</span>` : ''}`
    : genresFailed ? '写作方法列表没有加载出来，这次先交给 Agent 按描述判断。'
    : 'Agent 会按描述判断用哪种写作方法。想固定剧本怎么组织，就在上面选一种。';
  if (desc.dataset.html !== html) { desc.dataset.html = html; desc.innerHTML = html; } // 内容没变不重写，免得读屏反复播报
  desc.classList.toggle('is-auto', !g);
  $('#style-pair-hint').textContent = '写作方法决定剧本怎么组织，画风决定画面长什么样，可以自由搭配。'
    + (g ? `添加画风时，常和「${g.name}」搭配的排在前面。` : '');
}

/* ---------- 场记板 ---------- */

function setSlate(id, html) {
  const dd = $('#' + id);
  if (dd.innerHTML === html) return;
  const first = !dd.dataset.ready;
  dd.innerHTML = html;
  dd.dataset.ready = '1';
  if (first || reduceMotion) return;
  dd.animate([{ backgroundColor: 'rgba(244,180,0,.4)' }, { backgroundColor: 'rgba(244,180,0,0)' }], { duration: 700, easing: 'ease-out' });
}

function workingTitle(desc) {
  const first = desc.split(/[，。：！？,.:\n]/)[0];
  return first.length > 16 ? first.slice(0, 16) + '…' : first;
}


function counts() {
  return { refs: refs.length, models: models.length, pics: pics.length };
}

/** 切换做视频还是 3D 图片：两边填的内容都留着 */
export function setProduct(p) {
  product = p;
  $(`#product input[value="${p}"]`).checked = true;
  const m3d = p === 'model3d';
  $('#compose-form').hidden = m3d;
  $('#m3d-form').hidden = !m3d;
  $('#s-video').hidden = m3d;
  $('#s-m3d').hidden = !m3d;
  $('#compose-h').textContent = PRODUCT[p].h;
  $('#compose-lead').textContent = PRODUCT[p].lead;
  $('#s-title-k').textContent = PRODUCT[p].title;
  updateSlate();
}

function setTitle(desc, title) {
  const t = $('#s-title');
  t.textContent = desc ? (title || workingTitle(desc)) : '等你写描述';
  t.classList.toggle('is-empty', !desc);
}

/** 3D 图片的场记板：照片张数、联网、拆解、产出、用时和说明 */
function updateSlate3d() {
  const desc = $('#m3d-desc').value.trim();
  const n = photos.length;
  const up = photos.filter(x => x.state === 'uploading').length, failed = photos.filter(x => x.state === 'error').length;
  $('#m3d-examples').hidden = !!desc;
  $('#m3d-count').textContent = `${desc.length} 字`;
  $('#photos-count').textContent = `可选，${n} / ${PHOTO_MAX} 张`;
  $('#ph-add-li').hidden = n >= PHOTO_MAX;
  setTitle(desc);
  setSlate('s3-photos', n ? `${n} 张${up ? `<span class="dim">${up} 张上传中</span>` : failed ? `<span class="dim">${failed} 张没传上</span>` : ''}` : auto('不传，先画示意图'));
  const web = on('sw-web3d');
  $('#sw-web3d em').textContent = web ? '开' : '关';
  $('#web3d-hint').textContent = web ? '开：描述或照片里有具体型号时，Agent 会查它的尺寸、配色和材质。' : '关：只按描述和照片做。';
  setSlate('s3-web', web ? '开，有具体型号时查尺寸、配色、材质' : '不联网');
  // 做拆解（docs/library-3d-design.md 第六节）：多建内部零件，多出拆解图和 GIF 动图，用时大约翻倍
  const ex = on('sw-explode');
  $('#sw-explode em').textContent = ex ? '开' : '关';
  $('#explode-hint').textContent = ex ? '开：Agent 会把内部零件也做出来，并生成拆解动图和拆解图（适合发动机、机械、电器这类讲结构的物体）。' : '关：只做外观。';
  setSlate('s3-explode', ex ? '开，内部零件也做出来' : '关，只做外观');
  setSlate('s3-out', `3D 预览（${ex ? '可旋转、可拆开' : '可旋转'}）、多角度图、GLB、3D 打印文件${ex ? '、拆解图和 GIF 动图' : ''}`);
  setSlate('s3-eta', ex ? '约 20 到 40 分钟' : '约 10 到 20 分钟');
  $('#slate-note').textContent = (n === 0 ? '没有照片：Agent 先按描述画一张示意图，再照着建模。'
    : n === 1 ? '只有一张照片，看不到的面靠推测；再加几个角度会更像。'
    : `${n} 个角度的照片，Agent 会一起看，逐轮比对修正。`)
    + (ex ? '做拆解要多建内部零件，用时大约翻倍。' : '') + '做完自动进素材库，新建视频时可以直接引用。';
}

function updateSlate() {
  if (product === 'model3d') { updateSlate3d(); return; }
  const mode = val('mode');
  const adv = mode === 'advanced';
  const desc = $('#f-desc').value.trim();
  const c = counts();
  const web = on('sw-web'), strict = on('sw-strict');

  $('#adv').hidden = !adv;
  $('#l-desc').textContent = PROMPT[mode].label;
  $('#f-desc').placeholder = PROMPT[mode].ph;
  $('#examples').hidden = !!desc;
  const len = $('#f-desc').value.length; // 和 maxlength 的算法一样；粘贴超出的部分浏览器会直接截掉
  const dc = $('#desc-count');
  dc.textContent = `${num(len)} / ${num(DESC_MAX)} 字`;
  dc.classList.toggle('is-over', len >= DESC_MAX);
  $('#sw-web em').textContent = web ? '开' : '关';
  $('#sw-strict em').textContent = strict ? '开' : '关';
  // 强制引用只对你给的文件和链接生效（3D 图片不算）：没有时开关不能点（见 syncRefs）
  $('#strict-hint').textContent = !c.refs ? '先添加文件或链接，才能开强制引用。'
    : strict ? '开：片子里的事实、数字和术语只能来自资料。'
    : '关：资料只作参考，Agent 会更发散。';

  if (!desc) exampleTitle = '';
  setTitle(desc, exampleTitle);

  setSlate('s-mode', adv ? '高级' : '快速');

  // 资料：两种模式都生效。例如"3 份资料 · 1 个 3D 图片 · 联网 · 强制引用"、"无资料 · 联网"
  const refParts = [c.refs ? `${c.refs} 份资料` : !c.models && !c.pics && '无资料', c.pics && `${c.pics} 张图片`, c.models && `${c.models} 个 3D 图片`, web ? '联网' : '不联网', strict && '强制引用'].filter(Boolean);
  setSlate('s-refs', refParts.join('<span class="dim">·</span>'));

  const g = genre();
  updateGenre(g);
  setSlate('s-genre', g ? esc(g.name) : auto('交给 Agent 定'));

  setSlate('s-skills', use('c-skills')
    ? (selected.length ? esc(selected.map(skillName).join('、')) : '<span class="dim">还没选 Skill</span>')
    : auto('Agent 从仓库挑'));

  const ar = form.querySelector('input[name="ratio"]:checked').nextElementSibling.getAttribute('style');
  setSlate('s-spec', use('c-spec')
    ? `<i class="ar" style="${ar}"></i>${val('ratio')}，${durLabel(durSeconds())}，${val('res')}<span class="dim">${val('fps')} 帧</span>`
    : auto('Agent 按内容定'));

  setSlate('s-board', use('c-board') ? '先确认' : '不停下');
  const custom = val('dur') === 'custom';
  $('#dur-custom').hidden = !custom;
  const sec = durSeconds();
  $('#dur-hint').textContent = !custom ? '' : sec < 10 ? '最短 10 秒' : sec > LONG_SECONDS ? `超过 3 分钟的片子会先写总纲，再分成约 ${Math.max(2, Math.round(sec / 150))} 章同时制作` : '';
  setSlate('s-eta', use('c-spec') ? etaText(sec) : '约 5 到 10 分钟');

  const n = ADV.filter(checked).length;
  const notes = [];
  // 你指定的：写作方法、资料、强制引用（两种模式都生效），加上高级模式里勾选的项目
  const mine = n + (g ? 1 : 0) + (c.refs ? 1 : 0) + (strict ? 1 : 0) + (c.models ? 1 : 0);
  if (!adv) {
    const own = [g && `剧本按「${g.name}」的写作方法来组织`, c.refs && `${strict ? '事实、数字和术语只用' : '参考'}你给的 ${c.refs} 份资料`].filter(Boolean);
    notes.push(own.length ? `${own.join('，')}，其余由 Agent 决定。` : 'Agent 会先分析描述，自己决定写作方法、画风和规格。');
  } else notes.push(mine ? `你指定了 ${mine} 项，其余由 Agent 决定。` : '写作方法、资料和高级选项都没选，效果和快速模式一样，全部由 Agent 决定。');
  if (c.models) notes.push(`引用了 ${c.models} 个 3D 图片，Agent 会读素材卡，自己决定哪几镜用、怎么拍。`);
  if (use('c-board')) notes.push('写完分镜会停下来等你确认。');
  if (!web) notes.push('联网搜索已关闭，Agent 只用描述和你给的内容。');
  if (!adv && n) notes.push(`高级模式里勾选的 ${n} 项，在快速模式下不生效。`);
  $('#slate-note').textContent = notes.join('');
}

/* ---------- 上传：先申请预签名 URL，再直传（参考资料的文件、3D 图片的照片） ---------- */

function paint(item) {
  const pct = Math.round((item.progress || 0) * 100);
  const same = item.painted === item.state;
  item.painted = item.state;
  const st = $('.file-state', item.el);
  if (item.state === 'uploading' && same) {
    $('.mini-bar i', st).style.width = pct + '%';
    $('.pct', st).textContent = pct + '%';
    return;
  }
  st.className = 'file-state' + (item.state === 'done' ? ' ok' : item.state === 'error' ? ' err' : '');
  st.title = item.state === 'error' ? item.error : '';
  st.innerHTML = item.state === 'uploading'
    ? `<span class="mini-bar"><i style="width:${pct}%"></i></span><span class="pct">${pct}%</span>`
    : item.state === 'done' ? '<svg><use href="#i-check"/></svg>已上传'
    : '上传失败<button type="button" class="link-btn" data-retry-upload>重试</button>';
}

async function startUpload(item) {
  Object.assign(item, { state: 'uploading', progress: 0, error: '', handle: {} });
  paint(item);
  updateSlate();
  try {
    item.uploadId = await uploadFile(item.file, p => { if (!item.removed) { item.progress = p; paint(item); } }, item.handle, item.purpose);
    if (item.removed) return;
    item.state = 'done';
  } catch (e) {
    if (item.removed) return;
    item.state = 'error';
    item.error = e.message;
    if (e.status !== 401) toast(`「${item.file.name}」没有上传成功：${e.message}`, 'error');
  }
  paint(item);
  updateSlate();
}

const findItem = key => refs.find(u => u.key === key) || models.find(u => u.key === key) || photos.find(u => u.key === key) || pics.find(u => u.key === key) || null;

function removeItem(item) {
  item.removed = true;
  if (item.handle) { item.handle.cancelled = true; item.handle.abort?.(); }
  if (item.preview) URL.revokeObjectURL(item.preview);
  refs = refs.filter(u => u !== item);
  models = models.filter(u => u !== item);
  photos = photos.filter(u => u !== item);
  pics = pics.filter(u => u !== item);
  item.el.remove();
}

/* ---------- 添加资料：上传文件、从素材库选（文件和 3D 图片）、添加链接，排在一个列表里；文件和链接可以加一句备注 ---------- */

/** 就地提示：lines 为空时清掉；过一会儿自动收起 */
function hint(el, lines) {
  const list = [].concat(lines || []).filter(Boolean);
  el.textContent = list.join('\n');
  el.hidden = !list.length;
  clearTimeout(el.timer);
  if (list.length) el.timer = setTimeout(() => { el.hidden = true; }, 10000);
}
const rfHint = lines => hint($('#rf-msg'), lines);

function refLabel(r) {
  if (r.kind === 'file') return r.file.name;
  if (r.kind === 'library') return r.title;
  if (r.kind === 'model3d') return r.name;
  return r.url.replace(/^https?:\/\//, '').replace(/\/$/, '');
}
/** 名称后面的一行小字：文件的大小，素材库的来源，链接的网站，3D 图片能不能拆解 */
function refMeta(r) {
  if (r.kind === 'file') return fmtSize(r.file.size);
  if (r.kind === 'library') return ['来自素材库', r.size && fmtSize(r.size)].filter(Boolean).join(' · ');
  if (r.kind === 'model3d') return `3D 图片${r.explode ? ' · 可拆解' : ''}`;
  return new URL(r.url).host;
}

/** 列表里的一行：图标（3D 图片还有缩略图）、名称、小字、备注（3D 图片没有）、上传状态（只有上传的文件有）、移除 */
function refRow(r) {
  const li = document.createElement('li');
  li.className = 'rf-row';
  li.dataset.key = r.key;
  li.dataset.kind = r.kind;
  const name = refLabel(r), m3d = r.kind === 'model3d';
  li.innerHTML = `<svg class="ico" aria-hidden="true"><use href="#${REF_ICON[r.kind]}"/></svg>${m3d && r.thumb ? `<span class="rf-thumb"><img src="${esc(r.thumb)}" alt=""></span>` : ''}<span class="rf-name"></span><span class="rf-meta">${esc(refMeta(r))}</span>${m3d ? '' : '<input class="rf-note" type="text" maxlength="100" placeholder="加一句备注（可选）">'}${r.kind === 'file' ? '<span class="file-state"></span>' : ''}<button type="button" class="icon-btn" data-remove-ref><svg><use href="#i-x"/></svg></button>`;
  const el = $('.rf-name', li);
  el.textContent = name;
  el.title = r.kind === 'link' ? r.url : name;
  if (!m3d) $('.rf-note', li).setAttribute('aria-label', `「${name}」的备注`);
  $('[data-remove-ref]', li).setAttribute('aria-label', `移除${m3d ? ' 3D 图片' : ''}「${name}」`);
  return li;
}

/** 图片一行：缩略图、文件名、大小（或"来自素材库"）、上传状态、移除；下面一整行是必填的描述 */
function picRow(p) {
  const li = document.createElement('li');
  li.className = 'rf-row rf-pic';
  li.dataset.key = p.key;
  li.dataset.kind = p.kind;
  li.innerHTML = `<span class="rf-thumb"><img alt=""></span><span class="rf-name"></span><span class="rf-meta"></span>${p.kind === 'pic' ? '<span class="file-state"></span>' : ''}<button type="button" class="icon-btn" data-remove-ref><svg><use href="#i-x"/></svg></button>
    <input class="rf-note rf-desc" type="text" maxlength="${PIC_DESC_MAX}" required placeholder="这是什么、想在片子里怎么用（必填）。比如：新款保温杯正面图，讲外观时用">`;
  $('img', li).src = p.preview || p.url || '';
  $('.rf-name', li).textContent = p.name;
  $('.rf-name', li).title = p.name;
  $('.rf-meta', li).textContent = p.kind === 'pic' ? `图片 · ${fmtSize(p.file.size)}` : '图片 · 来自素材库';
  $('.rf-desc', li).value = p.desc || '';
  $('.rf-desc', li).setAttribute('aria-label', `「${p.name}」的描述（必填）`);
  $('[data-remove-ref]', li).setAttribute('aria-label', `移除图片「${p.name}」`);
  return li;
}

function pushPic(p) {
  p.el = picRow(p);
  rfList.insertBefore(p.el, models[0]?.el || null);
  pics.push(p);
}

const isImage = f => PHOTO_EXT.includes(extOf(f.name));

function addPics(files) {
  const errs = [];
  let skipped = 0;
  for (const f of files) {
    if (!f.size) { errs.push(`「${f.name}」是空文件，换一张试试`); continue; }
    if (f.size > PHOTO_MAX_BYTES) { errs.push(`「${f.name}」有 ${fmtSize(f.size)}，图片每张不超过 10 MB。压缩一下，或者换一张小一点的`); continue; }
    if (pics.some(x => x.kind === 'pic' && x.file.name === f.name && x.file.size === f.size)) { errs.push(`「${f.name}」已经加过了`); continue; }
    if (pics.length >= PIC_MAX) { skipped++; continue; }
    const p = { key: String(++seq), kind: 'pic', file: f, name: f.name, purpose: 'image', preview: URL.createObjectURL(f) };
    pushPic(p);
    startUpload(p);
  }
  if (skipped) errs.push(`图片最多 ${PIC_MAX} 张，有 ${skipped} 张没有加进来`);
  syncRefs();
  rfHint(errs);
  updateSlate();
  const empty = pics.find(x => !$('.rf-desc', x.el).value.trim());
  if (empty && !errs.length) $('.rf-desc', empty.el).focus(); // 加完马上写描述
}

/** 拖进来、选进来的文件：图片走图片，其他的当参考资料 */
function addFiles(files) {
  const imgs = files.filter(isImage);
  if (imgs.length) addPics(imgs);
  const rest = files.filter(f => !isImage(f));
  if (rest.length) addRefFiles(rest);
}

function pushRef(r) {
  r.el = refRow(r);
  rfList.insertBefore(r.el, models[0]?.el || null); // 3D 图片排在列表最后
  refs.push(r);
  syncRefs();
}

/** 已添加几项（参考资料和 3D 图片各有上限）；强制引用开关跟着有没有文件或链接走 */
function syncRefs() {
  const n = refs.length, total = n + models.length + pics.length;
  const sum = $('#rf-sum');
  sum.hidden = !total;
  sum.textContent = total ? `已添加 ${total} 项（资料 ${n}/${REF_MAX} · 图片 ${pics.length}/${PIC_MAX} · 3D 图片 ${models.length}/${MODEL_MAX}）` : '';
  $('#rf-link-count').textContent = `${linkCount()} / ${REF_MAX_LINKS} 个`;
  // 强制引用只管你给的文件和链接（联网搜到的、3D 图片都不算）：没有时关掉、不能点，最后一份移除时也关掉
  const strict = $('#sw-strict');
  strict.disabled = !n;
  if (!n) strict.setAttribute('aria-checked', 'false');
}

const fullMsg = () => `参考资料最多 ${REF_MAX} 份，先移除一份再加`;

function addRefFiles(files) {
  const errs = [];
  let skipped = 0;
  for (const f of files) {
    if (!REF_EXT.includes(extOf(f.name))) {
      errs.push(`「${f.name}」的格式不支持，参考资料只收 pdf、docx、md、txt、csv、xlsx，图片只收 png、jpg、webp`);
      continue;
    }
    if (!f.size) { errs.push(`「${f.name}」是空文件，换一个试试`); continue; }
    if (f.size > REF_MAX_BYTES) { errs.push(`「${f.name}」有 ${fmtSize(f.size)}，参考资料每个不超过 1 MB。可以拆成几份，或者把要用的部分写进描述`); continue; }
    if (refs.some(r => r.kind === 'file' && r.file.name === f.name && r.file.size === f.size)) { errs.push(`「${f.name}」已经加过了`); continue; }
    if (refs.length >= REF_MAX) { skipped++; continue; }
    const r = { key: String(++seq), kind: 'file', file: f, purpose: 'ref' };
    pushRef(r);
    startUpload(r);
  }
  if (skipped) errs.push(`参考资料最多 ${REF_MAX} 份，有 ${skipped} 个文件没有加进来`);
  rfHint(errs);
  updateSlate();
}

/* 添加链接（画风参考网站也用同样的网址检查） */
function normalizeUrl(raw) {
  if (!/^[\w-]+(\.[\w-]+)+/.test(raw.replace(/^https?:\/\//i, ''))) return null;
  const withProto = /^https?:\/\//i.test(raw) ? raw : 'https://' + raw;
  try {
    const u = new URL(withProto);
    if (!/^https?:$/.test(u.protocol) || !u.hostname.includes('.')) return null;
    return u.href;
  } catch { return null; }
}

function addLink() {
  const input = $('#rf-link-input');
  const msg = $('#rf-link-msg');
  const raw = input.value.trim();
  if (!raw) { hint(msg, '先粘贴一个网址'); input.focus(); return; }
  const url = normalizeUrl(raw);
  if (!url) { hint(msg, '这看起来不是网址，检查一下再添加'); input.focus(); return; }
  if (refs.some(r => r.kind === 'link' && r.url === url)) { hint(msg, '这个链接已经加过了'); input.focus(); return; }
  if (linkCount() >= REF_MAX_LINKS) { hint(msg, `链接最多 ${REF_MAX_LINKS} 个，先移除一个再加`); return; }
  if (refs.length >= REF_MAX) { hint(msg, fullMsg()); return; }
  pushRef({ key: String(++seq), kind: 'link', url });
  input.value = '';
  hint(msg);
  rfHint();
  input.focus(); // 链接常常一次加好几个：编辑框留着
  updateSlate();
}

function closeLink(clear) {
  if (clear) $('#rf-link-input').value = '';
  hint($('#rf-link-msg'));
  $('#rf-link-editor').hidden = true;
}

function openLinkEditor() {
  $('#rf-link-editor').hidden = false;
  $('#rf-link-input').focus();
}

/* "＋ 添加资料"菜单：上传文件、从素材库选、添加链接 */
const menuItems = () => $$('[role=menuitem]', rfMenu);

function openMenu() {
  rfMenu.hidden = false;
  rfAddBtn.setAttribute('aria-expanded', 'true');
  rfMenu.classList.remove('is-right');
  const box = $('#prompt').getBoundingClientRect(), r = rfMenu.getBoundingClientRect();
  if (r.right > Math.min(box.right, innerWidth - 8)) rfMenu.classList.add('is-right'); // 右边放不下时和按钮右对齐
  menuItems()[0].focus();
}

function closeMenu(focusBtn) {
  if (rfMenu.hidden) return;
  rfMenu.hidden = true;
  rfAddBtn.setAttribute('aria-expanded', 'false');
  if (focusBtn) rfAddBtn.focus();
}

function pickMenu(kind) {
  closeMenu(true);
  if (kind === 'library') { rfHint(); openLib(); return; } // 参考资料满了也能打开：还能选 3D 图片，文件那一页会提示
  if (kind === 'image') {
    if (pics.length >= PIC_MAX) { rfHint(`图片最多 ${PIC_MAX} 张，先移除一张再加`); return; }
    rfHint();
    $('#rf-img-input').click();
    return;
  }
  if (refs.length >= REF_MAX) { rfHint(fullMsg()); return; }
  if (kind === 'link' && linkCount() >= REF_MAX_LINKS) { rfHint(`链接最多 ${REF_MAX_LINKS} 个，先移除一个再加`); return; }
  rfHint();
  if (kind === 'file') $('#rf-file-input').click();
  else openLinkEditor();
}

function wireRefs() {
  rfAddBtn.addEventListener('click', () => (rfMenu.hidden ? openMenu() : closeMenu(true)));
  rfMenu.addEventListener('click', e => {
    const b = e.target.closest('[data-rf-add]');
    if (b) pickMenu(b.dataset.rfAdd);
  });
  rfMenu.addEventListener('keydown', e => {
    const items = menuItems();
    const i = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length].focus();
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      items[e.key === 'Home' ? 0 : items.length - 1].focus();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeMenu(true);
    } else if (e.key === 'Tab') closeMenu(false);
  });
  document.addEventListener('click', e => { if (!e.target.closest('.rf-add')) closeMenu(false); });

  const fileInput = $('#rf-file-input');
  fileInput.addEventListener('change', () => { addFiles([...fileInput.files]); fileInput.value = ''; });
  const imgInput = $('#rf-img-input');
  imgInput.addEventListener('change', () => { addPics([...imgInput.files].filter(isImage)); imgInput.value = ''; });
  rfList.addEventListener('input', e => { if (e.target.closest('.rf-desc')) e.target.classList.remove('is-bad'); });

  // 文件直接拖到描述块上也算上传参考资料
  const box = $('#prompt');
  const hasFiles = e => [...(e.dataTransfer?.types || [])].includes('Files');
  ['dragenter', 'dragover'].forEach(ev => box.addEventListener(ev, e => { if (hasFiles(e)) { e.preventDefault(); box.classList.add('is-over'); } }));
  box.addEventListener('dragleave', e => { if (!box.contains(e.relatedTarget)) box.classList.remove('is-over'); });
  box.addEventListener('drop', e => {
    box.classList.remove('is-over');
    if (!hasFiles(e)) return;
    e.preventDefault();
    addFiles([...e.dataTransfer.files]);
  });

  $('#rf-link-ok').addEventListener('click', addLink);
  $('#rf-link-input').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); addLink(); } });
  $('#rf-link-done').addEventListener('click', () => { closeLink(true); rfAddBtn.focus(); });

  rfList.addEventListener('click', e => {
    const rm = e.target.closest('[data-remove-ref]');
    if (!rm) return;
    const li = rm.closest('.rf-row');
    const item = findItem(li.dataset.key);
    if (!item) return;
    const next = li.nextElementSibling || li.previousElementSibling; // 删完把焦点放到相邻一行，没有了就回到"＋ 添加资料"
    removeItem(item);
    (next ? $('[data-remove-ref]', next) : rfAddBtn).focus();
    syncRefs();
    rfHint();
    updateSlate();
  });
}

/* ---------- 从素材库选：3D 图片（最多 3 个）不算参考资料，单独提交；文件算一份参考资料 ---------- */

/** 3D 图片加进列表，排在最后 */
function pushModel(x) {
  const m = { key: String(++seq), kind: 'model3d', id: x.id, name: x.name, thumb: x.thumb || heroView(x.views), explode: !!x.explode };
  m.el = refRow(m);
  rfList.append(m.el);
  models.push(m);
}

function openLib() {
  const lib = refs.filter(r => r.kind === 'library'), libPics = pics.filter(p => p.kind === 'libpic');
  openLibPicker({
    models,
    images: libPics.map(p => ({ id: p.fileId, name: p.name, url: p.url, desc: p.desc })),
    files: lib.map(r => ({ id: r.fileId, name: r.title, size: r.size })),
    maxModels: MODEL_MAX,
    maxImages: PIC_MAX - (pics.length - libPics.length),
    maxFiles: REF_MAX - (refs.length - lib.length),
  }, applyLib);
}

/** 选择框点了「完成」：3D 图片、图片和素材库的文件都去掉没选的，新选的排在已有的后面。图片带上素材库里存的描述，可以改 */
function applyLib({ models: picked, images = [], files }) {
  const mids = new Set(picked.map(x => x.id)), ids = new Set(files.map(f => f.id)), pids = new Set(images.map(x => x.id));
  [...models.filter(m => !mids.has(m.id)), ...refs.filter(r => r.kind === 'library' && !ids.has(r.fileId)),
    ...pics.filter(p => p.kind === 'libpic' && !pids.has(p.fileId))].forEach(removeItem);
  for (const x of images) {
    if (!pics.some(p => p.kind === 'libpic' && p.fileId === x.id)) pushPic({ key: String(++seq), kind: 'libpic', fileId: x.id, name: x.name, url: x.url, desc: x.desc || '' });
  }
  for (const f of files) {
    if (!refs.some(r => r.kind === 'library' && r.fileId === f.id)) pushRef({ key: String(++seq), kind: 'library', fileId: f.id, title: f.name, size: f.size });
  }
  for (const x of picked) if (!models.some(m => m.id === x.id)) pushModel(x);
  syncRefs();
  rfHint();
  updateSlate();
  rfAddBtn.focus();
}

/* ---------- 3D 图片：0～4 张同一物体不同角度的照片 ---------- */

function photoRow(x) {
  const li = document.createElement('li');
  li.className = 'ph';
  li.dataset.key = x.key;
  li.innerHTML = '<img alt=""><span class="file-state"></span><button type="button" class="icon-btn ph-x" data-remove-photo><svg><use href="#i-x"/></svg></button><span class="ph-name"></span>';
  $('img', li).src = x.preview;
  $('.ph-name', li).textContent = x.file.name;
  $('.ph-name', li).title = x.file.name;
  $('[data-remove-photo]', li).setAttribute('aria-label', `移除「${x.file.name}」`);
  return li;
}

function addPhotos(files) {
  const errs = [];
  let skipped = 0;
  for (const f of files) {
    if (!PHOTO_EXT.includes(extOf(f.name))) { errs.push(`「${f.name}」的格式不支持，照片只收 png、jpg、jpeg、webp`); continue; }
    if (!f.size) { errs.push(`「${f.name}」是空文件，换一张试试`); continue; }
    if (f.size > PHOTO_MAX_BYTES) { errs.push(`「${f.name}」有 ${fmtSize(f.size)}，超过了 10 MB。压缩一下，或者换一张小一点的`); continue; }
    if (photos.some(x => x.file.name === f.name && x.file.size === f.size)) { errs.push(`「${f.name}」已经加过了`); continue; }
    if (photos.length >= PHOTO_MAX) { skipped++; continue; }
    const x = { key: String(++seq), file: f, purpose: 'image', preview: URL.createObjectURL(f) };
    x.el = photoRow(x);
    $('#ph-add-li').before(x.el);
    photos.push(x);
    startUpload(x);
  }
  if (skipped) errs.push(`照片最多 ${PHOTO_MAX} 张，有 ${skipped} 张没有加进来`);
  hint($('#ph-msg'), errs);
  updateSlate();
}

function wirePhotos() {
  const input = $('#ph-input');
  $('#ph-add').addEventListener('click', () => input.click());
  input.addEventListener('change', () => { addPhotos([...input.files]); input.value = ''; });
  const box = $('#photos');
  const hasFiles = e => [...(e.dataTransfer?.types || [])].includes('Files');
  ['dragenter', 'dragover'].forEach(ev => box.addEventListener(ev, e => { if (hasFiles(e)) { e.preventDefault(); box.classList.add('is-over'); } }));
  box.addEventListener('dragleave', e => { if (!box.contains(e.relatedTarget)) box.classList.remove('is-over'); });
  box.addEventListener('drop', e => {
    box.classList.remove('is-over');
    if (!hasFiles(e)) return;
    e.preventDefault();
    addPhotos([...e.dataTransfer.files]);
  });
  $('#ph-grid').addEventListener('click', e => {
    if (!e.target.closest('[data-remove-photo]')) return;
    const li = e.target.closest('.ph');
    const item = findItem(li.dataset.key);
    if (!item) return;
    const next = li.nextElementSibling?.matches('.ph') ? li.nextElementSibling : li.previousElementSibling;
    removeItem(item);
    hint($('#ph-msg'));
    updateSlate();
    (next ? $('[data-remove-photo]', next) : $('#ph-add')).focus();
  });
  $('#m3d-examples').addEventListener('click', e => {
    const b = e.target.closest('[data-example]');
    if (!b) return;
    $('#m3d-desc').value = b.dataset.example;
    updateSlate();
    $('#m3d-desc').focus();
  });
  $('#m3d-form').addEventListener('input', updateSlate);
  $('#m3d-form').addEventListener('change', updateSlate);
}

/* ---------- 画风 Skills：挂载顺序（可拖动） ---------- */

function renderStack() {
  stack.innerHTML = selected.map(id => {
    const s = skillById(id);
    return `<li class="sk" draggable="true" data-id="${esc(id)}">
      <span class="grip" aria-hidden="true"><svg><use href="#i-grip"/></svg></span>
      <span class="rank" aria-hidden="true"></span>
      ${thumbArt(id)}
      <div><div class="sk-name">${esc(s?.name || id)}</div><div class="sk-sub">${selected.indexOf(id) === 0 ? '主画风' : '插入画风'}${s ? `，${esc(s.cat)}` : ''}</div></div>
      <button type="button" class="icon-btn" aria-label="移除 ${esc(s?.name || id)}" data-unmount="${esc(id)}"><svg><use href="#i-x"/></svg></button>
    </li>`;
  }).join('');
  updateSlate();
}

function wireStack() {
  let dragId = null;
  stack.addEventListener('dragstart', e => {
    const li = e.target.closest('.sk'); if (!li) return;
    dragId = li.dataset.id; li.classList.add('is-drag');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dragId);
  });
  stack.addEventListener('dragover', e => {
    e.preventDefault();
    $$('.sk', stack).forEach(x => x.classList.remove('is-target'));
    e.target.closest('.sk')?.classList.add('is-target');
  });
  stack.addEventListener('drop', e => {
    e.preventDefault();
    const target = e.target.closest('.sk');
    if (target && dragId && target.dataset.id !== dragId) {
      selected = selected.filter(x => x !== dragId);
      selected.splice(selected.indexOf(target.dataset.id), 0, dragId);
      renderStack();
      toast(`「${skillName(dragId)}」现在优先`);
    }
  });
  stack.addEventListener('dragend', () => { dragId = null; renderStack(); });
  stack.addEventListener('click', e => {
    const b = e.target.closest('[data-unmount]');
    if (b) { selected = selected.filter(x => x !== b.dataset.unmount); renderStack(); }
  });
}

/* 选 Skill 弹窗：选了写作方法时，这个写作方法常搭配的画风按顺序排在前面并标"常搭配"，其余照常排在后面，全部都能选。
   内测画风（只有管理员看得到）标"内测"，和其他画风一样能选 */
function renderPicker(list) {
  if (!list.length) { $('#pick-list').innerHTML = '<li class="pick-msg">官方库里暂时没有可用的 Skill。</li>'; return; }
  const g = genre();
  const paired = stylesOfGenre(g).map(id => list.find(s => s.id === id)).filter(Boolean);
  const rows = [...paired, ...list.filter(s => !paired.includes(s))];
  const hint = $('#pick-hint');
  hint.textContent = g && paired.length ? `写作方法选的是「${g.name}」：常搭配的 ${paired.length} 个画风排在前面，其他画风也都能选。` : '';
  hint.hidden = !hint.textContent;
  $('#pick-list').innerHTML = rows.map((s, i) => `${paired.length && i === paired.length ? '<li class="pick-sep" aria-hidden="true">其他画风</li>' : ''}<li><label class="pick">
    <input type="checkbox" value="${esc(s.id)}" ${selected.includes(s.id) ? 'checked' : ''}>
    ${thumbArt(s.id)}
    <div><b>${esc(s.name)}${i < paired.length ? '<span class="pair-tag">常搭配</span>' : ''}<span class="src-tag">${esc(s.cat)}</span>${s.beta ? `<span class="beta-tag" title="${BETA_HINT}">内测</span>` : ''}</b><p>${esc(s.summary)}</p></div>
  </label></li>`).join('');
  pickCount();
}
function pickCount() { $('#pick-count').textContent = `已选 ${$$('#pick-list input:checked').length} 个`; }

async function openPicker() {
  $('#pick-list').innerHTML = '<li class="pick-msg">正在加载 Skills…</li>';
  $('#pick-count').textContent = '';
  $('#pick-hint').hidden = true;
  openModal($('#picker'));
  try {
    renderPicker(await loadSkills());
  } catch (e) {
    $('#pick-list').innerHTML = `<li class="pick-msg">${esc(e.message)}<button type="button" class="link-btn" data-reload-skills>重试</button></li>`;
  }
}

/* ---------- 提交 ---------- */

function blocked(msg, focusSel) { toast(msg, 'error'); $(focusSel)?.focus(); }

/** 一份参考资料的提交格式（docs/references-design.md 第 3 节） */
function refPayload(r) {
  const note = ($('.rf-note', r.el)?.value || '').trim();
  if (r.kind === 'file') return { kind: 'file', uploadId: r.uploadId, name: r.file.name, note };
  if (r.kind === 'library') return { kind: 'library', fileId: r.fileId, note };
  return { kind: 'link', url: r.url, note };
}

const picDesc = p => ($('.rf-desc', p.el)?.value || '').replace(/\s+/g, ' ').trim();
/** 一张图片的提交格式：上传的给上传编号，素材库的给素材编号，都带描述 */
const picPayload = p => (p.kind === 'pic' ? { kind: 'file', uploadId: p.uploadId, name: p.file.name, desc: picDesc(p) } : { kind: 'library', fileId: p.fileId, desc: picDesc(p) });

function buildPayload() {
  const description = $('#f-desc').value.trim();
  const web = on('sw-web');
  // 写作方法和资料两种模式都传；写作方法"交给 Agent" 时传 null。顶层 web_search 留给老后端，值和 refs.web 一样
  const payload = {
    mode: val('mode'), web_search: web, description, genre: genre()?.id || null,
    refs: { web, strict: !!refs.length && on('sw-strict'), items: refs.map(refPayload) }, // 没有资料时强制引用一定是关
    models: models.map(m => m.id),
    images: pics.map(picPayload),
  };
  if (!isAdv()) return payload;
  const k = use('c-skills'), p = use('c-spec');
  payload.options = {
    skills: { enabled: k, ids: k ? [...selected] : [] },
    spec: {
      enabled: p, ratio: val('ratio'), duration: durSeconds(), resolution: val('res'), fps: Number(val('fps')),
      voice: on('sw-voice'), voice_id: $('#voice').value, subtitles: on('sw-sub'), bgm: on('sw-bgm'),
    },
    confirm_storyboard: use('c-board'),
  };
  if (!p) Object.assign(payload.options.spec, { ratio: '16:9', duration: 60, resolution: '1080p', fps: 30, voice: true, voice_id: 'auto', subtitles: true, bgm: false });
  return payload;
}

/** 视频不能开始的原因：[提示, 要聚焦的元素]；可以开始时返回 null */
function videoBlock() {
  if (!$('#f-desc').value.trim()) return ['先写一段描述，告诉 Agent 想做什么', '#f-desc'];
  if (refs.some(u => u.state === 'uploading')) return ['还有参考资料在上传，等上传完成再开始'];
  if (refs.some(u => u.state === 'error')) return ['有参考资料没有上传成功。点「重试」，或者移除后再开始'];
  if (pics.some(u => u.state === 'uploading')) return ['还有图片在上传，等上传完成再开始'];
  if (pics.some(u => u.state === 'error')) return ['有图片没有上传成功。点「重试」，或者移除后再开始'];
  const noDesc = pics.find(p => !picDesc(p));
  if (noDesc) { $('.rf-desc', noDesc.el).classList.add('is-bad'); return [`给图片「${noDesc.name}」写一句描述：这是什么、想在片子里怎么用`, `[data-key="${noDesc.key}"] .rf-desc`]; }
  if (use('c-skills') && !selected.length) return ['画风 Skills 已勾选但还没选。从仓库添加一个，或者取消勾选', '#open-picker'];
  if (use('c-spec') && val('dur') === 'custom' && (durSeconds() < 10 || durSeconds() > 36000)) return ['自定义时长要在 10 秒到 10 小时之间', '#f-dur-min'];
  return null;
}

function modelBlock() {
  if (!$('#m3d-desc').value.trim()) return ['先写一段描述，告诉 Agent 要做一个什么样的物体', '#m3d-desc'];
  if (photos.some(u => u.state === 'uploading')) return ['还有照片在上传，等上传完成再开始'];
  if (photos.some(u => u.state === 'error')) return ['有照片没有上传成功。点「重试」，或者移除后再开始'];
  return null;
}

/** 3D 图片的提交格式：照片按添加顺序 */
const modelPayload = () => ({
  product: 'model3d', description: $('#m3d-desc').value.trim(), web_search: on('sw-web3d'), explode: on('sw-explode'),
  images: photos.map(x => x.uploadId),
});

async function submit() {
  if (submitting) return;
  const m3d = product === 'model3d';
  const why = m3d ? modelBlock() : videoBlock();
  if (why) return blocked(...why);

  const btn = $('#start-btn');
  const unlock = () => {
    submitting = false;
    btn.disabled = false;
    btn.classList.remove('is-busy');
    btn.textContent = '开始生成';
  };
  submitting = true;
  btn.disabled = true;
  btn.classList.add('is-busy');
  btn.textContent = '正在提交…';
  let res;
  try {
    res = await api.post('/tasks', m3d ? modelPayload() : buildPayload());
    if (!res?.id) throw new Error('服务返回的数据不完整，请到任务列表里看看是否已经创建');
  } catch (e) {
    if (e.status !== 401) toast(e.message, 'error');
    if (e.status === 402) { const note = $('#quota-note'); note.textContent = `${e.message.replace(/[。.]$/, '')}。`; note.hidden = false; }
    unlock();
    return;
  }
  // 成功：打板动画结束后跳到生成页；跳转前按钮保持锁定，避免重复提交
  const go = () => { location.hash = 'run/' + encodeURIComponent(res.id); if (m3d) resetModel(); else resetForm(); unlock(); };
  if (reduceMotion) { go(); return; }
  const slate = $('#slate');
  slate.classList.add('is-clap');
  setTimeout(go, 520);
  setTimeout(() => slate.classList.remove('is-clap'), 900);
}

/** 提交成功后把表单恢复到初始状态，避免重复提交 */
function resetForm() {
  form.reset();
  $$('[role=switch]', form).forEach(sw => sw.setAttribute('aria-checked', sw.dataset.default));
  [...refs, ...models, ...pics].forEach(removeItem);
  closeLink(true);
  closeMenu(false);
  rfHint();
  syncRefs();
  selected = [];
  exampleTitle = '';
  lastMode = 'quick';
  renderStack();
}

/** 3D 图片提交成功后清空描述和照片；下次进来还是 3D 图片 */
function resetModel() {
  $('#m3d-desc').value = '';
  $$('[role=switch]', $('#m3d-form')).forEach(sw => sw.setAttribute('aria-checked', sw.dataset.default));
  [...photos].forEach(removeItem);
  hint($('#ph-msg'));
  updateSlate();
}

/* ---------- 对外接口 ---------- */

export const selectedSkills = () => [...selected];

/** 从素材库"用它做视频"：切到视频，把这个 3D 图片加进资料列表。满了返回 false */
export function useModel(item) {
  if (!models.some(m => m.id === item.id)) {
    if (models.length >= MODEL_MAX) { toast(`3D 图片最多引用 ${MODEL_MAX} 个，先在新建页移除一个再加`, 'error'); return false; }
    pushModel(item);
    syncRefs();
  }
  setProduct('video');
  return true;
}

/** 从 Skills 仓库"用在新视频里"：切到高级模式并勾上画风 Skills */
export function useSkill(id) {
  setProduct('video');
  if (!selected.includes(id)) {
    if (selected.length >= MAX_STYLES) { selected[MAX_STYLES - 1] = id; toast('最多两个画风，已替换插入画风'); }
    else selected.push(id);
  }
  form.querySelector('input[name="mode"][value="advanced"]').checked = true;
  lastMode = 'advanced';
  $('#c-skills').checked = true;
  renderStack();
}

/** 额度提示：只在快到上限时显示。q 是任务数额度，c 是本月 Credit（/me 的 credits） */
export function setQuota(q, c) {
  const el = $('#quota-note');
  if (!q && !c) { el.hidden = true; return; }
  let text = '';
  if (c?.warn === '100') text = '本月 Credit 额度已用完，下月 1 日恢复。';
  else if (q?.dailyLimit && q.today >= q.dailyLimit) text = `今天的 ${q.dailyLimit} 支额度已经用完，明天再来。`;
  else if (q?.runningLimit && q.running >= q.runningLimit) text = `同时最多 ${q.runningLimit} 个生成中的任务，等其中一个完成后再开始。`;
  el.textContent = text;
  el.hidden = !text;
}

// ---------- 配音音色：目录来自 GET /api/voices，试听音频是部署时生成好的静态文件，不实时合成 ----------
let voices = null;
const preview = new Audio();

async function loadVoices() {
  if (voices) return;
  try { voices = (await api.get('/voices'))?.items || []; } catch { voices = null; return; }
  const sel = $('#voice'), groups = new Map();
  for (const v of voices) { if (!groups.has(v.cat)) groups.set(v.cat, []); groups.get(v.cat).push(v); }
  sel.innerHTML = '<option value="auto">由 Agent 按内容挑选</option>' + [...groups].map(([cat, list]) =>
    `<optgroup label="${esc(cat)}">${list.map(v => `<option value="${esc(v.id)}">${esc(v.name)}</option>`).join('')}</optgroup>`).join('');
  syncVoice();
}

function syncVoice() {
  const v = (voices || []).find(x => x.id === $('#voice').value), on = $('#sw-voice').getAttribute('aria-checked') === 'true';
  $('#voice-desc').textContent = v ? v.desc : '';
  $('#voice-play').disabled = !v || !on;
  $('#voice').disabled = !on;
  if (!v || !on) stopPreview();
}

function stopPreview() {
  preview.pause();
  $('#voice-play use').setAttribute('href', '#i-play');
}

function togglePreview() {
  const v = (voices || []).find(x => x.id === $('#voice').value);
  if (!v) return;
  if (!preview.paused && preview.dataset.id === v.id) { stopPreview(); return; }
  preview.src = v.preview; preview.dataset.id = v.id;
  preview.play().then(() => $('#voice-play use').setAttribute('href', '#i-pause')).catch(() => toast('试听音频加载失败'));
}

export function enter() {
  updateSlate();
  loadVoices();
  // 画风名称和写作方法列表都来自目录；提前取一次，场记板、挂载列表和写作方法选项才能显示
  loadSkills()
    .then(() => { renderGenres(); renderStack(); })
    .catch(() => { if (!genresReady) { genresFailed = true; updateSlate(); } });
}

export function init() {
  $('#s-date').textContent = today();
  $('#voice').addEventListener('change', syncVoice);
  $('#sw-voice').addEventListener('change', syncVoice);
  $('#voice-play').addEventListener('click', togglePreview);
  preview.addEventListener('ended', stopPreview);

  [form, $('#m3d-form')].forEach(f => $$('[role=switch]', f).forEach(sw => sw.addEventListener('click', () => {
    sw.setAttribute('aria-checked', sw.getAttribute('aria-checked') !== 'true');
    sw.dispatchEvent(new Event('change', { bubbles: true }));
  })));

  form.addEventListener('input', updateSlate);
  form.addEventListener('change', e => {
    if (e.target.name === 'mode') {
      const m = val('mode');
      const n = ADV.filter(checked).length;
      if (m === 'quick' && lastMode === 'advanced' && n) toast(`高级模式里勾选的 ${n} 项不生效`);
      lastMode = m;
    }
    updateSlate();
  });

  $('#examples').addEventListener('click', e => {
    const b = e.target.closest('[data-example]');
    if (!b) return;
    $('#f-desc').value = b.dataset.example;
    exampleTitle = b.dataset.title || '';
    updateSlate();
    $('#f-desc').focus();
  });

  $('#product').addEventListener('change', e => setProduct(e.target.value));

  wireRefs();
  syncRefs();
  wirePhotos();
  // 重试上传（参考资料的文件、3D 图片的照片）
  [form, $('#m3d-form')].forEach(f => f.addEventListener('click', e => {
    if (!e.target.closest('[data-retry-upload]')) return;
    const item = findItem(e.target.closest('[data-key]')?.dataset.key);
    if (item) startUpload(item);
  }));

  // 从素材库选（「＋ 添加资料」菜单里打开）
  initLibPicker();

  wireStack();

  const picker = $('#picker');
  picker.addEventListener('click', e => {
    if (e.target === picker || e.target.closest('[data-close]')) closeModal(picker);
    if (e.target.closest('[data-reload-skills]')) openPicker();
  });
  $('#pick-list').addEventListener('change', pickCount);
  $('#open-picker').addEventListener('click', openPicker);
  $('#pick-done').addEventListener('click', () => {
    const boxes = $$('#pick-list input[type=checkbox]');
    if (boxes.length) {
      const chosen = boxes.filter(i => i.checked).map(i => i.value);
      selected = [...selected.filter(id => chosen.includes(id)), ...chosen.filter(id => !selected.includes(id))];
      if (selected.length > MAX_STYLES) { selected = selected.slice(0, MAX_STYLES); toast('最多选两个：一个主画风，一个插入画风'); }
      renderStack();
    }
    closeModal(picker);
  });
  addEventListener('keydown', e => { if (e.key === 'Escape' && !picker.hidden) closeModal(picker); });

  $('#start-btn').addEventListener('click', submit);
  [form, $('#m3d-form')].forEach(f => f.addEventListener('submit', e => e.preventDefault()));  // 在输入框里按回车不提交表单

  renderStack();
}
