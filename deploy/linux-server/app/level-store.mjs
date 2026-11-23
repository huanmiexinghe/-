// 自制关卡 HTTP 存储与校验（与联机 WebSocket 完全独立）
//
// 设计要点：
//  - 不信任客户端：尺寸 / 障碍数量 / 坐标范围 / 字段白名单全部服务端重算一遍；
//  - 请求体硬上限 64KB，单 IP 限流，分享码用 crypto 随机生成（非自增 id）；
//  - 落盘 server/data/levels.json，启动时读回，重启不丢；
//  - 仅暴露 /api/levels 系列 HTTP 路由，不触碰 WS 的 clientId / token 逻辑。

import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

export const MAX_BODY_BYTES = 64 * 1024;
export const MAX_OBSTACLES = 300;
export const MAX_NAME_LENGTH = 20;
export const MAX_LEVELS = 2000;
export const MAX_BAITS = 2;
/** 世界坐标 / 尺寸上限，与客户端 sanitizeObstacles 对齐 */
export const LIMITS = {
  x: 20000,
  y: 540,
  w: 560,
  h: 600,
  minWH: 8,
  maxRight: 20050,
};

export const SHARE_CODE_LENGTH = 8;
/** 接口版本：GET /api/levels 会返回该字段，用于确认远端是否为最新服务端 */
export const LEVELS_API_VERSION = 2;
/** 去掉易混淆字符（0/O、1/I/L），降低口头分享出错率 */
export const SHARE_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export const VALID_KINDS = [
  'RED_SPIKE', 'BLUE_SPIKE', 'WALL', 'PORTAL_A', 'PORTAL_B',
  'POLARITY_ZONE', 'GRAVITY_FLIP', 'SPEED_BOOST', 'FINISH',
  'PENDULUM', 'COLLECTIBLE', 'SPECIAL_ITEM', 'PLATFORM',
  'MOVING_PLATFORM', 'POLARITY_WALL', 'PULSE_LASER',
  'MAGNET_RAIN', 'POLARITY_LOCK', 'CORE_BAIT', 'MAGNET_MIRROR',
  'LAUNCH_PAD', 'CONVEYOR', 'PIT',
];

const SHARE_CODE_RE = new RegExp(`^[${SHARE_CODE_ALPHABET}]{${SHARE_CODE_LENGTH}}$`);

export function isValidShareCode(code) {
  return typeof code === 'string' && SHARE_CODE_RE.test(code);
}

/** crypto 随机分享码；8 字符 × 32 字母表 ≈ 1.1×10^12 组合，不可遍历 */
export function makeShareCode(randBytes = n => randomBytes(n)) {
  const bytes = randBytes(SHARE_CODE_LENGTH);
  let s = '';
  for (let i = 0; i < SHARE_CODE_LENGTH; i++) {
    s += SHARE_CODE_ALPHABET[bytes[i] % SHARE_CODE_ALPHABET.length];
  }
  return s;
}

function clampNum(v, lo, hi, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, n));
}

