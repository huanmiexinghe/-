// 自制关卡分享客户端：上传 / 按分享码下载
//
// 服务器地址不写死：一律取「当前生效的服务器地址」（ServerUrl.resolveServerUrl），
// 与联机大厅改地址用的是同一套规范化规则，避免改了联机地址后地图仍传旧服务器。

import { normalizeServerUrl, resolveServerUrl } from './ServerUrl';
import {
  CustomLevelData, CustomObstacleDto, sanitizeObstacles,
} from '../systems/CustomLevels';

export const LEVELS_API_PATH = '/api/levels';
const REQUEST_TIMEOUT_MS = 8000;
const MAX_NAME_LENGTH = 20;
/** 服务端分享码：8 位、去掉易混淆字符（与 server/level-store.mjs 的字母表一致） */
export const SERVER_CODE_RE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/;

/** 输入是否像服务端分享码（大小写不敏感） */
export function isServerShareCode(code: string): boolean {
  return SERVER_CODE_RE.test(code.trim().toUpperCase());
}

export type ShareCodeKind = 'server' | 'legacy' | 'invalid';

/**
 * 统一码制识别（玩家不需要猜格式）：
 * - server：8 位服务端分享码 → 走 HTTP 下载（跨设备以服务端为准）
 * - legacy：旧版本地 base64 关卡码（长串）→ 本地解码
 * - invalid：其他内容 → 明确报错
 */
export function classifyShareCode(raw: string): ShareCodeKind {
  const t = raw.trim();
  if (!t) return 'invalid';
  if (isServerShareCode(t)) return 'server';
  // 旧版 encode 产出的是 base64url 长串（通常 > 200 字符）
  if (t.length >= 40 && /^[A-Za-z0-9_\-+/=]+$/.test(t)) return 'legacy';
  return 'invalid';
}

/** 分享码面板的展示模型（不依赖剪贴板权限：码本身永远可见） */
export function sharePanelModel(code: string, copied: boolean) {
  return {
    codeText: code.split('').join(' '),
    copyLabel: copied ? '已复制！' : '复制分享码',
    hint: '已保存到「我的地图」，好友在「自定义关卡 → 输入分享码」填写',
  };
}

/** 当前生效地址；没有合法地址时抛错，不做静默回退 */
function currentHttpBase(): string {
  const resolved = resolveServerUrl();
  if (!resolved.ok) throw new Error(resolved.error);
  return resolved.httpUrl;
}

/**
 * 联机地址 → HTTP 接口地址：wss://host → https://host，ws://host → http://host。
 * 不传参时取当前生效地址；传参时按同一套规则规范化（裸域名、http(s)、尾斜杠、多余路径都能处理）。
 */
export function httpBaseFromWs(wsUrl?: string): string {
  if (wsUrl === undefined) return currentHttpBase();
  const parsed = normalizeServerUrl(wsUrl);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.httpUrl;
}

export function levelsApiUrl(wsUrl?: string): string {
  return `${httpBaseFromWs(wsUrl)}${LEVELS_API_PATH}`;
}

async function request(url: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(/abort/i.test(msg) ? '请求超时' : `网络请求失败（${msg}）`);
  } finally {
    clearTimeout(timer);
  }
}

async function readJson(res: Response): Promise<any> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/** HTTP 失败的明确原因：区分隧道/服务不可用、限流、校验被拒，不显示空码 */
export function httpFailureMessage(status: number, json: any): string {
  if (typeof json?.error === 'string' && json.error.trim()) return json.error;
  if (status === 502 || status === 503 || status === 504) {
    return `服务器暂时不可用（HTTP ${status}，隧道未连通或服务未启动）`;
  }
  if (status === 429) return '请求过于频繁，请稍后再试';
  if (status === 413) return '关卡数据过大，服务端拒绝接收';
  if (status === 400) return '服务器校验未通过（关卡数据不合法）';
  return `服务器返回 HTTP ${status}`;
}

