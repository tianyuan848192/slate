/* 入口：读取配置、hash 路由（#login #compose #run/<id> #projects #library #skills #usage #flows #flow/<画板>）、登录守卫、左侧导航、顶部额度条 */

import { $, $$ } from './util.js';
import { loadConfig } from './config.js';
import { isLoggedIn, logout, sessionEmail } from './auth.js';
import { api } from './api.js';
import * as login from './login.js';
import * as compose from './compose.js';
import * as run from './run.js';
import * as projects from './projects.js';
import * as library from './library.js';
import * as skills from './skills.js';
import * as usage from './usage.js';
import * as flows from './flows.js';
import * as flow from './flow.js';
import * as credits from './credits.js';

const PAGES = { compose, run, projects, library, skills, usage, flows, flow };
const TITLES = { login: '登录', compose: '新建', run: '生成过程', projects: '任务', library: '素材库', skills: 'Skills 仓库', usage: '用量',
                 flows: '工作流模式', flow: '工作流画板' };

let current = null; // {name, arg}
let me = null;
let meAt = 0;
let meLoading = false;
const ME_STALE_MS = 60000; // 切换页面时，/me 超过 1 分钟就重新取（顶部额度条跟着更新）

function parse() {
  const raw = location.hash.replace(/^#\/?/, '');
  const i = raw.indexOf('/');
  const name = i < 0 ? raw : raw.slice(0, i);
  let arg = i < 0 ? '' : raw.slice(i + 1);
  try { arg = decodeURIComponent(arg); } catch { /* 保留原样 */ }
  return { name, arg };
}

const go = h => location.replace('#' + h); // 会触发 hashchange，再走一遍 route

function leaveCurrent() {
  if (current) PAGES[current.name]?.leave?.();
  current = null;
}

function show(name) {
  const isLogin = name === 'login';
  $('#view-login').hidden = !isLogin;
  $('#shell').hidden = isLogin;
  $$('.view').forEach(v => v.classList.toggle('is-active', v.dataset.view === name));
  $$('.rail-item[data-route]').forEach(a => {
    const on = a.dataset.route.split(' ').includes(name);
    a.classList.toggle('is-on', on);
    if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  if (name !== 'run' && name !== 'flow') document.title = `${TITLES[name]}｜Slate`;
}

function paintAvatar() {
  const email = me?.email || sessionEmail();
  const av = $('#avatar');
  av.textContent = (email.trim()[0] || '·').toUpperCase();
  av.title = email ? `退出登录（${email}）` : '退出登录';
  av.setAttribute('aria-label', av.title);
}

function loadMe() {
  if (meLoading) return;
  meLoading = true;
  api.get('/me')
    .then(m => {
      me = m;
      meAt = Date.now();
      compose.setQuota(m?.quota, m?.credits);
      credits.setMonth(m?.credits);
    })
    .catch(() => {})
    .finally(() => { meLoading = false; paintAvatar(); });
}

function route() {
  const { name, arg } = parse();

  if (name === 'login') {
    if (isLoggedIn()) return go('compose');
    leaveCurrent();
    me = null;
    credits.setMonth(null);
    show('login');
    login.enter();
    return;
  }
  // 未登录访问其他页面：记住目标，回到登录页
  if (!isLoggedIn()) {
    if (name && PAGES[name]) sessionStorage.setItem('slate-next', location.hash);
    return go('login');
  }
  if (!PAGES[name]) return go('compose');
  if (name === 'run' && !arg) return go('projects');
  if (name === 'flow' && !arg) return go('flows');

  const same = current && current.name === name && current.arg === arg;
  if (!same) {
    const prevName = current?.name;
    leaveCurrent();
    show(name);
    if (prevName !== name) window.scrollTo(0, 0);
  }
  current = { name, arg };
  paintAvatar();
  if (!me || name === 'compose' || Date.now() - meAt > ME_STALE_MS) loadMe(); // 新建页每次刷新一下额度
  PAGES[name].enter(arg);
}

async function boot() {
  try {
    await loadConfig();
  } catch {
    $('#boot-reload').addEventListener('click', () => location.reload());
    $('#boot-error').hidden = false;
    return;
  }
  login.init();
  compose.init();
  run.init();
  projects.init();
  library.init();
  skills.init();
  usage.init();
  flows.init();
  flow.init();
  credits.init();
  credits.setRefresher(loadMe);

  $('#avatar').addEventListener('click', () => {
    logout();
    sessionStorage.removeItem('slate-next');
    // 整页重载，清掉上一个账号留在页面里的数据
    location.replace('#login');
    location.reload();
  });

  addEventListener('hashchange', route);
  route();
}

boot();