/** 元数据白名单：只保留各类型已知字段，其余一律丢弃 */
export function sanitizeMeta(kind, raw) {
  if (!raw || typeof raw !== 'object') return undefined;
  const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
  switch (kind) {
    case 'PORTAL_A':
    case 'PORTAL_B':
      return { portalId: Math.round(num(raw.portalId, 1)) };
    case 'POLARITY_ZONE':
      return { forcedPolarity: raw.forcedPolarity === 'BLUE' ? 'BLUE' : 'RED' };
    case 'SPEED_BOOST':
      return {
        multiplier: clampNum(raw.multiplier, 1.2, 3, 2),
        duration: clampNum(raw.duration, 0.5, 10, 3),
      };
    case 'PENDULUM':
      return {
        rope: clampNum(raw.rope, 150, 340, 260),
        polarity: raw.polarity === 'BLUE' ? 'BLUE' : 'RED',
        amplitude: clampNum(raw.amplitude, 0.35, 0.85, 0.62),
        swingSpeed: clampNum(raw.swingSpeed, 1.2, 2.62, 2.2),
        warnLead: clampNum(raw.warnLead, 0.3, 0.8, 0.45),
        phase: num(raw.phase, 0),
      };
    case 'SPECIAL_ITEM':
      return {
        itemId: typeof raw.itemId === 'string' ? raw.itemId.slice(0, 24) : 'CUSTOM_STAR',
        itemName: typeof raw.itemName === 'string' ? raw.itemName.slice(0, 16) : '星核',
      };
    case 'COLLECTIBLE': {
      // 颜色白名单：非 RED/BLUE 一律丢弃（= 任意极性可拾取）
      const meta = {};
      if (raw.color === 'RED' || raw.color === 'BLUE') meta.color = raw.color;
      if (raw.currency === 1 || raw.currency === true) meta.currency = 1;
      return Object.keys(meta).length > 0 ? meta : undefined;
    }
    case 'MOVING_PLATFORM':
      return {
        axis: raw.axis === 'x' ? 'x' : 'y',
        range: clampNum(raw.range, 60, 140, 90),
        period: clampNum(raw.period, 2.4, 4, 3),
        phase: clampNum(raw.phase, 0, 1, 0),
      };
    case 'POLARITY_WALL': {
      const meta = { polarity: raw.polarity === 'BLUE' ? 'BLUE' : 'RED' };
      const range = clampNum(raw.range, 0, 140, 0);
      if (range > 0) {
        meta.range = range;
        meta.period = clampNum(raw.period, 2, 5, 3);
        meta.phase = clampNum(raw.phase, 0, 1, 0);
      }
      return meta;
    }
    case 'MAGNET_RAIN':
      return {
        polarity: raw.polarity === 'BLUE' ? 'BLUE' : 'RED',
        count: Math.round(clampNum(raw.count, 1, 5, 3)),
      };
    case 'LAUNCH_PAD':
      return { polarity: raw.polarity === 'BLUE' ? 'BLUE' : 'RED' };
    case 'CONVEYOR':
      return {
        dir: raw.dir === -1 ? -1 : 1,
        speed: clampNum(raw.speed, 30, 180, 90),
      };
    case 'PULSE_LASER':
      return {
        orientation: raw.orientation === 'H' ? 'H' : 'V',
        period: clampNum(raw.period, 2.4, 3.2, 2.8),
        warn: 0.8,
        on: clampNum(raw.on, 0.4, 0.6, 0.5),
      };
    default:
      return undefined;
  }
}

/**
 * 服务端独立校验。返回值：
 *   { ok: true, data: { name, obstacles } }
 *   { ok: false, error }
 * 非法坐标 / 超量 / 超尺寸 / 非法类型一律整包拒绝。
 */
export function sanitizeLevel(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: '载荷必须是 JSON 对象' };
  }
  const nameRaw = typeof raw.name === 'string' ? raw.name.trim() : '';
  const name = (nameRaw || '分享关卡').slice(0, MAX_NAME_LENGTH);
  const arr = raw.obstacles;
  if (!Array.isArray(arr)) return { ok: false, error: 'obstacles 必须是数组' };
  if (arr.length === 0) return { ok: false, error: '关卡至少需要 1 个物件' };
  if (arr.length > MAX_OBSTACLES) {
    return { ok: false, error: `障碍数量超过上限 ${MAX_OBSTACLES}` };
  }

  const obstacles = [];
  let baits = 0;
  for (let i = 0; i < arr.length; i++) {
    const item = arr[i];
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return { ok: false, error: `第 ${i + 1} 个物件不是对象` };
    }
    const kind = item.kind;
    if (!VALID_KINDS.includes(kind)) {
      return { ok: false, error: `第 ${i + 1} 个物件类型非法` };
    }
    if (kind === 'CORE_BAIT') {
      baits++;
      if (baits > MAX_BAITS) return { ok: false, error: `磁芯诱饵最多 ${MAX_BAITS} 枚` };
    }
    const nums = [item.x, item.y, item.w, item.h];
    if (!nums.every(v => Number.isFinite(Number(v)))) {
      return { ok: false, error: `第 ${i + 1} 个物件坐标/尺寸不是数字` };
    }
    const cfg = {
      kind,
      x: Math.round(Number(item.x)),
      y: Math.round(Number(item.y)),
      w: Math.round(Number(item.w)),
      h: Math.round(Number(item.h)),
    };
    if (cfg.x < 0 || cfg.x > LIMITS.x) {
      return { ok: false, error: `第 ${i + 1} 个物件 x 越界（0–${LIMITS.x}）` };
    }
    if (cfg.y < 0 || cfg.y > LIMITS.y) {
      return { ok: false, error: `第 ${i + 1} 个物件 y 越界（0–${LIMITS.y}）` };
    }
    if (cfg.w < LIMITS.minWH || cfg.w > LIMITS.w) {
      return { ok: false, error: `第 ${i + 1} 个物件宽度越界（${LIMITS.minWH}–${LIMITS.w}）` };
    }
    if (cfg.h < LIMITS.minWH || cfg.h > LIMITS.h) {
      return { ok: false, error: `第 ${i + 1} 个物件高度越界（${LIMITS.minWH}–${LIMITS.h}）` };
    }
    if (cfg.x + cfg.w > LIMITS.maxRight) {
      return { ok: false, error: `第 ${i + 1} 个物件超出世界右边界` };
    }
    const meta = sanitizeMeta(kind, item.meta);
    if (meta) cfg.meta = meta;
    obstacles.push(cfg);
  }

  return { ok: true, data: { name, obstacles } };
}

