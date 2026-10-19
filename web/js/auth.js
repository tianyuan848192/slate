/* 登录：浏览器直接调用 Cognito（InitiateAuth / RespondToAuthChallenge），不经过 API。
   token 存在 localStorage；退出时清掉。config.mock 为 true 时（只在本地 mock 服务器下）跳过 Cognito，用假 token。 */

import { config } from './config.js';

const KEY = 'slate-auth';
let session = read();
let pending = null; // NEW_PASSWORD_REQUIRED 质询：{email, username, session}
let refreshing = null;

function read() {
  try { return JSON.parse(localStorage.getItem(KEY)) || null; } catch { return null; }
}
function write(s) {
  session = s;
  if (s) localStorage.setItem(KEY, JSON.stringify(s));
  else localStorage.removeItem(KEY);
}
// 其他标签页登录或退出时同步
addEventListener('storage', e => { if (e.key === KEY) session = read(); });

export class AuthError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

export const isLoggedIn = () => !!(session && session.idToken);
export const sessionEmail = () => session?.email || '';

/* ---------- Cognito 错误 → 中文 ---------- */

function passwordPolicyText(msg) {
  const need = [];
  if (/uppercase/i.test(msg)) need.push('大写字母');
  if (/lowercase/i.test(msg)) need.push('小写字母');
  if (/numeric|number/i.test(msg)) need.push('数字');
  if (/symbol|special/i.test(msg)) need.push('符号');
  if (/long enough|length|minimum/i.test(msg) && !need.length) return '新密码太短了，至少需要 8 位';
  return need.length ? `新密码还需要包含${need.join('、')}` : '新密码不符合要求：至少 8 位，需要同时包含大小写字母、数字和符号';
}

function cognitoMessage(type, msg, target) {
  switch (type) {
    case 'NotAuthorizedException':
      if (/attempts exceeded/i.test(msg)) return '密码错误次数太多，请稍后再试';
      if (/session is expired|invalid session/i.test(msg)) return '设置新密码超时了，请返回重新登录';
      if (/refresh token/i.test(msg) || target === 'refresh') return '登录已过期，请重新登录';
      if (/disabled/i.test(msg)) return '这个账号已被停用，请联系管理员';
      return '邮箱或密码不正确';
    case 'UserNotFoundException': return '邮箱或密码不正确';
    case 'PasswordResetRequiredException': return '这个账号需要重置密码，请联系管理员';
    case 'UserNotConfirmedException': return '这个账号还没有激活，请联系管理员';
    case 'InvalidPasswordException': return passwordPolicyText(msg);
    case 'InvalidParameterException': return '填写的信息格式不对，请检查后再试';
    case 'TooManyRequestsException':
    case 'LimitExceededException': return '操作太频繁，请稍后再试';
    case 'ResourceNotFoundException': return '登录服务配置有误，请联系管理员';
    default: return '登录服务暂时不可用，请稍后再试';
  }
}

async function cognito(target, body, kind) {
  const { region } = config();
  let res;
  try {
    res = await fetch(`https://cognito-idp.${region}.amazonaws.com/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-amz-json-1.1',
        'X-Amz-Target': `AWSCognitoIdentityProviderService.${target}`,
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new AuthError('network', '网络连接失败，请检查网络后重试');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const type = String(data.__type || '').split('#').pop();
    throw new AuthError(type || 'http_' + res.status, cognitoMessage(type, String(data.message || data.Message || ''), kind));
  }
  return data;
}

function store(email, r, prevRefresh) {
  write({
    email,
    idToken: r.IdToken,
    accessToken: r.AccessToken,
    refreshToken: r.RefreshToken || prevRefresh, // 刷新时 Cognito 不再返回 RefreshToken，沿用旧的
    expiresAt: Date.now() + (Number(r.ExpiresIn) || 3600) * 1000,
  });
}

/* mock 模式：假 token 里带上邮箱和签发时间，mock 服务器据此识别用户、模拟过期 */
function mockStore(email) {
  const t = `mock.${encodeURIComponent(email)}.${Date.now()}`;
  write({ email, idToken: t, accessToken: t, refreshToken: 'mock-refresh', expiresAt: Date.now() + 3600 * 1000 });
}

/* ---------- 对外接口 ---------- */

/** 登录。返回 {ok: true} 或 {challenge: 'NEW_PASSWORD_REQUIRED'} */
export async function login(email, password) {
  pending = null;
  if (config().mock) { mockStore(email); return { ok: true }; }
  const data = await cognito('InitiateAuth', {
    AuthFlow: 'USER_PASSWORD_AUTH',
    ClientId: config().clientId,
    AuthParameters: { USERNAME: email, PASSWORD: password },
  });
  if (data.AuthenticationResult) { store(email, data.AuthenticationResult); return { ok: true }; }
  if (data.ChallengeName === 'NEW_PASSWORD_REQUIRED') {
    pending = { email, username: data.ChallengeParameters?.USER_ID_FOR_SRP || email, session: data.Session };
    return { challenge: 'NEW_PASSWORD_REQUIRED' };
  }
  throw new AuthError('challenge', '这个账号需要额外的验证步骤，目前还不支持，请联系管理员');
}

/** 首次登录设置新密码 */
export async function completeNewPassword(newPassword) {
  if (!pending) throw new AuthError('expired', '设置新密码超时了，请返回重新登录');
  const data = await cognito('RespondToAuthChallenge', {
    ChallengeName: 'NEW_PASSWORD_REQUIRED',
    ClientId: config().clientId,
    Session: pending.session,
    ChallengeResponses: { USERNAME: pending.username, NEW_PASSWORD: newPassword },
  });
  if (data.AuthenticationResult) {
    store(pending.email, data.AuthenticationResult);
    pending = null;
    return { ok: true };
  }
  if (data.Session) pending.session = data.Session;
  throw new AuthError('challenge', '这个账号需要额外的验证步骤，目前还不支持，请联系管理员');
}

export const hasPendingChallenge = () => !!pending;

/** 用 refreshToken 换新的 idToken；同一时间只发一个刷新请求 */
export function refresh() {
  if (!refreshing) refreshing = doRefresh().finally(() => { refreshing = null; });
  return refreshing;
}
async function doRefresh() {
  const s = session;
  if (!s?.refreshToken) throw new AuthError('no_session', '登录已过期，请重新登录');
  if (config().mock) { mockStore(s.email); return; }
  const data = await cognito('InitiateAuth', {
    AuthFlow: 'REFRESH_TOKEN_AUTH',
    ClientId: config().clientId,
    AuthParameters: { REFRESH_TOKEN: s.refreshToken },
  }, 'refresh');
  if (!data.AuthenticationResult) throw new AuthError('refresh', '登录已过期，请重新登录');
  store(s.email, data.AuthenticationResult, s.refreshToken);
}

/** 取当前 idToken；快过期时先刷新。刷新被拒绝时清掉登录状态并返回 null */
export async function getIdToken() {
  if (!session) return null;
  if (session.expiresAt && session.expiresAt - Date.now() < 60_000) {
    try { await refresh(); } catch (e) {
      if (e.code !== 'network') { logout(); return null; }
      // 网络问题：先用旧 token 试，真过期了会收到 401
    }
  }
  return session?.idToken || null;
}

export function logout() {
  pending = null;
  // 刷新令牌也作废：退出以后，别处留着的令牌换不到新的登录（不等结果，失败了也照样退出）
  if (session?.refreshToken && !config().mock) {
    cognito('RevokeToken', { Token: session.refreshToken, ClientId: config().clientId }).catch(() => {});
  }
  write(null);
}
