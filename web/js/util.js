/* 通用小工具：选择器、转义、提示、时间格式 */

export const $ = (s, el = document) => el.querySelector(s);
export const $$ = (s, el = document) => [...el.querySelectorAll(s)];
export const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
/** 把任意值转成可以安全放进 HTML 的文本 */
export const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ESC[c]);

/** 底部提示条；kind='error' 时用红色并停留久一点 */
export function toast(msg, kind = '') {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.toggle('is-error', kind === 'error');
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), kind === 'error' ? 4200 : 2600);
}

const pad = n => String(n).padStart(2, '0');

/** 秒 → 00:23 */
export const mmss = t => {
  t = Math.max(0, Math.floor(t || 0));
  return `${pad(Math.floor(t / 60))}:${pad(t % 60)}`;
};
/** 秒 → 0:23（步骤时间、分镜时间用） */
export const mss = t => mmss(t).replace(/^0(\d)/, '$1');

/** 时长 → "15 秒" / "90 秒" / "3 分钟" / "2 分 30 秒" */
export function durLabel(sec) {
  const s = Math.round(Number(sec) || 0);
  if (s <= 90) return `${s} 秒`;
  const m = Math.floor(s / 60), r = s % 60;
  return r ? `${m} 分 ${r} 秒` : `${m} 分钟`;
}

export function fmtSize(b) {
  return b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB';
}

const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** 毫秒时间戳 → "刚刚" / "5 分钟前" / "今天 14:20" / "昨天 18:20" / "10月9日" */
export function relTime(ms) {
  if (!ms) return '';
  const d = new Date(ms), now = new Date();
  const diff = (now - d) / 1000;
  if (diff < 60) return '刚刚';
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (sameDay(d, now)) return `今天 ${hm}`;
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (sameDay(d, y)) return `昨天 ${hm}`;
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`;
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

/** 毫秒时间戳 → "10月12日 14:20" */
export function dateTime(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  return `${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function today() {
  const d = new Date();
  return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())}`;
}

/** 只放行 http(s) 链接，防止 javascript: 之类的地址；空值返回 null（不当成相对地址） */
export function safeUrl(u) {
  if (!u) return null;
  try {
    const x = new URL(u, location.href);
    return x.protocol === 'http:' || x.protocol === 'https:' ? x.href : null;
  } catch { return null; }
}
export function hostOf(u) {
  try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; }
}
/** 预签名链接每次轮询都会变，用去掉查询串的部分判断是不是同一个文件 */
export const keyOf = u => String(u || '').split('?')[0];

/* 弹窗：记住打开前的焦点，关掉后还回去（每个弹窗各记各的，叠着打开也不乱） */
const opener = new WeakMap();
export function openModal(el, focusEl) {
  opener.set(el, document.activeElement);
  el.hidden = false;
  (focusEl || $('button, input', el))?.focus();
}
export function closeModal(el) {
  el.hidden = true;
  const back = opener.get(el);
  opener.delete(el);
  if (back?.isConnected) back.focus();
}
let lastFocus = null;
export function rememberFocus() { lastFocus = document.activeElement; }
export function restoreFocus() { lastFocus?.focus?.(); }