/** 固定窗口限流：同一 key 在 windowMs 内最多 limit 次 */
export class RateLimiter {
  constructor({ limit, windowMs }) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.hits = new Map();
  }

  hit(key) {
    const now = Date.now();
    const rec = this.hits.get(key);
    if (!rec || now - rec.start >= this.windowMs) {
      this.hits.set(key, { start: now, count: 1 });
      if (this.hits.size > 2000) this.prune(now);
      return { allowed: true, retryAfterMs: 0 };
    }
    rec.count++;
    if (rec.count > this.limit) {
      return { allowed: false, retryAfterMs: rec.start + this.windowMs - now };
    }
    return { allowed: true, retryAfterMs: 0 };
  }

  prune(now = Date.now()) {
    for (const [k, rec] of this.hits) {
      if (now - rec.start >= this.windowMs) this.hits.delete(k);
    }
  }
}

/** 文件存储：启动读回 → 内存 Map → 每次写入原子落盘 */
export class LevelStore {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'levels.json');
    this.levels = new Map();
    this.load();
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const [code, entry] of Object.entries(raw.levels ?? {})) {
        if (isValidShareCode(code) && entry && Array.isArray(entry.obstacles)) {
          this.levels.set(code, entry);
        }
      }
    } catch {
      // 文件不存在或损坏：从空库开始，不影响联机
    }
  }

  add({ name, obstacles }) {
    let code = makeShareCode();
    for (let i = 0; i < 8 && this.levels.has(code); i++) code = makeShareCode();
    const entry = { code, name, obstacles, createdAt: Date.now() };
    this.levels.set(code, entry);
    this.prune();
    // 落盘失败必须整单失败：否则接口返回成功、重启后关卡却丢失
    if (!this.flush()) {
      this.levels.delete(code);
      throw new Error('关卡存储写入失败');
    }
    return entry;
  }

  get(code) {
    if (typeof code !== 'string') return null;
    return this.levels.get(code.trim().toUpperCase()) ?? null;
  }

  list(limit = 50) {
    return [...this.levels.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit)
      .map(e => ({ code: e.code, name: e.name, count: e.obstacles.length, createdAt: e.createdAt }));
  }

  get size() {
    return this.levels.size;
  }

  /** 删除指定分享码；不存在返回 false，写盘失败抛错并回滚内存 */
  remove(code) {
    const key = String(code ?? '').trim().toUpperCase();
    const entry = this.levels.get(key);
    if (!entry) return false;
    this.levels.delete(key);
    if (!this.flush()) {
      this.levels.set(key, entry);
      throw new Error('关卡存储写入失败');
    }
    return true;
  }

  prune() {
    if (this.levels.size <= MAX_LEVELS) return;
    const oldest = [...this.levels.values()].sort((a, b) => a.createdAt - b.createdAt);
    for (let i = 0; i < oldest.length - MAX_LEVELS; i++) this.levels.delete(oldest[i].code);
  }

  flush() {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const payload = JSON.stringify({ v: 1, levels: Object.fromEntries(this.levels) });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, payload, 'utf8');
      fs.renameSync(tmp, this.file);
      return true;
    } catch (err) {
      console.error(`[levels] 落盘失败：${err.message}`);
      return false;
    }
  }
}

/* ---------------- HTTP 处理 ---------------- */

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.trim()) return fwd.split(',')[0].trim();
  return req.socket?.remoteAddress ?? 'unknown';
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let settled = false;
    const chunks = [];
    req.on('data', chunk => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        settled = true;
        // 不销毁连接：让 handler 能把 413 正常写回客户端，剩余数据直接丢弃
        reject(Object.assign(new Error('body too large'), { status: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => { if (!settled) resolve(Buffer.concat(chunks).toString('utf8')); });
    req.on('error', err => { if (!settled) { settled = true; reject(err); } });
  });
}