/** 校验上传响应：必须带合法分享码，否则按“服务端版本过旧/响应异常”报错 */
export function parseUploadResponse(json: any): UploadResult {
  const code = typeof json?.code === 'string' ? json.code.trim().toUpperCase() : '';
  if (!isServerShareCode(code)) {
    throw new Error('服务器未返回有效分享码（服务端可能仍是旧版，请更新 relay-server.mjs 后重启）');
  }
  return {
    code,
    name: typeof json?.name === 'string' ? json.name : '分享关卡',
    count: Number.isFinite(Number(json?.count)) ? Number(json.count) : 0,
  };
}

export interface UploadResult {
  code: string;
  name: string;
  count: number;
}

/** 上传当前地图；服务端会重新校验，失败时抛出带原因的 Error */
export async function uploadLevel(
  data: CustomLevelData,
  wsUrl?: string,
): Promise<UploadResult> {
  if (data.obstacles.length === 0) throw new Error('关卡是空的');
  const res = await request(levelsApiUrl(wsUrl), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: data.name.slice(0, MAX_NAME_LENGTH),
      obstacles: data.obstacles,
    }),
  });
  const json = await readJson(res);
  if (!res.ok || !json?.ok) throw new Error(httpFailureMessage(res.status, json));
  return parseUploadResponse(json);
}

/** 按分享码下载；分享码不存在返回 null，网络/服务异常抛错 */
export async function downloadLevel(
  code: string,
  wsUrl?: string,
): Promise<CustomLevelData | null> {
  const clean = code.trim().toUpperCase();
  if (!/^[A-Z0-9_-]{4,24}$/.test(clean)) throw new Error('分享码格式不正确（应为 8 位字母数字）');
  const res = await request(`${levelsApiUrl(wsUrl)}/${encodeURIComponent(clean)}`);
  if (res.status === 404) return null;
  const json = await readJson(res);
  if (!res.ok || !json?.ok) throw new Error(httpFailureMessage(res.status, json));
  // 客户端再走一次本地 sanitize：即使服务端被替换，导入也不会注入未知字段
  const obstacles = sanitizeObstacles(Array.isArray(json.obstacles) ? json.obstacles : []);
  if (obstacles.length === 0) return null;
  return {
    id: Date.now(),
    name: typeof json.name === 'string' && json.name.trim()
      ? json.name.trim().slice(0, MAX_NAME_LENGTH)
      : '分享关卡',
    obstacles: obstacles as CustomObstacleDto[],
    createdAt: Date.now(),
    shareCode: clean,
  };
}

export interface RemoteLevelSummary {
  code: string;
  name: string;
  count: number;
  createdAt: number;
}

/** 最近上传列表（服务端只返回元信息，不含障碍数据） */
export async function listLevels(
  wsUrl?: string,
): Promise<RemoteLevelSummary[]> {
  const res = await request(levelsApiUrl(wsUrl));
  const json = await readJson(res);
  if (!res.ok || !json?.ok || !Array.isArray(json.levels)) return [];
  return json.levels
    .filter((l: unknown) => !!l && typeof (l as RemoteLevelSummary).code === 'string')
    .map((l: RemoteLevelSummary) => ({
      code: l.code, name: String(l.name ?? ''), count: Number(l.count ?? 0), createdAt: Number(l.createdAt ?? 0),
    }));
}

/** 复制到剪贴板；失败返回 false，调用方可退回 prompt 展示 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* 无剪贴板权限，走下方兜底 */ }
  // 兜底：页面来源为 http://localhost 等非 https 源、或 clipboard 权限被拒时，
  // 用隐藏 textarea + execCommand('copy')（WebView 中仍可用，不弹权限框）。
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.top = '-1000px';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    area.setSelectionRange(0, text.length);
    const copied = document.execCommand('copy');
    document.body.removeChild(area);
    return copied;
  } catch {
    return false;
  }
}
