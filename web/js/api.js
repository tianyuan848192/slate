/* 调用 Slate API。请求头 Authorization: <idToken>；401 时刷新 token 再试一次，还不行就回到登录页。
   所有错误都整理成 ApiError，message 是可以直接给用户看的中文。 */

import { config } from './config.js';
import { getIdToken, refresh, logout } from './auth.js';
import { toast } from './util.js';

export class ApiError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

const hasChinese = s => typeof s === 'string' && /[一-鿿]/.test(s);

function fallbackMessage(status) {
  if (status === 400) return '提交的内容有误，请检查后再试';
  if (status === 402) return '本月额度已用完，下月 1 日恢复';
  if (status === 403) return '没有权限执行这个操作';
  if (status === 404) return '没有找到对应的内容，可能已被删除，或者不属于当前账号';
  if (status === 409) return '现在不能执行这个操作，请稍后再试';
  if (status === 413) return '内容太大了，请减少后再试';
  if (status === 429) return '操作太频繁或超出了额度，请稍后再试';
  if (status >= 500) return '服务暂时不可用，请稍后再试';
  return '请求失败，请稍后再试';
}

/* 登录过期：清掉 token，记住当前页面，回到登录页（多个请求同时失败时只提示一次） */
let expiring = false;
function expireSession() {
  logout();
  if (expiring) return;
  expiring = true;
  setTimeout(() => { expiring = false; }, 1500);
  const here = location.hash;
  if (here && !here.startsWith('#login')) sessionStorage.setItem('slate-next', here);
  sessionStorage.setItem('slate-expired', '1');
  // 整页重载（和退出一样）：清掉上一个账号留在页面里的数据，免得同一个标签页换账号登录后还看得到
  location.replace('#login');
  location.reload();
}

async function send(method, path, body, token, timeout) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  const headers = { Authorization: token };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  try {
    return await fetch(config().apiBase + path, {
      method, headers, cache: 'no-store', signal: ctrl.signal,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    if (e.name === 'AbortError') throw new ApiError(0, 'timeout', '请求超时，请检查网络后重试');
    throw new ApiError(0, 'network', '网络连接失败，请检查网络后重试');
  } finally {
    clearTimeout(timer);
  }
}

/** raw 为 true 时返回响应体 Blob（导出文件用），出错时照常抛 ApiError */
export async function request(method, path, body, { timeout = 20000, raw = false } = {}) {
  let token = await getIdToken();
  if (!token) { expireSession(); throw new ApiError(401, 'unauthorized', '登录已过期，请重新登录'); }

  let res = await send(method, path, body, token, timeout);
  if (res.status === 401) {
    // token 过期：刷新后重试一次
    try { await refresh(); } catch (e) {
      if (e.code === 'network') throw new ApiError(0, 'network', '网络连接失败，请检查网络后重试');
      expireSession();
      throw new ApiError(401, 'unauthorized', '登录已过期，请重新登录');
    }
    token = await getIdToken();
    if (token) res = await send(method, path, body, token, timeout);
    if (!token || res.status === 401) {
      expireSession();
      throw new ApiError(401, 'unauthorized', '登录已过期，请重新登录');
    }
  }

  if (raw && res.ok) return res.blob();
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    // 只采用后端给的中文说明；网关默认返回的英文提示换成中文
    const msg = hasChinese(data?.message) ? data.message : fallbackMessage(res.status);
    // 402 = 本月 Credit 额度用完：通知顶部额度条立刻变成"已用完"并刷新一次
    if (res.status === 402) dispatchEvent(new CustomEvent('slate:quota-exceeded', { detail: { message: msg } }));
    throw new ApiError(res.status, data?.error || 'http_' + res.status, msg);
  }
  return data;
}

export const api = {
  get: (path, opts) => request('GET', path, undefined, opts),
  post: (path, body = {}, opts) => request('POST', path, body, opts),
  patch: (path, body = {}, opts) => request('PATCH', path, body, opts),
  del: (path, opts) => request('DELETE', path, undefined, opts),
};

/** 带登录凭证下载一个文件（比如用量 CSV）：先取回 Blob，再用临时链接触发保存 */
export async function downloadFile(path, filename) {
  const blob = await request('GET', path, undefined, { raw: true, timeout: 60000 });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/* ---------- 上传：先申请预签名 URL，再 PUT 文件本体 ---------- */

const TYPES = {
  md: 'text/markdown', markdown: 'text/markdown', txt: 'text/plain', csv: 'text/csv', pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
};
export function contentTypeOf(file) {
  if (file.type) return file.type;
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  return TYPES[ext] || 'application/octet-stream';
}

/**
 * 上传一个文件，返回 uploadId。
 * onProgress(0~1) 汇报进度；handle.abort() 可以取消。
 * purpose：'ref' 参考资料（pdf、docx、md、txt、csv、xlsx，每个不超过 1 MB）；'image' 3D 图片的参考照片（png、jpg、jpeg、webp，每张不超过 10 MB）。
 */
export async function uploadFile(file, onProgress, handle = {}, purpose) {
  const contentType = contentTypeOf(file);
  const body = { filename: file.name, contentType, size: file.size };
  if (purpose) body.purpose = purpose;
  const meta = await api.post('/uploads', body);
  if (handle.cancelled) throw new ApiError(0, 'aborted', '已取消上传');
  if (!meta?.url || !meta?.uploadId) throw new ApiError(0, 'bad_response', '上传服务返回的数据不完整，请重试');
  await new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', meta.url);
    const headers = meta.headers || { 'Content-Type': contentType };
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = e => { if (e.lengthComputable) onProgress?.(e.loaded / e.total); };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else if (xhr.status === 403) reject(new ApiError(403, 'upload_denied', '上传链接已失效，请重试'));
      else reject(new ApiError(xhr.status, 'upload_failed', '上传没有成功，请重试'));
    };
    xhr.onerror = () => reject(new ApiError(0, 'network', '网络连接中断，请重试'));
    xhr.onabort = () => reject(new ApiError(0, 'aborted', '已取消上传'));
    handle.abort = () => xhr.abort();
    xhr.send(file);
  });
  onProgress?.(1);
  return meta.uploadId;
}
