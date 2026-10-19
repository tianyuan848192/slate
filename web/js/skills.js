/* Skills 仓库 #skills：上面是写作方法（剧本怎么组织，只有文字说明），下面是官方画风库（按用途分类、可搜索）；
   详情抽屉展示效果预览、画风说明和常搭配的写作方法。内测中的生成画风（只有管理员看得到）标「内测」 */

import { $, $$, esc, toast, rememberFocus, restoreFocus } from './util.js';
import { thumbArt } from './art.js';
import { loadSkills, skillById, categories, genreGroups, genresOfStyle, BETA_HINT } from './catalog.js';
import { selectedSkills, useSkill } from './compose.js';

let list = null;
let cat = null;
let drawerId = null;

function showMessage(html) {
  $('#contact').innerHTML = '';
  const p = $('#skill-empty');
  p.innerHTML = html;
  p.hidden = false;
}

/* 写作方法：按分组列出名字、说明和例子 */
function renderGenres() {
  const groups = genreGroups();
  const box = $('#genre-lib');
  box.closest('.lib').hidden = !groups.length;
  box.innerHTML = groups.map(g => `<section class="gl-group">
    <h3>${esc(g.name)}</h3>
    <ul class="gl-list">${g.items.map(x => `<li>
      <b>${esc(x.name)}${x.beta ? `<span class="beta-tag" title="${BETA_HINT}">内测</span>` : ''}</b>
      <p>${esc(x.summary || '')}</p>
      ${x.example ? `<p class="eg">比如：${esc(x.example)}</p>` : ''}
    </li>`).join('')}</ul>
  </section>`).join('');
}

function renderCats() {
  $('#skill-cats').innerHTML = categories(list)
    .map(c => `<button type="button" aria-pressed="${c === cat}" data-c="${esc(c)}">${esc(c)}</button>`).join('');
}

function render() {
  if (!list) return;
  const q = $('#skill-q').value.trim().toLowerCase();
  const sel = selectedSkills();
  const rows = list.filter(s =>
    (!cat || s.cat === cat) &&
    (!q || [s.name, s.summary, s.cat, s.beta ? '内测' : '', ...(s.highlights || []), ...genresOfStyle(s.id).map(g => g.name)].join(' ').toLowerCase().includes(q)));
  $('#contact').innerHTML = rows.map(s => `<li><button type="button" class="frame" data-id="${esc(s.id)}">
    <span class="thumb">${thumbArt(s.id, '')}${sel.includes(s.id) ? '<span class="in-use"><svg><use href="#i-check"/></svg>新视频已选用</span>' : ''}</span>
    <span class="frame-h"><b>${esc(s.name)}</b><span class="src-tag">${esc(s.cat)}</span>${s.beta ? `<span class="beta-tag" title="${BETA_HINT}">内测</span>` : ''}</span>
    <p>${esc(s.summary)}</p>
    <span class="frame-meta"><span>v${esc(s.ver)}</span>${s.ratio ? `<span>画幅 ${esc(s.ratio)}</span>` : ''}${s.beta ? '<span>仅管理员可见</span>' : ''}</span>
  </button></li>`).join('');
  const empty = $('#skill-empty');
  empty.textContent = list.length ? '没有符合条件的 Skill。换个关键词试试。' : '官方库里暂时没有可用的 Skill。';
  empty.hidden = rows.length > 0;
}

function openDrawer(id) {
  const s = skillById(id);
  if (!s) return;
  drawerId = id;
  rememberFocus();
  $('#d-preview').innerHTML = thumbArt(id, '');
  $('#d-name').textContent = s.name;
  $('#d-cat').textContent = s.cat || '';
  $('#d-cat').hidden = !s.cat;
  $('#d-beta').hidden = !s.beta;
  $('#d-beta-note').textContent = s.beta ? `内测中：${BETA_HINT}。` : '';
  $('#d-beta-note').hidden = !s.beta;
  $('#d-desc').textContent = s.summary || '';
  $('#d-meta').innerHTML = [['版本', 'v' + s.ver], ['用途', s.cat || '不限'], ['画幅', s.ratio || '不限']]
    .map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join('');
  $('#d-highlights').innerHTML = (s.highlights || []).map(h => `<li>${esc(h)}</li>`).join('') || '<li>暂无说明</li>';
  // 常搭配的写作方法：反查哪些写作方法的 styles 里有这个画风
  $('#d-genres').innerHTML = genresOfStyle(id).map(g => `<li>${esc(g.name)}</li>`).join('') || '<li>不限，任何写作方法都能用</li>';
  $('#d-use').textContent = selectedSkills().includes(id) ? '已选用，去新建视频' : '用在新视频里';
  $('#scrim').hidden = false;
  $('#drawer').hidden = false;
  $('#drawer-x').focus();
}

function closeDrawer() {
  if ($('#drawer').hidden) return;
  $('#scrim').hidden = true;
  $('#drawer').hidden = true;
  restoreFocus();
}

export async function enter() {
  if (!list) showMessage('正在加载 Skills…');
  else render();
  try {
    list = await loadSkills();
    renderGenres();
    renderCats();
    render();
  } catch (e) {
    if (e.status === 401) return;
    if (!list) showMessage(`${esc(e.message)}<button type="button" class="link-btn" data-reload>重试</button>`);
    else toast(e.message, 'error');
  }
}

export function leave() { closeDrawer(); }

export function init() {
  $('#skill-cats').addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    cat = cat === b.dataset.c ? null : b.dataset.c;
    $$('#skill-cats button').forEach(x => x.setAttribute('aria-pressed', x.dataset.c === cat));
    render();
  });
  $('#skill-q').addEventListener('input', render);
  $('#skill-empty').addEventListener('click', e => { if (e.target.closest('[data-reload]')) enter(); });
  $('#contact').addEventListener('click', e => { const b = e.target.closest('.frame'); if (b) openDrawer(b.dataset.id); });
  $('#drawer-x').addEventListener('click', closeDrawer);
  $('#scrim').addEventListener('click', closeDrawer);
  $('#d-use').addEventListener('click', () => {
    const s = skillById(drawerId);
    if (!s) return;
    useSkill(s.id);
    closeDrawer();
    location.hash = 'compose';
    toast(`已切到高级模式，「${s.name}」加进了画风 Skills`);
  });
  addEventListener('keydown', e => { if (e.key === 'Escape') closeDrawer(); });
}
