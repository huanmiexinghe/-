// 服务器地址唯一来源：联机（WebSocket）与自制关卡上传/下载（HTTP）都从这里取地址。
//
// 规则：
// - ws/wss/http/https 都接受，统一规范化成 host[:port]（去掉尾斜杠、路径、查询串）；
//   联机用 wsUrl，HTTP 接口用 httpUrl，两者协议自动互换（ws↔http、wss↔https）。
// - 裸地址（无协议）：公网域名默认补 wss://（项目硬约束：默认地址必须是 wss）；
//   本地/内网主机、显式非 443 端口补 ws://（局域网与云电脑的 8080 明文服务）。
// - 非法地址（空、协议不对、非法端口）返回错误，由调用方提示，不静默回退默认值。

export const SERVER_URL_STORAGE_KEY = 'mr_server_url';

/**
 * 默认联机服务器地址：内测阶段直连阿里云 Linux 服务器（明文 ws，端口 8080）。
 * 服务端 relay 监听 0.0.0.0:8080，外网已验证 /api/levels 200、/admin 303、ws 能收到 hello。
 * 明文只用于测试期：后台密码、Cookie、联机消息都不加密；正式发布应换回 wss（域名 + 证书）。
 * 玩家仍可在联机大厅改地址，不需要改这行。
 */
export const DEFAULT_SERVER_URL: string = 'ws://47.96.190.73:8080';

export type NormalizedServerUrl =
  | { ok: true; wsUrl: string; httpUrl: string }
  | { ok: false; error: string };

export type ResolvedServerUrl =
  | { ok: true; wsUrl: string; httpUrl: string; stored: boolean }
  | { ok: false; error: string };

// 本地/内网主机：这类地址没有 TLS，裸写时应补 ws://
const LOCAL_HOST_RE = /^(localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|169\.254\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})$/;

function isLocalHost(host: string): boolean {
  return LOCAL_HOST_RE.test(host) || host === '[::1]' || host === '::1';
}

/** 裸地址（无协议）推断协议：无端口时公网域名走 wss，本地/显式非 443 端口走 ws */
function inferScheme(body: string): 'ws' | 'wss' {
  const authority = body.split(/[/?#]/, 1)[0] ?? '';
  const port = /:(\d+)$/.exec(authority);
  if (port) return port[1] === '443' ? 'wss' : 'ws';
  return isLocalHost(authority) ? 'ws' : 'wss';
}

/**
 * 规范化服务器地址。
 * 返回 wsUrl（联机用）与 httpUrl（上传/下载用），端口与主机保持不变。
 */
export function normalizeServerUrl(raw: string): NormalizedServerUrl {
  const input = typeof raw === 'string' ? raw.trim() : '';
  if (!input) return { ok: false, error: '服务器地址不能为空' };
  if (/\s/.test(input)) return { ok: false, error: '服务器地址不能包含空格' };

  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//.exec(input);
  let scheme: 'ws' | 'wss';
  let body: string;
  if (schemeMatch) {
    const s = schemeMatch[1].toLowerCase();
    if (s === 'ws' || s === 'http') scheme = 'ws';
    else if (s === 'wss' || s === 'https') scheme = 'wss';
    else return { ok: false, error: `不支持的协议 ${s}://，请用 ws://、wss://、http:// 或 https://` };
    body = input.slice(schemeMatch[0].length);
  } else {
    body = input.replace(/^\/+/, '');
    scheme = inferScheme(body);
  }
  if (!body) return { ok: false, error: '服务器地址缺少主机名' };

  let url: URL;
  try {
    // URL 只用来校验主机/端口；路径、查询串全部丢弃
    url = new URL(`${scheme}://${body}`);
  } catch {
    return { ok: false, error: '服务器地址格式不正确（示例：wss://server.example:8080）' };
  }
  if (!url.hostname) return { ok: false, error: '服务器地址缺少主机名' };
  if (url.port) {
    const port = Number(url.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return { ok: false, error: '端口需在 1–65535 之间' };
    }
  }
  const authority = url.host; // host[:port]，IPv6 带方括号
  return {
    ok: true,
    wsUrl: `${scheme}://${authority}`,
    httpUrl: `${scheme === 'wss' ? 'https' : 'http'}://${authority}`,
  };
}

function storage(): Storage | null {
  try {
    // Node（selfcheck）里没有 localStorage，直接当作无覆盖值
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  } catch {
    return null;
  }
}

/** 联机大厅保存的覆盖地址（原样返回，未规范化） */
export function getStoredServerUrl(): string {
  try {
    return storage()?.getItem(SERVER_URL_STORAGE_KEY)?.trim() ?? '';
  } catch {
    return '';
  }
}

/** 保存覆盖地址：先校验，非法值不写入；返回规范化结果便于调用方提示 */
export function setStoredServerUrl(raw: string): NormalizedServerUrl {
  const result = normalizeServerUrl(raw);
  if (!result.ok) return result;
  try {
    storage()?.setItem(SERVER_URL_STORAGE_KEY, result.wsUrl);
  } catch { /* 隐私模式写入失败不影响本次连接 */ }
  return result;
}

export function clearStoredServerUrl(): void {
  try {
    storage()?.removeItem(SERVER_URL_STORAGE_KEY);
  } catch { /* ignore */ }
}

/**
 * 当前生效地址：有合法覆盖值用覆盖值，否则用默认常量。
 * 覆盖值非法时返回错误（不静默回退），提示用户回去重填。
 */
export function resolveServerUrl(): ResolvedServerUrl {
  const saved = getStoredServerUrl();
  if (saved) {
    const result = normalizeServerUrl(saved);
    if (!result.ok) {
      return { ok: false, error: `已保存的服务器地址无效（${result.error}），请在联机大厅重新填写` };
    }
    return { ok: true, wsUrl: result.wsUrl, httpUrl: result.httpUrl, stored: true };
  }
  if (!DEFAULT_SERVER_URL) {
    return { ok: false, error: '未配置默认服务器，请先在联机大厅填写服务器地址' };
  }
  const result = normalizeServerUrl(DEFAULT_SERVER_URL);
  if (!result.ok) return { ok: false, error: `默认服务器地址无效（${result.error}）` };
  return { ok: true, wsUrl: result.wsUrl, httpUrl: result.httpUrl, stored: false };
}

/**
 * 隐私政策页面地址：由当前生效的服务器地址派生（与联机/关卡接口同源），
 * 不在界面层重复硬编码域名。服务端由 relay-server.mjs 提供 GET /privacy.html。
 */
export function privacyPolicyUrl(): string {
  const resolved = resolveServerUrl();
  if (!resolved.ok) return '';
  return `${resolved.httpUrl}/privacy.html`;
}