function sendJson(res, status, obj, extraHeaders = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(body);
}

const LEVEL_PATH_RE = /^\/api\/levels\/([A-Za-z0-9_-]{4,24})$/;

/**
 * 生成 HTTP handler：只处理 /api/levels*，其余交回调用方。
 * opts: { store, uploadLimiter, readLimiter, onUpload?, onDownload? }
 * onUpload/onDownload 仅用于运维计数，失败不影响接口本身。
 */
export function createLevelHttpHandler({ store, uploadLimiter, readLimiter, onUpload, onDownload }) {
  return async function handleLevelHttp(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const pathname = url.pathname;

    // CORS 预检
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '86400',
      });
      res.end();
      return true;
    }

    if (!pathname.startsWith('/api/levels')) return false;

    const ip = clientIp(req);

    // 上传：POST /api/levels
    if (pathname === '/api/levels' && req.method === 'POST') {
      const gate = uploadLimiter.hit(`upload:${ip}`);
      if (!gate.allowed) {
        sendJson(res, 429, { ok: false, error: '上传过于频繁，请稍后再试' }, {
          'Retry-After': String(Math.ceil(gate.retryAfterMs / 1000)),
        });
        return true;
      }
      let raw;
      try {
        raw = await readBody(req, MAX_BODY_BYTES);
      } catch (err) {
        if (err.status === 413) {
          sendJson(res, 413, { ok: false, error: `请求体超过 ${MAX_BODY_BYTES / 1024}KB 上限` });
        } else {
          sendJson(res, 400, { ok: false, error: '读取请求体失败' });
        }
        return true;
      }
      let payload;
      try {
        payload = JSON.parse(raw);
      } catch {
        sendJson(res, 400, { ok: false, error: 'JSON 解析失败' });
        return true;
      }
      const check = sanitizeLevel(payload);
      if (!check.ok) {
        sendJson(res, 400, { ok: false, error: check.error });
        return true;
      }
      let entry;
      try {
        entry = store.add(check.data);
      } catch (err) {
        console.error(`[levels] 保存失败：${err.message}`);
        sendJson(res, 500, { ok: false, error: '服务器存储写入失败，请稍后重试' });
        return true;
      }
      console.log(`[levels] 上传 ${entry.code}（${entry.obstacles.length} 个物件，${check.data.name}）`);
      try { onUpload?.(entry); } catch { /* 计数失败不影响上传结果 */ }
      sendJson(res, 201, {
        ok: true, version: LEVELS_API_VERSION, code: entry.code, name: entry.name,
        count: entry.obstacles.length, createdAt: entry.createdAt,
      });
      return true;
    }

    // 列表：GET /api/levels
    if (pathname === '/api/levels' && req.method === 'GET') {
      const gate = readLimiter.hit(`read:${ip}`);
      if (!gate.allowed) {
        sendJson(res, 429, { ok: false, error: '请求过于频繁' }, {
          'Retry-After': String(Math.ceil(gate.retryAfterMs / 1000)),
        });
        return true;
      }
      sendJson(res, 200, { ok: true, version: LEVELS_API_VERSION, levels: store.list(50) });
      return true;
    }

    // 下载：GET /api/levels/:code
    const m = pathname.match(LEVEL_PATH_RE);
    if (m && req.method === 'GET') {
      const gate = readLimiter.hit(`read:${ip}`);
      if (!gate.allowed) {
        sendJson(res, 429, { ok: false, error: '请求过于频繁' }, {
          'Retry-After': String(Math.ceil(gate.retryAfterMs / 1000)),
        });
        return true;
      }
      const entry = store.get(m[1]);
      if (!entry) {
        sendJson(res, 404, { ok: false, error: '分享码不存在或已过期' });
        return true;
      }
      try { onDownload?.(entry); } catch { /* 计数失败不影响下载结果 */ }
      sendJson(res, 200, {
        ok: true, version: LEVELS_API_VERSION, code: entry.code, name: entry.name,
        obstacles: entry.obstacles, count: entry.obstacles.length, createdAt: entry.createdAt,
      });
      return true;
    }

    sendJson(res, 405, { ok: false, error: '方法不支持' });
    return true;
  };
}
