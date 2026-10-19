/* 管理端登录：浏览器直接调用 Cognito（管理端自己的应用客户端），token 存在 sessionStorage（关掉标签页就退出）。
   用户端和管理端是两个客户端，管理员在用户端登录的令牌调不了管理端 API */
let cfg = null;
const KEY = 'slate-admin-auth';
let session = read();
let pending = null;   // 首次登录要设新密码：{email, username, session}
let refreshing = null;

export async function loadConfig() {
  if (!cfg) cfg = await (await fetch('config.json', { cache: 'no-store' })).json();
  return cfg;
}
function read() { try { return JSON.parse(sessionStorage.getItem(KEY)) || null; } catch { return null; } }
function write(s) { session = s; if (s) sessionStorage.setItem(KEY, JSON.stringify(s)); else sessionStorage.removeItem(KEY); }

export class AuthError extends Error { constructor(code, message) { super(message); this.code = code; } }
export const isLoggedIn = () => !!(session && session.idToken);
export const sessionEmail = () => session?.email || '';

function cognitoMessage(type, msg) {
  switch (type) {
    case 'NotAuthorizedException':
      if (/attempts exceeded/i.test(msg)) return '密码错误次数太多，请稍后再试';
      if (/session is expired|invalid session/i.test(msg)) return '设置新密码超时了，请重新登录';
      if (/disabled/i.test(msg)) return '这个账号已被停用';
      if (/refresh token/i.test(msg)) return '登录已过期，请重新登录';
      return '邮箱或密码不正确';
    case 'UserNotFoundException': return '邮箱或密码不正确';
    case 'InvalidPasswordException': return '新密码不符合要求：至少 8 位，同时包含大写字母、小写字母和数字';
    case 'TooManyRequestsException': case 'LimitExceededException': return '操作太频繁，请稍后再试';
    default: return '登录服务暂时不可用，请稍后再试';
  }
}
async function cognito(target, body) {
  const { region } = await loadConfig();
  let res;
  try {
    res = await fetch(`https://cognito-idp.${region}.amazonaws.com/`, {
      method: 'POST', body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/x-amz-json-1.1', 'X-Amz-Target': `AWSCognitoIdentityProviderService.${target}` },
    });
  } catch { throw new AuthError('network', '网络连接失败，请检查网络后重试'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const type = String(data.__type || '').split('#').pop();
    throw new AuthError(type, cognitoMessage(type, String(data.message || data.Message || '')));
  }
  return data;
}
function store(email, r, prevRefresh) {
  write({ email, idToken: r.IdToken, refreshToken: r.RefreshToken || prevRefresh, expiresAt: Date.now() + (Number(r.ExpiresIn) || 3600) * 1000 });
}

/** 登录。返回 {ok: true} 或 {challenge: 'NEW_PASSWORD_REQUIRED'} */
export async function login(email, password) {
  pending = null;
  const { clientId } = await loadConfig();
  const d = await cognito('InitiateAuth', { AuthFlow: 'USER_PASSWORD_AUTH', ClientId: clientId, AuthParameters: { USERNAME: email, PASSWORD: password } });
  if (d.AuthenticationResult) { store(email, d.AuthenticationResult); return { ok: true }; }
  if (d.ChallengeName === 'NEW_PASSWORD_REQUIRED') {
    pending = { email, username: d.ChallengeParameters?.USER_ID_FOR_SRP || email, session: d.Session };
    return { challenge: 'NEW_PASSWORD_REQUIRED' };
  }
  throw new AuthError('challenge', '这个账号需要额外的验证步骤，目前还不支持');
}
export async function completeNewPassword(pw) {
  if (!pending) throw new AuthError('expired', '设置新密码超时了，请重新登录');
  const { clientId } = await loadConfig();
  const d = await cognito('RespondToAuthChallenge', { ChallengeName: 'NEW_PASSWORD_REQUIRED', ClientId: clientId, Session: pending.session,
    ChallengeResponses: { USERNAME: pending.username, NEW_PASSWORD: pw } });
  if (!d.AuthenticationResult) throw new AuthError('challenge', '这个账号需要额外的验证步骤，目前还不支持');
  store(pending.email, d.AuthenticationResult); pending = null;
  return { ok: true };
}
async function refresh() {
  if (!session?.refreshToken) return null;
  if (!refreshing) {
    const { clientId } = await loadConfig();
    refreshing = cognito('InitiateAuth', { AuthFlow: 'REFRESH_TOKEN_AUTH', ClientId: clientId, AuthParameters: { REFRESH_TOKEN: session.refreshToken } })
      .then(d => { store(session.email, d.AuthenticationResult, session.refreshToken); return session.idToken; })
      .catch(() => { write(null); return null; })
      .finally(() => { refreshing = null; });
  }
  return refreshing;
}
/** 当前 idToken；5 分钟内过期就先刷新 */
export async function idToken() {
  if (!session) return null;
  if (Date.now() > session.expiresAt - 300e3) return refresh();
  return session.idToken;
}
export function logout() {
  // 刷新令牌也作废：退出以后，别处留着的令牌换不到新的登录（不等结果，失败了也照样退出）
  const token = session?.refreshToken;
  if (token) loadConfig().then(({ clientId }) => cognito('RevokeToken', { Token: token, ClientId: clientId })).catch(() => {});
  write(null);
}
