/* 读取部署时生成的 config.json：{apiBase, region, userPoolId, clientId}；本地 mock 服务器会额外返回 mock: true */

let cfg = null;

export async function loadConfig() {
  if (cfg) return cfg;
  const res = await fetch(new URL('config.json', document.baseURI), { cache: 'no-store' });
  if (!res.ok) throw new Error('config ' + res.status);
  const data = await res.json();
  cfg = {
    apiBase: String(data.apiBase || '/api').replace(/\/+$/, ''),
    region: data.region || 'us-east-1',
    userPoolId: data.userPoolId || '',
    clientId: data.clientId || '',
    mock: data.mock === true, // 只有显式为 true 才进入 mock 模式
  };
  return cfg;
}

export const config = () => cfg;
